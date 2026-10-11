"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BankPicker } from "@/components/app/bank-picker";
import { bankName } from "@/lib/banks";
import type { BankCode } from "@/lib/generated/prisma/enums";
import { Checkbox } from "@/components/ui/checkbox";
import { addClientAction, createEvidenceClientAction } from "@/app/actions";
import { CURRENCIES, CURRENCY_CODES } from "@/lib/fx/currency";
import { FRAMEWORK_OPTIONS, type Framework } from "@/lib/reports/framework";
import { isBlankBankRow } from "@/lib/blank-bank";

import type { NewClientInput } from "@/lib/onboarding";

type Kind = "PT" | "CV" | "BADAN_USAHA_ASING" | "PERORANGAN";
type Bank = BankCode;
type BankRow = { bank: Bank; number: string; label: string; isOverdraft: boolean };
type EntityRow = { name: string; shortName: string; kind: Kind; npwp: string; currency: string; reportingFramework: Framework; banks: BankRow[] };

const KIND_LABEL: Record<Kind, string> = { PT: "PT", CV: "CV", BADAN_USAHA_ASING: "Badan usaha asing", PERORANGAN: "Perorangan (pemilik)" };
const newBank = (): BankRow => ({ bank: "BCA", number: "", label: "", isOverdraft: false });
/** A person's own books have no SAK of their own: SAK EMKM (no OCI, no deferred tax) is the closest; companies start on SAK EP. */
const defaultFramework = (kind: Kind): Framework => (kind === "PERORANGAN" ? "SAK_EMKM" : "SAK_EP");
const newEntity = (kind: Kind): EntityRow => ({ name: "", shortName: "", kind, npwp: "", currency: "IDR", reportingFramework: defaultFramework(kind), banks: [newBank()] });

