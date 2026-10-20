"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SplitDialog, SplitSummary, type SplitPartView } from "@/components/app/split-dialog";
import { AccountPicker, type AccountOption } from "@/components/app/account-picker";
import { reverseEntryAction, reviewAction, unpairTransferAction } from "@/app/actions";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MethodBadge } from "@/components/app/status";
import { Input } from "@/components/ui/input";
import { SimpleSelect } from "@/components/app/simple-select";
import { formatMoney } from "@/lib/money";
import { RECEIPT_KINDS, WITHHOLDING_KINDS, WITHHOLDING_LABEL } from "@/lib/tax/withholding";
import type { WithholdingKind } from "@/lib/generated/prisma/enums";
import { ENTRY_KIND_LABEL } from "@/lib/reports/entry-source";
import { formNotice, type SourceRoute } from "@/lib/approvals/second";

export type LedgerRow = {
  id: string;
  date: string;
  entity: string;
  memo: string;
  kind: string;
  /** "Nama · 27 Sep 2026, 14:02" — who posted the entry and when; "Sistem" for seeds. */
  postedBy?: string;
  /** Persetujuan kedua: "Diajukan <maker> · Disetujui <approver>" when it came through a second approver. */
  approval?: string | null;
  /** The proposal the entry was approved from ("Usulan AI 6120 (92 %) disetujui"), if any (lib/reports/entry-origin.ts). */
  origin?: string | null;
  debit: string;
  credit: string;
  balance: string;
  entry: { lines: { code: string; name: string; debit: string; credit: string; memo?: string | null }[] };
  /** Adjustments: whether *Balik jurnal* applies (blocker = why not, and where it is changed instead), and the entry's date. */
  reversal?: { entryId: string; blocker: string | null; date: string };
  source: null | { bankTxId: string; accountCode: string | null; taxTag: string | null; whtKind: string | null; whtAmount: string; fileName: string; sheet: string | null; rowNumber: number; rawRow: string; description: string; amount: string; bank: string; method: string; reason: string; status: string; /** The other half of a transfer pair, when it has one. */ pairedWith?: string | null; /** A split line's parts (pecah transaksi). */ splits?: SplitPartView[]; /** Who changed this line, newest first (ADR 0013). */ history?: { at: string; actor: string; summary: string }[] };
  /** Ledger / Neraca import: file, entry rows, this line's row, the client's own account, and the original fx amount. */
  fileSource?: null | { fileName: string; entryRef: string; lineRef: string | null; sourceAccount: string | null; lineMemo: string | null; fx: string | null };
};

const KIND: Record<string, string> = ENTRY_KIND_LABEL;

