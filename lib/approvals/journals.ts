import type { Db, Tx } from "@/lib/db";
import type { JournalApprovalSource, MemberRole } from "@/lib/generated/prisma/enums";
import type { Prisma } from "@/lib/generated/prisma/client";
import { recordEvent } from "@/lib/audit";
import { formatDate, periodBounds } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { checkJournal, LedgerError } from "@/lib/ledger/post";
import { adjustmentPosting, firstOfNextMonth, postPreparedAdjustment, prepareAdjustment, storedTags, type AdjustmentLineInput, type PreparedAdjustment } from "@/lib/ledger/adjustment";
import { checkReversal, mirrorLines, reverseEntry, reverseEntryTx } from "@/lib/ledger/reverse";
import { chosenAccounts, postProposal, readLines } from "@/lib/adjust/proposals";
import { closeLock } from "@/lib/adjust/schedules";
import { ACCRUAL_PENDING, checkAccrualOpen, currentAccrual, postAccrual, postPreparedAccrual, prepareAccrual, type AccrualEdit } from "@/lib/adjust/accruals";
import { clientPeople } from "@/lib/checklist/view";
import { readApprovals } from "@/lib/settings/approvals";
import { ApprovalError, approvalSubject, approverProblem, hasApprover, JOURNAL_FALLBACK, journalHead, NOTE_MESSAGE, NOTE_MIN, PENDING_DRAFT, routing, sourceRoute, waitReason, type SourceRoute } from "@/lib/approvals/second";

/**
 * Persetujuan kedua for journals (cycle 2026-10-18-persetujuan-kedua, accounting-rules 2a). A routed journal is saved as a request
 * (`JournalApproval`), never as a ledger entry; on approval the maker's own writer posts it — the adjustment writer (directly, or through
 * the accrual writer for an approved *Usulan akrual*), the reversal writer or `postProposal` — all through postJournal(), the only writer,
 * in one transaction with the status change. Below the threshold, with the card off, or for a source that isn't routed, every writer
 * runs exactly as before.
 */
export type Maker = { id: string; role: MemberRole };
/** `posted`: the entry is in the books (`fallback` when no one else could approve it); otherwise it waits as `approvalId`. */
export type Outcome = { posted: true; entryId: string; fallback: boolean } | { posted: false; approvalId: string };

/** A stored request line: the account by code, minor units as strings (as a draft's), an optional note and Departemen & Proyek tags. */
export type StoredLine = { accountCode: string; debit: string; credit: string; memo?: string; departmentId?: string; projectId?: string };

const DIGITS = /^\d{1,18}$/;
export function readStoredLines(value: unknown): StoredLine[] {
  if (!Array.isArray(value)) throw new LedgerError("Permintaan persetujuan rusak.");
  return value.map((l) => {
    const x = l as Record<string, unknown>;
    if (typeof x.accountCode !== "string" || typeof x.debit !== "string" || typeof x.credit !== "string" || !DIGITS.test(x.debit) || !DIGITS.test(x.credit) || (x.memo !== undefined && typeof x.memo !== "string") || [x.departmentId, x.projectId].some((t) => t !== undefined && typeof t !== "string")) {
      throw new LedgerError("Permintaan persetujuan rusak.");
    }
    return { accountCode: x.accountCode, debit: x.debit, credit: x.credit, ...(x.memo ? { memo: x.memo } : {}), ...storedTags(x as Tags) };
  });
}

type Tags = { departmentId?: string | null; projectId?: string | null };
const sumDebit = (lines: { debit: bigint }[]) => lines.reduce((s, l) => s + l.debit, 0n);
const stored = (lines: ({ accountCode: string; debit: bigint; credit: bigint; memo?: string | null } & Tags)[]): StoredLine[] =>
  lines.filter((l) => l.debit > 0n || l.credit > 0n).map((l) => ({ accountCode: l.accountCode, debit: l.debit.toString(), credit: l.credit.toString(), ...(l.memo ? { memo: l.memo } : {}), ...storedTags(l) }));

