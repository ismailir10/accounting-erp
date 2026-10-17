import type { Db, Tx } from "@/lib/db";
import { ACCOUNT_CODES } from "@/lib/coa/template";
import { isGenericKey } from "@/lib/import/normalize";
import { scanLedger } from "@/lib/controls/anomaly";
import { openingDate, statementCoverage } from "@/lib/controls/coverage";
import { installments, owed } from "@/lib/adjust/schedules";
import { todayWib } from "@/lib/checklist/rules";
import { dateOnly, formatDate, formatMonthYear, monthName, periodBounds } from "@/lib/format";
import { formatMoney, parseMoney } from "@/lib/money";
import { LedgerError } from "@/lib/ledger/post";
import { postPreparedAdjustment, type PreparedAdjustment } from "@/lib/ledger/adjustment";
import type { ProposalLine } from "@/lib/adjust/proposals";

/**
 * Usulan akrual (cycle 2026-10-18-usulan-akrual, accounting-rules 5a / 20b): an expense that recurs every month from the same
 * counterparty and is missing from an ended, complete month is proposed as an accrual (Dr the expense / Cr 2150, reversed on the 1st
 * of the next month). Deterministic, no AI: which counterparty, whether it is missing and how much are arithmetic on cited journal
 * lines. Computed at read time; stored only when decided (a `ProposedEntry`, source ACCRUAL), so an undecided proposal vanishes on
 * its own when the payment arrives.
 *
 * The unit is a bucket (company, expense account, counterparty):
 * - a bank payee: the `merchantKey` of the bank line behind a BANK or RECLASS entry, never a generic key (rule 14);
 * - a supplier: the `Contact` of a purchase invoice (its INVOICE entry, not voided);
 * - none, for ledger-fed books: an imported ledger file's lines (IMPORTED) form one bucket per account.
 * Other entries (adjustments, schedules, reversals, Saldo Awal) are the accountant's own or a register's: never spend.
 */

export const ACCRUAL_PREFIX = "ACCRUAL:";
/** The months read before the month (M−4 … M−1). */
export const HISTORY_MONTHS = 4;
/** Months of the history that must carry movement. */
export const MIN_MONTHS = 3;
/** Every month within 1/BAND of the median (25 %): 4 × |amount − median| ≤ median, exact. */
export const BAND = 4n;
export const ACCRUED_EXPENSES = "2150";
/** The expense lines an accrual is proposed on: HPP (goods not delivered) and tax expense (not yet computed) are no accrual. */
const ACCRUAL_LINES = ["BEBAN_UMUM_ADM", "BEBAN_PENJUALAN", "BEBAN_LAIN"];
const NEVER: string[] = [ACCOUNT_CODES.ROUNDING, ACCOUNT_CODES.FX_GAIN_LOSS, ACCOUNT_CODES.DISPOSAL_GAIN_LOSS];

export const NO_CREDIT = `Pilih akun kredit (liabilitas): bagan akun klien tidak punya ${ACCRUED_EXPENSES}.`;
export const NO_AI = "Tanpa AI: tidak ada yang dikirim ke model.";

// ---- the rule (pure) ----

export type RuleMiss = "few" | "refund" | "band" | "material";
export type RuleResult = { ok: true; median: bigint; index: number } | { ok: false; why: RuleMiss; median: bigint | null; index: number | null };

const abs = (v: bigint) => (v < 0n ? -v : v);

/**
 * The median of the months with movement (0 = none), oldest first: with three months the middle one; with four, of the two middle
 * amounts the one from the later month (equal amounts sort by month). The proposed amount is therefore always an amount one month
 * carried; `index` is the latest month that carried it (its rows are the proof). Null below `MIN_MONTHS` months.
 */
export function medianOf(amounts: bigint[]): { median: bigint; index: number } | null {
  const moved = amounts.flatMap((a, i) => (a !== 0n ? [{ a, i }] : []));
  if (moved.length < MIN_MONTHS) return null;
  const sorted = [...moved].sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.i - y.i));
  const n = sorted.length;
  const pick = n % 2 ? sorted[(n - 1) / 2] : [sorted[n / 2 - 1], sorted[n / 2]].reduce((x, y) => (y.i > x.i ? y : x));
  return { median: pick.a, index: Math.max(...moved.filter((x) => x.a === pick.a).map((x) => x.i)) };
}

/**
 * The decision on four monthly amounts (oldest first, natural movement in minor units) and the materiality floor:
 * ≥ 3 months with movement, none negative (a refund month disqualifies), every one within 25 % of the median, the median ≥ floor.
 */
