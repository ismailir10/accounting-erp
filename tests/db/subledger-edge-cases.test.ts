import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { importStatement } from "@/lib/import/pipeline";
import { createInvoice, ppnFor, voidInvoice } from "@/lib/receivables/invoices";
import { settle, settleFifo, settleWithReclass } from "@/lib/receivables/settle";
import { invoicesAt, subledgerVsLedger } from "@/lib/receivables/aging";
import { reviewTransaction } from "@/lib/review";
import { masaReport } from "@/lib/tax/masa-report";
import { postPpnOffset } from "@/lib/tax/ppn-offset";
import { postJournal } from "@/lib/ledger/post";
import { upsertRate } from "@/lib/fx/rates";
import { postRevaluation, revaluationProposals } from "@/lib/fx/revalue";
import { postOpening, OpeningError } from "@/lib/opening";
import { createAsset, registerVsLedger, assetRegister } from "@/lib/assets/register";
import { disposeAsset } from "@/lib/assets/dispose";
import { fiscalDepreciation } from "@/lib/assets/fiscal";
import { createSchedule, installments, postInstallment } from "@/lib/adjust/schedules";
import { runControls } from "@/lib/controls";
import { ckpn } from "@/lib/receivables/ckpn";
import { taxPack } from "@/lib/tax/pack";
import { dateOnly } from "@/lib/format";

/**
 * Adversarial subledger / tax / FX / register scenarios. Every expected figure is computed by hand in the comment beside it, never
 * read back from the code under test. A failing test here is a bug reproducer.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;

const acc = async (g: G, code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code } } })).id;

/** GL net (debit − credit) of an account for PT Uji through a date. */
async function gl(g: G, code: string, asOf: Date) {
  const s = await db.journalLine.aggregate({ where: { entityId: g.pt.entity.id, account: { clientId: g.client.id, code }, date: { lte: asOf } }, _sum: { debit: true, credit: true } });
  return (s._sum.debit ?? 0n) - (s._sum.credit ?? 0n);
}

function csv(rows: [string, string, number, number][]) {
  let bal = 100_000_000;
  return Buffer.from(
    ["Tanggal;Keterangan;Debet;Kredit;Saldo", ...rows.map(([d, k, dr, cr]) => `${d};${k};${dr};${cr};${(bal = bal - dr + cr)}`), ""].join("\n"),
  );
}

async function bank(g: G, rows: [string, string, number, number][], fileName = "bca.csv") {
  await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName, data: csv(rows), provider: null });
  return async (text: string) => db.bankTransaction.findFirstOrThrow({ where: { description: { contains: text } } });
}

const inv = (g: G, number: string, contactName: string, issueDate: string, dueDate: string, dpp: string, more: Partial<Parameters<typeof createInvoice>[1]> = {}) =>
  createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "SALES", contactName, number, issueDate, dueDate, dpp, counterCode: "4100", ...more });

