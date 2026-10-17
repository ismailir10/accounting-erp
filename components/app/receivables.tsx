"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bell, ChevronDown, ChevronRight, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReceivablesTabs } from "@/components/app/receivables-tabs";
import { SimpleSelect } from "@/components/app/simple-select";
import { Money } from "@/components/app/money";
import { StatusPill } from "@/components/app/status";
import { useAccess } from "@/components/app/access-context";
import { CreditLimitDialog, ReminderDialog, type ReminderTarget } from "@/components/app/receivable-reminder";
import { createInvoiceAction, settleAction, settleCandidatesAction, settleFifoAction, tagAdvanceAction, unsettleAction, voidInvoiceAction } from "@/app/actions";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BUCKETS, BUCKET_LABEL } from "@/lib/receivables/aging";
import { formatMoney, parseMoney, PPN_EFFECTIVE_PERCENT } from "@/lib/money";
import { RECEIPT_KINDS, WITHHOLDING_KINDS, WITHHOLDING_LABEL, withholdingFor } from "@/lib/tax/withholding";
import type { WithholdingKind } from "@/lib/generated/prisma/enums";
import type { AgingView, CandidateView, ComparisonView, InvoiceView, UnsettledLineView, VoidedView } from "@/lib/receivables/view";

type Account = { code: string; name: string };
type Direction = "SALES" | "PURCHASE";
type InvoiceForm = { entityId: string; contactName: string; number: string; issueDate: string; dueDate: string; description: string; dpp: string; ppn: string; counterCode: string; arApCode: string; opening: boolean; whtKind: string; whtRate: string; whtAmount: string };

const WORDS = {
  SALES: { party: "Pelanggan", doc: "Faktur", docLower: "faktur", newDoc: "Faktur baru", counter: "Akun pendapatan", arAp: "Akun piutang", money: "penerimaan", lines: "Penerimaan di akun piutang belum dicocokkan" },
  PURCHASE: { party: "Pemasok", doc: "Tagihan", docLower: "tagihan", newDoc: "Tagihan baru", counter: "Akun beban / aset", arAp: "Akun utang", money: "pembayaran", lines: "Pembayaran di akun utang belum dicocokkan" },
} as const;

