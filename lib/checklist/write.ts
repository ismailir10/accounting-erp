import type { Db, Tx } from "@/lib/db";
import type { MemberRole } from "@/lib/generated/prisma/enums";
import type { Prisma } from "@/lib/generated/prisma/client";
import { capabilityRefusal, isAdminRole } from "@/lib/auth/permissions";
import { CLOSE_SIGNOFFS } from "@/lib/controls";
import { recordEvent } from "@/lib/audit";
import { formatPeriod } from "@/lib/format";
import { autoKind, isAutoKey } from "@/lib/checklist/proofs";
import { activeIn, addableAutoKinds, clientPeople, holderNotes, loadTasks, proposeChecklist, type TemplateTask } from "@/lib/checklist/view";
import { assignmentProblem, ChecklistError, humanStatus, periodNumber, previousPeriod, reviewProblem, tickProblem, validDueDay, type Stamp } from "@/lib/checklist/rules";

/**
 * Checklist tutup buku, the write side (cycle 2026-10-17-checklist-tutup-buku). The caller has passed `requireCapability` (books.write,
 * or checklist.manage for the template); these functions enforce what depends on the task and the people on it, and write one
 * `CHECKLIST` event to Riwayat perubahan with every change, in the same transaction. Ticks write no journal: no report number moves.
 */
export type ChecklistActor = { id: string; role: MemberRole };
type Month = { clientId: string; year: number; month: number };

export const LOCKED_SIGNOFF = "Periode sudah ditutup. Buka kembali dulu untuk mengubah.";
const TITLE_MAX = 200;

/** The month on screen, as the URL gave it (a server action takes anything). */
function mustMonth(m: Month) {
  if (![m.year, m.month].every(Number.isInteger) || m.year < 1900 || m.year > 2199 || m.month < 1 || m.month > 12) throw new ChecklistError("Periode tidak valid. Muat ulang halaman.");
}

function mustManage(actor: ChecklistActor) {
  if (!isAdminRole(actor.role)) throw new ChecklistError(capabilityRefusal("checklist.manage"));
}

/** Template changes apply from the month on screen, which must be open. */
async function mustBeOpen(tx: Tx, m: Month) {
  const p = await tx.period.findUnique({ where: { clientId_year_month: { clientId: m.clientId, year: m.year, month: m.month } }, select: { status: true } });
  if (p?.status === "LOCKED") throw new ChecklistError(`Buku ${formatPeriod(m.year, m.month)} sudah ditutup. Ubah checklist dari bulan yang masih terbuka.`);
}

function cleanTitle(title: string | undefined) {
  const t = (title ?? "").trim().replace(/\s+/g, " ");
  if (!t) throw new ChecklistError("Tulis nama tugasnya.");
  if (t.length > TITLE_MAX) throw new ChecklistError(`Nama tugas paling panjang ${TITLE_MAX} karakter.`);
  return t;
}

function mustDueDay(d: number) {
  if (!validDueDay(d)) throw new ChecklistError("Tanggal tenggat harus 1–28 (di bulan setelah periode).");
}

/** Pelaksana and Pereviu as the rules read them now: active writers who can open the client, Pereviu another person ranked ≥ Pelaksana. */
async function checkAssignment(tx: Tx, clientId: string, assigneeId: string, reviewerId: string | null) {
  const people = await clientPeople(tx, clientId);
  const problem = assignmentProblem(people.get(assigneeId), reviewerId === null ? null : people.get(reviewerId));
  if (problem) throw new ChecklistError(problem);
  return people;
}

const event = (tx: Tx, clientId: string, actorId: string, subject: string, summary: string, before?: Prisma.InputJsonValue, after?: Prisma.InputJsonValue) =>
  recordEvent(tx, { clientId, kind: "CHECKLIST", subject, summary, before, after, actorId });

const nameOf = (people: Map<string, { name: string }>, id: string | null) => (id ? (people.get(id)?.name ?? "?") : "tidak ada");

async function taskFor(tx: Tx, m: Month, taskId: string): Promise<TemplateTask> {
  // The client was resolved for this member by the guard; a task of another client (or organisation) reads as not found.
  const task = (await loadTasks(tx, m.clientId)).find((t) => t.id === taskId);
  if (!task) throw new ChecklistError("Tugas tidak ditemukan.");
  if (!activeIn(task, periodNumber(m.year, m.month))) throw new ChecklistError(`Tugas ini tidak berlaku untuk ${formatPeriod(m.year, m.month)}.`);
  return task;
}

