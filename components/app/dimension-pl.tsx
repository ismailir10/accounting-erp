import Link from "next/link";
import { Download } from "lucide-react";
import { Money } from "@/components/app/money";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LinkTabs } from "@/components/app/link-tabs";
import { cn } from "@/lib/utils";
import type { DimensionPl } from "@/lib/reports/by-dimension";

/**
 * Laba Rugi per Departemen / per Proyek (lib/reports/by-dimension.ts): a column per department in use, *Tanpa …* and Total (= the Laba
 * Rugi). An account cell drills to Buku Besar filtered by that department; *Tanpa* and Total open the account's whole ledger.
 */
export function DimensionPlCard({ pl, title, description, currency, ranges, accountHref, download }: {
  pl: DimensionPl;
  title: string;
  description: string;
  currency: string;
  ranges: { href: string; label: string; active: boolean }[];
  accountHref: (code: string, dimensionId: string | null) => string;
  download: string;
}) {
  const hasLines = pl.rows.some((r) => r.type === "account");
  return (
    <Card data-testid={`pl-by-${pl.kind.toLowerCase()}`}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LinkTabs label="Rentang" items={ranges} />
          <a href={download} className={buttonVariants({ variant: "outline", size: "sm" })}><Download /> Excel</a>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto px-0">
        {!hasLines ? (
          <p className="px-6 py-6 text-sm text-muted-foreground">Belum ada pendapatan atau beban di rentang ini.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Akun</TableHead>
                {pl.columns.map((c) => (
                  <TableHead key={c.key} className="text-right whitespace-normal">
                    {c.code && <span className="num block text-xs text-muted-foreground">{c.code}</span>}
                    {c.label}{c.archived && <span className="block text-xs font-normal text-muted-foreground">diarsipkan</span>}
                  </TableHead>
                ))}
                <TableHead className="pr-6 text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pl.rows.map((r, i) =>
                r.type === "heading" ? (
                  <TableRow key={i} className="hover:bg-transparent">
                    <TableCell colSpan={pl.columns.length + 2} className="pt-4 pl-6 text-xs font-medium tracking-wide text-muted-foreground uppercase">{r.label}</TableCell>
                  </TableRow>
                ) : r.type === "account" ? (
                  <TableRow key={i} data-testid="dimension-pl-row">
                    <TableCell className="pl-6 whitespace-normal"><span className="num text-muted-foreground">{r.code}</span> {r.name}</TableCell>
                    {r.amounts.map((v, j) => (
                      <TableCell key={j} className="text-right">
                        {v === 0n ? <Money value={v} currency={currency} /> : <Link href={accountHref(r.code, pl.columns[j].id)} className="drill"><Money value={v} currency={currency} /></Link>}
                      </TableCell>
                    ))}
                    <TableCell className="pr-6 text-right"><Link href={accountHref(r.code, null)} className="drill"><Money value={r.total} currency={currency} /></Link></TableCell>
                  </TableRow>
                ) : (
                  <TableRow key={i} className={cn("border-t", r.strong && "bg-muted/40")} data-testid="dimension-pl-subtotal">
                    <TableCell className={cn("pl-6 font-medium", r.strong && "font-semibold")}>{r.label}</TableCell>
                    {r.amounts.map((v, j) => <TableCell key={j} className="text-right"><Money value={v} currency={currency} strong={r.strong} /></TableCell>)}
                    <TableCell className="pr-6 text-right"><Money value={r.total} currency={currency} strong /></TableCell>
                  </TableRow>
                ),
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
