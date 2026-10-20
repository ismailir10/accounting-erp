import type { Db } from "@/lib/db";
import { formatDate, formatMonthShort, formatPeriod, toIsoDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { dueProposals, installments, KIND_LABEL, listSchedules } from "@/lib/adjust/schedules";
import { scheduleCandidates } from "@/lib/adjust/candidates";
import type { ScheduleKind } from "@/lib/generated/prisma/enums";
import { monthKey, recurringDue } from "@/lib/adjust/recurring";
import type { StoredLine } from "@/lib/approvals/journals";

/** Plain JSON for the schedule components (bigint as strings, rule 6). */

/**
 * A due instalment: a schedule's (`scheduleId` + installment `k`) or, with `recurring`, a Jurnal berulang's (`scheduleId` is the template,
 * `k` its month as year × 100 + month); a recurring one names its first debit and credit account and how many more lines it has.
 */
export type ProposalView = { scheduleId: string; k: number; recurring: boolean; memo: string; entityId: string; entity: string; currency: string; debit: string; credit: string; amount: string; date: string };
export type CandidateView = { key: string; kind: ScheduleKind; kindLabel: string; entityId: string; entity: string; currency: string; reason: string; memo: string; debitCode: string | null; creditCode: string; amount: string; amountMinor: string; months: number; start: string; sourceEntryId: string | null };
export type ScheduleView = {
  id: string; kind: ScheduleKind; kindLabel: string; memo: string; entity: string; currency: string; debit: string; credit: string;
  amount: string; perMonth: string; months: number; postedCount: number; remaining: string; span: string; status: "BERJALAN" | "SELESAI" | "DIHENTIKAN"; source: string | null;
};

const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

const codes = (lines: StoredLine[], side: "debit" | "credit") => {
  const list = lines.filter((l) => l[side] !== "0").map((l) => l.accountCode);
  return list.length > 1 ? `${list[0]} +${list.length - 1}` : (list[0] ?? "");
};

/** Schedule instalments, then Jurnal berulang instalments not waiting for a second approver (one that waits is under Persetujuan kedua). */
export async function proposalViews(db: Db, clientId: string, year: number, month: number): Promise<ProposalView[]> {
  const recurring = (await recurringDue(db, clientId, year, month))
    .filter((d) => !d.waitingId)
    .map((d) => ({
      scheduleId: d.template.id,
      k: monthKey(d.year, d.month),
      recurring: true,
      memo: `${d.template.memo} (${formatPeriod(d.year, d.month)})`,
      entityId: d.template.entity.id,
      entity: d.template.entity.shortName,
      currency: d.template.entity.functionalCurrency,
      debit: codes(d.template.lines as StoredLine[], "debit"),
      credit: codes(d.template.lines as StoredLine[], "credit"),
      amount: d.amount.toString(),
      date: toIsoDate(d.date),
    }));
  const scheduled = (await dueProposals(db, clientId, year, month)).map((p) => ({
    scheduleId: p.schedule.id,
    k: p.installment.k,
    recurring: false,
    memo: p.memo,
    entityId: p.schedule.entity.id,
    entity: p.schedule.entity.shortName,
    currency: p.schedule.entity.functionalCurrency,
    debit: `${p.installment.reversal ? p.schedule.creditAccount.code : p.schedule.debitAccount.code}`,
    credit: `${p.installment.reversal ? p.schedule.debitAccount.code : p.schedule.creditAccount.code}`,
    amount: p.installment.amount.toString(),
    date: toIsoDate(p.installment.date),
  }));
  return [...scheduled, ...recurring];
}

export async function candidateViews(db: Db, clientId: string, year: number, month: number): Promise<CandidateView[]> {
  return (await scheduleCandidates(db, clientId, year, month)).map((c) => ({
    key: c.key,
    kind: c.kind,
    kindLabel: KIND_LABEL[c.kind],
    entityId: c.entity.id,
    entity: c.entity.shortName,
    currency: c.entity.functionalCurrency,
    reason: c.reason,
    memo: c.memo,
    debitCode: c.debitCode,
    creditCode: c.creditCode,
    amount: formatMoney(c.amount, c.entity.functionalCurrency, { bare: true }),
    amountMinor: c.amount.toString(),
    months: c.months,
    start: ym(c.startYear, c.startMonth),
    sourceEntryId: c.sourceEntryId,
  }));
}

export async function scheduleViews(db: Db, clientId: string): Promise<ScheduleView[]> {
  return (await listSchedules(db, clientId)).map((s) => {
    const first = installments(s)[0];
    return {
      id: s.id,
      kind: s.kind,
      kindLabel: KIND_LABEL[s.kind],
      memo: s.memo,
      entity: s.entity.shortName,
      currency: s.entity.functionalCurrency,
      debit: `${s.debitAccount.code} ${s.debitAccount.name}`,
      credit: `${s.creditAccount.code} ${s.creditAccount.name}`,
      amount: s.amount.toString(),
      perMonth: first.amount.toString(),
      months: s.months,
      postedCount: s.postedCount,
      remaining: s.remaining.toString(),
      span: s.months === 1 ? formatMonthShort(s.startYear, s.startMonth) : `${formatMonthShort(s.startYear, s.startMonth)} – ${formatMonthShort(s.ends.year, s.ends.month)}`,
      status: s.stoppedAt ? "DIHENTIKAN" : s.postedCount >= s.months ? "SELESAI" : "BERJALAN",
      source: s.sourceEntry ? `${(s.sourceEntry.bankTransaction?.description ?? s.sourceEntry.memo).replace(/^Reklasifikasi:\s*/i, "").slice(0, 60)} · ${formatDate(s.sourceEntry.date)}` : null,
    };
  });
}
