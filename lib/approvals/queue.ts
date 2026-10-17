import type { Db } from "@/lib/db";
import { formatDate, periodBounds, toIsoDate } from "@/lib/format";
import { classifiableOptions } from "@/lib/coa/options";
import { isSimpleGuess } from "@/lib/classify/fallback";
import { accountantHints, bulkAcceptable } from "@/lib/classify/hints";
import { correctionViews } from "@/lib/adjust/suspense";
import { proposalViews as scheduleViews } from "@/lib/adjust/view";
import { packApplies } from "@/lib/tax/pack";
import { FAKTUR_PREFERRED, fakturCounterAccounts, fakturRecon } from "@/lib/tax/faktur";
import type { JournalApprovalSource, MemberRole } from "@/lib/generated/prisma/enums";
import { readStoredLines } from "@/lib/approvals/journals";
import { pendingReopens } from "@/lib/approvals/reopen";
import { SOURCE_LABEL, waitingFor, waitReason } from "@/lib/approvals/second";
import { accrualProposals, NO_CREDIT } from "@/lib/adjust/accruals";

/**
 * Kotak persetujuan (Phase 2 item 1): every proposal of a client-month waiting for the accountant's click, in one queue. A read model,
 * computed from what each owning page already reads — nothing is stored, and every approval goes through that page's own writer:
 * - bank lines in Review through the month end (Review's query and order), accepted by the reviewer's writer;
 * - open *Jelaskan* drafts and the month's 1999 corrections (Tutup Buku's *Usulan jurnal koreksi*), posted by the proposal writer;
 * - adjustment-schedule instalments due by the month, overdue ones included (Jurnal Penyesuaian), posted by the schedule writer;
 * - accruals proposed from each vendor's history (`lib/adjust/accruals.ts`), posted with their reversal by the accrual writer;
 * - counted Coretax faktur of the masa that match nothing in the books (Pajak Masa), booked by the invoice writer;
 * - journals waiting for a second approver and months an admin asked to reopen (Persetujuan kedua), decided by their own actions.
 * The firm board's count is this same function (`approvalCounts`), so the board always equals the page.
 */

export type ApprovalKind = "second" | "bank" | "draft" | "scheduled" | "accrual" | "faktur";
/** In page order; `param` is the kind's `?jenis=` value. Persetujuan kedua leads: a second person is waiting on it. */
export const APPROVAL_KINDS: { key: ApprovalKind; param: string; label: string }[] = [
  { key: "second", param: "kedua", label: "Persetujuan kedua" },
  { key: "bank", param: "bank", label: "Klasifikasi bank" },
  { key: "draft", param: "draf", label: "Draf jurnal" },
  { key: "scheduled", param: "terjadwal", label: "Jurnal terjadwal" },
  { key: "accrual", param: "akrual", label: "Usulan akrual" },
  { key: "faktur", param: "faktur", label: "Faktur Coretax" },
];
/** Bank lines dominate a month; past this many the rest are counted and left to Review. */
export const BANK_CARD_LIMIT = 50;
/** Below this an AI suggestion is called out in the review colour (Review's own threshold). */
export const LOW_CONFIDENCE = 0.7;

export type ApprovalCounts = Record<ApprovalKind, number> & { total: number };

/** Plain JSON (amounts as minor-unit strings), ready for the client component. */
export type BankCard = {
  id: string;
  date: string;
  entityId: string;
  entity: string;
  bank: string;
  description: string;
  /** Signed: + in, − out. */
  amount: string;
  currency: string;
  method: string;
  confidence: number;
  reason: string;
  suggestedCode: string | null;
  suggestedName: string | null;
  taxTag: string | null;
  /** Only the simple guess stands behind the suggestion. */
  guess: boolean;
  /** Accountant hints open on the suggested account (Review's), in full. */
  hints: string[];
  /** May go in *Setujui N usulan yakin*. */
  confident: boolean;
};
export type DraftCard = Awaited<ReturnType<typeof correctionViews>>[number] & { date: string };
export type ScheduledCard = Awaited<ReturnType<typeof scheduleViews>>[number] & { overdue: boolean };
/** An accrual proposal (plain JSON): `id` is its key; `source` marks it for *Lihat alasan* (`hasReasoning`). */
export type AccrualCard = {
  id: string;
  source: "ACCRUAL";
  entityId: string;
  entity: string;
  /** ISO: the month's last day, and the reversal's (the 1st of the next month). */
  date: string;
  reversalDate: string;
  counterparty: string;
  account: { code: string; name: string };
  credit: { code: string; name: string } | null;
  /** Without 2150 the accountant picks the liability (*Setujui* waits for it): what the card says. */
  noCredit: string | null;
  amount: string;
  currency: string;
  rationale: string;
  warning: string | null;
  blocked: string | null;
};
export type FakturCard = {
  id: string;
  direction: "KELUARAN" | "MASUKAN";
  number: string;
  date: string;
  name: string;
  npwp: string | null;
  dpp: string;
  ppn: string;
  entityId: string;
  entity: string;
  fileName: string;
  sourceRef: string;
  /** The account the select starts on (Pajak Masa's). */
  preferred: string;
};

