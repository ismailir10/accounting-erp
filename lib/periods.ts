import { prisma } from "@/lib/db";

/**
 * Months that actually have data, newest first: bank lines, or journal entries from ledger imports and adjustments.
 * Drives the period picker + default period. Opening-only months are left out (an empty, confusing option) — unless the
 * client has nothing else: a Neraca-only client (opening entries, nothing booked since) would otherwise open on today's
 * empty month, so its opening months stand in for its data.
 */
export async function dataMonths(clientIds: string[]): Promise<{ year: number; month: number }[]> {
  if (clientIds.length === 0) return [];
  const activity = await activityMonths(clientIds);
  return activity.length > 0 ? activity : openingMonths(clientIds);
}

async function openingMonths(clientIds: string[]) {
  const rows = await prisma.$queryRaw<{ y: number; m: number }[]>`
    SELECT DISTINCT EXTRACT(YEAR FROM j.date)::int AS y, EXTRACT(MONTH FROM j.date)::int AS m
    FROM "JournalEntry" j JOIN "Entity" e ON e.id = j."entityId"
    WHERE e."clientId" = ANY(${clientIds})
    ORDER BY 1 DESC, 2 DESC`;
  return rows.map((r) => ({ year: r.y, month: r.m }));
}

async function activityMonths(clientIds: string[]): Promise<{ year: number; month: number }[]> {
  const rows = await prisma.$queryRaw<{ y: number; m: number }[]>`
    SELECT DISTINCT y, m FROM (
      SELECT EXTRACT(YEAR FROM t.date)::int AS y, EXTRACT(MONTH FROM t.date)::int AS m
      FROM "BankTransaction" t JOIN "Entity" e ON e.id = t."entityId"
      WHERE e."clientId" = ANY(${clientIds})
      UNION
      SELECT EXTRACT(YEAR FROM j.date)::int AS y, EXTRACT(MONTH FROM j.date)::int AS m
      FROM "JournalEntry" j JOIN "Entity" e ON e.id = j."entityId"
      WHERE e."clientId" = ANY(${clientIds}) AND j.kind IN ('IMPORTED', 'ADJUSTMENT')
    ) months
    ORDER BY 1 DESC, 2 DESC`;
  return rows.map((r) => ({ year: r.y, month: r.m }));
}

/**
 * The month an accountant is working on: the latest month with data up to this month (falls back to today). A month still ahead
 * (a scheduled reversal, next year's instalment) holds entries but is not where the work is. `months` newest first, as `dataMonths`
 * returns them.
 */
export function pickWorkingMonth(months: { year: number; month: number }[], now = new Date()) {
  const current = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  const due = months.find((m) => m.year < current.year || (m.year === current.year && m.month <= current.month));
  return due ?? months.at(-1) ?? current;
}
