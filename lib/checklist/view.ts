import type { Db, Tx } from "@/lib/db";
import type { ChecklistKind } from "@/lib/generated/prisma/enums";
import { isAdminRole } from "@/lib/auth/permissions";
import { CLOSE_SIGNOFFS, runControls } from "@/lib/controls";
import { completenessMatrix } from "@/lib/controls/completeness";
import { approvalCounts } from "@/lib/approvals/queue";
import { setupProgress } from "@/lib/setup-progress";
import { clientModules } from "@/lib/clients/modules";
import { formatDate, formatPeriod } from "@/lib/format";
import { withParams } from "@/lib/scope";
import { AFTER_LOCK, AUTO_KINDS, autoKind, isAutoKey, NEEDS, prove, type AutoKey, type ChecklistFacts, type Proof } from "@/lib/checklist/proofs";
import { daysLate, dueDate, humanStatus, holderProblem, pairProblem, periodNumber, periodOf, nextPeriod, todayWib, type Person, type Role, type Stamp, type TaskStatus } from "@/lib/checklist/rules";

/**
 * Checklist tutup buku, the read side (cycle 2026-10-17-checklist-tutup-buku). A month's checklist is the client's template tasks active
 * in that month joined with that month's marks (and, for a Pemeriksaan akhir, the month's CloseSignoff): nothing is copied per month, so
 * every new month has the list without a write. The page, Tutup Buku, the firm board and Beranda all read it from here.
 */

export const SIGNOFF_LABEL = new Map<string, string>(CLOSE_SIGNOFFS.map((s) => [s.key, s.label]));
export const KIND_EYEBROW: Record<ChecklistKind, string | null> = { AUTO: "Otomatis", SIGNOFF: "Pemeriksaan akhir", MANUAL: null };

const holder = { select: { id: true, name: true, role: true, disabled: true } } as const;
export async function loadTasks(db: Db | Tx, clientId: string) {
  return db.checklistTask.findMany({ where: { clientId }, include: { assignee: holder, reviewer: holder }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
}
export type TemplateTask = Awaited<ReturnType<typeof loadTasks>>[number];

export const activeIn = (t: { startPeriod: number; endPeriod: number | null }, p: number) => t.startPeriod <= p && (t.endPeriod === null || t.endPeriod >= p);

/** The members of the client's organisation as the rules read them (active, role, and whether they can open this client). */
export async function clientPeople(db: Db | Tx, clientId: string): Promise<Map<string, Person>> {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { firmId: true, firm: { select: { kind: true } } } });
  const members = await db.firmMember.findMany({ where: { firmId: client.firmId }, select: { id: true, name: true, role: true, disabled: true, clientAccess: { where: { clientId }, select: { id: true } } }, orderBy: { name: "asc" } });
  return new Map(members.map((m) => [m.id, { id: m.id, name: m.name, role: m.role, disabled: m.disabled, canOpen: isAdminRole(m.role) || client.firm.kind === "PERUSAHAAN" || m.clientAccess.length > 0 }]));
}

/** Members who may hold a task of this client (Pelaksana or Pereviu): active writers who can open it. */
export const eligiblePeople = (people: Map<string, Person>) => [...people.values()].filter((p) => holderProblem(p, "Pelaksana") === null);

/** The board's *Sumber* for one month of a completeness grid: its rows, and those whose month is missing or broken. */
export function sumberOf(matrix: Awaited<ReturnType<typeof completenessMatrix>>, year: number, month: number): ChecklistFacts["sumber"] {
  const i = matrix.months.findIndex((m) => m.year === year && m.month === month);
  if (i < 0) return { rows: 0, gaps: 0 };
  const rows = matrix.rows.filter((r) => r.cells[i] && r.cells[i].state !== "before");
  return { rows: rows.length, gaps: rows.filter((r) => r.cells[i].state === "missing" || r.cells[i].state === "broken").length };
}

