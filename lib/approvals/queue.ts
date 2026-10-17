import type { Db } from "@/lib/db";
import { formatDate, periodBounds, toIsoDate } from "@/lib/format";
import { classifiableOptions } from "@/lib/coa/options";
import { isSimpleGuess } from "@/lib/classify/fallback";
import { accountantHints, bulkAcceptable } from "@/lib/classify/hints";
import { correctionViews } from "@/lib/adjust/suspense";
import { proposalViews as scheduleViews } from "@/lib/adjust/view";
import { packApplies } from "@/lib/tax/pack";
import { FAKTUR_PREFERRED, fakturCounterAccounts, fakturRecon } from "@/lib/tax/faktur";

/**
 * Kotak persetujuan (Phase 2 item 1): every proposal of a client-month waiting for the accountant's click, in one queue. A read model,
 * computed from what each owning page already reads — nothing is stored, and every approval goes through that page's own writer:
 * - bank lines in Review through the month end (Review's query and order), accepted by the reviewer's writer;
 * - open *Jelaskan* drafts and the month's 1999 corrections (Tutup Buku's *Usulan jurnal koreksi*), posted by the proposal writer;
 * - adjustment-schedule instalments due by the month, overdue ones included (Jurnal Penyesuaian), posted by the schedule writer;
 * - counted Coretax faktur of the masa that match nothing in the books (Pajak Masa), booked by the invoice writer.
 * The firm board's count is this same function (`approvalCounts`), so the board always equals the page.
 */

export type ApprovalKind = "bank" | "draft" | "scheduled" | "faktur";
/** In page order (the `?jenis=` tabs). */
export const APPROVAL_KINDS: { key: ApprovalKind; label: string }[] = [
  { key: "bank", label: "Klasifikasi bank" },
  { key: "draft", label: "Draf jurnal" },
  { key: "scheduled", label: "Jurnal terjadwal" },
  { key: "faktur", label: "Faktur Coretax" },
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
  faktur: FakturCard[];
  /** The accounts a faktur may be booked against, per direction (only when there are faktur cards). */
  fakturAccounts: ReturnType<typeof fakturCounterAccounts> | null;
};

export type QueueInput = { clientId: string; year: number; month: number; /** Companies in scope; all of the client's when omitted. */ entityIds?: string[] };

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

const countsOf = (bank: number, d: unknown[], s: unknown[], f: unknown[]): ApprovalCounts => ({ bank, draft: d.length, scheduled: s.length, faktur: f.length, total: bank + d.length + s.length + f.length });

/** The queue for a client-month and scope, with a card per proposal (bank lines capped) and the count per kind. */
export async function approvalQueue(db: Db, input: QueueInput): Promise<ApprovalQueue> {
  const { entities, ids, start, end } = await scopeOf(db, input);
  const [lines, accounts, period, draftCards, scheduledCards, fakturCards] = await Promise.all([
    db.bankTransaction.findMany({
      where: reviewWhere(ids, end),
      include: { bankAccount: { select: { label: true, currency: true } } },
      orderBy: [{ date: "asc" }, { rowNumber: "asc" }],
    }),
    db.account.findMany({ where: { clientId: input.clientId }, orderBy: { code: "asc" } }),
    db.period.findUnique({ where: { clientId_year_month: { clientId: input.clientId, year: input.year, month: input.month } }, select: { status: true } }),
    drafts(db, input, ids, end),
    scheduled(db, input, ids, start),
    unbookedFaktur(db, input, entities),
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
    counts: countsOf(lines.length, draftCards, scheduledCards, fakturCards),
    locked: period?.status === "LOCKED",
    bank: shown,
    confident,
    drafts: draftCards,
    scheduled: scheduledCards,
    faktur: fakturCards,
    fakturAccounts: fakturCards.length ? fakturCounterAccounts(accounts) : null,
  };
}

/** The count per kind only (the firm board's *Persetujuan* cell): the same sets as `approvalQueue`, without building cards. */
export async function approvalCounts(db: Db, input: QueueInput): Promise<ApprovalCounts> {
  const { entities, ids, start, end } = await scopeOf(db, input);
  const [bank, draftCards, scheduledCards, fakturCards] = await Promise.all([
    db.bankTransaction.count({ where: reviewWhere(ids, end) }),
    drafts(db, input, ids, end),
    scheduled(db, input, ids, start),
    unbookedFaktur(db, input, entities),
  ]);
  return countsOf(bank, draftCards, scheduledCards, fakturCards);
}
