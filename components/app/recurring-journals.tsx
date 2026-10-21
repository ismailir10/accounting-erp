"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Money } from "@/components/app/money";
import { createRecurringAction, stopRecurringAction } from "@/app/actions";
import type { RecurringView } from "@/lib/adjust/recurring";

/**
 * *Ulangi tiap bulan* on a posted Jurnal Penyesuaian (lib/adjust/recurring.ts): the same company, memo, lines and *Balik otomatis* from
 * `start` (the next month), proposed each month in *Jurnal terjadwal* until `Sampai bulan` (optional). Nothing posts from here.
 */
export function RepeatJournal({ clientId, entryId, memo, start, startLabel, day }: { clientId: string; entryId: string; memo: string; start: string; startLabel: string; day: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await createRecurringAction(clientId, entryId, end || undefined);
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(`${memo} diulang tiap bulan mulai ${startLabel}`);
    setOpen(false);
    router.refresh();
  };
  return (
    <>
      <button type="button" className="drill" aria-label={`Ulangi tiap bulan ${memo}`} onClick={() => setOpen(true)}>Ulangi</button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ulangi tiap bulan: {memo}</DialogTitle>
            <DialogDescription>
              Mulai {startLabel}, jurnal yang sama (perusahaan, baris dan catatannya) diusulkan tiap bulan bertanggal {day} di Jurnal terjadwal dan Kotak persetujuan.
              Dicatat hanya setelah Anda klik Catat, lewat aturan persetujuan Jurnal manual.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="recurring-end">Sampai bulan (opsional)</FieldLabel>
            <Input id="recurring-end" type="month" min={start} value={end} onChange={(e) => setEnd(e.target.value)} className="w-48" />
            <FieldDescription>Kosongkan bila berulang sampai dihentikan.</FieldDescription>
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Batal</Button>
            <Button disabled={busy} onClick={save}><Repeat /> {busy ? "Menyimpan…" : "Ulangi tiap bulan"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const STATUS_LABEL = { BERJALAN: "Berjalan", SELESAI: "Selesai", DIHENTIKAN: "Dihentikan" } as const;

/** The client's Jurnal berulang with what each posted so far; *Hentikan* ends a running one (what was posted stays). */
export function RecurringList({ clientId, items, canWrite }: { clientId: string; items: RecurringView[]; canWrite: boolean }) {
  const router = useRouter();
  const [stopping, setStopping] = useState<RecurringView | null>(null);
  const [busy, setBusy] = useState(false);
  if (!items.length) return null;
  return (
    <Card data-testid="recurring-journals">
      <CardHeader>
        <CardTitle>Jurnal berulang</CardTitle>
        <CardDescription>Jurnal penyesuaian yang diusulkan lagi tiap bulan. Barisnya tidak bisa diubah: hentikan, lalu ulangi jurnal yang lebih baru.</CardDescription>
      </CardHeader>
      <CardContent className="divide-y px-0">
        {items.map((t) => (
          <div key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2.5" data-testid="recurring-row">
            <div className="min-w-0 flex-1 basis-64">
              <div className="text-sm font-medium">{t.memo}</div>
              <div className="text-xs text-muted-foreground">
                {t.entity} · {t.lines} baris · {t.day} · {t.span}{t.reverse ? " · dibalik tanggal 1" : ""} · {STATUS_LABEL[t.status]}
                {t.postedCount > 0 && ` · ${t.postedCount} kali dicatat, terakhir ${t.lastPosted}`}
              </div>
            </div>
            <Money className="text-sm" value={BigInt(t.amount)} currency={t.currency} />
            {canWrite && t.status === "BERJALAN" && <Button variant="ghost" size="sm" aria-label={`Hentikan ${t.memo}`} onClick={() => setStopping(t)}>Hentikan</Button>}
          </div>
        ))}
      </CardContent>
      <Dialog open={stopping !== null} onOpenChange={(o) => !o && setStopping(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hentikan {stopping?.memo}?</DialogTitle>
            <DialogDescription>Tidak ada lagi bulan yang diusulkan, termasuk yang belum dicatat. Yang sudah dicatat tetap di buku besar; yang menunggu persetujuan tetap diputuskan di Kotak persetujuan.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStopping(null)}>Batal</Button>
            <Button
              disabled={busy}
              onClick={async () => {
                if (!stopping) return;
                setBusy(true);
                const r = await stopRecurringAction(clientId, stopping.id);
                setBusy(false);
                if (!r.ok) return void toast.error(r.error);
                toast.success(`${stopping.memo} dihentikan`);
                setStopping(null);
                router.refresh();
              }}
            >
              Hentikan jurnal berulang
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