/** A journal waiting for a second approver (Persetujuan kedua); amounts as minor-unit strings. */
export type SecondJournalCard = {
  type: "journal";
  id: string;
  source: JournalApprovalSource;
  sourceLabel: string;
  entityId: string;
  entity: string;
  currency: string;
  /** ISO date the journal posts on. */
  date: string;
  memo: string;
  lines: { accountCode: string; accountName: string; debit: string; credit: string; memo: string | null }[];
  total: string;
  reverseNextMonth: boolean;
  makerId: string;
  makerRole: MemberRole;
  maker: string;
  at: string;
  /** "di atas Rp 100.000.000" */
  why: string;
  /** Who may decide, for everyone else looking at it. */
  waitingFor: string;
  /** Dated before the month in scope ("bulan lalu"). */
  earlier: boolean;
};
/** A closed month an admin asked to reopen (Persetujuan kedua). */
export type SecondReopenCard = { type: "reopen"; id: string; year: number; month: number; label: string; reason: string; requestedById: string; requestedBy: string; at: string; earlier: boolean };
export type SecondCard = SecondJournalCard | SecondReopenCard;

export type ApprovalQueue = {
  counts: ApprovalCounts;
  /** The month is closed: the queue is shown, nothing can be approved. */
  locked: boolean;
  /** At most `BANK_CARD_LIMIT`, problems first; `counts.bank` has them all. */
  bank: BankCard[];
  /** Every line in scope that may be accepted in bulk, in Review's order (not only the cards shown). */
  confident: { id: string; accountCode: string; taxTag: string | null }[];
  drafts: DraftCard[];
  scheduled: ScheduledCard[];
  accruals: AccrualCard[];
  faktur: FakturCard[];
  /** Persetujuan kedua: waiting journals (oldest first), then reopen requests. */
  second: SecondCard[];
  /** The accounts a faktur may be booked against, per direction (only when there are faktur cards). */
  fakturAccounts: ReturnType<typeof fakturCounterAccounts> | null;
};

export type QueueInput = { clientId: string; year: number; month: number; /** Companies in scope; all of the client's when omitted. */ entityIds?: string[]; /** Today, for "the month has ended" (accruals); tests fix it. */ now?: Date };

async function scopeOf(db: Db, input: QueueInput) {
  const entities = await db.entity.findMany({
    where: { clientId: input.clientId, ...(input.entityIds ? { id: { in: input.entityIds } } : {}) },
    select: { id: true, shortName: true, kind: true, functionalCurrency: true },
  });
  return { entities, ids: entities.map((e) => e.id), ...periodBounds(input.year, input.month) };
}

/** Bank lines in Review through the month end: Review's own set and order. */
const reviewWhere = (ids: string[], end: Date) => ({ entityId: { in: ids }, date: { lte: end }, status: "NEEDS_REVIEW" as const });

async function drafts(db: Db, input: QueueInput, ids: string[], end: Date): Promise<DraftCard[]> {
  const date = toIsoDate(end);
  const views = (await correctionViews(db, input.clientId, input.year, input.month)).filter((v) => ids.includes(v.entityId));
  // Problems first (ui-rules 10): a draft that can't post says why at the top.
  return views.map((v) => ({ ...v, date })).sort((a, b) => Number(Boolean(b.blocked)) - Number(Boolean(a.blocked)));
}

async function scheduled(db: Db, input: QueueInput, ids: string[], start: Date): Promise<ScheduledCard[]> {
  const first = toIsoDate(start);
  const views = (await scheduleViews(db, input.clientId, input.year, input.month)).filter((v) => ids.includes(v.entityId));
  // An overdue instalment (an earlier month's) is the problem: first, then by date.
  return views.map((v) => ({ ...v, overdue: v.date < first })).sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.date.localeCompare(b.date));
}