describe("invoices, settlements, aging", () => {
  beforeEach(resetDb);

  it("PPN prefill is 11 % of the DPP rounded half up on odd DPP", () => {
    expect(ppnFor(50n)).toBe(6n); // 5,5 → 6
    expect(ppnFor(45n)).toBe(5n); // 4,95 → 5
    expect(ppnFor(1_234_567n)).toBe(135_802n); // 135.802,37
    expect(ppnFor(4_545n)).toBe(500n); // 499,95
    expect(ppnFor(9_090_909n)).toBe(1_000_000n); // 999.999,99
  });

  it("partial receipts: aging buckets at each month end equal GL 1130", async () => {
    const g = await makeGroup();
    const tx = await bank(g, [
      ["20/08/2026", "TRSF CR TOKO SEJAHTERA SATU", 0, 9_000_000],
      ["10/09/2026", "TRSF CR TOKO SEJAHTERA DUA", 0, 1_000_000],
    ]);
    // DPP 10.000.000 + PPN 1.100.000 = 11.100.000, due 15 Aug.
    const n1 = await inv(g, "N-1", "Toko Sejahtera", "2026-08-01", "2026-08-15", "10000000", { ppn: "1100000" });
    const entry = await db.journalEntry.findUniqueOrThrow({ where: { id: n1.entryId! }, include: { lines: { include: { account: true } } } });
    expect(entry.lines.map((l) => [l.account.code, l.debit, l.credit]).sort()).toEqual([["1130", 11_100_000n, 0n], ["2130", 0n, 1_100_000n], ["4100", 0n, 10_000_000n]]);
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: n1.id, bankTransactionId: (await tx("SATU")).id });
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: n1.id, bankTransactionId: (await tx("DUA")).id });

    const at = async (y: number, m: number, d: number) => {
      const asOf = dateOnly(y, m, d);
      const [i] = await invoicesAt(db, g.client.id, "SALES", asOf);
      const [c] = await subledgerVsLedger(db, g.client.id, "SALES", asOf);
      return { open: i.open, bucket: i.bucket, days: i.daysPastDue, sub: c.subledger, ledger: c.ledger, gl: await gl(g, "1130", asOf) };
    };
    // 31 Aug: 11,1 jt − 9 jt = 2,1 jt open, 16 days past due → 1–30.
    expect(await at(2026, 8, 31)).toEqual({ open: 2_100_000n, bucket: "D1_30", days: 16, sub: 2_100_000n, ledger: 2_100_000n, gl: 2_100_000n });
    // 30 Sep: 1,1 jt open, 46 days → 31–60.
    expect(await at(2026, 9, 30)).toEqual({ open: 1_100_000n, bucket: "D31_60", days: 46, sub: 1_100_000n, ledger: 1_100_000n, gl: 1_100_000n });
    // 30 Nov: 107 days → > 90.
    expect(await at(2026, 11, 30)).toMatchObject({ open: 1_100_000n, bucket: "OVER_90", days: 107 });
    // 15 Aug (due date itself) is not past due.
    expect((await invoicesAt(db, g.client.id, "SALES", dateOnly(2026, 8, 15)))[0]).toMatchObject({ daysPastDue: 0, bucket: "CURRENT" });
  });

  it("one net receipt across two PPh 23 invoices (FIFO): both close gross, line carries 2 × tax, 1180 = 200.000", async () => {
    const g = await makeGroup();
    const tx = await bank(g, [["25/08/2026", "TRSF CR PT MITRA JASA", 0, 10_900_000]]);
    // Each: DPP 5 jt + PPN 550 rb = 5,55 jt; PPh 23 2 % of DPP = 100 rb; net 5,45 jt. Two = 10,9 jt.
    const a = await inv(g, "A", "PT Mitra Jasa", "2026-08-01", "2026-08-10", "5000000", { ppn: "550000", whtKind: "PPH_23", whtRate: "2" });
    const b = await inv(g, "B", "PT Mitra Jasa", "2026-08-02", "2026-08-20", "5000000", { ppn: "550000", whtKind: "PPH_23", whtRate: "2" });
    const r = await settleFifo(db, { clientId: g.client.id, bankTransactionId: (await tx("MITRA")).id, contactId: a.contactId });
    expect(r.settled).toEqual([{ number: "A", amount: 5_550_000n }, { number: "B", amount: 5_550_000n }]);
    expect(r.rest).toBe(0n);
    for (const i of [a, b]) expect(await db.invoiceSettlement.findFirstOrThrow({ where: { invoiceId: i.id } })).toMatchObject({ amount: 5_550_000n, withheld: 100_000n });
    expect(await tx("MITRA")).toMatchObject({ whtKind: "PPH_23", whtAmount: 200_000n });
    const end = dateOnly(2026, 8, 31);
    expect(await gl(g, "1130", end)).toBe(0n); // 11,1 jt invoiced − 11,1 jt cleared gross
    expect(await gl(g, "1180", end)).toBe(200_000n);
    expect(await gl(g, "1101", end)).toBe(10_900_000n);
    const [c] = await subledgerVsLedger(db, g.client.id, "SALES", end);
    expect([c.open, c.advances, c.unallocated, c.subledger, c.ledger, c.equal]).toEqual([0n, 0n, 0n, 0n, 0n, true]);
  });

  it("PPh 4(2) withheld by the customer: receivable closes gross, the tax is final on 8200", async () => {
    const g = await makeGroup();
    const tx = await bank(g, [["25/08/2026", "TRSF CR PT KONSTRUKSI RAYA", 0, 18_000_000]]);
    // DPP 20 jt, no PPN; PPh 4(2) 10 % = 2 jt; cash 18 jt.
    const a = await inv(g, "K-1", "PT Konstruksi Raya", "2026-08-01", "2026-08-31", "20000000", { whtKind: "PPH_4_2", whtRate: "10" });
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: a.id, bankTransactionId: (await tx("KONSTRUKSI")).id });
    const end = dateOnly(2026, 8, 31);
    expect(await db.invoiceSettlement.findFirstOrThrow({ where: { invoiceId: a.id } })).toMatchObject({ amount: 20_000_000n, withheld: 2_000_000n });
    expect([await gl(g, "1130", end), await gl(g, "8200", end), await gl(g, "1180", end)]).toEqual([0n, 2_000_000n, 0n]);
  });

  it("purchase bill paid net of PPh 23 we withhold: 2110 debited gross, 2141 owed, remittance judged by the 15th", async () => {
    const g = await makeGroup();
    const tx = await bank(g, [
      ["20/08/2026", "TRSF DB CV SUMBER MESIN", 10_900_000, 0],
      ["14/09/2026", "SETOR PPH 23 MASA AGUSTUS", 200_000, 0],
    ]);
    // DPP 10 jt + PPN 1,1 jt = 11,1 jt; PPh 23 2 % = 200 rb; paid 10,9 jt.
    const bill = await createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "PURCHASE", contactName: "CV Sumber Mesin", number: "B-1", issueDate: "2026-08-01", dueDate: "2026-08-31", dpp: "10000000", ppn: "1100000", counterCode: "6190", whtKind: "PPH_23", whtRate: "2" });
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: bill.id, bankTransactionId: (await tx("SUMBER MESIN")).id });
    const aug = dateOnly(2026, 8, 31);
    expect([await gl(g, "2110", aug), await gl(g, "2141", aug), await gl(g, "1150", aug)]).toEqual([0n, -200_000n, 1_100_000n]);
    const [ap] = await subledgerVsLedger(db, g.client.id, "PURCHASE", aug);
    expect(ap.equal).toBe(true);
    const augReport = (await masaReport(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 8, now: dateOnly(2026, 10, 1) }))!;
    expect(augReport.rows.find((r) => r.key === "PPH_23")).toMatchObject({ owed: 200_000n, balance: 200_000n, other: 0n });
    await reviewTransaction(db, { bankTxId: (await tx("SETOR PPH 23")).id, accountCode: "2141", taxTag: null });
    const sep = (await masaReport(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 9, now: dateOnly(2026, 10, 1) }))!;
    const row = sep.rows.find((r) => r.key === "PPH_23")!;
    expect(row.previous).toMatchObject({ owed: 200_000n, short: 0n, state: "LUNAS" });
    expect([row.owed, row.balance, row.other, row.status]).toEqual([0n, 0n, 0n, "PASS"]);
  });

  it("opening invoice: subledger from the opening date equals the opening 1130, ages from its own due date", async () => {
    const g = await makeGroup();
    await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 7, 31), lines: [{ accountCode: "1130", debit: "5000000", credit: "0" }, { accountCode: "3100", debit: "0", credit: "5000000" }] });
    const ob = await inv(g, "OB-1", "Toko Lama", "2026-06-15", "2026-07-15", "5000000", { opening: true });
    expect(ob.entryId).toBeNull();
    const tx = await bank(g, [["20/08/2026", "TRSF CR TOKO LAMA", 0, 2_000_000]]);
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: ob.id, bankTransactionId: (await tx("TOKO LAMA")).id });
    // 31 Jul: listed from the opening date; 16 days past due.
    const [jul] = await invoicesAt(db, g.client.id, "SALES", dateOnly(2026, 7, 31));
    expect([jul.open, jul.daysPastDue, jul.bucket]).toEqual([5_000_000n, 16, "D1_30"]);
    // 31 Aug: 3 jt open, 47 days.
    const [c] = await subledgerVsLedger(db, g.client.id, "SALES", dateOnly(2026, 8, 31));
    expect([c.open, c.ledger, c.equal]).toEqual([3_000_000n, 3_000_000n, true]);
    const controls = await runControls(db, g.client.id, 2026, 8);
    expect(controls.find((x) => x.key === `ar:${g.pt.entity.id}`)?.status).toBe("PASS");
  });

  it("void: a part-paid invoice is refused; an unpaid one nets to zero in the GL and leaves PPN keluaran", async () => {
    const g = await makeGroup();
    const tx = await bank(g, [["20/08/2026", "TRSF CR TOKO SEJAHTERA", 0, 1_000_000]]);
    const paid = await inv(g, "N-1", "Toko Sejahtera", "2026-08-01", "2026-08-31", "2000000", { ppn: "220000" });
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: paid.id, bankTransactionId: (await tx("TOKO")).id });
    await expect(voidInvoice(db, { clientId: g.client.id, invoiceId: paid.id, reason: "salah input pelanggan" })).rejects.toThrow(/sudah dicocokkan/);
    const wrong = await inv(g, "N-2", "Toko Sejahtera", "2026-08-05", "2026-08-31", "3000000", { ppn: "330000" });
    await voidInvoice(db, { clientId: g.client.id, invoiceId: wrong.id, reason: "dokumen pemasok, bukan penjualan" });
    const end = dateOnly(2026, 8, 31);
    // Left: N-1 2,22 jt − 1 jt = 1,22 jt; 2130 only N-1's 220 rb.
    expect([await gl(g, "1130", end), await gl(g, "2130", end), await gl(g, "4100", end)]).toEqual([1_220_000n, -220_000n, -2_000_000n]);
    const r = (await masaReport(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 8, now: dateOnly(2026, 10, 1) }))!;
    expect(r.rows.find((x) => x.key === "PPN")!.ppn).toMatchObject({ keluaran: 220_000n, masukan: 0n });
  });
});

