import Link from "next/link";
import { prisma } from "@/lib/db";
import { periodKeyOf, priorYearEnd } from "@/lib/fiscal";
import { clientAccountsView, loadClientPage } from "@/lib/client-page";
import { sourceTrialBalance } from "@/lib/reports/source";
import { AccountViewTabs } from "@/components/app/account-view-tabs";
import { type SearchParams, withParams } from "@/lib/scope";
import { trialBalance } from "@/lib/reports/ledger";
import { formatPeriod } from "@/lib/format";
import { NextStep, PageHeader } from "@/components/app/page-header";
import { ScopeBar } from "@/components/app/scope-bar";
import { Money } from "@/components/app/money";
import { LedgerDownloads } from "@/components/app/ledger-downloads";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { currencyNote, FxMissing, withFx } from "@/components/app/fx-missing";
import { FxMissingError } from "@/lib/reports/fx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Buku Besar" };

const TYPES = [
  ["ASET", "Aset"],
  ["LIABILITAS", "Liabilitas"],
  ["EKUITAS", "Ekuitas"],
  ["PENDAPATAN", "Pendapatan"],
  ["BEBAN", "Beban"],
] as const;

export default async function LedgerIndex({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { client, period, scope, periodOptions, entityOptions, base, scopeLabel, currency, mixed, sp } = await loadClientPage(params, searchParams);
  const note = currencyNote(currency, mixed);
  const view = await clientAccountsView(scope, sp);
  const q = { period: period.key, entity: scope.value };
  const header = (
    <>
      <PageHeader title="Buku Besar" description={`${scopeLabel} · saldo per ${formatPeriod(period.year, period.month)}${note ? ` · ${note}` : ""}`} actions={<><ScopeBar entities={entityOptions} periods={periodOptions} entity={scope.value} period={period.key} />{!mixed && !view.active && currency === "IDR" && <LedgerDownloads href={`${base}/ledger/export`} query={q} testId="ledger-download" />}</>} />
      {view.available && <AccountViewTabs clientView={view.active} href={(v) => withParams(`${base}/ledger`, { ...q, view: v })} />}
    </>
  );
  if (view.active) {
    const src = await sourceTrialBalance(prisma, scope.value, period.end, period.start);
    return (
      <div className="space-y-6">
        {header}
        <NextStep>Akun seperti di file klien. Pilih akun untuk melihat mutasinya sampai baris sumbernya.</NextStep>
        <div className="grid gap-4">
          {TYPES.map(([t, label]) => {
            const rows = src.filter((r) => r.type === t);
            if (!rows.length) return null;
            const sign = t === "ASET" || t === "BEBAN" ? 1n : -1n;
            return (
              <Card key={t}>
                <CardHeader><CardTitle>{label}</CardTitle></CardHeader>
                <CardContent className="px-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-6">Akun klien</TableHead>
                        <TableHead className="text-right">Baris bln ini</TableHead>
                        <TableHead className="pr-6 text-right">Saldo</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => (
                        <TableRow key={r.key}>
                          <TableCell className="pl-6 whitespace-normal">
                            <Link href={r.key === "prior" ? withParams(`${base}/reports`, { period: periodKeyOf(priorYearEnd(client.fiscalYearEndMonth, period.year, period.month)), entity: scope.value, tab: "pl" }) : r.sourceAccountId ? withParams(`${base}/ledger/akun/${r.sourceAccountId}`, q) : withParams(`${base}/ledger/${r.accountCode}`, q)} className="drill" data-testid="client-account-link">
                              {r.code && <span className="num text-muted-foreground">{r.code}</span>} {r.name}
                            </Link>
                            <div className="text-xs text-muted-foreground">{r.clientAccount ? `→ ${r.clientAccount.code} ${r.clientAccount.name}` : r.key === "prior" ? "dari pendapatan & beban tahun lalu · buka Laba Rugi" : "tanpa akun klien"}</div>
                          </TableCell>
                          <TableCell className="num text-right text-muted-foreground">{r.periodLines || "–"}</TableCell>
                          <TableCell className="pr-6 text-right"><Money value={r.net * sign} currency={currency} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    );
  }
  const tb = await withFx(() => trialBalance(prisma, { clientId: client.id, entityIds: scope.entityIds }, period.end));
  if (tb instanceof FxMissingError) return <div className="space-y-6">{header}<FxMissing error={tb} base={base} /></div>;
  const counts = await prisma.journalLine.groupBy({ by: ["accountId"], where: { entityId: { in: scope.entityIds }, date: { gte: period.start, lte: period.end } }, _count: true });
  const countMap = new Map(counts.map((c) => [c.accountId, c._count]));
  return (
    <div className="space-y-6">
      {header}
      <NextStep>Pilih akun untuk melihat mutasinya dan menelusuri ke baris rekening koran atau file sumber.</NextStep>
      {!tb.some((r) => r.net !== 0n || countMap.get(r.account.id)) && <p className="text-sm text-muted-foreground">Belum ada jurnal sampai {formatPeriod(period.year, period.month)}. Impor rekening koran atau buku besar untuk mengisi buku besar.</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        {TYPES.map(([t, label]) => {
          const rows = tb.filter((r) => r.account.type === t && (r.net !== 0n || countMap.get(r.account.id)));
          if (!rows.length) return null;
          const sign = t === "ASET" || t === "BEBAN" ? 1n : -1n;
          return (
            <Card key={t}>
              <CardHeader><CardTitle>{label}</CardTitle></CardHeader>
              <CardContent className="px-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-6">Akun</TableHead>
                      <TableHead className="text-right">Baris bln ini</TableHead>
                      <TableHead className="pr-6 text-right">Saldo</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.account.id}>
                        <TableCell className="pl-6">
                          <Link href={withParams(`${base}/ledger/${r.account.code}`, q)} className="drill">
                            <span className="num text-muted-foreground">{r.account.code}</span> {r.account.name}
                          </Link>
                        </TableCell>
                        <TableCell className="num text-right text-muted-foreground">{countMap.get(r.account.id) ?? "–"}</TableCell>
                        <TableCell className="pr-6 text-right"><Money value={r.net * sign} currency={currency} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
