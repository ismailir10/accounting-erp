import type { Db } from "@/lib/db";
import { formatPeriod, periodBounds } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { fiscalEndMonth, financialYear } from "@/lib/fiscal";
import { incomeStatement, trialBalance } from "@/lib/reports/ledger";
import { scanLedger } from "@/lib/controls/anomaly";

/**
 * Laporan manajemen bulanan (I4b, ADR 0014): this month against last month and the year to date, and the commentary an owner reads —
 * sentences built only from those numbers (no AI, nothing stored). Movers are only the accounts the flux scan flags (accounting-rules
 * 22b), so the commentary never highlights noise.
 */
export type Figures = { revenue: bigint; grossProfit: bigint; netProfit: bigint; cash: bigint };
export type Mover = { code: string; name: string; type: "PENDAPATAN" | "BEBAN"; current: bigint; average: bigint; delta: bigint };
/** `series`: the account's movement in each baseline month, then this month (the scan's series). */
export type AccountChange = { accountId: string; code: string; name: string; current: bigint; average: bigint | null; delta: bigint; series: bigint[] };
export type ManagementSummary = {
  period: { year: number; month: number };
  previous: { year: number; month: number };
  currency: string;
  month: Figures;
  last: Figures;
  ytd: Omit<Figures, "cash">;
  movers: Mover[];
  changes: AccountChange[];
  /** The baseline months the averages are over, oldest first, as `YYYY-MM`. */
  baseline: string[];
};

const abs = (v: bigint) => (v < 0n ? -v : v);

export async function managementSummary(db: Db, input: { clientId: string; entityId: string; year: number; month: number }): Promise<ManagementSummary> {
  const { clientId, entityId, year, month } = input;
  const scope = { clientId, entityIds: [entityId] };
  const prevIndex = year * 12 + month - 2;
  const previous = { year: Math.floor(prevIndex / 12), month: (prevIndex % 12) + 1 };
  const cur = periodBounds(year, month);
  const prev = periodBounds(previous.year, previous.month);
  const fy = financialYear(await fiscalEndMonth(db, clientId), year, month);
  const entity = await db.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
  const cashAt = async (d: Date) =>
    (await trialBalance(db, scope, d)).filter((r) => r.account.fsLine === "KAS_SETARA_KAS" && r.account.type === "ASET").reduce((s, r) => s + r.net, 0n);
  const [plCur, plPrev, plYtd, cashCur, cashPrev, scan] = await Promise.all([
    incomeStatement(db, scope, cur.start, cur.end),
    incomeStatement(db, scope, prev.start, prev.end),
    incomeStatement(db, scope, fy.start, cur.end),
    cashAt(cur.end),
    cashAt(prev.end),
    scanLedger(db, clientId, entityId, year, month),
  ]);
  const fig = (pl: typeof plCur, cash: bigint): Figures => ({ revenue: pl.totals.revenue, grossProfit: pl.totals.grossProfit, netProfit: pl.totals.netProfit, cash });
  const movers = scan.flux
    .filter((f) => f.account.type === "PENDAPATAN" || f.account.type === "BEBAN")
    .map((f) => ({ code: f.account.code, name: f.account.name, type: f.account.type as Mover["type"], current: f.current, average: f.average, delta: f.delta }))
    .sort((a, b) => (abs(b.delta) > abs(a.delta) ? 1 : abs(b.delta) < abs(a.delta) ? -1 : a.code.localeCompare(b.code)));
  // Every P&L account with movement this month or in the baseline: this month against the baseline's average.
  const accounts = new Map((await db.account.findMany({ where: { clientId, type: { in: ["PENDAPATAN", "BEBAN"] } } })).map((a) => [a.id, a]));
  const changes: AccountChange[] = [];
  for (const [id, series] of scan.series) {
    const a = accounts.get(id);
    if (!a) continue;
    const current = series[series.length - 1];
    const base = series.slice(0, -1);
    const average = base.length ? base.reduce((s, v) => s + v, 0n) / BigInt(base.length) : null;
    if (current === 0n && !base.some((v) => v !== 0n)) continue;
    changes.push({ accountId: id, code: a.code, name: a.name, current, average, delta: current - (average ?? 0n), series });
  }
  changes.sort((a, b) => (abs(b.delta) > abs(a.delta) ? 1 : abs(b.delta) < abs(a.delta) ? -1 : a.code.localeCompare(b.code)));
  return {
    period: { year, month },
    previous,
    currency: entity.functionalCurrency,
    month: fig(plCur, cashCur),
    last: fig(plPrev, cashPrev),
    ytd: { revenue: plYtd.totals.revenue, grossProfit: plYtd.totals.grossProfit, netProfit: plYtd.totals.netProfit },
    movers,
    changes,
    baseline: scan.baseline,
  };
}

/** A percentage with one decimal ("12,5 %"), or null when the base is not positive. */
export function percentOf(part: bigint, whole: bigint): string | null {
  if (whole <= 0n) return null;
  const tenths = (part * 1000n) / whole;
  const sign = tenths < 0n ? "−" : "";
  const t = abs(tenths);
  return `${sign}${t / 10n},${t % 10n} %`;
}

/** An account's change against its average as a percentage of that average ("+52,1 %" reads as "52,1 %"); null without a baseline. */
export const changePercent = (c: Pick<AccountChange, "delta" | "average">) => (c.average === null ? null : percentOf(c.delta, abs(c.average)));

/** The commentary: plain sentences from the numbers, true in either direction (ui-rules: never a hard-coded "naik"). */
export function commentary(s: ManagementSummary): string[] {
  const m = (v: bigint) => formatMoney(abs(v), s.currency);
  const month = formatPeriod(s.period.year, s.period.month);
  const last = formatPeriod(s.previous.year, s.previous.month);
  const out: string[] = [];
  const dRev = s.month.revenue - s.last.revenue;
  if (s.month.revenue === 0n && s.last.revenue === 0n) out.push(`Belum ada pendapatan tercatat di ${month} maupun ${last}.`);
  else if (dRev === 0n) out.push(`Pendapatan ${month} ${m(s.month.revenue)}, sama dengan ${last}.`);
  else {
    const pct = percentOf(abs(dRev), s.last.revenue);
    out.push(`Pendapatan ${month} ${m(s.month.revenue)}, ${dRev > 0n ? "naik" : "turun"} ${m(dRev)}${pct ? ` (${pct})` : ""} dari ${last}.`);
  }
  const margin = percentOf(s.month.netProfit, s.month.revenue);
  out.push(
    s.month.netProfit >= 0n
      ? `Laba bersih bulan ini ${m(s.month.netProfit)}${margin ? `, margin bersih ${margin}` : ""}.`
      : `Bulan ini rugi bersih ${m(s.month.netProfit)}.`,
  );
  const dCash = s.month.cash - s.last.cash;
  out.push(dCash === 0n ? `Kas & bank akhir bulan tetap ${m(s.month.cash)}.` : `Kas & bank akhir bulan ${m(s.month.cash)}, ${dCash > 0n ? "bertambah" : "berkurang"} ${m(dCash)} dari akhir ${last}.`);
  for (const v of s.movers.slice(0, 3)) {
    out.push(`${v.code} ${v.name}: ${m(v.current)} bulan ini, ${v.delta > 0n ? "lebih tinggi" : "lebih rendah"} ${m(v.delta)} dari rata-rata bulan sebelumnya (${m(v.average)}).`);
  }
  return out;
}