const isUnique = (e: unknown) => (e as { code?: string }).code === "P2002";

async function firmOf(db: Db | Tx, clientId: string) {
  return (await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { firmId: true } })).firmId;
}

/** Whether another active member who holds the client may approve this maker's journal. */
async function approverExists(db: Db | Tx, clientId: string, maker: Maker) {
  return hasApprover((await clientPeople(db, clientId)).values(), maker);
}

/** What a form tells this member before the click (lib/approvals/second `formNotice`): the firm's route for the source, and the fallback. */
export async function routeFor(db: Db, clientId: string, member: Maker, source: JournalApprovalSource): Promise<SourceRoute> {
  const settings = await readApprovals(db, await firmOf(db, clientId));
  const on = source === "AI_DRAFT" ? settings.aiDraft : settings.manual;
  return sourceRoute(settings, source, on && !(await approverExists(db, clientId, member)));
}

type Head = { source: JournalApprovalSource; memo: string; date: Date; amount: bigint; currency: string };
const head = (h: Head) => journalHead(h.source, h.memo, formatDate(h.date), formatMoney(h.amount, h.currency));

/** The fallback's one Riwayat event: posted at once because nobody else may approve it (the owner's choice over refusing). */
async function recordFallback(tx: Tx, clientId: string, entityId: string, h: Head, entryId: string, actorId: string) {
  await recordEvent(tx, { clientId, entityId, kind: "APPROVAL", subject: `entry:${entryId}`, summary: `${head(h)} · ${JOURNAL_FALLBACK}`, after: { status: "POSTED", entryId, amount: h.amount.toString(), secondApprover: null }, actorId });
}

type NewRequest = {
  clientId: string;
  entityId: string;
  source: JournalApprovalSource;
  date: Date;
  memo: string;
  lines: StoredLine[];
  amount: bigint;
  currency: string;
  threshold: bigint | null;
  maker: Maker;
  reverseNextMonth?: boolean;
  reversesId?: string;
  proposalId?: string;
  accounts?: string[];
  accrualKey?: string;
  recurring?: { id: string; month: number };
};

/** Stores the request and its "diajukan" event in `tx` (the caller has checked it could post). */
async function createRequest(tx: Tx, r: NewRequest) {
  const a = await tx.journalApproval.create({
    data: {
      firmId: await firmOf(tx, r.clientId),
      clientId: r.clientId,
      entityId: r.entityId,
      source: r.source,
      date: r.date,
      memo: r.memo,
      lines: r.lines as Prisma.InputJsonValue,
      reverseNextMonth: r.reverseNextMonth === true,
      reversesId: r.reversesId ?? null,
      proposalId: r.proposalId ?? null,
      accounts: r.accounts ?? [],
      accrualKey: r.accrualKey ?? null,
      recurringId: r.recurring?.id ?? null,
      recurringMonth: r.recurring?.month ?? null,
      amount: r.amount,
      threshold: r.threshold,
      makerId: r.maker.id,
      makerRole: r.maker.role,
    },
  });
  await recordEvent(tx, {
    clientId: r.clientId,
    entityId: r.entityId,
    kind: "APPROVAL",
    subject: approvalSubject(a.id),
    summary: `${head(r)} diajukan untuk persetujuan kedua (${waitReason(r.threshold, r.currency)})`,
    after: { status: "PENDING", amount: r.amount.toString(), threshold: r.threshold?.toString() ?? null },
    actorId: r.maker.id,
  });
  return a;
}

/**
 * *Simpan jurnal* on Jurnal Penyesuaian (with or without *Balik otomatis*; a *Salin* save is the same). Card off or at/below the threshold:
 * posted exactly as before. Above it: every check the post would make runs now (balanced, chart, open month, and the reversal's month), and
 * the journal is stored as a request — no entry. With nobody else to approve, it posts at once and Riwayat says so.
 */
