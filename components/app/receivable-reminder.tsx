"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ShareMessageActions } from "@/components/app/share-message";
import { setCreditLimitAction } from "@/app/actions";
import { formatMoney } from "@/lib/money";

/**
 * A customer's *Batas kredit* (cycle 2026-10-17-pengingat-piutang): one field, empty clears it; the server's refusal shows under it.
 * Keyed by the customer, so each opens with their current limit and no old error.
 */
export function CreditLimitDialog({ clientId, customer, onClose }: { clientId: string; customer: { id: string; name: string; limit: string | null } | null; onClose: () => void }) {
  const router = useRouter();
  const [value, setValue] = useState(customer?.limit ? formatMoney(BigInt(customer.limit), "IDR", { bare: true }) : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!customer) return;
    setBusy(true);
    const r = await setCreditLimitAction({ clientId, contactId: customer.id, limit: value });
    setBusy(false);
    if (!r.ok) return void setError(r.error);
    toast.success(r.limit ? `Batas kredit ${customer.name}: ${formatMoney(BigInt(r.limit), "IDR")}` : `Batas kredit ${customer.name} dihapus`);
    onClose();
    router.refresh();
  }
  return (
    <Dialog open={customer !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Batas kredit {customer?.name}</DialogTitle>
          <DialogDescription>Piutang bersih di atas batas ini ditandai lewat batas kredit di umur piutang.</DialogDescription>
        </DialogHeader>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="credit-limit">Batas kredit (Rp)</FieldLabel>
          <Input
            id="credit-limit"
            inputMode="numeric"
            className="num"
            value={value}
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => e.key === "Enter" && !busy && save()}
            placeholder="Mis. 250.000.000"
          />
          <FieldDescription>Kosongkan bila tidak ada batas. Berlaku per perusahaan untuk piutang dalam Rupiah.</FieldDescription>
          {error && <FieldError>{error}</FieldError>}
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Batal</Button>
          <Button disabled={busy} onClick={save} data-testid="credit-limit-save">Simpan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type ReminderTarget = { key: string; customer: string; company: string; text: string; statementHref: string };

/**
 * Pengingat tagihan: the reminder built on the server, editable, with *Salin pesan*, *Kirim lewat WhatsApp* and the Surat tagihan PDF.
 * Nothing here changes anything, so no button is primary. Buku sends nothing; the client does. Keyed by the row, so edits never leak to
 * another customer's message.
 */
export function ReminderDialog({ target, date, monthOpen, onClose }: { target: ReminderTarget | null; date: string; monthOpen: boolean; onClose: () => void }) {
  const [text, setText] = useState(target?.text ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" data-testid="reminder-dialog">
        <DialogHeader>
          <DialogTitle>Pengingat tagihan · {target?.customer}</DialogTitle>
          <DialogDescription>Per {date} · {target?.company}. Ubah bila perlu, lalu kirim lewat klien.</DialogDescription>
          {monthOpen && <p className="text-xs text-muted-foreground">Bulan ini belum ditutup: penerimaan yang belum diimpor belum dikurangi.</p>}
        </DialogHeader>
        <Textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(14, text.split("\n").length + 1)} className="font-mono text-xs" aria-label="Pesan pengingat tagihan" />
        <ShareMessageActions text={text} textarea={ref}>
          {target && (
            <a className={buttonVariants({ variant: "outline" })} href={target.statementHref} download>
              <Download /> Unduh surat tagihan (PDF)
            </a>
          )}
        </ShareMessageActions>
      </DialogContent>
    </Dialog>
  );
}
