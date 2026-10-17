import Link from "next/link";
import { ArrowRight, CircleAlert, CircleCheck, Clock3 } from "lucide-react";
import type { WorkspaceOverview } from "@/lib/workspace";
import { workspaceHref } from "@/lib/workspace";
import { formatDateTime } from "@/lib/format";
import { buttonVariants } from "@/components/ui/button-variants";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill } from "@/components/app/status";
import { CountUp } from "@/components/motion/count-up";
import { ProgressFill } from "@/components/motion/progress-fill";

/** The task list: the first `limit` tasks, or all of them when `expanded` (Beranda's `?tugas=semua`); one page, two lengths. */
export function WorkspaceTasks({ data, limit, expanded = false, afterFirst = false }: { data: WorkspaceOverview; limit?: number; expanded?: boolean; afterFirst?: boolean }) {
  // `afterFirst`: Beranda's NextStep banner already states the first job, so the list continues from the second (each fact once).
  // The expanded view ("Semua pekerjaan") lists every job, the first included.
  const skipFirst = afterFirst && !expanded;
  const queue = skipFirst ? data.tasks.slice(1) : data.tasks;
  if (skipFirst && !queue.length) return null;
  const tasks = limit && !expanded ? queue.slice(0, limit) : queue;
  const more = limit !== undefined && queue.length > limit;
  return <Card><CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3"><div><CardTitle role="heading" aria-level={2}>{skipFirst ? "Setelah itu" : "Perlu dikerjakan"}</CardTitle><CardDescription>Masalah yang menghambat buku didahulukan.</CardDescription></div>{more && <Link href={workspaceHref("/", data.scope, expanded ? {} : { tugas: "semua" })} className={buttonVariants({ variant: "ghost", size: "sm" })}>{expanded ? `Tampilkan ${limit} teratas` : `Semua pekerjaan (${data.tasks.length})`} <ArrowRight /></Link>}</CardHeader><CardContent><ul className="divide-y">{tasks.map((task) => <li key={task.id} className="flex flex-wrap items-center gap-3 py-4 first:pt-0 last:pb-0"><span className={task.priority === "high" ? "text-review" : "text-muted-foreground"}>{task.priority === "high" ? <CircleAlert className="size-5" aria-label="Prioritas tinggi" /> : <Clock3 className="size-5" aria-label="Pekerjaan berikutnya" />}</span><div className="min-w-0 flex-1"><p className="text-sm font-semibold">{task.title}</p><p className="mt-0.5 text-xs text-muted-foreground">{task.detail}</p></div><Link href={task.href} aria-label={`${task.title} · ${task.detail}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Buka <ArrowRight aria-hidden /></Link></li>)}</ul>{!tasks.length && <p className="flex items-start gap-2 text-sm text-muted-foreground"><CircleCheck className="size-4 shrink-0 text-pass" />{data.clients.length ? "Tidak ada pekerjaan tertunda pada cakupan ini." : "Tambahkan klien untuk mulai menyiapkan buku."}</p>}</CardContent></Card>;
}

type BoardClient = WorkspaceOverview["clients"][number];

/** Papan kantor (I5a, ADR 0014): every client's month by stage — Sumber, Persetujuan (its Kotak), Checklist, Tutup buku, Terkirim. Each cell links to where it is fixed. */
export function WorkspaceClose({ data }: { data: WorkspaceOverview }) {
  const { closed, clients } = data.counts;
  const cells = (c: BoardClient) => [
    { label: "Sumber", node: !c.sumber.rows ? <span className="text-xs text-muted-foreground">Belum ada data</span> : <Link href={c.importHref}><StatusPill status={c.sumber.gaps ? "REVIEW" : "PASS"} label={c.sumber.gaps ? `${c.sumber.gaps} kurang` : "Lengkap"} /></Link> },
    { label: "Persetujuan", node: <Link href={c.approvalsHref}><StatusPill status={c.approvals ? "REVIEW" : "PASS"} label={c.approvals ? `${c.approvals} usulan` : "Selesai"} /></Link> },
    { label: "Checklist", node: !c.checklist.hasTemplate ? <span className="text-xs text-muted-foreground">Belum diatur</span> : c.checklist.overdue ? <Link href={c.checklist.href}><StatusPill status="REVIEW" label={`${c.checklist.overdue} lewat tenggat`} /></Link> : !c.checklist.total ? <span className="text-xs text-muted-foreground">–</span> : <Link href={c.checklist.href}><StatusPill status={c.checklist.finished === c.checklist.total ? "PASS" : "REVIEW"} label={c.checklist.finished === c.checklist.total ? "Lengkap" : `${c.checklist.finished} / ${c.checklist.total} selesai`} /></Link> },
    { label: "Tutup buku", node: <Link href={c.closeHref}><StatusPill status={c.state === "LOCKED" || c.state === "READY" ? "PASS" : c.state === "FAIL" ? "FAIL" : "REVIEW"} label={c.label} /></Link> },
    { label: "Terkirim", node: c.state !== "LOCKED" ? <span className="text-xs text-muted-foreground">–</span> : c.sentAt ? <StatusPill status="PASS" label={formatDateTime(c.sentAt)} /> : <StatusPill status="REVIEW" label="Belum dikirim" /> },
  ];
  return <Card data-testid="firm-board"><CardHeader><CardTitle role="heading" aria-level={2}>Kemajuan tutup buku</CardTitle><CardDescription>{data.scope.periodLabel} · per klien: data lengkap, usulan disetujui, checklist, buku ditutup, laporan terkirim</CardDescription></CardHeader><CardContent className="space-y-4"><div><div className="mb-2 flex justify-between gap-2 text-sm"><span>Klien selesai</span><strong><CountUp value={closed} suffix={` / ${clients}`} /></strong></div><ProgressFill value={clients ? (closed / clients) * 100 : 0} aria-label={`${closed} dari ${clients} klien selesai tutup buku`} /></div>{data.scope.kind === "entity" && <p className="text-xs leading-relaxed text-muted-foreground">Status mencakup seluruh grup / klien induk perusahaan ini.</p>}
    <table className="hidden w-full text-sm md:table"><thead><tr className="border-b">{["Klien", "Sumber", "Persetujuan", "Checklist", "Tutup buku", "Terkirim"].map((h) => <th key={h} className="eyebrow py-2 pr-3 text-left font-normal">{h}</th>)}</tr></thead><tbody className="divide-y">{data.clients.map((c) => <tr key={c.id} data-testid="board-row"><td className="py-3 pr-3"><Link href={c.closeHref} className="inline-flex items-center gap-1 font-medium hover:text-primary">{c.name}<ArrowRight className="size-3.5 shrink-0" /></Link></td>{cells(c).map((cell) => <td key={cell.label} className="py-3 pr-3">{cell.node}</td>)}</tr>)}</tbody></table>
    <ul className="divide-y md:hidden">{data.clients.map((c) => <li key={c.id} className="space-y-2 py-3"><Link href={c.closeHref} className="inline-flex min-w-0 items-center gap-1 text-sm font-medium hover:text-primary">{c.name}<ArrowRight className="size-3.5 shrink-0" /></Link><dl className="grid grid-cols-2 gap-2">{cells(c).map((cell) => <div key={cell.label}><dt className="eyebrow text-muted-foreground">{cell.label}</dt><dd className="mt-1">{cell.node}</dd></div>)}</dl></li>)}</ul>
    {!clients && <p className="text-sm text-muted-foreground">Belum ada klien dalam ruang kerja ini.</p>}</CardContent></Card>;
}