/** *Pakai daftar ini*: the default list, from the month on screen, with one Pelaksana and an optional Pereviu for every task. */
export async function acceptDefault(db: Db, actor: ChecklistActor, input: Month & { assigneeId: string; reviewerId: string | null }) {
  mustMonth(input);
  mustManage(actor);
  const lines = await proposeChecklist(db, input.clientId, input.year, input.month);
  return db.$transaction(async (tx) => {
    if (await tx.checklistTask.count({ where: { clientId: input.clientId } })) throw new ChecklistError("Checklist klien ini sudah ada. Ubah tugasnya lewat Atur checklist.");
    await mustBeOpen(tx, input);
    const people = await checkAssignment(tx, input.clientId, input.assigneeId, input.reviewerId);
    const { firmId } = await tx.client.findUniqueOrThrow({ where: { id: input.clientId }, select: { firmId: true } });
    const startPeriod = periodNumber(input.year, input.month);
    await tx.checklistTask.createMany({
      data: lines.map((l, position) => ({
        firmId, clientId: input.clientId, kind: l.kind, key: l.key, title: l.title, position, dueDay: l.dueDay, startPeriod,
        assigneeId: input.assigneeId, reviewerId: l.kind === "AUTO" ? null : input.reviewerId,
      })),
    });
    const label = formatPeriod(input.year, input.month);
    await event(tx, input.clientId, actor.id, "checklist:template",
      `Checklist dipakai mulai ${label}: ${lines.length} tugas · Pelaksana ${nameOf(people, input.assigneeId)} · Pereviu ${nameOf(people, input.reviewerId)}`,
      undefined, { startPeriod, assignee: nameOf(people, input.assigneeId), reviewer: nameOf(people, input.reviewerId), tasks: lines.map((l) => l.title) });
    return lines.length;
  });
}

export type NewTask = { kind: "MANUAL" | "AUTO"; key?: string; title?: string; assigneeId: string; reviewerId: string | null; dueDay: number };

/**
 * *Tambah tugas* (any writer: a Manual task with themselves as Pelaksana; an admin: for anyone) and *Tambah tugas otomatis* (admin: a
 * kind not in the month's list). It applies from the month on screen.
 */
export async function addTask(db: Db, actor: ChecklistActor, input: Month & NewTask) {
  mustMonth(input);
  if (input.kind === "AUTO") mustManage(actor);
  else if (!isAdminRole(actor.role) && input.assigneeId !== actor.id) throw new ChecklistError("Tugas yang Anda tambahkan dikerjakan oleh Anda sendiri sebagai Pelaksana. Admin kantor dapat menugaskan orang lain.");
  mustDueDay(input.dueDay);
  const p = periodNumber(input.year, input.month);
  return db.$transaction(async (tx) => {
    const tasks = await loadTasks(tx, input.clientId);
    if (!tasks.length) throw new ChecklistError("Checklist klien ini belum diatur. Admin kantor memakai daftar usulan Buku dulu.");
    await mustBeOpen(tx, input);
    let key: string | null = null;
    let title: string;
    if (input.kind === "AUTO") {
      const addable = addableAutoKinds(tasks.filter((t) => activeIn(t, p)));
      if (!input.key || !isAutoKey(input.key)) throw new ChecklistError("Pilih jenis tugas otomatis.");
      if (!addable.some((k) => k.key === input.key)) throw new ChecklistError("Tugas otomatis ini sudah ada di checklist bulan ini.");
      key = input.key;
      title = input.title?.trim() ? cleanTitle(input.title) : autoKind(input.key).title;
    } else title = cleanTitle(input.title);
    const reviewerId = input.kind === "AUTO" ? null : input.reviewerId;
    const people = await checkAssignment(tx, input.clientId, input.assigneeId, reviewerId);
    const { firmId } = await tx.client.findUniqueOrThrow({ where: { id: input.clientId }, select: { firmId: true } });
    const task = await tx.checklistTask.create({
      data: { firmId, clientId: input.clientId, kind: input.kind, key, title, position: Math.max(...tasks.map((t) => t.position)) + 1, dueDay: input.dueDay, startPeriod: p, assigneeId: input.assigneeId, reviewerId },
    });
    const after = { title, kind: input.kind, assignee: nameOf(people, input.assigneeId), reviewer: nameOf(people, reviewerId), dueDay: input.dueDay, startPeriod: p };
    await event(tx, input.clientId, actor.id, `checklist:${task.id}`, `Tugas ditambahkan mulai ${formatPeriod(input.year, input.month)}: ${title} · Pelaksana ${after.assignee} · Pereviu ${after.reviewer} · tanggal ${input.dueDay}`, undefined, after);
    return task;
  });
}