describe("PPN masa, kompensasi", () => {
  beforeEach(resetDb);

  it("lebih bayar carried within a year, compensation journal, next masa", async () => {
    const g = await makeGroup();
    // Jan: masukan 1,1 jt, keluaran 220 rb → LB 880 rb. Feb: keluaran 330 rb → LB 550 rb. Mar: keluaran 1 jt → owed 450 rb.
    await createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "PURCHASE", contactName: "CV Pemasok", number: "P-1", issueDate: "2026-01-05", dueDate: "2026-01-05", dpp: "10000000", ppn: "1100000", counterCode: "6190" });
    await inv(g, "S-1", "Toko A", "2026-01-10", "2026-01-10", "2000000", { ppn: "220000" });
    await inv(g, "S-2", "Toko A", "2026-02-10", "2026-02-10", "3000000", { ppn: "330000" });
    await inv(g, "S-3", "Toko A", "2026-03-10", "2026-03-10", "10000000", { ppn: "1000000" });
    const ppn = async (month: number) => (await masaReport(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month, now: dateOnly(2026, 6, 1) }))!.rows.find((r) => r.key === "PPN")!;
    const feb = await ppn(2);
    expect(feb.ppn).toMatchObject({ keluaran: 330_000n, masukan: 0n, carryIn: 880_000n, carryOut: 550_000n, offset: 550_000n });
    expect(feb.owed).toBe(0n);
    await postPpnOffset(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 2 });
    const febEnd = dateOnly(2026, 2, 28);
    expect([await gl(g, "2130", febEnd), await gl(g, "1150", febEnd)]).toEqual([0n, 550_000n]);
    const mar = await ppn(3);
    expect(mar.ppn).toMatchObject({ keluaran: 1_000_000n, carryIn: 550_000n, carryOut: 0n, offset: 550_000n });
    expect(mar.owed).toBe(450_000n);
  });

  it("a PPN lebih bayar from December is carried into January but dropped from February's report on", async () => {
    const g = await makeGroup();
    // Dec 2025: masukan 1,1 jt → LB 1,1 jt. Jan 2026: keluaran 300 rb → LB 800 rb. Feb 2026: keluaran 200 rb → LB 600 rb.
    await createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "PURCHASE", contactName: "CV Pemasok", number: "P-1", issueDate: "2025-12-05", dueDate: "2025-12-05", dpp: "10000000", ppn: "1100000", counterCode: "6190" });
    await inv(g, "S-1", "Toko A", "2026-01-10", "2026-01-10", "2727273", { ppn: "300000" });
    await inv(g, "S-2", "Toko A", "2026-02-10", "2026-02-10", "1818182", { ppn: "200000" });
    const ppn = async (month: number) => (await masaReport(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month, now: dateOnly(2026, 6, 1) }))!.rows.find((r) => r.key === "PPN")!;
    const jan = await ppn(1);
    expect(jan.ppn).toMatchObject({ keluaran: 300_000n, carryIn: 1_100_000n, carryOut: 800_000n });
    const feb = await ppn(2);
    // February must see January as the January report did: carry in 800 rb, out 600 rb, nothing owed, January nihil.
    expect({ owed: feb.owed, carryIn: feb.ppn!.carryIn, carryOut: feb.ppn!.carryOut, offset: feb.ppn!.offset, prevOwed: feb.previous.owed, status: feb.status }).toEqual({
      owed: 0n,
      carryIn: 800_000n,
      carryOut: 600_000n,
      offset: 500_000n, // 1150 1,1 jt − LB 600 rb carried
      prevOwed: 0n,
      status: "PASS",
    });
  });
});

