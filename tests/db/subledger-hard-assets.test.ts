import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { db, makeGroup, resetDb } from "../helpers";
import { importStatement } from "@/lib/import/pipeline";
import { createInvoice } from "@/lib/receivables/invoices";
import { settleWithReclass } from "@/lib/receivables/settle";
import { reviewTransaction } from "@/lib/review";
import { createAsset, assetRegister, registerVsLedger } from "@/lib/assets/register";
import { disposeAsset } from "@/lib/assets/dispose";
import { postInstallment } from "@/lib/adjust/schedules";
import { cashFlow, fixedAssetMovement } from "@/lib/reports/statements";
import { balanceSheet, incomeStatement } from "@/lib/reports/ledger";
import { taxPack } from "@/lib/tax/pack";
import { creditPackWorkbook } from "@/lib/reports/credit-pack";
import { postOpening } from "@/lib/opening";
import { receiptsVsRevenue } from "@/lib/reports/credit";
import { dateOnly } from "@/lib/format";

/**
 * Hard test: a fixed asset across a year end (round five). Every expected figure is computed by hand in the comment beside it.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;

async function gl(g: G, code: string, asOf: Date) {
  const s = await db.journalLine.aggregate({ where: { entityId: g.pt.entity.id, account: { clientId: g.client.id, code }, date: { lte: asOf } }, _sum: { debit: true, credit: true } });
  return (s._sum.debit ?? 0n) - (s._sum.credit ?? 0n);
}
function csv(rows: [string, string, number, number][]) {
  let bal = 500_000_000;
  return Buffer.from(["Tanggal;Keterangan;Debet;Kredit;Saldo", ...rows.map(([d, k, dr, cr]) => `${d};${k};${dr};${cr};${(bal = bal - dr + cr)}`), ""].join("\n"));
}
async function bank(g: G, rows: [string, string, number, number][]) {
  await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca.csv", data: csv(rows), provider: null });
  return (text: string) => db.bankTransaction.findFirstOrThrow({ where: { description: { contains: text } } });
}
const lock = (g: G, year: number, month: number) =>
  db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year, month } }, create: { firmId: g.firm.id, clientId: g.client.id, year, month, status: "LOCKED" }, update: { status: "LOCKED" } });

/**
 * Mesin bubut bought on a bill: 15 Jul 2025, DPP 120.000.000 on 1210 + PPN 13.200.000 = 133.200.000, paid in full 10 Aug 2025.
 * Book: 48 months, 2.500.000 a month from August 2025 (the month after acquisition). Kelompok 2 straight line 12,5 % (fiscal from July).
 * November's instalment is skipped and posted late in December. Sold 20 Jun 2026 for 90.000.000 on 1140, received 5 Jul 2026.
 */
async function machine(g: G) {
  const tx = await bank(g, [
    ["10/08/2025", "TRSF DB CV MESIN JAYA", 133_200_000, 0],
    ["05/07/2026", "TRSF CR PT PEMBELI MESIN", 0, 90_000_000],
  ]);
  const bill = await createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "PURCHASE", contactName: "CV Mesin Jaya", number: "MJ-77", issueDate: "2025-07-15", dueDate: "2025-08-15", dpp: "120000000", ppn: "13200000", counterCode: "1210" });
  await settleWithReclass(db, { clientId: g.client.id, invoiceId: bill.id, bankTransactionId: (await tx("MESIN JAYA")).id });
  const a = await createAsset(db, { clientId: g.client.id, entityId: g.pt.entity.id, name: "Mesin bubut", taxGroup: "KELOMPOK_2", fiscalMethod: "GARIS_LURUS", acquiredOn: "2025-07-15", cost: "120000000", usefulLifeMonths: 48, assetAccountCode: "1210", sourceEntryId: bill.entryId });
  const post = (k: number) => postInstallment(db, { clientId: g.client.id, scheduleId: a.scheduleId!, k });
  return { tx, bill, a, post };
}

