import type { Db, Tx } from "@/lib/db";
import { LedgerError, postJournal } from "@/lib/ledger/post";
import { mirrorLines, reversalMemo } from "@/lib/ledger/reverse";
import { dateOnly, formatDate } from "@/lib/format";
import { parseMoney } from "@/lib/money";

export type AdjustmentLineInput = { accountCode: string; debit: string; credit: string; memo?: string };

/** The first day of the month after `date`: where an accrual's automatic reversal goes. */
export const firstOfNextMonth = (date: Date) => dateOnly(date.getUTCFullYear(), date.getUTCMonth() + 2, 1);

/**
 * A Jurnal Penyesuaian read and checked against the client's chart, not yet posted: amounts are minor units of the entity's currency, one
 * side of each line zero (the reversal mirrors it). Built by `prepareAdjustment` from the form, by an approved *Usulan akrual*
 * (lib/adjust/accruals.ts) from its proposal, and from a waiting request's stored lines (lib/approvals/journals.ts).
 */
export type PreparedAdjustment = {
  entity: { id: string; functionalCurrency: string };
  date: Date;
  memo: string;
  lines: { accountId: string; accountCode: string; debit: bigint; credit: bigint; memo?: string }[];
  reverseNextMonth: boolean;
};

/**
 * Reads a typed Jurnal Penyesuaian: the entity of the client, a memo, a date, and the lines in major units of the entity's functional
 * currency (read here, never taken from the client) turned into minor units (rule 6), each with its own note. Nothing is written.
 */
export async function prepareAdjustment(
  db: Db | Tx,
  input: { clientId: string; entityId: string; date: Date; memo: string; lines: AdjustmentLineInput[]; reverseNextMonth?: boolean },
): Promise<PreparedAdjustment> {
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
      return { accountId: a.id, accountCode: a.code, debit: parseMoney(l.debit, entity.functionalCurrency), credit: parseMoney(l.credit, entity.functionalCurrency), memo: note || undefined };
    });
  return { entity: { id: entity.id, functionalCurrency: entity.functionalCurrency }, date: input.date, memo, lines, reverseNextMonth: input.reverseNextMonth === true };
}

/** The lines as postJournal() takes them (the code only names the account for a stored request). */
export const adjustmentPosting = (lines: PreparedAdjustment["lines"]) => lines.map(({ accountId, debit, credit, memo }) => ({ accountId, debit, credit, memo }));

/**
 * The one writer behind Jurnal Penyesuaian, an approved *Usulan akrual* and the approval of a waiting journal (Persetujuan kedua): posts a
 * prepared adjustment on `tx` (the caller's transaction) as one ADJUSTMENT through postJournal(), and with `reverseNextMonth` (*Balik
 * otomatis*, an accrual) its reversal — every line mirrored, `reversesId` set, as *Balik jurnal* (rule 3a) — on the first day of the next
 * month; a closed next month refuses both.
 */
export async function postPreparedAdjustment(tx: Tx, a: PreparedAdjustment, actorId?: string | null) {
  const lines = adjustmentPosting(a.lines);
  const entry = await postJournal(tx, { entityId: a.entity.id, date: a.date, kind: "ADJUSTMENT", memo: a.memo, lines, actorId });
  if (a.reverseNextMonth) {
    const on = firstOfNextMonth(a.date);
    try {
      await postJournal(tx, { entityId: a.entity.id, date: on, kind: "ADJUSTMENT", memo: reversalMemo(entry), reversesId: entry.id, actorId, lines: mirrorLines(lines) });
    } catch (e) {
      if (e instanceof LedgerError) throw new LedgerError(`Jurnal pembalik ${formatDate(on)} tidak bisa dicatat: ${e.message}. Jurnalnya tidak disimpan.`);
      throw e;
    }
  }
  return entry;
}

/** Jurnal Penyesuaian: read, then posted in one transaction (with its *Balik otomatis* reversal). */
export async function postAdjustment(db: Db, input: { clientId: string; entityId: string; date: Date; memo: string; lines: AdjustmentLineInput[]; reverseNextMonth?: boolean; actorId?: string | null }) {
  const prepared = await prepareAdjustment(db, input);
  return db.$transaction((tx) => postPreparedAdjustment(tx, prepared, input.actorId));
}
