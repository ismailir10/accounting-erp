import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { postJournal } from "@/lib/ledger/post";
import { postOpening } from "@/lib/opening";
import { createAsset } from "@/lib/assets/register";
import { disposeAsset } from "@/lib/assets/dispose";
import { cashFlow, equityChanges, fixedAssetMovement } from "@/lib/reports/statements";
import { balanceSheet, incomeStatement, trialBalance, trialBalanceMovement } from "@/lib/reports/ledger";
import { accountLedger } from "@/lib/reports/account-ledger";
import { generalLedger } from "@/lib/reports/general-ledger";
import { dateOnly } from "@/lib/format";
import { CLOSE_SIGNOFFS, lockPeriod, runControls, unlockPeriod } from "@/lib/controls";
import { reverseEntry } from "@/lib/ledger/reverse";
import { createSchedule, postInstallment } from "@/lib/adjust/schedules";
import { assetRegister } from "@/lib/assets/register";
import { createInvoice } from "@/lib/receivables/invoices";
import { statementSet } from "@/lib/reports/statement-set";

/**
 * Adversarial report and close scenarios (end-to-end test round, cycle 2026-10-20-paritas-inti). Every expected figure is hand-computed in the comments, never re-derived the way the code does.
 * J = Rp 1 juta.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;
const J = 1_000_000n;
const id = async (g: G, code: string) => (await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code } })).id;
const postFor = async (g: G, entityId: string, y: number, m: number, d: number, memo: string, lines: [string, bigint][]) =>
  db.$transaction(async (tx) =>
    postJournal(tx, { entityId, date: dateOnly(y, m, d), kind: "ADJUSTMENT", memo, lines: await Promise.all(lines.map(async ([code, v]) => (v > 0n ? { accountId: await id(g, code), debit: v } : { accountId: await id(g, code), credit: -v }))) }),
  );
const post = (g: G, y: number, m: number, d: number, memo: string, lines: [string, bigint][]) => postFor(g, g.pt.entity.id, y, m, d, memo, lines);
const pt = (g: G) => ({ clientId: g.client.id, entityIds: [g.pt.entity.id] });
const both = (g: G) => ({ clientId: g.client.id, entityIds: [g.pt.entity.id, g.owner.entity.id] });
const items = (xs: { key: string; amount: bigint }[]) => Object.fromEntries(xs.map((i) => [i.key, i.amount]));
const tbNet = (tb: Awaited<ReturnType<typeof trialBalance>>, code: string) => tb.find((r) => r.account.code === code)?.net ?? 0n;
const bsLine = (bs: Awaited<ReturnType<typeof balanceSheet>>, line: string) =>
  [...bs.currentAssets, ...bs.nonCurrentAssets, ...bs.liabilities, ...bs.equity].find((i) => i.fsLine === line)?.amount ?? 0n;

/**
 * Opening 31 Dec 2025 (PT): Kas di bank 1120 500, Aset tetap 1210 200, Akum 1219 (50), Piutang 1130 100 | Utang usaha 2110 80,
 * Modal 3100 400, Saldo laba 3200 270. Assets 750 = 80 + 670.
 */
async function openingBooks(g: G) {
  await postOpening(db, {
    clientId: g.client.id,
    entityId: g.pt.entity.id,
    date: dateOnly(2025, 12, 31),
    lines: [
      { accountCode: "1120", debit: "500000000", credit: "0" },
      { accountCode: "1210", debit: "200000000", credit: "0" },
      { accountCode: "1219", debit: "0", credit: "50000000" },
      { accountCode: "1130", debit: "100000000", credit: "0" },
      { accountCode: "2110", debit: "0", credit: "80000000" },
      { accountCode: "3100", debit: "0", credit: "400000000" },
      { accountCode: "3200", debit: "0", credit: "270000000" },
    ],
  });
}

