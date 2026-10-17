"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/app/money";
import { StatusPill } from "@/components/app/status";
import { SimpleSelect } from "@/components/app/simple-select";
import { setContactTaxIdentityAction, setInvoiceFakturItemAction } from "@/app/actions";
import { DEFAULT_ITEM_CODE, headOfficeNitku, ITEM_KIND_LABEL, npwp16, UNITS, unitLabel, type ItemKind } from "@/lib/tax/coretax-codes";

/**
 * *Faktur keluaran untuk Coretax* on Pajak Masa (cycle 2026-10-17-coretax-files): the masa's sales invoices with PPN, each Siap, Diblokir
 * (every reason, fixed in place) or already in Coretax, and the XML download of the Siap ones. Amounts arrive as strings.
 */
export type CoretaxContact = { id: string; name: string; npwp: string; nik: string; nitku: string; address: string; email: string };
export type CoretaxRow = {
  invoiceId: string;
  number: string;
  date: string;
  description: string;
  dpp: string;
  ppn: string;
  contact: CoretaxContact;
  item: { kind: ItemKind | null; code: string; unit: string | null; name: string; own: string; prefilled: boolean };
  status: "BLOCKED" | "READY" | "IN_CORETAX";
  reasons: { code: string; text: string; fix: "BUYER" | "ITEM" | "INVOICE" | "COMPANY" }[];
  coretaxNumber: string | null;
};
export type CoretaxPart = { href: string; rows: number };

type Open = { kind: "buyer"; contact: CoretaxContact } | { kind: "item"; rows: CoretaxRow[] } | null;

