"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { saveAutomationAction } from "@/app/firm-settings-actions";
import type { AutomationErrors } from "@/lib/settings/automation";

/** The firm's settings as the page reads them; amounts as whole-Rupiah digit strings (null = none). */
export type AutomationView = { transfer: boolean; rules: boolean; memory: boolean; cap: string | null; fluxFloor: string | null; fluxPercent: number };

const SOURCES = [
  { key: "transfer", label: "Transfer antar rekening", hint: "pasangan terbukti, atau transfer ke rekening sendiri" },
  { key: "rules", label: "Aturan", hint: "aturan kantor dan klien" },
  { key: "memory", label: "Pilihan yang diingat", hint: "keputusan akuntan sebelumnya untuk penerima yang sama" },
] as const;

const grouped = (digits: string | null) => (digits ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".") : "");
const rupiah = (digits: string | null, none: string) => (digits ? `Rp ${grouped(digits)}` : none);
const FLUX_HINT =
  "Akun Laba Rugi ditandai bila selisihnya dari rata-rata ≥ 1 % volume Laba Rugi bulanan, ≥ selisih minimal, dan ≥ persentase ini. Dipakai kontrol Fluktuasi Laba Rugi di Tutup Buku dan Wawasan. Selisih minimal hanya untuk perusahaan berbuku Rupiah.";

/**
 * Otomasi (cycle 2026-10-17-otomasi): which deterministic sources may post an imported line directly, the amount cap, and the flux
 * thresholds. Admins (`org.settings`) get the form; everyone else reads the same values as text.
 */
export function AutomationCard({ settings, canSave, lastChange }: { settings: AutomationView; canSave: boolean; lastChange: { at: string; actor: string } | null }) {
  const initial = { transfer: settings.transfer, rules: settings.rules, memory: settings.memory, cap: grouped(settings.cap), fluxFloor: grouped(settings.fluxFloor), fluxPercent: String(settings.fluxPercent) };
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<AutomationErrors>({});
  const [busy, setBusy] = useState(false);
  const dirty = (Object.keys(initial) as (keyof typeof initial)[]).some((k) => form[k] !== initial[k]);
  const set = (patch: Partial<typeof form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors({});
  };
  const save = async () => {
    setBusy(true);
    const r = await saveAutomationAction(form);
    setBusy(false);
    if (!r.ok) {
      setErrors(r.fields ?? {});
      return toast.error(r.error);
    }
    if (!r.changed) {
      setForm(initial); // the same values written differently ("100000000" for 100.000.000): nothing to save
      return toast.success("Tidak ada perubahan");
    }
    toast.success("Otomasi kantor disimpan");
    router.refresh();
  };
  const last = lastChange && <p className="text-xs text-muted-foreground" data-testid="automation-last">Terakhir diubah {lastChange.at} oleh {lastChange.actor}</p>;

  return (
    <Card data-testid="automation-card">
      <CardHeader>
        <CardTitle>Otomasi</CardTitle>
        <CardDescription>Sumber pasti yang boleh langsung dicatat saat rekening koran diimpor. Usulan AI dan tebakan selalu menunggu persetujuan Anda.</CardDescription>
      </CardHeader>
      {!canSave ? (
        <CardContent className="space-y-4 text-sm" data-testid="automation-readonly">
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {SOURCES.map((s) => (
              <div key={s.key} className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted-foreground">{s.label}</dt>
                <dd>{settings[s.key] ? "langsung dicatat" : "ke Review"}</dd>
              </div>
            ))}
            <div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">Usulan AI</dt><dd>selalu menunggu persetujuan</dd></div>
            <div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">Batas nominal</dt><dd className="num">{rupiah(settings.cap, "tanpa batas")}</dd></div>
            <div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">Selisih minimal</dt><dd className="num">{rupiah(settings.fluxFloor, "tanpa minimum")}</dd></div>
            <div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">Perubahan minimal</dt><dd className="num">{settings.fluxPercent} %</dd></div>
          </dl>
          <p className="text-muted-foreground">Diatur oleh admin kantor.</p>
          {last}
        </CardContent>
      ) : (
        <CardContent className="space-y-6 text-sm">
          <fieldset className="space-y-3">
            <legend className="eyebrow mb-2">Langsung dicatat</legend>
            {SOURCES.map((s) => (
              <div key={s.key} className="flex items-start gap-2">
                <Checkbox id={`auto-${s.key}`} className="mt-0.5" checked={form[s.key]} disabled={busy} onCheckedChange={(v) => set({ [s.key]: v === true })} />
                <div>
                  <label htmlFor={`auto-${s.key}`}>{s.label}</label>
                  <p className="text-xs text-muted-foreground">{s.hint}</p>
                </div>
              </div>
            ))}
            <div className="flex items-start gap-2">
              <Checkbox id="auto-ai" className="mt-0.5" checked={false} disabled />
              <div>
                <label htmlFor="auto-ai" className="text-muted-foreground">Usulan AI</label>
                <p className="text-xs text-muted-foreground">selalu menunggu persetujuan</p>
              </div>
            </div>
          </fieldset>
          <Field className="max-w-sm">
            <FieldLabel htmlFor="auto-cap">Batas nominal</FieldLabel>
            <Input id="auto-cap" inputMode="numeric" className="num text-right" placeholder="Tanpa batas" value={form.cap} aria-invalid={!!errors.cap} disabled={busy} onChange={(e) => set({ cap: e.target.value })} />
            <FieldDescription>Mutasi di atas nominal ini selalu masuk Review, dari sumber mana pun.</FieldDescription>
            <FieldError>{errors.cap}</FieldError>
          </Field>
          <fieldset className="space-y-3">
            <legend className="eyebrow mb-2">Ambang fluktuasi</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="auto-flux-floor">Selisih minimal (Rp)</FieldLabel>
                <Input id="auto-flux-floor" inputMode="numeric" className="num text-right" placeholder="Tanpa minimum" value={form.fluxFloor} aria-invalid={!!errors.fluxFloor} disabled={busy} onChange={(e) => set({ fluxFloor: e.target.value })} />
                <FieldError>{errors.fluxFloor}</FieldError>
              </Field>
              <Field>
                <FieldLabel htmlFor="auto-flux-percent">Perubahan minimal (%)</FieldLabel>
                <Input id="auto-flux-percent" inputMode="numeric" className="num text-right" value={form.fluxPercent} aria-invalid={!!errors.fluxPercent} disabled={busy} onChange={(e) => set({ fluxPercent: e.target.value })} />
                <FieldError>{errors.fluxPercent}</FieldError>
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">{FLUX_HINT}</p>
          </fieldset>
          <div className="space-y-2 border-t pt-4">
            <p className="text-xs text-muted-foreground">Berlaku untuk impor berikutnya. Mutasi yang sudah dicatat atau menunggu di Review tidak diubah.</p>
            <Button variant="outline" size="sm" disabled={busy || !dirty} onClick={save} data-testid="automation-save">Simpan</Button>
            {last}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