describe("FX", () => {
  beforeEach(resetDb);

  it("month-end revaluation retranslates a non-monetary asset bought in USD (fixed asset at historical cost)", async () => {
    const g = await makeGroup();
    const e = g.pt.entity;
    // IDR company buys a machine for USD 1.000,00 at 15.000 from a USD account on 1120.
    const [fa, bankUsd] = [await acc(g, "1210"), await acc(g, "1120")];
    await db.$transaction((t) =>
      postJournal(t, {
        entityId: e.id,
        date: dateOnly(2026, 1, 10),
        kind: "IMPORTED",
        memo: "Mesin USD",
        lines: [
          { accountId: fa, debit: 15_000_000n, fx: { currency: "USD", amount: 100_000n, rate: "15000" } },
          { accountId: bankUsd, credit: 15_000_000n, fx: { currency: "USD", amount: 100_000n, rate: "15000" } },
        ],
      }),
    );
    await upsertRate(db, g.firm.id, { currency: "USD", quote: "IDR", date: dateOnly(2026, 1, 31), kind: "SPOT", rate: "16000" });
    const [p] = await revaluationProposals(db, g.client.id, 2026, 1);
    // Only the monetary USD balance (1120, −USD 1.000) moves: −15 jt → −16 jt = −1 jt. The machine stays at its historical 15 jt.
    expect(p.lines.map((l) => [l.code, l.diff])).toEqual([["1120", -1_000_000n]]);
  });

  it("revaluation then next month's re-revaluation books only the change; a USD receivable is revalued", async () => {
    const g = await makeGroup();
    const e = g.pt.entity;
    const [ar, rev, bankUsd] = [await acc(g, "1130"), await acc(g, "4100"), await acc(g, "1120")];
    // Sale USD 333,33 at 15.123,45 = 5.041.098,5... → 5.041.099 (half up); collected USD 100,00 at 15.200 on 20 Jan.
    await db.$transaction((t) =>
      postJournal(t, {
        entityId: e.id,
        date: dateOnly(2026, 1, 5),
        kind: "IMPORTED",
        memo: "Ekspor",
        lines: [
          { accountId: ar, debit: 5_041_099n, fx: { currency: "USD", amount: 33_333n, rate: "15123.45" } },
          { accountId: rev, credit: 5_041_099n, fx: { currency: "USD", amount: 33_333n, rate: "15123.45" } },
        ],
      }),
    );
    await db.$transaction((t) =>
      postJournal(t, {
        entityId: e.id,
        date: dateOnly(2026, 1, 20),
        kind: "IMPORTED",
        memo: "Terima",
        lines: [
          { accountId: bankUsd, debit: 1_520_000n, fx: { currency: "USD", amount: 10_000n, rate: "15200" } },
          { accountId: ar, credit: 1_520_000n, fx: { currency: "USD", amount: 10_000n, rate: "15200" } },
        ],
      }),
    );
    await upsertRate(db, g.firm.id, { currency: "USD", quote: "IDR", date: dateOnly(2026, 1, 31), kind: "SPOT", rate: "15500" });
    // 1130: USD 233,33 → 3.616.615 (233,33 × 15.500 = 3.616.615); carried 5.041.099 − 1.520.000 = 3.521.099 → +95.516.
    // 1120: USD 100 → 1.550.000; carried 1.520.000 → +30.000. Gain 125.516.
    const [p] = await revaluationProposals(db, g.client.id, 2026, 1);
    expect(p.lines.map((l) => [l.code, l.fxBalance, l.carried, l.target, l.diff]).sort()).toEqual([
      ["1120", 10_000n, 1_520_000n, 1_550_000n, 30_000n],
      ["1130", 23_333n, 3_521_099n, 3_616_615n, 95_516n],
    ]);
    await postRevaluation(db, g.client.id, e.id, 2026, 1);
    expect(await gl(g, "7200", dateOnly(2026, 1, 31))).toBe(-125_516n);
    // Feb closing 15.300: 1130 → 233,33 × 15.300 = 3.569.949 (−46.666); 1120 → 1.530.000 (−20.000).
    await upsertRate(db, g.firm.id, { currency: "USD", quote: "IDR", date: dateOnly(2026, 2, 28), kind: "SPOT", rate: "15300" });
    const [q] = await revaluationProposals(db, g.client.id, 2026, 2);
    expect(q.lines.map((l) => [l.code, l.diff]).sort()).toEqual([["1120", -20_000n], ["1130", -46_666n]]);
  });
});

