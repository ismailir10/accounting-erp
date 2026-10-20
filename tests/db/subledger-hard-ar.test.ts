import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { importStatement } from "@/lib/import/pipeline";
import { createInvoice, voidInvoice } from "@/lib/receivables/invoices";
import { settle, settleWithReclass, tagAdvance, unsettle } from "@/lib/receivables/settle";
import { agingByContact, invoicesAt, subledgerVsLedger } from "@/lib/receivables/aging";
import { reviewTransaction } from "@/lib/review";
import { runControls } from "@/lib/controls";
import { masaReport } from "@/lib/tax/masa-report";
import { balanceSheet, incomeStatement } from "@/lib/reports/ledger";
import { cashFlow } from "@/lib/reports/statements";
import { financialNotes } from "@/lib/reports/notes";
import { receivablesView } from "@/lib/receivables/view";
import { creditPackWorkbook } from "@/lib/reports/credit-pack";
import ExcelJS from "exceljs";
import { postOpening } from "@/lib/opening";
import { dateOnly } from "@/lib/format";

/**
 * Hard test: receivables and payables across a year end (round five, docs/cycles/2026-10-21-uji-keras-grup.md). Every expected figure is
 * computed by hand in the comment beside it. Its failures were fixed in the same cycle.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;

async function gl(g: G, code: string, asOf: Date) {
  const s = await db.journalLine.aggregate({ where: { entityId: g.pt.entity.id, account: { clientId: g.client.id, code }, date: { lte: asOf } }, _sum: { debit: true, credit: true } });
  return (s._sum.debit ?? 0n) - (s._sum.credit ?? 0n);
}

function csv(rows: [string, string, number, number][]) {
  let bal = 100_000_000;
  return Buffer.from(["Tanggal;Keterangan;Debet;Kredit;Saldo", ...rows.map(([d, k, dr, cr]) => `${d};${k};${dr};${cr};${(bal = bal - dr + cr)}`), ""].join("\n"));
}
async function bank(g: G, rows: [string, string, number, number][], fileName = "bca.csv") {
  await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName, data: csv(rows), provider: null });
  return (text: string) => db.bankTransaction.findFirstOrThrow({ where: { description: { contains: text } } });
}
const lock = (g: G, year: number, month: number) =>
  db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year, month } }, create: { firmId: g.firm.id, clientId: g.client.id, year, month, status: "LOCKED" }, update: { status: "LOCKED" } });
const sale = (g: G, number: string, contactName: string, issueDate: string, dueDate: string, dpp: string, more: Partial<Parameters<typeof createInvoice>[1]> = {}) =>
  createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "SALES", contactName, number, issueDate, dueDate, dpp, counterCode: "4100", ...more });
const control = async (g: G, y: number, m: number, key: string) => (await runControls(db, g.client.id, y, m)).find((c) => c.key === `${key}:${g.pt.entity.id}`);

/**
 * Shared year-end case (PT Uji, BCA):
 * - S-1 PT Mitra Jasa 10 Nov 2025, due 10 Dec: DPP 10.000.000 + PPN 1.100.000 = 11.100.000, PPh 23 2 % = 200.000 expected.
 *   5 Dec: 5.000.000 received (part, cash only). 10 Jan 2026: 5.900.000 closes it (shortfall 200.000 = the PPh 23).
 * - S-2 Toko Sejahtera 15 Dec 2025, due 14 Jan 2026: DPP 20.000.000 + PPN 2.200.000 = 22.200.000. 20 Jan 2026: 23.000.000 received
 *   (over-payment 800.000 → Toko Sejahtera's advance).
 * - CV Maju pays an advance 5.550.000 on 20 Dec 2025 (tagged); S-3 issued 5 Jan 2026: DPP 5.000.000 + PPN 550.000 = 5.550.000.
 */