export type TaskEdit = { title: string; assigneeId: string; reviewerId: string | null; dueDay: number };

/** Rename, reassign or move the due day (admin). Shows in every month the task covers; the marks keep who actually ticked. */
export async function updateTask(db: Db, actor: ChecklistActor, input: Month & { taskId: string } & TaskEdit) {
  mustMonth(input);
  mustManage(actor);
  mustDueDay(input.dueDay);
  const title = cleanTitle(input.title);
  return db.$transaction(async (tx) => {
    await mustBeOpen(tx, input);
    const task = await taskFor(tx, input, input.taskId);
    const reviewerId = task.kind === "AUTO" ? null : input.reviewerId;
    const people = await checkAssignment(tx, input.clientId, input.assigneeId, reviewerId);
    const before = { title: task.title, assignee: task.assignee.name, reviewer: task.reviewer?.name ?? "tidak ada", dueDay: task.dueDay };
    const after = { title, assignee: nameOf(people, input.assigneeId), reviewer: nameOf(people, reviewerId), dueDay: input.dueDay };
    const changes = [
      title !== task.title ? `Nama "${task.title}" → "${title}"` : "",
      input.assigneeId !== task.assigneeId ? `Pelaksana ${before.assignee} → ${after.assignee}` : "",
      reviewerId !== task.reviewerId ? `Pereviu ${before.reviewer} → ${after.reviewer}` : "",
      input.dueDay !== task.dueDay ? `Tenggat tanggal ${task.dueDay} → ${input.dueDay}` : "",
    ].filter(Boolean);
    if (!changes.length) return task;
    const updated = await tx.checklistTask.update({ where: { id: task.id }, data: { title, assigneeId: input.assigneeId, reviewerId, dueDay: input.dueDay } });
    await event(tx, input.clientId, actor.id, `checklist:${task.id}`, `${task.title}: ${changes.join("; ")}`, before, after);
    return updated;
  });
}

/**
 * *Hapus dari checklist* (admin): the task ends before the month on screen, and earlier months keep it with their marks. A task that never
 * applied to a month before this one is deleted with its marks; Riwayat keeps the trail either way.
 */
export async function removeTask(db: Db, actor: ChecklistActor, input: Month & { taskId: string }) {
  mustMonth(input);
  mustManage(actor);
  return db.$transaction(async (tx) => {
    await mustBeOpen(tx, input);
    const task = await taskFor(tx, input, input.taskId);
    const p = periodNumber(input.year, input.month);
    const label = formatPeriod(input.year, input.month);
    if (task.startPeriod >= p) await tx.checklistTask.delete({ where: { id: task.id } });
    else {
      await tx.checklistMark.deleteMany({ where: { taskId: task.id, OR: [{ year: { gt: input.year } }, { year: input.year, month: { gte: input.month } }] } });
      await tx.checklistTask.update({ where: { id: task.id }, data: { endPeriod: previousPeriod(p) } });
    }
    await event(tx, input.clientId, actor.id, `checklist:${task.id}`,
      task.startPeriod >= p ? `Tugas dihapus: ${task.title} (belum pernah berlaku sebelum ${label})` : `Tugas dihapus mulai ${label}: ${task.title}; bulan sebelumnya tetap menyimpannya`,
      { title: task.title, startPeriod: task.startPeriod, endPeriod: task.endPeriod }, { endPeriod: task.startPeriod >= p ? null : previousPeriod(p), deleted: task.startPeriod >= p });
  });
}

export type MarkStep = "done" | "review";

