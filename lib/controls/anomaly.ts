import type { Db } from "@/lib/db";
import type { Account } from "@/lib/generated/prisma/client";
import type { EntryKind } from "@/lib/generated/prisma/enums";
import { ACCOUNT_CODES } from "@/lib/coa/template";
import { formatDate, periodBounds } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import type { Control } from "@/lib/controls";

/**
 * Ledger anomaly scans (accounting-rules 22b, ADR 0009): flux against the usual month, P&L movement against its nature,
 * new or reactivated accounts, possible double entries. They read journal lines, so ledger-fed clients get the same
 * scrutiny as bank-fed ones. Deterministic only; REVIEW, never FAIL. OPENING entries never count as movement.
 */

/** Calendar months before the period that form the baseline (only months with entity activity count). */
export const BASELINE_MONTHS = 3;
/** Materiality: this percentage of the baseline's average monthly P&L volume (Σ |movement| over P&L accounts). */
export const MATERIALITY_PERCENT = 1n;
/**
 * Flux: the month differs from the baseline average by at least this percentage of it (and by ≥ materiality). The default of the
 * firm's *Perubahan minimal* (`Firm.fluxPercent`, Pengaturan kantor → Otomasi); the scan reads the firm's value.
 */
export const FLUX_PERCENT = 50n;
/** Possible duplicates: identical entries at most this many days apart. */
export const DUPLICATE_DAYS = 3;

/** Either side is normal for these (rounding, FX gain/loss). */
const EITHER_SIDE = new Set<string>([ACCOUNT_CODES.ROUNDING, ACCOUNT_CODES.FX_GAIN_LOSS]);
const DAY = 86_400_000;

export type FluxFinding = { account: Account; current: bigint; average: bigint; months: number; delta: bigint };
export type AccountFinding = { account: Account; current: bigint };
export type DormantFinding = AccountFinding & { isNew: boolean };
export type DupEntry = { id: string; date: Date; kind: EntryKind; memo: string; sourceRef: string | null; bankTransactionId: string | null; ledgerImportId: string | null; amount: bigint; accountId: string };
export type DupFinding = { first: DupEntry; second: DupEntry; account: Account; amount: bigint };
/**
 * The firm's *Ambang fluktuasi* as one company's scan applies it: the Rupiah floor (*Selisih minimal*) only for a company kept in
 * Rupiah (a Rupiah figure is never compared with another currency's minor units, rule 3), and the percent.
 */
export type FluxThresholds = { floor: bigint | null; percent: number; /** The firm's Rupiah floor, when this company's currency can't use it. */ ignoredFloor: bigint | null };

export async function fluxThresholds(db: Db, clientId: string, entityId: string | null): Promise<FluxThresholds> {
  const [{ firm }, entity] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id: clientId }, select: { firm: { select: { fluxFloor: true, fluxPercent: true } } } }),
    entityId ? db.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } }) : null,
  ]);
  const rupiah = !entity || entity.functionalCurrency === "IDR";
  return { floor: rupiah ? firm.fluxFloor : null, percent: firm.fluxPercent, ignoredFloor: rupiah ? null : firm.fluxFloor };
}

export type LedgerScan = {
  materiality: bigint | null;
  /** The flux thresholds this scan applied (the firm's, Rupiah floor for Rupiah companies only). */
  thresholds: FluxThresholds;
  /** Baseline months with activity, oldest first, as `YYYY-MM`. */
  baseline: string[];
  /** Per account id: natural movement for each baseline month (0 when none), then the current month. */
  series: Map<string, bigint[]>;
  flux: FluxFinding[];
  flip: AccountFinding[];
  dormant: DormantFinding[];
  dup: DupFinding[];
};

const abs = (v: bigint) => (v < 0n ? -v : v);
const isPl = (a: Account) => a.type === "PENDAPATAN" || a.type === "BEBAN";
const natural = (a: Account, debit: bigint, credit: bigint) => (a.normalBalance === "DEBIT" ? debit - credit : credit - debit);
const keyOf = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

