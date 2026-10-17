import { prisma } from "@/lib/db";
import { periodKeyOf, priorYearEnd } from "@/lib/fiscal";
import { clientAccountsView, loadClientPage } from "@/lib/client-page";
import { type SearchParams, withParams } from "@/lib/scope";
import { trialBalance, trialBalanceMovement } from "@/lib/reports/ledger";
import { formatPeriod } from "@/lib/format";
import { NextStep, PageHeader } from "@/components/app/page-header";
import { ScopeBar } from "@/components/app/scope-bar";
import { Card, CardContent } from "@/components/ui/card";
import { currencyNote, FxMissing, withFx } from "@/components/app/fx-missing";
import { FxMissingError } from "@/lib/reports/fx";
import { sourceTrialBalance } from "@/lib/reports/source";
import { AccountViewTabs } from "@/components/app/account-view-tabs";
import { TbTable, type TbTableRow } from "@/components/app/tb-table";
import { LedgerDownloads } from "@/components/app/ledger-downloads";

export const metadata = { title: "Neraca Saldo" };

export default async function TrialBalancePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { client, period, scope, periodOptions, entityOptions, base, scopeLabel, currency, mixed, sp } = await loadClientPage(params, searchParams);
  const note = currencyNote(currency, mixed);
  const view = await clientAccountsView(scope, sp);
  const q = { period: period.key, entity: scope.value };
  const header = (
    <>
      <PageHeader
        title="Neraca Saldo"
        description={`${scopeLabel} · ${formatPeriod(period.year, period.month)}${note ? ` · ${note}` : ""}`}
        actions={<><ScopeBar entities={entityOptions} periods={periodOptions} entity={scope.value} period={period.key} />{!view.active && currency === "IDR" && <LedgerDownloads href={`${base}/trial-balance/export`} query={q} testId="tb-download" />}</>}
      />
      {view.available && <AccountViewTabs clientView={view.active} href={(v) => withParams(`${base}/trial-balance`, { ...q, view: v })} />}
    </>
  );

  if (view.active) {
    // The client's own accounts, as in their file; lines without one (bank, adjustments) under their Buku account.
    const src = await sourceTrialBalance(prisma, scope.value, period.end, period.start);
    // Last years' result isn't a 3200 entry: it is folded income & expense, so it opens last year's Laba Rugi.
    const priorHref = withParams(`${base}/reports`, { period: periodKeyOf(priorYearEnd(client.fiscalYearEndMonth, period.year, period.month)), entity: scope.value, tab: "pl" });
    const rows: TbTableRow[] = src.map((r) => ({
      key: r.key,
      code: r.code,
      name: r.name,
      href: r.key === "prior" ? priorHref : r.sourceAccountId ? withParams(`${base}/ledger/akun/${r.sourceAccountId}`, q) : withParams(`${base}/ledger/${r.accountCode}`, q),
      sub: [r.clientAccount ? `→ ${r.clientAccount.code} ${r.clientAccount.name}` : r.key === "prior" ? "dari pendapatan & beban tahun lalu · buka Laba Rugi" : "tanpa akun klien", r.previousNames.length ? `dulu: ${r.previousNames.map((p) => `“${p}”`).join(", ")}` : ""].filter(Boolean).join(" · ") || undefined,
      review: r.accountCode === "1999" && r.net !== 0n,
      move: { opening: r.opening, debit: r.periodDebit, credit: r.periodCredit },
      net: r.net,
    }));
    return (
      <div className="space-y-6">
        {header}
        <NextStep>Akun seperti di file klien. Pilih akun untuk membuka buku besarnya sampai baris sumber.</NextStep>
        <Card>
          <CardContent className="px-0">
            <TbTable rows={rows} currency={currency} codeLabel="Kode klien" />
            {rows.length === 0 && <p className="px-6 py-8 text-center text-sm text-muted-foreground">Belum ada saldo untuk entitas ini per akhir periode.</p>}
          </CardContent>
        </Card>
      </div>
    );
  }

  const scopeArg = { clientId: client.id, entityIds: scope.entityIds };
  const all = await withFx(async () =>
    mixed
      ? (await trialBalance(prisma, scopeArg, period.end)).map((r) => ({ ...r, move: null }))
      : (await trialBalanceMovement(prisma, scopeArg, period.start, period.end)).map((r) => ({ ...r, move: { opening: r.opening, debit: r.periodDebit, credit: r.periodCredit } })),
  );
  if (all instanceof FxMissingError) return <div className="space-y-6">{header}<FxMissing error={all} base={base} /></div>;
  const rows: TbTableRow[] = all
    .filter((r) => r.net !== 0n || (r.move && (r.move.debit || r.move.credit)))
    .map((r) => ({ key: r.account.id, code: r.account.code, name: r.account.name, href: withParams(`${base}/ledger/${r.account.code}`, q), review: r.account.isSuspense && r.net !== 0n, move: r.move, net: r.net }));
  return (
    <div className="space-y-6">
      {header}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Belum ada saldo per akhir {formatPeriod(period.year, period.month)}. Impor rekening koran atau buku besar untuk mengisi neraca saldo.</p>
      ) : (
        <NextStep>Debit dan kredit harus sama. Pilih nama akun untuk membuka buku besarnya.</NextStep>
      )}
      <Card>
        <CardContent className="px-0">
          <TbTable rows={rows} currency={currency} />
        </CardContent>
      </Card>
    </div>
  );
}