/** A year of 2026 activity, all typed journals against 1120. See the hand computation in the test. */
async function year2026(g: G) {
  await post(g, 2026, 1, 5, "Setoran modal", [["1120", 100n * J], ["3100", -100n * J]]);
  await post(g, 2026, 1, 10, "Pencairan pinjaman bank", [["1120", 300n * J], ["2210", -300n * J]]);
  await post(g, 2026, 1, 15, "Beli mesin tunai", [["1210", 240n * J], ["1120", -240n * J]]);
  await post(g, 2026, 2, 1, "Sewa dibayar di muka", [["1170", 12n * J], ["1120", -12n * J]]);
  await post(g, 2026, 2, 28, "Amortisasi sewa", [["6120", 2n * J], ["1170", -2n * J]]);
  await post(g, 2026, 2, 20, "Penjualan kredit + PPN", [["1130", 111n * J], ["4100", -100n * J], ["2130", -11n * J]]);
  await post(g, 2026, 3, 3, "Pembelian kredit + PPN masukan", [["5100", 50n * J], ["1150", 5_500_000n], ["2110", -55_500_000n]]);
  await post(g, 2026, 3, 10, "Pelunasan piutang", [["1120", 150n * J], ["1130", -150n * J]]);
  await post(g, 2026, 3, 12, "Bayar utang usaha", [["2110", 100n * J], ["1120", -100n * J]]);
  await post(g, 2026, 4, 30, "Penyusutan", [["6180", 20n * J], ["1219", -20n * J]]);
  await post(g, 2026, 4, 30, "Akrual listrik", [["6130", 7n * J], ["2150", -7n * J]]);
  await post(g, 2026, 5, 10, "Angsuran pinjaman + bunga", [["2210", 50n * J], ["7110", 3n * J], ["1120", -53n * J]]);
  await post(g, 2026, 6, 10, "Prive", [["3300", 25n * J], ["1120", -25n * J]]);
  await post(g, 2026, 6, 20, "Dividen dibayar", [["3200", 40n * J], ["1120", -40n * J]]);
  await post(g, 2026, 7, 1, "Reklas pinjaman jangka panjang", [["2210", 100n * J], ["2300", -100n * J]]);
}

