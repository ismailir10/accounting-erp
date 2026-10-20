import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { prisma } from "@/lib/db";
import { loadClientPage } from "@/lib/client-page";
import { type SearchParams, withParams } from "@/lib/scope";
import { formatPeriod } from "@/lib/format";
import { PageHeader } from "@/components/app/page-header";
import { ScopeBar } from "@/components/app/scope-bar";
import { LedgerTable } from "@/components/app/ledger-table";
import { classifiableOptions } from "@/lib/coa/options";
import { accountLedger } from "@/lib/reports/account-ledger";
import { Card, CardContent } from "@/components/ui/card";
import { NextStep } from "@/components/app/page-header";
import { currencyNote } from "@/components/app/fx-missing";
import { LedgerDownloads } from "@/components/app/ledger-downloads";
import { requireWorkspaceSession } from "@/lib/auth/session";
import { routeFor } from "@/lib/approvals/journals";

export const metadata = { title: "Buku Besar" };

export default async function AccountLedger({ params, searchParams }: { params: Promise<{ id: string; code: string }>; searchParams: SearchParams }) {
  const { code } = await params;
  const { client, period, scope, periodOptions, entityOptions, base, scopeLabel, currency, mixed } = await loadClientPage(params, searchParams);
  const account = await prisma.account.findUnique({ where: { clientId_code: { clientId: client.id, code } } });
  if (!account) notFound();
  if (mixed) {
    // One ledger can't list SGD and IDR lines in one running balance: show it per entity.
    const scoped = client.entities.filter((e) => scope.entityIds.includes(e.id));
    return (
      <div className="space-y-6">
        <PageHeader title={`${account.code} ${account.name}`} description={`${scopeLabel} · ${formatPeriod(period.year, period.month)}`} actions={<ScopeBar entities={entityOptions} periods={periodOptions} entity={scope.value} period={period.key} />} />
        <NextStep>Buku besar ditampilkan per perusahaan karena mata uangnya berbeda. Pilih perusahaan.</NextStep>
        <ul className="flex flex-wrap gap-2">
          {scoped.map((e) => (
            <li key={e.id}>
              <Link href={withParams(`${base}/ledger/${code}`, { period: period.key, entity: e.id })} className={buttonVariants({ variant: "outline" })}>
                {e.shortName} · {e.functionalCurrency} <ChevronRight />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const { opening, priorYearProfit, rows } = await accountLedger(prisma, { accountId: account.id, entityIds: scope.entityIds, start: period.start, end: period.end, normalBalance: account.normalBalance });
  // Persetujuan kedua: *Balik jurnal* above the firm's *Jurnal manual* threshold waits for a second member.
  const { member } = await requireWorkspaceSession();
  const reverseRoute = rows.some((r) => r.reversal && !r.reversal.blocker) ? await routeFor(prisma, client.id, { id: member.id, role: member.role }, "REVERSAL") : undefined;
  return (
    <div className="space-y-6">
      <PageHeader
        title={`${account.code} ${account.name}`}
        description={`${scopeLabel} · ${formatPeriod(period.year, period.month)}${currencyNote(currency, false) ? ` · ${currencyNote(currency, false)}` : ""} · klik baris untuk melihat sumbernya`}
        actions={<><ScopeBar entities={entityOptions} periods={periodOptions} entity={scope.value} period={period.key} />{currency === "IDR" && <LedgerDownloads href={`${base}/ledger/export`} query={{ period: period.key, entity: scope.value, account: account.code }} testId="account-ledger-download" />}</>}
      />
      <Card>
        <CardContent className="px-0">
          <LedgerTable rows={rows} opening={opening.toString()} priorYearProfit={priorYearProfit.toString()} currency={currency} reverseRoute={reverseRoute} accounts={rows.some((r) => r.source) ? classifiableOptions(await prisma.account.findMany({ where: { clientId: client.id }, orderBy: { code: "asc" } })) : undefined} />
          {rows.length === 0 && <p className="px-6 py-8 text-center text-sm text-muted-foreground">Tidak ada transaksi di periode ini.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
