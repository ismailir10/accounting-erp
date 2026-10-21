import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { db, makeGroup, resetDb } from "../helpers";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { reverseEntry } from "@/lib/ledger/reverse";
import { postOpening } from "@/lib/opening";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction } from "@/lib/review";
import { createInvoice } from "@/lib/receivables/invoices";
import { setFiscalYearEnd } from "@/lib/entity-settings";
import { createClient, createFirm } from "@/lib/setup";
import { neracaLajur, type Worksheet } from "@/lib/reports/worksheet";
import { worksheetWorkbook } from "@/lib/reports/ledger-workbook";
import { incomeStatement } from "@/lib/reports/ledger";
import { dateOnly } from "@/lib/format";

/**
 * Round nine, probe A — Neraca Lajur (cycle 2026-10-20-paritas-inti): Neraca Saldo before adjustments + Penyesuaian = Neraca Saldo
 * Disesuaikan = Laba Rugi + Neraca, the profit balancing both last pairs. "Penyesuaian" is the ADJUSTMENT kind (typed journals, their
 * automatic and manual reversals, instalments); bank lines, their reclassifications, invoices and Saldo Awal are the books before. Every
 * figure below is computed by hand in the comments.
 */
const K = 1_000n;
type Row = [code: string, unadjusted: bigint, adjDebit: bigint, adjCredit: bigint, adjusted: bigint, pl: boolean];
const rows = (w: Worksheet): Row[] => w.lines.map((l) => [l.account.code, l.unadjusted, l.adjDebit, l.adjCredit, l.adjusted, l.pl]);

/**
 * PT, August 2026:
 *   31 Jul Saldo Awal      1101 Dr 10.000.000 / 3100 Cr 10.000.000                              (before)
 *   3 Aug  BIAYA ADM       bank out 15.000, reviewed to 6170 (BANK + RECLASS)                    (before)
 *   5 Aug  SETORAN TUNAI   bank in 2.000.000, reviewed to 4100 (BANK + RECLASS)                  (before)
 *   10 Aug INV-1           1130 Dr 1.110.000 / 4100 Cr 1.000.000, 2130 Cr 110.000 (INVOICE)      (before)
 *   20 Aug Beli ATK        6160 Dr 100.000 / 1110 Cr 100.000                                     (adjustment)
 *   31 Aug its reversal    1110 Dr 100.000 / 6160 Cr 100.000                                     (adjustment)
 *   31 Aug Akrual listrik  6130 Dr 300.000 / 2150 Cr 300.000, Balik otomatis 1 Sep               (adjustment)
 *   31 Aug Penyusutan      6180 Dr 200.000 / 1219 Cr 200.000                                     (adjustment)
 */
async function august() {
  const g = await makeGroup();
  const base = { clientId: g.client.id, entityId: g.pt.entity.id };
  await postOpening(db, { ...base, date: dateOnly(2026, 7, 31), lines: [{ accountCode: "1101", debit: "10.000.000", credit: "" }, { accountCode: "3100", debit: "", credit: "10.000.000" }] });
  const csv = [
    "Tanggal;Keterangan;Debet;Kredit;Saldo",
    "01/08/2026;SALDO AWAL;;;10.000.000,00",
    "03/08/2026;BIAYA ADM;15.000,00;0,00;9.985.000,00",
    "05/08/2026;SETORAN TUNAI TOKO;0,00;2.000.000,00;11.985.000,00",
    "",
  ].join("\n");
  await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "agustus.csv", data: Buffer.from(csv), provider: null });
  for (const [desc, code] of [["BIAYA ADM", "6170"], ["SETORAN", "4100"]] as const) {
    const t = await db.bankTransaction.findFirstOrThrow({ where: { description: { contains: desc } } });
    await reviewTransaction(db, { bankTxId: t.id, accountCode: code, taxTag: null });
  }
  await createInvoice(db, { ...base, direction: "SALES", contactName: "PT A", number: "INV-1", issueDate: "2026-08-10", dpp: "1.000.000", ppn: "110.000", counterCode: "4100" });
  const atk = await postAdjustment(db, { ...base, date: dateOnly(2026, 8, 20), memo: "Beli ATK", lines: [{ accountCode: "6160", debit: "100.000", credit: "" }, { accountCode: "1110", debit: "", credit: "100.000" }] });
  await reverseEntry(db, { clientId: g.client.id, entryId: atk.id, date: dateOnly(2026, 8, 31) });
  await postAdjustment(db, { ...base, date: dateOnly(2026, 8, 31), memo: "Akrual listrik", reverseNextMonth: true, lines: [{ accountCode: "6130", debit: "300.000", credit: "" }, { accountCode: "2150", debit: "", credit: "300.000" }] });
  await postAdjustment(db, { ...base, date: dateOnly(2026, 8, 31), memo: "Penyusutan", lines: [{ accountCode: "6180", debit: "200.000", credit: "" }, { accountCode: "1219", debit: "", credit: "200.000" }] });
  return g;
}