describe("cash flow, equity and Neraca over a calendar year and its boundary", () => {
  beforeEach(resetDb);

  it("full-year 2026 indirect cash flow: every section hand-computed, closing cash = Neraca cash", async () => {
    const g = await makeGroup();
    await openingBooks(g);
    await year2026(g);
    const to = dateOnly(2026, 12, 31);
    const cf = await cashFlow(db, pt(g), to);
    // Profit: +100 sales −2 rent −50 purchases −20 depreciation −7 utilities −3 interest = 18
    expect(cf.netProfit).toBe(18n * J);
    // Operating: 1170 −12+2 = −10; 1130 −111+150 = +39; 2130 +11; 1150 −5.5; 2110 +55.5−100 = −44.5; 1219 +20; 2150 +7 → 18 + 17 = 35
    expect(cf.totals.OPERATING).toBe(35n * J);
    expect(items(cf.operating)).toMatchObject({ BIAYA_DIBAYAR_DIMUKA: -10n * J, PIUTANG_USAHA: 39n * J, AKUM_PENYUSUTAN: 20n * J });
    // Investing: machine −240
    expect(items(cf.investing)).toEqual({ ASET_TETAP: -240n * J });
    // Financing: 2210 +300−50−100 = +150, 2300 +100, capital +100, prive −25, dividend −40 → 285
    expect(items(cf.financing)).toEqual({ UTANG_BANK: 150n * J, UTANG_JANGKA_PANJANG: 100n * J, MODAL: 100n * J, PRIVE: -25n * J, SALDO_LABA: -40n * J });
    expect(cf.totals.FINANCING).toBe(285n * J);
    // 1120: +100+300−240−12+150−100−53−25−40 = +80; 500 → 580
    expect([cf.openingCash, cf.net, cf.closingCash]).toEqual([500n * J, 80n * J, 580n * J]);
    const bs = await balanceSheet(db, pt(g), to);
    expect(bsLine(bs, "KAS_SETARA_KAS")).toBe(580n * J);
    expect(bs.totals.difference).toBe(0n);
  });

  it("YTD cash flow at a month end inside the year (31 Mar 2026)", async () => {
    const g = await makeGroup();
    await openingBooks(g);
    await year2026(g);
    const cf = await cashFlow(db, pt(g), dateOnly(2026, 3, 31));
    // Jan–Mar profit: +100 −2 −50 = 48. Operating: 48 −10 (1170) +39 (1130) +11 (2130) −5.5 (1150) −44.5 (2110) = 38
    expect(cf.netProfit).toBe(48n * J);
    expect(cf.totals).toEqual({ OPERATING: 38n * J, INVESTING: -240n * J, FINANCING: 400n * J });
    // 1120 Jan–Mar: +100+300−240−12+150−100 = 198 → 698
    expect(cf.closingCash).toBe(698n * J);
    expect(bsLine(await balanceSheet(db, pt(g), dateOnly(2026, 3, 31)), "KAS_SETARA_KAS")).toBe(698n * J);
  });

  it("changes in equity 2026 and across the year end into 2027 equal Neraca equity", async () => {
    const g = await makeGroup();
    await openingBooks(g);
    await year2026(g);
    const eq = await equityChanges(db, pt(g), dateOnly(2026, 12, 31));
    // opening 400 + 270 = 670; profit 18; capital +100; prive −25; dividends −40 → 723
    expect(eq.totals).toMatchObject({ opening: 670n * J, profit: 18n * J, capital: 100n * J, prive: -25n * J, retained: -40n * J, closing: 723n * J });
    expect(eq.balanceSheetEquity).toBe(723n * J);

    await post(g, 2027, 1, 15, "Pendapatan jasa tunai", [["1120", 30n * J], ["4110", -30n * J]]);
    await post(g, 2027, 2, 15, "Dividen 2027", [["3200", 10n * J], ["1120", -10n * J]]);
    const eq2 = await equityChanges(db, pt(g), dateOnly(2027, 2, 28));
    // opening = 723 (prior profit 18 folded in Saldo laba: 270 − 40 + 18 = 248), profit 30, dividends −10 → 743
    expect(eq2.totals).toMatchObject({ opening: 723n * J, profit: 30n * J, retained: -10n * J, closing: 743n * J });
    expect(eq2.balanceSheetEquity).toBe(743n * J);
    const tb = await trialBalance(db, pt(g), dateOnly(2027, 1, 31));
    expect(tbNet(tb, "3200")).toBe(-248n * J); // 270 − 40 + 18 folded
    expect(tbNet(tb, "4100")).toBe(0n); // 2026 sales folded
    expect(tbNet(tb, "4110")).toBe(-30n * J);
    const cf2 = await cashFlow(db, pt(g), dateOnly(2027, 2, 28));
    expect([cf2.openingCash, cf2.netProfit, cf2.totals.FINANCING, cf2.closingCash]).toEqual([580n * J, 30n * J, -10n * J, 600n * J]);
  });

  it("non-calendar year (ends 31 March): TB folds Jan–Mar 2026 P&L into 3200 at 30 Apr 2026; P&L and cash flow run from 1 Apr", async () => {
    const g = await makeGroup();
    await db.client.update({ where: { id: g.client.id }, data: { fiscalYearEndMonth: 3 } });
    await openingBooks(g);
    await year2026(g);
    const asOf = dateOnly(2026, 4, 30);
    const tb = await trialBalance(db, pt(g), asOf);
    // FY 2025/26 (Apr 25 – Mar 26) profit = Jan–Mar 2026 = 48 → 3200 = 270 + 48 = 318 cr
    expect(tbNet(tb, "3200")).toBe(-318n * J);
    expect(tbNet(tb, "4100")).toBe(0n);
    expect(tbNet(tb, "6180")).toBe(20n * J); // April depreciation is this year
    const is = await incomeStatement(db, pt(g), dateOnly(2026, 4, 1), asOf);
    expect(is.totals.netProfit).toBe(-27n * J); // −20 depreciation −7 accrual
    const bs = await balanceSheet(db, pt(g), asOf);
    expect(bs.totals.difference).toBe(0n);
    expect(bsLine(bs, "LABA_BERJALAN")).toBe(-27n * J);
    const cf = await cashFlow(db, pt(g), asOf);
    // April: profit −27, +20 depreciation, +7 accrual → operating 0; no cash move; opening cash at 31 Mar = 698
    expect(cf.totals).toEqual({ OPERATING: 0n, INVESTING: 0n, FINANCING: 0n });
    expect([cf.openingCash, cf.closingCash]).toEqual([698n * J, 698n * J]);
    const eq = await equityChanges(db, pt(g), dateOnly(2026, 6, 30));
    // opening at 31 Mar 2026: 400+100 capital, 270+48 → 818; Apr–Jun profit −27 −3 = −30; prive −25; dividend −40 → 723
    expect(eq.totals).toMatchObject({ opening: 818n * J, profit: -30n * J, prive: -25n * J, retained: -40n * J, closing: 723n * J });
    expect(eq.balanceSheetEquity).toBe(723n * J);
  });
});

