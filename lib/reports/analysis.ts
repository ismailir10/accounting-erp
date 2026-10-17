import type { Db } from "@/lib/db";
import { financialYear, fiscalEndMonth } from "@/lib/fiscal";
import { formatMonthShort, periodBounds } from "@/lib/format";
import { balanceSheet, incomeStatement, type BalanceSheet, type FsItem, type IncomeStatement, type Scope } from "@/lib/reports/ledger";
import { balanceItems, incomeItems, loadReportFormat, renderFormat, type FormatSection } from "@/lib/reports/format";

/**
 * Analisis keuangan: the Laba Rugi and the Neraca month by month through the financial year, and the usual ratios per month. Every figure
 * comes from `incomeStatement` / `balanceSheet` (accounting-rules 1: derived from JournalLine at read time), so a column equals that month's
 * statement and the Laba Rugi's total equals the year to date. Ratios are bigint arithmetic on those figures; none is stored.
 */

export type MonthCol = { year: number; month: number; key: string; label: string; start: Date; end: Date };

/** The months of the financial year holding `month` of `year`, from its first month through that month. */
export function fiscalMonths(endMonth: number, year: number, month: number): MonthCol[] {
  const fy = financialYear(endMonth, year, month);
  const out: MonthCol[] = [];
  for (let d = fy.start; +d <= +periodBounds(year, month).start; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    out.push({ year: y, month: m, key: `${y}-${String(m).padStart(2, "0")}`, label: formatMonthShort(y, m), ...periodBounds(y, m) });
  }
  return out;
}

/**
 * The financial year's months through `month`, from the first month the scope's books hold an entry by (no column of dashes before the
 * books start, as the statements' comparatives). At least the selected month.
 */
export async function activeMonths(db: Db, scope: Scope, year: number, month: number): Promise<MonthCol[]> {
  const months = fiscalMonths(await fiscalEndMonth(db, scope.clientId), year, month);
  const first = await db.journalLine.findFirst({ where: { entityId: { in: scope.entityIds }, date: { lte: months.at(-1)!.end } }, orderBy: { date: "asc" }, select: { date: true } });
  const kept = first ? months.filter((m) => +m.end >= +first.date) : [];
  return kept.length ? kept : months.slice(-1);
}

/** One row of a month-by-month table: an FS line, one of its accounts, or a total. `values` per month; `total` = the year to date (Laba Rugi). */
export type TrendRow = { key: string; label: string; kind: "line" | "account" | "total" | "heading"; code?: string; values: bigint[]; total?: bigint };

/**
 * A statement rendered in the client's own format (lib/reports/format.ts: its labels, order, groups, headings and totals) as rows with one
 * value per column — each *Pos* with its accounts beneath, each total — the same walk as the statement set (`formatRows`), headings kept in
 * the format's own case. Amounts stay in whole units whatever the format's unit, so a column sums exactly.
 */
function trendRows(sections: FormatSection[], prefix: string): TrendRow[] {
  const rows: TrendRow[] = [];
  for (const [si, sec] of sections.entries()) {
    const keys = [...new Set(sec.items.flatMap((col) => col.map((i) => i.fsLine)))];
    if (sec.title && keys.length) rows.push({ key: `${prefix}:h${si}`, label: sec.title, kind: "heading", values: [] });
    for (const k of keys) {
      const cells = sec.items.map((col) => col.find((i) => i.fsLine === k));
      rows.push({ key: `${prefix}:${k}`, label: cells.find(Boolean)!.label, kind: "line", values: cells.map((c) => c?.amount ?? 0n) });
      const codes = [...new Set(cells.flatMap((c) => c?.accounts.map((a) => a.code) ?? []))].sort();
      for (const code of codes) {
        const name = cells.flatMap((c) => c?.accounts ?? []).find((a) => a.code === code)!.name;
        rows.push({ key: `${prefix}:${k}:${code}`, label: name, code, kind: "account", values: cells.map((c) => c?.accounts.find((a) => a.code === code)?.amount ?? 0n) });
      }
    }
    const t = sec.total;
    if (!t || (t.subtotal && !keys.length && t.values.every((v) => v === 0n))) continue;
    rows.push({ key: `${prefix}:${t.key}`, label: t.label, kind: "total", values: t.values });
  }
  return rows;
}

