import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { postJournal } from "@/lib/ledger/post";
import { balanceSheet, incomeStatement, trialBalance } from "@/lib/reports/ledger";
import { cashFlow, equityChanges } from "@/lib/reports/statements";
import { accountLedger } from "@/lib/reports/account-ledger";
import { sourceTrialBalance } from "@/lib/reports/source";
import { dateOnly } from "@/lib/format";

const J = 1_000_000n;

/** A client closing on 31 January (Chickin): "the year" runs February–January everywhere the ledger counts a year. */
describe("financial year in the ledger", () => {
  beforeEach(resetDb);

  async function books(endMonth: number) {
    const g = await makeGroup();
    await db.client.update({ where: { id: g.client.id }, data: { fiscalYearEndMonth: endMonth } });
    const acc = async (code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code } } })).id;
    await db.$transaction(async (tx) => {
      const post = async (date: Date, lines: [string, bigint, bigint][]) =>
        postJournal(tx, { entityId: g.pt.entity.id, date, kind: "ADJUSTMENT", memo: "uji", lines: await Promise.all(lines.map(async ([c, d, k]) => ({ accountId: await acc(c), debit: d, credit: k }))) });
      await post(dateOnly(2025, 11, 1), [["1110", 500n * J, 0n], ["3100", 0n, 500n * J]]);
      await post(dateOnly(2026, 1, 15), [["1110", 100n * J, 0n], ["4100", 0n, 100n * J]]); // the last month of the year ending 31 Jan 2026
      await post(dateOnly(2026, 3, 15), [["1110", 40n * J, 0n], ["4100", 0n, 40n * J]]);
      await post(dateOnly(2026, 8, 10), [["6190", 10n * J, 0n], ["1110", 0n, 10n * J]]);
    });
    return { g, scope: { clientId: g.client.id, entityIds: [g.pt.entity.id] }, revenue: await acc("4100") };
  }

  it("folds January into Saldo laba; laba berjalan, equity changes, cash flow and the account ledger count from 1 February", async () => {
    const { g, scope, revenue } = await books(1);
    const aug = dateOnly(2026, 8, 31);
    const tb = await trialBalance(db, scope, aug);
    const net = (code: string) => tb.find((r) => r.account.code === code)!.net;
    expect([net("4100"), net("3200")]).toEqual([-40n * J, -100n * J]);
    const bs = await balanceSheet(db, scope, aug);
    expect(bs.equity.find((i) => i.fsLine === "LABA_BERJALAN")!.amount).toBe(30n * J);
    expect(bs.totals.assets).toBe(bs.totals.liabilities + bs.totals.equity);
    expect((await incomeStatement(db, scope, dateOnly(2026, 2, 1), aug)).totals.netProfit).toBe(30n * J);

    const eq = await equityChanges(db, scope, aug);
    expect(eq.openedAt.toISOString().slice(0, 10)).toBe("2026-01-31");
    expect([eq.totals.opening, eq.totals.closing, eq.balanceSheetEquity]).toEqual([600n * J, 630n * J, 630n * J]);
    const cf = await cashFlow(db, scope, aug);
    expect([cf.openingCash, cf.netProfit, cf.closingCash]).toEqual([600n * J, 30n * J, 630n * J]);

    const led = await accountLedger(db, { entityIds: [g.pt.entity.id], start: dateOnly(2026, 8, 1), end: aug, normalBalance: "CREDIT", accountId: revenue });
    expect(led.opening).toBe(40n * J);
    const src = await sourceTrialBalance(db, g.pt.entity.id, aug);
    expect(src.find((r) => r.code === "4100")!.net).toBe(-40n * J);

    // January 2026 itself still belongs to the year that began 1 Feb 2025.
    const jan = await trialBalance(db, scope, dateOnly(2026, 1, 31));
    expect(jan.find((r) => r.account.code === "4100")!.net).toBe(-100n * J);
  });

  it("Saldo laba's account ledger opens with earlier years' profit folded in, equal to the trial balance", async () => {
    const { g, scope } = await books(1);
    const retained = (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code: "3200" } } })).id;
    const led = await accountLedger(db, { entityIds: [g.pt.entity.id], start: dateOnly(2026, 8, 1), end: dateOnly(2026, 8, 31), normalBalance: "CREDIT", accountId: retained });
    expect(led.opening).toBe(100n * J); // the year that ended 31 Jan 2026 earned 100
    expect(led.priorYearProfit).toBe(100n * J);
    const tb = await trialBalance(db, scope, dateOnly(2026, 8, 31));
    expect(-tb.find((r) => r.account.code === "3200")!.net).toBe(led.opening);
    // Inside that year nothing is folded yet.
    const jan = await accountLedger(db, { entityIds: [g.pt.entity.id], start: dateOnly(2026, 1, 1), end: dateOnly(2026, 1, 31), normalBalance: "CREDIT", accountId: retained });
    expect([jan.opening, jan.priorYearProfit]).toEqual([0n, 0n]);
  });

  it("a calendar-year client counts from 1 January, as before", async () => {
    const { scope } = await books(12);
    const tb = await trialBalance(db, scope, dateOnly(2026, 8, 31));
    expect([tb.find((r) => r.account.code === "4100")!.net, tb.find((r) => r.account.code === "3200")!.net]).toEqual([-140n * J, 0n]);
  });
});
