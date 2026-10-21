import type { Db, Tx } from "@/lib/db";
import type { Prisma, RecurringJournal } from "@/lib/generated/prisma/client";
import { recordEvent } from "@/lib/audit";
import { dateOnly, formatMonthShort, formatPeriod, periodBounds } from "@/lib/format";
import { LedgerError } from "@/lib/ledger/post";
import { firstOfNextMonth, storedTags } from "@/lib/ledger/adjustment";
import { closeLock } from "@/lib/adjust/schedules";
import type { StoredLine } from "@/lib/approvals/journals";

/**
 * Jurnal berulang (cycle 2026-10-21-jurnal-berulang): a Jurnal Penyesuaian repeated every month — the rent accrual, the BPJS share, a
 * management fee. *Ulangi tiap bulan* on a posted journal stores its company, memo, lines and *Balik otomatis* as a template from the next
 * month. Every month from the start to the end (or the stop) proposes its instalment until it is posted; nothing posts by itself
 * (accounting-rules 4). *Catat* goes through Jurnal Penyesuaian's own route (`submitPrepared`: above the *Jurnal manual* threshold it waits
 * for a second member), and an instalment is posted once per template and month (`JournalEntry.recurringId` + `recurringMonth`, unique).
 * A template's lines never change: a different journal is a new template.
 */

/** A month as one number: year × 100 + month (2026-08 → 202608). */
export const monthKey = (year: number, month: number) => year * 100 + month;
const fromKey = (key: number) => ({ year: Math.floor(key / 100), month: key % 100 });
const index = (year: number, month: number) => year * 12 + month - 1;
const fromIndex = (i: number) => ({ year: Math.floor(i / 12), month: (i % 12) + 1 });

/** The instalment's date in a month: the template's day, the month's last day for 0 or when the month is shorter. */
export function instalmentDate(t: Pick<RecurringJournal, "day">, year: number, month: number) {
  const last = periodBounds(year, month).end.getUTCDate();
  return dateOnly(year, month, t.day === 0 ? last : Math.min(t.day, last));
}

export const dayLabel = (day: number) => (day === 0 ? "akhir bulan" : `tanggal ${day}`);

export const recurringSubject = (id: string) => `recurring:${id}`;

/**
 * *Ulangi tiap bulan* on a posted Jurnal Penyesuaian of the client: the template starts the month after the journal's, dated the same
 * day (the last day when the journal was on its month's last), with the reversal when the journal was reversed on the 1st of the next
 * month (*Balik otomatis*). Not for a reversal, an instalment of a schedule or of another template, or a foreign-currency journal (its rate
 * is typed each time). `end` (optional) is the last month it proposes.
 */
