"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/app/money";
import { StatusPill } from "@/components/app/status";
import { SimpleSelect } from "@/components/app/simple-select";
import { IdentityForm, type CoretaxContact } from "@/components/app/coretax-faktur";
import { setWithholdingSlipAction } from "@/app/actions";
import { formatRupiah, parseMoney } from "@/lib/money";
import { DOCUMENT_LABEL, DOCUMENT_TYPES, exactDpp, KOPS, listedKop, parseRate, pphOf, rateLabel, SLIP_KIND_LABEL, taxTies, type SlipKind } from "@/lib/tax/bppu-codes";

/**
 * *Dipotong oleh perusahaan* in *Bukti potong (Unifikasi)* on Pajak Masa (cycle 2026-10-17-bppu-files): the masa's withheld payments as
 * Coretax BPPU slips, each Siap, Diblokir (every reason, fixed in place) or already in Coretax, and the XML download of the Siap ones.
 * Amounts arrive as strings; rates are hundredths of a percent.
 */
export type BppuViewRow = {
  id: string;
  date: string;
  description: string;
  kind: SlipKind;
  gross: string;
  withheld: string;
  inReview: boolean;
  ppnSplit: boolean;
  recipient: (CoretaxContact & { fromLine: boolean }) | null;
  kop: string;
  rate: number | null;
  dpp: string;
  documentType: string;
  documentNumber: string;
  /** YYYY-MM-DD */
  documentDate: string;
  prefill: { dpp: "INVOICE" | "DIVISION" | null; kop: boolean; document: "INVOICE" | "LAST" | null };
  status: "BLOCKED" | "READY" | "IN_CORETAX";
  reasons: { code: string; text: string; fix: "REVIEW" | "SLIP" | "RECIPIENT" | "COMPANY" }[];
  coretaxNumber: string | null;
};

type Open = { kind: "slip"; row: BppuViewRow } | { kind: "identity"; contact: CoretaxContact } | null;
const OTHER = "__other";
const NEW = "__new";

