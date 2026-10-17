import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { postJournal } from "@/lib/ledger/post";
import { budgetGrid, budgetVsActual, favourable, saveBudget, yearMonths } from "@/lib/budget";
import { clientUsage } from "@/lib/clients/entities";
import { deleteClient } from "@/lib/clients/delete";
import { removeAccount } from "@/lib/coa/manage";
import { dateOnly } from "@/lib/format";

const J = 1_000_000n;

async function books() {
  const g = await makeGroup();
  const acc = async (code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code } } })).id;
  const post = async (date: Date, lines: [string, bigint, bigint][]) =>
    db.$transaction(async (tx) => postJournal(tx, { entityId: g.pt.entity.id, date, kind: "ADJUSTMENT", memo: "uji", lines: await Promise.all(lines.map(async ([c, d, k]) => ({ accountId: await acc(c), debit: d, credit: k }))) }));
  await post(dateOnly(2025, 3, 10), [["1110", 80n * J, 0n], ["4100", 0n, 80n * J]]); // last year's March sales
  await post(dateOnly(2026, 2, 10), [["1110", 90n * J, 0n], ["4100", 0n, 90n * J]]);
  await post(dateOnly(2026, 3, 10), [["1110", 120n * J, 0n], ["4100", 0n, 120n * J]]);
  await post(dateOnly(2026, 3, 20), [["6100", 30n * J, 0n], ["1110", 0n, 30n * J]]);
  return { g, scope: { clientId: g.client.id, entityIds: [g.pt.entity.id] } };
}
const save = (g: Awaited<ReturnType<typeof makeGroup>>, cells: { accountCode: string; key: string; amount: string }[]) =>
  saveBudget(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 3, cells });

describe("Anggaran", () => {
  beforeEach(resetDb);

  it("saves typed cells, clears an emptied one, and records one Riwayat event", async () => {
    const { g } = await books();
    expect(await save(g, [{ accountCode: "4100", key: "2026-02", amount: "100.000.000" }, { accountCode: "4100", key: "2026-03", amount: "100.000.000" }, { accountCode: "6100", key: "2026-03", amount: "25.000.000" }])).toEqual({ set: 3, removed: 0 });
    expect(await save(g, [{ accountCode: "6100", key: "2026-03", amount: "" }, { accountCode: "6100", key: "2026-03", amount: "" }])).toEqual({ set: 0, removed: 1 });
    expect(await db.budget.count()).toBe(2);
    const events = await db.auditEvent.findMany({ where: { kind: "BUDGET" }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.summary)).toEqual([
      "Anggaran PT Uji Sejahtera tahun buku mulai Jan 26: 3 sel diisi (3 sel beranggaran)",
      "Anggaran PT Uji Sejahtera tahun buku mulai Jan 26: 0 sel diisi, 1 dikosongkan (2 sel beranggaran)",
    ]);
  });

  it("refuses a balance-sheet account, a month outside the financial year, an unreadable amount, another client's company", async () => {
    const { g } = await books();
    await expect(save(g, [{ accountCode: "1110", key: "2026-03", amount: "1" }])).rejects.toThrow("bukan akun pendapatan atau beban");
    await expect(save(g, [{ accountCode: "4100", key: "2027-01", amount: "1" }])).rejects.toThrow("bulan-bulan tahun buku");
    await expect(save(g, [{ accountCode: "4100", key: "2026-03", amount: "1,5" }])).rejects.toThrow("4100 Mar 26");
    const other = await makeGroup();
    await expect(saveBudget(db, { clientId: g.client.id, entityId: other.pt.entity.id, year: 2026, month: 3, cells: [] })).rejects.toThrow("Pilih perusahaan.");
  });

  it("compares the month and the year to date with the ledger, per account, by type and net", async () => {
    const { g, scope } = await books();
    await save(g, [{ accountCode: "4100", key: "2026-02", amount: "100.000.000" }, { accountCode: "4100", key: "2026-03", amount: "100.000.000" }, { accountCode: "6100", key: "2026-03", amount: "25.000.000" }]);
    const r = await budgetVsActual(db, scope, 2026, 3);
    const row = (label: string) => r.rows.find((x) => x.label === label || x.code === label)!;
    expect([row("4100").month, row("4100").ytd]).toEqual([[100n * J, 120n * J], [200n * J, 210n * J]]);
    expect([row("6100").month, row("6100").ytd]).toEqual([[25n * J, 30n * J], [25n * J, 30n * J]]);
    expect(row("Laba (rugi) bersih").ytd).toEqual([175n * J, 180n * J]);
    expect([favourable(row("4100"), 100n, 120n), favourable(row("6100"), 25n, 30n), favourable(row("Laba (rugi) bersih"), 175n, 180n)]).toEqual([true, false, true]);
    expect(r.hasBudget).toBe(true);
  });

  it("keeps an account whose months net to zero, with the month's activity", async () => {
    const { g, scope } = await books();
    const acc = async (code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code } } })).id;
    const post = async (date: Date, lines: [string, bigint, bigint][]) =>
      db.$transaction(async (tx) => postJournal(tx, { entityId: g.pt.entity.id, date, kind: "ADJUSTMENT", memo: "akrual", lines: await Promise.all(lines.map(async ([c, d, k]) => ({ accountId: await acc(c), debit: d, credit: k }))) }));
    await post(dateOnly(2026, 2, 28), [["6170", 5n * J, 0n], ["2150", 0n, 5n * J]]);
    await post(dateOnly(2026, 3, 1), [["2150", 5n * J, 0n], ["6170", 0n, 5n * J]]);
    const r = await budgetVsActual(db, scope, 2026, 3);
    const row = r.rows.find((x) => x.code === "6170");
    expect([row?.month, row?.ytd]).toEqual([[0n, -5n * J], [0n, 0n]]);
  });

  it("the editor grid lists accounts with a budget or actuals this year or last, with last year's months to copy", async () => {
    const { g } = await books();
    const grid = await budgetGrid(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 3 });
    expect(grid.months.map((m) => m.key)).toEqual(yearMonths(12, 2026, 3).map((m) => m.key));
    expect(grid.rows.map((r) => r.code)).toEqual(["4100", "6100"]);
    const sales = grid.rows[0];
    expect([sales.actual[1], sales.actual[2], sales.lastYear[2], sales.budget[2]]).toEqual([90n * J, 120n * J, 80n * J, null]);
  });

  it("a company or account with a budget can't be removed; deleting the client removes its budgets", async () => {
    const { g } = await books();
    await save(g, [{ accountCode: "4100", key: "2026-03", amount: "1" }, { accountCode: "6170", key: "2026-03", amount: "1" }]);
    const fees = await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code: "6170" } } });
    await expect(removeAccount(db, { clientId: g.client.id, accountId: fees.id })).rejects.toThrow("Akun 6170 Beban Jasa Profesional masih dipakai: 1 sel anggaran.");
    expect((await clientUsage(db, g.client.id)).entities.get(g.pt.entity.id)).toContainEqual({ label: "anggaran", n: 2 });
    await deleteClient(db, { firmId: g.firm.id, clientId: g.client.id, confirmName: "Grup Uji" });
    expect(await db.budget.count()).toBe(0);
  });
});