async function yearEnd(g: G) {
  const tx = await bank(g, [
    ["05/12/2025", "TRSF CR PT MITRA JASA SEBAGIAN", 0, 5_000_000],
    ["20/12/2025", "TRSF CR CV MAJU UANG MUKA", 0, 5_550_000],
    ["10/01/2026", "TRSF CR PT MITRA JASA PELUNASAN", 0, 5_900_000],
    ["20/01/2026", "TRSF CR TOKO SEJAHTERA", 0, 23_000_000],
  ]);
  const s1 = await sale(g, "S-1", "PT Mitra Jasa", "2025-11-10", "2025-12-10", "10000000", { ppn: "1100000", whtKind: "PPH_23", whtRate: "2" });
  const s2 = await sale(g, "S-2", "Toko Sejahtera", "2025-12-15", "2026-01-14", "20000000", { ppn: "2200000" });
  await settleWithReclass(db, { clientId: g.client.id, invoiceId: s1.id, bankTransactionId: (await tx("SEBAGIAN")).id });
  const maju = await tx("CV MAJU");
  await reviewTransaction(db, { bankTxId: maju.id, accountCode: "1130", taxTag: null });
  const majuContact = await db.contact.create({ data: { firmId: g.firm.id, clientId: g.client.id, name: "CV Maju" } });
  await tagAdvance(db, { clientId: g.client.id, bankTransactionId: maju.id, contactId: majuContact.id });
  return { tx, s1, s2, maju };
}

