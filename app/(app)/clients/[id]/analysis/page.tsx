import Link from "next/link";
import { ChevronRight, Download } from "lucide-react";
import { prisma } from "@/lib/db";
import { loadClientPage } from "@/lib/client-page";
import { type SearchParams, withParams } from "@/lib/scope";
import { formatDateTime, formatPeriod, monthName } from "@/lib/format";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NextStep, PageHeader } from "@/components/app/page-header";
import { ScopeBar } from "@/components/app/scope-bar";
import { LinkTabs } from "@/components/app/link-tabs";
import { RatioTable, TrendTable } from "@/components/app/trend-table";
import { MarginCard, MoverRow, TrendCard } from "@/components/app/insights";
import { currencyNote, FxMissing, withFx } from "@/components/app/fx-missing";
import { FxMissingError } from "@/lib/reports/fx";
import { monthlyBalance, monthlyIncome, ratios } from "@/lib/reports/analysis";
import { figuresOf, margins, topMovers, trend } from "@/lib/reports/insights";
import { FLUX_PERCENT, MATERIALITY_PERCENT } from "@/lib/controls/anomaly";
import { managementSummary } from "@/lib/reports/management";
import { fluxExplanations } from "@/lib/reports/flux-explanation";
import { resolveAiConfig } from "@/lib/settings/ai";
import { accessView, requireWorkspaceSession } from "@/lib/auth/session";
import { FluxExplanationCard } from "@/components/app/flux-explanation";

export const metadata = { title: "Analisis keuangan" };

const TABS = [
  { key: "pl", label: "Laba Rugi per bulan" },
  { key: "bs", label: "Neraca per bulan" },
  { key: "rasio", label: "Rasio keuangan" },
  { key: "wawasan", label: "Wawasan" },
] as const;

/**
 * Analisis keuangan: the financial year to date month by month — Laba Rugi, Neraca, the usual ratios — from the same statements as
 * Laporan Keuangan (lib/reports/analysis.ts), and *Wawasan*: what changed this month and which accounts moved it (lib/reports/insights.ts).
 * One tab on screen at a time (`?tab=`).
 */
