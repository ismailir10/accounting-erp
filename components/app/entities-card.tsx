"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BankPicker } from "@/components/app/bank-picker";
import { bankName } from "@/lib/banks";
import type { BankCode } from "@/lib/generated/prisma/enums";
import { addBankAccountAction, addEntityAction } from "@/app/actions";
import { CURRENCIES, CURRENCY_CODES } from "@/lib/fx/currency";

type Bank = BankCode;
type Kind = "PT" | "CV" | "BADAN_USAHA_ASING" | "PERORANGAN";
const KIND_LABEL: Record<Kind, string> = { PT: "PT", CV: "CV", BADAN_USAHA_ASING: "Badan usaha asing", PERORANGAN: "Perorangan (pemilik)" };

export type EntityView = { id: string; name: string; kind: Kind; banks: { id: string; label: string; number: string; code: string; isOverdraft: boolean }[] };

/** Fields of one bank account (bank, number, name, PRK). `prefix` is the error-key path the server reports under. */
function BankFields({ value, onChange, errors, prefix }: { value: { bank: Bank; number: string; label: string; isOverdraft: boolean }; onChange: (v: { bank: Bank; number: string; label: string; isOverdraft: boolean }) => void; errors: Record<string, string>; prefix: string }) {
  const id = prefix.replace(/\W/g, "-");
  return (
    <div className="grid gap-2 sm:grid-cols-[10rem_1fr_1fr]">
      <BankPicker value={value.bank} onChange={(v) => onChange({ ...value, bank: v })} />
      <div className="space-y-1">
        <Input aria-label="Nomor rekening" inputMode="numeric" value={value.number} aria-invalid={!!errors[`${prefix}.number`]} onChange={(e) => onChange({ ...value, number: e.target.value })} placeholder="Nomor rekening, sesuai rekening koran" />
        <FieldError>{errors[`${prefix}.number`]}</FieldError>
      </div>
      <div className="space-y-1.5">
        <Input aria-label="Nama rekening" value={value.label} onChange={(e) => onChange({ ...value, label: e.target.value })} placeholder={`Nama (opsional), mis. ${bankName(value.bank)} Giro`} />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox id={`prk-${id}`} checked={value.isOverdraft} onCheckedChange={(v) => onChange({ ...value, isOverdraft: v === true })} />
          <label htmlFor={`prk-${id}`}>Pinjaman rekening koran (PRK), saldonya utang ke bank</label>
        </div>
      </div>
    </div>
  );
}

const emptyBank = () => ({ bank: "BCA" as Bank, number: "", label: "", isOverdraft: false });

/** Add a bank account to a company/owner that already exists, inline under it. */
function AddBank({ clientId, entity, onDone }: { clientId: string; entity: EntityView; onDone: () => void }) {
  const router = useRouter();
  const [bank, setBank] = useState(emptyBank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const r = await addBankAccountAction(clientId, entity.id, bank);
      if (!r.ok) {
        setErrors(r.fields ?? {});
        return void toast.error(r.error);
      }
      toast.success(`Rekening ditambahkan ke ${entity.name}`);
      onDone();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 border-t pt-3" data-testid={`add-bank-${entity.id}`}>
      <BankFields value={bank} onChange={(v) => { setBank(v); setErrors({}); }} errors={errors} prefix="bank" />
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={busy}>{busy ? "Menyimpan…" : "Simpan rekening"}</Button>
        <Button size="sm" variant="ghost" onClick={onDone} disabled={busy}>Batal</Button>
      </div>
    </div>
  );
}