describe("hard test: receivables across a year end", () => {
  beforeEach(resetDb);

  it("31 Dec 2025: aging, advance and GL 1130 agree; the year-end Neraca and Laba Rugi", async () => {
    const g = await makeGroup();
    await yearEnd(g);
    const dec = dateOnly(2025, 12, 31);
    // S-1 open 11.100.000 − 5.000.000 = 6.100.000, 21 days past due → 1–30; S-2 22.200.000 current.
    const items = await invoicesAt(db, g.client.id, "SALES", dec);
    expect(items.map((i) => [i.number, i.open, i.daysPastDue, i.bucket])).toEqual([
      ["S-1", 6_100_000n, 21, "D1_30"],
      ["S-2", 22_200_000n, -14, "CURRENT"],
    ]);
    // GL 1130 = 11.100.000 + 22.200.000 − 5.000.000 − 5.550.000 = 22.750.000; subledger 28.300.000 − advance 5.550.000.
    const [c] = await subledgerVsLedger(db, g.client.id, "SALES", dec);
    expect([c.open, c.advances, c.unallocated, c.subledger, c.ledger, c.equal]).toEqual([28_300_000n, 5_550_000n, 0n, 22_750_000n, 22_750_000n, true]);
    expect((await control(g, 2025, 12, "ar"))?.status).toBe("PASS");
    // CV Maju holds a credit with nothing owed → overpaid: REVIEW.
    expect((await control(g, 2025, 12, "overpaid"))?.status).toBe("REVIEW");
    // Neraca 31 Dec: cash 10.550.000 (statement import: the bank GL holds the rows only), 1130 22.750.000, 2130 3.300.000, profit 30.000.000.
    const scope = { clientId: g.client.id, entityIds: [g.pt.entity.id] };
    const bs = await balanceSheet(db, scope, dec);
    expect(bs.totals.difference).toBe(0n);
    expect(bs.currentAssets.find((i) => i.fsLine === "PIUTANG_USAHA")?.amount).toBe(22_750_000n);
    const is = await incomeStatement(db, scope, dateOnly(2025, 1, 1), dec);
    expect(is.totals.revenue).toBe(30_000_000n);
  });

  it("aging at a date inside a closed month is not moved by next year's receipts", async () => {
    const g = await makeGroup();
    const { tx, s1, s2 } = await yearEnd(g);
    await lock(g, 2025, 11);
    await lock(g, 2025, 12);
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: s1.id, bankTransactionId: (await tx("PELUNASAN")).id });
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: s2.id, bankTransactionId: (await tx("TOKO SEJAHTERA")).id });
    // 15 Dec 2025: S-1 open 6.100.000 (5 days late, 1–30); S-2 issued that day, 22.200.000 current.
    const mid = agingByContact(await invoicesAt(db, g.client.id, "SALES", dateOnly(2025, 12, 15)));
    expect(mid.map((r) => [r.contact.name, r.buckets.CURRENT, r.buckets.D1_30, r.total])).toEqual([
      ["Toko Sejahtera", 22_200_000n, 0n, 22_200_000n],
      ["PT Mitra Jasa", 0n, 6_100_000n, 6_100_000n],
    ]);
    const [c] = await subledgerVsLedger(db, g.client.id, "SALES", dateOnly(2025, 12, 31));
    expect([c.subledger, c.ledger, c.equal]).toEqual([22_750_000n, 22_750_000n, true]);
  });

  it("January 2026: PPh 23 on the closing receipt, over-payment as an advance, Dec advance applied to the Jan invoice; control equal", async () => {
    const g = await makeGroup();
    const { tx, s1, s2, maju } = await yearEnd(g);
    await lock(g, 2025, 11);
    await lock(g, 2025, 12);
    const r1 = await settleWithReclass(db, { clientId: g.client.id, invoiceId: s1.id, bankTransactionId: (await tx("PELUNASAN")).id });
    expect([r1.amount, r1.withheld]).toEqual([6_100_000n, 200_000n]);
    const r2 = await settleWithReclass(db, { clientId: g.client.id, invoiceId: s2.id, bankTransactionId: (await tx("TOKO SEJAHTERA")).id });
    expect([r2.amount, r2.withheld]).toEqual([22_200_000n, 0n]);
    const s3 = await sale(g, "S-3", "CV Maju", "2026-01-05", "2026-01-05", "5000000", { ppn: "550000" });
    // The December advance pays the January invoice. Applying it changes nothing in December: at 31 Dec S-3 is not in the subledger,
    // so the line is still CV Maju's advance there (unmatchedLines only nets settlements of invoices already in the list).
    await settle(db, { clientId: g.client.id, invoiceId: s3.id, bankTransactionId: maju.id });
    const jan = dateOnly(2026, 1, 31);
    // GL 1130 = 22.750.000 − 6.100.000 (5.900.000 cash + 200.000 PPh 23) − 23.000.000 + 5.550.000 = −800.000.
    expect(await gl(g, "1130", jan)).toBe(-800_000n);
    expect(await gl(g, "1180", jan)).toBe(200_000n);
    const [c] = await subledgerVsLedger(db, g.client.id, "SALES", jan);
    expect([c.open, c.advances, c.subledger, c.ledger, c.equal]).toEqual([0n, 800_000n, -800_000n, -800_000n, true]);
    // December's proof is unchanged by the January matching.
    const [d] = await subledgerVsLedger(db, g.client.id, "SALES", dateOnly(2025, 12, 31));
    expect([d.open, d.advances, d.subledger, d.ledger]).toEqual([28_300_000n, 5_550_000n, 22_750_000n, 22_750_000n]);
  });

  it("same January with December still open: every figure holds once the advance can be applied", async () => {
    const g = await makeGroup();
    const { tx, s1, s2, maju } = await yearEnd(g);
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: s1.id, bankTransactionId: (await tx("PELUNASAN")).id });
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: s2.id, bankTransactionId: (await tx("TOKO SEJAHTERA")).id });
    const s3 = await sale(g, "S-3", "CV Maju", "2026-01-05", "2026-01-05", "5000000", { ppn: "550000" });
    await settle(db, { clientId: g.client.id, invoiceId: s3.id, bankTransactionId: maju.id });
    const jan = dateOnly(2026, 1, 31);
    expect([await gl(g, "1130", jan), await gl(g, "1180", jan)]).toEqual([-800_000n, 200_000n]);
    const [c] = await subledgerVsLedger(db, g.client.id, "SALES", jan);
    expect([c.open, c.advances, c.subledger, c.ledger, c.equal]).toEqual([0n, 800_000n, -800_000n, -800_000n, true]);
    expect((await control(g, 2026, 1, "ar"))?.status).toBe("PASS");
    expect((await control(g, 2026, 1, "overpaid"))?.detail).toMatch(/Toko Sejahtera Rp 800\.000/);
    const [d] = await subledgerVsLedger(db, g.client.id, "SALES", dateOnly(2025, 12, 31));
    expect([d.open, d.advances, d.subledger, d.ledger]).toEqual([28_300_000n, 5_550_000n, 22_750_000n, 22_750_000n]);
    // Masa PPN: Nov keluaran 1.100.000, Dec 2.200.000, Jan 550.000.
    const ppn = async (y: number, m: number) => (await masaReport(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: y, month: m, now: dateOnly(2026, 3, 1) }))!.rows.find((r) => r.key === "PPN")!.ppn!.keluaran;
    expect([await ppn(2025, 11), await ppn(2025, 12), await ppn(2026, 1)]).toEqual([1_100_000n, 2_200_000n, 550_000n]);
  });

  it("cash flow January 2026: receipts from customers = revenue + the fall in receivables − PPh 23 prepaid + PPN owed", async () => {
    const g = await makeGroup();
    const { tx, s1, s2 } = await yearEnd(g);
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: s1.id, bankTransactionId: (await tx("PELUNASAN")).id });
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: s2.id, bankTransactionId: (await tx("TOKO SEJAHTERA")).id });
    await sale(g, "S-3", "CV Maju", "2026-01-05", "2026-01-05", "5000000", { ppn: "550000" });
    const cf = await cashFlow(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, dateOnly(2026, 1, 31));
    // Net profit Jan = 5.000.000. 1130: 22.750.000 → −800.000 = +23.550.000. 1180 +200.000 → −200.000. 2130 +550.000 → +550.000.
    // Operating 5.000.000 + 23.550.000 − 200.000 + 550.000 = 28.900.000 = cash received (5.900.000 + 23.000.000).
    expect(cf.netProfit).toBe(5_000_000n);
    expect(cf.totals.OPERATING).toBe(28_900_000n);
    expect([cf.totals.INVESTING, cf.totals.FINANCING]).toEqual([0n, 0n]);
    expect([cf.openingCash, cf.closingCash, cf.net]).toEqual([10_550_000n, 39_450_000n, 28_900_000n]);
  });

  it("CALK aging note reconciles to the Neraca's Piutang usaha when a customer holds an advance", async () => {
    const g = await makeGroup();
    await yearEnd(g);
    const scope = { clientId: g.client.id, entityIds: [g.pt.entity.id] };
    const dec = dateOnly(2025, 12, 31);
    const bs = await balanceSheet(db, scope, dec);
    const neraca = bs.currentAssets.find((i) => i.fsLine === "PIUTANG_USAHA")!.amount; // 22.750.000
    const notes = await financialNotes(db, scope, 2025, 12);
    const note = notes.notes.find((n) => n.paragraphs.some((p) => p.startsWith("Umur piutang usaha")))!;
    const aging = note.tables.find((t) => t.columns[0] === "Umur")!;
    // The aging lists open invoices (28.300.000); the Neraca line nets CV Maju's 5.550.000 advance. A note attached to the line must
    // reconcile to it (an "uang muka pelanggan" row, or a total equal to the line).
    const rows = aging.rows.map((r) => r[1] as bigint);
    const shown = rows.reduce((t, v) => t + v, 0n);
    expect(aging.total![1]).toBe(neraca);
    expect(shown).toBe(neraca);
  });

  it("Paket Kredit Bank: Umur Piutang reconciles to the Neraca's Piutang usaha when a customer holds an advance", async () => {
    const g = await makeGroup();
    await yearEnd(g);
    const buf = await creditPackWorkbook(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2025, month: 12, meta: { firm: "KJA Uji", title: "PT Uji Sejahtera" } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const values: unknown[][] = [];
    wb.getWorksheet("Umur Piutang")!.eachRow((r) => values.push((r.values as unknown[]).slice(1)));
    const total = values.find((v) => v[0] === "Total")!;
    // Neraca 31 Dec 2025: Piutang usaha 22.750.000 (28.300.000 open − CV Maju's 5.550.000 advance). The bank's analyst ties the aging to it.
    expect(total.at(-1)).toBe(22_750_000);
  });

  it("Piutang page at 31 Dec 2025 after the advance was applied in January (Dec open): the advance line is still listed as unmatched", async () => {
    const g = await makeGroup();
    const { maju } = await yearEnd(g);
    const s3 = await sale(g, "S-3", "CV Maju", "2026-01-05", "2026-01-05", "5000000", { ppn: "550000" });
    await settle(db, { clientId: g.client.id, invoiceId: s3.id, bankTransactionId: maju.id });
    const v = await receivablesView(db, g.client.id, "SALES", dateOnly(2025, 12, 31), [{ id: g.pt.entity.id, shortName: "PT Uji", functionalCurrency: "IDR", kind: "PT" }]);
    // The aging row carries CV Maju's 5.550.000 advance (from the subledger proof) …
    const row = v.aging[0].rows.find((r) => r.contact === "CV Maju")!;
    expect(row.advance).toBe("5550000");
    // … so the list of unmatched cash at that date must show the line behind it (5.550.000 free at 31 Dec: S-3 did not exist yet).
    expect(v.unsettled.map((u) => [u.description, u.free])).toEqual([["TRSF CR CV MAJU UANG MUKA", "5550000"]]);
  });

  it("void after a partial payment: unsettle, void, the receipt becomes the customer's advance; GL and subledger agree", async () => {
    const g = await makeGroup();
    const tx = await bank(g, [["20/01/2026", "TRSF CR PT MITRA JASA DP", 0, 1_000_000]]);
    // S-9 3.000.000 + PPN 330.000 = 3.330.000, 1.000.000 paid, then found to be a duplicate.
    const s9 = await sale(g, "S-9", "PT Mitra Jasa", "2026-01-08", "2026-02-07", "3000000", { ppn: "330000" });
    const st = await settleWithReclass(db, { clientId: g.client.id, invoiceId: s9.id, bankTransactionId: (await tx("MITRA")).id });
    await expect(voidInvoice(db, { clientId: g.client.id, invoiceId: s9.id, reason: "duplikat faktur S-8" })).rejects.toThrow(/dicocokkan/);
    await unsettle(db, { clientId: g.client.id, settlementId: st.id });
    await voidInvoice(db, { clientId: g.client.id, invoiceId: s9.id, reason: "duplikat faktur S-8" });
    const jan = dateOnly(2026, 1, 31);
    // GL: 3.330.000 − 3.330.000 (void) − 1.000.000 = −1.000.000; 2130 and 4100 back to 0.
    expect([await gl(g, "1130", jan), await gl(g, "2130", jan), await gl(g, "4100", jan)]).toEqual([-1_000_000n, 0n, 0n]);
    // The voided invoice leaves the list; the tagged receipt is PT Mitra Jasa's advance. With no live invoice the entity has no
    // comparison (documented: advance invisible to ar: without an invoice), so check the line itself.
    const r = (await masaReport(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 1, now: dateOnly(2026, 3, 1) }))!;
    expect(r.rows.find((x) => x.key === "PPN")!.ppn).toMatchObject({ keluaran: 0n });
    expect((await tx("MITRA")).contactId).not.toBeNull();
  });
});

