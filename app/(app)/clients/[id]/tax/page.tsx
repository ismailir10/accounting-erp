import { prisma } from "@/lib/db";
import { fiscalSpan } from "@/lib/fiscal";
import { loadClientPage } from "@/lib/client-page";
import type { SearchParams } from "@/lib/scope";
import { formatPeriod } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { ScopeBar } from "@/components/app/scope-bar";
import { NextStep, PageHeader } from "@/components/app/page-header";
import { TaxPackPanel } from "@/components/app/tax-pack";
import { packApplies, taxPack } from "@/lib/tax/pack";
import { taxPackView } from "@/lib/tax/view";
import { Card, CardContent } from "@/components/ui/card";

export const metadata = { title: "Pajak Badan" };

export default async function TaxPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { client, period, scope, periodOptions, entityOptions } = await loadClientPage(params, searchParams, { defaultCombined: false });
  const entity = client.entities.find((e) => e.id === scope.entityIds[0])!;
  const label = formatPeriod(period.year, period.month);
  const header = (
    <PageHeader
      title="Pajak Badan"
      description={`${entity.name} · rekonsiliasi fiskal, PPh badan dan pajak tangguhan ${period.year} s.d. ${label} (estimasi, bukan SPT)`}
      actions={<ScopeBar entities={entityOptions} periods={periodOptions} entity={scope.value} period={period.key} allowCombined={false} />}
    />
  );
  if (!packApplies(entity)) {
    return (
      <div className="space-y-6">
        {header}
        <NextStep>Pilih badan usaha (PT/CV) dengan pembukuan Rupiah. Pajak orang pribadi dan entitas valuta asing belum dihitung di sini.</NextStep>
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">{entity.name} bukan badan usaha dengan pembukuan Rupiah.</CardContent></Card>
      </div>
    );
  }
  if (client.fiscalYearEndMonth !== 12) {
    return (
      <div className="space-y-6">
        {header}
        <NextStep>Hitung PPh badan di luar Buku untuk sementara, lalu catat jurnalnya di Jurnal Penyesuaian.</NextStep>
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground" data-testid="tax-fiscal-year">
            Pajak Badan untuk tahun buku non-kalender ({fiscalSpan(client.fiscalYearEndMonth)}) belum didukung di Buku. Paket ini menghitung per tahun kalender, jadi angkanya tidak ditampilkan agar tidak salah tahun.
          </CardContent>
        </Card>
      </div>
    );
  }
  const pack = (await taxPack(prisma, client.id, entity.id, period.year, period.month))!;
  const view = await taxPackView(prisma, client.id, pack);
  const accounts = await prisma.account.findMany({ where: { clientId: client.id }, orderBy: { code: "asc" } });
  const cur = entity.functionalCurrency;
  const pending = pack.proposals.CURRENT.length > 0 || pack.proposals.DEFERRED.length > 0;
  return (
    <div className="space-y-6">
      {header}
      {pack.suggestions.length && pack.regime === "NORMAL" ? (
        <NextStep>Periksa {pack.suggestions.length} usulan koreksi fiskal di bawah, lalu catat jurnal pajaknya.</NextStep>
      ) : pending && pack.regime === "FINAL_UMKM" ? (
        <NextStep>Skema final dipilih: balik jurnal pajak yang dicatat sebelumnya per {label}.</NextStep>
      ) : pending ? (
        <NextStep>Catat jurnal pajak per {label}: PPh badan terutang estimasi {formatMoney(pack.tax.due, cur)}.</NextStep>
      ) : pack.regime === "FINAL_UMKM" ? (
        <NextStep tone="done">PPh final 0,5% {period.year} s.d. {label}: {formatMoney(pack.tax.due, cur)}; dicatat saat disetor.</NextStep>
      ) : (
        <NextStep tone="done">PPh badan {period.year} s.d. {label} sudah dijurnal sesuai estimasi.</NextStep>
      )}
      <TaxPackPanel
        clientId={client.id}
        periodKey={period.key}
        periodLabel={label}
        view={view}
        accounts={{
          pl: accounts.filter((a) => !a.archivedAt && (a.type === "PENDAPATAN" || a.type === "BEBAN")).map((a) => ({ code: a.code, name: a.name })),
          credit: accounts.filter((a) => !a.archivedAt && a.type === "ASET" && !a.isBank && !a.isSuspense && !a.isClearing).map((a) => ({ code: a.code, name: a.name })),
        }}
      />
    </div>
  );
}
