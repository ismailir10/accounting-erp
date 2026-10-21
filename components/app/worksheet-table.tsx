import Link from "next/link";
import { Money } from "@/components/app/money";
import { StatusPill } from "@/components/app/status";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Worksheet } from "@/lib/reports/worksheet";

const PAIRS = ["Neraca Saldo", "Penyesuaian", "Neraca Saldo Disesuaikan", "Laba Rugi", "Neraca"] as const;

/**
 * Neraca Lajur: five debit/kredit pairs per account (lib/reports/worksheet.ts), the totals, and the profit that balances Laba Rugi and
 * Neraca. Each pair's balance is stated in words, not colour only. The table scrolls inside its own box on a phone.
 */
export function WorksheetTable({ w, currency, href }: { w: Worksheet; currency: string; href: (code: string) => string }) {
  const cell = (v: bigint, key: string | number, last = false) => (
    <TableCell key={key} className={`text-right ${last ? "pr-6" : ""}`}>{v ? <Money value={v} currency={currency} /> : null}</TableCell>
  );
  const d = (net: bigint) => (net > 0n ? net : 0n);
  const k = (net: bigint) => (net < 0n ? -net : 0n);
  /** A row's ten amounts, in column order, as cells; the last one carries the right padding. */
  const cells = (values: bigint[]) => values.map((v, i) => cell(v, i, i === values.length - 1));
  const t = w.totals;
  const p = w.profit;
  const ok = t.unadjusted.debit === t.unadjusted.credit && t.adjustments.debit === t.adjustments.credit && t.adjusted.debit === t.adjusted.credit && t.bs.debit - t.bs.credit === p;
  return (
    <Table data-testid="neraca-lajur">
      <TableHeader>
        <TableRow>
          <TableHead className="pl-6" rowSpan={2}>Akun</TableHead>
          {PAIRS.map((label, i) => (
            <TableHead key={label} colSpan={2} className={`border-l text-center whitespace-normal ${i === 4 ? "pr-6" : ""}`}>{label}</TableHead>
          ))}
        </TableRow>
        <TableRow>
          {PAIRS.flatMap((label, i) => [
            <TableHead key={`${label}-d`} className="border-l text-right">Debit</TableHead>,
            <TableHead key={`${label}-k`} className={`text-right ${i === 4 ? "pr-6" : ""}`}>Kredit</TableHead>,
          ])}
        </TableRow>
      </TableHeader>
      <TableBody>
        {w.lines.map((l) => (
          <TableRow key={l.account.id} data-testid="neraca-lajur-row">
            <TableCell className="min-w-48 pl-6 whitespace-normal">
              <span className="num mr-2 text-muted-foreground">{l.account.code}</span>
              <Link className="drill" href={href(l.account.code)}>{l.account.name}</Link>
            </TableCell>
            {cells([d(l.unadjusted), k(l.unadjusted), l.adjDebit, l.adjCredit, d(l.adjusted), k(l.adjusted), l.pl ? d(l.adjusted) : 0n, l.pl ? k(l.adjusted) : 0n, l.pl ? 0n : d(l.adjusted), l.pl ? 0n : k(l.adjusted)])}
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell className="pl-6">
            <span className="mr-2 font-semibold">Jumlah</span>
            <StatusPill status={ok ? "PASS" : "FAIL"} label={ok ? "Seimbang" : "Tidak seimbang"} />
          </TableCell>
          {cells([t.unadjusted.debit, t.unadjusted.credit, t.adjustments.debit, t.adjustments.credit, t.adjusted.debit, t.adjusted.credit, t.pl.debit, t.pl.credit, t.bs.debit, t.bs.credit])}
        </TableRow>
        <TableRow data-testid="neraca-lajur-profit">
          <TableCell className="pl-6 font-medium">{p >= 0n ? "Laba bersih" : "Rugi bersih"}</TableCell>
          <TableCell colSpan={6} />
          {cells([d(p), k(p), k(p), d(p)])}
        </TableRow>
        <TableRow>
          <TableCell className="pl-6 font-semibold">Jumlah setelah laba (rugi)</TableCell>
          <TableCell colSpan={6} />
          {cells([t.pl.debit + d(p), t.pl.credit + k(p), t.bs.debit + k(p), t.bs.credit + d(p)])}
        </TableRow>
      </TableFooter>
    </Table>
  );
}