/** Receivables or payables of the page's scope: aging, invoices with their settlements, and the forms (accounting-rules 5c). */
export function Receivables(props: {
  clientId: string;
  direction: Direction;
  entities: { id: string; name: string; currency: string }[];
  invoices: InvoiceView[];
  voided: VoidedView[];
  aging: AgingView[];
  comparison: ComparisonView[];
  unsettled: UnsettledLineView[];
  contacts: string[];
  contactOptions: { id: string; name: string }[];
  accounts: { counter: Account[]; arAp: Account[] };
  defaultDate: string;
  /** Piutang only (cycle 2026-10-17-pengingat-piutang): the reminder text per `entityId:contactId` with an overdue invoice on the date. */
  reminders?: Record<string, string>;
  reminder?: { date: string; monthOpen: boolean; periodKey: string };
}) {
  const router = useRouter();
  const { canWrite } = useAccess();
  const w = WORDS[props.direction];
  const [limitFor, setLimitFor] = useState<{ id: string; name: string; limit: string | null } | null>(null);
  const [reminding, setReminding] = useState<ReminderTarget | null>(null);
  const reminders = props.direction === "SALES" ? (props.reminders ?? {}) : {};
  const [form, setForm] = useState<InvoiceForm | null>(null);
  const [matching, setMatching] = useState<{ invoice: InvoiceView; candidates: CandidateView[] | null } | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  // Tax withheld per candidate (major units, "" = none) and the tax's kind for the dialog (the invoice's own, else chosen here).
  const [withheld, setWithheld] = useState<Record<string, string>>({});
  const [settleKind, setSettleKind] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState<InvoiceView | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const set = (patch: Partial<InvoiceForm>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const currency = props.entities.find((e) => e.id === form?.entityId)?.currency ?? "IDR";

  const blank = (): InvoiceForm => ({
    entityId: props.entities[0]?.id ?? "",
    contactName: "",
    number: "",
    issueDate: props.defaultDate,
    dueDate: "",
    description: "",
    dpp: "",
    ppn: "",
    counterCode: props.accounts.counter.find((a) => a.code === (props.direction === "SALES" ? "4100" : "6190"))?.code ?? props.accounts.counter[0]?.code ?? "",
    arApCode: props.accounts.arAp[0]?.code ?? "",
    opening: false,
    whtKind: "",
    whtRate: "",
    whtAmount: "",
  });

  let total = "";
  let amountError = "";
  try {
    const dpp = form?.dpp ? parseMoney(form.dpp, currency) : 0n;
    const ppn = form?.ppn ? parseMoney(form.ppn, currency) : 0n;
    if (dpp + ppn > 0n) total = formatMoney(dpp + ppn, currency);
  } catch (e) {
    amountError = (e as Error).message;
  }
  let whtHint = "";
  if (form?.whtKind && !form.whtAmount.trim() && form.whtRate.trim()) {
    try {
      whtHint = `= ${formatMoney(withholdingFor(parseMoney(form.dpp, currency), form.whtRate), currency)} dari DPP`;
    } catch (e) {
      whtHint = (e as Error).message;
    }
  }
  const whtKinds = props.direction === "SALES" ? RECEIPT_KINDS : WITHHOLDING_KINDS;
  const ppnFromDpp = () => {
    try {
      const dpp = parseMoney(form?.dpp ?? "", currency);
      set({ ppn: formatMoney((2n * dpp * PPN_EFFECTIVE_PERCENT + 100n) / 200n, currency, { bare: true }) });
    } catch {
      toast.error("Isi DPP dulu.");
    }
  };

  const submit = async () => {
    if (!form) return;
    setBusy(true);
    const { whtKind, whtRate, whtAmount, ...rest } = form;
    const r = await createInvoiceAction({ clientId: props.clientId, direction: props.direction, ...rest, dueDate: form.dueDate || null, ppn: form.ppn || null, ...(whtKind ? { whtKind: whtKind as WithholdingKind, whtRate: whtRate || null, whtAmount: whtAmount || null } : {}) });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(`${w.doc} ${form.number} dicatat`);
    setForm(null);
    router.refresh();
  };

  const openMatching = async (invoice: InvoiceView) => {
    setMatching({ invoice, candidates: null });
    setSettleKind(invoice.whtKind ?? "");
    const r = await settleCandidatesAction(props.clientId, invoice.id);
    if (!r.ok) return void toast.error(r.error);
    const open = BigInt(invoice.open);
    const expected = BigInt(invoice.whtExpected);
    const amountOf = (c: CandidateView) => (BigInt(c.free) < open ? BigInt(c.free) : open);
    setAmounts(Object.fromEntries(r.candidates.map((c) => [c.bankTransactionId, formatMoney(amountOf(c), invoice.currency, { bare: true })])));
    // A receipt short of the invoice by no more than the expected tax is that tax (the server applies the same rule).
    setWithheld(Object.fromEntries(r.candidates.flatMap((c) => { const short = open - amountOf(c); return short > 0n && short <= expected ? [[c.bankTransactionId, formatMoney(short, invoice.currency, { bare: true })]] : []; })));
    setMatching({ invoice, candidates: r.candidates });
  };

  const doSettle = async (c: CandidateView) => {
    if (!matching) return;
    setBusy(true);
    const r = await settleAction({ clientId: props.clientId, invoiceId: matching.invoice.id, bankTransactionId: c.bankTransactionId, amount: amounts[c.bankTransactionId] || null, ...(settleKind ? { whtKind: settleKind as WithholdingKind, withheld: withheld[c.bankTransactionId] || "0" } : { withheld: "0" }) });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(`${matching.invoice.number} dicocokkan dengan ${w.money} ${c.date}`);
    setMatching(null);
    router.refresh();
  };

  const doUnsettle = async (id: string) => {
    setBusy(true);
    const r = await unsettleAction(props.clientId, id);
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success("Pencocokan dihapus");
    router.refresh();
  };

  const doVoid = async () => {
    if (!voiding) return;
    setBusy(true);
    const r = await voidInvoiceAction({ clientId: props.clientId, invoiceId: voiding.id, reason: voidReason });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(`${w.doc} ${voiding.number} dikeluarkan`, { description: voiding.opening ? "Saldo awal: hanya ditandai, tanpa jurnal." : `Jurnalnya dibalik per ${voiding.issued}.` });
    setVoiding(null);
    setVoidReason("");
    router.refresh();
  };

  const openInvoices = props.invoices.filter((i) => BigInt(i.open) > 0n);
  const paid = props.invoices.filter((i) => BigInt(i.open) === 0n);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ReceivablesTabs value={props.direction === "SALES" ? "piutang" : "utang"} />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setForm({ ...blank(), opening: true })}>{w.doc} saldo awal</Button>
          <Button variant="outline" size="sm" onClick={() => setForm(blank())}><Plus /> {w.newDoc}</Button>
        </div>
      </div>

      {props.aging.map((a) => {
        const cmp = props.comparison.find((c) => c.entityId === a.entityId);
        const withAdvance = BigInt(a.totals.advance) !== 0n;
        const unallocated = BigInt(a.unallocated);
        // Batas kredit: Piutang of a Rupiah company; Pengingat: a customer with an overdue invoice on the reminder date.
        const limits = props.direction === "SALES" && a.currency === "IDR";
        const remind = a.rows.some((r) => reminders[`${a.entityId}:${r.contactId}`]);
        const company = props.entities.find((e) => e.id === a.entityId)?.name ?? a.entity;
        const end = remind ? "text-right" : "pr-6 text-right";
        return (
          <Card key={a.entityId} data-testid={`aging-${a.entity}`}>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
              <div className="space-y-1.5">
                <CardTitle>Umur {props.direction === "SALES" ? "piutang" : "utang"} · {a.entity}</CardTitle>
                <CardDescription>Sisa per {w.party.toLowerCase()} menurut hari lewat jatuh tempo (rinciannya di layar lebar).</CardDescription>
              </div>
              {cmp && <StatusPill status={cmp.equal ? "PASS" : "REVIEW"} label={cmp.equal ? "Cocok dengan buku besar" : "Beda dengan buku besar"} />}
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">{w.party}</TableHead>
                    {BUCKETS.map((b) => <TableHead key={b} className="hidden text-right md:table-cell">{BUCKET_LABEL[b]}</TableHead>)}
                    {withAdvance && <TableHead className="hidden text-right whitespace-normal md:table-cell">Uang muka / kelebihan bayar</TableHead>}
                    <TableHead className={end}>Jumlah</TableHead>
                    {remind && <TableHead className="pr-6"><span className="sr-only">Pengingat</span></TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {a.rows.map((r) => {
                    const text = reminders[`${a.entityId}:${r.contactId}`];
                    return (
                      <TableRow key={r.contact} data-credit={r.credit || undefined} data-testid={`aging-row-${r.contact}`}>
                        <TableCell className="pl-6 whitespace-normal">
                          {r.contact}
                          {limits && canWrite && (
                            <Button variant="ghost" size="icon-xs" className="ml-1 align-middle" aria-label={`Ubah batas kredit ${r.contact}`} onClick={() => setLimitFor({ id: r.contactId, name: r.contact, limit: r.limit })}>
                              <Pencil />
                            </Button>
                          )}{" "}
                          <span className="text-xs text-muted-foreground">· {r.count ? `${r.count} ${w.docLower}` : "uang muka"}</span>
                          {r.credit && <span className="text-xs text-review"> · kelebihan bayar</span>}
                          {r.limit && (
                            <div className="text-xs text-muted-foreground">
                              <span className="hidden md:inline">Batas {formatMoney(BigInt(r.limit), "IDR")}</span>
                              {r.over && <span className="text-review" data-testid="over-limit"><span className="hidden md:inline"> · </span>lewat batas kredit</span>}
                            </div>
                          )}
                        </TableCell>
                        {BUCKETS.map((b) => <TableCell key={b} className="hidden text-right md:table-cell"><Money value={BigInt(r.buckets[b])} currency={a.currency} /></TableCell>)}
                        {withAdvance && <TableCell className="hidden text-right md:table-cell"><Money value={-BigInt(r.advance)} currency={a.currency} /></TableCell>}
                        <TableCell className={r.credit ? `${end} text-review` : end}><Money strong value={BigInt(r.net)} currency={a.currency} /></TableCell>
                        {remind && (
                          <TableCell className="w-0 pr-4 text-right">
                            {text && props.reminder && (
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Pengingat ${r.contact}`}
                                onClick={() =>
                                  setReminding({
                                    key: `${a.entityId}:${r.contactId}`,
                                    customer: r.contact,
                                    company,
                                    text,
                                    statementHref: `/clients/${props.clientId}/receivables/statement?${new URLSearchParams({ entity: a.entityId, contact: r.contactId, period: props.reminder!.periodKey })}`,
                                  })
                                }
                              >
                                <Bell /> Pengingat
                              </Button>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell className="pl-6 font-medium">Jumlah</TableCell>
                    {BUCKETS.map((b) => <TableCell key={b} className="hidden text-right md:table-cell"><Money strong value={BigInt(a.totals[b])} currency={a.currency} /></TableCell>)}
                    {withAdvance && <TableCell className="hidden text-right md:table-cell"><Money strong value={-BigInt(a.totals.advance)} currency={a.currency} /></TableCell>}
                    <TableCell className={end}><Money strong value={BigInt(a.totals.net)} currency={a.currency} /></TableCell>
                    {remind && <TableCell className="pr-6" />}
                  </TableRow>
                  {unallocated !== 0n && (
                    <TableRow data-testid="unallocated">
                      <TableCell className="pl-6 whitespace-normal text-review">Belum dialokasikan <span className="text-xs">· {a.unallocatedLines} mutasi bank, lihat di bawah</span></TableCell>
                      <TableCell className="hidden md:table-cell" colSpan={BUCKETS.length + (withAdvance ? 1 : 0)} />
                      <TableCell className={end}><Money value={-unallocated} currency={a.currency} /></TableCell>
                      {remind && <TableCell className="pr-6" />}
                    </TableRow>
                  )}
                  {cmp && (
                    <TableRow data-testid="subledger-ledger">
                      <TableCell className="pl-6 text-muted-foreground whitespace-normal" colSpan={1}>Buku besar ({cmp.accounts.join(", ")})</TableCell>
                      <TableCell className="hidden md:table-cell" colSpan={BUCKETS.length + (withAdvance ? 1 : 0)} />
                      <TableCell className={end}><Money muted value={BigInt(cmp.ledger)} currency={cmp.currency} /></TableCell>
                      {remind && <TableCell className="pr-6" />}
                    </TableRow>
                  )}
                </TableFooter>
              </Table>
            </CardContent>
          </Card>
        );
      })}

      {props.unsettled.length > 0 && (
        <Card data-testid="unsettled-lines">
          <CardHeader>
            <CardTitle>{w.lines}</CardTitle>
            <CardDescription>
              Mutasi bank di akun {props.direction === "SALES" ? "piutang" : "utang"} yang belum (habis) dikaitkan ke {w.docLower}. Pilih {w.party.toLowerCase()}nya lalu Cocokkan FIFO: {w.docLower} terlama jatuh tempo dulu, sisanya jadi uang muka {w.party.toLowerCase()} itu. Uang yang memang dibayar di muka: Uang muka.
            </CardDescription>
          </CardHeader>
          <CardContent className="divide-y px-0">
            {props.unsettled.map((l) => (
              <UnsettledLine key={l.id} clientId={props.clientId} line={l} contacts={props.contactOptions} party={w.party.toLowerCase()} onDone={() => router.refresh()} />
            ))}
          </CardContent>
        </Card>
      )}

      <Card data-testid="invoices">
        <CardHeader>
          <CardTitle>{w.doc} terbuka</CardTitle>
          <CardDescription>Yang paling lama lewat jatuh tempo di atas. Buka panah di ujung baris untuk melihat pelunasannya.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {openInvoices.length === 0 ? (
            <p className="px-6 text-sm text-muted-foreground">Tidak ada {w.docLower} terbuka per tanggal ini.</p>
          ) : (
            <InvoiceTable rows={openInvoices} w={w} open={open} setOpen={setOpen} onMatch={openMatching} onUnsettle={doUnsettle} onVoid={setVoiding} busy={busy} />
          )}
        </CardContent>
      </Card>
      {paid.length > 0 && (
        <Card data-testid="invoices-paid">
          <CardHeader>
            <CardTitle>{w.doc} lunas</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <InvoiceTable rows={paid} w={w} open={open} setOpen={setOpen} onUnsettle={doUnsettle} busy={busy} />
          </CardContent>
        </Card>
      )}
      {props.voided.length > 0 && (
        <Card data-testid="invoices-voided">
          <Collapsible>
            <CardHeader>
              <CollapsibleTrigger className="group flex items-center gap-1 text-left">
                <ChevronRight className="size-4 transition-transform group-data-[panel-open]:rotate-90" aria-hidden />
                <CardTitle>{w.doc} dikeluarkan ({props.voided.length})</CardTitle>
              </CollapsibleTrigger>
              <CardDescription>Dokumen yang salah catat. Jurnalnya dibalik pada tanggal aslinya; tidak masuk umur {props.direction === "SALES" ? "piutang" : "utang"}, CKPN maupun laporan.</CardDescription>
            </CardHeader>
            <CollapsibleContent>
              <CardContent className="divide-y px-0">
                {props.voided.map((v) => (
                  <div key={v.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-6 py-2 text-sm">
                    <div className="min-w-0">
                      <div><span className="font-medium line-through decoration-muted-foreground">{v.number} · {v.contact}</span> <span className="text-xs text-muted-foreground">· {v.entity} · {v.issued}{v.opening ? " · saldo awal" : ""}</span></div>
                      <div className="text-xs text-muted-foreground">Dikeluarkan {v.voidedAt}{v.by ? ` oleh ${v.by}` : ""}: {v.reason}</div>
                    </div>
                    <span className="line-through decoration-muted-foreground"><Money muted value={BigInt(v.total)} currency={v.currency} /></span>
                  </div>
                ))}
              </CardContent>
            </CollapsibleContent>
          </Collapsible>
        </Card>
      )}

      <Dialog open={voiding !== null} onOpenChange={(o) => !o && setVoiding(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keluarkan {w.docLower} {voiding?.number}?</DialogTitle>
            <DialogDescription>
              {voiding?.opening
                ? `Rincian saldo awal: tidak ada jurnal, ${w.docLower} ini hanya ditandai dan keluar dari daftar.`
                : `Jurnalnya dibalik per ${voiding?.issued} (bulan itu harus belum dikunci). ${w.doc} tetap tercatat, dicoret dengan alasannya.`}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="void-reason">Alasan</FieldLabel>
            <Textarea id="void-reason" rows={2} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="Mis. dokumen pemasok, bukan nota penjualan; dobel dengan INV-012" />
            <FieldDescription>Min. 10 karakter. Tercatat di riwayat.</FieldDescription>
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVoiding(null)}>Batal</Button>
            <Button variant="destructive" disabled={busy || voidReason.trim().length < 10} onClick={doVoid} data-testid="void-confirm">Keluarkan</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={form !== null} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{form?.opening ? `${w.doc} saldo awal` : w.newDoc}</DialogTitle>
            <DialogDescription>
              {form?.opening
                ? `Rincian ${props.direction === "SALES" ? "piutang" : "utang"} yang sudah ada di Saldo Awal. Tidak dijurnal lagi; tanggalnya paling lambat tanggal Saldo Awal.`
                : props.direction === "SALES"
                  ? "Dijurnal saat disimpan: piutang di debit, pendapatan dan PPN Keluaran di kredit."
                  : "Dijurnal saat disimpan: beban atau aset dan PPN Masukan di debit, utang di kredit."}
            </DialogDescription>
          </DialogHeader>
          {form && (
            <div className="grid gap-4 sm:grid-cols-2">
              {props.entities.length > 1 && (
                <Field className="sm:col-span-2">
                  <FieldLabel>Entitas</FieldLabel>
                  <SimpleSelect label="Entitas" value={form.entityId} onChange={(v) => set({ entityId: v })} options={props.entities.map((e) => ({ value: e.id, label: e.name }))} />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="inv-contact">{w.party}</FieldLabel>
                <Input id="inv-contact" list="inv-contacts" value={form.contactName} onChange={(e) => set({ contactName: e.target.value })} placeholder="Nama sesuai dokumen" />
                <datalist id="inv-contacts">{props.contacts.map((c) => <option key={c} value={c} />)}</datalist>
              </Field>
              <Field>
                <FieldLabel htmlFor="inv-number">Nomor {w.docLower}</FieldLabel>
                <Input id="inv-number" value={form.number} onChange={(e) => set({ number: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="inv-date">Tanggal {w.docLower}</FieldLabel>
                <Input id="inv-date" type="date" value={form.issueDate} onChange={(e) => set({ issueDate: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="inv-due">Jatuh tempo</FieldLabel>
                <Input id="inv-due" type="date" value={form.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />
                <FieldDescription>Kosongkan bila jatuh tempo saat itu juga.</FieldDescription>
              </Field>
              <Field className="sm:col-span-2">
                <FieldLabel htmlFor="inv-desc">Keterangan (opsional)</FieldLabel>
                <Input id="inv-desc" value={form.description} onChange={(e) => set({ description: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="inv-dpp">DPP{currency === "IDR" ? "" : ` (${currency})`}</FieldLabel>
                <Input id="inv-dpp" inputMode="decimal" className="num text-right" value={form.dpp} onChange={(e) => set({ dpp: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="inv-ppn">PPN (opsional)</FieldLabel>
                <div className="flex gap-2">
                  <Input id="inv-ppn" inputMode="decimal" className="num text-right" value={form.ppn} onChange={(e) => set({ ppn: e.target.value })} />
                  <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={ppnFromDpp}>Hitung 11%</Button>
                </div>
                <FieldDescription>Sesuai faktur pajak; 11 % = tarif efektif (12 % × 11/12).</FieldDescription>
              </Field>
              {!form.opening && (
                <Field>
                  <FieldLabel>{w.counter}</FieldLabel>
                  <SimpleSelect label={w.counter} value={form.counterCode} onChange={(v) => set({ counterCode: v })} options={props.accounts.counter.map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }))} placeholder="Pilih akun" />
                </Field>
              )}
              <Field>
                <FieldLabel>{w.arAp}</FieldLabel>
                <SimpleSelect label={w.arAp} value={form.arApCode} onChange={(v) => set({ arApCode: v })} options={props.accounts.arAp.map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }))} />
              </Field>
              <Field>
                <FieldLabel>Pajak yang dipotong (opsional)</FieldLabel>
                <SimpleSelect label="Pajak yang dipotong" value={form.whtKind || "none"} onChange={(v) => set({ whtKind: v === "none" ? "" : v })} options={[{ value: "none", label: "Tidak ada" }, ...whtKinds.map((k) => ({ value: k, label: WITHHOLDING_LABEL[k] }))]} />
                <FieldDescription>{props.direction === "SALES" ? "Pelanggan membayar setelah dipotong pajak (mis. PPh 23 2 %)." : "Anda membayar setelah memotong pajak (mis. PPh 23 2 %, PPh 21)."} Piutang/utang tetap dijurnal bruto; pemotongan dicatat saat pelunasan.</FieldDescription>
              </Field>
              {form.whtKind && (
                <Field>
                  <FieldLabel htmlFor="inv-wht-rate">Tarif atau nominal</FieldLabel>
                  <div className="flex gap-2">
                    <Input id="inv-wht-rate" inputMode="decimal" className="num text-right" placeholder="Tarif %, mis. 2" value={form.whtRate} onChange={(e) => set({ whtRate: e.target.value })} />
                    <Input aria-label="Nominal pajak dipotong" inputMode="decimal" className="num text-right" placeholder="atau nominal" value={form.whtAmount} onChange={(e) => set({ whtAmount: e.target.value })} />
                  </div>
                  <FieldDescription>{whtHint || "Tarif dihitung dari DPP; nominal, bila diisi, dipakai apa adanya."}</FieldDescription>
                </Field>
              )}
              <div className="flex items-center gap-2 text-sm sm:col-span-2">
                <Checkbox id="inv-opening" checked={form.opening} onCheckedChange={(v) => set({ opening: v === true })} />
                <label htmlFor="inv-opening">{w.doc} saldo awal (sudah termasuk di Saldo Awal, tidak dijurnal)</label>
              </div>
              <p className="text-sm text-muted-foreground sm:col-span-2">{amountError ? <span className="text-destructive">{amountError}</span> : total ? `Total ${total}` : "Isi DPP dan PPN."}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>Batal</Button>
            <Button disabled={busy || !form?.contactName.trim() || !form?.number.trim() || !total || (!form?.opening && !form?.counterCode)} onClick={submit}>{busy ? "Menyimpan…" : `Simpan ${w.docLower}`}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={matching !== null} onOpenChange={(o) => !o && setMatching(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Cocokkan {w.money} · {matching?.invoice.number}</DialogTitle>
            <DialogDescription>
              Sisa {matching ? formatMoney(BigInt(matching.invoice.open), matching.invoice.currency) : ""} dari {matching?.invoice.contact}. Yang nominalnya sama dan menyebut nama atau nomornya di atas. Mutasi yang belum dicatat ke akun {matching?.invoice.arApCode} diklasifikasikan ke sana sekalian.
            </DialogDescription>
          </DialogHeader>
          {matching && (
            <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="settle-withholding">
              <span className="text-muted-foreground">Pajak dipotong:</span>
              <SimpleSelect label="Pajak yang dipotong" className="w-56" value={settleKind || "none"} onChange={(v) => setSettleKind(v === "none" ? "" : v)} options={[{ value: "none", label: "Tidak ada" }, ...(props.direction === "SALES" ? RECEIPT_KINDS : WITHHOLDING_KINDS).map((k) => ({ value: k, label: WITHHOLDING_LABEL[k] }))]} />
              {settleKind && <span className="text-xs text-muted-foreground">Nominal yang dipotong ikut melunasi {w.docLower}; sisanya kas dari mutasi bank.</span>}
            </div>
          )}
          {matching?.candidates === null ? (
            <p className="text-sm text-muted-foreground">Mencari mutasi…</p>
          ) : matching?.candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tidak ada mutasi bank entitas ini yang bisa dicocokkan sejak tanggal {w.docLower}. Impor rekening korannya dulu.</p>
          ) : (
            <div className="divide-y rounded-lg border" data-testid="settle-candidates">
              {matching?.candidates.map((c) => (
                <div key={c.bankTransactionId} className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
                  <div className="min-w-0 flex-1 basis-60">
                    <div className="text-sm">{c.description}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.date} · sisa <span className="num">{formatMoney(BigInt(c.free), matching.invoice.currency)}</span>
                      {c.advance ? " · uang muka pelanggan ini" : ""}{c.exact ? " · nominal sama" : ""}{c.named ? " · nama/nomor cocok" : ""}{c.onAccount ? "" : ` · akan diklasifikasikan ke ${matching.invoice.arApCode}`}
                    </div>
                  </div>
                  <Input aria-label={`Nominal ${c.date}`} inputMode="decimal" className="num w-36 text-right" value={amounts[c.bankTransactionId] ?? ""} onChange={(e) => setAmounts({ ...amounts, [c.bankTransactionId]: e.target.value })} />
                  {settleKind && <Input aria-label={`Dipotong ${c.date}`} inputMode="decimal" placeholder="Dipotong" className="num w-32 text-right" value={withheld[c.bankTransactionId] ?? ""} onChange={(e) => setWithheld({ ...withheld, [c.bankTransactionId]: e.target.value })} />}
                  <Button size="sm" variant={c.exact && c.named ? "default" : "outline"} disabled={busy} onClick={() => doSettle(c)}>Cocokkan</Button>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMatching(null)}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CreditLimitDialog key={limitFor?.id ?? "none"} clientId={props.clientId} customer={limitFor} onClose={() => setLimitFor(null)} />
      {props.reminder && <ReminderDialog key={reminding?.key ?? "none"} target={reminding} date={props.reminder.date} monthOpen={props.reminder.monthOpen} onClose={() => setReminding(null)} />}
    </div>
  );
}

function InvoiceTable(props: { rows: InvoiceView[]; w: (typeof WORDS)[Direction]; open: string | null; setOpen: (id: string | null) => void; onMatch?: (i: InvoiceView) => void; onUnsettle: (id: string) => void; onVoid?: (i: InvoiceView) => void; busy: boolean }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-6">{props.w.doc}</TableHead>
          <TableHead className="hidden md:table-cell">Jatuh tempo</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Total</TableHead>
          <TableHead className="text-right">Sisa</TableHead>
          <TableHead className="w-28 pr-6"><span className="sr-only">Aksi</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.rows.map((i) => (
          <Fragment key={i.id}>
            <TableRow className="cursor-pointer" onClick={() => props.setOpen(props.open === i.id ? null : i.id)} data-testid={`invoice-${i.number}`}>
              <TableCell className="pl-6 whitespace-normal">
                <div className="font-medium">{i.number} · {i.contact}</div>
                <div className="text-xs text-muted-foreground">{i.entity} · {i.issued}{i.opening ? " · saldo awal" : ""} · {i.description}</div>
              </TableCell>
              <TableCell className={i.daysPastDue > 0 && BigInt(i.open) > 0n ? "hidden text-review md:table-cell" : "hidden text-muted-foreground md:table-cell"}>
                {i.due}{i.daysPastDue > 0 && BigInt(i.open) > 0n ? ` · lewat ${i.daysPastDue} hari` : ""}
              </TableCell>
              <TableCell className="hidden text-right sm:table-cell"><Money value={BigInt(i.total)} currency={i.currency} /></TableCell>
              <TableCell className="text-right"><Money strong value={BigInt(i.open)} currency={i.currency} /></TableCell>
              <TableCell className="pr-6 text-right whitespace-nowrap">
                {props.onMatch && <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); props.onMatch!(i); }}>Cocokkan</Button>}
                <Button variant="ghost" size="icon-sm" aria-label={`Pelunasan ${i.number}`} aria-expanded={props.open === i.id} onClick={(e) => { e.stopPropagation(); props.setOpen(props.open === i.id ? null : i.id); }}>
                  <ChevronDown className={props.open === i.id ? "rotate-180" : ""} />
                </Button>
              </TableCell>
            </TableRow>
            {props.open === i.id && (
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableCell colSpan={5} className="px-6 py-3 whitespace-normal">
                  {i.whtKind && (
                    <p className="mb-2 text-xs text-muted-foreground" data-testid="invoice-wht">
                      Dipotong {WITHHOLDING_LABEL[i.whtKind as WithholdingKind]}: diharapkan sisa <Money value={BigInt(i.whtExpected)} currency={i.currency} />, dicatat saat pelunasan.
                    </p>
                  )}
                  {i.settlements.length === 0 ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <p className="text-muted-foreground">Belum ada pelunasan.</p>
                      {props.onVoid && (
                        <Button variant="ghost" size="sm" className="text-fail" onClick={() => props.onVoid!(i)} data-testid={`void-${i.number}`}>
                          Keluarkan {props.w.docLower} ini…
                        </Button>
                      )}
                    </div>
                  ) : (
                    <ul className="space-y-1.5 text-sm">
                      {i.settlements.map((s) => (
                        <li key={s.id} className="flex flex-wrap items-center gap-x-3">
                          <span className="text-muted-foreground">{s.date}</span>
                          <span className="min-w-0 flex-1 truncate">{s.description}</span>
                          {BigInt(s.withheld) > 0n && <span className="text-xs text-muted-foreground">termasuk pajak dipotong <Money value={BigInt(s.withheld)} currency={i.currency} /></span>}
                          <Money value={BigInt(s.amount)} currency={i.currency} />
                          <Button variant="ghost" size="sm" disabled={props.busy} onClick={() => props.onUnsettle(s.id)}>Hapus</Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * One unmatched bank line (UC-B5): pick the contact, then *Cocokkan FIFO* (their open documents, oldest first; the rest stays as their
 * advance) or *Uang muka* (the whole line is theirs, for a later document). A tagged line shows whose advance it is.
 */
function UnsettledLine({ clientId, line, contacts, party, onDone }: { clientId: string; line: UnsettledLineView; contacts: { id: string; name: string }[]; party: string; onDone: () => void }) {
  const [contactId, setContactId] = useState(line.contact?.id ?? "");
  const [busy, setBusy] = useState(false);
  async function fifo() {
    setBusy(true);
    const r = await settleFifoAction({ clientId, bankTransactionId: line.id, contactId });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    const rest = BigInt(r.rest);
    toast.success(`${r.settled.length} dokumen ${r.contact} dicocokkan`, { description: [r.settled.map((x) => `${x.number} ${formatMoney(BigInt(x.amount), line.currency)}`).join(", "), rest > 0n ? `sisa ${formatMoney(rest, line.currency)} jadi uang muka` : ""].filter(Boolean).join(" · ") });
    onDone();
  }
  async function tag(id: string | null) {
    setBusy(true);
    const r = await tagAdvanceAction({ clientId, bankTransactionId: line.id, contactId: id });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(id ? (line.refund ? "Ditandai sebagai pengembalian" : "Ditandai sebagai uang muka") : "Tanda dihapus");
    onDone();
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2.5" data-testid="unsettled-line">
      <div className="min-w-0 flex-1 basis-64">
        <div className="text-sm">{line.description}</div>
        <div className="text-xs text-muted-foreground">
          {line.entity} · {line.date} · {line.accountCode}
          {line.refund && <span className="text-review"> · pengembalian (uang keluar)</span>}
          {line.split && <span> · bagian dari mutasi yang dipecah</span>}
          {line.contact && <span className="font-medium text-foreground"> · {line.refund ? "pengembalian ke" : "uang muka"} {line.contact.name}</span>}
        </div>
      </div>
      <Money className="text-sm" value={BigInt(line.free)} currency={line.currency} />
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
        <Select value={contactId || null} onValueChange={(v) => setContactId((v as string) ?? "")}>
          <SelectTrigger size="sm" className="w-56 max-w-full" aria-label={`Pilih ${party}`}><SelectValue placeholder={`Pilih ${party}`} /></SelectTrigger>
          <SelectContent>{contacts.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
        </Select>
        {!line.refund && !line.split && <Button size="sm" variant="outline" disabled={busy || !contactId} onClick={fifo} data-testid="fifo">Cocokkan FIFO</Button>}
        {line.contact ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => tag(null)}>Hapus tanda</Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={busy || !contactId} onClick={() => tag(contactId)}>{line.refund ? "Tandai pengembalian" : "Uang muka"}</Button>
        )}
      </div>
    </div>
  );
}

