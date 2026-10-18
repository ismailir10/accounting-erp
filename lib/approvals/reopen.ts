import type { Db, Tx } from "@/lib/db";
import type { MemberRole } from "@/lib/generated/prisma/enums";
import { recordEvent } from "@/lib/audit";
import { formatPeriod } from "@/lib/format";
import { closeLock } from "@/lib/adjust/schedules";
import { CloseError, reopenablePeriod, unlockPeriod, unlockPeriodTx, unlockReason } from "@/lib/controls";
import { readApprovals } from "@/lib/settings/approvals";
import { ApprovalError, hasSecondAdmin, NOTE_MESSAGE, NOTE_MIN, REOPEN_FALLBACK, reopenDeciderProblem, reopenSubject } from "@/lib/approvals/second";

/**
 * Persetujuan kedua for reopening a month (cycle 2026-10-18-persetujuan-kedua, accounting-rules 4). With *Buka kembali bulan* on, an
 * admin's *Minta buka kembali* stores a `ReopenRequest` and the month stays locked; another active Pemilik or Admin confirms it, which runs
 * the unlock (`unlockPeriodTx`: reverse order, sign-offs removed, the log with requester and confirmer) in the same transaction as the
 * decision. With the card off, reopening is exactly today's; with a single active admin it reopens at once and says so.
 */
type Actor = { id: string; role: MemberRole };
export type ReopenOutcome = { opened: true; fallback: boolean } | { opened: false; requestId: string };

const label = (r: { year: number; month: number }) => formatPeriod(r.year, r.month);

/** *Buka kembali periode* / *Minta buka kembali*: the same dialog and reason; what it does depends on the firm's card and its admins. */
export async function requestReopen(db: Db, input: { clientId: string; year: number; month: number; actor: Actor; reason: string }): Promise<ReopenOutcome> {
  const { clientId, year, month, actor } = input;
  const why = unlockReason(actor, input.reason);
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { firmId: true } });
  if (!(await readApprovals(db, client.firmId)).reopen) {
    await unlockPeriod(db, clientId, year, month, actor, why);
    return { opened: true, fallback: false };
  }
  const admins = await db.firmMember.findMany({ where: { firmId: client.firmId }, select: { id: true, role: true, disabled: true } });
  if (!hasSecondAdmin(admins, actor.id)) {
    await db.$transaction(async (tx) => {
      // The log says it too: Tutup Buku's "Riwayat buka kembali" reads the reason.
      await unlockPeriodTx(tx, clientId, year, month, actor, `${why} · ${REOPEN_FALLBACK}`);
      await recordEvent(tx, { clientId, kind: "APPROVAL", subject: `period:${year}-${month}`, summary: `${label(input)} dibuka kembali: "${why}" · ${REOPEN_FALLBACK}`, after: { status: "OPEN", reason: why, secondAdmin: null }, actorId: actor.id });
    });
    return { opened: true, fallback: true };
  }
  try {
    const r = await db.$transaction(async (tx) => {
      await closeLock(tx, clientId);
      await reopenablePeriod(tx, clientId, year, month); // closed, and no later month closed: the unlock's own checks
      const req = await tx.reopenRequest.create({ data: { firmId: client.firmId, clientId, year, month, reason: why, requestedById: actor.id } });
      await recordEvent(tx, { clientId, kind: "APPROVAL", subject: reopenSubject(req.id), summary: `Permintaan buka kembali ${label(input)}: "${why}"`, after: { status: "PENDING", reason: why }, actorId: actor.id });
      return req;
    });
    return { opened: false, requestId: r.id };
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new CloseError(`Sudah ada permintaan membuka kembali ${label(input)} yang menunggu konfirmasi.`);
    throw e;
  }
}

async function loadRequest(db: Db | Tx, clientId: string, requestId: string) {
  const r = await db.reopenRequest.findFirst({ where: { id: requestId, clientId }, include: { requestedBy: { select: { name: true } } } });
  if (!r) throw new ApprovalError("Permintaan buka kembali tidak ditemukan.");
  if (r.status !== "PENDING") throw new ApprovalError(r.status === "APPROVED" ? `${label(r)} sudah dibuka kembali.` : r.status === "REJECTED" ? "Permintaan ini sudah ditolak." : "Permintaan ini sudah dibatalkan.");
  return r;
}