/** The task's tick and review for the month, as the rules read them (a SIGNOFF's tick is the CloseSignoff row). */
async function marksOf(tx: Tx, task: TemplateTask, m: Month) {
  const [mark, period] = await Promise.all([
    tx.checklistMark.findUnique({ where: { taskId_year_month: { taskId: task.id, year: m.year, month: m.month } } }),
    tx.period.findUnique({ where: { clientId_year_month: { clientId: m.clientId, year: m.year, month: m.month } }, include: { signoffs: true } }),
  ]);
  const signoff = task.kind === "SIGNOFF" ? period?.signoffs.find((s) => s.key === task.key) : undefined;
  const done: Stamp | null = task.kind === "SIGNOFF" ? (signoff ? { at: signoff.doneAt, byId: signoff.doneById, by: "" } : null) : mark?.doneAt ? { at: mark.doneAt, byId: mark.doneById, by: "" } : null;
  const review: Stamp | null = mark?.reviewedAt ? { at: mark.reviewedAt, byId: mark.reviewedById, by: "" } : null;
  return { mark, period, done, state: humanStatus(done, review, Boolean(task.reviewerId)) };
}

type MarkRow = { id: string; doneAt: Date | null; reviewedAt: Date | null };
/** Clears the tick and/or the review of a mark; a mark left with neither is deleted (marks are sparse, and a CHECK refuses an empty row). */
async function clearMark(tx: Tx, mark: MarkRow, parts: { done?: boolean; review?: boolean }) {
  const keeps = (!parts.done && mark.doneAt) || (!parts.review && mark.reviewedAt);
  if (!keeps) return tx.checklistMark.delete({ where: { id: mark.id } });
  return tx.checklistMark.update({ where: { id: mark.id }, data: { ...(parts.done ? { doneAt: null, doneById: null } : {}), ...(parts.review ? { reviewedAt: null, reviewedById: null } : {}) } });
}

/**
 * Selesai or Direviu on, or off, for one human task in one month.
 * - Selesai: the Pelaksana, or an admin covering; untick only while not Direviu. A Pemeriksaan akhir can't change in a closed month.
 * - Direviu: the Pereviu, or an admin ranked ≥ the Pelaksana; never whoever ticked Selesai; only after Selesai.
 * Manual ticks and every review stay open after the lock: they are not book writes.
 */
export async function markTask(db: Db, actor: ChecklistActor, input: Month & { taskId: string; step: MarkStep; value: boolean }) {
  mustMonth(input);
  if (input.step !== "done" && input.step !== "review") throw new ChecklistError("Langkah tidak dikenal.");
  return db.$transaction(async (tx) => {
    const task = await taskFor(tx, input, input.taskId);
    if (task.kind === "AUTO") throw new ChecklistError("Tugas otomatis dicentang oleh Buku dari data buku, tidak dengan tangan.");
    return applyMark(tx, actor, task, input);
  });
}