function shift(year: number, month: number, by: number) {
  const i = year * 12 + (month - 1) + by;
  return { year: Math.floor(i / 12), month: (i % 12) + 1 };
}

export async function scanLedger(db: Db, clientId: string, entityId: string, year: number, month: number): Promise<LedgerScan> {
  const [accountRows, thresholds] = await Promise.all([db.account.findMany({ where: { clientId } }), fluxThresholds(db, clientId, entityId)]);
  const accounts = new Map(accountRows.map((a) => [a.id, a]));
  const months = Array.from({ length: BASELINE_MONTHS + 1 }, (_, i) => shift(year, month, i - BASELINE_MONTHS));
  // Natural movement per account per month (last element = the period), non-opening lines only.
  const moves = await Promise.all(
    months.map(async ({ year: y, month: m }) => {
      const { start, end } = periodBounds(y, m);
      const rows = await db.journalLine.groupBy({ by: ["accountId"], where: { entityId, date: { gte: start, lte: end }, entry: { kind: { not: "OPENING" } } }, _sum: { debit: true, credit: true } });
      return new Map(
        rows.flatMap((r) => {
          const a = accounts.get(r.accountId);
          const d = r._sum.debit ?? 0n;
          const c = r._sum.credit ?? 0n;
          return a && (d !== 0n || c !== 0n) ? [[r.accountId, natural(a, d, c)] as const] : [];
        }),
      );
    }),
  );
  const current = moves[BASELINE_MONTHS];
  const prior = moves.slice(0, BASELINE_MONTHS);
  const activeIdx = prior.flatMap((m, i) => (m.size > 0 ? [i] : []));
  const baseline = activeIdx.map((i) => keyOf(months[i].year, months[i].month));
  const series = new Map<string, bigint[]>();
  for (const id of new Set([...current.keys(), ...activeIdx.flatMap((i) => [...prior[i].keys()])])) {
    series.set(id, [...activeIdx.map((i) => prior[i].get(id) ?? 0n), current.get(id) ?? 0n]);
  }
  const empty: LedgerScan = { materiality: null, thresholds, baseline, series, flux: [], flip: [], dormant: [], dup: [] };
  if (activeIdx.length === 0 || current.size === 0) return empty;

  const n = BigInt(activeIdx.length);
  const volumeOf = (keep: (a: Account) => boolean) => activeIdx.reduce((s, i) => s + [...prior[i]].reduce((t, [id, v]) => t + (keep(accounts.get(id)!) ? abs(v) : 0n), 0n), 0n);
  // A pre-revenue or holding entity has no P&L baseline: scale by all its movement so dup/dormant still run.
  const volume = volumeOf(isPl) || volumeOf(() => true);
  const materiality = (volume * MATERIALITY_PERCENT) / (100n * n);
  if (materiality <= 0n) return empty;
  const scan: LedgerScan = { ...empty, materiality };

  for (const [id, cur] of current) {
    const a = accounts.get(id)!;
    const exempt = EITHER_SIDE.has(a.code);
    const history = activeIdx.map((i) => prior[i].get(id));
    if (isPl(a) && !exempt) {
      // Flux: only accounts that moved in ≥ 2 baseline months; one moved once (or never) has no average to swing from.
      if (history.filter((v) => v !== undefined).length >= 2) {
        const sum = history.reduce<bigint>((s, v) => s + (v ?? 0n), 0n);
        const diffN = cur * n - sum; // Δ × n, exact
        // |Δ| ≥ max(materiality, the firm's Rupiah floor) and |Δ| ≥ the firm's percent of the average (default 50 %).
        const floor = thresholds.floor !== null && thresholds.floor > materiality ? thresholds.floor : materiality;
        if (abs(diffN) >= floor * n && abs(diffN) * 100n >= abs(sum) * BigInt(thresholds.percent)) {
          scan.flux.push({ account: a, current: cur, average: sum / n, months: activeIdx.length, delta: diffN / n });
        }
      }
      if (cur < 0n && -cur >= materiality) scan.flip.push({ account: a, current: cur });
    }
    const special = a.isBank || a.isSuspense || a.isClearing || a.isIntercompany || exempt;
    if (!special && activeIdx.length === BASELINE_MONTHS && history.every((v) => v === undefined) && abs(cur) >= materiality) {
      scan.dormant.push({ account: a, current: cur, isNew: true });
    }
  }
  if (scan.dormant.length) {
    // "New" = nothing on it before the period at all; an opening balance or older movement makes it a reactivation.
    const { start } = periodBounds(year, month);
    const earlier = new Set(
      (await db.journalLine.groupBy({ by: ["accountId"], where: { entityId, date: { lt: start }, accountId: { in: scan.dormant.map((d) => d.account.id) } }, _count: { _all: true } })).map((r) => r.accountId),
    );
    for (const d of scan.dormant) d.isNew = !earlier.has(d.account.id);
  }

  scan.dup = await duplicates(db, entityId, year, month, materiality, accounts);
  // Largest first, ties by account code: the order feeds the control detail and the AI review's cache key.
  const byDelta = <T extends { delta: bigint; account: Account }>(xs: T[]) => xs.sort((x, y) => (abs(y.delta) > abs(x.delta) ? 1 : abs(y.delta) < abs(x.delta) ? -1 : x.account.code.localeCompare(y.account.code)));
  const byCurrent = <T extends { current: bigint; account: Account }>(xs: T[]) => xs.sort((x, y) => (abs(y.current) > abs(x.current) ? 1 : abs(y.current) < abs(x.current) ? -1 : x.account.code.localeCompare(y.account.code)));
  byDelta(scan.flux);
  byCurrent(scan.flip);
  byCurrent(scan.dormant);
  return scan;
}

