import type { MemberRole } from "@/lib/generated/prisma/enums";
import { can, isAdminRole, ROLE_LABEL } from "@/lib/auth/permissions";
import { dateOnly } from "@/lib/format";

/**
 * Checklist tutup buku: the pure rules (cycle 2026-10-17-checklist-tutup-buku) — months and due dates, who may hold, tick and review a
 * task, and a task's status. The DB layer (view.ts, write.ts) reads the facts and applies these; the refusals are shown verbatim.
 */
export class ChecklistError extends Error {}

/** OWNER > ADMIN > AKUNTAN; a VIEWER writes nothing and ranks below every writer. */
export const ROLE_RANK: Record<MemberRole, number> = { OWNER: 3, ADMIN: 2, AKUNTAN: 1, VIEWER: 0 };

/** A month as one comparable number, YYYYMM (the template's start and end months). */
export const periodNumber = (year: number, month: number) => year * 100 + month;
export const periodOf = (n: number) => ({ year: Math.floor(n / 100), month: n % 100 });
export const previousPeriod = (n: number) => (n % 100 === 1 ? n - 100 + 11 : n - 1);
export const nextPeriod = (n: number) => (n % 100 === 12 ? n + 100 - 11 : n + 1);

export const DUE_DAY_MAX = 28;
export const validDueDay = (d: number) => Number.isInteger(d) && d >= 1 && d <= DUE_DAY_MAX;

/** Due on `dueDay` (1–28) of the month after the period: tanggal 10 for Agustus 2026 is 10 September 2026; December runs into January. */
export function dueDate(year: number, month: number, dueDay: number): Date {
  const next = periodOf(nextPeriod(periodNumber(year, month)));
  return dateOnly(next.year, next.month, Math.min(Math.max(1, dueDay), DUE_DAY_MAX));
}

/** Today's calendar day in WIB (UTC+7), as a date-only value. Overdue is judged at render time against it. */
export function todayWib(now = new Date()): Date {
  const wib = new Date(now.getTime() + 7 * 3600_000);
  return dateOnly(wib.getUTCFullYear(), wib.getUTCMonth() + 1, wib.getUTCDate());
}

/** Days past the due date (0 on the due day itself): a task is late from the day after it is due. */
export const daysLate = (due: Date, today: Date) => Math.max(0, Math.round((+today - +due) / 86_400_000));

/** A member as the rules read them: role, active, and whether they can open this client (admins and company members always can). */
export type Person = { id: string; name: string; role: MemberRole; disabled: boolean; canOpen: boolean };
export type Role = "Pelaksana" | "Pereviu";

/** Why a member can't hold a task of this client, or null when they can: active, a writer, and able to open the client. */
export function holderProblem(m: Person | undefined, as: Role): string | null {
  if (!m) return `${as} tidak ditemukan di tim kantor ini.`;
  if (m.disabled) return `${m.name} sudah dinonaktifkan, jadi tidak dapat menjadi ${as}.`;
  if (!can(m.role, "books.write")) return `${m.name} berperan ${ROLE_LABEL[m.role]} (hanya melihat), jadi tidak dapat menjadi ${as}.`;
  if (!m.canOpen) return `${m.name} tidak memegang klien ini, jadi tidak dapat menjadi ${as}. Tugaskan kliennya dulu di Pengaturan → Tim.`;
  return null;
}

/** The Pereviu is another person whose role ranks at least the Pelaksana's (AKUNTAN → AKUNTAN/ADMIN/OWNER, ADMIN → ADMIN/OWNER). */
export function pairProblem(assignee: Pick<Person, "id" | "role">, reviewer: Pick<Person, "id" | "role" | "name"> | null): string | null {
  if (!reviewer) return null;
  if (reviewer.id === assignee.id) return "Pereviu harus orang lain, bukan Pelaksana tugas ini.";
  if (ROLE_RANK[reviewer.role] < ROLE_RANK[assignee.role]) {
    return `${reviewer.name} berperan ${ROLE_LABEL[reviewer.role]}, lebih rendah dari Pelaksana (${ROLE_LABEL[assignee.role]}). Pereviu harus berperan setara atau lebih tinggi.`;
  }
  return null;
}

/** An assignment as a whole: both holders valid and the pair rule. The first problem, or null. */
export function assignmentProblem(assignee: Person | undefined, reviewer: Person | undefined | null): string | null {
  return holderProblem(assignee, "Pelaksana") ?? (reviewer === null ? null : holderProblem(reviewer, "Pereviu")) ?? pairProblem(assignee!, reviewer ?? null);
}

type Actor = { id: string; role: MemberRole };

/** Selesai (tick or untick): the task's Pelaksana, or an OWNER/ADMIN covering for them. */
export function tickProblem(actor: Actor, task: { assigneeId: string }): string | null {
  if (actor.id === task.assigneeId || isAdminRole(actor.role)) return null;
  return "Hanya Pelaksana tugas ini atau admin kantor yang dapat mengubah status selesainya.";
}

/**
 * Direviu (mark or undo): the task's Pereviu, or an OWNER/ADMIN whose role ranks at least the Pelaksana's — never the member who ticked
 * Selesai, not even an admin. Without a Pereviu there is no review step.
 */
export function reviewProblem(actor: Actor, task: { reviewerId: string | null; assigneeRole: MemberRole }, doneById: string | null): string | null {
  if (!task.reviewerId) return "Tugas ini tidak memiliki Pereviu, jadi tidak perlu direviu.";
  if (doneById && actor.id === doneById) return "Anda yang menandai tugas ini selesai, jadi tidak dapat mereviunya sendiri.";
  if (actor.id === task.reviewerId) return null;
  if (isAdminRole(actor.role) && ROLE_RANK[actor.role] >= ROLE_RANK[task.assigneeRole]) return null;
  return "Hanya Pereviu tugas ini, atau admin kantor yang berperan setara atau lebih tinggi dari Pelaksana, yang dapat mereviunya.";
}

export type Stamp = { at: Date; byId: string | null; by: string };
export type TaskStatus = "BELUM" | "SELESAI" | "DIREVIU";
export const STATUS_LABEL: Record<TaskStatus, string> = { BELUM: "Belum", SELESAI: "Selesai", DIREVIU: "Direviu" };

/** A review counts only while the task is Selesai and the review is later than the tick: untick + retick (or a reopened month) asks again. */
export const reviewCounts = (done: Stamp | null, review: Stamp | null) => Boolean(done && review && +review.at > +done.at);

/**
 * A human task's status and whether it is finished: Direviu with a Pereviu, Selesai without one. Waits on the Pelaksana before Selesai,
 * on the Pereviu after.
 */
export function humanStatus(done: Stamp | null, review: Stamp | null, hasReviewer: boolean) {
  const reviewed = reviewCounts(done, review);
  const status: TaskStatus = !done ? "BELUM" : reviewed ? "DIREVIU" : "SELESAI";
  const finished = Boolean(done) && (reviewed || !hasReviewer);
  const waitsOn: Role | null = finished ? null : !done ? "Pelaksana" : "Pereviu";
  return { status, finished, waitsOn, reviewed };
}