export async function submitAdjustment(db: Db, input: { clientId: string; entityId: string; date: Date; memo: string; lines: AdjustmentLineInput[]; reverseNextMonth?: boolean; maker: Maker }): Promise<Outcome> {
  return submitPrepared(db, await prepareAdjustment(db, input), input);
}

/**
 * The route behind `submitAdjustment` for an adjustment already read: also *Catat* on a Jurnal berulang instalment (lib/adjust/recurring.ts),
 * whose `guard` runs first in whichever transaction posts it or stores its request, and whose `onPosted` runs after a post in it.
 */
export async function submitPrepared(
  db: Db,
  prepared: PreparedAdjustment,
  input: { clientId: string; maker: Maker; guard?: (tx: Tx) => Promise<void>; onPosted?: (tx: Tx, entryId: string) => Promise<void> },
): Promise<Outcome> {
  const settings = await readApprovals(db, await firmOf(db, input.clientId));
  const by = input.maker.id;
  const post = (fallback?: (tx: Tx, entryId: string) => Promise<void>) =>
    db.$transaction(async (tx) => {
      await input.guard?.(tx);
      const e = await postPreparedAdjustment(tx, prepared, by);
      await fallback?.(tx, e.id);
      await input.onPosted?.(tx, e.id);
      return e;
    });
  if (!settings.manual) return { posted: true, entryId: (await post()).id, fallback: false };
  const amount = sumDebit(prepared.lines);
  const route = routing(settings, "MANUAL", amount, prepared.entity.functionalCurrency);
  const h: Head = { source: "MANUAL", memo: prepared.memo, date: prepared.date, amount, currency: prepared.entity.functionalCurrency };
  if (!route.routed) return { posted: true, entryId: (await post()).id, fallback: false };
  if (!(await approverExists(db, input.clientId, input.maker))) {
    const entry = await post((tx, id) => recordFallback(tx, input.clientId, prepared.entity.id, h, id, by));
    return { posted: true, entryId: entry.id, fallback: true };
  }
  const a = await db.$transaction(async (tx) => {
    await closeLock(tx, input.clientId); // a lock of the month either sees this request or refuses it (period closed)
    await input.guard?.(tx);
    await checkPrepared(tx, prepared);
    return createRequest(tx, { ...h, clientId: input.clientId, entityId: prepared.entity.id, lines: stored(prepared.lines), threshold: route.threshold, maker: input.maker, reverseNextMonth: prepared.reverseNextMonth, recurring: prepared.recurring });
  });
  return { posted: false, approvalId: a.id };
}

/** postPreparedAdjustment's checks without the write: the journal, and with *Balik otomatis* its reversal on the 1st of the next month. */
async function checkPrepared(tx: Tx, a: PreparedAdjustment) {
  const lines = adjustmentPosting(a.lines);
  await checkJournal(tx, { entityId: a.entity.id, date: a.date, lines });
  if (!a.reverseNextMonth) return;
  const on = firstOfNextMonth(a.date);
  try {
    await checkJournal(tx, { entityId: a.entity.id, date: on, lines: mirrorLines(lines) });
  } catch (e) {
    if (e instanceof LedgerError) throw new LedgerError(`Jurnal pembalik ${formatDate(on)} tidak bisa dicatat: ${e.message}. Jurnalnya tidak disimpan.`);
    throw e;
  }
}

/**
 * *Setujui* on a *Usulan akrual* card (with *Ubah*'s edits) follows *Jurnal manual*'s route (cycle 2026-10-18-usulan-akrual, decisions
 * while integrating): the accountant's click is the maker's. Card off or at/below the threshold: posted at once, exactly as the accrual
 * writer does. Above it: the proposal is re-checked (undecided, payment still missing) with every check the post would make (the month and
 * the reversal's), and the journal is stored as a request with *Balik otomatis* naming the proposal (`accrualKey`) — no entry, and the
 * card leaves *Usulan akrual* while it waits. With nobody else to approve, it posts at once and Riwayat says so.
 */