describe("hard test: payables across a year end", () => {
  beforeEach(resetDb);

  it("bill Dec 2025 with PPh 23 we withhold, paid Jan 2026; aging, ap: control, 2141 owed in January's masa", async () => {
    const g = await makeGroup();
    const tx = await bank(g, [["15/01/2026", "TRSF DB CV KONSULTAN BAYU", 10_900_000, 0]]);
    // DPP 10.000.000 + PPN 1.100.000 = 11.100.000, due 31 Dec; PPh 23 2 % = 200.000 withheld on payment (10.900.000 cash).
    const bill = await createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "PURCHASE", contactName: "CV Konsultan Bayu", number: "B-12", issueDate: "2025-12-01", dueDate: "2025-12-31", dpp: "10000000", ppn: "1100000", counterCode: "6170", whtKind: "PPH_23", whtRate: "2" });
    const dec = dateOnly(2025, 12, 31);
    const [d] = await invoicesAt(db, g.client.id, "PURCHASE", dec);
    expect([d.open, d.daysPastDue, d.bucket]).toEqual([11_100_000n, 0, "CURRENT"]);
    expect((await control(g, 2025, 12, "ap"))?.status).toBe("PASS");
    await lock(g, 2025, 12);
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: bill.id, bankTransactionId: (await tx("BAYU")).id });
    const jan = dateOnly(2026, 1, 31);
    expect([await gl(g, "2110", jan), await gl(g, "2141", jan)]).toEqual([0n, -200_000n]);
    const [c] = await subledgerVsLedger(db, g.client.id, "PURCHASE", jan);
    expect([c.open, c.ledger, c.equal]).toEqual([0n, 0n, true]);
    // PPh 23 is owed for masa January (withheld when paid); PPN masukan belongs to December.
    const janMasa = (await masaReport(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 1, now: dateOnly(2026, 3, 1) }))!;
    expect(janMasa.rows.find((r) => r.key === "PPH_23")?.owed).toBe(200_000n);
    const decMasa = (await masaReport(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2025, month: 12, now: dateOnly(2026, 3, 1) }))!;
    expect(decMasa.rows.find((r) => r.key === "PPN")!.ppn).toMatchObject({ masukan: 1_100_000n, keluaran: 0n, carryOut: 1_100_000n });
  });
});

