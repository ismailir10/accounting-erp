"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BankPicker } from "@/components/app/bank-picker";
import { bankName } from "@/lib/banks";
import type { BankCode } from "@/lib/generated/prisma/enums";
import { addBankAccountAction, addEntityAction, removeBankAccountAction, removeEntityAction, renameEntityAction, updateBankAccountAction } from "@/app/actions";
import { CURRENCIES, CURRENCY_CODES } from "@/lib/fx/currency";

type Bank = BankCode;
type Kind = "PT" | "CV" | "BADAN_USAHA_ASING" | "PERORANGAN";
const KIND_LABEL: Record<Kind, string> = { PT: "PT", CV: "CV", BADAN_USAHA_ASING: "Badan usaha asing", PERORANGAN: "Perorangan (pemilik)" };

/** `blocked`: why it can't be removed (the server's own check), null when it can. `numberLocked`: a statement was read for the account. */
export type BankView = { id: string; label: string; bank: Bank; number: string; code: string; isOverdraft: boolean; numberLocked: boolean; blocked: string | null };
export type EntityView = { id: string; name: string; shortName: string; npwp: string; nitku: string; kind: Kind; blocked: string | null; banks: BankView[] };

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

type Saved = { ok: true } | { ok: false; error: string; fields?: Record<string, string> };

/**
 * The end of an edit form: *Hapus …* with a second click to confirm, or why it can't be removed. Only for an admin; the reason comes
 * from the same check the removal runs.
 */
