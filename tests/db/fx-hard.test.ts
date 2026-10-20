import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { db, makeGroup, resetDb } from "../helpers";
import { postJournal, type PostLine } from "@/lib/ledger/post";
import { upsertRate } from "@/lib/fx/rates";
import { postRevaluation, revaluationProposals } from "@/lib/fx/revalue";
import { balanceSheet, incomeStatement, trialBalance } from "@/lib/reports/ledger";
import { FxMissingError } from "@/lib/reports/fx";
import { cashFlow } from "@/lib/reports/statements";
import { postOpening } from "@/lib/opening";
import { CLOSE_SIGNOFFS, lockPeriod, runControls } from "@/lib/controls";
import { stageImport } from "@/lib/ledger-import/post";
import { dateOnly } from "@/lib/format";

/**
 * Foreign currency, tested hard (cycle 2026-10-21-uji-keras-grup, area 2). Every case is built through the real writers
 * (postJournal, postRevaluation, postOpening, lockPeriod, stageImport) and every expected figure is computed by hand in the comment
 * beside it, never read back from the code under test. Eight of these found defects, fixed in the same cycle.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;

const acc = async (g: G, code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code } } })).id;

/** GL net (debit − credit) of an account for one entity through a date. */
async function gl(g: G, entityId: string, code: string, asOf: Date) {
  const s = await db.journalLine.aggregate({ where: { entityId, account: { clientId: g.client.id, code }, date: { lte: asOf } }, _sum: { debit: true, credit: true } });
  return (s._sum.debit ?? 0n) - (s._sum.credit ?? 0n);
}

type L = [code: string, debit: bigint, credit: bigint, fx?: { currency: string; amount: bigint; rate: string }];
async function post(g: G, entityId: string, date: Date, memo: string, lines: L[]) {
  const built: PostLine[] = [];
  for (const [code, debit, credit, fx] of lines) built.push({ accountId: await acc(g, code), debit, credit, fx: fx ?? null });
  return db.$transaction((tx) => postJournal(tx, { entityId, date, kind: "IMPORTED", memo, lines: built }));
}

const usd = (cents: bigint, rate: string) => ({ currency: "USD", amount: cents, rate });
const spot = (g: G, currency: string, quote: string, date: Date, rate: string) => upsertRate(db, g.firm.id, { currency, quote, date, kind: "SPOT", rate });