describe("hard test: Saldo Awal receivables taken over at a year end", () => {
  beforeEach(resetDb);

  it("opening 31 Dec 2025 detailed by two open invoices, one with PPh 23; paid in January; aging, ar: and cash flow", async () => {
    const g = await makeGroup();
    // Saldo Awal: 1130 33.300.000 (S-1 11.100.000 + S-2 22.200.000), 2130 3.300.000, modal 30.000.000.
    await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2025, 12, 31), lines: [{ accountCode: "1130", debit: "33300000", credit: "0" }, { accountCode: "2130", debit: "0", credit: "3300000" }, { accountCode: "3100", debit: "0", credit: "30000000" }] });
    const s1 = await sale(g, "S-1", "PT Mitra Jasa", "2025-11-10", "2025-12-10", "10000000", { ppn: "1100000", whtKind: "PPH_23", whtRate: "2", opening: true });
    const s2 = await sale(g, "S-2", "Toko Sejahtera", "2025-12-15", "2026-01-14", "20000000", { ppn: "2200000", opening: true });
    const dec = dateOnly(2025, 12, 31);
    expect((await invoicesAt(db, g.client.id, "SALES", dec)).map((i) => [i.number, i.open, i.bucket])).toEqual([["S-1", 11_100_000n, "D1_30"], ["S-2", 22_200_000n, "CURRENT"]]);
    expect((await control(g, 2025, 12, "ar"))?.status).toBe("PASS");
    const tx = await bank(g, [
      ["10/01/2026", "TRSF CR PT MITRA JASA", 0, 10_900_000],
      ["20/01/2026", "TRSF CR TOKO SEJAHTERA", 0, 10_000_000],
    ]);
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: s1.id, bankTransactionId: (await tx("MITRA")).id });
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: s2.id, bankTransactionId: (await tx("TOKO")).id });
    const jan = dateOnly(2026, 1, 31);
    // S-1 closed gross (10.900.000 + 200.000 PPh 23); S-2 open 12.200.000, 17 days late. GL 1130 = 33.300.000 − 11.100.000 − 10.000.000.
    const items = await invoicesAt(db, g.client.id, "SALES", jan);
    expect(items.map((i) => [i.number, i.open, i.daysPastDue])).toEqual([["S-1", 0n, 52], ["S-2", 12_200_000n, 17]]);
    expect(await gl(g, "1130", jan)).toBe(12_200_000n);
    expect((await control(g, 2026, 1, "ar"))?.status).toBe("PASS");
    // Cash flow Jan: profit 0; 1130 −21.100.000 → +21.100.000; 1180 +200.000 → −200.000; operating 20.900.000 = cash in.
    const cf = await cashFlow(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, jan);
    expect([cf.netProfit, cf.totals.OPERATING, cf.net]).toEqual([0n, 20_900_000n, 20_900_000n]);
  });
});
