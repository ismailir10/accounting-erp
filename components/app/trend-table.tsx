import Link from "next/link";
import { cn } from "@/lib/utils";
import { Money } from "@/components/app/money";
import type { MonthCol, RatioRow, TrendRow } from "@/lib/reports/analysis";

/**
 * A month-by-month table (Analisis keuangan): the label column stays put while the months scroll inside the card, so the page itself
 * never scrolls sideways (ui-rules 8). Accounts open their Buku Besar for the selected month.
 */
export function TrendTable({ months, rows, totalLabel, currency, href }: { months: MonthCol[]; rows: TrendRow[]; totalLabel?: string; currency: string; href: (code: string) => string }) {
  return (
    <div className="overflow-x-auto" data-testid="trend-table">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b">
            <th className="sticky left-0 z-10 min-w-44 bg-card py-2 pl-6 text-left font-medium text-muted-foreground sm:min-w-64">Pos</th>
            {months.map((m) => (
              <th key={m.key} className="num px-3 py-2 text-right font-medium whitespace-nowrap text-muted-foreground">{m.label}</th>
            ))}
            {totalLabel && <th className="num sticky right-0 z-10 border-l bg-card py-2 pr-6 pl-3 text-right font-medium whitespace-nowrap">{totalLabel}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) =>
            r.kind === "heading" ? (
              <tr key={r.key}>
                <td className="sticky left-0 z-10 bg-card pt-4 pb-1 pl-6 text-xs font-medium text-muted-foreground" colSpan={1}>{r.label}</td>
                <td colSpan={months.length} />
                {totalLabel && <td className="sticky right-0 z-10 border-l bg-card" />}
              </tr>
            ) : (
              <tr key={r.key} className={cn(r.kind === "total" && "border-t font-semibold", r.kind === "line" && "font-medium")} data-testid={`trend-${r.key}`}>
                <td className={cn("sticky left-0 z-10 bg-card py-1.5 pr-3", r.kind === "account" ? "pl-10 text-muted-foreground" : "pl-6")}>
                  {r.code ? (
                    <Link href={href(r.code)} className="drill">
                      <span className="num">{r.code}</span> {r.label}
                    </Link>
                  ) : (
                    r.label
                  )}
                </td>
                {r.values.map((v, i) => (
                  <td key={months[i].key} className="px-3 py-1.5 text-right">
                    <Money value={v} currency={currency} muted={r.kind === "account"} />
                  </td>
                ))}
                {totalLabel && <td className="sticky right-0 z-10 border-l bg-card py-1.5 pr-6 pl-3 text-right">{r.total !== undefined && <Money value={r.total} currency={currency} strong={r.kind !== "account"} />}</td>}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Ratios per month, grouped, each with the formula under its name. Working capital is a Rupiah amount; the rest are formatted text. */
export function RatioTable({ months, rows, currency }: { months: MonthCol[]; rows: RatioRow[]; currency: string }) {
  return (
    <div className="overflow-x-auto" data-testid="ratio-table">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b">
            <th className="sticky left-0 z-10 min-w-44 bg-card py-2 pl-6 text-left font-medium text-muted-foreground sm:min-w-64">Rasio</th>
            {months.map((m) => (
              <th key={m.key} className="num px-3 py-2 pr-6 text-right font-medium whitespace-nowrap text-muted-foreground last:pr-6">{m.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <RatioLine key={r.key} row={r} heading={i === 0 || rows[i - 1].group !== r.group} months={months} currency={currency} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RatioLine({ row, heading, months, currency }: { row: RatioRow; heading: boolean; months: MonthCol[]; currency: string }) {
  return (
    <>
      {heading && (
        <tr>
          <td className="sticky left-0 z-10 bg-card pt-4 pb-1 pl-6 text-xs font-medium text-muted-foreground">{row.group}</td>
          <td colSpan={months.length} />
        </tr>
      )}
      <tr data-testid={`ratio-${row.key}`}>
        <td className="sticky left-0 z-10 bg-card py-1.5 pr-3 pl-6">
          {row.label}
          <span className="block text-xs text-muted-foreground">{row.formula}</span>
        </td>
        {row.values.map((v, i) => (
          <td key={months[i].key} className="num px-3 py-1.5 text-right whitespace-nowrap align-top">
            {v === null ? <span className="text-muted-foreground">–</span> : row.amount ? <Money value={BigInt(v)} currency={currency} /> : v}
          </td>
        ))}
      </tr>
    </>
  );
}
