import Link from "next/link";
import { ChevronRight, Download } from "lucide-react";
import { prisma } from "@/lib/db";
import { loadClientPage } from "@/lib/client-page";
import { type SearchParams, withParams } from "@/lib/scope";
import { formatPeriod, monthName } from "@/lib/format";
import { requireWorkspaceSession } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { accountGroup } from "@/lib/coa/options";
import { budgetGrid, budgetVsActual, cellText, favourable, type VsRow } from "@/lib/budget";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { NextStep, PageHeader } from "@/components/app/page-header";
import { ScopeBar } from "@/components/app/scope-bar";
import { LinkTabs } from "@/components/app/link-tabs";
import { Money } from "@/components/app/money";
import { BudgetEditor } from "@/components/app/budget-editor";
import { percentOf } from "@/lib/reports/management";
import { cn } from "@/lib/utils";

export const metadata = { title: "Anggaran" };

const TABS = [
  { key: "realisasi", label: "Anggaran vs realisasi" },
  { key: "atur", label: "Atur anggaran" },
] as const;

/**
 * Anggaran: plan each company's income and expense per month of the financial year, and read the month and the year to date against the
 * ledger (lib/budget). The budget is planning data, never posted.
 */
export default async function BudgetPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { client, period, scope, periodOptions, entityOptions, base, scopeLabel, sp } = await loadClientPage(params, searchParams);
  const { member } = await requireWorkspaceSession();
  const tab = TABS.find((t) => t.key === sp.tab) ?? TABS[0];
  const q = { period: period.key, entity: scope.value };
  const header = (
    <>
      <PageHeader title="Anggaran" description={`${scopeLabel} · ${formatPeriod(period.year, period.month)}`} actions={<ScopeBar entities={entityOptions} periods={periodOptions} entity={scope.value} period={period.key} />} />
      <LinkTabs label="Anggaran" items={TABS.map((t) => ({ href: withParams(`${base}/budget`, { ...q, tab: t.key === "realisasi" ? undefined : t.key }), label: t.label, active: t.key === tab.key }))} />
    </>
  );

  if (tab.key === "atur") {
    if (scope.mode === "combined") {
      // A budget belongs to one company: its currency and its own books.
      return (
        <div className="space-y-6">
          {header}
          <NextStep>Anggaran diisi per perusahaan. Pilih perusahaannya.</NextStep>
          <ul className="flex flex-wrap gap-2">
            {client.entities.map((e) => (
              <li key={e.id}>
                <Link href={withParams(`${base}/budget`, { period: period.key, entity: e.id, tab: "atur" })} className={buttonVariants({ variant: "outline" })}>
                  {e.shortName} <ChevronRight />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      );
    }
    const grid = await budgetGrid(prisma, { clientId: client.id, entityId: scope.value, year: period.year, month: period.month });
    return (
      <div className="space-y-6">
        {header}
        <NextStep>Isi anggaran tahun buku {grid.fiscal} per bulan, atau salin dari realisasi tahun lalu, lalu simpan.</NextStep>
        <BudgetEditor
          clientId={client.id}
          entityId={scope.value}
          year={period.year}
          month={period.month}
          months={grid.months.map((m) => ({ key: m.key, label: m.label }))}
          currency={grid.currency}
          rows={grid.rows.map((r) => ({ code: r.code, name: r.name, type: r.type as "PENDAPATAN" | "BEBAN", cells: r.budget.map((v) => cellText(v, grid.currency)), lastYear: r.lastYear.map(String) }))}
          options={grid.accounts.map((a) => ({ code: a.code, name: a.name, group: accountGroup({ type: a.type, fsLine: null }), type: a.type as "PENDAPATAN" | "BEBAN" }))}
          canWrite={can(member.role, "books.write")}
        />
      </div>
    );
  }

  const vs = await budgetVsActual(prisma, { clientId: client.id, entityIds: scope.entityIds }, period.year, period.month).catch((e: Error) => e);
  if (vs instanceof Error) return <div className="space-y-6">{header}<NextStep>{vs.message}</NextStep></div>;
  const ytd = `S.d. ${monthName(period.month)}`;
  return (
    <div className="space-y-6">
      {header}
      {!vs.hasBudget ? (
        <NextStep href={withParams(`${base}/budget`, { ...q, tab: "atur", entity: scope.mode === "combined" ? client.entities[0]?.id : scope.value })} cta="Atur anggaran">
          Belum ada anggaran untuk tahun buku {vs.fiscal}. Isi anggarannya untuk membandingkan dengan realisasi.
        </NextStep>
      ) : (
        <div className="flex justify-end">
          <a href={withParams(`${base}/budget/export`, q)} className={buttonVariants({ variant: "outline" })} download data-testid="budget-download">
            <Download /> Unduh Excel
          </a>
        </div>
      )}
      <Card>
        <CardContent className="overflow-x-auto px-0">
          <table className="w-full text-sm" data-testid="budget-vs">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="sticky left-0 z-10 bg-card" />
                <th colSpan={3} className="border-b px-3 pb-1 text-center font-medium">{formatPeriod(period.year, period.month)}</th>
                <th colSpan={4} className="border-b px-3 pb-1 text-center font-medium">{ytd}</th>
              </tr>
              <tr className="border-b text-muted-foreground">
                <th className="sticky left-0 z-10 min-w-48 bg-card py-2 pl-6 text-left font-medium sm:min-w-64">Akun</th>
                {["Anggaran", "Realisasi", "Selisih", "Anggaran", "Realisasi", "Selisih", "Realisasi ÷ anggaran"].map((h, i) => (
                  <th key={i} className={cn("px-3 py-2 text-right font-medium whitespace-nowrap", i === 6 && "pr-6")}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {vs.rows.map((r, i) => (
                <VsLine key={`${r.code ?? r.label}-${i}`} row={r} currency={vs.currency} heading={r.kind === "account" && (i === 0 || vs.rows[i - 1].kind === "total")} />
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">Selisih = realisasi − anggaran. Selisih yang tidak menguntungkan (pendapatan di bawah anggaran, beban di atas anggaran) ditandai “di luar rencana”; akun yang terjadi tanpa anggaran ditandai “tanpa anggaran”.</p>
    </div>
  );
}

function VsLine({ row, currency, heading }: { row: VsRow; currency: string; heading: boolean }) {
  const diff = (b: bigint, a: bigint) => (
    <span className="inline-flex flex-col items-end">
      <Money value={a - b} currency={currency} />
      {b === 0n ? (a !== 0n && row.kind === "account" && <span className="text-xs text-muted-foreground">tanpa anggaran</span>) : !favourable(row, b, a) && <span className="text-xs text-review">di luar rencana</span>}
    </span>
  );
  return (
    <>
      {heading && (
        <tr>
          <td className="sticky left-0 z-10 bg-card pt-3 pb-1 pl-6 text-xs font-medium text-muted-foreground">{row.type === "PENDAPATAN" ? "Pendapatan" : "Beban"}</td>
          <td colSpan={7} />
        </tr>
      )}
      <tr className={cn(row.kind === "total" && "border-t font-semibold")} data-testid={row.code ? `vs-${row.code}` : `vs-${row.label}`}>
        <td className={cn("sticky left-0 z-10 bg-card py-1.5 pr-3", row.kind === "account" ? "pl-10" : "pl-6")}>
          {row.code && <span className="num text-muted-foreground">{row.code} </span>}
          {row.label}
        </td>
        <td className="px-3 py-1.5 text-right align-top"><Money value={row.month[0]} currency={currency} muted /></td>
        <td className="px-3 py-1.5 text-right align-top"><Money value={row.month[1]} currency={currency} /></td>
        <td className="px-3 py-1.5 text-right align-top">{diff(row.month[0], row.month[1])}</td>
        <td className="px-3 py-1.5 text-right align-top"><Money value={row.ytd[0]} currency={currency} muted /></td>
        <td className="px-3 py-1.5 text-right align-top"><Money value={row.ytd[1]} currency={currency} /></td>
        <td className="px-3 py-1.5 text-right align-top">{diff(row.ytd[0], row.ytd[1])}</td>
        <td className="num py-1.5 pr-6 pl-3 text-right align-top">{percentOf(row.ytd[1], row.ytd[0]) ?? "–"}</td>
      </tr>
    </>
  );
}