export function accrualRule(amounts: bigint[], floor: bigint): RuleResult {
  const m = medianOf(amounts);
  if (!m) return { ok: false, why: "few", median: null, index: null };
  if (amounts.some((a) => a < 0n)) return { ok: false, why: "refund", median: null, index: null };
  if (amounts.some((a) => a !== 0n && BAND * abs(a - m.median) > m.median)) return { ok: false, why: "band", ...m };
  if (m.median < floor) return { ok: false, why: "material", ...m };
  return { ok: true, ...m };
}

export type BucketKind = "bank" | "contact" | "ledger";
export type YearMonth = { year: number; month: number };

/** The facts a rationale is written from (all computed): the months that carried movement, the month missing, the evidence. */
export type RationaleFacts = {
  kind: BucketKind;
  counterparty: string;
  account: { code: string; name: string };
  currency: string;
  /** The months with movement, oldest first. */
  months: (YearMonth & { amount: bigint })[];
  year: number;
  month: number;
  /** Bank accounts whose statements cover the month (a bank payee). */
  banks: string[];
  median: bigint;
  medianMonth: YearMonth;
};

const listText = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} dan ${xs.at(-1)}`);

/** "Apr, Mei, Jun dan Jul 2026"; across a year end every month keeps its year ("Des 2025 dan Jan 2026"). */
export function monthsText(months: YearMonth[]): string {
  const oneYear = months.every((m) => m.year === months[0].year);
  const names = months.map((m) => (oneYear ? formatMonthYear(m.year, m.month).split(" ")[0] : formatMonthYear(m.year, m.month)));
  return oneYear ? `${listText(names)} ${months[0].year}` : listText(names);
}

/** One paragraph in Bahasa, built only from computed facts. */
export function accrualRationale(f: RationaleFacts): string {
  const fmt = (v: bigint) => formatMoney(v, f.currency);
  const amounts = f.months.map((m) => m.amount);
  const lo = amounts.reduce((a, b) => (b < a ? b : a));
  const hi = amounts.reduce((a, b) => (b > a ? b : a));
  const range = lo === hi ? `${fmt(lo)} tiap bulan` : `${fmt(lo)} – ${fmt(hi)}`;
  const account = `${f.account.code} ${f.account.name}`;
  const when = `${monthsText(f.months)} (${range})`;
  const missing = monthName(f.month);
  const until = formatDate(periodBounds(f.year, f.month).end);
  const story =
    f.kind === "bank"
      ? `${f.counterparty} dibayar ke ${account} pada ${when}. ${missing} belum ada sampai ${until}, dan rekening koran ${listText(f.banks)} sudah lengkap sampai tanggal itu.`
      : f.kind === "contact"
        ? `Tagihan ${f.counterparty} dicatat ke ${account} pada ${when}. ${missing} belum ada tagihan atau pembayarannya sampai ${until}.`
        : `${account} tercatat di buku besar yang diimpor pada ${when}. ${missing} belum ada sampai ${until}, dan buku besar ${missing} sudah diimpor.`;
  return `${story} Usulan: ${fmt(f.median)}, nilai tengah riwayat (${formatMonthYear(f.medianMonth.year, f.medianMonth.month)}).`;
}

// ---- keys ----

export type Bucket = { kind: "bank"; merchantKey: string } | { kind: "contact"; contactId: string } | { kind: "ledger" };

const bucketId = (b: Bucket) => (b.kind === "bank" ? `bank:${b.merchantKey}` : b.kind === "contact" ? `contact:${b.contactId}` : "ledger");
const ym = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

/** `ACCRUAL:<entityId>:<YYYY-MM>:<code>:<bucket>`: one proposal per company, month, account and counterparty (the stored key). */
export const accrualKey = (entityId: string, year: number, month: number, code: string, b: Bucket) => `${ACCRUAL_PREFIX}${entityId}:${ym(year, month)}:${code}:${bucketId(b)}`;

export function parseAccrualKey(key: string): { entityId: string; year: number; month: number; code: string; bucket: Bucket } | null {
  const m = /^ACCRUAL:([^:]+):(\d{4})-(\d{2}):([^:]+):(bank:(.+)|contact:([^:]+)|ledger)$/s.exec(key);
  if (!m) return null;
  const bucket: Bucket = m[6] !== undefined ? { kind: "bank", merchantKey: m[6] } : m[7] !== undefined ? { kind: "contact", contactId: m[7] } : { kind: "ledger" };
  const month = Number(m[3]);
  if (month < 1 || month > 12) return null;
  return { entityId: m[1], year: Number(m[2]), month, code: m[4], bucket };
}

function shift(year: number, month: number, by: number): YearMonth {
  const i = year * 12 + (month - 1) + by;
  return { year: Math.floor(i / 12), month: (i % 12) + 1 };
}

// ---- the read model ----

export type HistoryLine = { id: string; ref: string; date: Date; text: string; source: string; amount: bigint };
export type HistoryMonth = YearMonth & { amount: bigint; lines: HistoryLine[] };

export type AccrualProposal = {
  /** The stored key, also the card's id. */
  key: string;
  entity: { id: string; shortName: string; functionalCurrency: string };
  year: number;
  month: number;
  bucket: Bucket;
  counterparty: string;
  account: { id: string; code: string; name: string };
  /** 2150 when the chart has it; null → the accountant picks a liability. */
  credit: { id: string; code: string; name: string } | null;
  amount: bigint;
  medianMonth: YearMonth;
  history: HistoryMonth[];
  /** Bank accounts whose statements carried the history and cover the month (a bank payee). */
  banks: string[];
  floor: bigint;
  date: Date;
  reversalDate: Date;
  memo: string;
  rationale: string;
  /** Every history line counted, `jl:<journal line id>` (the anomaly scans' citation form). */
  refs: string[];
  /** A manual accrual of the account in the month (a payee or supplier bucket can't tell whose it was). */
  warning: string | null;
  /** Why *Setujui* can't post (the next month is locked). */
  blocked: string | null;
};

export type ProposalOptions = {
  entityIds?: string[];
  /** Today is read in Asia/Jakarta (tests fix it). */
  now?: Date;
  /** Include proposals waiting for a second approver (Persetujuan kedua): only its approval reads them. */
  withPending?: boolean;
};

type Line = Awaited<ReturnType<typeof historyLines>>[number];

const historyLines = (db: Db | Tx, entityId: string, accountIds: string[], from: Date, to: Date) =>
  db.journalLine.findMany({
    where: { entityId, accountId: { in: accountIds }, date: { gte: from, lte: to }, entry: { kind: { in: ["BANK", "RECLASS", "INVOICE", "IMPORTED"] } } },
    select: {
      id: true,
      date: true,
      debit: true,
      credit: true,
      memo: true,
      sourceRef: true,
      accountId: true,
      entry: {
        select: {
          kind: true,
          memo: true,
          sourceRef: true,
          ledgerImport: { select: { fileName: true } },
          bankTransaction: { select: { merchantKey: true, description: true, rowNumber: true, bankAccountId: true, bankAccount: { select: { label: true } } } },
          invoice: { select: { contactId: true, direction: true, voidedAt: true, number: true, contact: { select: { name: true } } } },
        },
      },
    },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });

/** The counterparty a counted line belongs to, or null for a line that is no spend (rule above). */
function bucketOf(l: Line): { bucket: Bucket; label: string } | null {
  const e = l.entry;
  if ((e.kind === "BANK" || e.kind === "RECLASS") && e.bankTransaction) {
    const key = e.bankTransaction.merchantKey;
    return key && !isGenericKey(key) ? { bucket: { kind: "bank", merchantKey: key }, label: key } : null;
  }
  if (e.kind === "INVOICE" && e.invoice && e.invoice.direction === "PURCHASE" && !e.invoice.voidedAt) return { bucket: { kind: "contact", contactId: e.invoice.contactId }, label: e.invoice.contact.name };
  if (e.kind === "IMPORTED") return { bucket: { kind: "ledger" }, label: "" };
  return null;
}

function historyLine(l: Line): HistoryLine {
  const e = l.entry;
  const bt = e.bankTransaction;
  const text = bt ? bt.description : e.invoice ? `${e.invoice.number} · ${e.invoice.contact.name}` : (l.memo ?? e.memo);
  const source = bt
    ? `${bt.bankAccount.label} baris ${bt.rowNumber}`
    : e.invoice
      ? `Tagihan pembelian ${e.invoice.number}`
      : [e.ledgerImport?.fileName, l.sourceRef ?? e.sourceRef].filter(Boolean).join(" ");
  return { id: l.id, ref: `jl:${l.id}`, date: l.date, text, source, amount: l.debit - l.credit };
}

export type Arrival = { date: Date; text: string; amount: bigint };

/**
 * What arrived from the counterparty in the month, through its last day: a bank payee's out lines (any status: a payment still in
 * Review on 1999 has arrived), a supplier's purchase invoices and the bank lines matched to it, a ledger bucket's imported lines.
 */
export async function arrivals(db: Db | Tx, entityId: string, accountId: string, bucket: Bucket, year: number, month: number): Promise<Arrival[]> {
  const { start, end } = periodBounds(year, month);
  const inMonth = { gte: start, lte: end };
  const bankLines = (where: Record<string, unknown>) =>
    db.bankTransaction.findMany({ where: { entityId, date: inMonth, ...where }, select: { date: true, description: true, amount: true }, orderBy: [{ date: "asc" }, { rowNumber: "asc" }] });
  if (bucket.kind === "bank") return (await bankLines({ merchantKey: bucket.merchantKey, direction: "OUT" })).map((t) => ({ date: t.date, text: t.description, amount: abs(t.amount) }));
  if (bucket.kind === "contact") {
    const [bills, paid] = await Promise.all([
      db.invoice.findMany({ where: { entityId, contactId: bucket.contactId, direction: "PURCHASE", voidedAt: null, issueDate: inMonth }, select: { issueDate: true, number: true, total: true }, orderBy: { issueDate: "asc" } }),
      bankLines({ contactId: bucket.contactId }),
    ]);
    return [...bills.map((b) => ({ date: b.issueDate, text: `Tagihan ${b.number}`, amount: b.total })), ...paid.map((t) => ({ date: t.date, text: t.description, amount: abs(t.amount) }))].sort((a, b) => +a.date - +b.date);
  }
  const lines = await db.journalLine.findMany({ where: { entityId, accountId, date: inMonth, entry: { kind: "IMPORTED" } }, select: { date: true, memo: true, debit: true, credit: true, entry: { select: { memo: true } } }, orderBy: [{ date: "asc" }, { id: "asc" }] });
  return lines.map((l) => ({ date: l.date, text: l.memo ?? l.entry.memo, amount: abs(l.debit - l.credit) }));
}

/** Accrual proposals of the client-month (companies in scope), problems first. Nothing is stored. */
export async function accrualProposals(db: Db, clientId: string, year: number, month: number, opts: ProposalOptions = {}): Promise<AccrualProposal[]> {
  const { start, end } = periodBounds(year, month);
  // The month must have ended (Asia/Jakarta, date-only): a vendor that pays on the 25th isn't missing on the 10th.
  if (+todayWib(opts.now) <= +end) return [];
  const next = shift(year, month, 1);
  const [periods, accounts, entities] = await Promise.all([
    db.period.findMany({ where: { clientId, status: "LOCKED", OR: [{ year, month }, next] }, select: { year: true, month: true } }),
    db.account.findMany({ where: { clientId }, select: { id: true, code: true, name: true, type: true, fsLine: true } }),
    db.entity.findMany({ where: { clientId, ...(opts.entityIds ? { id: { in: opts.entityIds } } : {}) }, select: { id: true, shortName: true, functionalCurrency: true }, orderBy: { name: "asc" } }),
  ]);
  // A locked month has nothing to approve (as Kotak leaves out locked instalments).
  if (periods.some((p) => p.year === year && p.month === month)) return [];
  const nextLocked = periods.some((p) => p.year === next.year && p.month === next.month);
  const reversalDate = dateOnly(next.year, next.month, 1);
  const eligible = accounts.filter((a) => a.type === "BEBAN" && ACCRUAL_LINES.includes(a.fsLine) && !NEVER.includes(a.code));
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const credit = accounts.find((a) => a.code === ACCRUED_EXPENSES) ?? null;
  const months = Array.from({ length: HISTORY_MONTHS }, (_, i) => shift(year, month, i - HISTORY_MONTHS));
  const out: AccrualProposal[] = [];
  if (!eligible.length) return out;

  for (const e of entities) {
    const lines = await historyLines(db, e.id, eligible.map((a) => a.id), periodBounds(months[0].year, months[0].month).start, periodBounds(months.at(-1)!.year, months.at(-1)!.month).end);
    // Group by account and counterparty; each month's amount is the net natural movement (debit − credit) of the counted lines.
    const groups = new Map<string, { accountId: string; bucket: Bucket; label: string; lines: Line[] }>();
    for (const l of lines) {
      const b = bucketOf(l);
      if (!b) continue;
      const k = `${l.accountId}|${bucketId(b.bucket)}`;
      const g = groups.get(k) ?? { accountId: l.accountId, bucket: b.bucket, label: b.label, lines: [] };
      g.lines.push(l);
      groups.set(k, g);
    }
    const monthOf = (d: Date) => months.findIndex((m) => m.year === d.getUTCFullYear() && m.month === d.getUTCMonth() + 1);
    // Recurs and stable first (no floor yet): the materiality scan runs only when something could be proposed.
    const recurring = [...groups.values()].flatMap((g) => {
      const amounts = months.map(() => 0n);
      for (const l of g.lines) amounts[monthOf(l.date)] += l.debit - l.credit;
      const rule = accrualRule(amounts, 0n);
      return rule.ok ? [{ ...g, amounts }] : [];
    });
    if (!recurring.length) continue;

    // Decided, or waiting for a second approver (shown under Persetujuan kedua instead, never twice).
    const keys = recurring.map((g) => accrualKey(e.id, year, month, byId.get(g.accountId)!.code, g.bucket));
    const [stored, waiting] = await Promise.all([
      db.proposedEntry.findMany({ where: { key: { in: keys } }, select: { key: true } }),
      opts.withPending ? [] : db.journalApproval.findMany({ where: { accrualKey: { in: keys }, status: "PENDING" }, select: { accrualKey: true } }),
    ]);
    const decided = new Set([...stored.map((p) => p.key), ...waiting.flatMap((a) => (a.accrualKey ? [a.accrualKey] : []))]);
    const opening = await openingDate(db, e.id);
    const covered = new Map<string, boolean>();
    const isCovered = async (bankAccountId: string) => {
      if (!covered.has(bankAccountId)) covered.set(bankAccountId, (await statementCoverage(db, bankAccountId, opening, start, end)).state === "covered");
      return covered.get(bankAccountId)!;
    };
    const ledgerComplete = (await db.journalLine.count({ where: { entityId: e.id, date: { gte: start, lte: end }, entry: { kind: "IMPORTED" } } })) > 0;
    const manual = await manualAccruals(db, e.id, year, month, e.functionalCurrency);
    let floor: bigint | null = null;

    for (const g of recurring) {
      const account = byId.get(g.accountId)!;
      const key = accrualKey(e.id, year, month, account.code, g.bucket);
      if (decided.has(key)) continue;
      // The month is complete for this counterparty: every bank account of its history covered through the month's end (a missing
      // statement is not a missing vendor); a ledger-fed company has imported lines dated in the month.
      const banks = [...new Map(g.lines.flatMap((l) => (l.entry.bankTransaction ? [[l.entry.bankTransaction.bankAccountId, l.entry.bankTransaction.bankAccount.label] as const] : []))).entries()];
      if (g.bucket.kind === "bank") {
        let all = true;
        for (const [id] of banks) all &&= await isCovered(id);
        if (!all) continue;
      }
      if (g.bucket.kind === "ledger" && !ledgerComplete) continue;
      if ((await arrivals(db, e.id, g.accountId, g.bucket, year, month)).length) continue;
      const already = manual.get(g.accountId) ?? null;
      // A ledger bucket is the account itself: a manual accrual on it is this accrual.
      if (already && g.bucket.kind === "ledger") continue;
      floor ??= (await scanLedger(db, clientId, e.id, year, month)).materiality ?? 1n;
      const rule = accrualRule(g.amounts, floor);
      if (!rule.ok) continue;

      const counterparty = g.bucket.kind === "ledger" ? `${account.code} ${account.name}` : g.label;
      const history = months.map((m, i) => ({ ...m, amount: g.amounts[i], lines: g.lines.filter((l) => monthOf(l.date) === i).map(historyLine) }));
      const medianMonth = months[rule.index];
      out.push({
        key,
        entity: e,
        year,
        month,
        bucket: g.bucket,
        counterparty,
        account: { id: account.id, code: account.code, name: account.name },
        credit: credit ? { id: credit.id, code: credit.code, name: credit.name } : null,
        amount: rule.median,
        medianMonth,
        history,
        banks: banks.map(([, label]) => label),
        floor,
        date: end,
        reversalDate,
        memo: `Akrual ${counterparty} ${formatMonthYear(year, month)}`.slice(0, 120),
        rationale: accrualRationale({
          kind: g.bucket.kind,
          counterparty,
          account,
          currency: e.functionalCurrency,
          months: history.filter((h) => h.amount !== 0n),
          year,
          month,
          banks: banks.map(([, label]) => label),
          median: rule.median,
          medianMonth,
        }),
        refs: g.lines.map((l) => `jl:${l.id}`),
        warning: already ? `Sudah ada akrual ${account.code} bulan ini: “${already.memo}” ${already.amount}. Pastikan bukan untuk ${counterparty} sebelum menyetujui.` : null,
        blocked: nextLocked ? `${formatDate(reversalDate)} sudah dikunci, jadi pembaliknya tidak bisa dicatat.` : null,
      });
    }
  }
  // Problems first (ui-rules 10): a blocked or warned card leads; then by company (as read), account and counterparty.
  const rank = (p: AccrualProposal) => (p.blocked ? 2 : 0) + (p.warning ? 1 : 0);
  const order = new Map(entities.map((e, i) => [e.id, i]));
  return out.sort((a, b) => rank(b) - rank(a) || order.get(a.entity.id)! - order.get(b.entity.id)! || a.account.code.localeCompare(b.account.code) || a.counterparty.localeCompare(b.counterparty));
}

/**
 * Accruals the accountant already made for the month, per expense account: an ADJUSTMENT (not a reversal, not from this feature, not a
 * schedule's) debiting the account and crediting a liability, or an ACCRUAL schedule's instalment in the month (posted or not).
 */
async function manualAccruals(db: Db, entityId: string, year: number, month: number, currency: string) {
  const { start, end } = periodBounds(year, month);
  const out = new Map<string, { memo: string; amount: string }>();
  const entries = await db.journalEntry.findMany({
    where: { entityId, kind: "ADJUSTMENT", date: { gte: start, lte: end }, reversesId: null, scheduleId: null, OR: [{ proposal: null }, { proposal: { source: { not: "ACCRUAL" } } }] },
    select: { memo: true, lines: { select: { accountId: true, debit: true, credit: true, account: { select: { type: true } } } } },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });
  for (const x of entries) {
    if (!x.lines.some((l) => l.credit > 0n && l.account.type === "LIABILITAS")) continue;
    for (const l of x.lines) if (l.debit > 0n && !out.has(l.accountId)) out.set(l.accountId, { memo: x.memo, amount: formatMoney(l.debit, currency) });
  }
  const schedules = await db.adjustmentSchedule.findMany({ where: { entityId, kind: "ACCRUAL" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  for (const s of schedules) {
    const due = installments(s).find((i) => !i.reversal && i.year === year && i.month === month && owed(s.stoppedAt, i));
    if (due && !out.has(s.debitAccountId)) out.set(s.debitAccountId, { memo: s.memo, amount: formatMoney(due.amount, currency) });
  }
  return out;
}

// ---- the decision (*Setujui*, *Ubah*, *Tolak*) ----

/** A refusal tied to one field of *Ubah* (shown under it). */
export class AccrualFieldError extends LedgerError {
  constructor(
    readonly field: "amount" | "debit" | "credit",
    message: string,
  ) {
    super(message);
  }
}

export const DECIDED = "Usulan akrual ini sudah diputuskan.";
export const ACCRUAL_PENDING = "Usulan akrual ini menunggu persetujuan kedua. Putuskan di Kotak persetujuan.";
const GONE = "Usulan akrual ini tidak berlaku lagi. Muat ulang halaman.";

/** *Ubah*: a new amount (major units, typed) and accounts; blank keeps Buku's. */
export type AccrualEdit = { amount?: string | null; debitCode?: string | null; creditCode?: string | null };

/** How a counterparty reads when its proposal is no longer computed (a refusal's words). */
async function labelOf(db: Db | Tx, clientId: string, code: string, bucket: Bucket) {
  if (bucket.kind === "bank") return bucket.merchantKey;
  if (bucket.kind === "contact") return (await db.contact.findFirst({ where: { id: bucket.contactId, clientId }, select: { name: true } }))?.name ?? "";
  const a = await db.account.findFirst({ where: { clientId, code }, select: { name: true } });
  return `${code} ${a?.name ?? ""}`.trim();
}

const arrivedText = (label: string, a: Arrival) => `Pembayaran ${label} ${formatDate(a.date)} sudah masuk; usulan ini tidak berlaku lagi.`;

/** A request of Persetujuan kedua waiting on this proposal: no direct *Setujui* or *Tolak* while it waits. */
async function waitingRequest(db: Db | Tx, key: string) {
  return (await db.journalApproval.findFirst({ where: { accrualKey: key, status: "PENDING" }, select: { id: true } })) !== null;
}
export const noPendingAccrual = (key: string) => async (db: Db | Tx) => {
  if (await waitingRequest(db, key)) throw new LedgerError(ACCRUAL_PENDING);
};

/**
 * The proposal behind a key as it reads now, or the reason it no longer exists (waiting for a second approver, decided, the payment
 * arrived, or anything else). `withPending`: a waiting proposal is read as any other (its approval).
 */
export async function currentAccrual(db: Db, clientId: string, key: string, now?: Date, withPending = false): Promise<AccrualProposal> {
  const k = parseAccrualKey(key);
  const entity = k ? await db.entity.findFirst({ where: { id: k.entityId, clientId }, select: { id: true } }) : null;
  if (!k || !entity) throw new LedgerError(GONE);
  const found = (await accrualProposals(db, clientId, k.year, k.month, { entityIds: [k.entityId], now, withPending })).find((p) => p.key === key);
  if (found) return found;
  if (!withPending && (await waitingRequest(db, key))) throw new LedgerError(ACCRUAL_PENDING);
  if (await db.proposedEntry.findUnique({ where: { key }, select: { id: true } })) throw new LedgerError(DECIDED);
  const account = await db.account.findFirst({ where: { clientId, code: k.code }, select: { id: true } });
  const [first] = account ? await arrivals(db, k.entityId, account.id, k.bucket, k.year, k.month) : [];
  if (first) throw new LedgerError(arrivedText(await labelOf(db, clientId, k.code, k.bucket), first));
  throw new LedgerError(GONE);
}

/** Buku's own lines, as the decision stores them (the entry holds what was posted). */
const proposedLines = (p: AccrualProposal): ProposalLine[] => [
  { accountCode: p.account.code, debit: p.amount.toString(), credit: "0" },
  { accountCode: p.credit?.code ?? "", debit: "0", credit: p.amount.toString() },
];

const stored = (firmId: string, clientId: string, p: AccrualProposal) => ({
  firmId,
  clientId,
  entityId: p.entity.id,
  year: p.year,
  month: p.month,
  source: "ACCRUAL" as const,
  key: p.key,
  memo: p.memo,
  lines: proposedLines(p),
  reason: p.rationale,
  refs: p.refs,
});

const isCode = (e: unknown, code: string) => (e as { code?: string } | null)?.code === code;

/**
 * *Setujui*'s journal (with *Ubah*'s edits), read and checked but not posted: the proposal as it reads now, and the ADJUSTMENT on the
 * month's last day with *Balik otomatis* as the one adjustment writer takes it (lib/ledger/adjustment.ts). A refusal tied to a field says
 * which. Persetujuan kedua routes this journal as *Jurnal manual* (lib/approvals/journals.ts `submitAccrual`).
 */
export async function prepareAccrual(db: Db, input: { clientId: string; key: string; edit?: AccrualEdit; now?: Date }): Promise<{ proposal: AccrualProposal; prepared: PreparedAdjustment }> {
  const p = await currentAccrual(db, input.clientId, input.key, input.now);
  if (p.blocked) throw new LedgerError(p.blocked);
  const edit = input.edit ?? {};
  let amount = p.amount;
  if (edit.amount?.trim()) {
    try {
      amount = parseMoney(edit.amount, p.entity.functionalCurrency);
    } catch (e) {
      throw new AccrualFieldError("amount", e instanceof Error ? e.message : "Nominal tidak bisa dibaca.");
    }
  }
  if (amount <= 0n) throw new AccrualFieldError("amount", "Nominal harus lebih dari nol.");
  const debitCode = edit.debitCode?.trim() || p.account.code;
  const creditCode = edit.creditCode?.trim() || p.credit?.code;
  if (!creditCode) throw new AccrualFieldError("credit", NO_CREDIT);
  const chart = new Map((await db.account.findMany({ where: { clientId: input.clientId, code: { in: [debitCode, creditCode] } } })).map((a) => [a.code, a]));
  const debit = chart.get(debitCode);
  const credit = chart.get(creditCode);
  const special = (a: { isBank: boolean; isClearing: boolean; isIntercompany: boolean; isSuspense: boolean }) => a.isBank || a.isClearing || a.isIntercompany || a.isSuspense;
  if (!debit) throw new AccrualFieldError("debit", `Akun ${debitCode} tidak ada di bagan akun klien.`);
  if (special(debit)) throw new AccrualFieldError("debit", "Akun debit tidak boleh akun bank, kliring (1190/1199) atau 1999.");
  if (!credit) throw new AccrualFieldError("credit", `Akun ${creditCode} tidak ada di bagan akun klien.`);
  if (special(credit) || credit.type !== "LIABILITAS") throw new AccrualFieldError("credit", "Akun kredit harus akun liabilitas, bukan bank, kliring (1190/1199) atau 1999.");
  if (debit.id === credit.id) throw new AccrualFieldError("credit", "Akun debit dan kredit harus berbeda.");
  const note = p.counterparty.slice(0, 200);
  return {
    proposal: p,
    prepared: {
      entity: { id: p.entity.id, functionalCurrency: p.entity.functionalCurrency },
      date: p.date,
      memo: p.memo,
      lines: [
        { accountId: debit.id, accountCode: debit.code, debit: amount, credit: 0n, memo: note },
        { accountId: credit.id, accountCode: credit.code, debit: 0n, credit: amount, memo: note },
      ],
      reverseNextMonth: true,
    },
  };
}

/** Inside a decision's transaction: the proposal is still undecided and its payment still hasn't arrived. */
export async function checkAccrualOpen(tx: Tx, p: AccrualProposal) {
  if (await tx.proposedEntry.findUnique({ where: { key: p.key }, select: { id: true } })) throw new LedgerError(DECIDED);
  const [first] = await arrivals(tx, p.entity.id, p.account.id, p.bucket, p.year, p.month);
  if (first) throw new LedgerError(arrivedText(p.counterparty, first));
}

/**
 * Posts a prepared accrual: one SERIALIZABLE transaction that runs `guard` (default: no request waiting on it), re-checks the proposal is
 * still undecided and still missing, posts through the one adjustment writer (`postPreparedAdjustment`, *Balik otomatis*), stores the
 * decision POSTED with its entry, then `onPosted` in the same transaction. A locked next month refuses both. The approval of a waiting
 * accrual (Persetujuan kedua) posts through here with its own guard (the row claimed) and hook (the request approved).
 */
export async function postPreparedAccrual(
  db: Db,
  input: {
    firmId: string;
    clientId: string;
    proposal: AccrualProposal;
    prepared: PreparedAdjustment;
    actorId?: string | null;
    guard?: (tx: Tx) => Promise<void>;
    onPosted?: (tx: Tx, entry: { id: string }) => Promise<void>;
  },
) {
  const p = input.proposal;
  const guard = input.guard ?? noPendingAccrual(p.key);
  try {
    return await db.$transaction(
      async (tx) => {
        await guard(tx);
        await checkAccrualOpen(tx, p);
        const entry = await postPreparedAdjustment(tx, input.prepared, input.actorId);
        await tx.proposedEntry.create({ data: { ...stored(input.firmId, input.clientId, p), status: "POSTED", entryId: entry.id, decidedById: input.actorId ?? null, decidedAt: new Date() } });
        await input.onPosted?.(tx, entry);
        return entry;
      },
      { isolationLevel: "Serializable", timeout: 60_000 },
    );
  } catch (e) {
    if (isCode(e, "P2002")) throw new LedgerError(DECIDED);
    if (isCode(e, "P2034")) throw new LedgerError("Buku sedang diubah bersamaan; coba catat lagi.");
    throw e;
  }
}

/**
 * *Setujui* (with *Ubah*'s edits), posting at once: the ADJUSTMENT on the month's last day and its mirror on the 1st of the next month
 * through Jurnal Penyesuaian's own writer, and the decision stored POSTED with its entry. With Persetujuan kedua's *Jurnal manual* on, the
 * action goes through `submitAccrual` (lib/approvals/journals.ts), which may store a request instead.
 */
export async function postAccrual(db: Db, input: { firmId: string; clientId: string; key: string; edit?: AccrualEdit; actorId?: string | null; now?: Date }) {
  const { proposal, prepared } = await prepareAccrual(db, input);
  return postPreparedAccrual(db, { firmId: input.firmId, clientId: input.clientId, proposal, prepared, actorId: input.actorId });
}

/**
 * Approved accruals of the company-month whose counterparty got a line in the month afterwards (a late statement, a bill entered late):
 * the expense is then in the books twice. Each with the accrual entry, its reversal (what *Salin* copies to cancel it) and the first
 * arrival. Feeds the REVIEW control *Akrual dan pembayaran di bulan yang sama*.
 */
export async function paidAfterAccrual(db: Db | Tx, clientId: string, entityId: string, year: number, month: number) {
  const posted = await db.proposedEntry.findMany({
    where: { clientId, entityId, year, month, source: "ACCRUAL", status: "POSTED", entryId: { not: null } },
    select: { id: true, key: true, entry: { select: { id: true, date: true, memo: true, reversedBy: { select: { id: true } }, lines: { select: { debit: true } } } } },
    orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
  });
  const out = [];
  for (const p of posted) {
    const k = parseAccrualKey(p.key);
    const account = k ? await db.account.findFirst({ where: { clientId, code: k.code }, select: { id: true } }) : null;
    if (!k || !account || !p.entry) continue;
    const [first] = await arrivals(db, entityId, account.id, k.bucket, year, month);
    if (!first) continue;
    out.push({
      proposalId: p.id,
      counterparty: await labelOf(db, clientId, k.code, k.bucket),
      entry: { date: p.entry.date, memo: p.entry.memo, amount: p.entry.lines.reduce((s, l) => s + l.debit, 0n) },
      reversalId: p.entry.reversedBy?.id ?? null,
      arrival: first,
    });
  }
  return out;
}

/** *Tolak*: the decision is stored DISMISSED for that month; the counterparty is evaluated afresh next month. */
export async function dismissAccrual(db: Db, input: { firmId: string; clientId: string; key: string; actorId?: string | null; now?: Date }) {
  const p = await currentAccrual(db, input.clientId, input.key, input.now);
  try {
    await db.proposedEntry.create({ data: { ...stored(input.firmId, input.clientId, p), status: "DISMISSED", decidedById: input.actorId ?? null, decidedAt: new Date() } });
  } catch (e) {
    if (isCode(e, "P2002")) throw new LedgerError(DECIDED);
    throw e;
  }
  return p;
}