describe("hard test: fixed asset across a year end", () => {
  beforeEach(resetDb);

  it("2025: start month, skipped instalment posted late, register = GL, cash flow investing = DPP paid, fiscal correction", async () => {
    const g = await makeGroup();
    const { a, post } = await machine(g);
    const s = await db.adjustmentSchedule.findUniqueOrThrow({ where: { id: a.scheduleId! } });
    expect([s.startYear, s.startMonth, s.amount, s.months]).toEqual([2025, 8, 120_000_000n, 48]);
    await post(1); // Aug
    await post(2); // Sep
    await post(3); // Oct
    // Nov (k=4) skipped; Dec posted, then Nov late.
    await post(5);
    const [nov] = await assetRegister(db, g.client.id, 2025, 12);
    expect(nov.unposted).toBe(1);
    await post(4);
    const dec = dateOnly(2025, 12, 31);
    // 5 × 2.500.000 = 12.500.000 accumulated; GL 1219 −12.500.000.
    const [row] = await assetRegister(db, g.client.id, 2025, 12);
    expect([row.cost, row.accumulated, row.bookValue, row.bookYtd, row.unposted]).toEqual([120_000_000n, 12_500_000n, 107_500_000n, 12_500_000n, 0]);
    // Fiscal 2025: 120.000.000 × 12,5 % × 6/12 (Jul–Dec) = 7.500.000; book − fiscal = +5.000.000.
    expect([row.fiscalYtd, row.difference]).toEqual([7_500_000n, 5_000_000n]);
    expect(await gl(g, "1219", dec)).toBe(-12_500_000n);
    const [cmp] = await registerVsLedger(db, g.client.id, 2025, 12);
    expect(cmp.equal).toBe(true);
    // Cash flow 2025: paid 133.200.000 → investing 133.200.000 × 120/133,2 = 120.000.000; PPN 13.200.000 is operating (1150 up).
    const cf = await cashFlow(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, dec);
    expect(cf.investing.find((i) => i.key === "ASET_TETAP")?.amount).toBe(-120_000_000n);
    expect(cf.totals.INVESTING).toBe(-120_000_000n);
    // Operating: net loss −12.500.000 + depreciation 12.500.000 − PPN 13.200.000 = −13.200.000.
    expect(cf.totals.OPERATING).toBe(-13_200_000n);
    expect(cf.net).toBe(-133_200_000n);
    const pack = (await taxPack(db, g.client.id, g.pt.entity.id, 2025, 12))!;
    expect(pack.corrections.find((c) => c.key === "auto:depreciation")).toMatchObject({ direction: "POSITIVE", amount: 5_000_000n });
  });

  it("2026: disposal at a loss in June (month depreciated in full), proceeds collected in July; register, movement, cash flow, tax pack", async () => {
    const g = await makeGroup();
    const { a, post } = await machine(g);
    for (let k = 1; k <= 5; k++) await post(k); // Aug–Dec 2025
    await lock(g, 2025, 12);
    // Disposal before June's instalment is refused.
    for (let k = 6; k <= 10; k++) await post(k); // Jan–May 2026
    await expect(disposeAsset(db, { clientId: g.client.id, assetId: a.id, date: "2026-06-20", proceeds: "90000000", proceedsCode: "1140" })).rejects.toThrow(/Catat dulu penyusutan/);
    await post(11); // Jun
    // Accumulated 12.500.000 + 6 × 2.500.000 = 27.500.000; book value 92.500.000; loss 2.500.000.
    const d = await disposeAsset(db, { clientId: g.client.id, assetId: a.id, date: "2026-06-20", proceeds: "90000000", proceedsCode: "1140" });
    expect([d.accumulated, d.bookValue, d.result]).toEqual([27_500_000n, 92_500_000n, -2_500_000n]);
    const jun = dateOnly(2026, 6, 30);
    expect([await gl(g, "1210", jun), await gl(g, "1219", jun), await gl(g, "1140", jun), await gl(g, "7300", jun)]).toEqual([0n, 0n, 90_000_000n, 2_500_000n]);
    const [cmp] = await registerVsLedger(db, g.client.id, 2026, 6);
    expect([cmp.register, cmp.ledger, cmp.equal]).toEqual([{ cost: 0n, accumulated: 0n }, { cost: 0n, accumulated: 0n }, true]);
    const [row] = await assetRegister(db, g.client.id, 2026, 6);
    // 2026 book 15.000.000; fiscal Jan–Jun 6 × 1.250.000 = 7.500.000; fiscal accumulated 7.500.000 + 7.500.000 = 15.000.000;
    // disposal difference fiscal − book accumulated = 15.000.000 − 27.500.000 = −12.500.000.
    expect([row.bookYtd, row.fiscalYtd, row.difference, row.disposalDifference]).toEqual([15_000_000n, 7_500_000n, 7_500_000n, -12_500_000n]);
    // CALK movement 1 Jan – 30 Jun 2026: cost 120.000.000 → −120.000.000 → 0; accumulated −12.500.000, +(−15.000.000), +27.500.000 → 0.
    const mv = await fixedAssetMovement(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, jun);
    expect(mv.rows.map((r) => [r.code, r.opening, r.additions, r.deductions, r.closing])).toEqual([
      ["1210", 120_000_000n, 0n, -120_000_000n, 0n],
      ["1219", -12_500_000n, -15_000_000n, 27_500_000n, 0n],
    ]);
    // Proceeds received 5 Jul, classified to 1140.
    const receipt = await db.bankTransaction.findFirstOrThrow({ where: { description: { contains: "PEMBELI MESIN" } } });
    await reviewTransaction(db, { bankTxId: receipt.id, accountCode: "1140", taxTag: null });
    const jul = dateOnly(2026, 7, 31);
    const cfJun = await cashFlow(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, jun);
    // By June nothing collected: investing 0; operating = −17.500.000 + 15.000.000 dep + 92.500.000 non-cash disposal − 90.000.000 (1140 up) = 0.
    expect([cfJun.totals.INVESTING, cfJun.totals.OPERATING, cfJun.net]).toEqual([0n, 0n, 0n]);
    const cfJul = await cashFlow(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, jul);
    expect(cfJul.investing.find((i) => i.key === "DISPOSAL")?.amount).toBe(90_000_000n);
    expect([cfJul.totals.INVESTING, cfJul.totals.OPERATING, cfJul.net]).toEqual([90_000_000n, 0n, 90_000_000n]);
    // Tax pack 2026: book −15.000.000 − 2.500.000 = −17.500.000; fiscal −7.500.000 + (90.000.000 − 105.000.000) = −22.500.000;
    // corrections net −5.000.000 (2025's +5.000.000 reverses).
    const pack = (await taxPack(db, g.client.id, g.pt.entity.id, 2026, 12))!;
    expect(pack.profitBeforeTax).toBe(-17_500_000n);
    expect(pack.fiscalProfit - pack.profitBeforeTax).toBe(-5_000_000n);
    // Neraca 31 Dec 2026 balances; Laba Rugi 2026 holds the loss on 7300.
    const scope = { clientId: g.client.id, entityIds: [g.pt.entity.id] };
    expect((await balanceSheet(db, scope, dateOnly(2026, 12, 31))).totals.difference).toBe(0n);
    const is = await incomeStatement(db, scope, dateOnly(2026, 1, 1), dateOnly(2026, 12, 31));
    expect(is.totals.netProfit).toBe(-17_500_000n);
  });

  it("disposal at a gain in the acquisition year: laptop 12.000.000, 12 months from April, sold 10 Sep for 10.000.000", async () => {
    const g = await makeGroup();
    const bill = await createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "PURCHASE", contactName: "Toko Komputer", number: "TK-1", issueDate: "2026-03-01", dueDate: "2026-03-31", dpp: "12000000", counterCode: "1210" });
    const a = await createAsset(db, { clientId: g.client.id, entityId: g.pt.entity.id, name: "Laptop", taxGroup: "KELOMPOK_1", fiscalMethod: "GARIS_LURUS", acquiredOn: "2026-03-01", cost: "12000000", usefulLifeMonths: 12, assetAccountCode: "1210", sourceEntryId: bill.entryId });
    for (let k = 1; k <= 6; k++) await postInstallment(db, { clientId: g.client.id, scheduleId: a.scheduleId!, k }); // Apr–Sep
    // Accumulated 6.000.000, book value 6.000.000, gain 4.000.000.
    const d = await disposeAsset(db, { clientId: g.client.id, assetId: a.id, date: "2026-09-10", proceeds: "10000000", proceedsCode: "1140" });
    expect([d.accumulated, d.bookValue, d.result]).toEqual([6_000_000n, 6_000_000n, 4_000_000n]);
    // Fiscal Kelompok 1 25 % from March: 2026 = 12.000.000 × 25 % × 10/12 = 2.500.000 → 250.000 a month; Mar–Sep 1.750.000;
    // fiscal value 10.250.000 → fiscal loss 250.000. Book −6.000.000 + 4.000.000 = −2.000.000 = fiscal −1.750.000 − 250.000.
    const [row] = await assetRegister(db, g.client.id, 2026, 12);
    expect([row.bookYtd, row.fiscalYtd, row.disposalDifference]).toEqual([6_000_000n, 1_750_000n, -4_250_000n]);
    const pack = (await taxPack(db, g.client.id, g.pt.entity.id, 2026, 12))!;
    expect(pack.fiscalProfit - pack.profitBeforeTax).toBe(0n);
  });

  it("Paket Kredit Bank, Mutasi vs Omzet: the 90.000.000 for the machine sold is not a business receipt", async () => {
    const g = await makeGroup();
    const { a, post } = await machine(g);
    for (let k = 1; k <= 11; k++) await post(k);
    await disposeAsset(db, { clientId: g.client.id, assetId: a.id, date: "2026-06-20", proceeds: "90000000", proceedsCode: "1140" });
    const receipt = await db.bankTransaction.findFirstOrThrow({ where: { description: { contains: "PEMBELI MESIN" } } });
    await reviewTransaction(db, { bankTxId: receipt.id, accountCode: "1140", taxTag: null });
    const months = await receiptsVsRevenue(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 7 });
    const jul = months.find((m) => m.year === 2026 && m.month === 7)!;
    // July: money in 90.000.000, all of it the disposal's proceeds (investing, the cash flow's "Hasil pelepasan aset tetap"); revenue 0.
    // "Penerimaan usaha" compared with revenue must leave it out, else the bank reads 90 jt of sales receipts against no sales.
    expect([jul.moneyIn, jul.revenue]).toEqual([90_000_000n, 0n]);
    expect(jul.operating).toBe(0n);
  });

  it("Paket Kredit Bank for March 2026 lists the machine sold in June (it was held on 31 March)", async () => {
    const g = await makeGroup();
    const { a, post } = await machine(g);
    for (let k = 1; k <= 11; k++) await post(k); // Aug 2025 – Jun 2026
    await disposeAsset(db, { clientId: g.client.id, assetId: a.id, date: "2026-06-20", proceeds: "90000000", proceedsCode: "1140" });
    // 31 Mar 2026: cost 120.000.000, accumulated 5 + 3 = 8 × 2.500.000 = 20.000.000, book value 100.000.000 (the Neraca's Aset tetap).
    const [mar] = await assetRegister(db, g.client.id, 2026, 3);
    expect([mar.cost, mar.accumulated, mar.bookValue]).toEqual([120_000_000n, 20_000_000n, 100_000_000n]);
    const buf = await creditPackWorkbook(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 3, meta: { firm: "KJA Uji", title: "PT Uji Sejahtera" } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Aset Tetap")!;
    const values: unknown[][] = [];
    ws.eachRow((r) => values.push((r.values as unknown[]).slice(1)));
    const machineRow = values.find((v) => v[0] === "Mesin bubut");
    expect(machineRow?.slice(2)).toEqual([120_000_000, 20_000_000, 100_000_000]);
  });
});