export type MonthlyIncome = { months: MonthCol[]; rows: TrendRow[]; statements: IncomeStatement[] };

/** Laba Rugi per month of the financial year to date (from the books' first month), with a total column = the year-to-date statement. Expenses and costs positive; totals signed. */
export async function monthlyIncome(db: Db, scope: Scope, year: number, month: number): Promise<MonthlyIncome> {
  const months = await activeMonths(db, scope, year, month);
  const [statements, ytd, format] = await Promise.all([
    Promise.all(months.map((m) => incomeStatement(db, scope, m.start, m.end))),
    // The total column is the year-to-date statement itself, not a sum of the months: a mixed-currency group translates each month at
    // that month's average rate but the year to date at the year's, exactly as Laporan Keuangan does.
    incomeStatement(db, scope, months[0].start, months.at(-1)!.end),
    loadReportFormat(db, scope.clientId),
  ]);
  const rows = trendRows(renderFormat(format.labaRugi, [...statements, ytd].map(incomeItems)), "pl").map((r) =>
    r.kind === "heading" ? r : { ...r, values: r.values.slice(0, -1), total: r.values.at(-1)! },
  );
  // The format's last total is net profit (validated on save): the row the page and tests know as "net".
  const net = rows.findLast((r) => r.kind === "total");
  if (net) net.key = "net";
  return { months, rows, statements };
}

export type MonthlyBalance = { months: MonthCol[]; rows: TrendRow[]; sheets: BalanceSheet[] };

/** Neraca at each month end of the financial year to date. */
export async function monthlyBalance(db: Db, scope: Scope, year: number, month: number): Promise<MonthlyBalance> {
  const months = await activeMonths(db, scope, year, month);
  const sheets = await Promise.all(months.map((m) => balanceSheet(db, scope, m.end)));
  const format = await loadReportFormat(db, scope.clientId);
  const rows = trendRows(renderFormat(format.neraca, sheets.map(balanceItems)), "bs");
  // The format holds a total equal to all assets and one equal to liabilities + equity (validated on save): found by their values.
  const same = (r: TrendRow, v: bigint[]) => r.kind === "total" && r.values.every((x, i) => x === v[i]);
  const assets = rows.find((r) => same(r, sheets.map((b) => b.totals.assets)));
  if (assets) assets.key = "assets";
  const le = rows.findLast((r) => r !== assets && same(r, sheets.map((b) => b.totals.liabilities + b.totals.equity)));
  if (le) le.key = "le";
  return { months, rows, sheets };
}

/** A ratio's value per month, already formatted ("1,85x", "23,4 %", "45 hari", or "–" where the base is zero or negative). */
export type RatioRow = { key: string; group: string; label: string; formula: string; values: (string | null)[]; /** Values are Rupiah minor units (as strings), not formatted text. */ amount?: boolean };

const abs = (v: bigint) => (v < 0n ? -v : v);
/** a ÷ b with two decimals ("1,85x"), half up; null when b ≤ 0. */
export function times(a: bigint, b: bigint): string | null {
  if (b <= 0n) return null;
  const h = (abs(a) * 200n + b) / (2n * b);
  return `${a < 0n ? "−" : ""}${h / 100n},${String(h % 100n).padStart(2, "0")}x`;
}
/** a ÷ b as a percentage with one decimal ("23,4 %"), half up; null when b ≤ 0. */
export function percent(a: bigint, b: bigint): string | null {
  if (b <= 0n) return null;
  const t = (abs(a) * 2000n + b) / (2n * b);
  return `${a < 0n ? "−" : ""}${t / 10n},${t % 10n} %`;
}
/** Days of the month a balance covers at the month's rate (balance ÷ flow × days), whole days half up; null when the flow ≤ 0. */
export function days(balance: bigint, flow: bigint, inMonth: number): string | null {
  if (flow <= 0n) return null;
  const d = (abs(balance) * BigInt(inMonth) * 2n + flow) / (2n * flow);
  return `${balance < 0n ? "−" : ""}${d} hari`;
}
const money = (v: bigint) => v.toString();

