import type { Db, Tx } from "@/lib/db";
import { periodBounds } from "@/lib/format";

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
