import { prisma } from "@/lib/db";
import { loadClientPage } from "@/lib/client-page";
import { type SearchParams, withParams } from "@/lib/scope";
import { formatDate, formatMonthShort, formatPeriod, toIsoDate } from "@/lib/format";
import { ScopeBar } from "@/components/app/scope-bar";
import { ScheduleProposals } from "@/components/app/schedule-proposals";
import { SchedulePanel } from "@/components/app/schedule-panel";
import { candidateViews, proposalViews, scheduleViews } from "@/lib/adjust/view";
import { accrualProposals } from "@/lib/adjust/accruals";
import { Money } from "@/components/app/money";
import { NextStep, PageHeader } from "@/components/app/page-header";
import Link from "next/link";
import { JournalForm, type JournalCopy } from "@/components/app/journal-form";
import { formatMoney } from "@/lib/money";
import { firstOfNextMonth } from "@/lib/ledger/adjustment";
import { accountGroup } from "@/lib/coa/options";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill } from "@/components/app/status";
import { accessView, requireWorkspaceSession } from "@/lib/auth/session";
import { routeFor } from "@/lib/approvals/journals";
import { dayLabel, recurringViews } from "@/lib/adjust/recurring";
import { RecurringList, RepeatJournal } from "@/components/app/recurring-journals";
import { dimensionOptions } from "@/lib/dimensions";

export const metadata = { title: "Jurnal Penyesuaian" };

/** Where *Ulangi tiap bulan* starts for a journal dated `d`: the next month, on the same day (the month's last when `d` was its last). */
function repeatFrom(d: Date) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate() === d.getUTCDate();
  return { start: `${next.y}-${String(next.m).padStart(2, "0")}`, startLabel: formatMonthShort(next.y, next.m), day: dayLabel(last ? 0 : d.getUTCDate()) };
}