async function applyMark(tx: Tx, actor: ChecklistActor, task: TemplateTask, input: Month & { step: MarkStep; value: boolean }) {
  const { mark, period, done, state } = await marksOf(tx, task, input);
  const people = await clientPeople(tx, input.clientId);
  const label = formatPeriod(input.year, input.month);
  const subject = `checklist:${task.id}`;
  const now = new Date();
  const { firmId } = await tx.client.findUniqueOrThrow({ where: { id: input.clientId }, select: { firmId: true } });
  const note = (from: string, to: string) => event(tx, input.clientId, actor.id, subject, `${task.title} · ${label}: ${from} → ${to}`, { status: from, period: label }, { status: to, period: label });

  if (input.step === "done") {
    const problem = tickProblem(actor, task);
    if (problem) throw new ChecklistError(problem);
    if (task.kind === "SIGNOFF" && period?.status === "LOCKED") throw new ChecklistError(LOCKED_SIGNOFF);
    if (input.value) {
      if (done) return;
      const holder = holderNotes(task, people).assignee;
      if (holder) throw new ChecklistError(holder);
      if (task.kind === "SIGNOFF") {
        const p = period ?? (await tx.period.create({ data: { firmId, clientId: input.clientId, year: input.year, month: input.month } }));
        await tx.closeSignoff.create({ data: { periodId: p.id, key: task.key!, doneById: actor.id, doneAt: now } });
        // A review given before this tick (a reopened month) no longer counts; clear it so the row reads as waiting.
        if (mark) await clearMark(tx, mark, { review: true });
      } else {
        await tx.checklistMark.upsert({
          where: { taskId_year_month: { taskId: task.id, year: input.year, month: input.month } },
          create: { firmId, taskId: task.id, kind: task.kind, year: input.year, month: input.month, doneAt: now, doneById: actor.id },
          update: { doneAt: now, doneById: actor.id, reviewedAt: null, reviewedById: null },
        });
      }
      return note("Belum", "Selesai");
    }
    if (!done) return;
    if (state.reviewed) throw new ChecklistError("Tugas ini sudah direviu. Batalkan reviunya dulu sebelum membatalkan selesai.");
    if (task.kind === "SIGNOFF") await tx.closeSignoff.deleteMany({ where: { periodId: period!.id, key: task.key! } });
    if (mark) await clearMark(tx, mark, { done: true, review: true });
    return note("Selesai", "Belum");
  }

  // Direviu
  if (!done) throw new ChecklistError("Tandai tugas ini selesai dulu sebelum direviu.");
  const assignee = people.get(task.assigneeId);
  const problem = reviewProblem(actor, { reviewerId: task.reviewerId, assigneeRole: assignee?.role ?? task.assignee.role }, done.byId);
  if (problem) throw new ChecklistError(problem);
  if (input.value) {
    if (state.reviewed) return;
    const holder = holderNotes(task, people).reviewer;
    if (holder) throw new ChecklistError(holder);
    // Later than the tick by construction, so the review counts even when both land in the same millisecond.
    const at = new Date(Math.max(+now, +done.at + 1));
    // Not an upsert: Postgres checks the insert row's CHECKs before ON CONFLICT, and a Manual review row without its tick fails them.
    if (mark) await tx.checklistMark.update({ where: { id: mark.id }, data: { reviewedAt: at, reviewedById: actor.id } });
    else await tx.checklistMark.create({ data: { firmId, taskId: task.id, kind: task.kind, year: input.year, month: input.month, reviewedAt: at, reviewedById: actor.id } });
    return note("Selesai", "Direviu");
  }
  if (!state.reviewed || !mark) return;
  await clearMark(tx, mark, { review: true });
  return note("Direviu", "Selesai");
}

/**
 * A Pemeriksaan akhir ticked from either page (Tutup Buku's *Daftar periksa* or the checklist): the one writer of `CloseSignoff`. With the
 * sign-off's task in the month's checklist it follows the task's rules; without one, any writer ticks as before. Either way the tick is
 * logged in Riwayat. A closed month refuses both (the lock rule itself, accounting-rules 23, is unchanged).
 */
export async function setSignoff(db: Db, actor: ChecklistActor, input: Month & { key: string; done: boolean }) {
  mustMonth(input);
  const signoff = CLOSE_SIGNOFFS.find((s) => s.key === input.key);
  if (!signoff) throw new ChecklistError("Pemeriksaan akhir tidak dikenal.");
  return db.$transaction(async (tx) => {
    const p = periodNumber(input.year, input.month);
    const task = (await loadTasks(tx, input.clientId)).find((t) => t.kind === "SIGNOFF" && t.key === input.key && activeIn(t, p));
    if (task) return applyMark(tx, actor, task, { ...input, step: "done", value: input.done });
    const client = await tx.client.findUniqueOrThrow({ where: { id: input.clientId }, select: { firmId: true } });
    const period = await tx.period.upsert({ where: { clientId_year_month: { clientId: input.clientId, year: input.year, month: input.month } }, create: { firmId: client.firmId, clientId: input.clientId, year: input.year, month: input.month }, update: {}, include: { signoffs: true } });
    if (period.status === "LOCKED") throw new ChecklistError(LOCKED_SIGNOFF);
    const had = period.signoffs.some((s) => s.key === input.key);
    if (had === input.done) return;
    if (input.done) await tx.closeSignoff.create({ data: { periodId: period.id, key: input.key, doneById: actor.id } });
    else await tx.closeSignoff.deleteMany({ where: { periodId: period.id, key: input.key } });
    const label = formatPeriod(input.year, input.month);
    const [from, to] = input.done ? ["Belum", "Selesai"] : ["Selesai", "Belum"];
    await event(tx, input.clientId, actor.id, `signoff:${input.key}`, `${signoff.label} · ${label}: ${from} → ${to}`, { status: from, period: label }, { status: to, period: label });
  });
}