/** Add a company or owner to the client, with an optional first bank account. */
function AddEntity({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("PERORANGAN");
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [currency, setCurrency] = useState("IDR");
  const [npwp, setNpwp] = useState("");
  const [bank, setBank] = useState(emptyBank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const r = await addEntityAction(clientId, { name, shortName, kind, npwp, currency, banks: [bank] });
      if (!r.ok) {
        setErrors(r.fields ?? {});
        return void toast.error(r.error);
      }
      toast.success(`${name.trim()} ditambahkan`);
      onDone();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  const clear = () => setErrors({});
  return (
    <div className="space-y-4 border-t pt-4" data-testid="add-entity">
      <div className="grid gap-4 sm:grid-cols-4">
        <Field>
          <FieldLabel>Jenis</FieldLabel>
          <Select value={kind} onValueChange={(v) => { setKind(v as Kind); clear(); }}>
            <SelectTrigger className="w-full" aria-label="Jenis perusahaan atau pemilik"><SelectValue>{KIND_LABEL[kind]}</SelectValue></SelectTrigger>
            <SelectContent>{(Object.keys(KIND_LABEL) as Kind[]).map((k) => <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="new-entity-name">Nama lengkap</FieldLabel>
          <Input id="new-entity-name" value={name} aria-invalid={!!errors["entity.name"]} onChange={(e) => { setName(e.target.value); clear(); }} placeholder={kind === "PERORANGAN" ? "mis. Budi Santoso" : "mis. PT Maju Bersama Sejahtera"} />
          <FieldError>{errors["entity.name"]}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="new-entity-short">Nama singkat</FieldLabel>
          <Input id="new-entity-short" value={shortName} onChange={(e) => setShortName(e.target.value)} placeholder="Opsional" />
        </Field>
        <Field>
          <FieldLabel>Mata uang pembukuan</FieldLabel>
          <Select value={currency} onValueChange={(v) => setCurrency(v as string)}>
            <SelectTrigger className="w-full" aria-label="Mata uang pembukuan"><SelectValue>{currency}</SelectValue></SelectTrigger>
            <SelectContent>{CURRENCY_CODES.map((c) => <SelectItem key={c} value={c}>{c} · {CURRENCIES[c].name}</SelectItem>)}</SelectContent>
          </Select>
          <FieldError>{errors["entity.currency"]}</FieldError>
        </Field>
        {kind !== "BADAN_USAHA_ASING" && (
          <Field>
            <FieldLabel htmlFor="new-entity-npwp">NPWP, 16 digit (opsional)</FieldLabel>
            <Input id="new-entity-npwp" value={npwp} aria-invalid={!!errors["entity.npwp"]} onChange={(e) => { setNpwp(e.target.value); clear(); }} placeholder="mis. 0012 3456 7801 5000" />
            <FieldError>{errors["entity.npwp"]}</FieldError>
          </Field>
        )}
      </div>
      <div className="space-y-2">
        <div className="text-sm font-medium">Rekening bank pertama (opsional)</div>
        <BankFields value={bank} onChange={(v) => { setBank(v); clear(); }} errors={errors} prefix="entity.banks.0" />
      </div>
      <div className="flex gap-2">
        <Button onClick={save} disabled={busy}>{busy ? "Menyimpan…" : "Simpan"}</Button>
        <Button variant="ghost" onClick={onDone} disabled={busy}>Batal</Button>
      </div>
    </div>
  );
}

/** The client's companies/owners and their bank accounts, with the two ways to add to them after "Simpan klien". */
export function EntitiesCard({ clientId, entities }: { clientId: string; entities: EntityView[] }) {
  const [open, setOpen] = useState<string | null>(null); // "entity" or the id of the entity getting a bank account
  return (
    <Card data-testid="entities-card">
      <CardHeader>
        <CardTitle>Perusahaan & rekening</CardTitle>
        <CardDescription>Ada perusahaan, pemilik atau rekening bank yang belum dimasukkan? Tambahkan di sini. Yang sudah ada tidak berubah. Rekening yang ditambahkan setelah Saldo Awal dicatat: saldo awalnya diisi lewat Jurnal Penyesuaian.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {entities.map((e) => (
          <div key={e.id} className="space-y-2" data-testid={`entity-${e.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium">{e.name}</div>
                <div className="text-xs text-muted-foreground">{KIND_LABEL[e.kind]}</div>
              </div>
              {open !== e.id && <Button size="sm" variant="outline" onClick={() => setOpen(e.id)}><Plus /> Tambah rekening</Button>}
            </div>
            {e.banks.length === 0 ? (
              <p className="text-sm text-muted-foreground">Belum ada rekening bank. Unggah rekening korannya di <Link href={`/clients/${clientId}/import`} className="text-primary">Unggah</Link> — rekeningnya ditambahkan dari file.</p>
            ) : (
              <ul className="divide-y border text-sm">
                {e.banks.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
                    <span className="min-w-0 truncate">{b.label}{b.isOverdraft ? " · PRK" : ""}</span>
                    <span className="num text-muted-foreground">{b.number} · {b.code}</span>
                  </li>
                ))}
              </ul>
            )}
            {open === e.id && <AddBank clientId={clientId} entity={e} onDone={() => setOpen(null)} />}
          </div>
        ))}
        {open === "entity" ? (
          <AddEntity clientId={clientId} onDone={() => setOpen(null)} />
        ) : (
          <Button variant="outline" onClick={() => setOpen("entity")}><Plus /> Tambah perusahaan atau pemilik</Button>
        )}
      </CardContent>
    </Card>
  );
}