export function CoretaxBppu({
  clientId,
  canWrite,
  href,
  counts,
  companyReasons,
  rows,
  contacts,
  settingsHref,
  reviewHref,
  sptBy,
}: {
  clientId: string;
  canWrite: boolean;
  /** The download, while something is Siap and the company doesn't block. */
  href: string | null;
  counts: { ready: number; blocked: number; inCoretax: number };
  companyReasons: string[];
  rows: BppuViewRow[];
  contacts: { id: string; name: string }[];
  settingsHref: string;
  reviewHref: string;
  sptBy: string;
}) {
  const [open, setOpen] = useState<Open>(null);
  const groups = (["BLOCKED", "READY", "IN_CORETAX"] as const).map((s) => ({ status: s, rows: rows.filter((r) => r.status === s) }));
  const blockedFile = companyReasons.length > 0;

  return (
    <div className="space-y-3" data-testid="coretax-bppu">
      <h3 className="text-sm font-medium">Dipotong oleh perusahaan: buat bukti potongnya di Coretax</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Tidak ada pemotongan oleh perusahaan masa ini.</p>
      ) : (
        <>
          {blockedFile && (
            <div role="alert" className="space-y-1 rounded-lg bg-fail-subtle px-3 py-2 text-sm" data-testid="bppu-company-block">
              {companyReasons.map((r) => <p key={r}>{r}</p>)}
              <Link href={settingsHref} className="font-medium text-primary underline-offset-2 hover:underline">Lengkapi data perusahaan</Link>
            </div>
          )}
          <div className="flex flex-wrap items-end justify-between gap-4">
            <dl className="grid grid-cols-3 gap-4 text-sm" data-testid="bppu-counts">
              <div>
                <dt className="eyebrow text-muted-foreground">Siap</dt>
                <dd className="num text-lg" data-testid="bppu-count-ready">{counts.ready}</dd>
              </div>
              <div>
                <dt className="eyebrow text-muted-foreground">Diblokir</dt>
                <dd className="num text-lg" data-testid="bppu-count-blocked">{counts.blocked}</dd>
              </div>
              <div>
                <dt className="eyebrow text-muted-foreground">Sudah ada di Coretax</dt>
                <dd className="num text-lg" data-testid="bppu-count-in">{counts.inCoretax}</dd>
              </div>
            </dl>
            {href ? (
              <a href={href} download className={buttonVariants()} data-testid="bppu-download">
                <Download /> Unduh XML BPPU ({counts.ready} bukti potong)
              </a>
            ) : (
              <Button disabled data-testid="bppu-download">
                <Download /> Unduh XML BPPU (0 bukti potong)
              </Button>
            )}
          </div>
          {href && counts.blocked + counts.inCoretax > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="bppu-left-out">
              File hanya berisi bukti potong yang siap: {[counts.blocked ? `${counts.blocked} diblokir` : "", counts.inCoretax ? `${counts.inCoretax} sudah ada di Coretax` : ""].filter(Boolean).join(" dan ")} tidak ikut.
            </p>
          )}

          {groups.map((g) =>
            g.rows.length === 0 ? null : g.status === "BLOCKED" ? (
              <section key={g.status} className="space-y-2" data-testid="bppu-BLOCKED">
                <h4 className="text-sm font-medium">Diblokir</h4>
                <Rows rows={g.rows} canWrite={canWrite} reviewHref={reviewHref} onOpen={setOpen} />
              </section>
            ) : (
              // Rows that need nothing fold (ui-rules 10); Siap stays open when nothing is blocked.
              <details key={g.status} open={g.status === "READY" && counts.blocked === 0} className="space-y-2" data-testid={`bppu-${g.status}`}>
                <summary className="cursor-pointer text-sm font-medium">
                  {g.status === "READY" ? `${g.rows.length} bukti potong siap` : `${g.rows.length} sudah ada di Coretax`}
                </summary>
                <Rows rows={g.rows} canWrite={canWrite} reviewHref={reviewHref} onOpen={setOpen} />
              </details>
            ),
          )}
        </>
      )}

      <p className="text-xs text-muted-foreground" data-testid="bppu-footnote">
        Format impor DJP bppu.xml (converter v.3), belum diuji dengan unggahan nyata. Unggah lewat Coretax → e-Bupot → BPPU → Impor Data; Buku tidak mengirim ke DJP.
        Pemotongan yang dicatat lewat jurnal saja (tanpa mutasi bank) tidak ada di daftar ini: buat bukti potongnya langsung di Coretax. SPT Masa PPh Unifikasi paling lambat {sptBy}.
      </p>

      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent className="w-full overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md">
          {open?.kind === "slip" && <SlipForm key={open.row.id} clientId={clientId} row={open.row} contacts={contacts} onDone={() => setOpen(null)} />}
          {open?.kind === "identity" && <IdentityForm key={open.contact.id} clientId={clientId} contact={open.contact} holder="penerima" onDone={() => setOpen(null)} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Rows({ rows, canWrite, reviewHref, onOpen }: { rows: BppuViewRow[]; canWrite: boolean; reviewHref: string; onOpen: (o: Open) => void }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="eyebrow">Mutasi</TableHead>
          <TableHead className="eyebrow hidden md:table-cell">Penerima</TableHead>
          <TableHead className="eyebrow hidden lg:table-cell">Kode objek pajak</TableHead>
          <TableHead className="eyebrow hidden text-right sm:table-cell">Bruto</TableHead>
          <TableHead className="eyebrow text-right">Dipotong</TableHead>
          <TableHead className="eyebrow hidden text-right sm:table-cell">DPP</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <RowLines key={r.id} r={r} canWrite={canWrite} reviewHref={reviewHref} onOpen={onOpen} />
        ))}
      </TableBody>
    </Table>
  );
}