describe("hard test: Saldo Awal asset and a bill paid across a year end", () => {
  beforeEach(resetDb);

  it("asset from Saldo Awal (opening accumulated), disposed in Q1 next year at a loss; tax pack reverses the timing difference", async () => {
    const g = await makeGroup();
    // Saldo Awal 31 Dec 2025: kendaraan 60.000.000, accumulated 23.000.000 (acquired 10 Jan 2024, 60 months, 1.000.000 a month from Feb 2024).
    await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2025, 12, 31), lines: [{ accountCode: "1210", debit: "60000000", credit: "0" }, { accountCode: "1219", debit: "0", credit: "23000000" }, { accountCode: "3100", debit: "0", credit: "37000000" }] });
    const a = await createAsset(db, { clientId: g.client.id, entityId: g.pt.entity.id, name: "Kendaraan", taxGroup: "KELOMPOK_2", fiscalMethod: "GARIS_LURUS", acquiredOn: "2024-01-10", cost: "60000000", openingAccumulated: "23000000", remainingMonths: 37, usefulLifeMonths: 60, assetAccountCode: "1210" });
    const s = await db.adjustmentSchedule.findUniqueOrThrow({ where: { id: a.scheduleId! } });
    expect([s.amount, s.months, s.startYear, s.startMonth]).toEqual([37_000_000n, 37, 2026, 1]);
    for (let k = 1; k <= 3; k++) await postInstallment(db, { clientId: g.client.id, scheduleId: s.id, k }); // Jan–Mar 2026
    // Sold 15 Mar 2026 for 30.000.000: accumulated 26.000.000, book value 34.000.000, loss 4.000.000.
    const d = await disposeAsset(db, { clientId: g.client.id, assetId: a.id, date: "2026-03-15", proceeds: "30000000", proceedsCode: "1140" });
    expect([d.accumulated, d.bookValue, d.result]).toEqual([26_000_000n, 34_000_000n, -4_000_000n]);
    // Fiscal Kelompok 2 12,5 % from Jan 2024: 7.500.000 a year, 625.000 a month; at Mar 2026 16.875.000 accumulated, value 43.125.000,
    // fiscal loss 13.125.000. Book 2026 −3.000.000 − 4.000.000 = −7.000.000; fiscal −1.875.000 − 13.125.000 = −15.000.000; net −8.000.000.
    const [row] = await assetRegister(db, g.client.id, 2026, 3);
    expect([row.bookYtd, row.fiscalYtd, row.disposalDifference]).toEqual([3_000_000n, 1_875_000n, -9_125_000n]);
    const pack = (await taxPack(db, g.client.id, g.pt.entity.id, 2026, 3))!;
    expect(pack.profitBeforeTax).toBe(-7_000_000n);
    expect(pack.fiscalProfit - pack.profitBeforeTax).toBe(-8_000_000n);
    const mv = await fixedAssetMovement(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, dateOnly(2026, 3, 31));
    expect(mv.rows.map((r) => [r.code, r.opening, r.additions, r.deductions, r.closing])).toEqual([
      ["1210", 60_000_000n, 0n, -60_000_000n, 0n],
      ["1219", -23_000_000n, -3_000_000n, 26_000_000n, 0n],
    ]);
    const [cmp] = await registerVsLedger(db, g.client.id, 2026, 3);
    expect(cmp.equal).toBe(true);
  });

  it("an equipment bill paid in two parts across a year end: investing outflows add up to the cost", async () => {
    const g = await makeGroup();
    const tx = await bank(g, [
      ["20/12/2025", "TRSF DB CV MESIN JAYA TERMIN 1", 50_000_001, 0],
      ["20/01/2026", "TRSF DB CV MESIN JAYA TERMIN 2", 83_199_999, 0],
    ]);
    // DPP 120.000.000 on 1210 + PPN 13.200.000 = 133.200.000, paid 50.000.001 + 83.199.999.
    const bill = await createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "PURCHASE", contactName: "CV Mesin Jaya", number: "MJ-9", issueDate: "2025-12-01", dueDate: "2026-01-31", dpp: "120000000", ppn: "13200000", counterCode: "1210" });
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: bill.id, bankTransactionId: (await tx("TERMIN 1")).id });
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: bill.id, bankTransactionId: (await tx("TERMIN 2")).id });
    const s = { clientId: g.client.id, entityIds: [g.pt.entity.id] };
    const y25 = (await cashFlow(db, s, dateOnly(2025, 12, 31))).totals.INVESTING;
    const y26 = (await cashFlow(db, s, dateOnly(2026, 12, 31))).totals.INVESTING;
    // 2025: 50.000.001 × 120/133,2 = 45.045.045,95…; 2026: 83.199.999 × 120/133,2 = 74.954.954,05…. Whatever the split, the two years'
    // investing outflows must add up to the 120.000.000 the machine cost (the last payment takes the rest).
    expect(y25 + y26).toBe(-120_000_000n);
  });
  it("books opened mid-year (Saldo Awal 30 Jun): the tax pack's depreciation correction covers the same months as the profit (Jul–Dec)", async () => {
    const g = await makeGroup();
    // Saldo Awal 30 Jun 2026: kendaraan 60.000.000 acquired 10 Jan 2024, 1.000.000 a month from Feb 2024 → 29.000.000 accumulated.
    await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 6, 30), lines: [{ accountCode: "1210", debit: "60000000", credit: "0" }, { accountCode: "1219", debit: "0", credit: "29000000" }, { accountCode: "3100", debit: "0", credit: "31000000" }] });
    const a = await createAsset(db, { clientId: g.client.id, entityId: g.pt.entity.id, name: "Kendaraan", taxGroup: "KELOMPOK_2", fiscalMethod: "GARIS_LURUS", acquiredOn: "2024-01-10", cost: "60000000", openingAccumulated: "29000000", remainingMonths: 31, usefulLifeMonths: 60, assetAccountCode: "1210" });
    for (let k = 1; k <= 6; k++) await postInstallment(db, { clientId: g.client.id, scheduleId: a.scheduleId!, k }); // Jul–Dec 2026
    const pack = (await taxPack(db, g.client.id, g.pt.entity.id, 2026, 12))!;
    // The books (and the pack's profit before tax, months = 6) start 1 Jul: book depreciation Jul–Dec 6.000.000. Fiscal Kelompok 2
    // 12,5 % = 7.500.000 a year → Jul–Dec 3.750.000. Correction +2.250.000. Counting fiscal Jan–Jun too (7.500.000) deducts six months
    // of depreciation against a profit that holds none of those months' income (that result is in Saldo Laba).
    expect(pack.months).toBe(6);
    expect(pack.profitBeforeTax).toBe(-6_000_000n);
    expect(pack.corrections.find((c) => c.key === "auto:depreciation")).toMatchObject({ direction: "POSITIVE", amount: 2_250_000n });
  });
});