/** `defaults`: what was typed before switching to this form (Tambah klien's *Isi manual*); the first company follows the name. */
export function ClientForm({ initial, evidenceIntakeId, onCreated, defaults }: { initial?: NewClientInput; evidenceIntakeId?: string; onCreated?: () => void; defaults?: { name: string; industry: string } } = {}) {
  const router = useRouter();
  const [name, setName] = useState(initial?.name ?? defaults?.name ?? "");
  const [industry, setIndustry] = useState(initial?.industry ?? defaults?.industry ?? "");
  const [entities, setEntities] = useState<EntityRow[]>(initial?.entities.map(e => ({ ...e, currency: e.currency ?? "IDR", reportingFramework: e.reportingFramework ?? "SAK_EP", banks: e.banks.map(b => ({ ...b, isOverdraft: b.isOverdraft ?? false })) })) ?? [{ ...newEntity("PT"), name: defaults?.name ?? "" }]);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // The first entity's name follows the client name until the user types their own (the common case is one PT).
  const [firstNameTouched, setFirstNameTouched] = useState(Boolean(initial?.entities[0]?.name));

  const clearError = (...paths: string[]) =>
    setErrors((es) => (paths.some((p) => p in es) ? Object.fromEntries(Object.entries(es).filter(([k]) => !paths.includes(k))) : es));
  const setEntity = (i: number, patch: Partial<EntityRow>) => {
    setEntities((es) => es.map((e, j) => (j === i ? { ...e, ...patch } : e)));
    clearError(...Object.keys(patch).map((k) => `entities.${i}.${k}`));
  };
  const setBank = (i: number, k: number, patch: Partial<BankRow>) => {
    setEntities((es) => es.map((e, j) => (j === i ? { ...e, banks: e.banks.map((b, m) => (m === k ? { ...b, ...patch } : b)) } : e)));
    clearError(...Object.keys(patch).map((f) => `entities.${i}.banks.${k}.${f}`));
  };
  const err = (path: string) => errors[path];

  async function submit() {
    setBusy(true);
    try {
      if (evidenceIntakeId) {
        const linked = await createEvidenceClientAction(evidenceIntakeId, { name, industry, entities });
        if (!linked.ok) return toast.error(linked.error);
        toast.success(`${name} ditambahkan`);
        onCreated?.();
        router.refresh();
        return;
      }
      const r = await addClientAction({ name, industry, entities });
      if (!r.ok) {
        if (r.fields) {
          setErrors(r.fields);
          // The marked field may be off-screen (a bank row far down): say it here too.
          toast.error(r.error);
          // Focus the first marked field so the message is where the user is looking.
          requestAnimationFrame(() => document.querySelector<HTMLElement>("[aria-invalid=true]")?.focus());
        } else toast.error(r.error);
        return;
      }
      toast.success(`${name} ditambahkan`);
      // The first step is the upload (Saldo Awal is prefilled from the statement afterwards); ledger-only clients start with the ledger tab.
      router.push(entities.some((e) => e.banks.some((b) => !isBlankBankRow(b))) ? `/clients/${r.clientId}/import` : `/clients/${r.clientId}/import?tab=ledger`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Klien</CardTitle>
          <CardDescription>Satu klien bisa berisi beberapa perusahaan, misalnya PT dan pemiliknya, yang dilaporkan sebagai gabungan.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="client-name">Nama klien</FieldLabel>
            <Input
              id="client-name"
              value={name}
              aria-invalid={!!err("name")}
              onChange={(e) => {
                setName(e.target.value);
                clearError("name");
                if (!firstNameTouched && entities[0]?.kind !== "PERORANGAN") setEntity(0, { name: e.target.value });
              }}
              placeholder="mis. Grup Maju Bersama"
            />
            <FieldError>{err("name")}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="client-industry">Bidang usaha</FieldLabel>
            <Input id="client-industry" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="mis. distributor bahan bangunan" />
            <FieldDescription>Dipakai AI sebagai konteks saat mengusulkan akun.</FieldDescription>
          </Field>
        </CardContent>
      </Card>

      {entities.map((e, i) => (
        <Card key={i}>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div>
              <CardTitle>Perusahaan atau pemilik {i + 1}</CardTitle>
              <CardDescription>Badan usaha atau orang yang punya pembukuan sendiri.</CardDescription>
            </div>
            {entities.length > 1 && (
              <Button variant="ghost" size="sm" onClick={() => { setErrors({}); setEntities((es) => es.filter((_, j) => j !== i)); }}>
                <Trash2 /> Hapus
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-4">
              <Field>
                <FieldLabel>Jenis</FieldLabel>
                <Select value={e.kind} onValueChange={(v) => {
                  const kind = v as Kind;
                  // The framework follows the kind until the accountant picks one.
                  const framework = e.reportingFramework === defaultFramework(e.kind) ? { reportingFramework: defaultFramework(kind) } : {};
                  setEntity(i, kind === "BADAN_USAHA_ASING" ? { kind, npwp: "", ...framework } : { kind, ...framework });
                }}>
                  <SelectTrigger className="w-full" aria-label="Jenis entitas"><SelectValue>{KIND_LABEL[e.kind]}</SelectValue></SelectTrigger>
                  <SelectContent>{(Object.keys(KIND_LABEL) as Kind[]).map((k) => <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field className="sm:col-span-2">
                <FieldLabel htmlFor={`e-name-${i}`}>Nama lengkap</FieldLabel>
                <Input
                  id={`e-name-${i}`}
                  value={e.name}
                  aria-invalid={!!err(`entities.${i}.name`)}
                  onFocus={(ev) => {
                    if (i === 0 && !firstNameTouched && e.kind !== "PERORANGAN") ev.currentTarget.select();
                  }}
                  onChange={(ev) => {
                    if (i === 0) setFirstNameTouched(true);
                    setEntity(i, { name: ev.target.value });
                  }}
                  placeholder={e.kind === "PERORANGAN" ? "mis. Budi Santoso" : "mis. PT Maju Bersama Sejahtera"}
                />
                <FieldError>{err(`entities.${i}.name`)}</FieldError>
              </Field>
              <Field>
                <FieldLabel htmlFor={`e-short-${i}`}>Nama singkat</FieldLabel>
                <Input id={`e-short-${i}`} value={e.shortName} onChange={(ev) => setEntity(i, { shortName: ev.target.value })} placeholder={e.kind === "PERORANGAN" ? "mis. Budi" : "mis. PT Maju"} />
                <FieldDescription>Opsional. Dipakai di tabel dan laporan.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Mata uang pembukuan</FieldLabel>
                <Select value={e.currency} onValueChange={(v) => setEntity(i, { currency: v as string })}>
                  <SelectTrigger className="w-full" aria-label="Mata uang pembukuan"><SelectValue>{e.currency || "Pilih mata uang"}</SelectValue></SelectTrigger>
                  <SelectContent>{CURRENCY_CODES.map((c) => <SelectItem key={c} value={c}>{c} · {CURRENCIES[c].name}</SelectItem>)}</SelectContent>
                </Select>
                <FieldError>{err(`entities.${i}.currency`)}</FieldError>
              </Field>
              {/* A foreign company has no Indonesian NPWP. */}
              {e.kind !== "BADAN_USAHA_ASING" && (
                <Field>
                  <FieldLabel htmlFor={`e-npwp-${i}`}>NPWP, 16 digit (opsional)</FieldLabel>
                  <Input id={`e-npwp-${i}`} value={e.npwp} aria-invalid={!!err(`entities.${i}.npwp`)} onChange={(ev) => setEntity(i, { npwp: ev.target.value })} placeholder="mis. 0012 3456 7801 5000" />
                  <FieldError>{err(`entities.${i}.npwp`)}</FieldError>
                </Field>
              )}
            </div>

            <Field>
              <FieldLabel>Kerangka pelaporan</FieldLabel>
              <Select value={e.reportingFramework} onValueChange={(v) => setEntity(i, { reportingFramework: v as Framework })}>
                <SelectTrigger className="w-full sm:w-64" aria-label="Kerangka pelaporan"><SelectValue>{FRAMEWORK_OPTIONS.find((o) => o.value === e.reportingFramework)?.label}</SelectValue></SelectTrigger>
                <SelectContent>{FRAMEWORK_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
              </Select>
              <FieldDescription>{FRAMEWORK_OPTIONS.find((o) => o.value === e.reportingFramework)?.help} Menentukan bunyi CALK dan nama laporan, bukan angkanya. Bisa diubah nanti di Pengaturan klien.</FieldDescription>
              <FieldError>{err(`entities.${i}.reportingFramework`)}</FieldError>
            </Field>

            <div className="space-y-2">
              <div className="text-sm font-medium">Rekening bank</div>
              {e.banks.length === 0 && (
                <p className="text-sm text-muted-foreground">Tanpa rekening bank. Buku ini diisi dari file buku besar atau neraca.</p>
              )}
              {e.banks.map((b, k) => (
                <div key={k} className="grid gap-2 sm:grid-cols-[10rem_1fr_1fr_auto] sm:items-start">
                  <BankPicker value={b.bank} onChange={(v) => setBank(i, k, { bank: v })} />
                  <div className="space-y-1">
                    <Input
                      aria-label="Nomor rekening"
                      inputMode="numeric"
                      value={b.number}
                      aria-invalid={!!err(`entities.${i}.banks.${k}.number`)}
                      onChange={(ev) => setBank(i, k, { number: ev.target.value })}
                      placeholder="Nomor rekening, sesuai rekening koran"
                    />
                    <FieldError>{err(`entities.${i}.banks.${k}.number`)}</FieldError>
                  </div>
                  <div className="space-y-1.5">
                    <Input aria-label="Nama rekening" value={b.label} onChange={(ev) => setBank(i, k, { label: ev.target.value })} placeholder={`Nama (opsional), mis. ${bankName(b.bank)} Giro`} />
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Checkbox id={`prk-${i}-${k}`} checked={b.isOverdraft} onCheckedChange={(v) => setBank(i, k, { isOverdraft: v === true })} />
                      <label htmlFor={`prk-${i}-${k}`}>Pinjaman rekening koran (PRK), saldonya utang ke bank</label>
                    </div>
                  </div>
                  <Button variant="ghost" size="icon" aria-label="Hapus rekening" onClick={() => { setErrors({}); setEntity(i, { banks: e.banks.filter((_, j) => j !== k) }); }}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <FieldError>{err(`entities.${i}.banks`)}</FieldError>
              <Button variant="outline" size="sm" onClick={() => setEntity(i, { banks: [...e.banks, { ...newBank(), bank: e.banks.at(-1)?.bank ?? "BCA" }] })}>
                <Plus /> Tambah rekening
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}

      <FieldError>{err("entities")}</FieldError>
      {/* Above Simpan: an owner added after saving can't be added from the UI yet. */}
      <Button variant="outline" onClick={() => { setErrors({}); setEntities((es) => [...es, newEntity(es.some((x) => x.kind === "PERORANGAN") ? "PT" : "PERORANGAN")]); }}>
        <Plus /> Tambah perusahaan atau pemilik
      </Button>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={evidenceIntakeId ? "outline" : "default"} onClick={submit} disabled={busy}>
          {busy ? "Menyimpan…" : "Simpan klien"}
        </Button>
        {Object.keys(errors).length > 1 && <span className="text-sm text-destructive">Periksa {Object.keys(errors).length} isian yang ditandai.</span>}
      </div>
    </div>
  );
}