function RowLines({ r, canWrite, reviewHref, onOpen }: { r: BppuViewRow; canWrite: boolean; reviewHref: string; onOpen: (o: Open) => void }) {
  const fixes = new Set(r.reasons.map((x) => x.fix));
  const toReview = fixes.has("REVIEW") || r.reasons.some((x) => x.code === "TAX_DIFF" || x.code === "KOP_KIND");
  const recipient = r.recipient?.name ?? <span className="text-muted-foreground">Belum dipilih</span>;
  const recipientId = r.recipient?.npwp ? `NPWP ${r.recipient.npwp}` : r.recipient?.nik ? "NIK terisi" : null;
  const kop = r.kop ? `${r.kop}${r.rate !== null ? ` · ${rateLabel(r.rate)}` : ""}` : null;
  return (
    <>
      <TableRow data-testid="bppu-row" data-status={r.status} data-description={r.description} className="border-b-0">
        <TableCell className="whitespace-normal">
          <span className="num text-xs text-muted-foreground">{r.date}</span>
          <div>{r.description}</div>
          <div className="text-xs text-muted-foreground">
            {SLIP_KIND_LABEL[r.kind]}
            {r.inReview ? " · belum direview" : ""}
          </div>
          {/* Phones and tablets: the recipient, KOP, gross and DPP sit under the line (their columns are hidden). */}
          <div className="text-xs text-muted-foreground md:hidden">Penerima: {recipient}</div>
          {kop && <div className="num text-xs text-muted-foreground lg:hidden">Kode {kop}</div>}
          <div className="num text-xs text-muted-foreground sm:hidden">
            Bruto {formatRupiah(BigInt(r.gross), { bare: true })}
            {r.dpp ? ` · DPP ${formatRupiah(BigInt(r.dpp), { bare: true })}` : ""}
          </div>
          {r.status === "BLOCKED" && <div className="mt-1 sm:hidden"><StatusPill status="REVIEW" label="Diblokir" /></div>}
        </TableCell>
        <TableCell className="hidden whitespace-normal md:table-cell">
          {recipient}
          {recipientId && <div className="num text-xs text-muted-foreground">{recipientId}</div>}
        </TableCell>
        <TableCell className="num hidden whitespace-nowrap lg:table-cell">{kop ?? <span className="text-muted-foreground">–</span>}</TableCell>
        <TableCell className="hidden text-right sm:table-cell"><Money value={BigInt(r.gross)} /></TableCell>
        <TableCell className="text-right"><Money value={BigInt(r.withheld)} /></TableCell>
        <TableCell className="hidden text-right sm:table-cell">{r.dpp ? <Money value={BigInt(r.dpp)} /> : <span className="text-muted-foreground">–</span>}</TableCell>
      </TableRow>
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={6} className="pt-0 text-xs whitespace-normal text-muted-foreground">
          {r.status === "IN_CORETAX" ? (
            <p>Sudah ada di Coretax{r.coretaxNumber ? `: bukti potong ${r.coretaxNumber}` : ""}.</p>
          ) : (
            <>
              <ul className="space-y-0.5" data-testid="bppu-reasons">
                {r.reasons.map((x) => (
                  <li key={x.code} className="text-review">{x.text}</li>
                ))}
              </ul>
              <div className="mt-1 flex flex-wrap gap-2">
                {canWrite && (
                  <Button size="xs" variant={fixes.has("SLIP") ? "outline" : "ghost"} onClick={() => onOpen({ kind: "slip", row: r })}>
                    {fixes.has("SLIP") ? "Atur bukti potong" : "Ubah bukti potong"}
                  </Button>
                )}
                {canWrite && r.recipient && (
                  <Button size="xs" variant={fixes.has("RECIPIENT") ? "outline" : "ghost"} onClick={() => onOpen({ kind: "identity", contact: r.recipient! })}>
                    {fixes.has("RECIPIENT") ? "Lengkapi identitas" : "Ubah identitas"}
                  </Button>
                )}
                {toReview && (
                  <Link href={reviewHref} className={buttonVariants({ variant: fixes.has("REVIEW") ? "outline" : "ghost", size: "xs" })}>Buka di Review</Link>
                )}
              </div>
            </>
          )}
        </TableCell>
      </TableRow>
    </>
  );
}