/**
 * Identical entries (same account/debit/credit per line) ≤ DUPLICATE_DAYS apart, at least one in the period.
 * Two bank-derived entries never pair (the statement's running balance proves each row); two entries of the same ledger
 * file pair only when their memos match too. OPENING and RECLASS never pair.
 */
async function duplicates(db: Db, entityId: string, year: number, month: number, materiality: bigint, accounts: Map<string, Account>): Promise<DupFinding[]> {
  const { start, end } = periodBounds(year, month);
  const entries = await db.journalEntry.findMany({
    where: { entityId, date: { gte: new Date(+start - DUPLICATE_DAYS * DAY), lte: end }, kind: { notIn: ["OPENING", "RECLASS"] } },
    select: { id: true, date: true, kind: true, memo: true, sourceRef: true, bankTransactionId: true, ledgerImportId: true, lines: { select: { accountId: true, debit: true, credit: true } } },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });
  const groups = new Map<string, DupEntry[]>();
  for (const e of entries) {
    const signature = e.lines.map((l) => `${l.accountId}:${l.debit}:${l.credit}`).sort().join("|");
    const amount = e.lines.reduce((s, l) => s + l.debit, 0n);
    if (amount < materiality) continue;
    const first = e.lines.find((l) => l.debit > 0n) ?? e.lines[0];
    const row: DupEntry = { id: e.id, date: e.date, kind: e.kind, memo: e.memo, sourceRef: e.sourceRef, bankTransactionId: e.bankTransactionId, ledgerImportId: e.ledgerImportId, amount, accountId: first.accountId };
    groups.set(signature, [...(groups.get(signature) ?? []), row]);
  }
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const out: DupFinding[] = [];
  for (const rows of groups.values()) {
    const used = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length && +rows[j].date - +rows[i].date <= DUPLICATE_DAYS * DAY; j++) {
        const [x, y] = [rows[i], rows[j]];
        if (used.has(x.id) || used.has(y.id) || +y.date < +start) continue;
        if (x.bankTransactionId && y.bankTransactionId) continue;
        if (x.ledgerImportId && x.ledgerImportId === y.ledgerImportId && norm(x.memo) !== norm(y.memo)) continue;
        used.add(x.id).add(y.id);
        out.push({ first: x, second: y, account: accounts.get(x.accountId)!, amount: x.amount });
      }
    }
  }
  return out.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : +a.first.date - +b.first.date || a.first.id.localeCompare(b.first.id)));
}

