import { Download } from "lucide-react";
import { prisma } from "@/lib/db";
import { loadClientPage } from "@/lib/client-page";
import { type SearchParams, withParams } from "@/lib/scope";
import { formatPeriod, monthName } from "@/lib/format";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/app/page-header";
import { ScopeBar } from "@/components/app/scope-bar";
import { LinkTabs } from "@/components/app/link-tabs";
import { RatioTable, TrendTable } from "@/components/app/trend-table";
import { currencyNote, FxMissing, withFx } from "@/components/app/fx-missing";
import { FxMissingError } from "@/lib/reports/fx";
import { monthlyBalance, monthlyIncome, ratios } from "@/lib/reports/analysis";

export const metadata = { title: "Analisis keuangan" };

const TABS = [
  { key: "pl", label: "Laba Rugi per bulan" },
  { key: "bs", label: "Neraca per bulan" },
  { key: "rasio", label: "Rasio keuangan" },
] as const;

/**
 * Analisis keuangan: the financial year to date month by month — Laba Rugi, Neraca, and the usual ratios — from the same statements as
 * Laporan Keuangan (lib/reports/analysis.ts). One tab on screen at a time (`?tab=`).
 */
export default async function AnalysisPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { client, period, scope, periodOptions, entityOptions, base, scopeLabel, currency, mixed, sp } = await loadClientPage(params, searchParams);
  const tab = TABS.find((t) => t.key === sp.tab) ?? TABS[0];
  const q = { period: period.key, entity: scope.value };
  const s = { clientId: client.id, entityIds: scope.entityIds };
  const note = currencyNote(currency, mixed);
  const header = (
    <>
      <PageHeader
        title="Analisis keuangan"
        description={`${scopeLabel} · tahun buku s.d. ${formatPeriod(period.year, period.month)}${note ? ` · ${note}` : ""}`}
        actions={<ScopeBar entities={entityOptions} periods={periodOptions} entity={scope.value} period={period.key} />}
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <LinkTabs label="Analisis" items={TABS.map((t) => ({ href: withParams(`${base}/analysis`, { ...q, tab: t.key === "pl" ? undefined : t.key }), label: t.label, active: t.key === tab.key }))} />
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
    const bs = tab.key === "pl" ? null : await monthlyBalance(prisma, s, period.year, period.month);
    return { pl, bs };
  });
  if (data instanceof FxMissingError) return <div className="space-y-6">{header}<FxMissing error={data} base={base} /></div>;
  const href = (code: string) => withParams(`${base}/ledger/${code}`, q);
  const { pl, bs } = data;
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