describe("Neraca Saldo movement and asset movement at the year start", () => {
  beforeEach(resetDb);

  it("January 2027 TB movement: P&L opens at 0, 3200 opens with 2026's profit folded, openings balance", async () => {
    const g = await makeGroup();
    await openingBooks(g);
    await year2026(g);
    await post(g, 2027, 1, 15, "Pendapatan jasa tunai", [["1120", 30n * J], ["4110", -30n * J]]);
    const rows = await trialBalanceMovement(db, pt(g), dateOnly(2027, 1, 1), dateOnly(2027, 1, 31));
    const r = (code: string) => rows.find((x) => x.account.code === code)!;
    expect(r("4100").opening).toBe(0n);
    expect(r("4110")).toMatchObject({ opening: 0n, periodCredit: 30n * J, net: -30n * J });
    expect(r("3200").opening).toBe(-248n * J); // 270 − 40 + 18
    expect(rows.reduce((t, x) => t + x.opening, 0n)).toBe(0n);
    expect(rows.reduce((t, x) => t + x.net, 0n)).toBe(0n);
  });

  it("fixed-asset movement 2026: opening 200/(50), machine +240, depreciation (20) → 440/(70) = Neraca", async () => {
    const g = await makeGroup();
    await openingBooks(g);
    await year2026(g);
    const m = await fixedAssetMovement(db, pt(g), dateOnly(2026, 12, 31));
    expect(m.rows.map((x) => [x.code, x.opening, x.additions, x.deductions, x.closing])).toEqual([
      ["1210", 200n * J, 240n * J, 0n, 440n * J],
      ["1219", -50n * J, -20n * J, 0n, -70n * J],
    ]);
  });
});

describe("multi-entity scope with intercompany 1190", () => {
  beforeEach(resetDb);

  it("PT lends the owner 50 through 1190: each entity's own cash flow classifies it, the group nets it out", async () => {
    const g = await makeGroup();
    await post(g, 2026, 1, 2, "Modal PT", [["1120", 200n * J], ["3100", -200n * J]]);
    await postFor(g, g.owner.entity.id, 2026, 1, 2, "Modal pemilik", [["1110", 10n * J], ["3100", -10n * J]]);
    await post(g, 2026, 2, 1, "Pinjaman ke pemilik", [["1190", 50n * J], ["1120", -50n * J]]);
    await postFor(g, g.owner.entity.id, 2026, 2, 1, "Pinjaman dari PT", [["1110", 50n * J], ["1190", -50n * J]]);
    const to = dateOnly(2026, 12, 31);
    const cfPt = await cashFlow(db, pt(g), to);
    expect(items(cfPt.investing)).toEqual({ INTERCOMPANY_LENT: -50n * J });
    const cfOwner = await cashFlow(db, { clientId: g.client.id, entityIds: [g.owner.entity.id] }, to);
    expect(items(cfOwner.financing)).toMatchObject({ INTERCOMPANY: 50n * J });
    const cfAll = await cashFlow(db, both(g), to);
    expect(cfAll.investing).toEqual([]);
    expect(items(cfAll.financing)).toEqual({ MODAL: 210n * J });
    expect(cfAll.closingCash).toBe(210n * J);
    const bs = await balanceSheet(db, both(g), to);
    expect(bs.totals.assets).toBe(210n * J);
    expect(bs.totals.difference).toBe(0n);
    expect([...bs.currentAssets, ...bs.currentLiabilities].some((i) => i.accounts.some((a) => a.code === "1190"))).toBe(false);
  });
});

