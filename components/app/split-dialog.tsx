"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Split, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AccountPicker, type AccountOption } from "@/components/app/account-picker";
import { splitTransactionAction } from "@/app/actions";
import { formatMoney, parseMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { isIntercompanyCode } from "@/lib/coa/template";

type Part = { accountCode: string; amount: string; memo: string };
export type SplitPartView = { accountCode: string; amount: string; memo: string | null };

/** "Dipecah: 6100 Rp 120.000.000 · 5110 Rp 80.000.000": a split line's parts, wherever the line is shown. */
export function SplitSummary({ parts, currency }: { parts: SplitPartView[]; currency: string }) {
  if (!parts.length) return null;
  return (
    <span className="text-sm" data-testid="split-summary">
      Dipecah: {parts.map((p, i) => <span key={i} className="num">{i > 0 && " · "}{p.accountCode} {formatMoney(BigInt(p.amount), currency)}</span>)}
    </span>
  );
}

/**
 * *Pecah transaksi* (UC-B3): one bank line across accounts. The parts must add up to the line; the remainder shows as you type and
 * saving waits until it is zero. The server checks again and its refusal is shown as it is.
 */
export function SplitDialog({ bankTxId, amount, currency, accounts, initial, onDone, trigger }: {
  bankTxId: string;
  /** The bank line's signed amount (minor units, as a string). */
  amount: string;
  currency: string;
  accounts: AccountOption[];
  initial?: SplitPartView[];
  onDone?: () => void;
  trigger?: string;
}) {
  const total = (() => {
    const a = BigInt(amount);
    return a < 0n ? -a : a;
  })();
  const blank = (): Part[] => [{ accountCode: "", amount: "", memo: "" }, { accountCode: "", amount: "", memo: "" }];
  const start = (): Part[] => (initial?.length ? initial.map((p) => ({ accountCode: p.accountCode, amount: formatMoney(BigInt(p.amount), currency, { bare: true }), memo: p.memo ?? "" })) : blank());
  const [open, setOpen] = useState(false);
  const [parts, setParts] = useState<Part[]>(start);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Accounts a part can't use (the server refuses them too): unclassified and the transfer accounts.
  const options = useMemo(() => accounts.filter((a) => !["1999", "1199"].includes(a.code) && !isIntercompanyCode(a.code)), [accounts]);

  const parsed = parts.map((p) => {
    if (!p.amount.trim()) return 0n;
    try {
      return parseMoney(p.amount, currency);
    } catch {
      return null;
    }
  });
  const unreadable = parsed.some((v) => v === null);
  const sum = parsed.reduce<bigint>((s, v) => s + (v ?? 0n), 0n);
  const rest = total - sum;
  const filled = parts.filter((p, i) => p.accountCode && (parsed[i] ?? 0n) > 0n).length;
  const ready = !unreadable && rest === 0n && filled === parts.length && parts.length >= 2;

  const set = (i: number, patch: Partial<Part>) => setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  async function save() {
    setBusy(true);
    const r = await splitTransactionAction({ bankTxId, parts: parts.map((p) => ({ accountCode: p.accountCode, amount: p.amount, memo: p.memo || null })) });
    setBusy(false);
    if (!r.ok) return void setError(r.error);
    toast.success(`Dipecah ke ${parts.length} akun`, { description: "Buku Besar diperbarui · tiap bagian tetap menunjuk ke baris rekening koran" });
    setOpen(false);
    onDone?.();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setParts(start());
          setError(null);
        }
      }}
    >
      <DialogTrigger render={<Button size="sm" variant="outline" data-testid="split-open" />}>
        <Split /> {trigger ?? "Pecah"}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl" data-testid="split-dialog">
        <DialogHeader>
          <DialogTitle>Pecah transaksi</DialogTitle>
          <DialogDescription>
            Bagi mutasi {formatMoney(total, currency)} ke beberapa akun, mis. gaji dan ongkos produksi. Jumlah bagian harus sama dengan nominal mutasi.
          </DialogDescription>
        </DialogHeader>
        <ol className="space-y-2">
          {parts.map((p, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 sm:grid sm:grid-cols-[1.25rem_minmax(0,1.4fr)_9rem_minmax(0,1fr)_auto]" data-testid="split-part">
              <span className="eyebrow w-6 shrink-0">{i + 1}</span>
              <AccountPicker value={p.accountCode} onChange={(v) => set(i, { accountCode: v })} options={options} ariaLabel={`Akun bagian ${i + 1}`} className="min-w-0 flex-1 basis-56 sm:w-full" />
              <Input aria-label={`Nominal bagian ${i + 1}`} inputMode="decimal" className={cn("num w-40 text-right sm:w-full", parsed[i] === null && "border-fail")} placeholder="Nominal" value={p.amount} onChange={(e) => set(i, { amount: e.target.value })} />
              <Input aria-label={`Catatan bagian ${i + 1}`} className="min-w-0 flex-1 basis-40" placeholder="Catatan (opsional)" value={p.memo} maxLength={200} onChange={(e) => set(i, { memo: e.target.value })} />
              <Button variant="ghost" size="icon-sm" aria-label={`Hapus bagian ${i + 1}`} disabled={parts.length <= 2} onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}><Trash2 /></Button>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="outline" size="sm" onClick={() => setParts((ps) => [...ps, { accountCode: "", amount: rest > 0n ? formatMoney(rest, currency, { bare: true }) : "", memo: "" }])}>
            <Plus /> Tambah bagian
          </Button>
          <p className={cn("num text-sm", rest === 0n && !unreadable ? "text-pass" : "text-review")} data-testid="split-rest">
            {unreadable ? "Ada nominal yang tidak terbaca" : rest === 0n ? "Seimbang dengan mutasi" : rest > 0n ? `Sisa ${formatMoney(rest, currency)}` : `Lebih ${formatMoney(-rest, currency)}`}
          </p>
        </div>
        {error && <p role="alert" className="text-sm text-fail" data-testid="split-error">{error}</p>}
        <DialogFooter>
          <Button onClick={save} disabled={busy || !ready} data-testid="split-save">Simpan pecahan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
