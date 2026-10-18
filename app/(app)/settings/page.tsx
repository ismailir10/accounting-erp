import { accessibleClientWhere, accessView, requireWorkspaceSession, type WorkspaceSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { formatDate, formatDateTime } from "@/lib/format";
import { can } from "@/lib/auth/permissions";
import { compiledSentence, flagTitle, KIND_LABEL, ORIGIN_LABEL } from "@/lib/instructions/compile";
import { draftOf, listInstructions } from "@/lib/instructions/store";
import { InstructionEditor } from "@/components/app/instruction-editor";
import { InstructionList, type InstructionRow } from "@/components/app/instruction-list";
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
  const session = await requireWorkspaceSession();
  const { firm, member } = session;
  const isAdmin = isAdminRole(member.role);
  // Tim (ADR 0017 §5): owners and admins manage people here. Instruksi (cycle 2026-10-18-instruksi-kantor): every role, writers write.
  const asked = (await searchParams).tab;
  const tab = asked === "tim" && isAdmin ? "tim" : asked === "instruksi" ? "instruksi" : "umum";
  const tabs = (
    <LinkTabs
      label="Bagian pengaturan"
      items={[
        { href: "/settings", label: "Umum", active: tab === "umum" },
        { href: "/settings?tab=instruksi", label: "Instruksi", active: tab === "instruksi" },
        ...(isAdmin ? [{ href: "/settings?tab=tim", label: "Tim", active: tab === "tim" }] : []),
      ]}
    />
  );
  if (tab === "instruksi") {
    return (
      <div className="space-y-6">
        <PageHeader title="Pengaturan kantor" description="Berlaku untuk semua klien di kantor ini." />
        {tabs}
        <NextStep>Tulis kebiasaan kantor dalam satu kalimat. Buku menyusunnya menjadi aturan pasti; Anda memeriksa contohnya lalu menyetujui.</NextStep>
        <InstructionsSection session={session} />
      </div>
    );
  }
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

/**
 * Pengaturan kantor → Instruksi (cycle 2026-10-18-instruksi-kantor): the editor for members who may approve in at least one scope
 * (*Semua klien* for admins, their clients for writers), the list for everyone. Peninjau, a read-only organisation and a support
 * session read the list only.
 */
async function InstructionsSection({ session }: { session: WorkspaceSession }) {
  const { firm, member } = session;
  const writes = accessView(session).canWrite;
  const firmWide = writes && can(member.role, "org.settings");
  const perClient = writes && can(member.role, "books.write");
  const [clients, rows, cfg] = await Promise.all([
    prisma.client.findMany({ where: accessibleClientWhere(session), select: { id: true, name: true }, orderBy: { name: "asc" } }),
    listInstructions(prisma, firm.id, session.clientIds),
    resolveAiConfig(prisma),
  ]);
  const codes = [...new Set(rows.flatMap((r) => (r.accountCode ? [r.accountCode] : [])))];
  const names = new Map((await prisma.account.findMany({ where: { firmId: firm.id, code: { in: codes } }, distinct: ["code"], select: { code: true, name: true } })).map((a) => [a.code, a.name]));
  const scopes = [...(firmWide ? [{ value: "", label: "Semua klien" }] : []), ...(perClient ? clients.map((c) => ({ value: c.id, label: c.name })) : [])];
  const view = rows.map((r): InstructionRow => {
    const d = draftOf(r);
    return {
      id: r.id,
      sentence: r.sentence,
      compiled: compiledSentence(d, { accountName: d.accountCode ? names.get(d.accountCode) : null, firmWide: !r.clientId }),
      eyebrow: `${KIND_LABEL[d.kind]} · ${r.client?.name ?? "Semua klien"}`,
      approved: `Disetujui ${formatDate(r.approvedAt)} oleh ${r.approvedBy?.name ?? "anggota yang sudah dihapus"} · ${ORIGIN_LABEL[r.origin]}`,
      off: r.offAt && `Dimatikan ${formatDate(r.offAt)} oleh ${r.offBy?.name ?? "anggota yang sudah dihapus"}`,
      stops:
        d.kind === "ACCOUNT" ? `Aturan "${d.pattern}" → ${d.accountCode} dihapus, jadi impor berikutnya memakai aturan lain.`
        : d.kind === "FLAG" ? `Kontrol "${flagTitle(d)}" hilang dari bulan yang belum dikunci.`
        : `Impor berikutnya tidak lagi menahan mutasi yang memuat "${d.pattern}".`,
      canTurnOff: r.clientId ? perClient : firmWide,
    };
  });
  return (
    <>
      {scopes.length > 0 && <InstructionEditor scopes={scopes} aiAvailable={Boolean(cfg.apiKey && cfg.model)} />}
      <InstructionList active={view.filter((r) => !r.off)} off={view.filter((r) => r.off)} />
    </>
  );
}
