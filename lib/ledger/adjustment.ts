import type { Db, Tx } from "@/lib/db";
import { LedgerError, postJournal } from "@/lib/ledger/post";
import { mirrorLines, reversalMemo } from "@/lib/ledger/reverse";
import { dateOnly, formatDate } from "@/lib/format";
import { parseMoney } from "@/lib/money";

export type AdjustmentLineInput = { accountCode: string; debit: string; credit: string; memo?: string };
/** A line in minor units, one side zero (the reversal mirrors it). */
export type AdjustmentLine = { accountId: string; debit: bigint; credit: bigint; memo?: string };

/** The first day of the month after `date`: where an accrual's automatic reversal goes. */
export const firstOfNextMonth = (date: Date) => dateOnly(date.getUTCFullYear(), date.getUTCMonth() + 2, 1);

/**
 * The writer behind Jurnal Penyesuaian and an approved *Usulan akrual*: one ADJUSTMENT through postJournal(), lines already in minor
 * units of the entity's functional currency. With `reverseNextMonth` (*Balik otomatis*, an accrual) its reversal — every line mirrored,
 * `reversesId` set, as *Balik jurnal* (rule 3a) — is posted in the same transaction on the first day of the next month; a closed next
 * month refuses both. Runs inside the caller's transaction.
 */
export async function postAdjustmentTx(tx: Tx, input: { entityId: string; date: Date; memo: string; lines: AdjustmentLine[]; reverseNextMonth?: boolean; actorId?: string | null }) {
  const entry = await postJournal(tx, { entityId: input.entityId, date: input.date, kind: "ADJUSTMENT", memo: input.memo, lines: input.lines, actorId: input.actorId });
  if (input.reverseNextMonth) {
    const on = firstOfNextMonth(input.date);
    try {
      await postJournal(tx, { entityId: input.entityId, date: on, kind: "ADJUSTMENT", memo: reversalMemo(entry), reversesId: entry.id, actorId: input.actorId, lines: mirrorLines(input.lines) });
    } catch (e) {
      if (e instanceof LedgerError) throw new LedgerError(`Jurnal pembalik ${formatDate(on)} tidak bisa dicatat: ${e.message}. Jurnalnya tidak disimpan.`);
      throw e;
    }
  }
  return entry;
}

/**
 * Jurnal Penyesuaian: one typed ADJUSTMENT entry. Amounts are typed in major units of the entity's functional currency (read here,
 * never taken from the client) and posted as minor units (rule 6). Each line may carry its own note. `reverseNextMonth`: see
 * `postAdjustmentTx`.
 */
export async function postAdjustment(db: Db, input: { clientId: string; entityId: string; date: Date; memo: string; lines: AdjustmentLineInput[]; reverseNextMonth?: boolean; actorId?: string | null }) {
  const entity = await db.entity.findFirst({ where: { id: input.entityId, clientId: input.clientId } });
  if (!entity) throw new LedgerError("Pilih entitas.");
  const memo = input.memo.trim();
  if (!memo) throw new LedgerError("Isi keterangan jurnal.");
  if (Number.isNaN(+input.date)) throw new LedgerError("Pilih tanggal jurnal.");
  const accounts = new Map((await db.account.findMany({ where: { clientId: input.clientId } })).map((a) => [a.code, a]));
  const lines = input.lines
    .filter((l) => l.accountCode)
    .map((l) => {
      const a = accounts.get(l.accountCode);
      if (!a) throw new LedgerError(`Akun ${l.accountCode} tidak ditemukan`);
      const note = l.memo?.replace(/\s+/g, " ").trim().slice(0, 200);
      return { accountId: a.id, debit: parseMoney(l.debit, entity.functionalCurrency), credit: parseMoney(l.credit, entity.functionalCurrency), memo: note || undefined };
    });
  return db.$transaction((tx) => postAdjustmentTx(tx, { entityId: entity.id, date: input.date, memo, lines, reverseNextMonth: input.reverseNextMonth, actorId: input.actorId }));
}