describe("neraca lajur: every column ties, hand-computed", () => {
  beforeEach(resetDb);

  it("August: reclassifications and invoices are before adjustment; an adjustment and its reversal both show gross", async () => {
    const g = await august();
    const w = await neracaLajur(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, dateOnly(2026, 8, 1), dateOnly(2026, 8, 31));
    // unadjusted = closing − (adj Dr − adj Cr); 1999 and the auto-classified account net to zero and are left out.
    expect(rows(w)).toEqual([
      ["1101", 11_985n * K, 0n, 0n, 11_985n * K, false], // 10.000.000 − 15.000 + 2.000.000
      ["1110", 0n, 100n * K, 100n * K, 0n, false],
      ["1130", 1_110n * K, 0n, 0n, 1_110n * K, false],
      ["1219", 0n, 0n, 200n * K, -200n * K, false],
      ["2130", -110n * K, 0n, 0n, -110n * K, false],
      ["2150", 0n, 0n, 300n * K, -300n * K, false],
      ["3100", -10_000n * K, 0n, 0n, -10_000n * K, false],
      ["4100", -3_000n * K, 0n, 0n, -3_000n * K, true], // 1.000.000 invoice + 2.000.000 deposit
      ["6130", 0n, 300n * K, 0n, 300n * K, true],
      ["6160", 0n, 100n * K, 100n * K, 0n, true],
      ["6170", 15n * K, 0n, 0n, 15n * K, true],
      ["6180", 0n, 200n * K, 0n, 200n * K, true],
    ]);
    // Before: Dr 11.985.000 + 1.110.000 + 15.000 = 13.110.000 = Cr 110.000 + 10.000.000 + 3.000.000.
    // Adjustments: 100.000 + 100.000 + 300.000 + 200.000 = 700.000 each side.
    // After: Dr 13.110.000 + 300.000 + 200.000 = 13.610.000 = Cr 13.110.000 + 200.000 + 300.000.
    // Laba Rugi: Dr 300.000 + 15.000 + 200.000 = 515.000, Cr 3.000.000 → profit 2.485.000; Neraca Dr 13.095.000 − Cr 10.610.000 = 2.485.000.
    expect(w.totals).toEqual({
      unadjusted: { debit: 13_110n * K, credit: 13_110n * K },
      adjustments: { debit: 700n * K, credit: 700n * K },
      adjusted: { debit: 13_610n * K, credit: 13_610n * K },
      pl: { debit: 515n * K, credit: 3_000n * K },
      bs: { debit: 13_095n * K, credit: 10_610n * K },
    });
    expect(w.profit).toBe(2_485n * K);
    const is = await incomeStatement(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, dateOnly(2026, 8, 1), dateOnly(2026, 8, 31));
    expect(JSON.stringify(is, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toContain('"2485000"');
  });

  it("the Excel worksheet holds the screen's numbers, and its formulas recompute to the same totals and profit", async () => {
    const g = await august();
    const w = await neracaLajur(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, dateOnly(2026, 8, 1), dateOnly(2026, 8, 31));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await worksheetWorkbook({ firm: "KJA Uji", title: "Grup Uji" }, "Agustus 2026", w)) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Neraca Lajur")!;
    const num = (v: ExcelJS.CellValue) => (v === null || v === undefined ? 0 : typeof v === "number" ? v : typeof v === "object" && "formula" in v ? Number((v as { result?: unknown }).result ?? 0) : Number(v));
    const byCode = new Map<string, number[]>();
    let totalRow: number[] | null = null;
    let profitRow: number[] | null = null;
    let afterRow: number[] | null = null;
    ws.eachRow((r) => {
      const vals = Array.from({ length: 10 }, (_, i) => num(r.getCell(3 + i).value));
      const a = String(r.getCell(1).value ?? "");
      const b = String(r.getCell(2).value ?? "");
      if (/^\d{4}$/.test(a)) byCode.set(a, vals);
      else if (b === "Jumlah") totalRow = vals;
      else if (b === "Laba bersih") profitRow = vals;
      else if (b === "Jumlah setelah laba (rugi)") afterRow = vals;
    });
    for (const l of w.lines) {
      const [c, d, e, f, gg, h, i, j, k, ll] = byCode.get(l.account.code)!;
      // Inputs are the screen's; the formulas' cached results are what Excel recomputes from them.
      expect([c - d, e, f]).toEqual([Number(l.unadjusted), Number(l.adjDebit), Number(l.adjCredit)]);
      expect([gg, h]).toEqual([Math.max(c - d + e - f, 0), Math.max(d - c + f - e, 0)]);
      expect(gg - h).toBe(Number(l.adjusted));
      expect(l.pl ? [i, j, k, ll] : [k, ll, i, j]).toEqual([gg, h, 0, 0]);
    }
    const t = w.totals;
    expect(totalRow).toEqual([t.unadjusted.debit, t.unadjusted.credit, t.adjustments.debit, t.adjustments.credit, t.adjusted.debit, t.adjusted.credit, t.pl.debit, t.pl.credit, t.bs.debit, t.bs.credit].map(Number));
    // Sum of the rows equals the total row's cached SUM.
    const colSum = (i: number) => [...byCode.values()].reduce((s, v) => s + v[i], 0);
    expect(Array.from({ length: 10 }, (_, i) => colSum(i))).toEqual(totalRow);
    // Profit 2.485.000 on the Laba Rugi debit and the Neraca credit; both pairs then balance at 3.000.000 and 13.095.000.
    expect(profitRow!.slice(6)).toEqual([2_485_000, 0, 0, 2_485_000]);
    expect(afterRow!.slice(6)).toEqual([3_000_000, 3_000_000, 13_095_000, 13_095_000]);
  });

  it("a group of two Rupiah companies: the worksheet is the sum of each company's, still balanced", async () => {
    const g = await august();
    // Andi, two Jurnal Penyesuaian (so adjustments): 12 Aug 1110 Dr 500.000 / 3100 Cr 500.000 and 18 Aug 6190 Dr 50.000 / 1110 Cr 50.000.
    await postAdjustment(db, { clientId: g.client.id, entityId: g.owner.entity.id, date: dateOnly(2026, 8, 12), memo: "Setoran modal kas", lines: [{ accountCode: "1110", debit: "500.000", credit: "" }, { accountCode: "3100", debit: "", credit: "500.000" }] });
    await postAdjustment(db, { clientId: g.client.id, entityId: g.owner.entity.id, date: dateOnly(2026, 8, 18), memo: "Biaya lain", lines: [{ accountCode: "6190", debit: "50.000", credit: "" }, { accountCode: "1110", debit: "", credit: "50.000" }] });
    const both = await neracaLajur(db, { clientId: g.client.id, entityIds: [g.pt.entity.id, g.owner.entity.id] }, dateOnly(2026, 8, 1), dateOnly(2026, 8, 31));
    // Adjustments grow by 550.000 each side (700.000 → 1.250.000); 1110 adjusted = 0 + 500.000 − 50.000 = 450.000; profit 2.485.000 − 50.000.
    expect(both.totals.adjustments).toEqual({ debit: 1_250n * K, credit: 1_250n * K });
    expect(both.lines.find((l) => l.account.code === "1110")!.adjusted).toBe(450n * K);
    expect(both.profit).toBe(2_435n * K);
    expect(both.totals.unadjusted.debit).toBe(both.totals.unadjusted.credit);
    expect(both.totals.adjusted.debit).toBe(both.totals.adjusted.credit);
    expect(both.totals.bs.debit - both.totals.bs.credit).toBe(both.profit);
  });

  it("a mixed-currency group is refused (one currency per worksheet)", async () => {
    const firm = await createFirm(db, "KJA Valas");
    const { client, entities } = await createClient(db, firm.id, {
      name: "Grup Valas",
      industry: "trading",
      entities: [
        { name: "PT Rupiah", shortName: "PT Rp", kind: "PT", banks: [] },
        { name: "PT Dolar", shortName: "PT USD", kind: "PT", functionalCurrency: "USD", banks: [] },
      ],
    });
    await expect(neracaLajur(db, { clientId: client.id, entityIds: entities.map((e) => e.entity.id) }, dateOnly(2026, 8, 1), dateOnly(2026, 8, 31))).rejects.toThrow("Neraca lajur hanya untuk satu mata uang");
  });
});

describe("neraca lajur: a financial year ending in March", () => {
  beforeEach(resetDb);

  /**
   * Year end 31 March. 28 Feb 2026 Saldo Awal 1101 5.000.000 / 3100 5.000.000.
   * March (last month of 2025/26): INV-M 1130 Dr 1.000.000 / 4100 Cr 1.000.000; 31 Mar 6180 Dr 100.000 / 1219 Cr 100.000; 31 Mar accrual
   * 6130 Dr 50.000 / 2150 Cr 50.000 with Balik otomatis on 1 Apr. April (first month of 2026/27): INV-A 1130 Dr 400.000 / 4110 Cr 400.000;
   * 30 Apr 6180 Dr 100.000 / 1219 Cr 100.000.
   */
  async function books() {
    const g = await makeGroup();
    await setFiscalYearEnd(db, { clientId: g.client.id, endMonth: 3 });
    const base = { clientId: g.client.id, entityId: g.pt.entity.id };
    await postOpening(db, { ...base, date: dateOnly(2026, 2, 28), lines: [{ accountCode: "1101", debit: "5.000.000", credit: "" }, { accountCode: "3100", debit: "", credit: "5.000.000" }] });
    await createInvoice(db, { ...base, direction: "SALES", contactName: "PT M", number: "INV-M", issueDate: "2026-03-10", dpp: "1.000.000", counterCode: "4100" });
    await postAdjustment(db, { ...base, date: dateOnly(2026, 3, 31), memo: "Penyusutan Maret", lines: [{ accountCode: "6180", debit: "100.000", credit: "" }, { accountCode: "1219", debit: "", credit: "100.000" }] });
    await postAdjustment(db, { ...base, date: dateOnly(2026, 3, 31), memo: "Akrual listrik Maret", reverseNextMonth: true, lines: [{ accountCode: "6130", debit: "50.000", credit: "" }, { accountCode: "2150", debit: "", credit: "50.000" }] });
    await createInvoice(db, { ...base, direction: "SALES", contactName: "PT A", number: "INV-A", issueDate: "2026-04-15", dpp: "400.000", counterCode: "4110" });
    await postAdjustment(db, { ...base, date: dateOnly(2026, 4, 30), memo: "Penyusutan April", lines: [{ accountCode: "6180", debit: "100.000", credit: "" }, { accountCode: "1219", debit: "", credit: "100.000" }] });
    return { g, scope: { clientId: g.client.id, entityIds: [g.pt.entity.id] } };
  }

  it("April, the first month of 2026/27: March's result is folded into Saldo Laba before adjustment; the accrual's reversal is April's adjustment", async () => {
    const { scope } = await books();
    const w = await neracaLajur(db, scope, dateOnly(2026, 4, 1), dateOnly(2026, 4, 30));
    // 3200 = −(1.000.000 − 100.000 − 50.000) = −850.000 (2025/26 profit); 6130 closing (from 1 Apr) = −50.000, adj Cr 50.000 → before 0.
    expect(rows(w)).toEqual([
      ["1101", 5_000n * K, 0n, 0n, 5_000n * K, false],
      ["1130", 1_400n * K, 0n, 0n, 1_400n * K, false],
      ["1219", -100n * K, 0n, 100n * K, -200n * K, false],
      ["2150", -50n * K, 50n * K, 0n, 0n, false],
      ["3100", -5_000n * K, 0n, 0n, -5_000n * K, false],
      ["3200", -850n * K, 0n, 0n, -850n * K, false],
      ["4110", -400n * K, 0n, 0n, -400n * K, true],
      ["6130", 0n, 0n, 50n * K, -50n * K, true],
      ["6180", 0n, 100n * K, 0n, 100n * K, true],
    ]);
    // Before Dr 6.400.000 = Cr 100.000 + 50.000 + 5.000.000 + 850.000 + 400.000; after Dr 6.500.000 = Cr 200.000 + 5.000.000 + 850.000 + 400.000 + 50.000.
    // Laba Rugi Dr 100.000, Cr 450.000 → profit 350.000 (= 400.000 − 100.000 + 50.000); Neraca Dr 6.400.000 − Cr 6.050.000 = 350.000.
    expect(w.totals).toEqual({
      unadjusted: { debit: 6_400n * K, credit: 6_400n * K },
      adjustments: { debit: 150n * K, credit: 150n * K },
      adjusted: { debit: 6_500n * K, credit: 6_500n * K },
      pl: { debit: 100n * K, credit: 450n * K },
      bs: { debit: 6_400n * K, credit: 6_050n * K },
    });
    expect(w.profit).toBe(350n * K);
  });

  it("March year to date (1 Apr 2025 – 31 Mar 2026): the year's adjustments, profit 850.000, nothing in Saldo Laba yet", async () => {
    const { scope } = await books();
    const w = await neracaLajur(db, scope, dateOnly(2025, 4, 1), dateOnly(2026, 3, 31));
    expect(w.lines.find((l) => l.account.code === "3200")).toBeUndefined();
    // Adjustments: 6180/1219 100.000 and 6130/2150 50.000 → 150.000 each side; profit = 1.000.000 − 100.000 − 50.000.
    expect(w.totals.adjustments).toEqual({ debit: 150n * K, credit: 150n * K });
    expect(w.profit).toBe(850n * K);
    expect(w.totals.unadjusted).toEqual({ debit: 6_000n * K, credit: 6_000n * K }); // 1101 5.000.000 + 1130 1.000.000 = 3100 + 4100
  });
});