describe("opening", () => {
  beforeEach(resetDb);

  it("a difference goes to 3290 with a Temuan, FAILs opening-diff, and a second save is refused", async () => {
    const g = await makeGroup();
    // Dr 1101 10 jt + 1130 2 jt = 12 jt; Cr 3100 11,5 jt → 500 rb credit to 3290.
    const r = await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 7, 31), lines: [{ accountCode: "1101", debit: "10.000.000", credit: "" }, { accountCode: "1130", debit: "2000000", credit: "0" }, { accountCode: "3100", debit: "0", credit: "11500000" }] });
    expect(r.finding?.amount).toBe(-500_000n);
    expect(await gl(g, "3290", dateOnly(2026, 7, 31))).toBe(-500_000n);
    const c = await runControls(db, g.client.id, 2026, 8);
    expect(c.find((x) => x.key === `opening-diff:${g.pt.entity.id}`)?.status).toBe("FAIL");
    await expect(postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 7, 31), lines: [{ accountCode: "1101", debit: "1", credit: "0" }, { accountCode: "3100", debit: "0", credit: "1" }] })).rejects.toThrow(OpeningError);
  });

  it("opening fixed asset with opening accumulated depreciation: register equals the GL", async () => {
    const g = await makeGroup();
    // Machine cost 24 jt, accumulated 6 jt at 31 Jul 2026, 18 months left → 1 jt a month from Aug.
    await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 7, 31), lines: [{ accountCode: "1210", debit: "24000000", credit: "0" }, { accountCode: "1219", debit: "0", credit: "6000000" }, { accountCode: "3100", debit: "0", credit: "18000000" }] });
    const a = await createAsset(db, { clientId: g.client.id, entityId: g.pt.entity.id, name: "Mesin lama", taxGroup: "KELOMPOK_2", fiscalMethod: "GARIS_LURUS", acquiredOn: "2025-01-15", cost: "24000000", openingAccumulated: "6000000", remainingMonths: 18, usefulLifeMonths: 24, assetAccountCode: "1210" });
    const s = await db.adjustmentSchedule.findUniqueOrThrow({ where: { id: a.scheduleId! } });
    expect([s.amount, s.months, s.startYear, s.startMonth]).toEqual([18_000_000n, 18, 2026, 8]);
    await postInstallment(db, { clientId: g.client.id, scheduleId: s.id, k: 1 });
    const [cmp] = await registerVsLedger(db, g.client.id, 2026, 8);
    expect([cmp.register, cmp.ledger, cmp.equal]).toEqual([{ cost: 24_000_000n, accumulated: 7_000_000n }, { cost: 24_000_000n, accumulated: 7_000_000n }, true]);
  });
});