export async function createRecurring(db: Db, input: { clientId: string; entryId: string; end?: { year: number; month: number } | null; actorId?: string | null }) {
  const entry = await db.journalEntry.findFirst({
    where: { id: input.entryId, entity: { clientId: input.clientId } },
    include: { entity: true, reversedBy: { select: { date: true } }, lines: { include: { account: true }, orderBy: { id: "asc" } } },
  });
  if (!entry) throw new LedgerError("Jurnal tidak ditemukan.");
  if (entry.kind !== "ADJUSTMENT") throw new LedgerError("Hanya jurnal penyesuaian yang bisa diulang tiap bulan.");
  if (entry.reversesId) throw new LedgerError("Jurnal pembalik tidak bisa diulang; ulangi jurnal aslinya dengan Balik otomatis.");
  if (entry.scheduleId) throw new LedgerError("Jurnal ini angsuran jadwal penyesuaian, yang sudah berulang sendiri.");
  if (entry.recurringId) throw new LedgerError("Jurnal ini sudah angsuran jurnal berulang.");
  if (entry.lines.some((l) => l.currency)) throw new LedgerError("Jurnal valas tidak bisa diulang: kursnya diisi lagi setiap bulan.");
  const day = entry.date.getUTCDate() === periodBounds(entry.date.getUTCFullYear(), entry.date.getUTCMonth() + 1).end.getUTCDate() ? 0 : entry.date.getUTCDate();
  const start = fromIndex(index(entry.date.getUTCFullYear(), entry.date.getUTCMonth() + 1) + 1);
  const end = input.end ?? null;
  if (end && (!(end.month >= 1 && end.month <= 12) || !Number.isInteger(end.year))) throw new LedgerError("Bulan terakhir tidak valid.");
  if (end && index(end.year, end.month) < index(start.year, start.month)) throw new LedgerError(`Bulan terakhir paling awal ${formatPeriod(start.year, start.month)}.`);
  const reverse = !!entry.reversedBy && +entry.reversedBy.date === +firstOfNextMonth(entry.date);
  // Debits first, as the form shows them; amounts in minor units as a stored request's.
  const lines: StoredLine[] = [...entry.lines]
    .sort((a, b) => Number(b.debit > 0n) - Number(a.debit > 0n))
    .map((l) => ({ accountCode: l.account.code, debit: l.debit.toString(), credit: l.credit.toString(), ...(l.memo ? { memo: l.memo } : {}), ...storedTags(l) }));
  return db.$transaction(async (tx) => {
    await closeLock(tx, input.clientId); // a close running now either sees the template or refuses (`recurringDueBy`)
    const running = await tx.recurringJournal.findFirst({ where: { sourceEntryId: entry.id, stoppedAt: null }, select: { id: true } });
    if (running) throw new LedgerError("Jurnal ini sudah diulang tiap bulan. Lihat Jurnal berulang di bawah.");
    const t = await tx.recurringJournal.create({
      data: {
        firmId: entry.firmId,
        clientId: input.clientId,
        entityId: entry.entityId,
        memo: entry.memo,
        lines: lines as Prisma.InputJsonValue,
        day,
        reverseNextMonth: reverse,
        startYear: start.year,
        startMonth: start.month,
        endYear: end?.year ?? null,
        endMonth: end?.month ?? null,
        sourceEntryId: entry.id,
        createdById: input.actorId ?? null,
      },
    });
    const until = end ? ` sampai ${formatPeriod(end.year, end.month)}` : "";
    await recordEvent(tx, {
      clientId: input.clientId,
      entityId: entry.entityId,
      kind: "RECURRING",
      subject: recurringSubject(t.id),
      summary: `Jurnal berulang dibuat dari ${entry.number ? `${entry.number} · ` : ""}${entry.memo}: ${dayLabel(day)}, mulai ${formatPeriod(start.year, start.month)}${until}${reverse ? ", dengan jurnal pembalik" : ""}`,
      after: { day, start: monthKey(start.year, start.month), end: end ? monthKey(end.year, end.month) : null, reverse, lines: lines as Prisma.InputJsonValue },
      actorId: input.actorId,
    });
    return t;
  });
}

export type RecurringDue = {
  template: RecurringJournal & { entity: { id: string; shortName: string; functionalCurrency: string } };
  year: number;
  month: number;
  date: Date;
  amount: bigint;
  /** A request of this instalment waiting for a second member (Persetujuan kedua): the month is asked, not due. */
  waitingId: string | null;
};

/**
 * Instalments of running templates in or before the month and not posted yet (an overdue one stays proposed until posted, as a schedule's
 * does), each with its waiting request if any. A month a close froze — itself or an earlier month of a later closed one — can't post
 * any more and is left out. A stopped template proposes nothing. Nothing is stored.
 */
