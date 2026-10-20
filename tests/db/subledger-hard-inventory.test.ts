import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { createInvoice } from "@/lib/receivables/invoices";
import { cogsBreakdown, inventoryRows, recordInventoryCount } from "@/lib/inventory";
import { runControls } from "@/lib/controls";
import { balanceSheet, incomeStatement } from "@/lib/reports/ledger";
import { cashFlow } from "@/lib/reports/statements";
import { dateOnly } from "@/lib/format";

/**
 * Hard test: periodic stock count month to month and across a year end (round five). Figures computed by hand beside each assertion.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;

async function gl(g: G, code: string, asOf: Date, from?: Date) {
  const s = await db.journalLine.aggregate({ where: { entityId: g.pt.entity.id, account: { clientId: g.client.id, code }, date: { gte: from, lte: asOf } }, _sum: { debit: true, credit: true } });
  return (s._sum.debit ?? 0n) - (s._sum.credit ?? 0n);
}
const lock = (g: G, year: number, month: number) =>
  db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year, month } }, create: { firmId: g.firm.id, clientId: g.client.id, year, month, status: "LOCKED" }, update: { status: "LOCKED" } });
const buy = (g: G, number: string, date: string, dpp: string, counterCode = "5100") =>
  createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "PURCHASE", contactName: "UD Grosir", number, issueDate: date, dueDate: date, dpp, ppn: String((BigInt(dpp) * 11n) / 100n), counterCode });
const sell = (g: G, number: string, date: string, dpp: string) =>
  createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "SALES", contactName: "Toko Eceran", number, issueDate: date, dueDate: date, dpp, counterCode: "4100" });
const count = (g: G, year: number, month: number, amount: bigint) => recordInventoryCount(db, { clientId: g.client.id, entityId: g.pt.entity.id, year, month, amount });
const scope = (g: G) => ({ clientId: g.client.id, entityIds: [g.pt.entity.id] });
const hpp = async (g: G, from: Date, to: Date) => (await incomeStatement(db, scope(g), from, to)).cogs.find((i) => i.fsLine === "HPP")?.amount;

/**
 * Nov 2025: buy 50.000.000, sell 60.000.000, count 20.000.000 → HPP 30.000.000.
 * Dec 2025: buy 30.000.000, sell 45.000.000, count 15.000.000 → HPP 30 + (20 − 15) = 35.000.000. Year 2025 HPP 65.000.000.
 * Jan 2026: buy 10.000.000, sell 12.000.000, count 18.000.000 → HPP 10 − (18 − 15) = 7.000.000.
 */
async function threeMonths(g: G) {
  await buy(g, "P-11", "2025-11-05", "50000000");
  await sell(g, "S-11", "2025-11-20", "60000000");
  await count(g, 2025, 11, 20_000_000n);
  await buy(g, "P-12", "2025-12-05", "30000000");
  await sell(g, "S-12", "2025-12-20", "45000000");
  await count(g, 2025, 12, 15_000_000n);
  await buy(g, "P-01", "2026-01-05", "10000000");
  await sell(g, "S-01", "2026-01-20", "12000000");
  await count(g, 2026, 1, 18_000_000n);
}