async function accruals(db: Db, input: QueueInput, ids: string[]): Promise<AccrualCard[]> {
  if (!ids.length) return [];
  // Problems first already (blocked, then warned).
  return (await accrualProposals(db, input.clientId, input.year, input.month, { entityIds: ids, now: input.now })).map((p) => ({
    id: p.key,
    source: "ACCRUAL",
    entityId: p.entity.id,
    entity: p.entity.shortName,
    date: toIsoDate(p.date),
    reversalDate: toIsoDate(p.reversalDate),
    counterparty: p.counterparty,
    account: { code: p.account.code, name: p.account.name },
    credit: p.credit ? { code: p.credit.code, name: p.credit.name } : null,
    noCredit: p.credit ? null : NO_CREDIT,
    amount: p.amount.toString(),
    currency: p.entity.functionalCurrency,
    rationale: p.rationale,
    warning: p.warning,
    blocked: p.blocked,
  }));
}

/** Counted faktur of the masa matching nothing in the books, for each Rupiah company that imported faktur for it. */
async function unbookedFaktur(db: Db, input: QueueInput, entities: { id: string; shortName: string; kind: string; functionalCurrency: string }[]): Promise<FakturCard[]> {
  const companies = entities.filter(packApplies);
  if (!companies.length) return [];
  const imported = await db.coretaxFaktur.groupBy({ by: ["entityId"], where: { clientId: input.clientId, entityId: { in: companies.map((e) => e.id) }, year: input.year, month: input.month } });
  const out: FakturCard[] = [];
  for (const e of companies.filter((c) => imported.some((i) => i.entityId === c.id))) {
    const recon = await fakturRecon(db, { clientId: input.clientId, entityId: e.id, year: input.year, month: input.month });
    for (const d of recon.directions) {
      for (const f of d.unmatchedFaktur) {
        out.push({ id: f.id, direction: d.direction, number: f.number, date: toIsoDate(f.date), name: f.name, npwp: f.npwp, dpp: f.dpp.toString(), ppn: f.ppn.toString(), entityId: e.id, entity: e.shortName, fileName: f.fileName, sourceRef: f.sourceRef, preferred: FAKTUR_PREFERRED[d.direction] });
      }
    }
  }
  return out;
}

const countsOf = (second: number, bank: number, d: unknown[], s: unknown[], a: unknown[], f: unknown[]): ApprovalCounts => ({
  second,
  bank,
  draft: d.length,
  scheduled: s.length,
  accrual: a.length,
  faktur: f.length,
  total: second + bank + d.length + s.length + a.length + f.length,
});

/**
 * Journals waiting for a second approver dated on or before the month end (a draft by its period), for the companies in scope, oldest
 * first: Review's "through the month end", so an old request never hides. A request is never a ledger entry (accounting-rules 2a).
 */
const secondWhere = (clientId: string, ids: string[], end: Date) => ({ clientId, entityId: { in: ids }, status: "PENDING" as const, date: { lte: end } });
/** Reopen requests for months up to the one in scope: shown even when that month is closed, the one card a closed month can act on. */
const reopenWhere = (clientId: string, year: number, month: number) => ({ clientId, status: "PENDING" as const, OR: [{ year: { lt: year } }, { year, month: { lte: month } }] });

async function secondCards(db: Db, input: QueueInput, ids: string[], start: Date, end: Date): Promise<SecondCard[]> {
  const [rows, reopens, accounts] = await Promise.all([
    db.journalApproval.findMany({
      where: secondWhere(input.clientId, ids, end),
      include: { entity: { select: { shortName: true, functionalCurrency: true } }, maker: { select: { name: true } } },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    }),
    pendingReopens(db, input.clientId, { year: input.year, month: input.month }),
    db.account.findMany({ where: { clientId: input.clientId }, select: { code: true, name: true } }),
  ]);
  const names = new Map(accounts.map((a) => [a.code, a.name]));
  const journals: SecondCard[] = rows.map((a) => ({
    type: "journal",
    id: a.id,
    source: a.source,
    sourceLabel: SOURCE_LABEL[a.source],
    entityId: a.entityId,
    entity: a.entity.shortName,
    currency: a.entity.functionalCurrency,
    date: toIsoDate(a.date),
    memo: a.memo,
    lines: readStoredLines(a.lines).map((l) => ({ accountCode: l.accountCode, accountName: names.get(l.accountCode) ?? "", debit: l.debit, credit: l.credit, memo: l.memo ?? null })),
    total: a.amount.toString(),
    reverseNextMonth: a.reverseNextMonth,
    makerId: a.makerId,
    makerRole: a.makerRole,
    maker: a.maker.name,
    at: a.createdAt.toISOString(),
    why: waitReason(a.threshold, a.entity.functionalCurrency),
    waitingFor: waitingFor(a.makerRole),
    earlier: a.date < start,
  }));
  const asked: SecondCard[] = reopens.map((r) => ({ type: "reopen", id: r.id, year: r.year, month: r.month, label: r.label, reason: r.reason, requestedById: r.requestedById, requestedBy: r.requestedBy, at: r.at.toISOString(), earlier: r.year * 100 + r.month < input.year * 100 + input.month }));
  return [...journals, ...asked];
}