export default async function NewJournalPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { client, period, periodOptions, sp } = await loadClientPage(params, searchParams);
  const [due, candidates, schedules, p, lockedPeriods, accruals] = await Promise.all([
    proposalViews(prisma, client.id, period.year, period.month),
    candidateViews(prisma, client.id, period.year, period.month),
    scheduleViews(prisma, client.id),
    prisma.period.findUnique({ where: { clientId_year_month: { clientId: client.id, year: period.year, month: period.month } }, select: { status: true } }),
    prisma.period.findMany({ where: { clientId: client.id, status: "LOCKED" }, select: { year: true, month: true } }),
    // Accruals are proposed per vendor in Kotak persetujuan (cycle 2026-10-18-usulan-akrual), no longer as candidates here.
    accrualProposals(prisma, client.id, period.year, period.month),
  ]);
  const lockedMonths = lockedPeriods.map((l) => `${l.year}-${String(l.month).padStart(2, "0")}`);
  const closeHref = `/clients/${client.id}/close?period=${period.key}`;
  const locked = p?.status === "LOCKED";
  const label = formatPeriod(period.year, period.month);
  const next = period.month === 12 ? `${period.year + 1}-01` : `${period.year}-${String(period.month + 1).padStart(2, "0")}`;
  // Companies first: an adjusting entry almost always belongs to the PT/CV, not the owner.
  const entities = [...client.entities].sort((a, b) => Number(a.kind === "PERORANGAN") - Number(b.kind === "PERORANGAN")).map((e) => ({ id: e.id, name: e.name, currency: e.functionalCurrency }));
  const accounts = await prisma.account.findMany({ where: { clientId: client.id, isSuspense: false, archivedAt: null }, orderBy: { code: "asc" }, include: { bankAccounts: { select: { entityId: true } } } });
  // Persetujuan kedua: this member's route for *Jurnal manual*, and the journals of this client still waiting (listed first).
  const session = await requireWorkspaceSession();
  const [route, waiting] = await Promise.all([
    routeFor(prisma, client.id, { id: session.member.id, role: session.member.role }, "MANUAL"),
    prisma.journalApproval.findMany({ where: { clientId: client.id, status: "PENDING", source: { in: ["MANUAL", "REVERSAL"] } }, include: { entity: { select: { shortName: true, functionalCurrency: true } } }, orderBy: { createdAt: "desc" } }),
  ]);
  const { canWrite } = accessView(session);
  // Jurnal berulang: the client's templates, and the journals already repeated (no second *Ulangi* on them).
  const [recurring, repeated] = await Promise.all([
    recurringViews(prisma, client.id),
    prisma.recurringJournal.findMany({ where: { clientId: client.id, stoppedAt: null, sourceEntryId: { not: null } }, select: { sourceEntryId: true } }),
  ]);
  const repeatedIds = new Set(repeated.map((r) => r.sourceEntryId));
  const dimensions = await dimensionOptions(prisma, client.id);
  const activeTags = new Set([...dimensions.departments, ...dimensions.projects].map((d) => d.id));
  const tag = (id: string | null) => (id && activeTags.has(id) ? id : undefined); // an archived one is not copied: postJournal() refuses it
  const kotakHref = (d: Date) => withParams(`/clients/${client.id}/approvals`, { period: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, jenis: "kedua" });
  const recent = await prisma.journalEntry.findMany({
    where: { entity: { clientId: client.id }, kind: "ADJUSTMENT" },
    include: { entity: true, lines: true, reversedBy: { select: { date: true } } },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: 8,
  });
  // *Salin*: a manual journal of this client as the form's starting point (company, memo, lines and notes); the date stays the month's.
  const source = typeof sp.salin === "string" ? await prisma.journalEntry.findFirst({ where: { id: sp.salin, kind: "ADJUSTMENT", entity: { clientId: client.id } }, include: { entity: true, reversedBy: { select: { date: true } }, lines: { include: { account: true }, orderBy: { id: "asc" } } } }) : null;
  const copy: JournalCopy | undefined =
    source && !source.lines.some((l) => l.currency)
      ? {
          entityId: source.entityId,
          memo: source.memo,
          reverse: !!source.reversedBy && +source.reversedBy.date === +firstOfNextMonth(source.date),
          lines: [...source.lines]
            .sort((a, b) => Number(b.debit > 0n) - Number(a.debit > 0n))
            .map((l) => ({ accountCode: l.account.code, debit: l.debit > 0n ? formatMoney(l.debit, source.entity.functionalCurrency, { bare: true }) : "", credit: l.credit > 0n ? formatMoney(l.credit, source.entity.functionalCurrency, { bare: true }) : "", memo: l.memo ?? "", departmentId: tag(l.departmentId), projectId: tag(l.projectId) })),
        }
      : undefined;
  return (
    <div className="space-y-6">
      <PageHeader title="Jurnal Penyesuaian" description="Untuk yang tidak lewat bank: penyusutan, akrual, piutang." actions={<ScopeBar entities={[]} periods={periodOptions} period={period.key} />} />
      {locked ? (
        <NextStep href={closeHref} cta="Buka Tutup Buku">Buku {label} sudah ditutup, jadi jurnal bertanggal di bulan ini ditolak. Pilih bulan yang masih terbuka di kanan atas, atau minta admin membuka kembali {label} (dengan alasan).</NextStep>
      ) : due.length ? (
        <NextStep>Catat {due.length} jurnal terjadwal {label} di bawah, lalu tambahkan penyesuaian lain bila perlu.</NextStep>
      ) : accruals.length ? (
        <NextStep href={withParams(`/clients/${client.id}/approvals`, { period: period.key, jenis: "akrual" })} cta="Buka Kotak persetujuan">
          {accruals.length} usulan akrual dari riwayat vendor menunggu di Kotak persetujuan.
        </NextStep>
      ) : candidates.length ? (
        <NextStep>Buat jadwal untuk kandidat di bawah bila perlu, atau catat jurnal bebas.</NextStep>
      ) : (
        <NextStep>Pilih perusahaan dan tanggal, isi baris sampai debit dan kredit seimbang, lalu simpan.</NextStep>
      )}
      {due.length > 0 && <ScheduleProposals clientId={client.id} year={period.year} month={period.month} periodLabel={label} items={due} locked={locked} />}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="pt-6">
            {copy && <p className="mb-4 text-sm text-muted-foreground" data-testid="journal-copy">Disalin dari “{source!.memo}” ({formatDate(source!.date)}). Periksa tanggal dan nominalnya sebelum menyimpan.</p>}
            <JournalForm
              key={copy ? source!.id : "baru"}
              copy={copy}
              clientId={client.id}
              entities={entities}
              accounts={accounts.map((a) => ({ code: a.code, name: a.name, group: accountGroup(a), entityId: a.bankAccounts[0]?.entityId ?? null }))}
              defaultDate={toIsoDate(period.end)}
              lockedMonths={lockedMonths}
              closeHref={closeHref}
              route={route}
              dimensions={dimensions}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Terakhir dicatat</CardTitle>
            <CardDescription>Jurnal penyesuaian klien ini</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {waiting.map((a) => (
              <div key={a.id} className="flex justify-between gap-2" data-testid="journal-waiting">
                <div className="min-w-0">
                  <div className="truncate">{a.source === "REVERSAL" ? `Pembalik: ${a.memo}` : a.memo}</div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <StatusPill status="REVIEW" label="Menunggu persetujuan" />
                    <span>{formatDate(a.date)} · {a.entity.shortName}</span>
                    <Link href={kotakHref(a.date)} className="drill">Kotak persetujuan</Link>
                  </div>
                </div>
                <Money className="shrink-0" value={a.amount} currency={a.entity.functionalCurrency} />
              </div>
            ))}
            {recent.map((e) => (
              <div key={e.id} className="flex justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate">{e.memo}</div>
                  <div className="text-xs text-muted-foreground">
                    {e.number && <span className="num">{e.number} · </span>}{formatDate(e.date)} · {e.entity.shortName}
                    {e.reversedBy && ` · dibalik ${formatDate(e.reversedBy.date)}`}
                    {/* A foreign-currency journal is not copied: its rate must be typed again (the copy would open empty). */}
                    {!e.lines.some((l) => l.currency) && (
                      <>
                        {" · "}
                        <Link href={withParams(`/clients/${client.id}/journals/new`, { period: period.key, salin: e.id })} className="drill" aria-label={`Salin jurnal ${e.memo}`}>Salin</Link>
                        {/* *Ulangi tiap bulan*: not for a reversal, a schedule's or a template's instalment, or a journal already repeated. */}
                        {canWrite && !e.reversesId && !e.scheduleId && !e.recurringId && !repeatedIds.has(e.id) && (
                          <>
                            {" · "}
                            <RepeatJournal clientId={client.id} entryId={e.id} memo={e.memo} {...repeatFrom(e.date)} />
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <Money className="shrink-0" value={e.lines.reduce((s, l) => s + l.debit, 0n)} currency={e.entity.functionalCurrency} />
              </div>
            ))}
            {recent.length === 0 && waiting.length === 0 && <p className="text-muted-foreground">Belum ada jurnal penyesuaian untuk klien ini.</p>}
          </CardContent>
        </Card>
      </div>
      <RecurringList clientId={client.id} items={recurring} canWrite={canWrite} />
      <SchedulePanel clientId={client.id} entities={entities} accounts={accounts.filter((a) => !a.isBank && !a.isClearing).map((a) => ({ code: a.code, name: a.name, type: a.type, fsLine: a.fsLine }))} candidates={candidates} schedules={schedules} nextMonth={next} dimensions={dimensions} />
    </div>
  );
}
