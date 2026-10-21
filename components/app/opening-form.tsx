"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { openingAction } from "@/app/actions";
import { formatMoney, moneyExample, parseMoney } from "@/lib/money";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ACCOUNT_CODES } from "@/lib/coa/template";
import { CURRENCY_CODES } from "@/lib/fx/currency";

/** `currency` + `fxAmount`: a balance held in another currency, given in that currency too (revalued at month end from then on). */
type Line = { accountCode: string; debit: string; credit: string; currency?: string; fxAmount?: string };
const RETAINED = ACCOUNT_CODES.RETAINED;
const DIFFERENCE = ACCOUNT_CODES.OPENING_DIFFERENCE;
type BankLine = { accountCode: string; label: string; prefill: string; source: string | null; isOverdraft?: boolean };

/** Typed amount → minor units, or the Bahasa reason it can't be read. */
const read = (s: string, currency: string): { value: bigint; error?: undefined } | { value: 0n; error: string } => {
  try {
    return { value: parseMoney(s, currency) };
  } catch (e) {
    return { value: 0n, error: (e as Error).message };
  }
};

/**
 * One entity's opening balances. Bank lines come first (prefilled from the first statement), then any other
 * balances (receivables, fixed assets, loans…), then Saldo Laba as typed from the client's Neraca. No plug (ADR 0012): a difference
 * left over is shown on 3290 Selisih Saldo Awal and becomes a Temuan that holds the close until it is decided in writing.
 * Amounts are typed in major units of the entity's `currency`; the server parses them the same way.
 */