export async function submitAccrual(db: Db, input: { firmId: string; clientId: string; key: string; edit?: AccrualEdit; maker: Maker; now?: Date }): Promise<Outcome> {
  const settings = await readApprovals(db, input.firmId);
  const by = input.maker.id;
  if (!settings.manual) return { posted: true, entryId: (await postAccrual(db, { ...input, actorId: by })).id, fallback: false };
  const { proposal, prepared } = await prepareAccrual(db, input);
  const amount = sumDebit(prepared.lines);
  const route = routing(settings, "MANUAL", amount, prepared.entity.functionalCurrency);
  const h: Head = { source: "MANUAL", memo: prepared.memo, date: prepared.date, amount, currency: prepared.entity.functionalCurrency };
  const direct = { firmId: input.firmId, clientId: input.clientId, proposal, prepared, actorId: by };
  if (!route.routed) return { posted: true, entryId: (await postPreparedAccrual(db, direct)).id, fallback: false };
  if (!(await approverExists(db, input.clientId, input.maker))) {
    const entry = await postPreparedAccrual(db, { ...direct, onPosted: (tx, e) => recordFallback(tx, input.clientId, prepared.entity.id, h, e.id, by) });
    return { posted: true, entryId: entry.id, fallback: true };
  }
  try {
    const a = await db.$transaction(
      async (tx) => {
        await closeLock(tx, input.clientId);
        await checkAccrualOpen(tx, proposal);
        await checkPrepared(tx, prepared);
        return createRequest(tx, { ...h, clientId: input.clientId, entityId: prepared.entity.id, lines: stored(prepared.lines), threshold: route.threshold, maker: input.maker, reverseNextMonth: true, accrualKey: proposal.key });
      },
      { isolationLevel: "Serializable", timeout: 60_000 },
    );
    return { posted: false, approvalId: a.id };
  } catch (e) {
    if (isUnique(e)) throw new LedgerError(ACCRUAL_PENDING); // a second request racing this one
    if ((e as { code?: string }).code === "P2034") throw new LedgerError("Buku sedang diubah bersamaan; coba catat lagi.");
    throw e;
  }
}

export const REVERSAL_PENDING = "Jurnal ini sudah menunggu persetujuan untuk dibalik. Putuskan di Kotak persetujuan.";

/** *Balik jurnal*: routed as *Jurnal manual* by the original's Σdebit. One waiting reversal per entry; while it waits, no other reversal. */
export async function submitReversal(db: Db, input: { clientId: string; entryId: string; date: Date; maker: Maker }): Promise<Outcome> {
  if (await db.journalApproval.findFirst({ where: { reversesId: input.entryId, status: "PENDING" }, select: { id: true } })) throw new LedgerError(REVERSAL_PENDING);
  const settings = await readApprovals(db, await firmOf(db, input.clientId));
  const direct = { clientId: input.clientId, entryId: input.entryId, date: input.date, actorId: input.maker.id };
  if (!settings.manual) return { posted: true, entryId: (await reverseEntry(db, direct)).id, fallback: false };
  const entry = await checkReversal(db, input);
  const { functionalCurrency: currency } = await db.entity.findUniqueOrThrow({ where: { id: entry.entityId }, select: { functionalCurrency: true } });
  const amount = sumDebit(entry.lines);
  const route = routing(settings, "REVERSAL", amount, currency);
  const h: Head = { source: "REVERSAL", memo: entry.memo, date: input.date, amount, currency };
  if (!route.routed) return { posted: true, entryId: (await reverseEntry(db, direct)).id, fallback: false };
  if (!(await approverExists(db, input.clientId, input.maker))) {
    const posted = await db.$transaction(async (tx) => {
      const e = await reverseEntryTx(tx, direct);
      await recordFallback(tx, input.clientId, entry.entityId, h, e.id, input.maker.id);
      return e;
    });
    return { posted: true, entryId: posted.id, fallback: true };
  }
  const mirrored = entry.lines.map((l) => ({ accountCode: l.account.code, debit: l.credit, credit: l.debit, memo: l.memo, departmentId: l.departmentId, projectId: l.projectId }));
  try {
    const a = await db.$transaction(async (tx) => {
      await closeLock(tx, input.clientId);
      await checkJournal(tx, { entityId: entry.entityId, date: input.date, lines: mirrorLines(entry.lines), reversesId: entry.id });
      return createRequest(tx, { ...h, clientId: input.clientId, entityId: entry.entityId, lines: stored(mirrored), threshold: route.threshold, maker: input.maker, reversesId: entry.id });
    });
    return { posted: false, approvalId: a.id };
  } catch (e) {
    if (isUnique(e)) throw new LedgerError(REVERSAL_PENDING); // a second request racing this one
    throw e;
  }
}