describe("intercompany loan given last year, fully repaid this year", () => {
  beforeEach(resetDb);

  it("PT's 2025 loan of 50 to the owner, repaid in 2026, is an investing inflow of 2026 (repayment of a loan given)", async () => {
    const g = await makeGroup();
    await post(g, 2025, 3, 1, "Modal", [["1120", 200n * J], ["3100", -200n * J]]);
    await post(g, 2025, 6, 1, "Pinjaman ke pemilik", [["1190", 50n * J], ["1120", -50n * J]]);
    await post(g, 2026, 4, 1, "Pelunasan pinjaman oleh pemilik", [["1120", 50n * J], ["1190", -50n * J]]);
    const y25 = await cashFlow(db, pt(g), dateOnly(2025, 12, 31));
    expect(items(y25.investing)).toEqual({ INTERCOMPANY_LENT: -50n * J });
    const y26 = await cashFlow(db, pt(g), dateOnly(2026, 12, 31));
    expect(y26.net).toBe(50n * J);
    // Hand: the 50 is the loan given in 2025 coming back → investing +50; nothing was borrowed → financing 0.
    expect({ investing: items(y26.investing), financing: items(y26.financing) }).toEqual({ investing: { INTERCOMPANY_LENT: 50n * J }, financing: {} });
  });
});

describe("disposal proceeds collected in the next financial year", () => {
  beforeEach(resetDb);

  it("a disposal of Jan 2026 collected in Feb 2027 is an investing inflow of 2027 (rule 1: collected proceeds are investing)", async () => {
    const g = await makeGroup();
    await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2025, 12, 31), lines: [
      { accountCode: "1120", debit: "100000000", credit: "0" },
      { accountCode: "1210", debit: "120000000", credit: "0" },
      { accountCode: "1219", debit: "0", credit: "90000000" },
      { accountCode: "3100", debit: "0", credit: "130000000" },
    ] });
    const a = await createAsset(db, { clientId: g.client.id, entityId: g.pt.entity.id, name: "Mesin cetak", taxGroup: "KELOMPOK_2", fiscalMethod: "GARIS_LURUS", acquiredOn: "2024-01-01", cost: "120000000", usefulLifeMonths: 48, openingAccumulated: "90000000", remainingMonths: 12, assetAccountCode: "1210", startYear: 2026, startMonth: 2 });
    await disposeAsset(db, { clientId: g.client.id, assetId: a.id, date: "2026-01-20", proceeds: "40000000", proceedsCode: "1140" });
    await post(g, 2027, 2, 10, "Penerimaan hasil penjualan mesin (tahun berikutnya)", [["1120", 40n * J], ["1140", -40n * J]]);
    const y1 = await cashFlow(db, pt(g), dateOnly(2026, 12, 31));
    expect(y1.net).toBe(0n); // nothing collected in 2026
    const y2 = await cashFlow(db, pt(g), dateOnly(2027, 12, 31));
    expect(y2.net).toBe(40n * J);
    // Hand: the 40 collected is the disposal's proceeds → investing +40, operating 0.
    expect(items(y2.investing)).toEqual({ DISPOSAL: 40n * J });
    expect(y2.totals.OPERATING).toBe(0n);
  });
});

