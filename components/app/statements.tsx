import { Fragment } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Money } from "@/components/app/money";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { frameworkLabel, type Framework } from "@/lib/reports/framework";
import { EQUITY_ROWS, EQUITY_ROW_LABEL, type CashFlow, type EquityChanges } from "@/lib/reports/statements";
import { formatDate } from "@/lib/format";
import type { NoteCell, Notes } from "@/lib/reports/notes";

/** Account codes as links to their ledgers (every figure drills to its accounts, then to its source rows). */
function Codes({ codes, accountHref }: { codes: string[]; accountHref: (code: string) => string }) {
  return (
    <>
      {codes.map((c, i) => (
        <Fragment key={c}>
          {i > 0 && ", "}
          <Link href={accountHref(c)} className="num drill" data-testid="fs-account-link">{c}</Link>
        </Fragment>
      ))}
    </>
  );
}

/** Laporan Perubahan Ekuitas: one column per equity line, a total column; rows from the opening balance to the closing one. */
export function EquityTable({ data, currency, accountHref, framework = "SAK_EP" }: { data: EquityChanges; currency: string; accountHref: (code: string) => string; framework?: Framework }) {
  const rows = EQUITY_ROWS.filter((r) => r === "opening" || r === "closing" || data.totals[r] !== 0n || data.values[r].some((v) => v !== 0n));
  return (
    <div className="overflow-x-auto">
      <Table data-testid="equity-changes">
        <TableHeader>
          <TableRow>
            <TableHead className="py-2 pl-6" />
            {data.columns.map((c) => (
              <TableHead key={c.fsLine} className="py-2 pr-4 text-right font-medium whitespace-normal">
                {c.label}
                {c.codes.length > 0 && <div className="text-xs font-normal normal-case"><Codes codes={c.codes} accountHref={accountHref} /></div>}
              </TableHead>
            ))}
            <TableHead className="py-2 pr-6 text-right font-medium">Jumlah</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const edge = r === "opening" || r === "closing";
            const label = r === "opening" ? `Saldo ${formatDate(data.openedAt)}` : r === "closing" ? `Saldo ${formatDate(data.to)}` : frameworkLabel(framework, EQUITY_ROW_LABEL[r]);
            return (
              <TableRow key={r} className={cn(edge && "font-medium", r === "closing" && "border-t-2 border-foreground/15")} data-testid={`equity-${r}`}>
                <TableCell className="py-1.5 pl-6 whitespace-normal">{label}</TableCell>
                {data.values[r].map((v, i) => <TableCell key={i} className="py-1.5 pr-4 text-right"><Money value={v} currency={currency} /></TableCell>)}
                <TableCell className="py-1.5 pr-6 text-right"><Money value={data.totals[r]} strong={edge} currency={currency} /></TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {data.totals.closing !== data.balanceSheetEquity && (
        <p className="px-6 pt-3 text-sm text-fail">Ekuitas di Neraca <Money value={data.balanceSheetEquity} currency={currency} />; selisih <Money value={data.totals.closing - data.balanceSheetEquity} currency={currency} />.</p>
      )}
    </div>
  );
}

/** Laporan Arus Kas (indirect): operating from net profit, investing, financing, then the change and the cash balances. */
export function CashFlowTable({ data, currency, accountHref, framework = "SAK_EP" }: { data: CashFlow; currency: string; accountHref: (code: string) => string; framework?: Framework }) {
  const section = (title: string, items: CashFlow["operating"], total: bigint, totalLabel: string, lead?: { label: string; amount: bigint }) => (
    <Fragment>
      <TableRow className="border-b-0 hover:bg-transparent">
        <TableCell colSpan={2} className="eyebrow pt-5 pb-1 pl-6 whitespace-normal">{title}</TableCell>
      </TableRow>
      {lead && (
        <TableRow className="border-b-0">
          <TableCell className="py-1.5 pl-6 whitespace-normal">{frameworkLabel(framework, lead.label)}</TableCell>
          <TableCell className="py-1.5 pr-6 text-right"><Money value={lead.amount} currency={currency} /></TableCell>
        </TableRow>
      )}
      {items.map((i) => (
        <TableRow key={i.key} className="border-b-0 text-muted-foreground">
          <TableCell className="py-1 pl-10 whitespace-normal">{frameworkLabel(framework, i.label)} <span className="text-xs">(<Codes codes={i.codes} accountHref={accountHref} />)</span></TableCell>
          <TableCell className="py-1 pr-6 text-right"><Money value={i.amount} currency={currency} /></TableCell>
        </TableRow>
      ))}
      <TableRow className="border-t-2 border-b-0 border-foreground/15 hover:bg-transparent">
        <TableCell className="py-2 pl-6 font-medium whitespace-normal">{totalLabel}</TableCell>
        <TableCell className="py-2 pr-6 text-right"><Money value={total} strong currency={currency} /></TableCell>
      </TableRow>
    </Fragment>
  );
  return (
    <Table data-testid="cash-flow">
      <TableBody>
        {section("Arus kas dari aktivitas operasi", data.operating, data.totals.OPERATING, "Kas bersih dari aktivitas operasi", { label: "Laba bersih", amount: data.netProfit })}
        {section("Arus kas dari aktivitas investasi", data.investing, data.totals.INVESTING, "Kas bersih dari aktivitas investasi")}
        {section("Arus kas dari aktivitas pendanaan", data.financing, data.totals.FINANCING, "Kas bersih dari aktivitas pendanaan")}
        <TableRow className="border-t-2 border-foreground/15 font-medium" data-testid="cash-net">
          <TableCell className="py-2 pl-6 whitespace-normal">Kenaikan (penurunan) bersih kas dan setara kas</TableCell>
          <TableCell className="py-2 pr-6 text-right"><Money value={data.net} strong currency={currency} /></TableCell>
        </TableRow>
        {data.fxEffect !== 0n && (
          <TableRow className="border-b-0" data-testid="cash-fx-effect">
            <TableCell className="py-1.5 pl-6 whitespace-normal">Pengaruh perubahan kurs terhadap kas dan setara kas</TableCell>
            <TableCell className="py-1.5 pr-6 text-right"><Money value={data.fxEffect} currency={currency} /></TableCell>
          </TableRow>
        )}
        <TableRow className="border-b-0">
          <TableCell className="py-1.5 pl-6 whitespace-normal">Kas dan setara kas {formatDate(data.openedAt)}</TableCell>
          <TableCell className="py-1.5 pr-6 text-right"><Money value={data.openingCash} currency={currency} /></TableCell>
        </TableRow>
        {data.joinedCash !== 0n && data.joinedOn && (
          <TableRow className="border-b-0" data-testid="cash-joined">
            <TableCell className="py-1.5 pl-6 whitespace-normal">Kas entitas yang bergabung (saldo awal {formatDate(data.joinedOn)})</TableCell>
            <TableCell className="py-1.5 pr-6 text-right"><Money value={data.joinedCash} currency={currency} /></TableCell>
          </TableRow>
        )}
        <TableRow className="font-semibold" data-testid="cash-closing">
          <TableCell className="py-2 pl-6 whitespace-normal">Kas dan setara kas {formatDate(data.to)}</TableCell>
          <TableCell className="py-2 pr-6 text-right"><Money value={data.closingCash} strong currency={currency} /></TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

/** A paragraph with its *[isi oleh manajemen: …]* parts in review colour: what management still has to write before the CALK is sent. */
function Manual({ text }: { text: string }) {
  const parts = text.split(/(\[isi oleh manajemen: [^\]]*\])/);
  return <>{parts.map((part, i) => (i % 2 ? <span key={i} className="font-medium text-review" data-testid="calk-manual">{part}</span> : part))}</>;
}

/** CALK draft: numbered notes with their text and tables, then the directors' statement. */
export function NotesView({ data, currency, accountHref }: { data: Notes; currency: string; accountHref: (code: string) => string }) {
  const cell = (c: NoteCell, i: number, strong = false) => {
    if (typeof c === "bigint") return <Money value={c} strong={strong} currency={currency} />;
    // An account row ("1130 Piutang Usaha") opens that account's ledger.
    const account = i === 0 && typeof c === "string" ? c.match(/^(\d[\w.-]*) (.+)$/) : null;
    if (account) return <span className="whitespace-normal"><Codes codes={[account[1]]} accountHref={accountHref} /> {account[2]}</span>;
    return <span className={cn(i === 0 && "whitespace-normal")}>{c ?? ""}</span>;
  };
  return (
    <div className="space-y-8 px-6" data-testid="notes">
      {data.notes.map((n) => (
        <section key={n.number} className="space-y-2" data-testid={`note-${n.number}`}>
          <h3 className="font-semibold">{n.number}. {n.title}</h3>
          {n.paragraphs.map((p, i) => <p key={i} className="text-sm leading-relaxed text-muted-foreground"><Manual text={p} /></p>)}
          {n.tables.map((t, ti) => (
            <div key={ti} className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[320px] text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>{t.columns.map((c, i) => <th key={i} className={cn("px-3 py-1.5 font-medium", i === 0 ? "text-left" : "text-right")}>{c}</th>)}</tr>
                </thead>
                <tbody>
                  {t.rows.map((r, ri) => (
                    <tr key={ri} className="border-t">{r.map((c, i) => <td key={i} className={cn("px-3 py-1", i === 0 ? "text-left" : "text-right")}>{cell(c, i)}</td>)}</tr>
                  ))}
                  {t.total && <tr className="border-t-2 border-foreground/15 font-medium">{t.total.map((c, i) => <td key={i} className={cn("px-3 py-1.5", i === 0 ? "text-left" : "text-right")}>{cell(c, i, true)}</td>)}</tr>}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      ))}
      <section className="space-y-1 border-t pt-6 text-sm" data-testid="directors-statement">
        {data.directors.map((line, i) => <p key={i} className={cn(i < 3 && "text-center font-semibold")}>{line}</p>)}
      </section>
    </div>
  );
}
