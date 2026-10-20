import type { Db } from "@/lib/db";
import { financialYear, fiscalEndMonth, priorYearEnd, samePeriodLastYear } from "@/lib/fiscal";
import { formatDateLong, periodBounds } from "@/lib/format";
import type { Scope } from "@/lib/reports/ledger";

/**
 * The periods a set of statements reports (accounting-rules 1), one rule for the page, the PDF / Excel set and the CALK:
 * - the year to date runs from the books' start when a Saldo Awal opens them inside the financial year (nothing posted before it), else from
 *   the financial year's first day;
 * - a comparative only where the books hold something by then — no column of dashes before the books start: the previous year end, or, when
 *   the books open inside this year, the Saldo Awal position; the same months last year only when they hold entries.
 */
export type ReportPeriods = {
  asOf: Date;
  yearStart: Date;
  lastYearEnd: Date;
  /** The day after a Saldo Awal that opens the books inside this year, else the year's first day. */
  booksStart: Date;
  /** The month is at or before that Saldo Awal: a position, no income yet. */
  beforeBooks: boolean;
  /** The year-to-date start: `booksStart`, or the year's first day before the books start. */
  ytdFrom: Date;
  /** The year's first Saldo Awal (OPENING) date between the previous year end and this month, if any. */
  openingAt: Date | null;
  /** The Neraca's comparative column, or null. */
  balanceComparative: { date: Date; label: string; opening: boolean } | null;
  /** The Laba Rugi's comparative (the same months last year), or null. */
  priorPl: { start: Date; end: Date } | null;
};

export async function reportPeriods(db: Db, scope: Scope, year: number, month: number, endMonth?: number): Promise<ReportPeriods> {
  const end = endMonth ?? (await fiscalEndMonth(db, scope.clientId));
  const asOf = periodBounds(year, month).end;
  const yearStart = financialYear(end, year, month).start;
  const lastYearEnd = priorYearEnd(end, year, month);
  const prior = samePeriodLastYear(end, year, month);
  const entryBy = async (to: Date, from?: Date) => !!(await db.journalLine.findFirst({ where: { entityId: { in: scope.entityIds }, date: { gte: from, lte: to } }, select: { id: true } }));
  const first = await db.journalEntry.findFirst({ where: { entityId: { in: scope.entityIds }, kind: "OPENING", date: { gte: lastYearEnd, lte: asOf } }, orderBy: { date: "asc" }, select: { date: true } });
  const openingAt = first?.date ?? null;
  const opensBooks = openingAt !== null && +openingAt >= +yearStart && !(await entryBy(new Date(+openingAt - 86_400_000)));
  const booksStart = opensBooks ? new Date(+openingAt! + 86_400_000) : yearStart;
  const beforeBooks = +booksStart > +asOf;
  let balanceComparative: ReportPeriods["balanceComparative"] = null;
  if (await entryBy(lastYearEnd)) {
    // A Saldo Awal on that date is the column's source only when it opens the books: a company joining a group kept before it is not.
    const opening = openingAt !== null && +openingAt === +lastYearEnd && !(await entryBy(new Date(+lastYearEnd - 86_400_000)));
    balanceComparative = { date: lastYearEnd, label: `${opening ? "Saldo awal " : ""}${formatDateLong(lastYearEnd)}`, opening };
  }
  else if (openingAt && +openingAt > +lastYearEnd && +openingAt < +asOf) balanceComparative = { date: openingAt, label: `Saldo awal ${formatDateLong(openingAt)}`, opening: true };
  return {
    asOf,
    yearStart,
    lastYearEnd,
    booksStart,
    beforeBooks,
    ytdFrom: beforeBooks ? yearStart : booksStart,
    openingAt,
    balanceComparative,
    priorPl: (await entryBy(prior.end, prior.start)) ? prior : null,
  };
}
