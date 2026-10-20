import type { Db, Tx } from "@/lib/db";
import { recordEvent } from "@/lib/audit";
import { formatDate, formatPeriod } from "@/lib/format";
import { LedgerError } from "@/lib/ledger/post";
import type { PreparedAdjustment } from "@/lib/ledger/adjustment";
import { closeLock } from "@/lib/adjust/schedules";
import { instalmentDate, monthKey, recurringDue, recurringSubject } from "@/lib/adjust/recurring";
import { storedPosting, submitPrepared, type Maker, type Outcome } from "@/lib/approvals/journals";

/**
 * Posting a Jurnal berulang instalment (lib/adjust/recurring.ts). Kept apart from the template and its due list, which the close controls
 * read: the route (lib/approvals/journals.ts) reaches back to them through the checklist.
 */

const isUnique = (e: unknown) => (e as { code?: string }).code === "P2002";

/**
 * *Catat* on one instalment: the template's lines dated that month's day, through Jurnal Penyesuaian's route — posted (with its reversal
 * on the 1st of the next month for *Balik otomatis*), or stored as a request above the *Jurnal manual* threshold. Refused when the month
 * is posted, waiting or not due, and when the template was stopped; under the close lock, so a double click or a second tab posts once.
 */
export async function postRecurring(db: Db, input: { clientId: string; recurringId: string; year: number; month: number; maker: Maker }): Promise<Outcome> {
  const t = await db.recurringJournal.findFirst({ where: { id: input.recurringId, clientId: input.clientId }, include: { entity: { select: { id: true, functionalCurrency: true } } } });
  if (!t) throw new LedgerError("Jurnal berulang tidak ditemukan.");
  const key = monthKey(input.year, input.month);
  const label = `${t.memo} ${formatPeriod(input.year, input.month)}`;
  const due = (await recurringDue(db, input.clientId, input.year, input.month, t.entityId)).find((d) => d.template.id === t.id && d.year === input.year && d.month === input.month);
  // Each refusal names why, read again under the lock below (the guard).
  const already = async (tx: Db | Tx) => {
    if (await tx.journalEntry.findFirst({ where: { recurringId: t.id, recurringMonth: key }, select: { id: true } })) throw new LedgerError(`${label} sudah dicatat.`);
    if (await tx.journalApproval.findFirst({ where: { recurringId: t.id, recurringMonth: key, status: "PENDING" }, select: { id: true } })) throw new LedgerError(`${label} sudah menunggu persetujuan. Putuskan di Kotak persetujuan.`);
  };
  await already(db);
  if (t.stoppedAt) throw new LedgerError("Jurnal berulang ini sudah dihentikan.");
  if (!due) throw new LedgerError(`${label} tidak jatuh tempo: di luar masa jurnal berulang ini, atau bulannya sudah ditutup.`);
  const date = instalmentDate(t, input.year, input.month);
  const prepared: PreparedAdjustment = {
    entity: { id: t.entityId, functionalCurrency: t.entity.functionalCurrency },
    date,
    memo: t.memo,
    lines: await storedPosting(db, input.clientId, t.lines),
    reverseNextMonth: t.reverseNextMonth,
    recurring: { id: t.id, month: key },
  };
  try {
    return await submitPrepared(db, prepared, {
      clientId: input.clientId,
      maker: input.maker,
      guard: async (tx) => {
        await closeLock(tx, input.clientId);
        // The template's row lock: a stop racing this click either commits first (and is seen here) or waits for this instalment.
        const [row] = await tx.$queryRaw<{ stoppedAt: Date | null }[]>`SELECT "stoppedAt" FROM "RecurringJournal" WHERE id = ${t.id} FOR UPDATE`;
        if (row?.stoppedAt) throw new LedgerError("Jurnal berulang ini sudah dihentikan.");
        await already(tx);
      },
      onPosted: async (tx, entryId) => {
        const e = await tx.journalEntry.findUniqueOrThrow({ where: { id: entryId }, select: { number: true } });
        await recordEvent(tx, { clientId: input.clientId, entityId: t.entityId, kind: "RECURRING", subject: recurringSubject(t.id), summary: `${label} dicatat${e.number ? ` sebagai ${e.number}` : ""} (${formatDate(date)})`, after: { month: key, entryId }, actorId: input.maker.id });
      },
    });
  } catch (e) {
    if (isUnique(e)) throw new LedgerError(`${label} sudah dicatat.`);
    throw e;
  }
}

/** *Catat semua* for the Jurnal berulang part: every due instalment not waiting, in order; stops at the first refusal (earlier ones stay). */
export async function postAllRecurring(db: Db, input: { clientId: string; year: number; month: number; entityId?: string; maker: Maker }) {
  let posted = 0;
  let asked = 0;
  for (const d of (await recurringDue(db, input.clientId, input.year, input.month, input.entityId)).filter((x) => !x.waitingId)) {
    const o = await postRecurring(db, { clientId: input.clientId, recurringId: d.template.id, year: d.year, month: d.month, maker: input.maker });
    if (o.posted) posted++;
    else asked++;
  }
  return { posted, asked };
}
