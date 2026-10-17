import type { Db } from "@/lib/db";
import type { IncomeStatement } from "@/lib/reports/ledger";
import { formatPeriod, periodBounds } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { percent, tenthsOf, type MonthCol } from "@/lib/reports/analysis";
import { changePercent, managementSummary, percentOf, type AccountChange, type ManagementSummary } from "@/lib/reports/management";
import { ENTRY_SOURCE_SELECT, lineSource } from "@/lib/reports/entry-source";

/**
 * Wawasan keuangan (cycle 2026-10-17-wawasan-keuangan): what changed this month and which accounts moved it. Every finding is arithmetic
 * on the statements *Laba Rugi per bulan* already shows (`monthlyIncome`) or on the management summary's *Perubahan Akun* comparison and
 * the flux scan (accounting-rules 22b), so each figure equals a cell elsewhere and opens down to its rows. Nothing here is stored and no
 * sentence is a hard-coded direction (ui-rules: true either way).
 */

/** One month's Laba Rugi totals the findings read. Beban pokok positive. */
export type Figures = { revenue: bigint; cogs: bigint; grossProfit: bigint; operatingProfit: bigint; netProfit: bigint };

export function figuresOf(s: IncomeStatement): Figures {
  return { revenue: s.totals.revenue, cogs: s.cogs.reduce((t, i) => t + i.amount, 0n), grossProfit: s.totals.grossProfit, operatingProfit: s.totals.operatingProfit, netProfit: s.totals.netProfit };
}

const abs = (v: bigint) => (v < 0n ? -v : v);
const hasProfitAndLoss = (f: Figures) => f.revenue !== 0n || f.cogs !== 0n || f.grossProfit !== 0n || f.operatingProfit !== 0n || f.netProfit !== 0n;
type Month = Pick<MonthCol, "key" | "label" | "year" | "month">;

export type TrendKey = "revenue" | "grossProfit" | "netProfit";
const TREND: { key: TrendKey; label: string }[] = [
  { key: "revenue", label: "Pendapatan" },
  { key: "grossProfit", label: "Laba kotor" },
  { key: "netProfit", label: "Laba bersih" },
];

export type TrendMetric = {
  key: TrendKey;
  label: string;
  current: bigint;
  /** Last month of the financial year to date; null in its first month. */
  previous: bigint | null;
  change: bigint | null;
  /** The change as a percentage of last month ("12,5 %", unsigned); null when last month was zero or negative. */
  changePercent: string | null;
  /** The average of the year's earlier months (whole units, truncated); null in its first month. */
  average: bigint | null;
  /** Consecutive months moving the same way through this month, shown from 2. */
  run: { up: boolean; months: number } | null;
  high: { key: string; label: string; value: bigint };
  low: { key: string; label: string; value: bigint };
};
export type Trend = { compared: boolean; metrics: TrendMetric[]; sentence: string };

/** How many months in a row a series moved the same way, ending with its last value; null below 2. */
export function runOf(values: bigint[]): { up: boolean; months: number } | null {
  const steps = values.slice(1).map((v, i) => v - values[i]);
  const last = steps.at(-1);
  if (last === undefined || last === 0n) return null;
  let n = 0;
  for (let i = steps.length - 1; i >= 0 && steps[i] !== 0n && steps[i] > 0n === last > 0n; i--) n++;
  return n >= 2 ? { up: last > 0n, months: n } : null;
}

/**
 * Tren: pendapatan, laba kotor and laba bersih of the last month in `months` against the month before, against the average of the year's
 * earlier months, the run and the year's highest and lowest month (the first of equal months). `figures[i]` is `months[i]`'s statement.
 */