export default async function AnalysisPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { client, period, scope, periodOptions, entityOptions, base, scopeLabel, currency, mixed, sp } = await loadClientPage(params, searchParams);
  const tab = TABS.find((t) => t.key === sp.tab) ?? TABS[0];
  const q = { period: period.key, entity: scope.value };
  const s = { clientId: client.id, entityIds: scope.entityIds };
  const note = currencyNote(currency, mixed);
  const tabHref = (key: string) => withParams(`${base}/analysis`, { ...q, tab: key === "pl" ? undefined : key });
  const header = (
    <>
      <PageHeader
        title="Analisis keuangan"
        description={`${scopeLabel} · tahun buku s.d. ${formatPeriod(period.year, period.month)}${note ? ` · ${note}` : ""}`}
        actions={<ScopeBar entities={entityOptions} periods={periodOptions} entity={scope.value} period={period.key} />}
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <LinkTabs label="Analisis" items={TABS.map((t) => ({ href: tabHref(t.key), label: t.label, active: t.key === tab.key }))} />
        {currency === "IDR" && (
          <a href={withParams(`${base}/analysis/export`, q)} className={buttonVariants({ variant: "outline" })} download data-testid="analysis-download">
            <Download /> Unduh Excel
          </a>
        )}
      </div>
    </>
  );
  const data = await withFx(async () => {
    const pl = await monthlyIncome(prisma, s, period.year, period.month);
    const bs = tab.key === "pl" || tab.key === "wawasan" ? null : await monthlyBalance(prisma, s, period.year, period.month);
    return { pl, bs };
  });
  if (data instanceof FxMissingError) return <div className="space-y-6">{header}<FxMissing error={data} base={base} /></div>;
  const href = (code: string) => withParams(`${base}/ledger/${code}`, q);
  const { pl, bs } = data;

  if (tab.key === "wawasan") {
    const figures = pl.statements.map(figuresOf);
    const t = trend(pl.months, figures, currency);
    // Movers are per company, as the flux scan and the management pack are; a group view asks for one.
    const key = scope.mode === "entity" ? { clientId: client.id, entityId: scope.value, year: period.year, month: period.month } : null;
    const summary = key && (await managementSummary(prisma, key));
    const [movers, explained, ai, session] = key && summary
      ? await Promise.all([topMovers(prisma, key, summary), fluxExplanations(prisma, key, summary), resolveAiConfig(prisma), requireWorkspaceSession()])
      : [null, null, null, null];
    const canWrite = session ? accessView(session).canWrite : false;
    // Flagged movers whose explanation is missing or no longer matches the books: what stands between the pack and the owner.
    const current = (code: string) => explained?.current.get(code)?.stale === false;
    const open = movers?.movers.filter((m) => m.flagged && !current(m.code)) ?? [];
    const flagged = movers?.movers.some((m) => m.flagged) ?? false;
    return (
      <div className="space-y-6">
        {header}
        {open.length > 0 && canWrite && (
          <NextStep href={`#mover-${open[0].code}`} cta={`Jelaskan ${open[0].code}`}>
            Jelaskan {open.length} akun yang melewati ambang sebelum laporan manajemen dikirim
          </NextStep>
        )}
        {flagged && open.length === 0 && <NextStep tone="done">Semua akun yang melewati ambang sudah dijelaskan untuk laporan manajemen</NextStep>}
        <TrendCard trend={t} currency={currency} plHref={tabHref("pl")} />
        <MarginCard margins={margins(figures, figuresOf(pl.ytd), pl.months)} compared={t.compared} ratioHref={tabHref("rasio")} plHref={tabHref("pl")} />
        <Card data-testid="insight-movers">
          <CardHeader>
            <CardTitle>Penggerak bulan ini</CardTitle>
            <CardDescription>
              Akun laba rugi yang paling jauh dari rata-rata bulan aktif sebelumnya (maks. 3), urut seperti Perubahan Akun di laporan manajemen.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {!movers ? (
              <div className="space-y-2 px-6 text-sm" data-testid="movers-pick-company">
                <p>Penggerak dihitung per perusahaan. Pilih satu perusahaan:</p>
                <ul className="divide-y rounded-lg border">
                  {client.entities.map((e) => (
                    <li key={e.id}>
                      <Link href={withParams(`${base}/analysis`, { period: period.key, entity: e.id, tab: "wawasan" })} className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-muted">
                        <span className="drill">{e.name}</span> <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : movers.movers.length === 0 ? (
              <p className="px-6 text-sm text-muted-foreground">Tidak ada mutasi akun laba rugi bulan ini.</p>
            ) : (
              <ul className="divide-y border-t">
                {movers.movers.map((m) => {
                  const x = explained?.current.get(m.code);
                  return (
                    <MoverRow key={m.code} mover={m} months={movers.baseline.length} currency={movers.currency} ledgerHref={href(m.code)}>
                      <FluxExplanationCard
                        clientId={client.id}
                        entityId={scope.value}
                        year={period.year}
                        month={period.month}
                        code={m.code}
                        flagged={m.flagged}
                        aiReady={Boolean(ai?.apiKey && ai.model)}
                        approved={x ? { text: x.text, source: x.source, approved: `${x.approvedBy ?? "Akuntan"} · ${formatDateTime(x.approvedAt)}`, stale: x.stale } : null}
                        previous={explained?.previous.get(m.code) ?? null}
                      />
                    </MoverRow>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
        <p className="text-xs text-muted-foreground">
          Ambang: selisih ≥ {MATERIALITY_PERCENT.toString()} % dari rata-rata volume Laba Rugi bulanan dan ≥ {FLUX_PERCENT.toString()} % dari rata-rata akunnya — sama dengan
          kontrol Fluktuasi Laba Rugi di Tutup Buku. Tren dan margin dari Laba Rugi per bulan; pilih angkanya untuk membuka tabelnya.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      <Card>
        <CardContent className="px-0">
          {tab.key === "pl" && <TrendTable months={pl.months} rows={pl.rows} totalLabel={`S.d. ${monthName(period.month)}`} currency={currency} href={href} />}
          {tab.key === "bs" && bs && <TrendTable months={bs.months} rows={bs.rows} currency={currency} href={href} />}
          {tab.key === "rasio" && bs && <RatioTable months={bs.months} rows={ratios(pl, bs)} currency={currency} />}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        {tab.key === "rasio"
          ? "Rasio likuiditas dan solvabilitas dari Neraca akhir bulan; margin dan umur piutang/utang dari Laba Rugi bulan itu. “–” bila pembaginya nol atau negatif."
          : tab.key === "bs"
            ? "Saldo per akhir setiap bulan; laba berjalan masuk ekuitas, jadi jumlah aset sama dengan jumlah liabilitas dan ekuitas setiap bulan."
            : "Setiap kolom adalah Laba Rugi bulan itu; kolom terakhir adalah jumlahnya, sama dengan Laba Rugi tahun berjalan di Laporan Keuangan."}
      </p>
    </div>
  );
}
