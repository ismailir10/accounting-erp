import { prisma } from "@/lib/db";
import { dimensionOptions } from "@/lib/dimensions";
import { loadClientPage } from "@/lib/client-page";
import type { SearchParams } from "@/lib/scope";
import { formatPeriod, toIsoDate } from "@/lib/format";
import { ScopeBar } from "@/components/app/scope-bar";
import { NextStep, PageHeader } from "@/components/app/page-header";
import { AssetRegister } from "@/components/app/asset-register";
import { candidateViews, registerViews, scheduleLinkViews } from "@/lib/assets/view";

export const metadata = { title: "Aset Tetap" };

export default async function AssetsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { client, period, scope, periodOptions, entityOptions, base } = await loadClientPage(params, searchParams);
  const entities = client.entities.filter((e) => scope.entityIds.includes(e.id));
  const [registers, candidates, schedules, accounts] = await Promise.all([
    registerViews(prisma, client.id, period.year, period.month, entities),
    candidateViews(prisma, client.id, scope.entityIds),
    scheduleLinkViews(prisma, client.id, scope.entityIds),
    prisma.account.findMany({ where: { clientId: client.id }, orderBy: { code: "asc" } }),
  ]);
  const pick = (f: (a: (typeof accounts)[number]) => boolean) => accounts.filter((a) => !a.archivedAt && f(a)).map((a) => ({ code: a.code, name: a.name })); // never an archived account
  const label = formatPeriod(period.year, period.month);
  const unposted = registers.reduce((n, r) => n + r.rows.reduce((m, row) => m + row.unposted, 0), 0);
  const mismatch = registers.filter((r) => r.ledger && !r.ledger.equal);
  const periodQ = `period=${period.key}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Aset Tetap"
        description={`Daftar aset, penyusutan buku (PSAK 216) dan estimasi penyusutan fiskal per ${label}`}
        actions={<ScopeBar entities={entityOptions} periods={periodOptions} entity={scope.value} period={period.key} />}
      />
      {candidates.length ? (
        <NextStep>Daftarkan {candidates.length} pembelian aset tetap di bawah agar penyusutannya dijadwalkan.</NextStep>
      ) : unposted ? (
        <NextStep href={`${base}/journals/new?${periodQ}`} cta="Buka Jurnal Penyesuaian">Catat {unposted} penyusutan yang sudah jatuh tempo sampai {label}.</NextStep>
      ) : mismatch.length ? (
        <NextStep>Daftar aset {mismatch.map((r) => r.entity.shortName).join(", ")} berbeda dengan buku besar. Daftarkan aset yang belum ada atau periksa jurnal manual di akun aset.</NextStep>
      ) : registers.length ? (
        <NextStep tone="done">Daftar aset per {label} cocok dengan buku besar dan semua penyusutan sudah dicatat.</NextStep>
      ) : (
        <NextStep>Tambahkan aset tetap klien: dari pembelian di buku besar, dari jadwal penyusutan, atau aset di Saldo Awal.</NextStep>
      )}
      <AssetRegister
        dimensions={await dimensionOptions(prisma, client.id)}
        clientId={client.id}
        year={period.year}
        periodKey={period.key}
        entities={[...entities].sort((a, b) => Number(a.kind === "PERORANGAN") - Number(b.kind === "PERORANGAN")).map((e) => ({ id: e.id, name: e.name, currency: e.functionalCurrency }))}
        registers={registers}
        candidates={candidates}
        schedules={schedules}
        accounts={{
          asset: pick((a) => a.fsLine === "ASET_TETAP"),
          expense: pick((a) => a.type === "BEBAN"),
          accumulated: pick((a) => a.fsLine === "AKUM_PENYUSUTAN"),
          proceeds: pick((a) => !a.isBank && !a.isSuspense && !a.isClearing && a.fsLine !== "ASET_TETAP" && a.fsLine !== "AKUM_PENYUSUTAN"),
          gainLoss: pick((a) => a.type === "PENDAPATAN" || a.type === "BEBAN"),
        }}
        defaultDate={toIsoDate(period.end)}
      />
    </div>
  );
}