export function OpeningForm({
  clientId,
  entityId,
  currency,
  suggestedDate,
  banks,
  accounts,
  deposits = [],
  loanRows = 0,
  company = true,
}: {
  clientId: string;
  entityId: string;
  currency: string;
  suggestedDate: string;
  banks: BankLine[];
  accounts: { code: string; name: string }[];
  /** Time deposits the statements list: proposed as lines the accountant can change or remove. */
  deposits?: { accountCode: string; amount: string; note: string }[];
  /** Imported rows suggested as loan principal: a loan balance at the opening date may be missing. */
  loanRows?: number;
  /** A company (PT/CV): its equity has paid-in capital to fill; an individual's hasn't. */
  company?: boolean;
}) {
  const router = useRouter();
  const [date, setDate] = useState(suggestedDate);
  const [bankBalances, setBankBalances] = useState(banks.map((b) => b.prefill));
  const [others, setOthers] = useState<Line[]>(deposits.map((d) => ({ accountCode: d.accountCode, debit: d.amount, credit: "" })));
  const [retained, setRetained] = useState<{ debit: string; credit: string }>({ debit: "", credit: "" });
  const [busy, setBusy] = useState(false);

  const cur = currency === "IDR" ? "" : ` (${currency})`;
  const bankParsed = bankBalances.map((v) => read(v, currency));
  const otherParsed = others.map((l) => ({ debit: read(l.debit, currency), credit: read(l.credit, currency), fx: l.currency ? read(l.fxAmount ?? "", l.currency) : null }));
  const retainedParsed = { debit: read(retained.debit, currency), credit: read(retained.credit, currency) };
  const error = [...bankParsed.map((p) => p.error), ...otherParsed.flatMap((p) => [p.debit.error, p.credit.error, p.fx?.error]), retainedParsed.debit.error, retainedParsed.credit.error].find(Boolean);
  // A bank balance is an asset: positive = debit, negative (overdraft) = credit. Sent back in the same major-unit
  // notation the server parses, never as raw minor units.
  const bankLines: Line[] = banks.map((b, i) => {
    const v = bankParsed[i].value;
    const major = formatMoney(v < 0n ? -v : v, currency, { bare: true });
    return { accountCode: b.accountCode, debit: v > 0n ? major : "", credit: v < 0n ? major : "" };
  });
  const lines = [...bankLines, ...others, ...(retained.debit || retained.credit ? [{ accountCode: RETAINED, ...retained }] : [])];
  const dr = bankParsed.reduce((s, p) => s + (p.value > 0n ? p.value : 0n), 0n) + otherParsed.reduce((s, p) => s + p.debit.value, 0n) + retainedParsed.debit.value;
  const cr = bankParsed.reduce((s, p) => s + (p.value < 0n ? -p.value : 0n), 0n) + otherParsed.reduce((s, p) => s + p.credit.value, 0n) + retainedParsed.credit.value;
  /** Debit minus credit of what is typed: positive leaves a credit on 3290, negative a debit. */
  const diff = dr - cr;
  // An explicit choice for a client without a Neraca: the difference becomes the Saldo Laba line (shown, editable), not a silent plug.
  const useAsRetained = () => {
    const net = retainedParsed.credit.value - retainedParsed.debit.value + diff;
    const major = formatMoney(net < 0n ? -net : net, currency, { bare: true });
    setRetained(net > 0n ? { debit: "", credit: major } : net < 0n ? { debit: major, credit: "" } : { debit: "", credit: "" });
  };
  const hasCapital = !company || others.some((l) => l.accountCode.startsWith("31"));
  const setOther = (i: number, patch: Partial<Line>) => setOthers((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  // A readable amount reads back formatted when the field is left ("800000000" → "800.000.000"), like Jurnal Penyesuaian; unreadable text
  // stays as typed for its message.
  const tidy = (text: string) => {
    const r = read(text, currency);
    if (r.error || r.value === 0n) return text;
    return r.value < 0n ? `-${formatMoney(-r.value, currency, { bare: true })}` : formatMoney(r.value, currency, { bare: true });
  };

  async function submit() {
    setBusy(true);
    try {
      const r = await openingAction({ clientId, entityId, date, lines });
      if (!r.ok) return void toast.error(r.error);
      toast.success(r.finding ? `Saldo awal tersimpan. Selisihnya dibuka sebagai temuan ${r.finding} di Tutup Buku.` : "Saldo awal tersimpan");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Field className="max-w-xs">
        <FieldLabel htmlFor={`opening-date-${entityId}`}>Per tanggal</FieldLabel>
        <Input id={`opening-date-${entityId}`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <FieldDescription>Sehari sebelum transaksi pertama yang akan diimpor.</FieldDescription>
      </Field>

      {(deposits.length > 0 || loanRows > 0) && (
        <div className="space-y-1 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
          {deposits.map((d) => (
            <p key={d.note}>
              Rekening koran mencantumkan <span className="font-medium">{d.note}</span> senilai <span className="num font-medium">{d.amount}</span>. Sudah ditambahkan di bawah ke akun {d.accountCode}; ganti akunnya atau hapus barisnya kalau tidak dipakai.
            </p>
          ))}
          {loanRows > 0 && (
            <p>
              Mutasi berisi {loanRows} angsuran atau pencairan pinjaman. Kalau ada sisa pinjaman per tanggal di atas, tambahkan saldonya di kredit 2210 Utang Bank.
            </p>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="p-2 pl-3 text-left font-medium">Akun</TableHead>
              <TableHead className="p-2 text-right font-medium">Debit{cur}</TableHead>
              <TableHead className="p-2 text-right font-medium">Kredit{cur}</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {banks.map((b, i) => (
              <TableRow key={b.accountCode} className="border-t">
                <TableCell className="p-2 pl-3">
                  <div className="font-medium">{b.accountCode} {b.label}</div>
                  <div className="text-xs text-muted-foreground">{b.source ?? "Belum ada rekening koran. Isi saldo dari rekening koran bulan sebelumnya."}</div>
                </TableCell>
                <TableCell className="p-2" colSpan={2}>
                  <Input
                    aria-label={`Saldo ${b.label}`}
                    aria-invalid={!!bankParsed[i].error || undefined}
                    inputMode="decimal"
                    className="num text-right"
                    value={bankBalances[i]}
                    onChange={(e) => setBankBalances((vs) => vs.map((v, j) => (j === i ? e.target.value : v)))}
                    onBlur={() => setBankBalances((vs) => vs.map((v, j) => (j === i ? tidy(v) : v)))}
                    placeholder={`Saldo di bank, mis. ${moneyExample(currency)}`}
                  />
                  {b.isOverdraft && <p className="mt-1 text-right text-xs text-muted-foreground">Negatif = utang ke bank (PRK), dicatat di kredit.</p>}
                </TableCell>
                <TableCell />
              </TableRow>
            ))}
            {others.map((l, i) => (
              <TableRow key={i} className="border-t">
                <TableCell className="p-2 pl-3">
                  <Select value={l.accountCode} onValueChange={(v) => setOther(i, { accountCode: v as string })}>
                    <SelectTrigger className="w-full min-w-64" aria-label={`Akun baris ${i + 1}`}><SelectValue placeholder="Pilih akun" /></SelectTrigger>
                    <SelectContent>{accounts.map((a) => <SelectItem key={a.code} value={a.code}>{a.code} {a.name}</SelectItem>)}</SelectContent>
                  </Select>
                  {/* A dollar account, receivable or loan: its foreign amount too, so month-end revaluation sees the whole balance. */}
                  {l.currency ? (
                    <div className="mt-1.5 flex items-center gap-2">
                      <Select value={l.currency} onValueChange={(v) => setOther(i, { currency: v as string })}>
                        <SelectTrigger size="sm" className="w-24" aria-label={`Mata uang baris ${i + 1}`}><SelectValue /></SelectTrigger>
                        <SelectContent>{CURRENCY_CODES.filter((c) => c !== currency).map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                      </Select>
                      <Input aria-label={`Nominal valas baris ${i + 1}`} aria-invalid={!!otherParsed[i].fx?.error || undefined} inputMode="decimal" className="num h-8 text-right" value={l.fxAmount ?? ""} onChange={(e) => setOther(i, { fxAmount: e.target.value })} placeholder={moneyExample(l.currency)} />
                      <Button variant="ghost" size="sm" onClick={() => setOther(i, { currency: undefined, fxAmount: undefined })}>Bukan valas</Button>
                    </div>
                  ) : (
                    <Button variant="link" size="sm" className="mt-1 h-auto p-0 text-xs" onClick={() => setOther(i, { currency: CURRENCY_CODES.find((c) => c !== currency && c !== "IDR") ?? "USD", fxAmount: "" })}>Saldo dalam valas?</Button>
                  )}
                </TableCell>
                <TableCell className="p-2"><Input aria-label="Debit" aria-invalid={!!otherParsed[i].debit.error || undefined} inputMode="decimal" className="num text-right" value={l.debit} onBlur={() => setOther(i, { debit: tidy(l.debit) })} onChange={(e) => setOther(i, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} placeholder={formatMoney(0n, currency, { bare: true })} /></TableCell>
                <TableCell className="p-2"><Input aria-label="Kredit" aria-invalid={!!otherParsed[i].credit.error || undefined} inputMode="decimal" className="num text-right" value={l.credit} onBlur={() => setOther(i, { credit: tidy(l.credit) })} onChange={(e) => setOther(i, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} placeholder={formatMoney(0n, currency, { bare: true })} /></TableCell>
                <TableCell className="p-2"><Button variant="ghost" size="icon-sm" aria-label="Hapus baris" onClick={() => setOthers((ls) => ls.filter((_, j) => j !== i))}><Trash2 /></Button></TableCell>
              </TableRow>
            ))}
            <TableRow className="border-t">
              <TableCell className="p-2 pl-3">
                <div className="font-medium">{RETAINED} Saldo Laba</div>
                <div className="text-xs text-muted-foreground">Dari neraca klien per tanggal di atas.</div>
              </TableCell>
              <TableCell className="p-2"><Input aria-label="Saldo Laba debit" aria-invalid={!!retainedParsed.debit.error || undefined} inputMode="decimal" className="num text-right" value={retained.debit} onBlur={() => setRetained((r) => ({ ...r, debit: tidy(r.debit) }))} onChange={(e) => setRetained({ debit: e.target.value, credit: e.target.value ? "" : retained.credit })} placeholder={formatMoney(0n, currency, { bare: true })} /></TableCell>
              <TableCell className="p-2"><Input aria-label="Saldo Laba kredit" aria-invalid={!!retainedParsed.credit.error || undefined} inputMode="decimal" className="num text-right" value={retained.credit} onBlur={() => setRetained((r) => ({ ...r, credit: tidy(r.credit) }))} onChange={(e) => setRetained({ credit: e.target.value, debit: e.target.value ? "" : retained.debit })} placeholder={formatMoney(0n, currency, { bare: true })} /></TableCell>
              <TableCell />
            </TableRow>
            {diff !== 0n && (
              <TableRow className="border-t bg-review-subtle/60" data-testid="opening-difference-row">
                <TableCell className="p-2 pl-3">
                  <div className="font-medium">{DIFFERENCE} Selisih Saldo Awal</div>
                  <div className="text-xs text-muted-foreground">Menjadi temuan sampai Anda memutuskan asalnya.</div>
                </TableCell>
                <TableCell className="num p-2 pr-5 text-right">{diff < 0n ? formatMoney(-diff, currency, { bare: true }) : "–"}</TableCell>
                <TableCell className="num p-2 pr-5 text-right">{diff > 0n ? formatMoney(diff, currency, { bare: true }) : "–"}</TableCell>
                <TableCell />
              </TableRow>
            )}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="p-2 pl-3 font-semibold">Jumlah</TableCell>
              <TableCell className="num p-2 pr-5 text-right font-semibold" data-testid="opening-total-debit">{formatMoney(diff < 0n ? dr - diff : dr, currency, { bare: true })}</TableCell>
              <TableCell className="num p-2 pr-5 text-right font-semibold">{formatMoney(diff > 0n ? cr + diff : cr, currency, { bare: true })}</TableCell>
              <TableCell />
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      {diff !== 0n && (
        <div className="space-y-2 rounded-md border border-review/40 bg-review-subtle px-3 py-2 text-sm" data-testid="opening-difference">
          <p>
            Debit dan kredit selisih {formatMoney(diff < 0n ? -diff : diff, currency)}. Selisih ini dicatat ke {DIFFERENCE} Selisih Saldo Awal dan dibuka sebagai{" "}
            <span className="font-medium">temuan</span>: Tutup Buku tertahan sampai Anda menulis dari mana asalnya.
            {!hasCapital && " Modal disetor (3100) belum diisi: bila klien punya modal disetor, isi barisnya dulu."}
          </p>
          <p className="text-muted-foreground">
            Klien tidak punya neraca, jadi saldo laba memang sisa dari saldo yang ada?{" "}
            <Button variant="link" size="sm" className="h-auto p-0 align-baseline" onClick={useAsRetained} data-testid="opening-use-retained">Pakai selisih sebagai Saldo Laba</Button>
          </p>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={submit} disabled={busy || !!error || (dr === 0n && cr === 0n)}>
          {busy ? "Menyimpan…" : "Simpan saldo awal"}
        </Button>
        <Button variant="outline" onClick={() => setOthers((ls) => [...ls, { accountCode: "", debit: "", credit: "" }])}>
          <Plus /> Tambah akun lain
        </Button>
        <span className="text-xs text-muted-foreground">Piutang, persediaan, aset tetap, utang, modal. Kosongkan kalau belum ada datanya.</span>
      </div>
    </div>
  );
}