describe("fixed assets and schedules", () => {
  beforeEach(resetDb);

  it("residual + odd months: Σ instalments = cost − residual exactly, last one absorbs the remainder", async () => {
    const g = await makeGroup();
    // 10.000.000 − 1.000.000 = 9.000.000 over 7 months: 1.285.714 × 6 = 7.714.284, last 1.285.716.
    const a = await createAsset(db, { clientId: g.client.id, entityId: g.pt.entity.id, name: "Laptop", taxGroup: "KELOMPOK_1", fiscalMethod: "GARIS_LURUS", acquiredOn: "2026-01-10", cost: "10000000", residual: "1000000", usefulLifeMonths: 7, assetAccountCode: "1210" });
    const s = await db.adjustmentSchedule.findUniqueOrThrow({ where: { id: a.scheduleId! } });
    const list = installments(s);
    expect(list.map((i) => i.amount)).toEqual([1_285_714n, 1_285_714n, 1_285_714n, 1_285_714n, 1_285_714n, 1_285_714n, 1_285_716n]);
    expect(list.reduce((t, i) => t + i.amount, 0n)).toBe(9_000_000n);
    expect([list[0].year, list[0].month, list.at(-1)!.month]).toEqual([2026, 2, 8]);
  });

  it("disposal mid-life: accumulated to date, gain on 7300, register equals GL afterwards", async () => {
    const g = await makeGroup();
    const [fa, other] = [await acc(g, "1210"), await acc(g, "2120")];
    const buy = await db.$transaction((t) => postJournal(t, { entityId: g.pt.entity.id, date: dateOnly(2026, 1, 10), kind: "ADJUSTMENT", memo: "Beli mobil", lines: [{ accountId: fa, debit: 12_000_000n }, { accountId: other, credit: 12_000_000n }] }));
    const a = await createAsset(db, { clientId: g.client.id, entityId: g.pt.entity.id, name: "Mobil", taxGroup: "KELOMPOK_2", fiscalMethod: "GARIS_LURUS", acquiredOn: "2026-01-10", cost: "12000000", usefulLifeMonths: 12, assetAccountCode: "1210", sourceEntryId: buy.id });
    for (let k = 1; k <= 5; k++) await postInstallment(db, { clientId: g.client.id, scheduleId: a.scheduleId!, k }); // Feb..Jun, 1 jt each
    // Sold 20 Jun for 8 jt (receivable 1140): accumulated 5 jt, book 7 jt, gain 1 jt.
    const d = await disposeAsset(db, { clientId: g.client.id, assetId: a.id, date: "2026-06-20", proceeds: "8000000", proceedsCode: "1140" });
    expect([d.accumulated, d.bookValue, d.result]).toEqual([5_000_000n, 7_000_000n, 1_000_000n]);
    const e = await db.journalEntry.findUniqueOrThrow({ where: { id: d.entryId }, include: { lines: { include: { account: true } } } });
    expect(e.lines.map((l) => [l.account.code, l.debit, l.credit]).sort()).toEqual([["1140", 8_000_000n, 0n], ["1210", 0n, 12_000_000n], ["1219", 5_000_000n, 0n], ["7300", 0n, 1_000_000n]]);
    const [cmp] = await registerVsLedger(db, g.client.id, 2026, 6);
    expect(cmp.equal).toBe(true);
    const [row] = await assetRegister(db, g.client.id, 2026, 6);
    expect([row.cost, row.accumulated, row.bookYtd]).toEqual([0n, 0n, 5_000_000n]);
  });

  it("fiscal straight line (PMK 72/2023): from the acquisition month, pro rata, last year takes the rest", () => {
    // Kelompok 1, 25 %, cost 10 jt, acquired 15 Mar 2026: 2026 = 10 jt × 25 % × 10/12 = 2.083.333,33 → 2.083.333; 2027–2029 2,5 jt; 2030 (Jan–Feb) rest 416.667.
    const asset = { taxGroup: "KELOMPOK_1" as const, fiscalMethod: "GARIS_LURUS" as const, acquiredOn: dateOnly(2026, 3, 15), cost: 10_000_000n };
    expect([2026, 2027, 2028, 2029, 2030, 2031].map((y) => fiscalDepreciation(asset, y).depreciation)).toEqual([2_083_333n, 2_500_000n, 2_500_000n, 2_500_000n, 416_667n, 0n]);
    expect(fiscalDepreciation(asset, 2030).bookValue).toBe(0n);
  });

  it("fiscal declining balance: rate on start-of-year book value, half up, rest in the last year", () => {
    // Kelompok 2, 25 %, cost 100 jt, acquired 1 Jul 2026 (life to Jun 2034).
    // 2026: 100 jt × 25 % × 6/12 = 12.500.000 → BV 87.500.000
    // 2027: 21.875.000 → 65.625.000; 2028: 16.406.250 → 49.218.750; 2029: 12.304.687,5 → 12.304.688 → 36.914.062
    // 2030: 9.228.515,5 → 9.228.516 → 27.685.546; 2031: 6.921.386,5 → 6.921.387 → 20.764.159; 2032: 5.191.039,75 → 5.191.040 → 15.573.119
    // 2033: 3.893.279,75 → 3.893.280 → 11.679.839; 2034 (Jan–Jun): rest 11.679.839.
    const asset = { taxGroup: "KELOMPOK_2" as const, fiscalMethod: "SALDO_MENURUN" as const, acquiredOn: dateOnly(2026, 7, 1), cost: 100_000_000n };
    const years = [2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034].map((y) => fiscalDepreciation(asset, y).depreciation);
    expect(years).toEqual([12_500_000n, 21_875_000n, 16_406_250n, 12_304_688n, 9_228_516n, 6_921_387n, 5_191_040n, 3_893_280n, 11_679_839n]);
    expect(years.reduce((t, v) => t + v, 0n)).toBe(100_000_000n);
  });

  it("amortisation schedule: ⌊total/n⌋ each and the remainder on the last, Σ = total", async () => {
    const g = await makeGroup();
    const s = await createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "AMORTIZATION", memo: "Sewa dibayar di muka", debitCode: "6120", creditCode: "1170", amount: "1000000", months: 3, startYear: 2026, startMonth: 1 });
    expect(installments(s).map((i) => i.amount)).toEqual([333_333n, 333_333n, 333_334n]);
  });
});