export async function recurringDue(db: Db | Tx, clientId: string, year: number, month: number, entityId?: string): Promise<RecurringDue[]> {
  const templates = await db.recurringJournal.findMany({
    where: { clientId, stoppedAt: null, ...(entityId ? { entityId } : {}) },
    include: { entity: { select: { id: true, shortName: true, functionalCurrency: true } }, entries: { select: { recurringMonth: true } }, approvals: { where: { status: "PENDING" }, select: { id: true, recurringMonth: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (!templates.length) return [];
  const lastLocked = await db.period.findFirst({ where: { clientId, status: "LOCKED" }, orderBy: [{ year: "desc" }, { month: "desc" }], select: { year: true, month: true } });
  const after = lastLocked ? index(lastLocked.year, lastLocked.month) + 1 : -Infinity;
  const upTo = index(year, month);
  const out: RecurringDue[] = [];
  for (const t of templates) {
    const posted = new Set(t.entries.map((e) => e.recurringMonth));
    const waiting = new Map(t.approvals.map((a) => [a.recurringMonth, a.id]));
    const last = Math.min(upTo, t.endYear && t.endMonth ? index(t.endYear, t.endMonth) : upTo);
    const amount = (t.lines as StoredLine[]).reduce((s, l) => s + BigInt(l.debit), 0n);
    for (let i = Math.max(index(t.startYear, t.startMonth), after); i <= last; i++) {
      const m = fromIndex(i);
      const key = monthKey(m.year, m.month);
      if (posted.has(key)) continue;
      out.push({ template: t, year: m.year, month: m.month, date: instalmentDate(t, m.year, m.month), amount, waitingId: waiting.get(key) ?? null });
    }
  }
  return out;
}

/** Ids of templates with an instalment due by the month (asked ones included): a close compares them before and after its controls. */
export async function recurringDueBy(db: Db | Tx, clientId: string, year: number, month: number) {
  return [...new Set((await recurringDue(db, clientId, year, month)).map((d) => d.template.id))];
}

/** *Hentikan*: nothing is proposed from now on; what was posted stays, and a waiting request is still decided in Kotak persetujuan. */
export async function stopRecurring(db: Db, input: { clientId: string; recurringId: string; actorId?: string | null; at?: Date }) {
  const t = await db.recurringJournal.findFirst({ where: { id: input.recurringId, clientId: input.clientId } });
  if (!t) throw new LedgerError("Jurnal berulang tidak ditemukan.");
  if (t.stoppedAt) return t;
  const at = input.at ?? new Date();
  return db.$transaction(async (tx) => {
    // Conditional update: takes the row lock a posting click holds, so the two serialize (see postRecurring).
    const done = await tx.recurringJournal.updateMany({ where: { id: t.id, stoppedAt: null }, data: { stoppedAt: at } });
    if (done.count === 1) {
      await recordEvent(tx, { clientId: input.clientId, entityId: t.entityId, kind: "RECURRING", subject: recurringSubject(t.id), summary: `Jurnal berulang ${t.memo} dihentikan`, before: { stoppedAt: null }, after: { stoppedAt: at.toISOString() }, actorId: input.actorId });
    }
    return tx.recurringJournal.findUniqueOrThrow({ where: { id: t.id } });
  });
}

export type RecurringView = {
  id: string;
  memo: string;
  entity: string;
  currency: string;
  amount: string;
  lines: number;
  day: string;
  span: string;
  reverse: boolean;
  postedCount: number;
  lastPosted: string | null;
  status: "BERJALAN" | "SELESAI" | "DIHENTIKAN";
};

/** A client's templates for the *Jurnal berulang* list (plain JSON, bigint as strings): running first, then ended and stopped. */
export async function recurringViews(db: Db, clientId: string, now = new Date()): Promise<RecurringView[]> {
  const templates = await db.recurringJournal.findMany({
    where: { clientId },
    include: { entity: { select: { shortName: true, functionalCurrency: true } }, entries: { select: { recurringMonth: true } } },
    orderBy: [{ stoppedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }, { id: "asc" }],
  });
  const today = index(now.getUTCFullYear(), now.getUTCMonth() + 1);
  return templates.map((t) => {
    const lines = t.lines as StoredLine[];
    const months = t.entries.map((e) => e.recurringMonth!).sort((a, b) => b - a);
    const ended = t.endYear && t.endMonth ? index(t.endYear, t.endMonth) : null;
    const last = months[0] ? fromKey(months[0]) : null;
    const allPosted = ended !== null && ended < today && months.length >= ended - index(t.startYear, t.startMonth) + 1;
    return {
      id: t.id,
      memo: t.memo,
      entity: t.entity.shortName,
      currency: t.entity.functionalCurrency,
      amount: lines.reduce((s, l) => s + BigInt(l.debit), 0n).toString(),
      lines: lines.length,
      day: dayLabel(t.day),
      span: `${formatMonthShort(t.startYear, t.startMonth)} – ${t.endYear && t.endMonth ? formatMonthShort(t.endYear, t.endMonth) : "seterusnya"}`,
      reverse: t.reverseNextMonth,
      postedCount: months.length,
      lastPosted: last ? formatMonthShort(last.year, last.month) : null,
      status: t.stoppedAt ? "DIHENTIKAN" : allPosted ? "SELESAI" : "BERJALAN",
    };
  });
}