/** Every GL line opens its source: the full journal and — for bank lines — the original statement row, for imports the file row. */
export function LedgerTable({ rows, opening, priorYearProfit, currency = "IDR", accounts, reverseRoute }: { rows: LedgerRow[]; opening: string; /** Saldo laba only: earlier years' result folded into the opening, as in the Neraca Saldo. */ priorYearProfit?: string; currency?: string; accounts?: AccountOption[]; /** Persetujuan kedua's *Jurnal manual* for this member: *Balik jurnal* above it waits. */ reverseRoute?: SourceRoute }) {
  // The reversal's amount is the original's Σdebit, in the books' currency.
  const reverseNotice = (r: LedgerRow) => formNotice(reverseRoute, r.entry.lines.reduce((s, l) => s + BigInt(l.debit), 0n), currency);
  const router = useRouter();
  const [open, setOpen] = useState<LedgerRow | null>(null);
  const [newCode, setNewCode] = useState("");
  const [saving, setSaving] = useState(false);
  // Tax withheld from this payment/receipt (not in the bank amount): "" = none. Amount in major units.
  const [whtKind, setWhtKind] = useState("");
  const [whtAmount, setWhtAmount] = useState("");
  const [reverseDate, setReverseDate] = useState("");
  const reverse = async () => {
    if (!open?.reversal) return;
    setSaving(true);
    const r = await reverseEntryAction({ entryId: open.reversal.entryId, date: reverseDate });
    setSaving(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(r.pending ? "Jurnal menunggu persetujuan" : "Jurnal pembalik dicatat");
    setOpen(null);
    router.refresh();
  };
  const show = (r: LedgerRow | null) => {
    setOpen(r);
    // The reversal goes on the 1st of the month after the entry by default (an accrual reversed next month).
    if (r?.reversal) {
      const [y, m] = r.reversal.date.split("-").map(Number);
      setReverseDate(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`);
    }
    setNewCode(r?.source?.accountCode ?? "");
    setWhtKind(r?.source?.whtKind ?? "");
    setWhtAmount(r?.source && BigInt(r.source.whtAmount) > 0n ? formatMoney(BigInt(r.source.whtAmount), currency, { bare: true }) : "");
  };
  const moneyIn = open?.source ? BigInt(open.source.amount) > 0n : false;
  const whtChanged = Boolean(open?.source) && (whtKind !== (open!.source!.whtKind ?? "") || (whtKind !== "" && whtAmount.replace(/\D/g, "") !== (BigInt(open!.source!.whtAmount) > 0n ? open!.source!.whtAmount : "")));
  // A bank line's classification can change after it was accepted: the reviewer's writer posts a RECLASS of the difference
  // (rule 3) and memory learns it; a locked month refuses with the lock message.
  const reclass = async () => {
    if (!open?.source || !newCode) return;
    setSaving(true);
    if (whtKind && !whtAmount.trim()) {
      setSaving(false);
      return void toast.error("Isi nominal pajak yang dipotong.");
    }
    const split = Boolean(open.source.splits?.length);
    const r = await reviewAction({ bankTxId: open.source.bankTxId, accountCode: newCode, taxTag: open.source.taxTag as never, ...(split ? { replaceSplit: true } : whtChanged ? { withholding: whtKind ? { kind: whtKind as WithholdingKind, amount: whtAmount } : null } : {}) });
    setSaving(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(`Dipindah ke ${newCode}`, { description: "Reklasifikasi dicatat · Buku Besar diperbarui" });
    show(null);
    router.refresh();
  };
  const unpair = async () => {
    if (!open?.source) return;
    setSaving(true);
    const r = await unpairTransferAction({ bankTxId: open.source.bankTxId });
    setSaving(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success("Pasangan dilepas", { description: "Kedua mutasi kembali ke Review" });
    show(null);
    router.refresh();
  };
  const m = (s: string) => (BigInt(s) === 0n ? "" : formatMoney(BigInt(s), currency, { bare: true }));
  const acc = (s: string) => formatMoney(BigInt(s), currency, { bare: true, accounting: true });
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-6">Tanggal</TableHead>
            <TableHead>Keterangan</TableHead>
            <TableHead className="text-right">Debit</TableHead>
            <TableHead className="text-right">Kredit</TableHead>
            <TableHead className="pr-6 text-right">Saldo</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow className="bg-muted/40">
            <TableCell className="pl-6 text-muted-foreground" colSpan={4}>
              Saldo awal periode
              {priorYearProfit && BigInt(priorYearProfit) !== 0n && <span className="block text-xs" data-testid="ledger-prior-year">termasuk laba (rugi) tahun-tahun lalu {acc(priorYearProfit)}</span>}
            </TableCell>
            <TableCell className="num pr-6 text-right font-medium">{acc(opening)}</TableCell>
          </TableRow>
          {rows.map((r) => (
            <TableRow key={r.id} className="cursor-pointer" onClick={() => show(r)} data-testid="ledger-row">
              <TableCell className="num pl-6 whitespace-nowrap text-muted-foreground">{r.date}</TableCell>
              <TableCell className="max-w-md">
                <button type="button" className="block max-w-full truncate text-left drill" onClick={(e) => { e.stopPropagation(); show(r); }}>{r.memo}</button>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  {KIND[r.kind]} · {r.entity}
                  {(r.source || r.fileSource) && <FileText className="size-3" aria-label="Ada sumber" />}
                </div>
              </TableCell>
              <TableCell className="num text-right">{m(r.debit)}</TableCell>
              <TableCell className="num text-right">{m(r.credit)}</TableCell>
              <TableCell className="num pr-6 text-right">{acc(r.balance)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Sheet open={Boolean(open)} onOpenChange={(o) => !o && show(null)}>
        <SheetContent className="w-full overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
          {open && (
            <>
              <SheetHeader>
                <SheetTitle>{KIND[open.kind]} · {open.date}</SheetTitle>
                <SheetDescription>
                  {open.memo}
                  {open.postedBy && <span className="mt-1 block text-xs">Dicatat oleh {open.postedBy}</span>}
                  {open.approval && <span className="mt-0.5 block text-xs" data-testid="entry-approval">{open.approval}</span>}
                  {open.origin && <span className="mt-0.5 block text-xs" data-testid="entry-origin">Asal: {open.origin}</span>}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-6 px-4 pb-6">
                {open.source && (
                  <section data-testid="source-row">
                    <h3 className="mb-2 text-sm font-semibold">Sumber: baris rekening koran</h3>
                    <dl className="grid grid-cols-3 gap-y-1.5 text-sm">
                      <dt className="text-muted-foreground">Rekening</dt><dd className="col-span-2">{open.source.bank}</dd>
                      <dt className="text-muted-foreground">File</dt><dd className="col-span-2 font-mono text-xs">{open.source.fileName}, {open.source.sheet ? `lembar ${open.source.sheet}, ` : ""}baris {open.source.rowNumber}</dd>
                      <dt className="text-muted-foreground">Nominal</dt><dd className="num col-span-2">{formatMoney(BigInt(open.source.amount), currency)}</dd>
                      <dt className="text-muted-foreground">Klasifikasi</dt><dd className="col-span-2 flex items-center gap-2"><MethodBadge method={open.source.method} /> <span className="text-xs text-muted-foreground">{open.source.reason}</span></dd>
                      {open.source.splits && open.source.splits.length > 0 && (<><dt className="text-muted-foreground">Bagian</dt><dd className="col-span-2"><SplitSummary parts={open.source.splits} currency={currency} /></dd></>)}
                    </dl>
                    <pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-all">{open.source.rawRow}</pre>
                    {open.source.history && open.source.history.length > 0 && (
                      <div className="mt-4 space-y-2 border-t pt-4" data-testid="line-history">
                        <h4 className="text-sm font-semibold">Riwayat</h4>
                        <ul className="space-y-1.5 text-sm">
                          {open.source.history.map((h, i) => (
                            <li key={i}>
                              {h.summary}
                              <span className="block text-xs text-muted-foreground">{h.actor} · {h.at}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {open.source.pairedWith && (
                      <div className="mt-4 space-y-2 border-t pt-4" data-testid="transfer-pair">
                        <h4 className="text-sm font-semibold">Pasangan transfer</h4>
                        <p className="text-sm">{open.source.pairedWith}</p>
                        <p className="text-xs text-muted-foreground">Bukan transfer yang sama? Lepas pasangannya: kedua mutasi kembali ke Review dan tidak akan dipasangkan lagi.</p>
                        <Button size="sm" variant="outline" disabled={saving} onClick={unpair}>Lepas pasangan</Button>
                      </div>
                    )}
                    {accounts && (
                      <div className="mt-4 space-y-2 border-t pt-4" data-testid="reclass">
                        <h4 className="text-sm font-semibold">Ubah akun</h4>
                        <p className="text-xs text-muted-foreground">Sisi bank tetap; Buku mencatat reklasifikasi selisihnya dan mengingat pilihan ini.</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <AccountPicker value={newCode} onChange={setNewCode} options={accounts} ariaLabel="Akun baru" className="w-80 max-w-full" />
                          <Button size="sm" disabled={saving || !newCode || (newCode === open.source.accountCode && !whtChanged && !open.source.splits?.length)} onClick={reclass}>{open.source.splits?.length ? "Gabungkan ke akun ini" : "Simpan"}</Button>
                          {!open.source.pairedWith && (
                            <SplitDialog
                              bankTxId={open.source.bankTxId}
                              amount={open.source.amount}
                              currency={currency}
                              accounts={accounts}
                              initial={open.source.splits}
                              trigger={open.source.splits?.length ? "Ubah pecahan" : "Pecah"}
                              onDone={() => {
                                show(null);
                                router.refresh();
                              }}
                            />
                          )}
                        </div>
                        {open.source.splits && open.source.splits.length > 0 ? (
                          <p className="text-xs text-muted-foreground">Mutasi ini dipecah. “Gabungkan ke akun ini” mengembalikan seluruh nominal ke satu akun; pajak yang dipotong bisa dicatat setelah digabung.</p>
                        ) : (<>
                        <div className="flex flex-wrap items-center gap-2 pt-2" data-testid="withholding">
                          <SimpleSelect
                            label="Pajak yang dipotong"
                            value={whtKind || "none"}
                            onChange={(v) => setWhtKind(v === "none" ? "" : v)}
                            options={[{ value: "none", label: "Tidak ada pajak dipotong" }, ...(moneyIn ? RECEIPT_KINDS : WITHHOLDING_KINDS).map((k) => ({ value: k, label: WITHHOLDING_LABEL[k] }))]}
                          />
                          {whtKind && <Input aria-label="Nominal pajak dipotong" inputMode="decimal" className="num w-40 text-right" placeholder="Nominal" value={whtAmount} onChange={(e) => setWhtAmount(e.target.value)} />}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {moneyIn
                            ? "Pelanggan memotong pajak dari pembayarannya (mis. PPh 23): nominal ini tidak ada di mutasi bank; dicatat sebagai pajak dibayar di muka (PPh 4(2) final: beban pajak final) dan ikut melunasi piutang."
                            : "Anda memotong pajak dari pembayaran ini (mis. sewa dengan PPh 4(2)): nominal ini tidak ada di mutasi bank; dicatat sebagai utang pajak sampai disetor, dan ikut melunasi biaya atau utangnya."}
                        </p>
                        </>)}
                      </div>
                    )}
                  </section>
                )}
                {open.fileSource && (
                  <section data-testid="file-source">
                    <h3 className="mb-2 text-sm font-semibold">Sumber: baris file impor</h3>
                    <dl className="grid grid-cols-3 gap-y-1.5 text-sm">
                      <dt className="text-muted-foreground">File</dt><dd className="col-span-2 font-mono text-xs break-all">{open.fileSource.fileName}</dd>
                      {open.fileSource.lineRef && (<><dt className="text-muted-foreground">Baris ini</dt><dd className="col-span-2 font-mono text-xs">{open.fileSource.lineRef}</dd></>)}
                      <dt className="text-muted-foreground">Jurnal dari baris</dt><dd className="col-span-2 font-mono text-xs break-all">{open.fileSource.entryRef}</dd>
                      {open.fileSource.sourceAccount && (<><dt className="text-muted-foreground">Akun di file</dt><dd className="col-span-2">{open.fileSource.sourceAccount}</dd></>)}
                      {open.fileSource.fx && (<><dt className="text-muted-foreground">Valas</dt><dd className="num col-span-2">{open.fileSource.fx}</dd></>)}
                      {open.fileSource.lineMemo && (<><dt className="text-muted-foreground">Keterangan</dt><dd className="col-span-2 text-xs">{open.fileSource.lineMemo}</dd></>)}
                    </dl>
                  </section>
                )}
                <section>
                  <h3 className="mb-2 text-sm font-semibold">Jurnal</h3>
                  <Table className="table-fixed text-sm">
                    <TableHeader>
                      <TableRow><TableHead>Akun</TableHead><TableHead className="w-36 text-right">Debit</TableHead><TableHead className="w-36 text-right">Kredit</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {open.entry.lines.map((l, i) => (
                        <TableRow key={i}>
                          <TableCell className="truncate"><span className="num text-muted-foreground">{l.code}</span> {l.name}{l.memo && l.memo !== open.memo && <span className="block truncate text-xs text-muted-foreground">{l.memo}</span>}</TableCell>
                          <TableCell className="num text-right">{m(l.debit)}</TableCell>
                          <TableCell className="num text-right">{m(l.credit)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </section>
                {open.reversal && (
                  <section data-testid="reverse-entry" className="space-y-2">
                    <h3 className="text-sm font-semibold">Balik jurnal</h3>
                    {open.reversal.blocker ? (
                      <p className="text-sm text-muted-foreground">{open.reversal.blocker}</p>
                    ) : (
                      <>
                        <p className="text-sm text-muted-foreground">Jurnal asli tidak diubah: Buku mencatat jurnal baru dengan debit dan kredit dibalik, pada tanggal di bawah.</p>
                        <div className="flex flex-wrap items-end gap-2">
                          <label className="grid gap-1 text-sm">
                            <span className="text-xs text-muted-foreground">Tanggal jurnal pembalik</span>
                            <Input type="date" value={reverseDate} min={open.reversal.date} onChange={(e) => setReverseDate(e.target.value)} className="w-44" />
                          </label>
                          <Button variant="outline" disabled={saving || !reverseDate} onClick={reverse}>{saving ? "Mencatat…" : reverseNotice(open)?.waits ? "Ajukan persetujuan" : "Balik jurnal"}</Button>
                        </div>
                        {reverseNotice(open) && <p className="text-sm text-muted-foreground" data-testid="reverse-second-notice">{reverseNotice(open)!.text}</p>}
                      </>
                    )}
                  </section>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