/** One row per company: name + three figures. Stacked on a phone, four columns from md up (one DOM, no hidden duplicate). */
const COLS = "md:grid-cols-[minmax(0,1fr)_9rem_9rem_9rem] md:gap-x-3";

export function WorkspaceFinancials({ data }: { data: WorkspaceOverview }) {
  type Entity = WorkspaceOverview["entities"][number];
  const figures = (entity: Entity) => [
    { label: "Pendapatan bulan ini", value: entity.revenueFormatted, hasData: entity.revenue !== null, href: entity.reportHref },
    { label: "Laba bersih bulan ini", value: entity.profitFormatted, hasData: entity.profit !== null, href: entity.reportHref },
    { label: "Kas & bank akhir bulan", value: entity.cashFormatted, hasData: entity.cash !== null, href: workspaceHref(`/clients/${entity.clientId}/trial-balance`, data.scope, { entity: entity.id }) },
  ].map((figure) => ({
    ...figure,
    node: figure.hasData
      ? <Link href={figure.href} aria-label={`${figure.label} ${entity.name}: ${figure.value}; buka rincian`} className="drill">{figure.value}</Link>
      : <span className="text-xs font-normal text-muted-foreground">Belum ada jurnal</span>,
  }));
  const name = (entity: Entity) => (
    <>
      <Link className="inline-flex items-center gap-1 font-medium hover:text-primary" href={entity.reportHref}>{entity.name}<ArrowRight className="size-3.5 shrink-0" /></Link>
      <p className="mt-0.5 text-xs text-muted-foreground">{entity.clientName} · {entity.currency}</p>
      {!entity.hasActivity && <p className="mt-1 text-xs text-muted-foreground">Belum ada jurnal bulan ini. Saldo kas, jika tersedia, berasal dari jurnal sampai akhir bulan.</p>}
    </>
  );
  return (
    <Card>
      <CardHeader><CardTitle role="heading" aria-level={2}>Keuangan per perusahaan</CardTitle><CardDescription>Dari buku besar · jurnal yang sudah dibukukan · {data.scope.periodLabel}. Setiap perusahaan memakai mata uangnya sendiri; bukan konsolidasi.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        {data.entities.length > 0 && (
          <div>
            <div className={`${COLS} hidden border-b py-2 md:grid`} aria-hidden>{["Perusahaan", "Pendapatan", "Laba bersih", "Kas & bank"].map((h, i) => <span key={h} className={`eyebrow ${i ? "text-right" : ""}`}>{h}</span>)}</div>
            <ul className="divide-y">{data.entities.map((entity) => <li key={entity.id} className={`${COLS} grid gap-2 py-3 md:items-start`}><div className="min-w-0">{name(entity)}</div><dl className="space-y-1 md:contents">{figures(entity).map((f) => <div key={f.label} className="flex items-baseline justify-between gap-3 md:block md:text-right"><dt className="text-xs text-muted-foreground md:sr-only">{f.label}</dt><dd className="num text-right text-sm font-semibold md:text-base">{f.node}</dd></div>)}</dl></li>)}</ul>
          </div>
        )}
        {!data.entities.length && <p className="text-sm text-muted-foreground">Belum ada perusahaan. Tambahkan klien beserta perusahaannya untuk mulai menyiapkan laporan.</p>}
        <p className="text-xs leading-relaxed text-muted-foreground">Angka laporan yang diunggah tersedia di Dokumen. Unggahan tersebut menjadi bahan analisis dan tidak otomatis menjadi jurnal.</p>
        <Link href={workspaceHref("/documents", data.scope)} className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-4">Periksa dokumen sumber <ArrowRight className="size-3.5" /></Link>
      </CardContent>
    </Card>
  );
}