describe("FX probes: a Rupiah company with dollar balances", () => {
  beforeEach(resetDb);

  it("settlement at a different rate: unrealised (Jan) + realised (Feb) = the whole gain, nothing left to revalue", async () => {
    const g = await makeGroup();
    const e = g.pt.entity.id;
    // 5 Jan: export USD 1.000,00 at 15.000 → Dr 1130 15.000.000 / Cr 4100 15.000.000.
    await post(g, e, dateOnly(2026, 1, 5), "Ekspor", [["1130", 15_000_000n, 0n, usd(100_000n, "15000")], ["4100", 0n, 15_000_000n, usd(100_000n, "15000")]]);
    // 31 Jan closing 15.500: 1130 → 15.500.000, +500.000 unrealised gain.
    await spot(g, "USD", "IDR", dateOnly(2026, 1, 31), "15500");
    const [jan] = await revaluationProposals(db, g.client.id, 2026, 1);
    expect(jan.lines.map((l) => [l.code, l.fxBalance, l.carried, l.target, l.diff])).toEqual([["1130", 100_000n, 15_000_000n, 15_500_000n, 500_000n]]);
    await postRevaluation(db, g.client.id, e, 2026, 1);
    // 10 Feb collected USD 1.000 at 15.800: Dr 1120 15.800.000; Cr 1130 at its carrying rate 15.500 = 15.500.000; Cr 7200 300.000 realised.
    await post(g, e, dateOnly(2026, 2, 10), "Terima USD", [
      ["1120", 15_800_000n, 0n, usd(100_000n, "15800")],
      ["1130", 0n, 15_500_000n, usd(100_000n, "15500")],
      ["7200", 0n, 300_000n],
    ]);
    await spot(g, "USD", "IDR", dateOnly(2026, 2, 28), "15800");
    // Feb: 1130 USD 0 / carried 0; 1120 USD 1.000 carried 15.800.000 = 1.000 × 15.800 → nothing to revalue.
    const [feb] = await revaluationProposals(db, g.client.id, 2026, 2);
    expect(feb.lines).toEqual([]);
    // Total FX gain = (15.800 − 15.000) × 1.000 = 800.000 (credit on 7200).
    expect(await gl(g, e, "7200", dateOnly(2026, 2, 28))).toBe(-800_000n);
    const is = await incomeStatement(db, { clientId: g.client.id, entityIds: [e] }, dateOnly(2026, 1, 1), dateOnly(2026, 2, 28));
    expect(is.totals.netProfit).toBe(15_800_000n); // sales 15.000.000 + FX gain 800.000
  });

  it("settlement crediting the receivable at its historical rate: next month's revaluation takes the unrealised part back", async () => {
    const g = await makeGroup();
    const e = g.pt.entity.id;
    await post(g, e, dateOnly(2026, 1, 5), "Ekspor", [["1130", 15_000_000n, 0n, usd(100_000n, "15000")], ["4100", 0n, 15_000_000n, usd(100_000n, "15000")]]);
    await spot(g, "USD", "IDR", dateOnly(2026, 1, 31), "15500");
    await postRevaluation(db, g.client.id, e, 2026, 1); // +500.000
    // Collected at 15.800 but the receivable credited at the invoice rate 15.000: realised 800.000 booked in full.
    await post(g, e, dateOnly(2026, 2, 10), "Terima USD", [
      ["1120", 15_800_000n, 0n, usd(100_000n, "15800")],
      ["1130", 0n, 15_000_000n, usd(100_000n, "15000")],
      ["7200", 0n, 800_000n],
    ]);
    await spot(g, "USD", "IDR", dateOnly(2026, 2, 28), "15800");
    // 1130: USD 0, carried 15.000.000 + 500.000 − 15.000.000 = 500.000 → target 0, diff −500.000 (the January gain reversed).
    const [feb] = await revaluationProposals(db, g.client.id, 2026, 2);
    expect(feb.lines.map((l) => [l.code, l.fxBalance, l.carried, l.diff])).toEqual([["1130", 0n, 500_000n, -500_000n]]);
    await postRevaluation(db, g.client.id, e, 2026, 2);
    expect(await gl(g, e, "1130", dateOnly(2026, 2, 28))).toBe(0n);
    expect(await gl(g, e, "7200", dateOnly(2026, 2, 28))).toBe(-800_000n); // −500.000 − 800.000 + 500.000
  });

  it("revaluation across a year end: December's gain sits in Saldo Laba, January revalues only the change", async () => {
    const g = await makeGroup();
    const e = g.pt.entity.id;
    const scope = { clientId: g.client.id, entityIds: [e] };
    // 10 Dec 2025: USD 1.000 deposited as capital at 15.000.
    await post(g, e, dateOnly(2025, 12, 10), "Setoran modal USD", [["1120", 15_000_000n, 0n, usd(100_000n, "15000")], ["3100", 0n, 15_000_000n]]);
    await spot(g, "USD", "IDR", dateOnly(2025, 12, 31), "15400"); // → 15.400.000, +400.000
    await postRevaluation(db, g.client.id, e, 2025, 12);
    await spot(g, "USD", "IDR", dateOnly(2026, 1, 31), "15100"); // → 15.100.000, −300.000
    const [jan] = await revaluationProposals(db, g.client.id, 2026, 1);
    expect(jan.lines.map((l) => [l.code, l.carried, l.target, l.diff])).toEqual([["1120", 15_400_000n, 15_100_000n, -300_000n]]);
    await postRevaluation(db, g.client.id, e, 2026, 1);
    const net = async (d: Date) => Object.fromEntries((await trialBalance(db, scope, d)).filter((r) => r.net).map((r) => [r.account.code, r.net]));
    expect(await net(dateOnly(2025, 12, 31))).toEqual({ "1120": 15_400_000n, "3100": -15_000_000n, "7200": -400_000n });
    // 2026: 7200 restarts (loss 300.000), the 2025 gain folded into 3200.
    expect(await net(dateOnly(2026, 1, 31))).toEqual({ "1120": 15_100_000n, "3100": -15_000_000n, "3200": -400_000n, "7200": 300_000n });
  });

  it("revaluation of a locked month is refused; the next month's revaluation catches up the whole difference", async () => {
    const g = await makeGroup();
    const e = g.pt.entity.id;
    await post(g, e, dateOnly(2026, 1, 10), "Setoran modal USD", [["1120", 15_000_000n, 0n, usd(100_000n, "15000")], ["3100", 0n, 15_000_000n]]);
    await spot(g, "USD", "IDR", dateOnly(2026, 1, 31), "15500");
    // Close January without posting the revaluation (its REVIEW acknowledged with a note).
    const period = await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 1 } }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 1 }, update: {} });
    for (const s of CLOSE_SIGNOFFS) await db.closeSignoff.upsert({ where: { periodId_key: { periodId: period.id, key: s.key } }, create: { periodId: period.id, key: s.key }, update: {} });
    for (const c of await runControls(db, g.client.id, 2026, 1)) {
      if (c.status === "REVIEW") await db.controlAck.create({ data: { periodId: period.id, controlKey: c.key, note: "Uji" } });
    }
    await lockPeriod(db, g.client.id, 2026, 1, "uji");
    await expect(postRevaluation(db, g.client.id, e, 2026, 1)).rejects.toThrow();
    expect(await db.journalEntry.count({ where: { entityId: e, kind: "ADJUSTMENT" } })).toBe(0);
    // February closing 15.600: carried 15.000.000 → 15.600.000, +600.000 posted on 28 Feb.
    await spot(g, "USD", "IDR", dateOnly(2026, 2, 28), "15600");
    const [feb] = await revaluationProposals(db, g.client.id, 2026, 2);
    expect(feb.lines.map((l) => [l.code, l.diff])).toEqual([["1120", 600_000n]]);
    await postRevaluation(db, g.client.id, e, 2026, 2);
    expect(await gl(g, e, "1120", dateOnly(2026, 2, 28))).toBe(15_600_000n);
  });

  it("±1 minor unit tolerance on a converted line, and the revaluation sweeps the rounding", async () => {
    const g = await makeGroup();
    const e = g.pt.entity.id;
    // USD 0,01 × 15.050 = 150,5 → 151 (half away from zero). 150, 151 and 152 pass (±1); 149 and 153 do not.
    for (const v of [150n, 151n, 152n]) await post(g, e, dateOnly(2026, 1, 10), `sen ${v}`, [["1120", v, 0n, usd(1n, "15050")], ["3100", 0n, v]]);
    for (const v of [149n, 153n]) await expect(post(g, e, dateOnly(2026, 1, 10), `sen ${v}`, [["1120", v, 0n, usd(1n, "15050")], ["3100", 0n, v]])).rejects.toThrow(/tidak sama dengan/);
    // USD 0,03 at 15.050 = 451,5 → 452; carried 150 + 151 + 152 = 453 → −1.
    await spot(g, "USD", "IDR", dateOnly(2026, 1, 31), "15050");
    const [p] = await revaluationProposals(db, g.client.id, 2026, 1);
    expect(p.lines.map((l) => [l.code, l.fxBalance, l.carried, l.target, l.diff])).toEqual([["1120", 3n, 453n, 452n, -1n]]);
  });

  it("JPY (no decimals): revaluation of a yen receivable at a two-decimal rate", async () => {
    const g = await makeGroup();
    const e = g.pt.entity.id;
    // ¥1.000.000 × 105,25 = 105.250.000.
    await post(g, e, dateOnly(2026, 1, 5), "Ekspor JPY", [["1130", 105_250_000n, 0n, { currency: "JPY", amount: 1_000_000n, rate: "105.25" }], ["4100", 0n, 105_250_000n]]);
    // Closing 104,7 → 104.700.000: −550.000.
    await spot(g, "JPY", "IDR", dateOnly(2026, 1, 31), "104.7");
    const [p] = await revaluationProposals(db, g.client.id, 2026, 1);
    expect(p.lines.map((l) => [l.code, l.fxBalance, l.target, l.diff])).toEqual([["1130", 1_000_000n, 104_700_000n, -550_000n]]);
  });

  it("a dollar payable (credit balance) and two currencies on one account revalue per currency with symmetric rounding", async () => {
    const g = await makeGroup();
    const e = g.pt.entity.id;
    // Payable USD 333,33 × 15.123,45 = 5.041.099,5885 → 5.041.100.
    await post(g, e, dateOnly(2026, 1, 5), "Jasa USD", [["6170", 5_041_100n, 0n], ["2110", 0n, 5_041_100n, usd(33_333n, "15123.45")]]);
    // 1120 holds USD 100 at 15.000 (1.500.000) and SGD 100 at 11.000 (1.100.000).
    await post(g, e, dateOnly(2026, 1, 6), "Setoran", [
      ["1120", 1_500_000n, 0n, usd(10_000n, "15000")],
      ["1120", 1_100_000n, 0n, { currency: "SGD", amount: 10_000n, rate: "11000" }],
      ["3100", 0n, 2_600_000n],
    ]);
    await spot(g, "USD", "IDR", dateOnly(2026, 1, 31), "15000");
    await spot(g, "SGD", "IDR", dateOnly(2026, 1, 31), "11500");
    // 2110: USD −333,33 × 15.000 = −4.999.950; carried −5.041.100 → +41.150 (gain). 1120 USD: 1.500.000 → nil. 1120 SGD: 1.150.000, +50.000.
    const [p] = await revaluationProposals(db, g.client.id, 2026, 1);
    expect(p.lines.map((l) => [l.code, l.currency, l.fxBalance, l.target, l.diff]).sort()).toEqual([
      ["1120", "SGD", 10_000n, 1_150_000n, 50_000n],
      ["2110", "USD", -33_333n, -4_999_950n, 41_150n],
    ]);
    await postRevaluation(db, g.client.id, e, 2026, 1);
    expect(await gl(g, e, "7200", dateOnly(2026, 1, 31))).toBe(-91_150n);
    expect(await gl(g, e, "2110", dateOnly(2026, 1, 31))).toBe(-4_999_950n);
  });

  it("a company kept in USD: Saldo Awal typed in dollars and cents, Neraca in cents", async () => {
    const g = await makeGroup();
    const e = g.owner.entity.id;
    await db.entity.update({ where: { id: e }, data: { functionalCurrency: "USD" } });
    // "1.250,50" = USD 1.250,50 = 125.050 cents.
    await postOpening(db, { clientId: g.client.id, entityId: e, date: dateOnly(2025, 12, 31), lines: [{ accountCode: "1120", debit: "1.250,50", credit: "" }, { accountCode: "3100", debit: "", credit: "1.250,50" }] });
    const bs = await balanceSheet(db, { clientId: g.client.id, entityIds: [e] }, dateOnly(2025, 12, 31));
    expect(bs.totals).toMatchObject({ assets: 125_050n, equity: 125_050n, difference: 0n });
  });

  it("the indirect cash flow keeps an unrealised FX gain on a dollar bank account out of operating: it is the effect of rates on cash", async () => {
    const g = await makeGroup();
    const e = g.pt.entity.id;
    // 10 Jan: USD 10.000 capital into the USD account at 15.000 = 150.000.000. 31 Jan closing 15.500: +5.000.000 to 7200 (non-cash).
    await post(g, e, dateOnly(2026, 1, 10), "Setoran modal USD", [["1120", 150_000_000n, 0n, usd(1_000_000n, "15000")], ["3100", 0n, 150_000_000n]]);
    await spot(g, "USD", "IDR", dateOnly(2026, 1, 31), "15500");
    await postRevaluation(db, g.client.id, e, 2026, 1);
    const cf = await cashFlow(db, { clientId: g.client.id, entityIds: [e] }, dateOnly(2026, 1, 31));
    expect(cf.closingCash - cf.openingCash).toBe(155_000_000n);
    // PSAK 207: an unrealised exchange gain is not a cash flow. Operating = 5.000.000 profit − 5.000.000 non-cash gain = 0; financing
    // 150.000.000; the remaining 5.000.000 is "pengaruh perubahan kurs terhadap kas", outside the three sections.
    expect(cf.totals.FINANCING).toBe(150_000_000n);
    expect(cf.totals.OPERATING).toBe(0n);
    expect(cf.fxEffect).toBe(5_000_000n);
    expect(cf.openingCash + cf.net + cf.fxEffect).toBe(cf.closingCash);
  });

  it("the indirect cash flow does not show a USD bank loan's revaluation as loan cash received", async () => {
    const g = await makeGroup();
    const e = g.pt.entity.id;
    // 10 Jan: USD 10.000 bank loan drawn into the USD account at 15.000. 31 Jan closing 15.500: cash +5.000.000, loan −5.000.000, 7200 nil.
    await post(g, e, dateOnly(2026, 1, 10), "Pinjaman USD", [["1120", 150_000_000n, 0n, usd(1_000_000n, "15000")], ["2210", 0n, 150_000_000n, usd(1_000_000n, "15000")]]);
    await spot(g, "USD", "IDR", dateOnly(2026, 1, 31), "15500");
    await postRevaluation(db, g.client.id, e, 2026, 1);
    const cf = await cashFlow(db, { clientId: g.client.id, entityIds: [e] }, dateOnly(2026, 1, 31));
    // The loan brought 150.000.000 of cash; its 5.000.000 revaluation is non-cash (and offsets the cash account's FX effect).
    expect(cf.financing.map((i) => [i.key, i.amount])).toEqual([["UTANG_BANK", 150_000_000n]]);
  });

  it("a USD time deposit on 1260 (where Buku files deposits) is monetary and revalued", async () => {
    const g = await makeGroup();
    const e = g.pt.entity.id;
    // 5 Jan: USD 10.000 time deposit (deposito berjangka, > 3 months) at 15.000 = 150.000.000 on 1260.
    await post(g, e, dateOnly(2026, 1, 5), "Deposito USD", [["1260", 150_000_000n, 0n, usd(1_000_000n, "15000")], ["3100", 0n, 150_000_000n]]);
    await spot(g, "USD", "IDR", dateOnly(2026, 1, 31), "15500");
    // A deposit is a right to a fixed number of dollars (PSAK 221 monetary item): 10.000 × 15.500 = 155.000.000, +5.000.000.
    const lines = (await revaluationProposals(db, g.client.id, 2026, 1)).flatMap((p) => p.lines);
    expect(lines.map((l) => [l.code, l.target, l.diff])).toEqual([["1260", 155_000_000n, 5_000_000n]]);
  });

  it("an inverted rate keeps enough digits that a large Rupiah balance in a USD company revalues to the cent", async () => {
    const g = await makeGroup();
    const e = g.owner.entity.id;
    await db.entity.update({ where: { id: e }, data: { functionalCurrency: "USD" } });
    // 10 Jan: Rp 10.000.000.000 at 0,0000625 USD/IDR (= 1/16.000) = USD 625.000,00 = 62.500.000 cents.
    await post(g, e, dateOnly(2026, 1, 10), "Rekening IDR", [["1120", 62_500_000n, 0n, { currency: "IDR", amount: 10_000_000_000n, rate: "0.0000625" }], ["3100", 0n, 62_500_000n]]);
    // The Kurs table holds the usual quote, USD→IDR 15.873, for 31 Jan.
    await spot(g, "USD", "IDR", dateOnly(2026, 1, 31), "15873");
    // Exact: 10.000.000.000 / 15.873 = USD 630.000,630000… → 63.000.063 cents; difference +500.063.
    // (1/15.873 rounded to 10 decimals = 0,0000630001 gives USD 630.001,00 → 37 cents too many.)
    const [p] = await revaluationProposals(db, g.client.id, 2026, 1);
    expect(p.lines.map((l) => [l.code, l.target, l.diff])).toEqual([["1120", 63_000_063n, 500_063n]]);
  });

  it("the revaluation journal's line memo reads in dollars, not minor units", async () => {
    const g = await makeGroup();
    const e = g.pt.entity.id;
    await post(g, e, dateOnly(2026, 1, 5), "Ekspor", [["1130", 15_000_000n, 0n, usd(100_000n, "15000")], ["4100", 0n, 15_000_000n]]);
    await spot(g, "USD", "IDR", dateOnly(2026, 1, 31), "15500");
    await postRevaluation(db, g.client.id, e, 2026, 1);
    const line = await db.journalLine.findFirstOrThrow({ where: { entityId: e, entry: { kind: "ADJUSTMENT" }, account: { code: "1130" } } });
    // The balance is USD 1.000,00 (100.000 cents); the Buku Besar drawer shows this memo, so it must read as dollars, not "USD 100000".
    expect(line.memo).not.toMatch(/USD 100000\b/);
    expect(line.memo).toContain("1.000,00");
  });

  it("a dollar balance entered as Saldo Awal with its USD amount is revalued whole", async () => {
    const g = await makeGroup();
    const e = g.pt.entity.id;
    // Opening 31 Dec 2025: USD 10.000 on the USD account, Rp 150.000.000 (15.000) — the line gives its dollar amount too.
    await postOpening(db, { clientId: g.client.id, entityId: e, date: dateOnly(2025, 12, 31), lines: [{ accountCode: "1120", debit: "150.000.000", credit: "", currency: "USD", fxAmount: "10.000,00" }, { accountCode: "3100", debit: "", credit: "150.000.000" }] });
    // 10 Jan: + USD 1.000 at 15.200 = 15.200.000.
    await post(g, e, dateOnly(2026, 1, 10), "Terima USD", [["1120", 15_200_000n, 0n, usd(100_000n, "15200")], ["4100", 0n, 15_200_000n]]);
    await spot(g, "USD", "IDR", dateOnly(2026, 1, 31), "15500");
    // USD 11.000 × 15.500 = 170.500.000; carried 165.200.000 → +5.300.000 (without the dollar amount Buku saw only USD 1.000: +300.000).
    const [p] = await revaluationProposals(db, g.client.id, 2026, 1);
    expect(p.lines.map((l) => [l.code, l.target, l.diff])).toEqual([["1120", 170_500_000n, 5_300_000n]]);
  });
});

