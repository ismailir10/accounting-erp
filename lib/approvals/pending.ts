import type { Db, Tx } from "@/lib/db";
import { formatPeriod, periodBounds } from "@/lib/format";
import { recordEvent } from "@/lib/audit";

/**
 * Journals of a client waiting for a second approver (Persetujuan kedua) that would post into this month: dated in it, or a *Balik
 * otomatis* request of the month before whose reversal lands on its 1st. A month can't be locked while any waits (accounting-rules 23):
 * the request could then never post, and the maker's intent would be lost silently.
 */
export async function pendingJournalCount(db: Db | Tx, clientId: string, year: number, month: number) {
  const { start, end } = periodBounds(year, month);
  const before = periodBounds(month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1);
  return db.journalApproval.count({
    where: {
      clientId,
      status: "PENDING",
      OR: [{ date: { gte: start, lte: end } }, { reverseNextMonth: true, date: { gte: before.start, lte: before.end } }],
    },
  });
}

export const pendingLockMessage = (n: number) => `Belum bisa tutup buku: ${n} jurnal menunggu persetujuan kedua.`;

export const DIRECT_UNLOCK_NOTE = "dibuka langsung";

/**
 * A direct unlock (Persetujuan kedua's *Buka kembali bulan* off, or the one-admin fallback) closes a reopen request of that month still
 * waiting, as cancelled with "dibuka langsung", in the unlock's transaction: the month it asked to open is open.
 */
export async function closeReopenRequests(tx: Tx, clientId: string, year: number, month: number, actorId: string) {
  const open = await tx.reopenRequest.findMany({ where: { clientId, year, month, status: "PENDING" }, select: { id: true } });
  for (const r of open) {
    await tx.reopenRequest.update({ where: { id: r.id }, data: { status: "WITHDRAWN", note: DIRECT_UNLOCK_NOTE, decidedById: actorId, decidedAt: new Date() } });
    await recordEvent(tx, { clientId, kind: "APPROVAL", subject: `reopen:${r.id}`, summary: `Permintaan buka kembali ${formatPeriod(year, month)} ditutup: ${DIRECT_UNLOCK_NOTE}`, before: { status: "PENDING" }, after: { status: "WITHDRAWN", note: DIRECT_UNLOCK_NOTE }, actorId });
  }
}