export function CoretaxFaktur({
  clientId,
  label,
  parts,
  counts,
  companyReasons,
  rows,
  bankPpn,
  settingsHref,
  receivablesHref,
  uploadBy,
}: {
  clientId: string;
  label: string;
  parts: CoretaxPart[];
  counts: { ready: number; blocked: number; inCoretax: number };
  companyReasons: string[];
  rows: CoretaxRow[];
  bankPpn: { key: string; date: string; label: string; ppn: string }[];
  settingsHref: string;
  receivablesHref: string;
  uploadBy: string;
}) {
  const [open, setOpen] = useState<Open>(null);
  const editable = rows.filter((r) => r.status !== "IN_CORETAX");
  const groups = (["BLOCKED", "READY", "IN_CORETAX"] as const).map((s) => ({ status: s, rows: rows.filter((r) => r.status === s) }));
  const total = parts.reduce((t, p) => t + p.rows, 0);
  const blockedFile = companyReasons.length > 0;

  if (!rows.length && !bankPpn.length) {
    return (
      <div className="space-y-2 text-sm" data-testid="coretax-faktur">
        <p>Belum ada faktur penjualan ber-PPN di masa ini.</p>
        <Link href={receivablesHref} className="text-primary underline-offset-2 hover:underline">Buka Piutang & Utang</Link>
        <Footnote />
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="coretax-faktur">
      {blockedFile && (
        <div role="alert" className="space-y-1 rounded-lg bg-fail-subtle px-3 py-2 text-sm" data-testid="coretax-company-block">
          {companyReasons.map((r) => <p key={r}>{r}</p>)}
          <Link href={settingsHref} className="font-medium text-primary underline-offset-2 hover:underline">Lengkapi data perusahaan</Link>
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-4">
        <dl className="grid grid-cols-3 gap-4 text-sm" data-testid="coretax-counts">
          <div>
            <dt className="eyebrow text-muted-foreground">Siap</dt>
            <dd className="num text-lg" data-testid="coretax-count-ready">{counts.ready}</dd>
          </div>
          <div>
            <dt className="eyebrow text-muted-foreground">Diblokir</dt>
            <dd className="num text-lg" data-testid="coretax-count-blocked">{counts.blocked}</dd>
          </div>
          <div>
            <dt className="eyebrow text-muted-foreground">Sudah ada di Coretax</dt>
            <dd className="num text-lg" data-testid="coretax-count-in">{counts.inCoretax}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          {blockedFile || total === 0 ? (
            <Button disabled data-testid="coretax-download">
              <Download /> Unduh XML (0 faktur)
            </Button>
          ) : parts.length === 1 ? (
            <a href={parts[0].href} download className={buttonVariants()} data-testid="coretax-download">
              <Download /> Unduh XML ({total} faktur)
            </a>
          ) : (
            parts.map((p, i) => (
              <a key={p.href} href={p.href} download className={buttonVariants({ variant: i === 0 ? "default" : "outline" })} data-testid="coretax-download">
                <Download /> Bagian {i + 1} dari {parts.length} ({p.rows} faktur)
              </a>
            ))
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {counts.blocked + counts.inCoretax > 0 && !blockedFile
          ? `File hanya berisi faktur yang siap: ${[counts.blocked ? `${counts.blocked} diblokir` : "", counts.inCoretax ? `${counts.inCoretax} sudah ada di Coretax` : ""].filter(Boolean).join(" dan ")} tidak ikut. `
          : ""}
        {parts.length > 1 ? "Coretax menerima paling banyak 1.000 faktur per file, jadi file dibagi. " : ""}
        Unggah sebaiknya paling lambat {uploadBy} (tanggal 15 bulan berikutnya; batas ini belum dicek dengan PER-11/PJ/2025).
      </p>

      {editable.length > 0 && (
        <Button variant="outline" size="sm" onClick={() => setOpen({ kind: "item", rows: editable })} data-testid="coretax-item-all">
          Atur barang/jasa untuk semua
        </Button>
      )}

      {groups.map((g) =>
        g.rows.length === 0 ? null : g.status === "BLOCKED" ? (
          <section key={g.status} className="space-y-2" data-testid="coretax-BLOCKED">
            <h3 className="text-sm font-medium">Diblokir</h3>
            <Rows rows={g.rows} receivablesHref={receivablesHref} onOpen={setOpen} />
          </section>
        ) : (
          // Rows that need nothing fold (ui-rules 10); Siap stays open when nothing is blocked.
          <details key={g.status} open={g.status === "READY" && counts.blocked === 0} className="group space-y-2" data-testid={`coretax-${g.status}`}>
            <summary className="cursor-pointer text-sm font-medium">
              {g.status === "READY" ? `${g.rows.length} faktur siap` : `${g.rows.length} faktur sudah ada di Coretax`}
            </summary>
            <Rows rows={g.rows} receivablesHref={receivablesHref} onOpen={setOpen} />
          </details>
        ),
      )}

      {bankPpn.length > 0 && (
        <section className="space-y-2" data-testid="coretax-bank-ppn">
          <h3 className="text-sm font-medium">PPN dari mutasi bank: catat sebagai faktur penjualan dulu</h3>
          <p className="text-xs text-muted-foreground">
            PPN mutasi ini dipisah dengan tarif efektif dan tidak punya pembeli, jadi tidak masuk file. Catat penjualannya di{" "}
            <Link href={receivablesHref} className="text-primary underline-offset-2 hover:underline">Piutang & Utang</Link>, lalu fakturnya muncul di sini.
          </p>
          <Table>
            <TableBody>
              {bankPpn.map((b) => (
                <TableRow key={b.key}>
                  <TableCell className="num hidden w-0 whitespace-nowrap sm:table-cell">{b.date}</TableCell>
                  <TableCell className="whitespace-normal">
                    {b.label}
                    <div className="num text-xs text-muted-foreground sm:hidden">{b.date}</div>
                  </TableCell>
                  <TableCell className="text-right"><Money value={BigInt(b.ppn)} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      <Footnote />

      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent className="w-full overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md">
          {open?.kind === "buyer" && <BuyerForm key={open.contact.id} clientId={clientId} contact={open.contact} onDone={() => setOpen(null)} />}
          {open?.kind === "item" && <ItemForm key={open.rows.map((r) => r.invoiceId).join()} clientId={clientId} rows={open.rows} label={label} onDone={() => setOpen(null)} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Footnote() {
  return (
    <p className="text-xs text-muted-foreground" data-testid="coretax-footnote">
      Format impor DJP v1.4 (template 1.6.1), belum diuji dengan unggahan nyata ke Coretax. Unggah lewat Coretax → e-Faktur → Faktur Keluaran → Impor Data; Buku tidak
      mengirim ke DJP.
    </p>
  );
}

function Rows({ rows, receivablesHref, onOpen }: { rows: CoretaxRow[]; receivablesHref: string; onOpen: (o: Open) => void }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="eyebrow">Faktur</TableHead>
          <TableHead className="eyebrow hidden md:table-cell">Pembeli</TableHead>
          <TableHead className="eyebrow hidden text-right sm:table-cell">DPP</TableHead>
          <TableHead className="eyebrow text-right">PPN</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <RowLines key={r.invoiceId} r={r} receivablesHref={receivablesHref} onOpen={onOpen} />
        ))}
      </TableBody>
    </Table>
  );
}

function RowLines({ r, receivablesHref, onOpen }: { r: CoretaxRow; receivablesHref: string; onOpen: (o: Open) => void }) {
  const item = r.item.kind && r.item.unit ? `${ITEM_KIND_LABEL[r.item.kind]} · ${r.item.code} · ${unitLabel(r.item.unit)}${r.item.prefilled ? " (dari faktur terakhir pembeli ini)" : ""}` : null;
  const buyerId = r.contact.npwp ? `NPWP ${r.contact.npwp}` : r.contact.nik ? "NIK terisi" : null;
  const fixes = new Set(r.reasons.map((x) => x.fix));
  return (
    <>
      <TableRow data-testid="coretax-row" data-status={r.status} data-number={r.number} className="border-b-0">
        <TableCell className="whitespace-normal">
          <span className="num font-medium">{r.number}</span>
          <span className="num ml-2 text-xs text-muted-foreground">{r.date}</span>
          <div className="text-xs text-muted-foreground md:hidden">{r.contact.name}</div>
          {r.status === "BLOCKED" && <div className="mt-1 sm:hidden"><StatusPill status="REVIEW" label="Diblokir" /></div>}
        </TableCell>
        <TableCell className="hidden whitespace-normal md:table-cell">
          {r.contact.name}
          {buyerId && <div className="num text-xs text-muted-foreground">{buyerId}</div>}
        </TableCell>
        <TableCell className="hidden text-right sm:table-cell"><Money value={BigInt(r.dpp)} /></TableCell>
        <TableCell className="text-right"><Money value={BigInt(r.ppn)} /></TableCell>
      </TableRow>
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={4} className="pt-0 text-xs whitespace-normal text-muted-foreground">
          {r.status === "IN_CORETAX" ? (
            <p>Sudah ada di Coretax{r.coretaxNumber ? `: faktur ${r.coretaxNumber}` : ""}.</p>
          ) : (
            <>
              <ul className="space-y-0.5" data-testid="coretax-reasons">
                {r.reasons.map((x) => (
                  <li key={x.code} className="text-review">{x.text}</li>
                ))}
              </ul>
              {item && <p>{item}</p>}
              <div className="mt-1 flex flex-wrap gap-2">
                <Button size="xs" variant={fixes.has("BUYER") ? "outline" : "ghost"} onClick={() => onOpen({ kind: "buyer", contact: r.contact })}>
                  {fixes.has("BUYER") ? "Lengkapi pembeli" : "Ubah pembeli"}
                </Button>
                <Button size="xs" variant={fixes.has("ITEM") ? "outline" : "ghost"} onClick={() => onOpen({ kind: "item", rows: [r] })}>
                  {fixes.has("ITEM") ? "Atur barang/jasa" : "Ubah barang/jasa"}
                </Button>
                {fixes.has("INVOICE") && (
                  <Link href={receivablesHref} className={buttonVariants({ variant: "outline", size: "xs" })}>Buka Piutang & Utang</Link>
                )}
              </div>
            </>
          )}
        </TableCell>
      </TableRow>
    </>
  );
}

/** *Lengkapi pembeli*: the buyer's identity on the contact, reused every month. */
function BuyerForm({ clientId, contact, onDone }: { clientId: string; contact: CoretaxContact; onDone: () => void }) {
  const router = useRouter();
  const [v, setV] = useState({ npwp: contact.npwp, nik: contact.nik, nitku: contact.nitku, address: contact.address, email: contact.email });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof v>) => {
    setV({ ...v, ...p });
    setErrors({});
  };
  const tin = npwp16(v.npwp);
  async function save() {
    setBusy(true);
    try {
      // A NITKU belongs to an NPWP: without one it is not sent.
      const r = await setContactTaxIdentityAction({ clientId, contactId: contact.id, ...v, nitku: v.npwp.trim() ? v.nitku : "" });
      if (!r.ok) {
        setErrors(r.fields ?? {});
        return void toast.error(r.error);
      }
      toast.success(`Identitas pajak ${contact.name} disimpan`);
      onDone();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-4" data-testid="coretax-buyer-form">
      <SheetHeader>
        <SheetTitle>Pembeli: {contact.name}</SheetTitle>
        <SheetDescription>Disimpan di kontak dan dipakai untuk semua fakturnya. Isi NPWP; pembeli tanpa NPWP diisi NIK dan alamat.</SheetDescription>
      </SheetHeader>
      <div className="space-y-4 px-4">
        <Field>
          <FieldLabel htmlFor="buyer-npwp">NPWP</FieldLabel>
          <Input id="buyer-npwp" inputMode="numeric" value={v.npwp} aria-invalid={!!errors.npwp} onChange={(e) => set({ npwp: e.target.value })} placeholder="15 atau 16 angka" />
          <FieldError>{errors.npwp}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="buyer-nitku">NITKU</FieldLabel>
          <Input id="buyer-nitku" inputMode="numeric" value={v.nitku} aria-invalid={!!errors.nitku} disabled={!v.npwp.trim()} onChange={(e) => set({ nitku: e.target.value })} placeholder={tin ? headOfficeNitku(tin) : "Isi NPWP dulu"} />
          <FieldDescription>Kosong = kantor pusat (NPWP + 000000). Isi untuk cabang.</FieldDescription>
          <FieldError>{errors.nitku}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="buyer-nik">NIK (pembeli tanpa NPWP)</FieldLabel>
          <Input id="buyer-nik" inputMode="numeric" value={v.nik} aria-invalid={!!errors.nik} onChange={(e) => set({ nik: e.target.value })} placeholder="16 angka" />
          <FieldError>{errors.nik}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="buyer-address">Alamat</FieldLabel>
          <Input id="buyer-address" value={v.address} aria-invalid={!!errors.address} onChange={(e) => set({ address: e.target.value })} placeholder={v.npwp.trim() ? "Opsional: Coretax mengisi dari data NPWP" : "Wajib untuk pembeli dengan NIK"} />
          <FieldError>{errors.address}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="buyer-email">Email (opsional)</FieldLabel>
          <Input id="buyer-email" type="email" value={v.email} aria-invalid={!!errors.email} onChange={(e) => set({ email: e.target.value })} />
          <FieldError>{errors.email}</FieldError>
        </Field>
        <p className="text-xs text-muted-foreground">NIK, alamat dan email hanya masuk ke file faktur; tidak pernah dikirim ke AI.</p>
      </div>
      <SheetFooter>
        <Button onClick={save} disabled={busy} data-testid="coretax-buyer-save">{busy ? "Menyimpan…" : "Simpan pembeli"}</Button>
      </SheetFooter>
    </div>
  );
}

/** *Atur barang/jasa*: one item per faktur. For one invoice the name can be set too; for all, each keeps its own. */
function ItemForm({ clientId, rows, label, onDone }: { clientId: string; rows: CoretaxRow[]; label: string; onDone: () => void }) {
  const router = useRouter();
  const one = rows.length === 1 ? rows[0] : null;
  const seed = rows.find((r) => r.item.kind && r.item.unit)?.item;
  const [kind, setKind] = useState<string>(seed?.kind ?? "");
  const [code, setCode] = useState(seed?.code ?? DEFAULT_ITEM_CODE);
  const [unit, setUnit] = useState(seed?.unit ?? "");
  const [name, setName] = useState(one?.item.own ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const r = await setInvoiceFakturItemAction({ clientId, invoiceIds: rows.map((x) => x.invoiceId), kind, code, unit, ...(one ? { name } : {}) });
      if (!r.ok) return void setError(r.error);
      toast.success(one ? `Barang/jasa faktur ${one.number} disimpan` : `Barang/jasa diatur untuk ${r.count} faktur`);
      onDone();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-4" data-testid="coretax-item-form">
      <SheetHeader>
        <SheetTitle>{one ? `Barang/jasa faktur ${one.number}` : `Barang/jasa untuk ${rows.length} faktur`}</SheetTitle>
        <SheetDescription>
          Satu baris per faktur: jumlah 1, harga = DPP. {one ? "" : `Berlaku untuk semua faktur ${label} yang belum ada di Coretax; nama barang/jasa tetap keterangan masing-masing faktur.`}
        </SheetDescription>
      </SheetHeader>
      <div className="space-y-4 px-4">
        <Field>
          <FieldLabel htmlFor="item-kind">Barang atau jasa</FieldLabel>
          <SimpleSelect id="item-kind" label="Barang atau jasa" value={kind} onChange={(x) => { setKind(x); setError(null); }} options={(["A", "B"] as const).map((k) => ({ value: k, label: ITEM_KIND_LABEL[k] }))} placeholder="Pilih" />
        </Field>
        <Field>
          <FieldLabel htmlFor="item-code">Kode barang/jasa</FieldLabel>
          <Input id="item-code" inputMode="numeric" value={code} onChange={(e) => { setCode(e.target.value); setError(null); }} />
          <FieldDescription>{DEFAULT_ITEM_CODE} bila tidak ada kode DJP yang cocok.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="item-unit">Satuan</FieldLabel>
          <SimpleSelect id="item-unit" label="Satuan" value={unit} onChange={(x) => { setUnit(x); setError(null); }} options={UNITS.map((u) => ({ value: u.code, label: u.label }))} placeholder="Pilih satuan" />
        </Field>
        {one && (
          <Field>
            <FieldLabel htmlFor="item-name">Nama barang/jasa</FieldLabel>
            <Input id="item-name" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} placeholder={one.description} />
            <FieldDescription>Kosong = keterangan faktur.</FieldDescription>
          </Field>
        )}
        {error && <p role="alert" className="text-sm text-fail">{error}</p>}
      </div>
      <SheetFooter>
        <Button onClick={save} disabled={busy || !kind || !unit} data-testid="coretax-item-save">
          {busy ? "Menyimpan…" : one ? "Simpan" : `Terapkan ke semua (${rows.length} faktur)`}
        </Button>
      </SheetFooter>
    </div>
  );
}