describe("FX probes: translation into the Rupiah Gabungan", () => {
  beforeEach(resetDb);

  it("with a financial year ending in March, a missing average rate is asked for, never replaced by the closing rate", async () => {
    const g = await makeGroup();
    await db.client.update({ where: { id: g.client.id }, data: { fiscalYearEndMonth: 3 } });
    const hc = g.owner.entity.id;
    await db.entity.update({ where: { id: hc }, data: { functionalCurrency: "SGD", shortName: "HoldCo" } });
    // FY 2025/26 = 1 Apr 2025 – 31 Mar 2026. PT: Kas 1.000.000 / Modal. HoldCo: Bank S$500 / Modal (15 Apr), expense S$12 (30 Jun).
    await post(g, g.pt.entity.id, dateOnly(2025, 4, 15), "modal", [["1110", 1_000_000n, 0n], ["3100", 0n, 1_000_000n]]);
    await post(g, hc, dateOnly(2025, 4, 15), "modal", [["1120", 50_000n, 0n], ["3100", 0n, 50_000n]]);
    await post(g, hc, dateOnly(2025, 6, 30), "beban", [["6170", 1_200n, 0n], ["1120", 0n, 1_200n]]);
    // Historical (Apr 2025) 12.000 and closing (Feb 2026) 12.500 only: no average rate for FY 2025/26 anywhere.
    await spot(g, "SGD", "IDR", dateOnly(2025, 4, 30), "12000");
    await spot(g, "SGD", "IDR", dateOnly(2026, 2, 28), "12500");
    const all = { clientId: g.client.id, entityIds: [g.pt.entity.id, hc] };
    // The year-to-date Laba Rugi (Apr 2025 – Feb 2026) holds the S$12 expense: rule 11 translates it at the year's average, and a missing
    // rate must show "belum dijabarkan", never a number at a substituted rate. Buku reads "this year" as 1 Jan – 28 Feb 2026 (no P&L there),
    // so it uses the closing rate: 6170 = 12 × 12.500 = 150.000.
    await expect(trialBalance(db, all, dateOnly(2026, 2, 28))).rejects.toThrow(FxMissingError);
    await expect(incomeStatement(db, all, dateOnly(2025, 4, 1), dateOnly(2026, 2, 28))).rejects.toThrow(FxMissingError);
  });
});

