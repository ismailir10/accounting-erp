import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDate, formatMonthShort } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/app/money";
import { StatusPill } from "@/components/app/status";
import { pointsText, type InsightMover, type Margins, type Trend } from "@/lib/reports/insights";

/**
 * Wawasan keuangan (Analisis keuangan → *Wawasan*): Tren, Margin and Penggerak bulan ini. Each card opens with its computed sentence;
 * every figure opens the table it comes from (`plHref`, `ratioHref`) and every account its Buku Besar.
 */

const TH = "px-3 py-2 text-right font-medium whitespace-nowrap text-muted-foreground";
const TD = "px-3 py-1.5 text-right align-top";

export function TrendCard({ trend, currency, plHref }: { trend: Trend; currency: string; plHref: string }) {
  const cell = (v: bigint | null) => (v === null ? null : <Link href={plHref} className="drill"><Money value={v} currency={currency} /></Link>);
  return (
    <Card data-testid="insight-trend">
      <CardHeader>
        <CardTitle>Tren</CardTitle>
        <CardDescription className="text-foreground" data-testid="insight-trend-sentence">{trend.sentence}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto px-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-2 pl-6 text-left font-medium text-muted-foreground">Pos</th>
              <th className={TH}>Bulan ini</th>
              {trend.compared && (
                <>
                  <th className={TH}>Bulan lalu</th>
                  <th className={cn(TH, "hidden md:table-cell")}>Rata-rata tahun ini</th>
                  <th className={cn(TH, "hidden sm:table-cell")}>Tertinggi</th>
                  <th className={cn(TH, "hidden sm:table-cell pr-6")}>Terendah</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {trend.metrics.map((m) => (
              <tr key={m.key} data-testid={`insight-trend-${m.key}`}>
                <td className="py-1.5 pr-3 pl-6 align-top">
                  {m.label}
                  {m.run && <span className="block text-xs text-muted-foreground">{m.run.up ? "Naik" : "Turun"} {m.run.months} bulan berturut-turut</span>}
                </td>
                <td className={cn(TD, !trend.compared && "pr-6")} data-testid="current">{cell(m.current)}</td>
                {trend.compared && (
                  <>
                    <td className={TD}>{cell(m.previous)}</td>
                    <td className={cn(TD, "hidden md:table-cell")}>{cell(m.average)}</td>
                    <td className={cn(TD, "hidden sm:table-cell")}>{cell(m.high.value)}<span className="block text-xs text-muted-foreground">{m.high.label}</span></td>
                    <td className={cn(TD, "hidden sm:table-cell pr-6")}>{cell(m.low.value)}<span className="block text-xs text-muted-foreground">{m.low.label}</span></td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

export function MarginCard({ margins, compared, ratioHref, plHref }: { margins: Margins; compared: boolean; ratioHref: string; plHref: string }) {
  const cell = (v: string | null, href: string) => (v === null ? <span className="text-muted-foreground">–</span> : <Link href={href} className="drill num">{v}</Link>);
  return (
    <Card data-testid="insight-margin">
      <CardHeader>
        <CardTitle>Margin</CardTitle>
        <CardDescription className="text-foreground" data-testid="insight-margin-sentence">{margins.sentence}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto px-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-2 pl-6 text-left font-medium text-muted-foreground">Margin</th>
              <th className={TH}>Bulan ini</th>
              {compared && <th className={TH}>Bulan lalu</th>}
              {compared && <th className={cn(TH, "hidden sm:table-cell")}>Perubahan</th>}
              <th className={cn(TH, "pr-6")}>Tahun berjalan</th>
            </tr>
          </thead>
          <tbody>
            {margins.rows.map((r) => (
              <tr key={r.key} data-testid={`insight-margin-${r.key}`}>
                <td className="py-1.5 pr-3 pl-6">{r.label}</td>
                <td className={TD} data-testid="current">{cell(r.current, ratioHref)}</td>
                {compared && <td className={TD}>{cell(r.previous, ratioHref)}</td>}
                {compared && (
                  <td className={cn(TD, "num hidden whitespace-nowrap sm:table-cell")}>
                    {r.points === null ? <span className="text-muted-foreground">–</span> : r.points === 0n ? "tetap" : `${r.points > 0n ? "+" : "−"}${pointsText(r.points)}`}
                  </td>
                )}
                <td className={cn(TD, "pr-6")}>{cell(r.ytd, plHref)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

/** One mover: the account (opens its Buku Besar), the figures, the threshold mark, its largest lines, then the explanation slot. */
export function MoverRow({ mover, months, currency, ledgerHref, children }: { mover: InsightMover; months: number; currency: string; ledgerHref: string; children?: React.ReactNode }) {
  const m = mover;
  return (
    <li id={`mover-${m.code}`} className="scroll-mt-20 space-y-3 px-6 py-4" data-testid={`mover-${m.code}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Link href={ledgerHref} className="drill inline-flex items-center gap-1 font-medium" data-testid="mover-account">
          <span className="num">{m.code}</span> {m.name} <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
        </Link>
        {m.flagged && <StatusPill status="REVIEW" label="Melewati ambang" />}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <Figure label="Bulan ini"><Money value={m.current} currency={currency} /></Figure>
        <Figure label={months ? `Rata-rata ${months} bulan` : "Rata-rata"}>{m.average === null ? <span className="text-muted-foreground">Belum ada</span> : <Money value={m.average} currency={currency} />}</Figure>
        <Figure label="Selisih"><Money value={m.delta} currency={currency} /></Figure>
        <Figure label="Perubahan">{m.percent === null ? <span className="text-muted-foreground">–</span> : <span className="num">{m.delta < 0n ? "−" : "+"}{m.percent.replace(/^−/, "")}</span>}</Figure>
      </dl>
      {m.lines.length > 0 && (
        <div className="space-y-1">
          <div className="eyebrow">Baris terbesar bulan ini</div>
          <ul className="space-y-1 text-sm" data-testid="mover-lines">
            {m.lines.map((l) => (
              <li key={l.id} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className="num text-muted-foreground">{formatDate(l.date)}</span> {l.memo}
                  {l.source && <span className="block text-xs text-muted-foreground">{l.source}</span>}
                </div>
                <Money value={l.amount} currency={currency} className="shrink-0" />
              </li>
            ))}
          </ul>
        </div>
      )}
      {children}
    </li>
  );
}

function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

/** The baseline months as words ("Mei 26 – Jul 26"), for the movers' card. */
export function baselineLabel(baseline: string[]): string {
  const label = (k: string) => formatMonthShort(Number(k.slice(0, 4)), Number(k.slice(5)));
  return baseline.length === 0 ? "" : baseline.length === 1 ? label(baseline[0]) : `${label(baseline[0])} – ${label(baseline.at(-1)!)}`;
}
