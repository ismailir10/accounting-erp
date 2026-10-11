import { prisma } from "@/lib/db";
import { loadClientPage } from "@/lib/client-page";
import { withParams, type SearchParams } from "@/lib/scope";
import { resolveAiConfig } from "@/lib/settings/ai";
import { automationByMonth } from "@/lib/queries";
import { firmTokenBudget } from "@/lib/ai/budget";
import { TAX_TAG_LABEL } from "@/lib/coa/template";
import { formatMonthShort } from "@/lib/format";
import { NextStep, PageHeader, Stat } from "@/components/app/page-header";
import { StatusPill } from "@/components/app/status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isGenericKey } from "@/lib/import/normalize";
import { LinkTabs } from "@/components/app/link-tabs";
import { EntitiesCard } from "@/components/app/entities-card";
import { requireWorkspaceSession } from "@/lib/auth/session";
import { DeleteClientCard } from "@/components/app/delete-client";
import { FrameworkCard } from "@/components/app/framework-card";
import { ReportFormatCard } from "@/components/app/report-format-card";
import { FiscalYearCard } from "@/components/app/fiscal-year-card";
import { loadReportFormat } from "@/lib/reports/format";
import { formatUniverse } from "@/lib/reports/format-settings";
import { ModulesCard } from "@/components/app/modules-card";
import { clientModules, MODULES } from "@/lib/clients/modules";
import { can, isAdminRole } from "@/lib/auth/permissions";
import { keyringSize } from "@/lib/inbox/keyring";
import { PdfKeyringCard } from "@/components/app/pdf-keyring-card";

export const metadata = { title: "Pengaturan klien" };

const TABS = [
  { key: "perusahaan", label: "Perusahaan & laporan", next: "Pastikan perusahaan, rekening bank dan kerangka pelaporan sudah benar sebelum menutup buku." },
  { key: "klasifikasi", label: "Klasifikasi & AI", next: "Tambahkan aturan untuk transaksi yang selalu masuk ke akun yang sama. Aturan dipakai sebelum AI." },
] as const;

