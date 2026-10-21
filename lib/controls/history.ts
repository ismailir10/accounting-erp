import { createHash } from "node:crypto";
import type { Db } from "@/lib/db";
import { recordEvent } from "@/lib/audit";
import { pendingJournalCount, pendingLockMessage } from "@/lib/approvals/pending";
import { formatPeriod } from "@/lib/format";
import { saveControlNote } from "@/lib/controls/ack";
import { CLOSE_SIGNOFFS, CloseError, earlierOpenMonth, lockPeriod, runControls, type Control } from "@/lib/controls";
import { can } from "@/lib/auth/permissions";
import type { MemberRole } from "@/lib/generated/prisma/enums";

/**
 * Closing the history in one pass (rule 23, applied per month): a client migrated with many past months closes them in order from the
 * Tutup Buku page of a later month, with one note and one confirmation of the sign-offs for the run. Every month still runs its
 * controls and is locked by `lockPeriod`; a failed control stops the run at that month.
 */
export type YearMonth = { year: number; month: number };
export type HistoryControl = { key: string; title: string; scope: string; detail: string };
export type HistoryMonth = YearMonth & {
  label: string;
  /** READY: nothing open · NOTE: REVIEW controls the note will answer · FAIL: the run stops here. */
  status: "READY" | "NOTE" | "FAIL";
  toNote: HistoryControl[];
  fails: HistoryControl[];
  /** What the note was shown to answer; a month whose controls read differently at closing time is refused. */
  fingerprint: string;
};
export type HistoryPreview = {
  months: HistoryMonth[];
  /** Months after a failing one: not part of this run. */
  blocked: { count: number; from: string } | null;
  /** The controls the note answers, grouped across months, most months first. */
  groups: { title: string; scope: string; months: number }[];
};

export const HISTORY_NOTE_MIN = 10;
export const HISTORY_MIN_MONTHS = 2;
const CHUNK = 4;

const before = (a: YearMonth, b: YearMonth) => a.year < b.year || (a.year === b.year && a.month < b.month);
const view = (c: Control): HistoryControl => ({ key: c.key, title: c.title, scope: c.scope, detail: c.detail });
const toNote = (controls: Control[]) => controls.filter((c) => c.status === "REVIEW" && !c.ack);

/** Stable over order: the REVIEW controls still without a current note, by key and detail. */
export function historyFingerprint(controls: Control[]) {
  const parts = toNote(controls).map((c) => `${c.key}\u0001${c.detail}`).sort();
  return createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 16);
}

/** The open months with activity (a Saldo Awal alone is an opening, not a month to close) before `until`, earliest first. */
export async function historyMonths(db: Db, clientId: string, until: YearMonth): Promise<YearMonth[]> {
  return db.period.findMany({
    where: { clientId, status: "OPEN", OR: [{ year: { lt: until.year } }, { year: until.year, month: { lt: until.month } }], entries: { some: { kind: { not: "OPENING" } } } },
    orderBy: [{ year: "asc" }, { month: "asc" }],
    select: { year: true, month: true },
  });
}

function monthView(m: YearMonth, controls: Control[]): HistoryMonth {
  const fails = controls.filter((c) => c.status === "FAIL").map(view);
  const notes = toNote(controls).map(view);
  return { ...m, label: formatPeriod(m.year, m.month), status: fails.length ? "FAIL" : notes.length ? "NOTE" : "READY", toNote: notes, fails, fingerprint: historyFingerprint(controls) };
}

/** Runs the controls of the open months before `until` in order, a few at a time, and stops at the first month with a failed control. */
export async function historyPreview(db: Db, clientId: string, until: YearMonth): Promise<HistoryPreview> {
  const all = await historyMonths(db, clientId, until);
  const months: HistoryMonth[] = [];
  for (let i = 0; i < all.length; i += CHUNK) {
    const chunk = all.slice(i, i + CHUNK);
    const views = await Promise.all(chunk.map(async (m) => monthView(m, await runControls(db, clientId, m.year, m.month))));
    const stop = views.findIndex((v) => v.status === "FAIL");
    months.push(...(stop < 0 ? views : views.slice(0, stop + 1)));
    if (stop >= 0) break;
  }
  const last = months.at(-1);
  const rest = last?.status === "FAIL" ? all.length - months.length : 0;
  const after = rest ? all[months.length] : null;
  const counts = new Map<string, { title: string; scope: string; months: number }>();
  for (const m of months) {
    if (m.status === "FAIL") continue;
    for (const c of m.toNote) {
      const k = `${c.title}\u0001${c.scope}`;
      const g = counts.get(k) ?? { title: c.title, scope: c.scope, months: 0 };
      g.months += 1;
      counts.set(k, g);
    }
  }
  return {
    months,
    blocked: after ? { count: rest, from: formatPeriod(after.year, after.month) } : null,
    groups: [...counts.values()].sort((a, b) => b.months - a.months || a.title.localeCompare(b.title, "id")),
  };
}