/** *Konfirmasi buka kembali*: another active admin runs the unlock with the requester's reason; the log keeps both. */
export async function confirmReopen(db: Db, input: { clientId: string; requestId: string; actor: Actor }) {
  const first = await loadRequest(db, input.clientId, input.requestId);
  const problem = reopenDeciderProblem(input.actor, first);
  if (problem) throw new ApprovalError(problem);
  return db.$transaction(async (tx) => {
    await closeLock(tx, input.clientId);
    await tx.$queryRaw`SELECT id FROM "ReopenRequest" WHERE id = ${first.id} FOR UPDATE`;
    const r = await loadRequest(tx, input.clientId, first.id);
    const period = await unlockPeriodTx(tx, r.clientId, r.year, r.month, input.actor, r.reason, { requestedById: r.requestedById });
    await tx.reopenRequest.update({ where: { id: r.id }, data: { status: "APPROVED", decidedById: input.actor.id, decidedAt: new Date() } });
    await recordEvent(tx, { clientId: r.clientId, kind: "APPROVAL", subject: reopenSubject(r.id), summary: `Buka kembali ${label(r)} dikonfirmasi: "${r.reason}" (diminta ${r.requestedBy.name})`, before: { status: "PENDING" }, after: { status: "APPROVED" }, actorId: input.actor.id });
    return period;
  });
}

/** *Tolak*: another admin, with a reason (≥ 5 characters). The month stays closed. */
export async function rejectReopen(db: Db, input: { clientId: string; requestId: string; actor: Actor; note: string }) {
  const note = input.note.replace(/\s+/g, " ").trim();
  if (note.length < NOTE_MIN) throw new ApprovalError(NOTE_MESSAGE);
  const r = await loadRequest(db, input.clientId, input.requestId);
  const problem = reopenDeciderProblem(input.actor, r);
  if (problem) throw new ApprovalError(problem);
  await decide(db, r, { status: "REJECTED", note, by: input.actor.id, summary: `Permintaan buka kembali ${label(r)} ditolak: ${note}` });
}

/** *Batalkan permintaan*: the requester only. */
export async function cancelReopen(db: Db, input: { clientId: string; requestId: string; actor: Actor }) {
  const r = await loadRequest(db, input.clientId, input.requestId);
  if (r.requestedById !== input.actor.id) throw new ApprovalError("Hanya admin yang meminta yang dapat membatalkan permintaan ini.");
  await decide(db, r, { status: "WITHDRAWN", note: null, by: input.actor.id, summary: `Permintaan buka kembali ${label(r)} dibatalkan` });
}

async function decide(db: Db, r: { id: string; clientId: string }, d: { status: "REJECTED" | "WITHDRAWN"; note: string | null; by: string; summary: string }) {
  await db.$transaction(async (tx) => {
    const done = await tx.reopenRequest.updateMany({ where: { id: r.id, status: "PENDING" }, data: { status: d.status, note: d.note, decidedById: d.by, decidedAt: new Date() } });
    if (done.count !== 1) throw new ApprovalError("Permintaan ini sudah diputuskan.");
    await recordEvent(tx, { clientId: r.clientId, kind: "APPROVAL", subject: reopenSubject(r.id), summary: d.summary, before: { status: "PENDING" }, after: { status: d.status, note: d.note }, actorId: d.by });
  });
}

export type ReopenView = { id: string; year: number; month: number; label: string; reason: string; requestedById: string; requestedBy: string; at: Date };

/** Waiting reopen requests of a client, oldest first; `upTo` keeps those for months on or before it (Kotak's scope). */
export async function pendingReopens(db: Db, clientId: string, upTo?: { year: number; month: number }): Promise<ReopenView[]> {
  const rows = await db.reopenRequest.findMany({
    where: { clientId, status: "PENDING", ...(upTo ? { OR: [{ year: { lt: upTo.year } }, { year: upTo.year, month: { lte: upTo.month } }] } : {}) },
    include: { requestedBy: { select: { name: true } } },
    orderBy: [{ year: "asc" }, { month: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((r) => ({ id: r.id, year: r.year, month: r.month, label: label(r), reason: r.reason, requestedById: r.requestedById, requestedBy: r.requestedBy.name, at: r.createdAt }));
}