describe("FX probes: ledger import conversion", () => {
  beforeEach(resetDb);

  async function xlsx(rows: unknown[][]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("GL");
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const H = ["Entity", "Entry Date", "Account Code", "Account Name", "Currency", "Debit", "Credit", "Notes"];
  const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

  it("CONVERT mode refuses a Kurs rate older than the row's month and the month before", async () => {
    const g = await makeGroup();
    // The only USD rate on file is three years old.
    await spot(g, "USD", "IDR", dateOnly(2023, 1, 31), "14000");
    const file = await xlsx([
      H,
      ["PT Uji", d(2026, 3, 10), "11201", "Bank USD", "USD", 100, 0, ""],
      ["PT Uji", d(2026, 3, 10), "40000", "Sales Export", "USD", 0, 100, ""],
    ]);
    const staged = await stageImport(db, { firmId: g.firm.id, clientId: g.client.id, fileName: "gl.xlsx", data: file, currencyMode: "CONVERT" });
    if (staged.status !== "STAGED") throw new Error("not staged");
    // A rate older than the row's month and the month before is never used: the rate is missing (it was posted at 14.000 silently).
    expect(staged.checks.filter((c) => c.code === "MISSING_RATE").map((c) => c.message)).toEqual([
      "Kurs USD tanggal 10 Mar 2026 belum ada (Buku memakai kurs bulan itu atau bulan sebelumnya, tidak yang lebih lama). Isi di halaman Kurs atau di kolom kurs file.",
    ]);
  });
});