export default async function SettingsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { client, sp } = await loadClientPage(params, searchParams);
  const { member, firm } = await requireWorkspaceSession();
  const [rules, memories, auto, usage, cacheSize, cfg, reportFormat, lockedPeriod] = await Promise.all([
    prisma.rule.findMany({ where: { firmId: client.firmId, OR: [{ clientId: client.id }, { clientId: null }] }, orderBy: [{ clientId: "asc" }, { priority: "asc" }] }),
    prisma.memory.findMany({ where: { clientId: client.id }, orderBy: { hits: "desc" }, take: 40 }).then((ms) => ms.filter((m) => !isGenericKey(m.merchantKey)).slice(0, 15)),
    automationByMonth([client.id]),
    prisma.aiUsage.aggregate({ where: { firmId: client.firmId }, _sum: { calls: true, promptTokens: true, completionTokens: true, keysRequested: true } }),
    prisma.aiSuggestion.count(),
    resolveAiConfig(prisma),
    loadReportFormat(prisma, client.id),
    prisma.period.findFirst({ where: { clientId: client.id, status: "LOCKED" }, select: { id: true } }),
  ]);
  const { custom: customFormat, stale: staleFormat, ...formatValue } = reportFormat;
  const mods = (await clientModules(prisma, client.firmId)).get(client.id) ?? { enabled: [], inUse: [], visible: [] };
  const accounts = new Map((await prisma.account.findMany({ where: { clientId: client.id } })).map((a) => [a.code, a.name]));
  const clientRules = rules.filter((r) => r.clientId);
  const firmRules = rules.filter((r) => !r.clientId);
  const tab = TABS.find((t) => t.key === sp.tab) ?? TABS[0];
  // Admin-only like its actions (org.settings, ADR 0018): other members neither see the card nor load the count.
  const keyringCount = tab.key === "perusahaan" && can(member.role, "org.settings") ? await keyringSize(prisma, client.id) : null;
  const live = Boolean(cfg.apiKey && cfg.model);
  const lastMonth = auto[auto.length - 1];
  const aiLines = auto.reduce((s, a) => s + a.ai, 0);
  const total = auto.reduce((s, a) => s + a.total, 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Pengaturan klien" description="Perusahaan dan rekening, kerangka pelaporan, lalu aturan klasifikasi." />
      <LinkTabs label="Bagian pengaturan" items={TABS.map((t) => ({ href: withParams(`/clients/${client.id}/settings`, t.key === TABS[0].key ? {} : { tab: t.key }), label: t.label, active: t.key === tab.key }))} />
      <NextStep>{tab.next}</NextStep>
      {tab.key === "perusahaan" ? (
        <>
          <EntitiesCard clientId={client.id} entities={client.entities.map((e) => ({ id: e.id, name: e.name, kind: e.kind, banks: e.bankAccounts.map((b) => ({ id: b.id, label: b.label, number: b.number, code: b.account.code, isOverdraft: b.isOverdraft })) }))} />
          <FrameworkCard clientId={client.id} entities={client.entities.map((e) => ({ id: e.id, name: e.name, framework: e.reportingFramework }))} />
          <FiscalYearCard clientId={client.id} endMonth={client.fiscalYearEndMonth} locked={Boolean(lockedPeriod)} />
          <ModulesCard
            clientId={client.id}
            modules={MODULES.map(({ key, label, description }) => ({ key, label, description }))}
            enabled={mods.enabled}
            inUse={mods.inUse}
            defaults={mods.visible.filter((k) => !mods.enabled.includes(k) && !mods.inUse.includes(k))}
          />
          {/* Keyed on what's saved: after a save or a reset the editor starts again from the server's format. */}
          <ReportFormatCard key={JSON.stringify(reportFormat)} clientId={client.id} initial={formatValue} custom={customFormat} stale={staleFormat} universe={formatUniverse()} />
          {keyringCount !== null && <PdfKeyringCard clientId={client.id} count={keyringCount} />}
          {isAdminRole(member.role) && firm.kind !== "PERUSAHAAN" && <DeleteClientCard clientId={client.id} name={client.name} />}
        </>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Status AI" value={<StatusPill status={live ? "PASS" : "REVIEW"} label={live ? "Aktif" : "Aturan saja"} />} hint={live ? `Model ${cfg.model}` : "Diatur oleh Buku"} />
            <Stat label="Dikode tanpa AI" value={`${total ? Math.round(((total - aiLines) / total) * 100) : 0}%`} hint={`${total} baris sejak awal`} />
            <Stat label="Panggilan AI (total)" value={usage._sum.calls ?? 0} hint={`${((usage._sum.promptTokens ?? 0) + (usage._sum.completionTokens ?? 0)).toLocaleString("id-ID")} token`} />
            <Stat label="Jawaban AI tersimpan" value={cacheSize} hint="Penerima atau pengirim yang sama tidak ditanyakan lagi" />
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Batas pemakaian</CardTitle>
              <CardDescription>
                Maks. {cfg.maxCallsPerRun} panggilan per proses · {(await firmTokenBudget(prisma, client.firmId)).toLocaleString("id-ID")} token per bulan untuk kantor ini.
                {lastMonth && ` Bulan terakhir: ${lastMonth.pct}% dikode otomatis (${formatMonthShort(Number(lastMonth.ym.slice(0, 4)), Number(lastMonth.ym.slice(5)))}).`}
              </CardDescription>
            </CardHeader>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Aturan klien</CardTitle>
                <CardDescription>Didahulukan dari aturan kantor. Tambah dari halaman Review dengan “Selalu gunakan akun ini”.</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <RuleTable rules={clientRules} accounts={accounts} />
                <Collapsible className="border-t">
                  <CollapsibleTrigger className="group flex w-full items-center gap-1 px-6 py-3 text-left text-sm font-medium text-primary hover:underline">
                    <ChevronRight className="size-4 transition-transform group-data-[panel-open]:rotate-90" aria-hidden />
                    Aturan kantor ({firmRules.length})
                    <span className="font-normal text-muted-foreground">· berlaku untuk semua klien</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <RuleTable rules={firmRules} accounts={accounts} />
                  </CollapsibleContent>
                </Collapsible>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Pilihan yang diingat</CardTitle>
                <CardDescription>Dipelajari dari keputusan reviewer dan dipakai sebelum AI.</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <Table>
                  <TableHeader>
                    <TableRow><TableHead className="pl-6">Penerima / pengirim</TableHead><TableHead>Akun</TableHead><TableHead className="pr-6 text-right">Dikonfirmasi</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {memories.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="pl-6 font-mono text-xs whitespace-normal">{m.merchantKey}</TableCell>
                        <TableCell className="whitespace-normal">{m.accountCode} {accounts.get(m.accountCode)}</TableCell>
                        <TableCell className="num pr-6 text-right">{m.hits}×</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {memories.length === 0 && <p className="px-6 py-4 text-sm text-muted-foreground">Belum ada pilihan yang diingat. Buku mengingat akun yang Anda pilih saat mereview transaksi.</p>}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function RuleTable({ rules, accounts }: { rules: { id: string; pattern: string; direction: string | null; accountCode: string; taxTag: keyof typeof TAX_TAG_LABEL | null; source: string }[]; accounts: Map<string, string> }) {
  if (rules.length === 0) return <p className="px-6 py-4 text-sm text-muted-foreground">Belum ada aturan khusus untuk klien ini.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow><TableHead className="pl-6">Keterangan mengandung</TableHead><TableHead>Arah</TableHead><TableHead className="pr-6">Akun</TableHead></TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="pl-6 font-mono text-xs whitespace-normal">{r.pattern}{r.source === "USER" && <span className="ml-2 font-sans text-muted-foreground">(dari review)</span>}</TableCell>
            <TableCell className="text-muted-foreground">{r.direction === "IN" ? "Masuk" : r.direction === "OUT" ? "Keluar" : "Semua"}</TableCell>
            <TableCell className="pr-6 whitespace-normal">{r.accountCode} {accounts.get(r.accountCode)}{r.taxTag && <span className="text-xs text-muted-foreground"> · {TAX_TAG_LABEL[r.taxTag]}</span>}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
