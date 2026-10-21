"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/app/money";
import { originOf, sourceFor, type FormOrigin } from "@/lib/adjust/form";
import { createScheduleAction, setScheduleTagsAction, stopScheduleAction } from "@/app/actions";
import { SimpleSelect } from "@/components/app/simple-select";
import type { JournalDimensions } from "@/components/app/journal-form";
import { formatMoney, parseMoney } from "@/lib/money";
import type { CandidateView, ScheduleView } from "@/lib/adjust/view";
import type { AccountType } from "@/lib/generated/prisma/enums";

type Kind = "DEPRECIATION" | "AMORTIZATION" | "ACCRUAL";
const KINDS: { kind: Kind; label: string; debit: string; credit: string; months: number; memo: string }[] = [
  { kind: "DEPRECIATION", label: "Penyusutan", debit: "6180", credit: "1219", months: 48, memo: "Penyusutan " },
  { kind: "AMORTIZATION", label: "Amortisasi", debit: "", credit: "1170", months: 12, memo: "Amortisasi " },
  { kind: "ACCRUAL", label: "Akrual", debit: "", credit: "2150", months: 1, memo: "Akrual " },
];
type Form = { kind: Kind; entityId: string; memo: string; debitCode: string; creditCode: string; amount: string; months: string; start: string; origin: FormOrigin; departmentId?: string; projectId?: string };

const STATUS_LABEL = { BERJALAN: "Berjalan", SELESAI: "Selesai", DIHENTIKAN: "Dihentikan" } as const;