/** The first report out for the month after its lock (the board's *Terkirim*); null when the month is open or nothing was exported. */
async function sentAfterLock(db: Db | Tx, clientId: string, year: number, month: number, lockedAt: Date | null) {
  if (!lockedAt) return null;
  const key = `period:${year}-${String(month).padStart(2, "0")}`;
  const e = await db.auditEvent.findFirst({ where: { clientId, kind: "REPORT_EXPORT", subject: key, createdAt: { gte: lockedAt } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  return e?.createdAt ?? null;
}

/** The facts the given Otomatis kinds read, reusing what the caller already has (`given`); only the missing parts are loaded. */
export async function loadFacts(db: Db, clientId: string, year: number, month: number, keys: AutoKey[], given: Partial<ChecklistFacts> = {}): Promise<Partial<ChecklistFacts>> {
  const need = new Set(keys.flatMap((k) => NEEDS[k]).filter((f) => !(f in given)));
  const out: Partial<ChecklistFacts> = { ...given };
  const lockedAt = async () => {
    if ("lockedAt" in out) return out.lockedAt ?? null;
    const p = await db.period.findUnique({ where: { clientId_year_month: { clientId, year, month } }, select: { status: true, lockedAt: true } });
    return (out.lockedAt = p?.status === "LOCKED" ? (p.lockedAt ?? new Date(0)) : null);
  };
  await Promise.all([
    need.has("controls") && runControls(db, clientId, year, month).then((c) => void (out.controls = c)),
    need.has("sumber") && completenessMatrix(db, clientId, year, month, 1).then((m) => void (out.sumber = sumberOf(m, year, month))),
    need.has("approvals") && approvalCounts(db, { clientId, year, month }, { reopen: false }).then((c) => void (out.approvals = c.total)),
    need.has("opening") && setupProgress(db, clientId).then((s) => void (out.opening = { needs: s.needsOpening.map((e) => e.shortName), hasData: s.hasData })),
    (need.has("lockedAt") || need.has("sentAt")) && lockedAt().then(async (at) => { if (need.has("sentAt")) out.sentAt = await sentAfterLock(db, clientId, year, month, at); }),
  ]);
  return out;
}

export type ChecklistRow = {
  id: string;
  kind: ChecklistKind;
  key: string | null;
  title: string;
  eyebrow: string | null;
  assignee: { id: string; name: string; role: Person["role"] };
  reviewer: { id: string; name: string; role: Person["role"] } | null;
  dueDay: number;
  /** ISO date and "10 Sep 2026". */
  due: string;
  dueLabel: string;
  done: Stamp | null;
  review: Stamp | null;
  status: TaskStatus;
  finished: boolean;
  overdue: boolean;
  daysLate: number;
  /** Who the task waits on now: the Pelaksana before Selesai, the Pereviu after; null once finished. */
  waitsOn: { role: Role; id: string; name: string } | null;
  /** Otomatis: the proof line and where it is fixed. */
  proof: (Proof & { href: string; fix: string }) | null;
  /** Otomatis whose facts were not read (an earlier closed month in the board's roll-up): neither finished nor late. */
  unknown: boolean;
  /** The Pelaksana or Pereviu can no longer hold the task (disabled, unassigned, role changed): an admin reassigns it. */
  problem: string | null;
  /** Which of them it is: a gone Pelaksana stops the tick, a gone Pereviu the review. */
  gone: { assignee: boolean; reviewer: boolean };
};

type MarkIn = { taskId: string; doneAt: Date | null; doneById: string | null; doneBy: { name: string } | null; reviewedAt: Date | null; reviewedById: string | null; reviewedBy: { name: string } | null };
type SignoffIn = { key: string; doneAt: Date; doneById: string | null; doneBy: { name: string } | null };
const stamp = (at: Date | null, byId: string | null, by: { name: string } | null): Stamp | null => (at ? { at, byId, by: by?.name ?? "Sistem" } : null);

/** Problems with the people on a task, read against who they are now (roles and assignments change); null when they still hold it. */
export function holderNotes(t: TemplateTask, people: Map<string, Person>): { assignee: string | null; reviewer: string | null } {
  const a = people.get(t.assigneeId);
  const assignee = holderProblem(a, "Pelaksana") ? `Pelaksana ${t.assignee.name} tidak lagi memegang klien ini. Admin perlu mengganti Pelaksana.` : null;
  if (!t.reviewerId) return { assignee, reviewer: null };
  const r = people.get(t.reviewerId);
  const reviewer = holderProblem(r, "Pereviu")
    ? `Pereviu ${t.reviewer?.name ?? ""} tidak lagi memegang klien ini. Admin perlu mengganti Pereviu.`
    : a && pairProblem(a, r!) ? `Pereviu ${r!.name} kini berperan lebih rendah dari Pelaksana. Admin perlu mengganti Pereviu.` : null;
  return { assignee, reviewer };
}

/**
 * One month's rows, from the tasks active in it, its marks and sign-offs, and the facts read for its Otomatis tasks (a kind whose facts
 * are missing is `unknown`). Pure: the page, Tutup Buku and the board's roll-up share it.
 */
export function buildRows(input: { tasks: TemplateTask[]; marks: MarkIn[]; signoffs: SignoffIn[]; facts: Partial<ChecklistFacts>; year: number; month: number; today: Date; base: string; people?: Map<string, Person> }): ChecklistRow[] {
  const p = periodNumber(input.year, input.month);
  const label = formatPeriod(input.year, input.month);
  const query = { period: `${input.year}-${String(input.month).padStart(2, "0")}` };
  return input.tasks.filter((t) => activeIn(t, p)).map((t): ChecklistRow => {
    const due = dueDate(input.year, input.month, t.dueDay);
    const mark = input.marks.find((m) => m.taskId === t.id);
    const assignee = { id: t.assignee.id, name: t.assignee.name, role: t.assignee.role };
    const reviewer = t.reviewer ? { id: t.reviewer.id, name: t.reviewer.name, role: t.reviewer.role } : null;
    let proof: ChecklistRow["proof"] = null;
    let unknown = false;
    let done: Stamp | null = null;
    let review: Stamp | null = null;
    let state: { status: TaskStatus; finished: boolean; waitsOn: Role | null };
    if (t.kind === "AUTO" && t.key && isAutoKey(t.key)) {
      const kind = autoKind(t.key);
      unknown = NEEDS[t.key].some((f) => !(f in input.facts));
      const proven = unknown ? null : prove(t.key, input.facts as ChecklistFacts, label);
      const href = t.key === "subledger" ? withParams(`${input.base}${kind.href}`, { ...query, tab: "rekonsiliasi" }) : t.key === "sumber" || t.key === "opening" ? `${input.base}${kind.href}` : withParams(`${input.base}${kind.href}`, query);
      proof = proven ? { ...proven, href, fix: kind.fix } : null;
      state = proven?.ok ? { status: "SELESAI", finished: true, waitsOn: null } : { status: "BELUM", finished: false, waitsOn: unknown ? null : "Pelaksana" };
    } else {
      const signoff = t.kind === "SIGNOFF" ? input.signoffs.find((s) => s.key === t.key) : undefined;
      done = t.kind === "SIGNOFF" ? (signoff ? stamp(signoff.doneAt, signoff.doneById, signoff.doneBy) : null) : mark ? stamp(mark.doneAt, mark.doneById, mark.doneBy) : null;
      review = mark ? stamp(mark.reviewedAt, mark.reviewedById, mark.reviewedBy) : null;
      state = humanStatus(done, review, Boolean(t.reviewerId));
    }
    const overdue = !state.finished && !unknown && +input.today > +due;
    const notes = input.people ? holderNotes(t, input.people) : { assignee: null, reviewer: null };
    const who = state.waitsOn === "Pereviu" ? reviewer : state.waitsOn === "Pelaksana" ? assignee : null;
    return {
      id: t.id, kind: t.kind, key: t.key, title: t.title, eyebrow: KIND_EYEBROW[t.kind], assignee, reviewer, dueDay: t.dueDay,
      due: due.toISOString().slice(0, 10), dueLabel: formatDate(due), done, review, status: state.status, finished: state.finished,
      overdue, daysLate: overdue ? daysLate(due, input.today) : 0, waitsOn: who && state.waitsOn ? { role: state.waitsOn, id: who.id, name: who.name } : null,
      proof, unknown, problem: notes.assignee ?? notes.reviewer, gone: { assignee: Boolean(notes.assignee), reviewer: Boolean(notes.reviewer) },
    };
  });
}

export const countsOf = (rows: ChecklistRow[]) => ({
  total: rows.length,
  finished: rows.filter((r) => r.finished).length,
  awaitingReview: rows.filter((r) => !r.finished && r.status === "SELESAI" && r.kind !== "AUTO").length,
  overdue: rows.filter((r) => r.overdue).length,
});

/** What Tutup Buku warns about before the lock (never a blocker): unfinished tasks, less *Tutup buku* and *Laporan dikirim*, which can't be done before it. */
export const unfinishedBeforeLock = (rows: Pick<ChecklistRow, "finished" | "kind" | "key">[]) =>
  rows.filter((r) => !r.finished && !(r.kind === "AUTO" && AFTER_LOCK.includes(r.key as AutoKey))).length;

const markInclude = { doneBy: { select: { name: true } }, reviewedBy: { select: { name: true } } } as const;

export type ChecklistMonth = Awaited<ReturnType<typeof checklistMonth>>;

/**
 * A client's checklist for one month: its rows (problems sorted by the page), counts, and whether the client has a template at all and
 * from which month. `facts` passes what the caller already read (Tutup Buku its controls); the rest is read only for active Otomatis kinds.
 */
export async function checklistMonth(db: Db, input: { clientId: string; year: number; month: number; now?: Date; facts?: Partial<ChecklistFacts> }) {
  const { clientId, year, month } = input;
  const p = periodNumber(year, month);
  const [tasks, period, people] = await Promise.all([
    loadTasks(db, clientId),
    db.period.findUnique({ where: { clientId_year_month: { clientId, year, month } }, select: { status: true, lockedAt: true, signoffs: { include: { doneBy: { select: { name: true } } } } } }),
    clientPeople(db, clientId),
  ]);
  const active = tasks.filter((t) => activeIn(t, p));
  const marks = active.length ? await db.checklistMark.findMany({ where: { taskId: { in: active.map((t) => t.id) }, year, month }, include: markInclude }) : [];
  const locked = period?.status === "LOCKED";
  const autoKeys = active.filter((t) => t.kind === "AUTO" && t.key && isAutoKey(t.key)).map((t) => t.key as AutoKey);
  const given = { lockedAt: locked ? (period?.lockedAt ?? new Date(0)) : null, ...input.facts };
  const facts = autoKeys.length ? await loadFacts(db, clientId, year, month, autoKeys, given) : given;
  const rows = buildRows({ tasks: active, marks, signoffs: period?.signoffs ?? [], facts, year, month, today: todayWib(input.now), base: `/clients/${clientId}`, people });
  const starts = tasks.map((t) => t.startPeriod);
  return {
    year, month, label: formatPeriod(year, month), locked,
    hasTemplate: tasks.length > 0,
    /** The template's first month (a month before it shows no checklist). */
    firstPeriod: starts.length ? Math.min(...starts) : null,
    rows,
    counts: countsOf(rows),
    people,
  };
}

/** The Otomatis kinds an admin may still add for the month (those not active in it). */
export function addableAutoKinds(rows: Pick<ChecklistRow, "kind" | "key">[]) {
  const present = new Set(rows.filter((r) => r.kind === "AUTO").map((r) => r.key));
  return AUTO_KINDS.filter((k) => !present.has(k.key));
}

export type ProposalLine = { kind: Exclude<ChecklistKind, "MANUAL">; key: string; title: string; dueDay: number; reason: string };

/**
 * The first list Buku proposes (never creates on its own) from what the client uses: Saldo awal only while a company still needs one,
 * Piutang & Utang only when its module shows, Pajak Masa only when the month has a `masa:` control. Each line says why it is there.
 */
export function defaultLines(facts: { receivables: boolean; masa: boolean; opening: { needs: string[]; hasData: boolean } }): ProposalLine[] {
  const auto = (key: AutoKey, reason: string, dueDay?: number): ProposalLine => ({ kind: "AUTO", key, title: autoKind(key).title, dueDay: dueDay ?? autoKind(key).dueDay, reason });
  const lines: ProposalLine[] = [auto("sumber", "Setiap bulan: data klien masuk lebih dulu. Tercentang saat semua rekening koran bulan ini lengkap.")];
  if (!facts.opening.hasData || facts.opening.needs.length) {
    lines.push(auto("opening", facts.opening.needs.length ? `${facts.opening.needs.join(", ")} belum punya saldo awal.` : "Belum ada saldo awal yang dicatat."));
  }
  lines.push(auto("approvals", "Setiap bulan: usulan klasifikasi dan jurnal menunggu klik akuntan."));
  if (facts.receivables) lines.push(auto("subledger", "Modul Piutang & Utang dipakai klien ini."));
  if (facts.masa) lines.push(auto("tax", "Bulan ini ada kontrol Pajak Masa."));
  lines.push(auto("controls", "Setiap bulan: kontrol gagal atau tanpa catatan menahan tutup buku."));
  for (const s of CLOSE_SIGNOFFS) lines.push({ kind: "SIGNOFF", key: s.key, title: s.label, dueDay: s.key === "review" ? 12 : 10, reason: "Syarat tutup buku: dicentang sebelum buku dikunci." });
  lines.push(auto("lock", "Setiap bulan: buku dikunci setelah kontrol dan pemeriksaan akhir lengkap."));
  lines.push(auto("sent", "Setiap bulan: laporan untuk klien setelah tutup buku."));
  return lines;
}

/** The default list for this client and month (what *Pakai daftar ini* creates). */
export async function proposeChecklist(db: Db, clientId: string, year: number, month: number, given: { controls?: ChecklistFacts["controls"] } = {}) {
  const { firmId } = await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { firmId: true } });
  const [modules, controls, setup] = await Promise.all([clientModules(db, firmId), given.controls ?? runControls(db, clientId, year, month), setupProgress(db, clientId)]);
  return defaultLines({
    receivables: modules.get(clientId)?.visible.includes("receivables") ?? false,
    masa: controls.some((c) => c.key.startsWith("masa:")),
    opening: { needs: setup.needsOpening.map((e) => e.shortName), hasData: setup.hasData },
  });
}

export type ChecklistRollup = {
  hasTemplate: boolean;
  /** The board month's own checklist (zero before the template's first month). */
  total: number;
  finished: number;
  /** Late tasks in the board month and every earlier month since the template began. */
  overdue: number;
  /** The earliest month with a late task: where the board and Beranda link. */
  earliest: { year: number; month: number } | null;
  /** Who the late tasks wait on, names once each. */
  waitsOn: string[];
};

/**
 * The firm board's *Checklist* cell and Beranda's late-task count, from the same rows as the page. The board month reads every proof from
 * the facts the board already computed; an earlier month still open reads its own; an earlier closed month reads its human tasks and the
 * lock and *Laporan dikirim* proofs (its other proofs would need that month's controls, which its own page reads).
 */
export async function checklistRollup(db: Db, input: { clientId: string; year: number; month: number; now?: Date; facts?: Partial<ChecklistFacts> }): Promise<ChecklistRollup> {
  const { clientId } = input;
  const tasks = await loadTasks(db, clientId);
  const empty: ChecklistRollup = { hasTemplate: tasks.length > 0, total: 0, finished: 0, overdue: 0, earliest: null, waitsOn: [] };
  const last = periodNumber(input.year, input.month);
  const first = tasks.length ? Math.min(...tasks.map((t) => t.startPeriod)) : last + 1;
  if (first > last) return empty;
  const months: number[] = [];
  for (let p = first; p <= last; p = nextPeriod(p)) if (tasks.some((t) => activeIn(t, p))) months.push(p);
  const [marks, periods] = await Promise.all([
    db.checklistMark.findMany({ where: { taskId: { in: tasks.map((t) => t.id) } }, include: markInclude }),
    db.period.findMany({ where: { clientId, OR: months.map((p) => ({ year: periodOf(p).year, month: periodOf(p).month })) }, select: { year: true, month: true, status: true, lockedAt: true, signoffs: { include: { doneBy: { select: { name: true } } } } } }),
  ]);
  const today = todayWib(input.now);
  const out = { ...empty };
  const waits = new Set<string>();
  for (const p of months) {
    const { year, month } = periodOf(p);
    const period = periods.find((x) => x.year === year && x.month === month);
    const lockedAt = period?.status === "LOCKED" ? (period.lockedAt ?? new Date(0)) : null;
    const active = tasks.filter((t) => activeIn(t, p));
    const keys = active.filter((t) => t.kind === "AUTO" && t.key && isAutoKey(t.key)).map((t) => t.key as AutoKey);
    const base: Partial<ChecklistFacts> = { lockedAt, ...(p === last ? input.facts : {}) };
    // The board month and an earlier month still open read every proof; an earlier closed month only the cheap ones.
    const facts = p === last || !lockedAt ? await loadFacts(db, clientId, year, month, keys, base) : { ...base, sentAt: await sentAfterLock(db, clientId, year, month, lockedAt) };
    const rows = buildRows({ tasks: active, marks: marks.filter((m) => m.year === year && m.month === month), signoffs: period?.signoffs ?? [], facts, year, month, today, base: `/clients/${clientId}` });
    const late = rows.filter((r) => r.overdue);
    if (late.length && !out.earliest) out.earliest = { year, month };
    out.overdue += late.length;
    for (const r of late) if (r.waitsOn) waits.add(r.waitsOn.name);
    if (p === last) Object.assign(out, { total: rows.length, finished: rows.filter((r) => r.finished).length });
  }
  return { ...out, waitsOn: [...waits] };
}