/**
 * Closes one month of the run: the earliest open month, before `until`, whose open controls still read as previewed. Writes the note on
 * each REVIEW control without one, records the sign-offs by the actor and locks through `lockPeriod` (rule 23 unchanged). Admin only:
 * one confirmation signs off many months.
 */
export async function closeHistoryMonth(
  db: Db,
  input: { clientId: string; until: YearMonth; month: YearMonth; note: string; fingerprint: string; actor: { id: string; role: MemberRole } },
) {
  const { clientId, until, actor } = input;
  const { year, month } = input.month;
  const label = formatPeriod(year, month);
  const note = input.note.trim();
  if (!can(actor.role, "close.batch")) throw new CloseError("Hanya admin kantor yang dapat menutup beberapa bulan sekaligus.");
  if (note.length < HISTORY_NOTE_MIN) throw new CloseError(`Tulis catatan untuk bulan-bulan ini (min. ${HISTORY_NOTE_MIN} karakter).`);
  if (!before(input.month, until)) throw new CloseError(`${label} bukan bulan sebelum ${formatPeriod(until.year, until.month)}; tutup bulan itu dari halamannya sendiri.`);
  const period = await db.period.findUnique({ where: { clientId_year_month: { clientId, year, month } } });
  if (!period) throw new CloseError(`${label} tidak berisi transaksi.`);
  if (period.status === "LOCKED") throw new CloseError(`${label} sudah ditutup.`);
  // Order first (lockPeriod checks it again under the lock): nothing is written for a month that cannot close yet.
  const first = await earlierOpenMonth(db, clientId, year, month);
  if (first) throw new CloseError(`Tutup buku ${formatPeriod(first.year, first.month)} dulu: bulan sebelumnya yang berisi transaksi harus ditutup lebih dulu.`);
  // A journal waiting for a second approver holds the lock (lockPeriod): refused before any note or sign-off is written.
  const waiting = await pendingJournalCount(db, clientId, year, month);
  if (waiting) throw new CloseError(`${label}: ${pendingLockMessage(waiting)}`);
  const controls = await runControls(db, clientId, year, month);
  const fails = controls.filter((c) => c.status === "FAIL");
  if (fails.length) throw new CloseError(`${label}: ${fails.length} kontrol gagal (${fails.map((c) => `${c.title} · ${c.scope}`).join("; ")}). Perbaiki dulu dari halaman Tutup Buku ${label}.`);
  if (historyFingerprint(controls) !== input.fingerprint) throw new CloseError(`Kontrol ${label} berubah sejak diperiksa. Periksa ulang.`);
  const noted = toNote(controls);
  for (const c of noted) {
    await saveControlNote(db, { clientId, periodId: period.id, year, month, controlKey: c.key, title: `${c.title} · ${c.scope}`, note, detail: c.detail, actorId: actor.id });
  }
  for (const s of CLOSE_SIGNOFFS) {
    // One already ticked keeps who ticked it and when.
    await db.closeSignoff.upsert({ where: { periodId_key: { periodId: period.id, key: s.key } }, create: { periodId: period.id, key: s.key, doneById: actor.id }, update: {} });
  }
  const locked = await lockPeriod(db, clientId, year, month, `Ditutup bersama bulan-bulan sebelumnya: ${note}`, actor.id);
  await recordEvent(db, {
    clientId,
    kind: "HISTORY_CLOSE",
    subject: `period:${period.id}`,
    summary: `${label} ditutup bersama bulan-bulan sebelumnya${noted.length ? ` (${noted.length} kontrol diberi catatan)` : ""}: ${note}`,
    after: { year, month, note, noted: noted.map((c) => `${c.title} · ${c.scope}`) },
    actorId: actor.id,
  });
  return locked;
}