export function trend(allMonths: Month[], allFigures: Figures[], currency: string): Trend {
  // Months before the first with any Laba Rugi figure (the books' opening month holds only the Saldo Awal) are not part of the year's
  // trend: counted, they would be its "lowest month" at zero and pull the average down.
  const from = Math.min(Math.max(0, allFigures.findIndex(hasProfitAndLoss)), allMonths.length - 1);
  const months = allMonths.slice(from);
  const figures = allFigures.slice(from);
  const i = months.length - 1;
  const metrics = TREND.map(({ key, label }): TrendMetric => {
    const values = figures.map((f) => f[key]);
    const current = values[i];
    const earlier = values.slice(0, i);
    const previous = i > 0 ? values[i - 1] : null;
    const change = previous === null ? null : current - previous;
    const extreme = (better: (a: bigint, b: bigint) => boolean) => {
      let at = 0;
      values.forEach((v, j) => { if (better(v, values[at])) at = j; });
      return { key: months[at].key, label: months[at].label, value: values[at] };
    };
    return {
      key,
      label,
      current,
      previous,
      change,
      changePercent: change === null || previous === null || previous === 0n ? null : percentOf(abs(change), abs(previous)),
      average: earlier.length ? earlier.reduce((s, v) => s + v, 0n) / BigInt(earlier.length) : null,
      run: runOf(values),
      high: extreme((a, b) => a > b),
      low: extreme((a, b) => a < b),
    };
  });
  return { compared: i > 0, metrics, sentence: trendSentence(months, metrics, currency) };
}

function trendSentence(months: Month[], metrics: TrendMetric[], currency: string): string {
  const now = months.at(-1)!;
  const month = formatPeriod(now.year, now.month);
  if (months.length < 2) return `${month} adalah bulan pertama tahun buku ini yang berisi laba rugi, jadi belum ada bulan pembanding.`;
  const before = months.at(-2)!;
  const last = formatPeriod(before.year, before.month);
  const m = (v: bigint) => formatMoney(abs(v), currency);
  const moved = (x: TrendMetric) =>
    x.change === 0n ? `sama dengan ${last}` : `${x.change! > 0n ? "naik" : "turun"} ${x.changePercent ?? m(x.change!)} dari ${last}`;
  const [rev, , net] = metrics;
  const run = net.run ? ` dan ${net.run.up ? "naik" : "turun"} ${net.run.months} bulan berturut-turut` : "";
  const profit = net.current < 0n ? `rugi bersih ${m(net.current)}` : `laba bersih ${m(net.current)}`;
  return `Pendapatan ${month} ${m(rev.current)}, ${moved(rev)}; ${profit}, ${moved(net)}${run}.`;
}

export type MarginKey = "gpm" | "opm" | "npm";
export type MarginRow = {
  key: MarginKey;
  label: string;
  /** As *Rasio keuangan* shows them ("23,4 %"); null where revenue is zero or negative. */
  current: string | null;
  previous: string | null;
  ytd: string | null;
  /** This month against last month in tenths of a percentage point; null when either is not computed. */
  points: bigint | null;
};
export type Margins = { rows: MarginRow[]; sentence: string };

const MARGINS: { key: MarginKey; label: string; part: (f: Figures) => bigint }[] = [
  { key: "gpm", label: "Margin laba kotor", part: (f) => f.grossProfit },
  { key: "opm", label: "Margin laba usaha", part: (f) => f.operatingProfit },
  { key: "npm", label: "Margin laba bersih", part: (f) => f.netProfit },
];

/** Tenths of a point as words: "4,1 poin" (unsigned). */
export const pointsText = (t: bigint) => `${abs(t) / 10n},${abs(t) % 10n} poin`;

/**
 * Margin: laba kotor, usaha and bersih over pendapatan for this month, last month and the year to date (the formulas of *Rasio keuangan*),
 * and the change in points. When the gross margin moved, the sentence says which side moved it.
 */
export function margins(figures: Figures[], ytd: Figures, months: Month[]): Margins {
  const cur = figures.at(-1)!;
  const prev = figures.length > 1 ? figures.at(-2)! : null;
  const rows = MARGINS.map(({ key, label, part }): MarginRow => {
    const a = tenthsOf(part(cur), cur.revenue);
    const b = prev ? tenthsOf(part(prev), prev.revenue) : null;
    return { key, label, current: percent(part(cur), cur.revenue), previous: prev ? percent(part(prev), prev.revenue) : null, ytd: percent(part(ytd), ytd.revenue), points: a === null || b === null ? null : a - b };
  });
  return { rows, sentence: marginSentence(rows[0], cur, prev, months) };
}

