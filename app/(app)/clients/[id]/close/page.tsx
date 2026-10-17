import { prisma } from "@/lib/db";
import { loadClientPage } from "@/lib/client-page";
import type { SearchParams } from "@/lib/scope";
import { CLOSE_SIGNOFFS, closeReadiness, earlierOpenMonth, laterLockedMonth, runControls } from "@/lib/controls";
import { accessView, requireWorkspaceSession } from "@/lib/auth/session";
import { formatDate, formatDateTime, formatPeriod } from "@/lib/format";
import { NextStep, PageHeader } from "@/components/app/page-header";
import { setupProgress } from "@/lib/setup-progress";
import { ScopeBar } from "@/components/app/scope-bar";
import { ClosePanel } from "@/components/app/close-panel";
import { RevaluationCard } from "@/components/app/revaluation-card";
import { ScheduleProposals } from "@/components/app/schedule-proposals";
import { proposalViews } from "@/lib/adjust/view";
import { correctionViews as draftViews } from "@/lib/adjust/suspense";
import { ProposalsCard } from "@/components/app/proposals-card";
import { revaluationProposals } from "@/lib/fx/revalue";
import { CloseReviewCard } from "@/components/app/close-review-card";
import { cachedCloseReview } from "@/lib/controls/ai-review";
import { resolveAiConfig } from "@/lib/settings/ai";
import { createHash } from "node:crypto";
import { listFindings } from "@/lib/findings";
import { openingTargetOptions } from "@/lib/coa/options";
import { FindingsCard } from "@/components/app/findings-card";
import { completenessMatrix } from "@/lib/controls/completeness";
import { CompletenessCard } from "@/components/app/completeness-card";
import { CloseHistoryCard } from "@/components/app/close-history-card";
import { HISTORY_MIN_MONTHS, historyMonths } from "@/lib/controls/history";
import { isAdminRole } from "@/lib/auth/permissions";
import { checklistMonth, sumberOf, unfinishedBeforeLock } from "@/lib/checklist/view";
import { tickProblem } from "@/lib/checklist/rules";
import { LOCKED_SIGNOFF } from "@/lib/checklist/write";
import { withParams } from "@/lib/scope";

export const metadata = { title: "Tutup Buku" };