describe("books opened inside the year with a Saldo Awal that carries the year's P&L to date", () => {
  beforeEach(resetDb);

  it("Saldo Awal is a balance-sheet position: income and expense balances are refused, so the statements can't disagree", async () => {
    const g = await makeGroup();
    // Saldo Awal 30 Jun 2026 typed from the client's TB with Jan–Jun results: refused; the H1 profit goes to Saldo Laba instead.
    const typed = [
      { accountCode: "1120", debit: "150000000", credit: "0" },
      { accountCode: "3100", debit: "0", credit: "100000000" },
      { accountCode: "4100", debit: "0", credit: "80000000" },
      { accountCode: "6100", debit: "30000000", credit: "0" },
    ];
    await expect(postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 6, 30), lines: typed })).rejects.toThrow("4100 Penjualan adalah akun laba rugi");
    await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 6, 30), lines: [typed[0], typed[1], { accountCode: "3200", debit: "0", credit: "50000000" }] });
    await post(g, 2026, 7, 15, "Penjualan Juli", [["1120", 10n * J], ["4100", -10n * J]]);
    const set = await statementSet(db, pt(g), 2026, 12);
    const lr = set.statements.find((s) => s.name === "Laba Rugi")!;
    const lrNet = lr.rows.find((r) => r.label.trim() === "Laba bersih")!.values[0];
    const eqRows = set.statements.find((s) => s.name === "Perubahan Ekuitas")!.rows;
    const eqProfit = eqRows.find((r) => /Laba \(rugi\)/.test(r.label))!.values.at(-1);
    const cfNet = set.statements.find((s) => s.name === "Arus Kas")!.rows.find((r) => r.label === "Laba bersih")!.values[0];
    // Hand: the statements are labelled 1 Juli – 31 Desember 2026; profit of that period = 10. All three agree.
    expect(lr.columns[0]).toBe("1 Juli – 31 Desember 2026");
    expect({ lrNet, eqProfit, cfNet }).toEqual({ lrNet: 10n * J, eqProfit: 10n * J, cfNet: 10n * J });
  });
});

describe("disposal proceeds received as an advance before the disposal", () => {
  beforeEach(resetDb);

  it("a buyer's 40 jt deposit (Jan 10) before the disposal (Jan 20), same year, is the disposal's investing inflow", async () => {
    const g = await makeGroup();
    await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2025, 12, 31), lines: [
      { accountCode: "1120", debit: "100000000", credit: "0" },
      { accountCode: "1210", debit: "120000000", credit: "0" },
      { accountCode: "1219", debit: "0", credit: "90000000" },
      { accountCode: "3100", debit: "0", credit: "130000000" },
    ] });
    const a = await createAsset(db, { clientId: g.client.id, entityId: g.pt.entity.id, name: "Mesin cetak", taxGroup: "KELOMPOK_2", fiscalMethod: "GARIS_LURUS", acquiredOn: "2024-01-01", cost: "120000000", usefulLifeMonths: 48, openingAccumulated: "90000000", remainingMonths: 12, assetAccountCode: "1210", startYear: 2026, startMonth: 2 });
    await post(g, 2026, 1, 10, "Uang muka pembeli mesin", [["1120", 40n * J], ["1140", -40n * J]]);
    await disposeAsset(db, { clientId: g.client.id, assetId: a.id, date: "2026-01-20", proceeds: "40000000", proceedsCode: "1140" });
    const cf = await cashFlow(db, pt(g), dateOnly(2026, 12, 31));
    expect(cf.net).toBe(40n * J);
    // Hand: cost 120 − accumulated 90 = book 30; sold 40 → gain 10. All 40 of cash came for the machine → investing +40, operating 0.
    expect(cf.netProfit).toBe(10n * J);
    expect(items(cf.investing)).toEqual({ DISPOSAL: 40n * J });
    expect(cf.totals.OPERATING).toBe(0n);
  });
});

describe("Buku Besar of Saldo Laba (3200) across a year end", () => {
  beforeEach(resetDb);

  it("the account ledger of 3200 opens January with last year's profit folded in, like the TB and the general ledger", async () => {
    const g = await makeGroup();
    await post(g, 2025, 6, 1, "Modal", [["1120", 100n * J], ["3100", -100n * J]]);
    await post(g, 2025, 7, 1, "Penjualan 2025", [["1120", 60n * J], ["4100", -60n * J]]);
    await post(g, 2026, 1, 20, "Dividen", [["3200", 15n * J], ["1120", -15n * J]]);
    const start = dateOnly(2026, 1, 1);
    const end = dateOnly(2026, 1, 31);
    const tb = await trialBalance(db, pt(g), end);
    expect(tbNet(tb, "3200")).toBe(-45n * J); // 60 folded − 15 dividend
    const gl = (await generalLedger(db, pt(g), start, end, { accountCode: "3200" }))[0];
    expect([gl.opening, gl.closing]).toEqual([60n * J, 45n * J]); // credit-normal, positive = credit
    const acc = await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code: "3200" } });
    const al = await accountLedger(db, { accountId: acc.id, entityIds: [g.pt.entity.id], start, end, normalBalance: acc.normalBalance });
    // Hand: opening 60 (2025 profit folded, as the TB row the page drills from), closing 45
    expect(al.opening).toBe(60n * J);
    expect(al.rows.at(-1)!.balance).toBe(String(45n * J));
  });
});

