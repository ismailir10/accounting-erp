import { requireWorkspaceSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { resolveAiConfig } from "@/lib/settings/ai";
import { monthlyAiUse } from "@/lib/ai/budget";
import { PageHeader, NextStep } from "@/components/app/page-header";
import { AiStatusCard } from "@/components/app/ai-status-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { planRejections } from "@/lib/evidence/plan-stats";
import { ocrEnabled } from "@/lib/ocr/draft";
import { OcrSettingCard } from "@/components/app/ocr-setting";
import { AutomationCard } from "@/components/app/automation-card";
import { lastAutomationChange, readAutomation } from "@/lib/settings/automation";
import { ApprovalsCard } from "@/components/app/approvals-card";
import { activeAdminCount, lastApprovalsChange, readApprovals } from "@/lib/settings/approvals";
import { isAdminRole } from "@/lib/auth/permissions";
import { LinkTabs } from "@/components/app/link-tabs";
import { TeamCard } from "@/components/app/team-card";
import { listTeam } from "@/lib/team";
import type { SearchParams } from "@/lib/scope";

export const metadata = { title: "Pengaturan kantor" };

export default async function SettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const { firm, member } = await requireWorkspaceSession();
  const isAdmin = isAdminRole(member.role);
  // Tim (ADR 0017 §5): owners and admins manage people here; other roles see only the general section.
  const tab = (await searchParams).tab === "tim" && isAdmin ? "tim" : "umum";
  const tabs = isAdmin ? <LinkTabs label="Bagian pengaturan" items={[{ href: "/settings", label: "Umum", active: tab === "umum" }, { href: "/settings?tab=tim", label: "Tim", active: tab === "tim" }]} /> : null;
  if (tab === "tim") {
    const team = await listTeam(prisma, firm.id);
    return (
      <div className="space-y-6">
        <PageHeader title="Pengaturan kantor" description="Berlaku untuk semua klien di kantor ini." />
        {tabs}
        <NextStep>{team.kind === "PERUSAHAAN" ? "Undang anggota tim dan pilih perannya." : "Undang anggota tim, pilih perannya, lalu tugaskan klien untuk akuntan dan peninjau."}</NextStep>
        <TeamCard
          members={team.members.map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, disabled: m.disabled, clientIds: m.clientAccess.map((a) => a.clientId) }))}
          clients={team.clients}
          me={{ id: member.id, role: member.role }}
          company={team.kind === "PERUSAHAAN"}
          seatLimit={team.seatLimit}
        />
      </div>
    );
  }
  const [cfg, lastCall, plans, ocr, automation, automationChange] = await Promise.all([resolveAiConfig(prisma), prisma.aiUsage.findFirst({ where: { firmId: firm.id, model: { not: "demo-seed" } }, orderBy: { at: "desc" } }), planRejections(prisma, firm.id), ocrEnabled(prisma), readAutomation(prisma, firm.id), lastAutomationChange(prisma, firm.id)]);
  const [approvals, approvalsChange, admins] = await Promise.all([readApprovals(prisma, firm.id), lastApprovalsChange(prisma, firm.id), activeAdminCount(prisma, firm.id)]);
  const live = Boolean(cfg.apiKey && cfg.model);
  const use = await monthlyAiUse(prisma, firm.id);

  return (
    <div className="space-y-6">
      <PageHeader title="Pengaturan kantor" description="Berlaku untuk semua klien di kantor ini." />
      {tabs}
      {live ? (
        <NextStep tone="done">Usulan AI aktif. Semua usulan tetap masuk Review transaksi sebelum dicatat.</NextStep>
      ) : (
        <NextStep>Usulan AI belum aktif, jadi Buku bekerja dengan aturan saja. Hubungi Buku untuk menyalakannya.</NextStep>
      )}
      <AiStatusCard live={live} model={cfg.model || null} used={use.spent} limit={use.limit} lastCall={lastCall && { at: formatDateTime(lastCall.at), ok: lastCall.ok }} />
      {/* Keyed by the saved values: after a save the form restarts from what was stored (amounts regrouped). */}
      <AutomationCard
        key={[automation.transfer, automation.rules, automation.memory, automation.cap, automation.fluxFloor, automation.fluxPercent].join("|")}
        settings={{ ...automation, cap: automation.cap?.toString() ?? null, fluxFloor: automation.fluxFloor?.toString() ?? null }}
        canSave={isAdmin}
        lastChange={automationChange && { at: formatDateTime(automationChange.at), actor: automationChange.actor }}
      />
      {/* Otomasi decides what may skip you; Persetujuan kedua decides what needs two of you. */}
      <ApprovalsCard
        key={[approvals.manual, approvals.manualAbove, approvals.aiDraft, approvals.aiDraftAbove, approvals.reopen].join("|")}
        settings={{ ...approvals, manualAbove: approvals.manualAbove?.toString() ?? null, aiDraftAbove: approvals.aiDraftAbove?.toString() ?? null }}
        canSave={isAdmin}
        singleAdmin={admins < 2}
        lastChange={approvalsChange && { at: formatDateTime(approvalsChange.at), actor: approvalsChange.actor }}
      />
      <OcrSettingCard enabled={ocr} canSave={false} aiLive={live} />
      <Card>
        <CardHeader>
          <CardTitle>Rencana jawaban AI</CardTitle>
          <CardDescription>Pertanyaan di Dokumen memakai AI untuk merencanakan pencarian. Rencana yang tidak valid ditolak dan diganti pencarian biasa.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm" data-testid="plan-rejections">
          {plans.requested === 0
            ? `Belum ada rencana jawaban AI dalam ${plans.days} hari terakhir.`
            : `${plans.days} hari terakhir: ${plans.requested} rencana diminta, ${plans.rejected} ditolak (${Math.round(plans.rate * 100)}%).`}
        </CardContent>
      </Card>
    </div>
  );
}