function marginSentence(gross: MarginRow, cur: Figures, prev: Figures | null, months: Month[]): string {
  if (gross.current === null) return `Pendapatan bulan ini ${cur.revenue === 0n ? "nol" : "negatif"}, jadi margin tidak dihitung.`;
  if (!prev) return `Margin laba kotor ${gross.current}; belum ada bulan pembanding di tahun buku ini.`;
  const before = months.at(-2)!;
  if (gross.points === null) return `Margin laba kotor ${gross.current}; ${formatPeriod(before.year, before.month)} tidak ada pendapatan untuk dibandingkan.`;
  if (gross.points === 0n) return `Margin laba kotor tetap ${gross.current}, sama dengan ${formatPeriod(before.year, before.month)}.`;
  const side = (label: string, now: bigint, then: bigint) => {
    const d = now - then;
    if (d === 0n) return `${label} tetap`;
    const pct = then > 0n ? percentOf(abs(d), then) : null;
    return pct ? `${label} ${d > 0n ? "naik" : "turun"} ${pct}` : `${label} ${d > 0n ? "naik" : "turun"} dari nol`;
  };
  return `Margin laba kotor ${gross.points > 0n ? "naik" : "turun"} ${pointsText(gross.points)}: ${side("beban pokok", cur.cogs, prev.cogs)}, ${side("pendapatan", cur.revenue, prev.revenue)}.`;
}

/** Movers shown at most (the pack keeps every account), and journal lines shown under each. */
export const MOVERS_SHOWN = 5;
export const LINES_SHOWN = 3;

export type MoverLine = { id: string; date: Date; memo: string; amount: bigint; source: string | null };
export type InsightMover = AccountChange & {
  /** The change as a percentage of the average, as *Perubahan Akun* shows it. */
  percent: string | null;
  /** The flux scan flags it (the accounts of *Fluktuasi Laba Rugi tidak biasa* on Tutup Buku). */
  flagged: boolean;
  lines: MoverLine[];
};
export type Movers = { movers: InsightMover[]; baseline: string[]; currency: string };

/**
 * Penggerak bulan ini for one company: the accounts of *Perubahan Akun* in its order (largest difference first), without those with no
 * difference, the first five — and any account the flux scan flags beyond them, so every flagged account can be explained. Each carries
 * its three largest lines of the month (by size, OPENING excluded as in the scan) with their source.
 */
export async function topMovers(db: Db, k: { clientId: string; entityId: string; year: number; month: number }, summary?: ManagementSummary): Promise<Movers> {
  const s = summary ?? (await managementSummary(db, k));
  const flagged = new Set(s.movers.map((m) => m.code));
  const shown = s.changes.filter((c) => c.delta !== 0n).filter((c, i) => i < MOVERS_SHOWN || flagged.has(c.code));
  const { start, end } = periodBounds(k.year, k.month);
  const lines = shown.length
    ? await db.journalLine.findMany({
        where: { entityId: k.entityId, accountId: { in: shown.map((c) => c.accountId) }, date: { gte: start, lte: end }, entry: { kind: { not: "OPENING" } } },
        select: { id: true, accountId: true, date: true, debit: true, credit: true, memo: true, sourceRef: true, account: { select: { normalBalance: true } }, entry: { select: { memo: true, ...ENTRY_SOURCE_SELECT } } },
        orderBy: [{ date: "asc" }, { id: "asc" }],
      })
    : [];
  const byAccount = new Map<string, MoverLine[]>();
  for (const l of lines) {
    const amount = l.account.normalBalance === "DEBIT" ? l.debit - l.credit : l.credit - l.debit;
    byAccount.set(l.accountId, [...(byAccount.get(l.accountId) ?? []), { id: l.id, date: l.date, memo: l.memo ?? l.entry.memo, amount, source: lineSource(l) }]);
  }
  const largest = (xs: MoverLine[]) => [...xs].sort((a, b) => (abs(b.amount) > abs(a.amount) ? 1 : abs(b.amount) < abs(a.amount) ? -1 : 0)).slice(0, LINES_SHOWN);
  return {
    movers: shown.map((c) => ({ ...c, percent: changePercent(c), flagged: flagged.has(c.code), lines: largest(byAccount.get(c.accountId) ?? []) })),
    baseline: s.baseline,
    currency: s.currency,
  };
}
