import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { postJournal } from "@/lib/ledger/post";
import { balanceSheet, incomeStatement } from "@/lib/reports/ledger";
import { activeMonths, days, fiscalMonths, monthlyBalance, monthlyIncome, percent, ratios, times } from "@/lib/reports/analysis";
import { dateOnly } from "@/lib/format";
import { upsertRate } from "@/lib/fx/rates";

const J = 1_000_000n;

async function books(endMonth = 12) {
  const g = await makeGroup();
  await db.client.update({ where: { id: g.client.id }, data: { fiscalYearEndMonth: endMonth } });
  const acc = async (code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code } } })).id;
  const post = async (date: Date, lines: [string, bigint, bigint][]) =>
    db.$transaction(async (tx) => postJournal(tx, { entityId: g.pt.entity.id, date, kind: "ADJUSTMENT", memo: "uji", lines: await Promise.all(lines.map(async ([c, d, k]) => ({ accountId: await acc(c), debit: d, credit: k }))) }));
  await post(dateOnly(2026, 1, 2), [["1110", 500n * J, 0n], ["3100", 0n, 500n * J]]);
  await post(dateOnly(2026, 2, 10), [["1130", 100n * J, 0n], ["4100", 0n, 100n * J]]);
  await post(dateOnly(2026, 2, 12), [["5100", 60n * J, 0n], ["2110", 0n, 60n * J]]);
  await post(dateOnly(2026, 3, 15), [["1110", 80n * J, 0n], ["1130", 0n, 80n * J]]);
  await post(dateOnly(2026, 3, 20), [["6100", 15n * J, 0n], ["1110", 0n, 15n * J]]);
  await post(dateOnly(2026, 3, 25), [["1130", 50n * J, 0n], ["4100", 0n, 50n * J]]);
  return { g, scope: { clientId: g.client.id, entityIds: [g.pt.entity.id] } };
}

describe("analysis: month by month", () => {
  beforeEach(resetDb);

  it("each Laba Rugi column is that month's statement and the total is the year to date", async () => {
    const { scope } = await books();
    const pl = await monthlyIncome(db, scope, 2026, 3);
    expect(pl.months.map((m) => m.key)).toEqual(["2026-01", "2026-02", "2026-03"]);
    const net = pl.rows.find((r) => r.key === "net")!;
    expect(net.values).toEqual([0n, 40n * J, 35n * J]);
    const ytd = await incomeStatement(db, scope, dateOnly(2026, 1, 1), dateOnly(2026, 3, 31));
    expect(net.total).toBe(ytd.totals.netProfit);
    // The months translated one by one add up to something else: the case the total column must not use.
    expect(net.values.reduce((t, v) => t + v, 0n)).not.toBe(net.total);
    const sales = pl.rows.find((r) => r.code === "4100")!;
    expect([sales.label, sales.values, sales.total]).toEqual(["Penjualan", [0n, 100n * J, 50n * J], 150n * J]);
    expect(pl.rows.filter((r) => r.kind === "heading").map((r) => r.label)).toEqual(["Pendapatan usaha", "Beban pokok pendapatan", "Beban usaha"]);
  });

  it("each Neraca column is that month end's balance sheet, assets = liabilities + equity", async () => {
    const { scope } = await books();
    const bs = await monthlyBalance(db, scope, 2026, 3);
    const row = (key: string) => bs.rows.find((r) => r.key === key)!.values;
    const march = await balanceSheet(db, scope, dateOnly(2026, 3, 31));
    expect(row("assets")[2]).toBe(march.totals.assets);
    expect(row("assets")).toEqual(row("le"));
    expect(row("assets")).toEqual([500n * J, 600n * J, 635n * J]);
  });

  it("ratios per month, with a dash where the base is zero", async () => {
    const { scope } = await books();
    const pl = await monthlyIncome(db, scope, 2026, 3);
    const bs = await monthlyBalance(db, scope, 2026, 3);
    const r = Object.fromEntries(ratios(pl, bs).map((x) => [x.key, x.values]));
    // Feb: current assets 600 (cash 500 + receivable 100), current liabilities 60.
    expect(r.current).toEqual([null, "10,00x", "10,58x"]);
    expect(r.cash).toEqual([null, "8,33x", "9,42x"]);
    expect(r.wc).toEqual([String(500n * J), String(540n * J), String(575n * J)]);
    expect(r.gpm).toEqual([null, "40,0 %", "100,0 %"]);
    expect(r.npm).toEqual([null, "40,0 %", "70,0 %"]);
    // Receivable 100 against 100 of February sales over 28 days; payable 60 against 60 of cost.
    expect(r.dso).toEqual([null, "28 hari", "43 hari"]);
    expect(r.dpo).toEqual([null, "28 hari", null]);
    expect(r.der).toEqual(["0,00x", "0,11x", "0,10x"]);
  });

  it("starts at the books' first month: no column before the first entry", async () => {
    const g = await makeGroup();
    const scope = { clientId: g.client.id, entityIds: [g.pt.entity.id] };
    expect((await activeMonths(db, scope, 2026, 5)).map((m) => m.key)).toEqual(["2026-05"]);
    const acc = async (code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code } } })).id;
    await db.$transaction(async (tx) => postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, 3, 31), kind: "ADJUSTMENT", memo: "uji", lines: [{ accountId: await acc("1110"), debit: J }, { accountId: await acc("3100"), credit: J }] }));
    expect((await monthlyIncome(db, scope, 2026, 5)).months.map((m) => m.key)).toEqual(["2026-03", "2026-04", "2026-05"]);
  });

  it("a financial year that ends in January starts its months in February", () => {
    expect(fiscalMonths(1, 2026, 4).map((m) => m.key)).toEqual(["2026-02", "2026-03", "2026-04"]);
    expect(fiscalMonths(12, 2026, 1).map((m) => m.label)).toEqual(["Jan 26"]);
  });

  it("formats ratios half up, signed, never through Number", () => {
    expect([times(2n, 3n), times(-5n, 4n), times(1n, 0n)]).toEqual(["0,67x", "−1,25x", null]);
    expect([percent(1n, 3n), percent(-1n, 8n), percent(1n, -1n)]).toEqual(["33,3 %", "−12,5 %", null]);
    expect([days(10n, 31n, 31), days(1n, 0n, 30)]).toEqual(["10 hari", null]);
    expect(times(10n ** 30n, 3n)).toBe(`${(10n ** 30n) / 3n},33x`);
  });
});