export default async function ClosePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { client, period, periodOptions, base } = await loadClientPage(params, searchParams);
  const controls = await runControls(prisma, client.id, period.year, period.month);
  const setup = await setupProgress(prisma, client.id);
  const p = await prisma.period.findUnique({ where: { clientId_year_month: { clientId: client.id, year: period.year, month: period.month } }, include: { signoffs: { include: { doneBy: { select: { name: true } } } }, lockedBy: { select: { name: true } } } });
  const done = p?.signoffs.map((s) => s.key) ?? [];
  const r = closeReadiness(controls, done);
  // One line per kind of blocker, not one per control — the list on the left already has the detail.
  const blockers = [
    r.fails.length ? `${r.fails.length} kontrol gagal, perbaiki dulu` : "",
    r.unacked.length ? `${r.unacked.length} kontrol perlu dicek dan diberi catatan` : "",
    r.missing.length ? `${r.missing.length} checklist belum dicentang` : "",
  ].filter(Boolean);
  const label = formatPeriod(period.year, period.month);
  // Closing goes in order, reopening in reverse; only an admin reopens, with a reason that stays in the log.
  const [before, after, session, unlockRows] = await Promise.all([
    earlierOpenMonth(prisma, client.id, period.year, period.month),
    laterLockedMonth(prisma, client.id, period.year, period.month),
    requireWorkspaceSession(),
    prisma.periodUnlockLog.findMany({ where: { clientId: client.id }, orderBy: { createdAt: "desc" }, take: 5, include: { unlockedBy: { select: { name: true } } } }),
  ]);
  const { member } = session;
  if (before) blockers.unshift(`Tutup buku ${formatPeriod(before.year, before.month)} dulu, bulan sebelumnya masih terbuka`);
  const open = controls.find((c) => c.key === "suspense" && c.status === "REVIEW");
  const missing = controls.find((c) => c.key.startsWith("bank:") && c.detail.includes("belum diimpor"));
  const locked = p?.status === "LOCKED";
  const reval = await revaluationProposals(prisma, client.id, period.year, period.month);
  const scheduled = locked ? [] : await proposalViews(prisma, client.id, period.year, period.month);
  const drafts = locked ? [] : await draftViews(prisma, client.id, period.year, period.month);
  const chart = drafts.length ? (await prisma.account.findMany({ where: { clientId: client.id, isBank: false }, select: { code: true, name: true }, orderBy: { code: "asc" } })) : [];
  const flagged = controls.filter((c) => c.status !== "PASS").length;
  const ai = await resolveAiConfig(prisma);
  const aiModel = ai.apiKey && ai.model ? ai.model : null;
  // Remount the review card whenever the flagged set changes, so a stale review never stays on screen.
  const reviewKey = createHash("sha1").update(controls.filter((c) => c.status !== "PASS").map((c) => `${c.key}|${c.detail}`).join("\n")).digest("hex");
  const review = !locked && flagged ? await cachedCloseReview(prisma, client.firmId, client.id, period.year, period.month, aiModel, controls) : null;

  const findings = await listFindings(prisma, client.id);
  const completeness = await completenessMatrix(prisma, client.id, period.year, period.month);
  // Only an opening difference holds the close; a subledger difference is a REVIEW control explained under Rekonsiliasi.
  const openFindings = findings.filter((f) => f.status === "OPEN" && f.kind === "OPENING_DIFFERENCE");
  const targets = openFindings.length ? openingTargetOptions(await prisma.account.findMany({ where: { clientId: client.id }, orderBy: { code: "asc" } })) : [];

  // Many open months before this one (a migrated history): checked and closed together from here.
  const history = before ? await historyMonths(prisma, client.id, period) : [];
  const historyRange = history.length ? `${formatPeriod(history[0].year, history[0].month)} – ${formatPeriod(history.at(-1)!.year, history.at(-1)!.month)}` : "";
  const monthKey = (m: { year: number; month: number }) => `${m.year}-${String(m.month).padStart(2, "0")}`;
  // Checklist tutup buku: the sign-offs follow their task's Pelaksana once the month's checklist has them; the unfinished tasks warn
  // the lock, never block it (accounting-rules 23 is unchanged). *Tutup buku* and *Laporan dikirim* can't be done before the lock.
  const checklist = await checklistMonth(prisma, { clientId: client.id, year: period.year, month: period.month, facts: { controls, sumber: sumberOf(completeness, period.year, period.month) } });
  const checklistHref = withParams(`${base}/checklist`, { period: period.key });
  const checklistOpen = unfinishedBeforeLock(checklist.rows);
  const access = accessView({ access: session.access, member, support: session.support });
  const signoffTask = (key: string) => checklist.rows.find((r) => r.kind === "SIGNOFF" && r.key === key);
  const signoffBlock = (key: string): string | null => {
    const task = signoffTask(key);
    if (!access.canWrite) return access.reason;
    if (!task) return null;
    if (locked) return LOCKED_SIGNOFF;
    if (task.status === "DIREVIU") return "Sudah direviu. Batalkan reviunya di checklist dulu untuk mengubah.";
    if (!task.done && task.gone.assignee) return task.problem;
    return tickProblem(member, { assigneeId: task.assignee.id });
  };
  return (
    <div className="space-y-6">
      <PageHeader title="Tutup Buku" description={`${label}`} actions={<ScopeBar entities={[]} periods={periodOptions} period={period.key} />} />
      {locked ? (
        <NextStep tone="done">Buku {label} sudah ditutup. Laporan siap dikirim ke klien.</NextStep>
      ) : before ? (
        <NextStep href={`${base}/close?period=${monthKey(before)}`} cta={`Buka ${formatPeriod(before.year, before.month)}`}>Tutup buku {formatPeriod(before.year, before.month)} dulu. Penutupan berurutan dari bulan paling awal{history.length >= HISTORY_MIN_MONTHS ? `; ${history.length} bulan sebelumnya bisa ditutup sekaligus di bawah` : ""}.</NextStep>
      ) : setup.current === "opening" && setup.next ? (
        <NextStep href={setup.next.href} cta={setup.next.cta}>{setup.next.text}</NextStep>
      ) : openFindings.length ? (
        <NextStep>Putuskan {openFindings.length === 1 ? `temuan ${openFindings[0].label}` : `${openFindings.length} temuan`} di bawah: tulis asal selisih saldo awal dan pilih akunnya. Tutup buku tertahan sampai itu selesai.</NextStep>
      ) : missing ? (
        <NextStep href={`${base}/import`} cta="Impor mutasi">{missing.title.replace("Rekonsiliasi", "Mutasi")} belum diimpor. Beberapa kontrol baru bisa lolos setelah mutasinya masuk.</NextStep>
      ) : open ? (
        <NextStep href={`${base}/review`} cta="Review transaksi">{open.detail}.</NextStep>
      ) : r.unacked.length ? (
        <NextStep>Cek kontrol yang ditandai “Perlu dicek”, lalu beri catatan kenapa wajar.</NextStep>
      ) : r.missing.length ? (
        <NextStep>Centang checklist di kanan setelah Anda memeriksanya.</NextStep>
      ) : (
        <NextStep>Semua kontrol lolos dan checklist lengkap. Tutup buku {label}.</NextStep>
      )}
      {!locked && history.length >= HISTORY_MIN_MONTHS && (
        <CloseHistoryCard
          clientId={client.id}
          year={period.year}
          month={period.month}
          periodLabel={label}
          count={history.length}
          range={historyRange}
          signoffs={CLOSE_SIGNOFFS.map((s) => ({ key: s.key, label: s.label }))}
          isAdmin={isAdminRole(member.role)}
          base={base}
        />
      )}
      {findings.length > 0 && (
        <div id="temuan" className="scroll-mt-20">
          <FindingsCard
            clientId={client.id}
            accounts={targets}
            items={findings.map((f) => ({
              id: f.id,
              kind: f.kind,
              href: `${base}/receivables?tab=rekonsiliasi`,
              label: f.label,
              entity: f.entity,
              currency: f.currency,
              amount: f.amount.toString(),
              date: formatDate(f.date),
              question: f.question,
              status: f.status,
              opened: `${formatDateTime(f.createdAt)}${f.openedBy ? ` oleh ${f.openedBy}` : ""}`,
              resolution: f.resolution,
              resolved: f.resolvedAt ? `${formatDateTime(f.resolvedAt)}${f.resolvedBy ? ` oleh ${f.resolvedBy}` : ""}` : null,
              resolvedTo: f.resolvedTo,
            }))}
          />
        </div>
      )}
      {completeness.rows.length > 0 && <CompletenessCard months={completeness.months} rows={completeness.rows} importHref={`${base}/import`} />}
      {reval.length > 0 && (
        <RevaluationCard
          clientId={client.id}
          year={period.year}
          month={period.month}
          periodLabel={label}
          locked={locked}
          proposals={reval.map((r) => ({
            entityId: r.entityId,
            entityName: r.entityName,
            functional: r.functional,
            missingRates: r.missingRates,
            lines: r.lines.map((l) => ({ code: l.code, name: l.name, currency: l.currency, fxBalance: l.fxBalance.toString(), carried: l.carried.toString(), target: l.target.toString(), diff: l.diff.toString(), rate: l.rate })),
          }))}
        />
      )}
      {drafts.length > 0 && <ProposalsCard clientId={client.id} periodLabel={label} items={drafts} accounts={chart} locked={locked} />}
      {scheduled.length > 0 && <ScheduleProposals clientId={client.id} year={period.year} month={period.month} periodLabel={label} items={scheduled} locked={locked} />}
      {!locked && flagged > 0 && aiModel !== null && <CloseReviewCard key={`${period.key}:${reviewKey}`} clientId={client.id} year={period.year} month={period.month} flagged={flagged} aiReady={aiModel !== null} initial={review} />}
      <ClosePanel
        clientId={client.id}
        year={period.year}
        month={period.month}
        periodLabel={label}
        controls={controls}
        signoffs={CLOSE_SIGNOFFS.map((s) => { const row = p?.signoffs.find((x) => x.key === s.key); return { key: s.key, label: s.label, done: Boolean(row), by: row ? `${row.doneBy?.name ?? "Sistem"} · ${formatDateTime(row.doneAt)}` : null, pelaksana: signoffTask(s.key)?.assignee.name ?? null, blocked: signoffBlock(s.key) }; })}
        checklist={checklist.hasTemplate && checklist.rows.length ? { href: checklistHref, open: checklistOpen } : null}
        locked={locked}
        lockedAt={p?.lockedAt ? `${formatDateTime(p.lockedAt)} oleh ${p.lockedBy?.name ?? "Sistem"}` : null}
        blockers={blockers}
        aiReady={aiModel !== null}
        isAdmin={isAdminRole(member.role)}
        unlockBlocker={after ? `Buka kembali ${formatPeriod(after.year, after.month)} dulu: bulan setelahnya masih ditutup.` : null}
        unlocks={unlockRows.map((u) => ({ label: `${formatPeriod(u.year, u.month)} dibuka kembali`, reason: u.reason, by: `${u.unlockedBy.name} · ${formatDateTime(u.createdAt)}` }))}
      />
    </div>
  );
}