const fs = (items: FsItem[], line: string) => items.filter((i) => i.fsLine === line).reduce((s, i) => s + i.amount, 0n);

/**
 * The usual ratios at each month end (liquidity, solvency) and for each month's Laba Rugi (margins, days). Working capital is a Rupiah
 * amount (as a string of minor units, `formula` says so); the rest are formatted text.
 */
export function ratios(pl: MonthlyIncome, bs: MonthlyBalance): RatioRow[] {
  const each = <T>(f: (b: BalanceSheet, s: IncomeStatement, m: MonthCol) => T) => bs.sheets.map((b, i) => f(b, pl.statements[i], bs.months[i]));
  const sum = (items: FsItem[]) => items.reduce((s, i) => s + i.amount, 0n);
  const ca = (b: BalanceSheet) => sum(b.currentAssets);
  const cl = (b: BalanceSheet) => sum(b.currentLiabilities);
  const dim = (m: MonthCol) => m.end.getUTCDate();
  return [
    { key: "current", group: "Likuiditas", label: "Rasio lancar", formula: "Aset lancar ÷ liabilitas jangka pendek", values: each((b) => times(ca(b), cl(b))) },
    { key: "quick", group: "Likuiditas", label: "Rasio cepat", formula: "(Aset lancar − persediaan) ÷ liabilitas jangka pendek", values: each((b) => times(ca(b) - fs(b.currentAssets, "PERSEDIAAN"), cl(b))) },
    { key: "cash", group: "Likuiditas", label: "Rasio kas", formula: "Kas dan setara kas ÷ liabilitas jangka pendek", values: each((b) => times(fs(b.currentAssets, "KAS_SETARA_KAS"), cl(b))) },
    { key: "wc", group: "Likuiditas", label: "Modal kerja", formula: "Aset lancar − liabilitas jangka pendek", values: each((b) => money(ca(b) - cl(b))), amount: true },
    { key: "der", group: "Solvabilitas", label: "Utang terhadap ekuitas", formula: "Jumlah liabilitas ÷ jumlah ekuitas", values: each((b) => times(b.totals.liabilities, b.totals.equity)) },
    { key: "dar", group: "Solvabilitas", label: "Utang terhadap aset", formula: "Jumlah liabilitas ÷ jumlah aset", values: each((b) => percent(b.totals.liabilities, b.totals.assets)) },
    { key: "gpm", group: "Profitabilitas (bulan itu)", label: "Margin laba kotor", formula: "Laba kotor ÷ pendapatan usaha", values: each((_, s) => percent(s.totals.grossProfit, s.totals.revenue)) },
    { key: "opm", group: "Profitabilitas (bulan itu)", label: "Margin laba usaha", formula: "Laba usaha ÷ pendapatan usaha", values: each((_, s) => percent(s.totals.operatingProfit, s.totals.revenue)) },
    { key: "npm", group: "Profitabilitas (bulan itu)", label: "Margin laba bersih", formula: "Laba bersih ÷ pendapatan usaha", values: each((_, s) => percent(s.totals.netProfit, s.totals.revenue)) },
    { key: "dso", group: "Aktivitas", label: "Umur piutang", formula: "Piutang usaha ÷ pendapatan usaha bulan itu × hari dalam bulan", values: each((b, s, m) => days(fs(b.currentAssets, "PIUTANG_USAHA"), s.totals.revenue, dim(m))) },
    { key: "dpo", group: "Aktivitas", label: "Umur utang", formula: "Utang usaha ÷ beban pokok pendapatan bulan itu × hari dalam bulan", values: each((b, s, m) => days(fs(b.currentLiabilities, "UTANG_USAHA"), sum(s.cogs), dim(m))) },
  ];
}