function RemovePart({ what, name, blocked, canRemove, remove, onDone }: { what: string; name: string; blocked: string | null; canRemove: boolean; remove: () => Promise<Saved>; onDone: () => void }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!canRemove) return null;
  if (blocked) return <p className="border-t pt-3 text-sm text-muted-foreground">Tidak bisa dihapus. {blocked}</p>;
  async function go() {
    setBusy(true);
    try {
      const r = await remove();
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${name} dihapus`);
      onDone();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 border-t pt-3">
      {confirming ? (
        <>
          <span className="text-sm">Hapus {name}? Belum ada pembukuan di sini, jadi tidak ada angka yang berubah.</span>
          <Button size="sm" variant="destructive" onClick={go} disabled={busy}>{busy ? "Menghapus…" : `Ya, hapus ${what}`}</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Batal</Button>
        </>
      ) : (
        <Button size="sm" variant="ghost" className="text-fail" onClick={() => setConfirming(true)}><Trash2 /> Hapus {what}</Button>
      )}
    </div>
  );
}

/** *Ubah* on a company/owner: the names and NPWP (labels only), then the removal part. */
function EditEntity({ clientId, entity, canRemove, onDone }: { clientId: string; entity: EntityView; canRemove: boolean; onDone: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(entity.name);
  const [shortName, setShortName] = useState(entity.shortName);
  const [npwp, setNpwp] = useState(entity.npwp);
  const [nitku, setNitku] = useState(entity.nitku);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const id = `edit-${entity.id}`;
  // The seller's NITKU in the Coretax faktur file: companies only (a foreign one has no NPWP, an owner issues no faktur here).
  const company = entity.kind === "PT" || entity.kind === "CV";
  async function save() {
    setBusy(true);
    try {
      const r = await renameEntityAction(clientId, entity.id, { name, shortName, npwp, ...(company ? { nitku } : {}) });
      if (!r.ok) {
        setErrors(r.fields ?? {});
        return void toast.error(r.error);
      }
      toast.success("Perubahan disimpan");
      onDone();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  const clear = () => setErrors({});
  return (
    <div className="space-y-4 border-t pt-4" data-testid={`edit-entity-${entity.id}`}>
      <div className="grid gap-4 sm:grid-cols-4">
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor={`${id}-name`}>Nama lengkap</FieldLabel>
          <Input id={`${id}-name`} value={name} aria-invalid={!!errors.name} onChange={(e) => { setName(e.target.value); clear(); }} />
          <FieldError>{errors.name}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-short`}>Nama singkat</FieldLabel>
          <Input id={`${id}-short`} value={shortName} aria-invalid={!!errors.shortName} onChange={(e) => { setShortName(e.target.value); clear(); }} placeholder="Sama dengan nama lengkap" />
          <FieldError>{errors.shortName}</FieldError>
        </Field>
        {entity.kind !== "BADAN_USAHA_ASING" && (
          <Field>
            <FieldLabel htmlFor={`${id}-npwp`}>NPWP (opsional)</FieldLabel>
            <Input id={`${id}-npwp`} value={npwp} aria-invalid={!!errors.npwp} onChange={(e) => { setNpwp(e.target.value); clear(); }} placeholder="15 atau 16 angka" />
            <FieldError>{errors.npwp}</FieldError>
          </Field>
        )}
        {company && (
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor={`${id}-nitku`}>NITKU untuk faktur (opsional)</FieldLabel>
            <Input id={`${id}-nitku`} value={nitku} inputMode="numeric" aria-invalid={!!errors.nitku} onChange={(e) => { setNitku(e.target.value); clear(); }} placeholder="Kosong = kantor pusat (NPWP + 000000)" />
            <FieldError>{errors.nitku}</FieldError>
          </Field>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Nama hanya label: tidak ada jurnal atau angka yang berubah. Nama akun bank di buku besar ikut nama singkat.</p>
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={busy}>{busy ? "Menyimpan…" : "Simpan perubahan"}</Button>
        <Button size="sm" variant="ghost" onClick={onDone} disabled={busy}>Batal</Button>
      </div>
      <RemovePart what={entity.kind === "PERORANGAN" ? "pemilik" : "perusahaan"} name={entity.name} blocked={entity.blocked} canRemove={canRemove} remove={() => removeEntityAction(clientId, entity.id)} onDone={onDone} />
    </div>
  );
}

/** *Ubah* on a rekening: name and bank any time; the number only until a statement was read for it. */
function EditBank({ clientId, bank, canRemove, onDone }: { clientId: string; bank: BankView; canRemove: boolean; onDone: () => void }) {
  const router = useRouter();
  const [value, setValue] = useState({ bank: bank.bank, number: bank.number, label: bank.label });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const id = `edit-bank-${bank.id}`;
  async function save() {
    setBusy(true);
    try {
      const r = await updateBankAccountAction(clientId, bank.id, value);
      if (!r.ok) {
        setErrors(r.fields ?? {});
        return void toast.error(r.error);
      }
      toast.success("Rekening disimpan");
      onDone();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  const set = (v: Partial<typeof value>) => { setValue({ ...value, ...v }); setErrors({}); };
  return (
    <div className="space-y-3 bg-muted/30 px-3 py-3" data-testid={`edit-bank-${bank.id}`}>
      <div className="grid gap-2 sm:grid-cols-[10rem_1fr_1fr]">
        <BankPicker value={value.bank} onChange={(v) => set({ bank: v })} />
        <div className="space-y-1">
          <Input id={`${id}-number`} aria-label="Nomor rekening" inputMode="numeric" value={value.number} disabled={bank.numberLocked} aria-invalid={!!errors["bank.number"]} onChange={(e) => set({ number: e.target.value })} />
          <FieldError>{errors["bank.number"]}</FieldError>
          {bank.numberLocked && <p className="text-xs text-muted-foreground">Nomor tetap: rekening korannya sudah dibaca dan file berikutnya dicocokkan dengan nomor ini.</p>}
        </div>
        <Input aria-label="Nama rekening" value={value.label} onChange={(e) => set({ label: e.target.value })} placeholder={`Nama (opsional), mis. ${bankName(value.bank)} Giro`} />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={busy}>{busy ? "Menyimpan…" : "Simpan rekening"}</Button>
        <Button size="sm" variant="ghost" onClick={onDone} disabled={busy}>Batal</Button>
      </div>
      <RemovePart what="rekening" name={bank.label} blocked={bank.blocked} canRemove={canRemove} remove={() => removeBankAccountAction(clientId, bank.id)} onDone={onDone} />
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

/** The client's companies/owners and their bank accounts: add to them, fix a name or number, remove what was entered by mistake. */
export function EntitiesCard({ clientId, entities, canEdit, canRemove }: { clientId: string; entities: EntityView[]; canEdit: boolean; canRemove: boolean }) {
  // One form open at a time: "entity" (add), "bank:<entity id>" (add a rekening), "edit:<entity id>", "edit-bank:<bank id>".
  const [open, setOpen] = useState<string | null>(null);
  const close = () => setOpen(null);
  return (
    <Card data-testid="entities-card">
      <CardHeader>
        <CardTitle>Perusahaan & rekening</CardTitle>
        <CardDescription>Ada perusahaan, pemilik atau rekening bank yang belum dimasukkan? Tambahkan di sini. Salah ketik nama atau nomor? Pilih Ubah. Rekening yang ditambahkan setelah Saldo Awal dicatat: saldo awalnya diisi lewat Jurnal Penyesuaian.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {entities.map((e) => (
          <div key={e.id} className="space-y-2" data-testid={`entity-${e.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium">{e.name}</div>
                <div className="text-xs text-muted-foreground">{KIND_LABEL[e.kind]}{e.shortName !== e.name ? ` · ${e.shortName}` : ""}{e.npwp ? ` · NPWP ${e.npwp}` : ""}</div>
              </div>
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  {open !== `edit:${e.id}` && <Button size="sm" variant="ghost" aria-label={`Ubah ${e.name}`} onClick={() => setOpen(`edit:${e.id}`)}><Pencil /> Ubah</Button>}
                  {open !== `bank:${e.id}` && <Button size="sm" variant="outline" onClick={() => setOpen(`bank:${e.id}`)}><Plus /> Tambah rekening</Button>}
                </div>
              )}
            </div>
            {open === `edit:${e.id}` && <EditEntity clientId={clientId} entity={e} canRemove={canRemove} onDone={close} />}
            {e.banks.length === 0 ? (
              <p className="text-sm text-muted-foreground">Belum ada rekening bank. Unggah rekening korannya di <Link href={`/clients/${clientId}/import`} className="text-primary">Unggah</Link> — rekeningnya ditambahkan dari file.</p>
            ) : (
              <ul className="divide-y border text-sm">
                {e.banks.map((b) => (
                  <li key={b.id}>
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
                      <span className="min-w-0 truncate">{b.label}{b.isOverdraft ? " · PRK" : ""}</span>
                      <span className="flex items-center gap-2">
                        <span className="num text-muted-foreground">{b.number} · {b.code}</span>
                        {canEdit && open !== `edit-bank:${b.id}` && <Button size="xs" variant="ghost" aria-label={`Ubah rekening ${b.label}`} onClick={() => setOpen(`edit-bank:${b.id}`)}><Pencil /> Ubah</Button>}
                      </span>
                    </div>
                    {open === `edit-bank:${b.id}` && <EditBank clientId={clientId} bank={b} canRemove={canRemove} onDone={close} />}
                  </li>
                ))}
              </ul>
            )}
            {open === `bank:${e.id}` && <AddBank clientId={clientId} entity={e} onDone={close} />}
          </div>
        ))}
        {canEdit && (open === "entity" ? (
          <AddEntity clientId={clientId} onDone={close} />
        ) : (
          <Button variant="outline" onClick={() => setOpen("entity")}><Plus /> Tambah perusahaan atau pemilik</Button>
        ))}
      </CardContent>
    </Card>
  );
}