describe("hard test: stock count across a year end", () => {
  beforeEach(resetDb);

  it("HPP per month and per year, Persediaan on the Neraca, CALK breakdown across 31 December", async () => {
    const g = await makeGroup();
    await threeMonths(g);
    expect(await hpp(g, dateOnly(2025, 11, 1), dateOnly(2025, 11, 30))).toBe(30_000_000n);
    expect(await hpp(g, dateOnly(2025, 12, 1), dateOnly(2025, 12, 31))).toBe(35_000_000n);
    expect(await hpp(g, dateOnly(2025, 1, 1), dateOnly(2025, 12, 31))).toBe(65_000_000n);
    expect(await hpp(g, dateOnly(2026, 1, 1), dateOnly(2026, 1, 31))).toBe(7_000_000n);
    expect(await gl(g, "1160", dateOnly(2025, 12, 31))).toBe(15_000_000n);
    expect(await gl(g, "1160", dateOnly(2026, 1, 31))).toBe(18_000_000n);
    // CALK Jan 2026: awal 15.000.000 + pembelian 10.000.000 − akhir 18.000.000 = 7.000.000.
    const c = await cogsBreakdown(db, g.client.id, [g.pt.entity.id], dateOnly(2026, 1, 1), dateOnly(2026, 1, 31));
    expect([c.opening, c.purchases, c.direct, c.closing, c.total]).toEqual([15_000_000n, 10_000_000n, 0n, 18_000_000n, 7_000_000n]);
    // Year 2025: awal 0 + pembelian 80.000.000 − akhir 15.000.000 = 65.000.000.
    const y = await cogsBreakdown(db, g.client.id, [g.pt.entity.id], dateOnly(2025, 1, 1), dateOnly(2025, 12, 31));
    expect([y.opening, y.purchases, y.direct, y.closing, y.total]).toEqual([0n, 80_000_000n, 0n, 15_000_000n, 65_000_000n]);
    // Cash flow January: no cash moved, profit 12 − 7 = 5.000.000; persediaan up 3.000.000 is operating.
    const cf = await cashFlow(db, scope(g), dateOnly(2026, 1, 31));
    expect(cf.netProfit).toBe(5_000_000n);
    expect(cf.operating.find((i) => i.key === "PERSEDIAAN")?.amount).toBe(-3_000_000n);
    expect((await balanceSheet(db, scope(g), dateOnly(2026, 1, 31))).totals.difference).toBe(0n);
    const [row] = await inventoryRows(db, g.client.id, 2026, 1, [g.pt.entity.id]);
    expect([row.book, row.count?.amount, row.previous?.amount, row.purchasesMonth]).toEqual([18_000_000n, 18_000_000n, 15_000_000n, 10_000_000n]);
    const ctl = (await runControls(db, g.client.id, 2026, 1)).find((x) => x.key === `inv:${g.pt.entity.id}`);
    expect(ctl?.status).toBe("PASS");
  });

  it("a count recorded, then a back-dated purchase on cost of sales: count unchanged, HPP up; on Persediaan: control asks for a recount", async () => {
    const g = await makeGroup();
    await threeMonths(g);
    // A January bill found late, dated 25 Jan, on 5100: periodic method — the goods are either in the count or sold: HPP 7 + 4 = 11.000.000.
    await buy(g, "P-01B", "2026-01-25", "4000000");
    expect(await hpp(g, dateOnly(2026, 1, 1), dateOnly(2026, 1, 31))).toBe(11_000_000n);
    let ctl = (await runControls(db, g.client.id, 2026, 1)).find((x) => x.key === `inv:${g.pt.entity.id}`);
    expect(ctl?.status).toBe("PASS");
    // Another, booked to Persediaan directly (1160): book 18 + 2 = 20.000.000 ≠ count → REVIEW; recount 18.000.000 books Dr 5190 2.000.000.
    await buy(g, "P-01C", "2026-01-26", "2000000", "1160");
    ctl = (await runControls(db, g.client.id, 2026, 1)).find((x) => x.key === `inv:${g.pt.entity.id}`);
    expect(ctl?.status).toBe("REVIEW");
    await count(g, 2026, 1, 18_000_000n);
    expect(await gl(g, "1160", dateOnly(2026, 1, 31))).toBe(18_000_000n);
    expect(await hpp(g, dateOnly(2026, 1, 1), dateOnly(2026, 1, 31))).toBe(13_000_000n);
    const c = await cogsBreakdown(db, g.client.id, [g.pt.entity.id], dateOnly(2026, 1, 1), dateOnly(2026, 1, 31));
    // awal 15 + pembelian 14 (5100) + langsung 2 (on 1160, then off it by the recount: movement 0 + 5190 2) − akhir 18 = 13.000.000.
    expect(c.total).toBe(13_000_000n);
    expect(c.opening + c.purchases + c.direct - c.closing).toBe(c.total);
  });

  it("December closed: its count can't change; a January recount and a later month counted refuse an earlier recount", async () => {
    const g = await makeGroup();
    await threeMonths(g);
    await lock(g, 2025, 11);
    await lock(g, 2025, 12);
    await expect(count(g, 2025, 12, 16_000_000n)).rejects.toThrow(/ditutup/);
    await count(g, 2026, 2, 17_000_000n);
    await expect(count(g, 2026, 1, 19_000_000n)).rejects.toThrow(/sudah dicatat/);
    // Feb: no purchases, count 17.000.000 → HPP 1.000.000.
    expect(await hpp(g, dateOnly(2026, 2, 1), dateOnly(2026, 2, 28))).toBe(1_000_000n);
    expect(await hpp(g, dateOnly(2026, 1, 1), dateOnly(2026, 2, 28))).toBe(8_000_000n);
  });
});