const readDpp = (s: string): bigint | null => {
  try {
    const v = parseMoney(s, "IDR");
    return v > 0n ? v : null;
  } catch {
    return null;
  }
};

/** *Atur bukti potong*: recipient (when the line has none), KOP with DJP's rate or *Kode lain*, DPP with the formula line, document. */
function SlipForm({ clientId, row, contacts, onDone }: { clientId: string; row: BppuViewRow; contacts: { id: string; name: string }[]; onDone: () => void }) {
  const router = useRouter();
  const fromLine = row.recipient?.fromLine ?? false;
  const listed = listedKop(row.kop);
  const [contact, setContact] = useState(fromLine ? "" : (row.recipient?.id ?? ""));
  const [newName, setNewName] = useState("");
  const [kop, setKop] = useState(row.kop ? (listed ? row.kop : OTHER) : "");
  const [otherCode, setOtherCode] = useState(listed ? "" : row.kop);
  const [otherRate, setOtherRate] = useState(!listed && row.rate !== null ? rateLabel(row.rate).replace("%", "") : "");
  const [dpp, setDpp] = useState(row.dpp ? formatRupiah(BigInt(row.dpp), { bare: true }) : "");
  const [docType, setDocType] = useState(row.documentType || "CommercialInvoice");
  const [docNumber, setDocNumber] = useState(row.documentNumber);
  const [docDate, setDocDate] = useState(row.documentDate);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const withheld = BigInt(row.withheld);
  const rate = kop === OTHER ? parseRate(otherRate) : (listedKop(kop)?.rate ?? null);
  const base = readDpp(dpp);
  const kops = KOPS.filter((k) => k.kind === row.kind);

  function pickKop(value: string) {
    setKop(value);
    setError(null);
    // An empty DPP takes withheld ÷ rate when it divides exactly (never on a PPN-split line, whose DPP is the accountant's to state).
    const r = listedKop(value)?.rate;
    if (r && !dpp.trim() && !row.ppnSplit) {
      const exact = exactDpp(withheld, r);
      if (exact !== null) setDpp(formatRupiah(exact, { bare: true }));
    }
  }

  async function save() {
    setBusy(true);
    try {
      const r = await setWithholdingSlipAction({
        clientId,
        bankTransactionId: row.id,
        contactId: fromLine || contact === NEW ? null : contact || null,
        contactName: !fromLine && contact === NEW ? newName : null,
        kop: kop === OTHER ? otherCode : kop,
        rate: kop === OTHER ? otherRate : null,
        dpp,
        documentType: docType,
        documentNumber: docNumber,
        documentDate: docDate,
      });
      if (!r.ok) return void setError(r.error);
      toast.success(`Bukti potong ${row.description} disimpan`);
      onDone();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="bppu-slip-form">
      <SheetHeader>
        <SheetTitle>Bukti potong: {row.description}</SheetTitle>
        <SheetDescription>
          {row.date} · {SLIP_KIND_LABEL[row.kind]} dipotong {formatRupiah(withheld)}. Disimpan untuk file Coretax saja: tidak mengubah jurnal maupun potongannya.
        </SheetDescription>
      </SheetHeader>
      <div className="space-y-4 px-4">
        {fromLine ? (
          <p className="text-sm">
            Penerima: <span className="font-medium">{row.recipient!.name}</span> <span className="text-muted-foreground">(dari mutasi; ubah lewat Piutang & Utang)</span>
          </p>
        ) : (
          <Field>
            <FieldLabel htmlFor="slip-recipient">Penerima penghasilan</FieldLabel>
            <SimpleSelect
              id="slip-recipient"
              label="Penerima penghasilan"
              value={contact}
              onChange={(v) => { setContact(v); setError(null); }}
              options={[...contacts.map((c) => ({ value: c.id, label: c.name })), { value: NEW, label: "Penerima baru…" }]}
              placeholder="Pilih penerima"
            />
            {contact === NEW && <Input aria-label="Nama penerima baru" value={newName} onChange={(e) => { setNewName(e.target.value); setError(null); }} placeholder="Nama sesuai NPWP/KTP" />}
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="slip-kop">Kode objek pajak</FieldLabel>
          <SimpleSelect
            id="slip-kop"
            label="Kode objek pajak"
            value={kop}
            onChange={pickKop}
            options={[...kops.map((k) => ({ value: k.code, label: `${k.code} ${k.name} (${rateLabel(k.rate)})` })), { value: OTHER, label: "Kode lain" }]}
            placeholder={`Pilih kode ${SLIP_KIND_LABEL[row.kind]}`}
          />
          {kop === OTHER ? (
            <div className="grid grid-cols-2 gap-2">
              <Input aria-label="Kode" inputMode="numeric" value={otherCode} onChange={(e) => { setOtherCode(e.target.value); setError(null); }} placeholder="NN-NNN-NN" />
              <Input aria-label="Tarif (%)" inputMode="decimal" value={otherRate} onChange={(e) => { setOtherRate(e.target.value); setError(null); }} placeholder="Tarif, mis. 1,75" />
            </div>
          ) : rate !== null ? (
            <FieldDescription data-testid="slip-rate">Tarif {rateLabel(rate)} sesuai referensi DJP.</FieldDescription>
          ) : null}
          {row.prefill.kop && <FieldDescription>Dari bukti potong terakhir penerima ini.</FieldDescription>}
        </Field>
        <Field>
          <FieldLabel htmlFor="slip-dpp">DPP</FieldLabel>
          <Input id="slip-dpp" inputMode="numeric" value={dpp} onChange={(e) => { setDpp(e.target.value); setError(null); }} placeholder="Dasar pemotongan, Rupiah" />
          {rate !== null && base !== null && (
            <FieldDescription data-testid="slip-formula" className={taxTies(base, rate, withheld) ? undefined : "text-review"}>
              {rateLabel(rate)} × DPP = {formatRupiah(pphOf(base, rate))}, buku {formatRupiah(withheld)}
            </FieldDescription>
          )}
          {row.prefill.dpp === "INVOICE" && <FieldDescription>Dari tagihan yang dilunasi mutasi ini.</FieldDescription>}
          {row.ppnSplit && <FieldDescription>PPN mutasi ini dipisah dengan tarif efektif: isi DPP dari dokumennya.</FieldDescription>}
        </Field>
        <Field>
          <FieldLabel htmlFor="slip-doc-type">Dokumen referensi</FieldLabel>
          <SimpleSelect id="slip-doc-type" label="Dokumen referensi" value={docType} onChange={(v) => { setDocType(v); setError(null); }} options={DOCUMENT_TYPES.map((d) => ({ value: d, label: DOCUMENT_LABEL[d] }))} />
          <div className="grid grid-cols-2 gap-2">
            <Input aria-label="Nomor dokumen" value={docNumber} onChange={(e) => { setDocNumber(e.target.value); setError(null); }} placeholder={docType === "TaxInvoice" ? "16 atau 17 angka" : "Nomor"} />
            <Input aria-label="Tanggal dokumen" type="date" value={docDate} onChange={(e) => { setDocDate(e.target.value); setError(null); }} />
          </div>
          {row.prefill.document === "INVOICE" && <FieldDescription>Nomor dan tanggal dari tagihan yang dilunasi.</FieldDescription>}
        </Field>
        {error && <p role="alert" className="text-sm text-fail">{error}</p>}
      </div>
      <SheetFooter>
        <Button onClick={save} disabled={busy} data-testid="bppu-slip-save">{busy ? "Menyimpan…" : "Simpan bukti potong"}</Button>
      </SheetFooter>
    </div>
  );
}
