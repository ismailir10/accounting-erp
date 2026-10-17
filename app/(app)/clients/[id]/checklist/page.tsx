import { prisma } from "@/lib/db";
import { loadClientPage } from "@/lib/client-page";
import { type SearchParams, withParams } from "@/lib/scope";
import { formatDateTime, formatPeriod } from "@/lib/format";
import { accessView, requireWorkspaceSession } from "@/lib/auth/session";
import { can, ROLE_LABEL } from "@/lib/auth/permissions";
import { NextStep, PageHeader } from "@/components/app/page-header";
import { ScopeBar } from "@/components/app/scope-bar";
import { ChecklistPanel, type ChecklistRowView, type PersonOption } from "@/components/app/checklist-panel";
import { addableAutoKinds, checklistMonth, eligiblePeople, proposeChecklist, type ChecklistRow } from "@/lib/checklist/view";
import { periodOf, reviewProblem, ROLE_RANK, tickProblem, type Stamp } from "@/lib/checklist/rules";

export const metadata = { title: "Checklist tutup buku" };

/** "9 Sep 13.10": the done line's time without the year (the month on screen says it). */
const when = (s: Stamp) => formatDateTime(s.at).replace(/ \d{4} /, " ");

/** Problems first (ui-rules 10): late, then not done, then waiting for review; finished ones fold. */
const ORDER = (r: ChecklistRow) => (r.finished ? 3 : r.overdue ? 0 : r.status === "BELUM" ? 1 : 2);

/**
 * Checklist tutup buku (cycle 2026-10-17-checklist-tutup-buku): the client's close steps for the month, each with a Pelaksana, an optional
 * Pereviu and a due date in the month after. Otomatis rows are proven from the books; Pemeriksaan akhir are Tutup Buku's sign-offs.
 * Without a template the page shows the list Buku proposes, and an admin creates it with *Pakai daftar ini*.
 */
export default async function ChecklistPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { client, period, periodOptions, base } = await loadClientPage(params, searchParams);
  const [view, session] = await Promise.all([checklistMonth(prisma, { clientId: client.id, year: period.year, month: period.month }), requireWorkspaceSession()]);
  const me = session.member;
  const { canWrite } = accessView(session);
  const manage = canWrite && can(me.role, "checklist.manage");
  const label = formatPeriod(period.year, period.month);
  const proposal = view.hasTemplate ? null : await proposeChecklist(prisma, client.id, period.year, period.month);
  const people: PersonOption[] = eligiblePeople(view.people).map((p) => ({ id: p.id, label: `${p.name} · ${ROLE_LABEL[p.role]}`, rank: ROLE_RANK[p.role] }));

  const rows = [...view.rows].sort((a, b) => ORDER(a) - ORDER(b) || a.due.localeCompare(b.due));
  const shown: ChecklistRowView[] = rows.map((r) => {
    const human = r.kind !== "AUTO";
    const reviewerOk = r.reviewer && !reviewProblem(me, { reviewerId: r.reviewer.id, assigneeRole: r.assignee.role }, r.done?.byId ?? null);
    const tickable = canWrite && human && !tickProblem(me, { assigneeId: r.assignee.id }) && !(r.kind === "SIGNOFF" && view.locked) && r.status !== "DIREVIU" && !(r.status === "BELUM" && r.gone.assignee);
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      eyebrow: r.eyebrow,
      people: [`Pelaksana ${r.assignee.name}`, r.reviewer ? `Pereviu ${r.reviewer.name}` : "", `Tenggat ${r.dueLabel}`].filter(Boolean).join(" · "),
      late: r.overdue ? `lewat ${r.daysLate} hari` : null,
      waits: r.overdue && r.waitsOn ? `Menunggu ${r.waitsOn.name}` : null,
      status: r.status,
      finished: r.finished,
      overdue: r.overdue,
      doneLine: [r.done ? `Selesai ${r.done.by} · ${when(r.done)}` : "", r.status === "DIREVIU" && r.review ? `Direviu ${r.review.by} · ${when(r.review)}` : ""].filter(Boolean).join(" · ") || null,
      proof: r.proof,
      problem: r.problem,
      done: Boolean(r.done),
      canTick: tickable,
      canReview: Boolean(canWrite && reviewerOk && r.status === "SELESAI" && !r.gone.reviewer),
      canUndoReview: Boolean(canWrite && reviewerOk && r.status === "DIREVIU"),
      edit: { title: r.title, assigneeId: r.assignee.id, reviewerId: r.reviewer?.id ?? null, dueDay: r.dueDay },
    };
  });

  const open = rows.filter((r) => !r.finished);
  const mine = open.filter((r) => r.waitsOn?.id === me.id && r.waitsOn.role === "Pelaksana");
  const toReview = open.filter((r) => r.waitsOn?.id === me.id && r.waitsOn.role === "Pereviu");
  const first = view.firstPeriod ? periodOf(view.firstPeriod) : null;
  const firstKey = first ? `${first.year}-${String(first.month).padStart(2, "0")}` : null;
  const beforeStart = view.hasTemplate && view.rows.length === 0 && first !== null && view.firstPeriod! > period.year * 100 + period.month;

  const next = !view.hasTemplate ? (
    view.locked ? <NextStep>Buku {label} sudah ditutup. Checklist dipakai mulai dari bulan yang masih terbuka.</NextStep>
    : manage ? <NextStep>Buku menyusun daftar dari yang dipakai klien ini. Periksa, lalu pakai.</NextStep>
    : <NextStep>Admin kantor belum mengatur checklist klien ini. Di bawah daftar yang diusulkan Buku dari yang dipakai klien.</NextStep>
  ) : beforeStart ? (
    <NextStep href={withParams(`${base}/checklist`, { period: firstKey! })} cta={`Buka ${formatPeriod(first!.year, first!.month)}`}>Checklist klien ini dimulai {formatPeriod(first!.year, first!.month)}. Bulan sebelumnya tidak punya checklist.</NextStep>
  ) : !rows.length ? (
    <NextStep>Checklist {label} kosong. Tambahkan tugas lewat Atur checklist.</NextStep>
  ) : view.locked ? (
    open.length ? <NextStep>Buku {label} sudah ditutup. {open.length} tugas masih terbuka: {open.map((r) => r.title).join(", ")}.</NextStep>
    : <NextStep tone="done">Buku {label} sudah ditutup dan semua tugas selesai.</NextStep>
  ) : mine.length ? (
    <NextStep>Kerjakan {mine.length} tugas Anda: {mine[0].title}.</NextStep>
  ) : toReview.length ? (
    <NextStep>Reviu {toReview.length} tugas yang menunggu Anda.</NextStep>
  ) : open.length ? (
    <NextStep>{open.length} tugas menunggu orang lain.</NextStep>
  ) : (
    <NextStep tone="done">Semua tugas {label} selesai dan direviu.</NextStep>
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Checklist tutup buku" description={`${label} · tenggat di bulan berikutnya`} actions={<ScopeBar entities={[]} periods={periodOptions} period={period.key} />} />
      {next}
      <ChecklistPanel
        clientId={client.id}
        year={period.year}
        month={period.month}
        periodLabel={label}
        locked={view.locked}
        hasTemplate={view.hasTemplate && !beforeStart}
        rows={beforeStart ? [] : shown}
        counts={view.counts}
        proposal={proposal}
        people={people}
        me={{ id: me.id, rank: ROLE_RANK[me.role] }}
        canWrite={canWrite}
        manage={manage}
        autoKinds={addableAutoKinds(view.rows).map((k) => ({ key: k.key, label: k.label, dueDay: k.dueDay }))}
      />
    </div>
  );
}