export const sourceLabel = (e: Pick<DupEntry, "kind" | "bankTransactionId" | "sourceRef">) =>
  e.bankTransactionId ? "mutasi bank" : e.kind === "IMPORTED" ? `file ${e.sourceRef ?? ""}`.trim() : e.kind === "ADJUSTMENT" ? "jurnal penyesuaian" : e.kind.toLowerCase();

type Args = {
  clientId: string;
  entity: { id: string; shortName: string; functionalCurrency: string };
  year: number;
  month: number;
  base: string;
  acks: Map<string, string>;
};

const TOP = 5;

export async function anomalyControls(db: Db, a: Args): Promise<Control[]> {
  const e = a.entity;
  const s = await scanLedger(db, a.clientId, e.id, a.year, a.month);
  const fmt = (v: bigint) => formatMoney(v, e.functionalCurrency);
  const pk = keyOf(a.year, a.month);
  const ledger = (code: string) => `${a.base}/ledger/${code}?period=${pk}&entity=${e.id}`;
  const more = (n: number) => (n > TOP ? `; +${n - TOP} lainnya` : "");
  const out: Control[] = [];
  const control = (key: string, title: string, detail: string, code: string) =>
    out.push({ key: `${key}:${e.id}`, title, scope: e.shortName, status: "REVIEW", detail, href: ledger(code), ack: a.acks.get(`${key}:${e.id}`) });

  if (s.flux.length) {
    const list = s.flux.slice(0, TOP).map((f) => {
      const pct = f.average === 0n ? "" : ` (${f.delta > 0n ? "+" : ""}${(f.delta * 100n) / abs(f.average)}%)`;
      return `${f.account.code} ${f.account.name} ${fmt(f.current)} vs rata-rata ${f.months} bln ${fmt(f.average)}${pct}`;
    });
    control("flux", "Fluktuasi Laba Rugi tidak biasa", list.join("; ") + more(s.flux.length), s.flux[0].account.code);
  }
  if (s.flip.length) {
    const list = s.flip.slice(0, TOP).map((f) => `${f.account.code} ${f.account.name} bersaldo ${f.account.normalBalance === "DEBIT" ? "kredit" : "debit"} ${fmt(-f.current)} bulan ini`);
    control("flip", "Akun Laba Rugi berlawanan arah", list.join("; ") + more(s.flip.length), s.flip[0].account.code);
  }
  if (s.dormant.length) {
    const list = s.dormant.slice(0, TOP).map((d) => `${d.account.code} ${d.account.name} ${fmt(d.current)}, ${d.isNew ? "akun baru" : `bergerak lagi setelah ≥ ${BASELINE_MONTHS} bulan diam`}`);
    control("dormant", "Akun baru atau aktif lagi", list.join("; ") + more(s.dormant.length), s.dormant[0].account.code);
  }
  if (s.dup.length) {
    const list = s.dup.slice(0, TOP).map((d) => `${formatDate(d.first.date)} & ${formatDate(d.second.date)} ${fmt(d.amount)} ${d.account.code} (${sourceLabel(d.first)} + ${sourceLabel(d.second)})`);
    control("dup", "Kemungkinan jurnal ganda", `${s.dup.length} pasang: ${list.join("; ")}${more(s.dup.length)}`, s.dup[0].account.code);
  }
  return out;
}
