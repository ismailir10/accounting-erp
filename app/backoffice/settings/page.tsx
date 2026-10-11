import { PageHeader, NextStep } from "@/components/app/page-header";
import { AiSettingsForm } from "@/components/app/ai-settings-form";
import { OcrSettingCard } from "@/components/app/ocr-setting";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { prisma } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { resolveAiConfig } from "@/lib/settings/ai";
import { settingsSecretConfigured } from "@/lib/settings/secret";
import { ocrEnabled } from "@/lib/ocr/draft";
import { aiConfig } from "@/lib/ai/provider";

export const metadata = { title: "Pengaturan AI" };

/** Buku's AI provider and OCR switch (ADR 0017 §6): one key for every organisation, changed only here. */
export default async function BackofficeSettingsPage() {
  await requirePlatformAdmin();
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const [cfg, lastCall, ocr, used] = await Promise.all([
    resolveAiConfig(prisma),
    prisma.aiUsage.findFirst({ where: { model: { not: "demo-seed" } }, orderBy: { at: "desc" } }),
    ocrEnabled(prisma),
    prisma.aiUsage.aggregate({ where: { at: { gte: monthStart } }, _sum: { promptTokens: true, completionTokens: true } }),
  ]);
  const secretReady = settingsSecretConfigured();
  const live = Boolean(cfg.apiKey && cfg.model);
  return (
    <div className="space-y-6">
      <PageHeader title="Pengaturan AI" description="Kunci, model dan izin baca scan untuk semua organisasi." />
      {!secretReady ? (
        <NextStep>Kunci keamanan server (SETTINGS_SECRET) belum disiapkan, jadi kunci AI belum bisa disimpan.</NextStep>
      ) : cfg.keyError ? (
        <NextStep>{cfg.keyError}</NextStep>
      ) : !live ? (
        <NextStep>Tempel kunci API dan pilih model untuk menyalakan usulan AI. Tanpa kunci, Buku tetap bekerja dengan aturan.</NextStep>
      ) : (
        <NextStep tone="done">Usulan AI aktif untuk semua organisasi, dalam batas token bulanan masing-masing.</NextStep>
      )}
      <AiSettingsForm
        status={{
          live,
          keyLast4: cfg.keyLast4,
          keySource: cfg.keySource,
          model: cfg.model || null,
          modelSource: cfg.modelSource,
          gatewayHost: new URL(cfg.baseUrl).host,
          maxCallsPerRun: cfg.maxCallsPerRun,
          monthlyTokensUsed: (used._sum.promptTokens ?? 0) + (used._sum.completionTokens ?? 0),
          defaultTokenBudget: aiConfig().monthlyTokenBudget,
          lastCall: lastCall && { at: formatDateTime(lastCall.at), ok: lastCall.ok, model: lastCall.model, note: lastCall.note },
        }}
        canSave={secretReady}
      />
      <OcrSettingCard enabled={ocr} canSave aiLive={live} />
    </div>
  );
}
