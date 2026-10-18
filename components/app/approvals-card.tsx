"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { saveApprovalsAction } from "@/app/firm-settings-actions";
import type { ApprovalsErrors } from "@/lib/settings/approvals";

/** The firm's card as the page reads it; thresholds as whole-Rupiah digit strings (null = every journal of the source). */
export type ApprovalsView = { manual: boolean; manualAbove: string | null; aiDraft: boolean; aiDraftAbove: string | null; reopen: boolean };

const grouped = (digits: string | null) => (digits ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".") : "");
const JOURNALS = [
  { key: "manual", above: "manualAbove", label: "Jurnal manual", hint: "Jurnal Penyesuaian dan Balik jurnal" },
  { key: "aiDraft", above: "aiDraftAbove", label: "Draf AI", hint: "draf jurnal dari Jelaskan di Tutup Buku" },
] as const;
const routeText = (on: boolean, above: string | null) => (!on ? "tanpa persetujuan" : above ? `di atas Rp ${grouped(above)}` : "semua nominal");

/**
 * Persetujuan kedua (cycle 2026-10-18-persetujuan-kedua): which journals wait for another member before they change the books, and
 * whether reopening a month needs a second admin. Admins (`org.settings`) get the form; everyone else reads the same values as text.
 */
export function ApprovalsCard({ settings, canSave, lastChange, singleAdmin }: { settings: ApprovalsView; canSave: boolean; lastChange: { at: string; actor: string } | null; singleAdmin: boolean }) {
  const initial = { manual: settings.manual, manualAbove: grouped(settings.manualAbove), aiDraft: settings.aiDraft, aiDraftAbove: grouped(settings.aiDraftAbove), reopen: settings.reopen };
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<ApprovalsErrors>({});
  const [busy, setBusy] = useState(false);
  const dirty = (Object.keys(initial) as (keyof typeof initial)[]).some((k) => form[k] !== initial[k]);
  const set = (patch: Partial<typeof form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors({});
  };
  const save = async () => {
    setBusy(true);
    const r = await saveApprovalsAction(form);
    setBusy(false);
    if (!r.ok) {
      setErrors(r.fields ?? {});
      return toast.error(r.error);
    }
    if (!r.changed) {
      setForm(initial); // the same values written differently: nothing to save
      return toast.success("Tidak ada perubahan");
    }
    toast.success("Persetujuan kedua disimpan");
    router.refresh();
  };
  const anyOn = settings.manual || settings.aiDraft || settings.reopen;
  const last = lastChange && <p className="text-xs text-muted-foreground" data-testid="approvals-last">Terakhir diubah {lastChange.at} oleh {lastChange.actor}</p>;
  const footer = (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>Penyetuju: anggota lain yang memegang klien, berperan setara atau lebih tinggi dari pembuatnya; Admin dan Pemilik saling menyetujui. Tidak ada yang menyetujui jurnalnya sendiri.</p>
      <p>Perusahaan berbuku selain Rupiah: semua jurnal sumber ini perlu persetujuan.</p>
      <p>Berlaku untuk jurnal dan permintaan berikutnya. Yang sudah dicatat tidak berubah; yang menunggu tetap diputuskan di Kotak persetujuan.</p>
      {singleAdmin && (anyOn || canSave) && (
        <p className="font-medium text-review" data-testid="approvals-single-admin">
          Kantor ini baru punya satu admin aktif, jadi jurnal admin dan pembukaan kembali berjalan tanpa persetujuan kedua sampai ada admin kedua.
        </p>
      )}
    </div>
  );

  return (
    <Card data-testid="approvals-card">
      <CardHeader>
        <CardTitle>Persetujuan kedua</CardTitle>
        <CardDescription>Jurnal besar dan pembukaan kembali bulan perlu disetujui anggota lain sebelum mengubah buku.</CardDescription>
      </CardHeader>
      {!canSave ? (
        <CardContent className="space-y-4 text-sm" data-testid="approvals-readonly">
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {JOURNALS.map((j) => (
              <div key={j.key} className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted-foreground">{j.label}</dt>
                <dd className="num">{routeText(settings[j.key], settings[j.above])}</dd>
              </div>
            ))}
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted-foreground">Buka kembali bulan</dt>
              <dd>{settings.reopen ? "dikonfirmasi admin kedua" : "langsung oleh admin"}</dd>
            </div>
          </dl>
          <p className="text-muted-foreground">Diatur oleh admin kantor.</p>
          {footer}
          {last}
        </CardContent>
      ) : (
        <CardContent className="space-y-5 text-sm">
          {JOURNALS.map((j) => (
            <div key={j.key} className="flex flex-wrap items-start gap-x-6 gap-y-2">
              {/* Not wrapped in a label: a wrapping label re-forwards the click and toggles twice. */}
              <div className="flex min-w-0 flex-1 basis-56 items-start gap-2">
                <Checkbox id={`approval-${j.key}`} className="mt-0.5" checked={form[j.key]} disabled={busy} onCheckedChange={(v) => set({ [j.key]: v === true })} />
                <div>
                  <label htmlFor={`approval-${j.key}`}>{j.label}</label>
                  <p className="text-xs text-muted-foreground">{j.hint}</p>
                </div>
              </div>
              <Field className="w-full max-w-56">
                <FieldLabel htmlFor={`approval-${j.above}`} className="text-xs text-muted-foreground">di atas (Rp)</FieldLabel>
                <Input
                  id={`approval-${j.above}`}
                  inputMode="numeric"
                  className="num text-right"
                  placeholder="Semua nominal"
                  value={form[j.above]}
                  aria-invalid={!!errors[j.above]}
                  disabled={busy || !form[j.key]}
                  onChange={(e) => set({ [j.above]: e.target.value })}
                />
                <FieldError>{errors[j.above]}</FieldError>
              </Field>
            </div>
          ))}
          <div className="flex items-start gap-2">
            <Checkbox id="approval-reopen" className="mt-0.5" checked={form.reopen} disabled={busy} onCheckedChange={(v) => set({ reopen: v === true })} />
            <div>
              <label htmlFor="approval-reopen">Buka kembali bulan</label>
              <p className="text-xs text-muted-foreground">satu admin meminta dengan alasan, admin lain mengonfirmasi</p>
            </div>
          </div>
          <div className="space-y-2 border-t pt-4">
            {footer}
            <Button variant="outline" size="sm" disabled={busy || !dirty} onClick={save} data-testid="approvals-save">Simpan</Button>
            {last}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