/** A draft with a waiting request is never posted or dismissed directly, whatever the card says now. */
const noPendingRequest = (proposalId: string) => async (tx: Db | Tx) => {
  if (await tx.journalApproval.findFirst({ where: { proposalId, status: "PENDING" }, select: { id: true } })) throw new LedgerError(PENDING_DRAFT);
};

/**
 * *Catat jurnal* on a *Jelaskan* draft (source AI_CONTROL; the 1999 corrections are deterministic and never routed). Above the *Draf AI*
 * threshold the accountant's click is the first approval: the chosen accounts are stored in a request and the draft stays PROPOSED, out
 * of *Draf jurnal*. Approval runs `postProposal` with those accounts, every re-check (freshness, grounding) included.
 */
export async function submitProposal(db: Db, input: { clientId: string; proposalId: string; accounts?: string[]; maker: Maker }): Promise<Outcome> {
  const p = await db.proposedEntry.findFirst({ where: { id: input.proposalId, clientId: input.clientId }, include: { entity: { select: { functionalCurrency: true } } } });
  if (!p) throw new LedgerError("Usulan tidak ditemukan.");
  const direct = { clientId: input.clientId, proposalId: p.id, accounts: input.accounts, actorId: input.maker.id, guard: noPendingRequest(p.id) };
  await direct.guard(db); // refused at once, and again inside the post's serializable transaction
  const settings = await readApprovals(db, p.firmId);
  if (!settings.aiDraft || p.source !== "AI_CONTROL" || p.status !== "PROPOSED") return { posted: true, entryId: (await postProposal(db, direct)).id, fallback: false };
  const lines = readLines(p.lines);
  const { codes, posting } = await chosenAccounts(db, input.clientId, lines, input.accounts);
  const amount = sumDebit(posting);
  const currency = p.entity.functionalCurrency;
  const route = routing(settings, "AI_DRAFT", amount, currency);
  const date = periodBounds(p.year, p.month).end;
  const h: Head = { source: "AI_DRAFT", memo: p.memo, date, amount, currency };
  if (!route.routed) return { posted: true, entryId: (await postProposal(db, direct)).id, fallback: false };
  if (!(await approverExists(db, input.clientId, input.maker))) {
    const entry = await postProposal(db, { ...direct, onPosted: (tx, e) => recordFallback(tx, input.clientId, p.entityId, h, e.id, input.maker.id) });
    return { posted: true, entryId: entry.id, fallback: true };
  }
  try {
    const a = await db.$transaction(async (tx) => {
      await closeLock(tx, input.clientId);
      await checkJournal(tx, { entityId: p.entityId, date, lines: posting });
      const lines2 = lines.map((l, i) => ({ accountCode: codes[i], debit: BigInt(l.debit), credit: BigInt(l.credit) }));
      return createRequest(tx, { ...h, clientId: input.clientId, entityId: p.entityId, lines: stored(lines2), threshold: route.threshold, maker: input.maker, proposalId: p.id, accounts: codes });
    });
    return { posted: false, approvalId: a.id };
  } catch (e) {
    if (isUnique(e)) throw new LedgerError(PENDING_DRAFT);
    throw e;
  }
}

const DECIDED: Record<"APPROVED" | "REJECTED" | "WITHDRAWN", string> = {
  APPROVED: "Jurnal ini sudah disetujui dan dicatat.",
  REJECTED: "Jurnal ini sudah ditolak.",
  WITHDRAWN: "Jurnal ini sudah ditarik kembali oleh pembuatnya.",
};