// ─── Close: lock sequencing and writers ─────────────────────────────────────────

async function ready(g: G, year: number, month: number) {
  const period = await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year, month } }, create: { firmId: g.firm.id, clientId: g.client.id, year, month }, update: {} });
  for (const s of CLOSE_SIGNOFFS) await db.closeSignoff.upsert({ where: { periodId_key: { periodId: period.id, key: s.key } }, create: { periodId: period.id, key: s.key }, update: {} });
  for (const c of await runControls(db, g.client.id, year, month)) {
    if (c.status === "REVIEW") await db.controlAck.upsert({ where: { periodId_controlKey: { periodId: period.id, controlKey: c.key } }, create: { periodId: period.id, controlKey: c.key, note: "Wajar untuk uji" }, update: {} });
  }
}
const lockMonth = async (g: G, year: number, month: number) => {
  await ready(g, year, month);
  return lockPeriod(db, g.client.id, year, month, "uji");
};

describe("close — a locked month's figures must not change", () => {
  beforeEach(resetDb);

  it("every writer into a locked month refuses: postJournal, reversal dated there, schedule, invoice", async () => {
    const g = await makeGroup();
    await post(g, 2026, 1, 5, "Modal", [["1120", 100n * J], ["3100", -100n * J]]);
    const adj = await post(g, 2026, 1, 10, "Beban", [["6190", 5n * J], ["1120", -5n * J]]);
    await lockMonth(g, 2026, 1);
    await expect(post(g, 2026, 1, 20, "Masuk bulan terkunci", [["6190", 1n * J], ["1120", -1n * J]])).rejects.toThrow(/ditutup/);
    await expect(reverseEntry(db, { clientId: g.client.id, entryId: adj.id, date: dateOnly(2026, 1, 31) })).rejects.toThrow(/ditutup/);
    await expect(createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "AMORTIZATION", memo: "Sewa", debitCode: "6120", creditCode: "1170", amount: "12.000.000", months: 12, startYear: 2026, startMonth: 1 })).rejects.toThrow(/dikunci/);
    await expect(createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "SALES", contactName: "PT A", number: "INV-1", issueDate: "2026-01-15", dpp: "10.000.000", counterCode: "4100" })).rejects.toThrow();
    // a reversal dated in the next (open) month is fine
    await reverseEntry(db, { clientId: g.client.id, entryId: adj.id, date: dateOnly(2026, 2, 1) });
    expect(tbNet(await trialBalance(db, pt(g), dateOnly(2026, 1, 31)), "1120")).toBe(95n * J);
  });

  it("posting into an EARLIER open (empty) month after a later month is locked changes the locked month's Neraca", async () => {
    const g = await makeGroup();
    await post(g, 2026, 1, 5, "Modal", [["1120", 100n * J], ["3100", -100n * J]]);
    await lockMonth(g, 2026, 1);
    // February is empty, so March can be closed (empty months never block)
    await post(g, 2026, 3, 5, "Penjualan Maret", [["1120", 10n * J], ["4100", -10n * J]]);
    await lockMonth(g, 2026, 3);
    const before = await balanceSheet(db, pt(g), dateOnly(2026, 3, 31));
    expect(before.totals.assets).toBe(110n * J);
    // A journal into open February: the locked March balance sheet must stay 110 — so the post must be refused.
    let refused = false;
    try {
      await post(g, 2026, 2, 10, "Beban Februari (setelah Maret ditutup)", [["6190", 30n * J], ["1120", -30n * J]]);
    } catch {
      refused = true;
    }
    const after = await balanceSheet(db, pt(g), dateOnly(2026, 3, 31));
    expect({ refused, assets: after.totals.assets }).toEqual({ refused: true, assets: 110n * J });
  });

  it("a second entity's Saldo Awal dated before a locked month changes that locked month's group Neraca", async () => {
    const g = await makeGroup();
    await post(g, 2026, 1, 5, "Modal", [["1120", 100n * J], ["3100", -100n * J]]);
    await lockMonth(g, 2026, 1);
    const before = await balanceSheet(db, both(g), dateOnly(2026, 1, 31));
    let refused = false;
    try {
      await postOpening(db, { clientId: g.client.id, entityId: g.owner.entity.id, date: dateOnly(2025, 12, 31), lines: [{ accountCode: "1110", debit: "70000000", credit: "0" }, { accountCode: "3100", debit: "0", credit: "70000000" }] });
    } catch {
      refused = true;
    }
    const after = await balanceSheet(db, both(g), dateOnly(2026, 1, 31));
    expect({ refused, assets: after.totals.assets }).toEqual({ refused: true, assets: before.totals.assets });
  });

  it("an asset whose depreciation month was closed without the installment (control acknowledged) can still be disposed later", async () => {
    const g = await makeGroup();
    await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2025, 12, 31), lines: [
      { accountCode: "1120", debit: "100000000", credit: "0" },
      { accountCode: "1210", debit: "120000000", credit: "0" },
      { accountCode: "1219", debit: "0", credit: "90000000" },
      { accountCode: "3100", debit: "0", credit: "130000000" },
    ] });
    const a = await createAsset(db, { clientId: g.client.id, entityId: g.pt.entity.id, name: "Mesin cetak", taxGroup: "KELOMPOK_2", fiscalMethod: "GARIS_LURUS", acquiredOn: "2024-01-01", cost: "120000000", usefulLifeMonths: 48, openingAccumulated: "90000000", remainingMonths: 12, assetAccountCode: "1210", startYear: 2026, startMonth: 2 });
    await post(g, 2026, 2, 5, "Penjualan Februari", [["1120", 5n * J], ["4100", -5n * J]]);
    await lockMonth(g, 2026, 2); // sched: is REVIEW and acknowledged → February closes without its 2.5 jt installment
    const reg = await assetRegister(db, g.client.id, 2026, 3);
    expect(reg[0].unposted).toBe(1); // only March is still owed (February's is dropped: its month is locked)
    await postInstallment(db, { clientId: g.client.id, scheduleId: a.scheduleId!, k: 2 });
    expect((await assetRegister(db, g.client.id, 2026, 3))[0].unposted).toBe(0);
    // Hand: nothing the register calls owed is unposted, so the disposal must go through (else the asset can never leave the books
    // without reopening February).
    await expect(disposeAsset(db, { clientId: g.client.id, assetId: a.id, date: "2026-03-20", proceeds: "20000000", proceedsCode: "1140" })).resolves.toBeTruthy();
  });

  it("unlock runs in reverse order and relock works", async () => {
    const g = await makeGroup();
    const admin = await db.firmMember.create({ data: { firmId: g.firm.id, userId: crypto.randomUUID(), email: "a@example.test", name: "Admin", role: "ADMIN" } });
    await post(g, 2026, 1, 5, "Modal", [["1120", 100n * J], ["3100", -100n * J]]);
    await post(g, 2026, 2, 5, "Penjualan", [["1120", 10n * J], ["4100", -10n * J]]);
    await lockMonth(g, 2026, 1);
    await lockMonth(g, 2026, 2);
    await expect(unlockPeriod(db, g.client.id, 2026, 1, { id: admin.id, role: "ADMIN" }, "koreksi januari")).rejects.toThrow(/Februari 2026/);
    await unlockPeriod(db, g.client.id, 2026, 2, { id: admin.id, role: "ADMIN" }, "koreksi februari");
    await unlockPeriod(db, g.client.id, 2026, 1, { id: admin.id, role: "ADMIN" }, "koreksi januari");
    await post(g, 2026, 1, 20, "Koreksi", [["6190", 1n * J], ["1120", -1n * J]]);
    await expect(lockMonth(g, 2026, 2)).rejects.toThrow(/Januari 2026/);
    await lockMonth(g, 2026, 1);
    await lockMonth(g, 2026, 2);
    expect(tbNet(await trialBalance(db, pt(g), dateOnly(2026, 2, 28)), "1120")).toBe(109n * J);
  });
});