/** Candidates from the ledger, the client's schedules, and the form that creates one (nothing posts from here). */
export function SchedulePanel(props: { clientId: string; entities: { id: string; name: string; currency: string }[]; accounts: { code: string; name: string; type: AccountType; fsLine: string }[]; candidates: CandidateView[]; schedules: ScheduleView[]; nextMonth: string; /** The client's active Departemen & Proyek. */ dimensions?: JournalDimensions }) {
  const router = useRouter();
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState<ScheduleView | null>(null);
  const [tagging, setTagging] = useState<{ s: ScheduleView; departmentId: string; projectId: string } | null>(null);
  const departments = props.dimensions?.departments ?? [];
  const projects = props.dimensions?.projects ?? [];
  const tagOptions = (list: { id: string; code: string; name: string }[], none: string) => [{ value: "", label: none }, ...list.map((d) => ({ value: d.id, label: `${d.code} · ${d.name}` }))];
  const saveTags = async () => {
    if (!tagging) return;
    setBusy(true);
    const r = await setScheduleTagsAction({ clientId: props.clientId, scheduleId: tagging.s.id, departmentId: tagging.departmentId || null, projectId: tagging.projectId || null });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success("Departemen & proyek jadwal disimpan", { description: "Berlaku untuk angsuran berikutnya" });
    setTagging(null);
    router.refresh();
  };
  const blank = (): Form => ({ kind: "DEPRECIATION", entityId: props.entities[0]?.id ?? "", memo: KINDS[0].memo, debitCode: KINDS[0].debit, creditCode: KINDS[0].credit, amount: "", months: String(KINDS[0].months), start: props.nextMonth, origin: null });
  const fromCandidate = (c: CandidateView): Form => ({ kind: c.kind, entityId: c.entityId, memo: c.memo, debitCode: c.debitCode ?? "", creditCode: c.creditCode, amount: c.amount, months: String(c.months), start: c.start, origin: originOf(c) });
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const currency = props.entities.find((e) => e.id === form?.entityId)?.currency ?? "IDR";
  const months = form?.kind === "ACCRUAL" ? 1 : Number(form?.months || 0);
  let perMonth = "";
  let amountError = "";
  try {
    const total = form?.amount ? parseMoney(form.amount, currency) : 0n;
    if (total > 0n && months >= 1) perMonth = formatMoney(total / BigInt(Math.trunc(months)), currency);
  } catch (e) {
    amountError = (e as Error).message;
  }

  const submit = async () => {
    if (!form) return;
    const [y, m] = form.start.split("-").map(Number);
    setBusy(true);
    const r = await createScheduleAction({ clientId: props.clientId, entityId: form.entityId, kind: form.kind, memo: form.memo, debitCode: form.debitCode, creditCode: form.creditCode, amount: form.amount, months, startYear: y, startMonth: m, departmentId: form.departmentId || null, projectId: form.projectId || null, ...sourceFor(form.origin, form, props.accounts) });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success("Jadwal dibuat");
    setForm(null);
    router.refresh();
  };

  const accountSelect = (label: string, value: string, onChange: (v: string) => void) => (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select value={value} onValueChange={(v) => onChange(v as string)}>
        <SelectTrigger className="w-full" aria-label={label}><SelectValue placeholder="Pilih akun" /></SelectTrigger>
        <SelectContent>{props.accounts.map((a) => <SelectItem key={a.code} value={a.code}>{a.code} {a.name}</SelectItem>)}</SelectContent>
      </Select>
    </Field>
  );

  return (
    <div className="space-y-4">
      {props.candidates.length > 0 && (
        <Card data-testid="schedule-candidates">
          <CardHeader>
            <CardTitle>Kandidat dari buku besar</CardTitle>
            <CardDescription>Pembelian aset, pembayaran di muka dan beban rutin yang belum tercatat bulan ini. Buat jadwal bila perlu; tidak ada yang dicatat otomatis.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y px-0">
            {props.candidates.map((c) => (
              <div key={c.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2.5">
                <div className="min-w-0 flex-1 basis-64">
                  <div className="text-sm font-medium">{c.kindLabel} · {c.entity}</div>
                  <div className="text-xs text-muted-foreground">{c.reason}</div>
                </div>
                <Money className="text-sm" value={BigInt(c.amountMinor)} currency={c.currency} />
                <Button variant="outline" size="sm" onClick={() => setForm(fromCandidate(c))}>Buat jadwal</Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card data-testid="schedules">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle>Jadwal penyesuaian</CardTitle>
            <CardDescription>Penyusutan, amortisasi dan akrual yang diusulkan tiap bulan.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setForm(blank())}><Plus /> Buat jadwal</Button>
        </CardHeader>
        <CardContent>
          {props.schedules.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada jadwal untuk klien ini.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="p-2 pl-3 text-left font-medium">Jadwal</TableHead>
                    <TableHead className="hidden p-2 text-left font-medium md:table-cell">Debit / kredit</TableHead>
                    <TableHead className="hidden p-2 text-right font-medium sm:table-cell">Per bulan</TableHead>
                    <TableHead className="p-2 text-right font-medium">Tercatat</TableHead>
                    <TableHead className="hidden p-2 text-right font-medium sm:table-cell">Sisa</TableHead>
                    <TableHead className="p-2 pr-3 text-right font-medium"><span className="sr-only">Aksi</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {props.schedules.map((s) => (
                    <TableRow key={s.id} className="border-t">
                      <TableCell className="p-2 pl-3 whitespace-normal">
                        <div className="font-medium">{s.memo}</div>
                        <div className="text-xs text-muted-foreground">{s.kindLabel} · {s.entity} · {s.span} · {STATUS_LABEL[s.status]}{s.source ? ` · dari ${s.source}` : ""}{s.tags ? <span className="num" data-testid="schedule-tags"> · {s.tags}</span> : null}</div>
                      </TableCell>
                      <TableCell className="hidden p-2 text-xs text-muted-foreground md:table-cell">{s.debit}<br />{s.credit}</TableCell>
                      <TableCell className="hidden p-2 text-right sm:table-cell"><Money value={BigInt(s.perMonth)} currency={s.currency} /></TableCell>
                      <TableCell className="num p-2 text-right">{s.postedCount}/{s.months}</TableCell>
                      <TableCell className="hidden p-2 text-right sm:table-cell"><Money value={BigInt(s.remaining)} currency={s.currency} /></TableCell>
                      <TableCell className="p-2 pr-3 text-right">
                        {s.status === "BERJALAN" && (departments.length > 0 || projects.length > 0) && (
                          <Button variant="ghost" size="sm" aria-label={`Departemen & proyek ${s.memo}`} onClick={() => setTagging({ s, departmentId: s.departmentId ?? "", projectId: s.projectId ?? "" })}>Departemen</Button>
                        )}
                        {s.status === "BERJALAN" && <Button variant="ghost" size="sm" onClick={() => setStopping(s)}>Hentikan</Button>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={form !== null} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Buat jadwal penyesuaian</DialogTitle>
            <DialogDescription>Angsuran tiap bulan diusulkan di Jurnal Penyesuaian dan Tutup Buku, lalu dicatat setelah Anda klik. Jadwal tidak bisa diubah setelah angsuran pertama; hentikan dan buat baru.</DialogDescription>
          </DialogHeader>
          {form && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Jenis</FieldLabel>
                <Select value={form.kind} onValueChange={(v) => { const k = KINDS.find((x) => x.kind === v)!; set({ kind: k.kind, debitCode: k.debit || form.debitCode, creditCode: k.credit, months: String(k.months), memo: form.memo.trim() && !KINDS.some((x) => x.memo === form.memo) ? form.memo : k.memo }); }}>
                  <SelectTrigger className="w-full" aria-label="Jenis"><SelectValue /></SelectTrigger>
                  <SelectContent>{KINDS.map((k) => <SelectItem key={k.kind} value={k.kind}>{k.label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Entitas</FieldLabel>
                <Select value={form.entityId} onValueChange={(v) => set({ entityId: v as string })}>
                  <SelectTrigger className="w-full" aria-label="Entitas"><SelectValue /></SelectTrigger>
                  <SelectContent>{props.entities.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field className="sm:col-span-2">
                <FieldLabel>Keterangan</FieldLabel>
                <Input aria-label="Keterangan jadwal" value={form.memo} onChange={(e) => set({ memo: e.target.value })} placeholder="mis. Penyusutan mesin pakan" />
              </Field>
              {accountSelect("Akun debit", form.debitCode, (v) => set({ debitCode: v }))}
              {accountSelect("Akun kredit", form.creditCode, (v) => set({ creditCode: v }))}
              <Field>
                <FieldLabel>Total{currency === "IDR" ? "" : ` (${currency})`}</FieldLabel>
                <Input aria-label="Total jadwal" aria-invalid={!!amountError || undefined} inputMode="decimal" className="num text-right" value={form.amount} onChange={(e) => set({ amount: e.target.value })} placeholder={formatMoney(0n, currency, { bare: true })} />
              </Field>
              <div className="grid grid-cols-[6rem_1fr] gap-4">
                {form.kind !== "ACCRUAL" && (
                  <Field>
                    <FieldLabel>Bulan</FieldLabel>
                    <Input aria-label="Jumlah bulan" type="number" min={1} max={600} className="num" value={form.months} onChange={(e) => set({ months: e.target.value })} />
                  </Field>
                )}
                <Field className={form.kind === "ACCRUAL" ? "col-span-2" : ""}>
                  <FieldLabel>Mulai</FieldLabel>
                  <Input aria-label="Bulan mulai" type="month" value={form.start} onChange={(e) => set({ start: e.target.value })} />
                </Field>
              </div>
              {departments.length > 0 && (
                <Field>
                  <FieldLabel>Departemen</FieldLabel>
                  <SimpleSelect label="Departemen" value={form.departmentId ?? ""} onChange={(v) => set({ departmentId: v })} options={tagOptions(departments, "Tanpa departemen")} />
                </Field>
              )}
              {projects.length > 0 && (
                <Field>
                  <FieldLabel>Proyek</FieldLabel>
                  <SimpleSelect label="Proyek" value={form.projectId ?? ""} onChange={(v) => set({ projectId: v })} options={tagOptions(projects, "Tanpa proyek")} />
                </Field>
              )}
              <p className="text-sm text-muted-foreground sm:col-span-2">
                {amountError ? <span className="text-destructive">{amountError}</span> : perMonth ? (form.kind === "ACCRUAL" ? `Akrual ${perMonth}, dibalik tanggal 1 bulan berikutnya.` : `± ${perMonth} per bulan selama ${months} bulan; sisa pembulatan di angsuran terakhir.`) : "Isi total dan jumlah bulan."}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>Batal</Button>
            <Button disabled={busy || !form?.debitCode || !form?.creditCode || !perMonth || !form?.start} onClick={submit}>{busy ? "Menyimpan…" : "Simpan jadwal"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={tagging !== null} onOpenChange={(o) => !o && setTagging(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Departemen & proyek jadwal</DialogTitle>
            <DialogDescription>Berlaku untuk angsuran berikutnya; angsuran yang sudah dicatat tidak berubah. Hanya sisi pendapatan atau beban yang diberi label.</DialogDescription>
          </DialogHeader>
          {tagging && (
            <div className="grid gap-4 sm:grid-cols-2">
              {departments.length > 0 && (
                <Field>
                  <FieldLabel>Departemen</FieldLabel>
                  <SimpleSelect label="Departemen jadwal" value={tagging.departmentId} onChange={(v) => setTagging({ ...tagging, departmentId: v })} options={tagOptions(departments, "Tanpa departemen")} />
                </Field>
              )}
              {projects.length > 0 && (
                <Field>
                  <FieldLabel>Proyek</FieldLabel>
                  <SimpleSelect label="Proyek jadwal" value={tagging.projectId} onChange={(v) => setTagging({ ...tagging, projectId: v })} options={tagOptions(projects, "Tanpa proyek")} />
                </Field>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTagging(null)}>Batal</Button>
            <Button disabled={busy} onClick={saveTags}>{busy ? "Menyimpan…" : "Simpan"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={stopping !== null} onOpenChange={(o) => !o && setStopping(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hentikan {stopping?.memo}?</DialogTitle>
            <DialogDescription>Angsuran setelah bulan ini tidak diusulkan lagi. Angsuran yang sudah jatuh tempo sampai bulan ini tetap diusulkan sampai dicatat. Yang sudah dicatat tetap di buku besar; koreksi dengan jurnal penyesuaian bila perlu.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStopping(null)}>Batal</Button>
            <Button
              disabled={busy}
              onClick={async () => {
                if (!stopping) return;
                setBusy(true);
                const r = await stopScheduleAction(props.clientId, stopping.id);
                setBusy(false);
                if (!r.ok) return void toast.error(r.error);
                toast.success("Jadwal dihentikan");
                setStopping(null);
                router.refresh();
              }}
            >
              Hentikan jadwal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