async function loadRequest(db: Db | Tx, clientId: string, approvalId: string) {
  const a = await db.journalApproval.findFirst({ where: { id: approvalId, clientId }, include: { entity: { select: { functionalCurrency: true } } } });
  if (!a) throw new ApprovalError("Permintaan persetujuan tidak ditemukan.");
  if (a.status !== "PENDING") throw new ApprovalError(DECIDED[a.status]);
  return a;
}
type Request = Awaited<ReturnType<typeof loadRequest>>;
const requestHead = (a: Request) => head({ source: a.source, memo: a.memo, date: a.date, amount: a.amount, currency: a.entity.functionalCurrency });

/** Locks the request row and reads it again on `tx`: a second click, or a reject racing this approval, finds it decided. */
async function claim(tx: Tx, clientId: string, approvalId: string) {
  await tx.$queryRaw`SELECT id FROM "JournalApproval" WHERE id = ${approvalId} FOR UPDATE`;
  return loadRequest(tx, clientId, approvalId);
}

/** Marks the claimed request approved with its entry, and writes the "disetujui" event, in the posting's transaction. */
async function markApproved(tx: Tx, a: Request, entryId: string, approverId: string) {
  const done = await tx.journalApproval.updateMany({ where: { id: a.id, status: "PENDING" }, data: { status: "APPROVED", entryId, decidedById: approverId, decidedAt: new Date() } });
  if (done.count !== 1) throw new ApprovalError("Jurnal ini sudah diputuskan.");
  const reversal = a.reverseNextMonth ? ` dengan jurnal pembalik ${formatDate(firstOfNextMonth(a.date))}` : "";
  await recordEvent(tx, { clientId: a.clientId, entityId: a.entityId, kind: "APPROVAL", subject: approvalSubject(a.id), summary: `${requestHead(a)} disetujui dan dicatat${reversal}`, before: { status: "PENDING" }, after: { status: "APPROVED", entryId }, actorId: approverId });
}

/** Stored lines (a request's, a Jurnal berulang template's) on the client's chart as it is now (an account removed meanwhile refuses). */
export async function storedPosting(db: Db | Tx, clientId: string, value: unknown): Promise<PreparedAdjustment["lines"]> {
  const lines = readStoredLines(value);
  const accounts = new Map((await db.account.findMany({ where: { clientId, code: { in: lines.map((l) => l.accountCode) } } })).map((x) => [x.code, x]));
  return lines.map((l) => {
    const acc = accounts.get(l.accountCode);
    if (!acc) throw new LedgerError(`Akun ${l.accountCode} tidak ada lagi di bagan akun klien.`);
    return { accountId: acc.id, accountCode: acc.code, debit: BigInt(l.debit), credit: BigInt(l.credit), memo: l.memo, departmentId: l.departmentId ?? null, projectId: l.projectId ?? null };
  });
}

/** A waiting request as the adjustment writer takes it (a Jurnal berulang instalment keeps its template and month). */
async function preparedOf(tx: Db | Tx, a: Request): Promise<PreparedAdjustment> {
  return {
    entity: { id: a.entityId, functionalCurrency: a.entity.functionalCurrency },
    date: a.date,
    memo: a.memo,
    reverseNextMonth: a.reverseNextMonth,
    lines: await storedPosting(tx, a.clientId, a.lines),
    ...(a.recurringId && a.recurringMonth ? { recurring: { id: a.recurringId, month: a.recurringMonth } } : {}),
  };
}

/**
 * *Setujui & catat*: another eligible member posts the request through the maker's own writer, every check made again now (open month,
 * the reversal's month, the chart, not already reversed, a draft's freshness and grounding). Posting and the status change are one
 * transaction; a refusal leaves the request PENDING and returns the writer's reason. The entry's `postedById` is the approver.
 */
