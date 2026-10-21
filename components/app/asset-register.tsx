"use client";

import { useState } from "react";
import type { JournalDimensions } from "@/components/app/journal-form";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SimpleSelect } from "@/components/app/simple-select";
import { Money } from "@/components/app/money";
import { StatusPill } from "@/components/app/status";
import { createAssetAction, disposeAssetAction } from "@/app/actions";
import { FISCAL_METHOD_LABEL, TAX_GROUPS, defaultLifeMonths, fiscalMethodAllowed } from "@/lib/assets/fiscal";
import { formatMoney } from "@/lib/money";
import type { AssetCandidateView, AssetRowView, EntityRegisterView, ScheduleLinkView } from "@/lib/assets/view";
import type { AssetTaxGroup, FiscalMethod } from "@/lib/generated/prisma/enums";

type Account = { code: string; name: string };
type Accounts = { asset: Account[]; expense: Account[]; accumulated: Account[]; proceeds: Account[]; gainLoss: Account[] };
type Mode = { kind: "blank" } | { kind: "candidate"; c: AssetCandidateView } | { kind: "schedule"; s: ScheduleLinkView };
type Form = {
  mode: Mode;
  entityId: string;
  name: string;
  taxGroup: AssetTaxGroup;
  fiscalMethod: FiscalMethod;
  acquiredOn: string;
  cost: string;
  residual: string;
  life: string;
  assetAccountCode: string;
  expenseCode: string;
  accumulatedCode: string;
  start: string;
  fromOpening: boolean;
  openingAccumulated: string;
  remainingMonths: string;
  departmentId?: string;
  projectId?: string;
};

