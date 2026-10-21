import type { Db, Tx } from "@/lib/db";
import { LedgerError } from "@/lib/ledger/post";
import { formatDate } from "@/lib/format";

/**
 * An entry typed by hand (Jurnal Penyesuaian, a sales invoice or purchase bill) dated on or before the entity's Saldo Awal would land
 * inside the balances Saldo Awal already holds: Saldo Laba already carries those months' result, so the books would count it twice and
 * the opening column of the Neraca would change. Refused, with the date to use. An entity without Saldo Awal (books from a ledger
 * import, or not started) has no such date.
 */
export async function assertAfterOpening(db: Db | Tx, entity: { id: string; shortName: string }, date: Date, hint = "") {
  const opening = await db.journalEntry.findFirst({ where: { entityId: entity.id, kind: "OPENING" }, orderBy: { date: "asc" }, select: { date: true } });
  if (opening && +date <= +opening.date) {
    throw new LedgerError(`Tanggal ${formatDate(date)} tidak bisa dipakai: saldo ${entity.shortName} sampai ${formatDate(opening.date)} sudah tercatat di Saldo Awal. Pilih tanggal sesudahnya${hint}.`);
  }
}