export async function approveJournal(db: Db, input: { clientId: string; approvalId: string; approver: Maker; now?: Date }) {
  const first = await loadRequest(db, input.clientId, input.approvalId);
  const problem = approverProblem(input.approver, first);
  if (problem) throw new ApprovalError(problem);
  const by = input.approver.id;
  const claimed = async (tx: Tx) => {
    await closeLock(tx, input.clientId);
    await claim(tx, input.clientId, first.id);
  };
  if (first.accrualKey) {
    // A waiting *Usulan akrual*: the proposal read again now (still undecided, payment still missing, next month open), the stored
    // lines posted through the accrual writer with *Balik otomatis*, the decision stored POSTED and the request approved — one transaction.
    const proposal = await currentAccrual(db, input.clientId, first.accrualKey, input.now, true);
    if (proposal.blocked) throw new LedgerError(proposal.blocked);
    return postPreparedAccrual(db, { firmId: first.firmId, clientId: input.clientId, proposal, prepared: await preparedOf(db, first), actorId: by, guard: claimed, onPosted: (tx, entry) => markApproved(tx, first, entry.id, by) });
  }
  if (first.source === "AI_DRAFT") {
    return postProposal(db, {
      clientId: input.clientId,
      proposalId: first.proposalId!,
      accounts: first.accounts,
      actorId: by,
      guard: claimed,
      onPosted: (tx, entry) => markApproved(tx, first, entry.id, by),
    });
  }
  return db.$transaction(
    async (tx) => {
      await closeLock(tx, input.clientId); // a lock of the month waits for this approval, then counts it as decided
      const a = await claim(tx, input.clientId, first.id);
      const entry = a.source === "REVERSAL" ? await reverseEntryTx(tx, { clientId: a.clientId, entryId: a.reversesId!, date: a.date, actorId: by }) : await postPreparedAdjustment(tx, await preparedOf(tx, a), by);
      await markApproved(tx, a, entry.id, by);
      return entry;
    },
    { timeout: 60_000 },
  );
}

/** *Tolak*: the same members who may approve, with a reason (≥ 5 characters) shown to the maker. Nothing is posted. */
export async function rejectJournal(db: Db, input: { clientId: string; approvalId: string; approver: Maker; note: string }) {
  const note = input.note.replace(/\s+/g, " ").trim();
  if (note.length < NOTE_MIN) throw new ApprovalError(NOTE_MESSAGE);
  const a = await loadRequest(db, input.clientId, input.approvalId);
  const problem = approverProblem(input.approver, a);
  if (problem) throw new ApprovalError(problem);
  await decide(db, a, { status: "REJECTED", note, by: input.approver.id, summary: `${requestHead(a)} ditolak: ${note}` });
}

/** *Tarik kembali*: the maker only, while it waits. To change a waiting journal the maker withdraws it and enters it again. */
export async function withdrawJournal(db: Db, input: { clientId: string; approvalId: string; maker: Maker }) {
  const a = await loadRequest(db, input.clientId, input.approvalId);
  if (a.makerId !== input.maker.id) throw new ApprovalError("Hanya pembuatnya yang dapat menarik kembali jurnal ini.");
  await decide(db, a, { status: "WITHDRAWN", note: null, by: input.maker.id, summary: `${requestHead(a)} ditarik kembali` });
}

async function decide(db: Db, a: Request, d: { status: "REJECTED" | "WITHDRAWN"; note: string | null; by: string; summary: string }) {
  await db.$transaction(async (tx) => {
    // Conditional on still PENDING: an approval or another decision racing this one leaves it decided once.
    const done = await tx.journalApproval.updateMany({ where: { id: a.id, status: "PENDING" }, data: { status: d.status, note: d.note, decidedById: d.by, decidedAt: new Date() } });
    if (done.count !== 1) throw new ApprovalError("Jurnal ini sudah diputuskan.");
    await recordEvent(tx, { clientId: a.clientId, entityId: a.entityId, kind: "APPROVAL", subject: approvalSubject(a.id), summary: d.summary, before: { status: "PENDING" }, after: { status: d.status, note: d.note }, actorId: d.by });
  });
}