describe("more", () => {
  beforeEach(resetDb);

  it("PPh 23 masa paid after the 15th reads TERLAMBAT, paid on the 15th LUNAS", async () => {
    const g = await makeGroup();
    const tx = await bank(g, [
      ["20/08/2026", "TRSF DB CV SUMBER MESIN", 9_800_000, 0],
      ["15/09/2026", "SETOR PPH 23 SEBAGIAN", 50_000, 0],
      ["16/09/2026", "SETOR PPH 23 SISA", 150_000, 0],
    ]);
    // DPP 10 jt, PPh 23 2 % = 200 rb, paid 9,8 jt. Masa Agustus due 15 Sep: 50 rb on time, 150 rb a day late.
    const bill = await createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "PURCHASE", contactName: "CV Sumber Mesin", number: "B-1", issueDate: "2026-08-01", dueDate: "2026-08-31", dpp: "10000000", counterCode: "6190", whtKind: "PPH_23", whtRate: "2" });
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: bill.id, bankTransactionId: (await tx("SUMBER MESIN")).id });
    for (const k of ["SEBAGIAN", "SISA"]) await reviewTransaction(db, { bankTxId: (await tx(k)).id, accountCode: "2141", taxTag: null });
    const row = (await masaReport(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 9, now: dateOnly(2026, 10, 1) }))!.rows.find((r) => r.key === "PPH_23")!;
    expect(row.previous.paid.map((p) => p.amount)).toEqual([50_000n]);
    expect(row.previous.late.map((p) => [p.date.toISOString().slice(0, 10), p.amount])).toEqual([["2026-09-16", 150_000n]]);
    expect([row.previous.state, row.previous.short, row.balance, row.other, row.status]).toEqual(["TERLAMBAT", 0n, 0n, 0n, "REVIEW"]);
  });

  it("CKPN roll rates by hand: 1,95 jt allowance at 31 Mar 2026", async () => {
    const g = await makeGroup();
    const tx = await bank(g, [
      ["15/11/2025", "TRSF CR TOKO B", 0, 500_000],
      ["10/02/2026", "TRSF CR TOKO A", 0, 400_000],
    ]);
    // B: 2 jt, due 30 Sep 2025, 500 rb paid 15 Nov. A: 1 jt, due 31 Jan 2026, 400 rb paid 10 Feb.
    const b = await inv(g, "B", "Toko B", "2025-09-01", "2025-09-30", "2000000");
    const a = await inv(g, "A", "Toko A", "2026-01-01", "2026-01-31", "1000000");
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: b.id, bankTransactionId: (await tx("TOKO B")).id });
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: a.id, bankTransactionId: (await tx("TOKO A")).id });
    // Month-ends Sep 2025 … Mar 2026. B: Sep current (2 jt), Oct 31–60 (2 jt), Nov 61–90 (1,5 jt), Dec > 90. A: Jan current (1 jt), Feb 1–30 (600 rb), Mar 31–60.
    // Roll current = avg(Sep→Oct 2/2 = 100 %, Jan→Feb 0,6/1 = 60 %) = 80 %; 1–30 = Feb→Mar 100 %; 31–60 = Oct→Nov 1,5/2 = 75 %; 61–90 = Nov→Dec 100 %.
    // Loss: > 90 100 %; 61–90 100 %; 31–60 75 %; 1–30 75 %; current 60 %. Open Mar: A 600 rb in 31–60 → 450 rb; B 1,5 jt > 90 → 1,5 jt.
    const c = await ckpn(db, g.client.id, g.pt.entity.id, 2026, 3);
    expect(c.rows.map((r) => [r.bucket, r.open, r.roll, r.rate, r.amount])).toEqual([
      ["CURRENT", 0n, 800_000n, 600_000n, 0n],
      ["D1_30", 0n, 1_000_000n, 750_000n, 0n],
      ["D31_60", 600_000n, 750_000n, 750_000n, 450_000n],
      ["D61_90", 0n, 1_000_000n, 1_000_000n, 0n],
      ["OVER_90", 1_500_000n, null, 1_000_000n, 1_500_000n],
    ]);
    expect(c.total).toBe(1_950_000n);
  });

  it("tax pack: a disposal in the acquisition year keeps a +3,5 jt depreciation correction although book and fiscal deductions are equal", async () => {
    const g = await makeGroup();
    const [fa, other] = [await acc(g, "1210"), await acc(g, "2120")];
    const buy = await db.$transaction((t) => postJournal(t, { entityId: g.pt.entity.id, date: dateOnly(2026, 1, 10), kind: "ADJUSTMENT", memo: "Beli laptop", lines: [{ accountId: fa, debit: 12_000_000n }, { accountId: other, credit: 12_000_000n }] }));
    // Book: 12 months from Feb, 1 jt each; Kelompok 1 fiscal straight line 25 % from Jan = 250 rb a month.
    const a = await createAsset(db, { clientId: g.client.id, entityId: g.pt.entity.id, name: "Laptop", taxGroup: "KELOMPOK_1", fiscalMethod: "GARIS_LURUS", acquiredOn: "2026-01-10", cost: "12000000", usefulLifeMonths: 12, assetAccountCode: "1210", sourceEntryId: buy.id });
    for (let k = 1; k <= 5; k++) await postInstallment(db, { clientId: g.client.id, scheduleId: a.scheduleId!, k });
    await disposeAsset(db, { clientId: g.client.id, assetId: a.id, date: "2026-06-20", proceeds: "8000000", proceedsCode: "1140" });
    // Book 2026: −5 jt depreciation + 1 jt gain = −4 jt. Fiscal: −1,5 jt depreciation (Jan–Jun) − 2,5 jt loss (8 jt − 10,5 jt fiscal value) = −4 jt.
    // Net koreksi fiskal for the asset over the year must be 0 (fiscal profit = commercial profit).
    const pack = (await taxPack(db, g.client.id, g.pt.entity.id, 2026, 12))!;
    expect(pack.profitBeforeTax).toBe(-4_000_000n);
    expect(pack.fiscalProfit - pack.profitBeforeTax).toBe(0n);
  });

  it("two simultaneous clicks on Posting revaluasi book the FX difference twice", async () => {
    const g = await makeGroup();
    const [bankUsd, loan] = [await acc(g, "1120"), await acc(g, "2300")];
    await db.$transaction((t) =>
      postJournal(t, {
        entityId: g.pt.entity.id,
        date: dateOnly(2026, 1, 3),
        kind: "IMPORTED",
        memo: "USD masuk",
        lines: [
          { accountId: bankUsd, debit: 15_000_000n, fx: { currency: "USD", amount: 100_000n, rate: "15000" } },
          { accountId: loan, credit: 15_000_000n },
        ],
      }),
    );
    await upsertRate(db, g.firm.id, { currency: "USD", quote: "IDR", date: dateOnly(2026, 1, 31), kind: "SPOT", rate: "15500" });
    // One revaluation: USD 1.000 × 15.500 = 15,5 jt → +500 rb on 1120, gain 500 rb on 7200.
    await Promise.allSettled([postRevaluation(db, g.client.id, g.pt.entity.id, 2026, 1), postRevaluation(db, g.client.id, g.pt.entity.id, 2026, 1)]);
    const end = dateOnly(2026, 1, 31);
    expect([await gl(g, "1120", end), await gl(g, "7200", end)]).toEqual([15_500_000n, -500_000n]);
  });
});

