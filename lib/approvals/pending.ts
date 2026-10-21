import type { Db, Tx } from "@/lib/db";
import { formatPeriod, periodBounds } from "@/lib/format";
import { recordEvent } from "@/lib/audit";

/**
 * Journals of a client waiting for a second approver (Persetujuan kedua) that would post into this month or before it: a lock freezes
 * every earlier month too (a journal dated before a closed month changes its Neraca), so a request dated in an empty earlier month — or a
 * *Balik otomatis* request whose reversal lands on this month's 1st — could never post after it. A month can't be locked while any waits
 * (accounting-rules 23): the maker's intent would be lost silently.
 */
export async function pendingJournalCount(db: Db | Tx, clientId: string, year: number, month: number) {
  const { end } = periodBounds(year, month);
  return db.journalApproval.count({ where: { clientId, status: "PENDING", date: { lte: end } } });
}

export const pendingLockMessage = (n: number) => `Belum bisa tutup buku: ${n} jurnal menunggu persetujuan kedua.`;

/**
 * Who asked and who approved the entries that came through a second approver: "Diajukan Andi · Disetujui Budi", per entry id. A *Balik
 * otomatis* reversal posted with its journal carries the same line (its `reversesId` is the approved entry). Entries without one are
 * absent: their `postedBy` says who posted them, as before.
 */
export async function approvalLines(db: Db | Tx, entries: { id: string; reversesId: string | null }[]): Promise<Map<string, string>> {
  if (!entries.length) return new Map();
  const reversed = entries.flatMap((e) => (e.reversesId ? [e.reversesId] : []));
  const rows = await db.journalApproval.findMany({
    where: { status: "APPROVED", OR: [{ entryId: { in: entries.map((e) => e.id) } }, ...(reversed.length ? [{ entryId: { in: reversed }, reverseNextMonth: true }] : [])] },
    select: { entryId: true, reverseNextMonth: true, maker: { select: { name: true } }, decidedBy: { select: { name: true } } },
  });
  const byEntry = new Map(rows.map((r) => [r.entryId!, r]));
  const out = new Map<string, string>();
  for (const e of entries) {
    const a = byEntry.get(e.id) ?? (e.reversesId ? byEntry.get(e.reversesId) : undefined);
    if (a && (byEntry.get(e.id) || a.reverseNextMonth)) out.set(e.id, `Diajukan ${a.maker.name} · Disetujui ${a.decidedBy?.name ?? "Sistem"}`);
  }
  return out;
}

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