describe("analysis: a group in two currencies", () => {
  beforeEach(resetDb);

  it("the total column is the translated year to date, as Laporan Keuangan, not the sum of translated months", async () => {
    const g = await makeGroup();
    const hc = g.owner.entity;
    await db.entity.update({ where: { id: hc.id }, data: { functionalCurrency: "SGD", shortName: "HoldCo" } });
    const acc = async (code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code } } })).id;
    const [bank, modal, beban] = [await acc("1120"), await acc("3100"), await acc("6170")];
    await db.$transaction(async (tx) => {
      await postJournal(tx, { entityId: hc.id, date: dateOnly(2026, 1, 15), kind: "ADJUSTMENT", memo: "modal", lines: [{ accountId: bank, debit: 50_000n }, { accountId: modal, credit: 50_000n }] });
      await postJournal(tx, { entityId: hc.id, date: dateOnly(2026, 2, 10), kind: "ADJUSTMENT", memo: "beban", lines: [{ accountId: beban, debit: 1_000n }, { accountId: bank, credit: 1_000n }] });
      await postJournal(tx, { entityId: hc.id, date: dateOnly(2026, 3, 10), kind: "ADJUSTMENT", memo: "beban", lines: [{ accountId: beban, debit: 1_000n }, { accountId: bank, credit: 1_000n }] });
    });
    for (const [m, spot, avg] of [[1, "12000", "12000"], [2, "12100", "12100"], [3, "12500", "12300"]] as const) {
      const end = new Date(Date.UTC(2026, m, 0));
      await upsertRate(db, g.firm.id, { currency: "SGD", quote: "IDR", date: end, kind: "SPOT", rate: spot });
      await upsertRate(db, g.firm.id, { currency: "SGD", quote: "IDR", date: end, kind: "AVERAGE", rate: avg });
    }
    const scope = { clientId: g.client.id, entityIds: [g.pt.entity.id, hc.id] };
    const pl = await monthlyIncome(db, scope, 2026, 3);
    const net = pl.rows.find((r) => r.key === "net")!;
    const ytd = await incomeStatement(db, scope, dateOnly(2026, 1, 1), dateOnly(2026, 3, 31));
    expect(net.total).toBe(ytd.totals.netProfit);
    // The months translated one by one add up to something else: the case the total column must not use.
    expect(net.values.reduce((t, v) => t + v, 0n)).not.toBe(net.total);
  });
});