const GROUPS = Object.entries(TAX_GROUPS).map(([value, g]) => ({ value, label: g.label }));
const nextMonthOf = (iso: string) => {
  const [y, m] = iso.split("-").map(Number);
  if (!y || !m) return "";
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/** The fixed-asset register of the page's scope, with the forms that register and dispose of an asset (accounting-rules 5b). */
export function AssetRegister(props: {
  clientId: string;
  year: number;
  periodKey: string;
  entities: { id: string; name: string; currency: string }[];
  registers: EntityRegisterView[];
  candidates: AssetCandidateView[];
  schedules: ScheduleLinkView[];
  accounts: Accounts;
  defaultDate: string;
  /** The client's active Departemen & Proyek: its depreciation and disposal gain or loss carry them. */
  dimensions?: JournalDimensions;
}) {
  const router = useRouter();
  const [form, setForm] = useState<Form | null>(null);
  const [disposing, setDisposing] = useState<{ row: AssetRowView; currency: string } | null>(null);
  const [disposal, setDisposal] = useState({ date: props.defaultDate, proceeds: "", proceedsCode: "1140", gainLossCode: "" });
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const code = (list: Account[], wanted: string) => (list.some((a) => a.code === wanted) ? wanted : (list[0]?.code ?? ""));

  const blank = (entityId = props.entities[0]?.id ?? ""): Form => ({
    mode: { kind: "blank" },
    entityId,
    name: "",
    taxGroup: "KELOMPOK_1",
    fiscalMethod: "GARIS_LURUS",
    acquiredOn: props.defaultDate,
    cost: "",
    residual: "",
    life: "48",
    assetAccountCode: code(props.accounts.asset, "1210"),
    expenseCode: code(props.accounts.expense, "6180"),
    accumulatedCode: code(props.accounts.accumulated, "1219"),
    start: nextMonthOf(props.defaultDate),
    fromOpening: false,
    openingAccumulated: "",
    remainingMonths: "",
  });
  const fromCandidate = (c: AssetCandidateView): Form => ({ ...blank(c.entityId), mode: { kind: "candidate", c }, name: c.description.slice(0, 80), acquiredOn: c.dateIso, cost: formatMoney(BigInt(c.amount), c.currency, { bare: true }), assetAccountCode: c.accountCode, start: nextMonthOf(c.dateIso) });
  // The acquisition date is the purchase entry's when the schedule stored it; otherwise the accountant types it (depreciation often
  // starts the month after, so the schedule's start is no acquisition date).
  const fromSchedule = (s: ScheduleLinkView): Form => ({ ...blank(s.entityId), mode: { kind: "schedule", s }, name: s.memo.replace(/^Penyusutan\s+/i, ""), cost: formatMoney(BigInt(s.amount), s.currency, { bare: true }), life: String(s.months), assetAccountCode: s.accountCode ?? code(props.accounts.asset, "1210"), start: s.start, acquiredOn: s.sourceDateIso ?? "" });

  const land = form?.taxGroup === "TANAH";
  const currency = props.entities.find((e) => e.id === form?.entityId)?.currency ?? "IDR";

  const submit = async () => {
    if (!form) return;
    const [sy, sm] = form.start.split("-").map(Number);
    setBusy(true);
    const r = await createAssetAction({
      clientId: props.clientId,
      entityId: form.entityId,
      name: form.name,
      taxGroup: form.taxGroup,
      fiscalMethod: form.fiscalMethod,
      acquiredOn: form.acquiredOn,
      cost: form.cost,
      residual: form.residual,
      usefulLifeMonths: land ? null : Number(form.life),
      openingAccumulated: form.fromOpening ? form.openingAccumulated : "",
      remainingMonths: form.fromOpening ? Number(form.remainingMonths) : null,
      assetAccountCode: form.assetAccountCode,
      expenseCode: form.expenseCode,
      accumulatedCode: form.accumulatedCode,
      startYear: sy,
      startMonth: sm,
      sourceEntryId: form.mode.kind === "candidate" ? form.mode.c.entryId : null,
      scheduleId: form.mode.kind === "schedule" ? form.mode.s.id : null,
      departmentId: form.departmentId || null,
      projectId: form.projectId || null,
    });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(`${form.name} terdaftar`);
    setForm(null);
    router.refresh();
  };

  const dispose = async () => {
    if (!disposing) return;
    setBusy(true);
    const r = await disposeAssetAction({ clientId: props.clientId, assetId: disposing.row.id, date: disposal.date, proceeds: disposal.proceeds || "0", proceedsCode: disposal.proceedsCode, gainLossCode: disposal.gainLossCode || null });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(`Pelepasan ${disposing.row.name} dicatat`);
    setDisposing(null);
    router.refresh();
  };

  const accountSelect = (label: string, value: string, list: Account[], onChange: (v: string) => void, disabled = false) => (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <SimpleSelect label={label} value={value} onChange={onChange} disabled={disabled} options={list.map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }))} placeholder="Pilih akun" />
    </Field>
  );

  return (
    <div className="space-y-4">
      {props.candidates.length > 0 && (
        <Card data-testid="asset-candidates">
          <CardHeader>
            <CardTitle>Pembelian aset belum terdaftar</CardTitle>
            <CardDescription>Debit ke akun aset tetap di buku besar yang belum menjadi aset. Daftarkan agar penyusutannya dijadwalkan; tidak ada yang dicatat otomatis.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y px-0">
            {props.candidates.map((c) => (
              <div key={c.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2.5">
                <div className="min-w-0 flex-1 basis-64">
                  <div className="text-sm font-medium">{c.description}</div>
                  <div className="text-xs text-muted-foreground">{c.entity} · {c.date} · {c.account}</div>
                </div>
                <Money className="text-sm" value={BigInt(c.amount)} currency={c.currency} />
                <Button variant="outline" size="sm" onClick={() => setForm(fromCandidate(c))}>Daftarkan</Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {props.schedules.length > 0 && (
        <Card data-testid="asset-schedules">
          <CardHeader>
            <CardTitle>Jadwal penyusutan tanpa aset</CardTitle>
            <CardDescription>Jadwal yang dibuat di Jurnal Penyesuaian. Jadikan aset agar masuk daftar dan perhitungan fiskal; jadwalnya tetap sama.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y px-0">
            {props.schedules.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2.5">
                <div className="min-w-0 flex-1 basis-64">
                  <div className="text-sm font-medium">{s.memo}</div>
                  <div className="text-xs text-muted-foreground">{s.entity} · {s.months} bulan dari {s.start} · {s.accumulated}</div>
                </div>
                <Money className="text-sm" value={BigInt(s.amount)} currency={s.currency} />
                <Button variant="outline" size="sm" onClick={() => setForm(fromSchedule(s))}>Jadikan aset</Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => setForm(blank())}><Plus /> Tambah aset</Button>
      </div>

      {props.registers.length === 0 && (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">Belum ada aset tetap terdaftar untuk cakupan ini.</CardContent></Card>
      )}

      {props.registers.map((reg) => {
        const cur = reg.entity.currency;
        // Every booked figure drills to the asset's page: the purchase or Saldo Awal, each posted installment and the disposal, each
        // linked to its ledger month (a single account or month can't explain a book value or a year's depreciation). The fiscal
        // figures are an estimate.
        const drill = (id: string, node: React.ReactNode, label: string) => <Link href={`/clients/${props.clientId}/assets/${id}?period=${props.periodKey}&entity=${reg.entity.id}`} aria-label={label} className="underline-offset-2 hover:text-primary hover:underline">{node}</Link>;
        const fiscal = reg.totals.fiscalYtd !== null;
        return (
          <Card key={reg.entity.id} data-testid={`register-${reg.entity.shortName}`}>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
              <div className="space-y-1.5">
                <CardTitle>Daftar Aset Tetap · {reg.entity.name}</CardTitle>
                <CardDescription>Akumulasi penyusutan dari jurnal yang sudah dicatat. Penyusutan fiskal adalah estimasi untuk koreksi fiskal, tidak dijurnal.</CardDescription>
              </div>
              {reg.ledger && <StatusPill status={reg.ledger.equal ? "PASS" : "REVIEW"} label={reg.ledger.equal ? "Cocok dengan buku besar" : "Beda dengan buku besar"} />}
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Aset</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Harga perolehan</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Akum. penyusutan</TableHead>
                    <TableHead className="text-right">Nilai buku</TableHead>
                    <TableHead className="hidden text-right lg:table-cell">Penyusutan {props.year}</TableHead>
                    {fiscal && <TableHead className="hidden text-right lg:table-cell">Fiskal {props.year} (estimasi)</TableHead>}
                    {fiscal && <TableHead className="hidden text-right lg:table-cell">Koreksi fiskal</TableHead>}
                    <TableHead className="w-24 pr-6"><span className="sr-only">Aksi</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reg.rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="pl-6 whitespace-normal">
                        <Link href={`/clients/${props.clientId}/assets/${r.id}?period=${props.periodKey}&entity=${reg.entity.id}`} className="inline-flex items-center gap-1 font-medium hover:text-primary">{r.name} <ChevronRight className="size-3.5" aria-hidden /></Link>
                        <div className="text-xs text-muted-foreground">
                          {r.groupLabel}{r.methodLabel !== "–" ? ` · fiskal ${r.methodLabel.toLowerCase()}` : ""} · diperoleh {r.acquired}{r.lifeMonths ? ` · ${r.lifeMonths} bulan` : ""}
                        </div>
                        {r.disposed && <div className="text-xs text-muted-foreground">Dilepas {r.disposed}{r.proceeds && r.proceeds !== "0" ? `, hasil ${formatMoney(BigInt(r.proceeds), cur)}` : ", dihapuskan"}</div>}
                        {r.unposted > 0 && (
                          <Link href={`/clients/${props.clientId}/journals/new?period=${props.periodKey}`} className="text-xs text-review underline-offset-2 hover:underline">
                            {r.unposted} penyusutan belum dicatat
                          </Link>
                        )}
                      </TableCell>
                      <TableCell className="hidden text-right md:table-cell">{drill(r.id, <Money value={BigInt(r.cost)} currency={cur} />, `Harga perolehan ${r.name}`)}</TableCell>
                      <TableCell className="hidden text-right md:table-cell">{drill(r.id, <Money value={-BigInt(r.accumulated)} currency={cur} />, `Akumulasi penyusutan ${r.name}`)}</TableCell>
                      <TableCell className="text-right">{drill(r.id, <Money value={BigInt(r.bookValue)} currency={cur} />, `Nilai buku ${r.name}`)}</TableCell>
                      <TableCell className="hidden text-right lg:table-cell">{drill(r.id, <Money value={BigInt(r.bookYtd)} currency={cur} />, `Penyusutan tahun ini ${r.name}`)}</TableCell>
                      {fiscal && <TableCell className="hidden text-right lg:table-cell"><Money value={BigInt(r.fiscalYtd ?? "0")} currency={cur} /></TableCell>}
                      {fiscal && <TableCell className="hidden text-right lg:table-cell"><Money value={BigInt(r.difference ?? "0")} currency={cur} /></TableCell>}
                      <TableCell className="pr-6 text-right">
                        {!r.disposed && <Button variant="ghost" size="sm" onClick={() => { setDisposal({ date: props.defaultDate, proceeds: "", proceedsCode: props.accounts.proceeds.some((a) => a.code === "1140") ? "1140" : (props.accounts.proceeds[0]?.code ?? ""), gainLossCode: "" }); setDisposing({ row: r, currency: cur }); }}>Lepas</Button>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell className="pl-6 font-medium">Jumlah</TableCell>
                    <TableCell className="hidden text-right md:table-cell"><Money strong value={BigInt(reg.totals.cost)} currency={cur} /></TableCell>
                    <TableCell className="hidden text-right md:table-cell"><Money strong value={-BigInt(reg.totals.accumulated)} currency={cur} /></TableCell>
                    <TableCell className="text-right"><Money strong value={BigInt(reg.totals.bookValue)} currency={cur} /></TableCell>
                    <TableCell className="hidden text-right lg:table-cell"><Money strong value={BigInt(reg.totals.bookYtd)} currency={cur} /></TableCell>
                    {fiscal && <TableCell className="hidden text-right lg:table-cell"><Money strong value={BigInt(reg.totals.fiscalYtd ?? "0")} currency={cur} /></TableCell>}
                    {fiscal && <TableCell className="hidden text-right lg:table-cell"><Money strong value={BigInt(reg.totals.difference ?? "0")} currency={cur} /></TableCell>}
                    <TableCell className="pr-6" />
                  </TableRow>
                  {reg.ledger && (
                    <TableRow data-testid="register-ledger">
                      <TableCell className="pl-6 text-muted-foreground whitespace-normal">Buku besar ({[...reg.ledger.assetAccounts, ...reg.ledger.accumulatedAccounts].join(", ")})</TableCell>
                      <TableCell className="hidden text-right md:table-cell"><Money muted value={BigInt(reg.ledger.cost)} currency={cur} /></TableCell>
                      <TableCell className="hidden text-right md:table-cell"><Money muted value={-BigInt(reg.ledger.accumulated)} currency={cur} /></TableCell>
                      <TableCell className="text-right"><Money muted value={BigInt(reg.ledger.cost) - BigInt(reg.ledger.accumulated)} currency={cur} /></TableCell>
                      <TableCell className="hidden lg:table-cell" colSpan={fiscal ? 3 : 1} />
                      <TableCell className="pr-6" />
                    </TableRow>
                  )}
                </TableFooter>
              </Table>
              {fiscal && <p className="px-6 pt-3 text-xs text-muted-foreground">Koreksi fiskal = penyusutan buku − penyusutan fiskal tahun ini; positif ditambahkan ke laba fiskal. Kelompok dan tarif menurut PMK 72/2023.</p>}
            </CardContent>
          </Card>
        );
      })}

      <Dialog open={form !== null} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{form?.mode.kind === "schedule" ? "Jadikan aset" : "Daftarkan aset tetap"}</DialogTitle>
            <DialogDescription>
              {form?.mode.kind === "schedule"
                ? "Jadwal penyusutannya tetap; aset masuk daftar dan perhitungan fiskal."
                : "Penyusutan buku dijadwalkan garis lurus dan diusulkan tiap bulan di Jurnal Penyesuaian; dicatat setelah Anda klik."}
            </DialogDescription>
          </DialogHeader>
          {form && (
            <div className="grid gap-4 sm:grid-cols-2">
              {props.entities.length > 1 && (
                <Field className="sm:col-span-2">
                  <FieldLabel>Entitas</FieldLabel>
                  <SimpleSelect label="Entitas" value={form.entityId} disabled={form.mode.kind !== "blank"} onChange={(v) => set({ entityId: v })} options={props.entities.map((e) => ({ value: e.id, label: e.name }))} />
                </Field>
              )}
              <Field className="sm:col-span-2">
                <FieldLabel htmlFor="asset-name">Nama aset</FieldLabel>
                <Input id="asset-name" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="mis. Mobil box Grand Max" />
              </Field>
              <Field>
                <FieldLabel>Kelompok fiskal</FieldLabel>
                <SimpleSelect
                  label="Kelompok fiskal"
                  value={form.taxGroup}
                  onChange={(v) => {
                    const g = v as AssetTaxGroup;
                    const life = defaultLifeMonths(g);
                    set({ taxGroup: g, fiscalMethod: fiscalMethodAllowed(g, form.fiscalMethod) ? form.fiscalMethod : "GARIS_LURUS", life: form.mode.kind === "schedule" ? form.life : life ? String(life) : "" });
                  }}
                  options={GROUPS}
                />
              </Field>
              <Field>
                <FieldLabel>Metode fiskal</FieldLabel>
                <SimpleSelect
                  label="Metode fiskal"
                  value={form.fiscalMethod}
                  disabled={land || !fiscalMethodAllowed(form.taxGroup, "SALDO_MENURUN")}
                  onChange={(v) => set({ fiscalMethod: v as FiscalMethod })}
                  options={(Object.keys(FISCAL_METHOD_LABEL) as FiscalMethod[]).map((m) => ({ value: m, label: FISCAL_METHOD_LABEL[m] }))}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="asset-date">Tanggal perolehan</FieldLabel>
                <Input id="asset-date" type="date" value={form.acquiredOn} disabled={form.mode.kind === "candidate"} onChange={(e) => set({ acquiredOn: e.target.value, start: form.mode.kind === "schedule" ? form.start : nextMonthOf(e.target.value) })} />
                {form.mode.kind === "schedule" && !form.mode.s.sourceDateIso && <FieldDescription>Jadwal ini tidak menyimpan pembeliannya: isi tanggal perolehan dari dokumennya.</FieldDescription>}
              </Field>
              <Field>
                <FieldLabel htmlFor="asset-cost">Harga perolehan{currency === "IDR" ? "" : ` (${currency})`}</FieldLabel>
                <Input id="asset-cost" inputMode="decimal" className="num text-right" value={form.cost} disabled={form.mode.kind === "candidate"} onChange={(e) => set({ cost: e.target.value })} />
              </Field>
              {accountSelect("Akun aset", form.assetAccountCode, props.accounts.asset, (v) => set({ assetAccountCode: v }), form.mode.kind === "candidate")}
              {!land && (
                <>
                  <Field>
                    <FieldLabel htmlFor="asset-residual">Nilai sisa (opsional)</FieldLabel>
                    <Input id="asset-residual" inputMode="decimal" className="num text-right" value={form.residual} onChange={(e) => set({ residual: e.target.value })} placeholder="0" />
                  </Field>
                  {form.mode.kind !== "schedule" && accountSelect("Akun beban penyusutan", form.expenseCode, props.accounts.expense, (v) => set({ expenseCode: v }))}
                  {form.mode.kind !== "schedule" && accountSelect("Akun akumulasi penyusutan", form.accumulatedCode, props.accounts.accumulated, (v) => set({ accumulatedCode: v }))}
                  <Field>
                    <FieldLabel htmlFor="asset-life">Masa manfaat buku (bulan)</FieldLabel>
                    <Input id="asset-life" type="number" min={1} max={600} className="num" value={form.life} onChange={(e) => set({ life: e.target.value })} />
                    <FieldDescription>Estimasi entitas (PSAK 216); saran dari kelompok fiskal.</FieldDescription>
                  </Field>
                  {form.mode.kind !== "schedule" && props.dimensions?.departments.length ? (
                    <Field>
                      <FieldLabel>Departemen</FieldLabel>
                      <SimpleSelect label="Departemen" value={form.departmentId ?? ""} onChange={(v) => set({ departmentId: v })} options={[{ value: "", label: "Tanpa departemen" }, ...props.dimensions.departments.map((d) => ({ value: d.id, label: `${d.code} · ${d.name}` }))]} />
                    </Field>
                  ) : null}
                  {form.mode.kind !== "schedule" && props.dimensions?.projects.length ? (
                    <Field>
                      <FieldLabel>Proyek</FieldLabel>
                      <SimpleSelect label="Proyek" value={form.projectId ?? ""} onChange={(v) => set({ projectId: v })} options={[{ value: "", label: "Tanpa proyek" }, ...props.dimensions.projects.map((d) => ({ value: d.id, label: `${d.code} · ${d.name}` }))]} />
                    </Field>
                  ) : null}
                  {form.mode.kind !== "schedule" && (
                    <Field>
                      <FieldLabel htmlFor="asset-start">Mulai disusutkan</FieldLabel>
                      <Input id="asset-start" type="month" value={form.start} onChange={(e) => set({ start: e.target.value })} />
                    </Field>
                  )}
                  {form.mode.kind === "blank" && (
                    <div className="space-y-3 sm:col-span-2">
                      <div className="flex items-center gap-2 text-sm">
                        <Checkbox id="asset-opening" checked={form.fromOpening} onCheckedChange={(v) => set({ fromOpening: v === true })} />
                        <label htmlFor="asset-opening">Aset dari Saldo Awal (sudah disusutkan sebagian)</label>
                      </div>
                      {form.fromOpening && (
                        <div className="grid gap-4 sm:grid-cols-2">
                          <Field>
                            <FieldLabel htmlFor="asset-opening-acc">Akumulasi penyusutan di Saldo Awal</FieldLabel>
                            <Input id="asset-opening-acc" inputMode="decimal" className="num text-right" value={form.openingAccumulated} onChange={(e) => set({ openingAccumulated: e.target.value })} />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="asset-remaining">Sisa masa manfaat (bulan)</FieldLabel>
                            <Input id="asset-remaining" type="number" min={1} max={600} className="num" value={form.remainingMonths} onChange={(e) => set({ remainingMonths: e.target.value })} />
                          </Field>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
              {land && <p className="text-sm text-muted-foreground sm:col-span-2">Tanah tidak disusutkan, baik buku maupun fiskal.</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>Batal</Button>
            <Button disabled={busy || !form?.name.trim() || !form?.cost || !form?.acquiredOn || !form?.assetAccountCode} onClick={submit}>{busy ? "Menyimpan…" : "Simpan aset"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={disposing !== null} onOpenChange={(o) => !o && setDisposing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Lepas {disposing?.row.name}</DialogTitle>
            <DialogDescription>
              Satu jurnal: akumulasi penyusutan dan harga perolehan dihapus, hasil penjualan dicatat, selisihnya laba atau rugi pelepasan. Penyusutan sampai bulan pelepasan harus sudah dicatat. Nilai buku saat ini {disposing ? formatMoney(BigInt(disposing.row.bookValue), disposing.currency) : ""}.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="disposal-date">Tanggal pelepasan</FieldLabel>
              <Input id="disposal-date" type="date" value={disposal.date} onChange={(e) => setDisposal({ ...disposal, date: e.target.value })} />
            </Field>
            <Field>
              <FieldLabel htmlFor="disposal-proceeds">Hasil penjualan</FieldLabel>
              <Input id="disposal-proceeds" inputMode="decimal" className="num text-right" value={disposal.proceeds} onChange={(e) => setDisposal({ ...disposal, proceeds: e.target.value })} placeholder="0" />
              <FieldDescription>Kosongkan bila dihapuskan tanpa hasil.</FieldDescription>
            </Field>
            {accountSelect("Akun penerimaan", disposal.proceedsCode, props.accounts.proceeds, (v) => setDisposal({ ...disposal, proceedsCode: v }))}
            <Field>
              <FieldLabel>Akun laba/rugi pelepasan</FieldLabel>
              <SimpleSelect label="Akun laba/rugi pelepasan" value={disposal.gainLossCode} onChange={(v) => setDisposal({ ...disposal, gainLossCode: v })} options={[{ value: "", label: "7300 Laba/Rugi Pelepasan Aset Tetap" }, ...props.accounts.gainLoss.filter((a) => a.code !== "7300").map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }))]} />
            </Field>
            <p className="text-xs text-muted-foreground sm:col-span-2">Uang yang masuk di rekening koran diklasifikasikan ke akun penerimaan yang sama saat review.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisposing(null)}>Batal</Button>
            <Button disabled={busy || !disposal.date || !disposal.proceedsCode} onClick={dispose}>{busy ? "Mencatat…" : "Catat pelepasan"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