describe("Saldo Awal boundary", () => {
  beforeEach(resetDb);

  it("a regular (non Saldo Awal) invoice dated before the opening date posts and counts the receivable twice", async () => {
    const g = await makeGroup();
    // Saldo Awal 31 Jul 2026 already holds Toko Lama's 5 jt receivable.
    await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 7, 31), lines: [{ accountCode: "1130", debit: "5000000", credit: "0" }, { accountCode: "3100", debit: "0", credit: "5000000" }] });
    // The same note typed without "Saldo awal" ticked, dated 20 Jul: bank and ledger imports refuse rows on/before the opening
    // (BEFORE_OPENING: "akan terhitung dua kali"); an invoice must too, else 1130 = 10 jt and July revenue appears before the books start.
    await expect(inv(g, "OB-1", "Toko Lama", "2026-07-20", "2026-07-31", "5000000")).rejects.toThrow();
    expect(await gl(g, "1130", dateOnly(2026, 7, 31))).toBe(5_000_000n);
  });

  it("receipt before the invoice: no comparison at the first month end (advance invisible to ar:), equal at the second", async () => {
    const g = await makeGroup();
    const tx = await bank(g, [["25/07/2026", "TRSF CR TOKO DULU", 0, 3_000_000]]);
    const line = await tx("TOKO DULU");
    const n = await inv(g, "N-9", "Toko Dulu", "2026-08-05", "2026-08-20", "3000000");
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: n.id, bankTransactionId: line.id });
    expect(await gl(g, "1130", dateOnly(2026, 7, 31))).toBe(-3_000_000n);
    expect(await subledgerVsLedger(db, g.client.id, "SALES", dateOnly(2026, 7, 31))).toEqual([]);
    const [aug] = await subledgerVsLedger(db, g.client.id, "SALES", dateOnly(2026, 8, 31));
    expect([aug.open, aug.ledger, aug.equal]).toEqual([0n, 0n, true]);
  });
});

void settle;