/** The queue for a client-month and scope, with a card per proposal (bank lines capped) and the count per kind. */
export async function approvalQueue(db: Db, input: QueueInput): Promise<ApprovalQueue> {
  const { entities, ids, start, end } = await scopeOf(db, input);
  const [lines, accounts, period, draftCards, scheduledCards, accrualCards, fakturCards, second] = await Promise.all([
    db.bankTransaction.findMany({
      where: reviewWhere(ids, end),
      include: { bankAccount: { select: { label: true, currency: true } } },
      orderBy: [{ date: "asc" }, { rowNumber: "asc" }],
    }),
    db.account.findMany({ where: { clientId: input.clientId }, orderBy: { code: "asc" } }),
    db.period.findUnique({ where: { clientId_year_month: { clientId: input.clientId, year: input.year, month: input.month } }, select: { status: true } }),
    drafts(db, input, ids, end),
    scheduled(db, input, ids, start),
    accruals(db, input, ids),
    unbookedFaktur(db, input, entities),
    secondCards(db, input, ids, start, end),
  ]);
  // The hints read the suggested account as Review's picker lists it.
  const byCode = new Map(classifiableOptions(accounts).map((o) => [o.code, o]));
  const kindOf = new Map(entities.map((e) => [e.id, e]));
  const cards: BankCard[] = lines.map((t) => {
    const account = t.suggestedCode ? (byCode.get(t.suggestedCode) ?? null) : null;
    const entity = kindOf.get(t.entityId)!;
    const line = { ...t, entityKind: entity.kind };
    return {
      id: t.id,
      date: formatDate(t.date),
      entityId: t.entityId,
      entity: entity.shortName,
      bank: t.bankAccount.label,
      description: t.description,
      amount: t.amount.toString(),
      currency: t.bankAccount.currency,
      method: t.method,
      confidence: t.confidence,
      reason: t.reason,
      suggestedCode: t.suggestedCode,
      suggestedName: account?.name ?? null,
      taxTag: t.taxTag,
      guess: isSimpleGuess(t),
      hints: accountantHints({ description: t.description, amount: t.amount, account, wht: "none", entityKind: entity.kind }).map((h) => h.text),
      confident: bulkAcceptable(line, account),
    };
  });
  const confident = cards.filter((c) => c.confident).map((c) => ({ id: c.id, accountCode: c.suggestedCode!, taxTag: c.taxTag }));
  // Problems first (ui-rules 10): low confidence and simple guesses lead, the rest keep Review's date order.
  const low = (c: BankCard) => c.confidence < LOW_CONFIDENCE;
  const shown = [...cards].sort((a, b) => Number(low(b)) - Number(low(a))).slice(0, BANK_CARD_LIMIT);
  return {
    counts: countsOf(second.length, lines.length, draftCards, scheduledCards, accrualCards, fakturCards),
    locked: period?.status === "LOCKED",
    bank: shown,
    confident,
    drafts: draftCards,
    scheduled: scheduledCards,
    accruals: accrualCards,
    faktur: fakturCards,
    second,
    fakturAccounts: fakturCards.length ? fakturCounterAccounts(accounts) : null,
  };
}

/**
 * The count per kind only (the firm board's *Persetujuan* cell): the same sets as `approvalQueue`, without building cards. `reopen: false`
 * leaves reopen requests out (the checklist's *Review transaksi dan usulan* proof: a reopen of July is not August's review work).
 */
export async function approvalCounts(db: Db, input: QueueInput, opts: { reopen?: boolean } = {}): Promise<ApprovalCounts> {
  const { entities, ids, start, end } = await scopeOf(db, input);
  const [journals, reopens, bank, draftCards, scheduledCards, accrualCards, fakturCards] = await Promise.all([
    db.journalApproval.count({ where: secondWhere(input.clientId, ids, end) }),
    opts.reopen === false ? 0 : db.reopenRequest.count({ where: reopenWhere(input.clientId, input.year, input.month) }),
    db.bankTransaction.count({ where: reviewWhere(ids, end) }),
    drafts(db, input, ids, end),
    scheduled(db, input, ids, start),
    accruals(db, input, ids),
    unbookedFaktur(db, input, entities),
  ]);
  return countsOf(journals + reopens, bank, draftCards, scheduledCards, accrualCards, fakturCards);
}
