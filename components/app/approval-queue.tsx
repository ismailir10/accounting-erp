"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, Check, CheckCheck, CircleAlert, Loader2, Pencil, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/app/money";
import { MethodBadge } from "@/components/app/status";
import { SimpleSelect } from "@/components/app/simple-select";
import { ReasoningDisclosure } from "@/components/app/reasoning-panel";
import { hasReasoning } from "@/lib/approvals/has-reasoning";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { bookFakturAction, dismissAccrualAction, dismissProposalAction, postAccrualAction, postAllDueAction, postInstallmentAction, postProposalAction, reviewAction } from "@/app/actions";
import type { AccrualCard, ApprovalKind, BankCard, DraftCard, FakturCard, ScheduledCard } from "@/lib/approvals/queue";
import type { TaxTag } from "@/lib/generated/prisma/enums";
import { cn } from "@/lib/utils";
import { formatDate, formatPeriod } from "@/lib/format";
import { formatMoney } from "@/lib/money";

type Account = { code: string; name: string };
type Result = { ok: boolean; error?: string; fields?: Record<string, string> };
/** Debit: any account but bank, clearing and 1999; credit: a liability, none of those (the writer checks again). */
export type AccrualAccounts = { debit: Account[]; credit: Account[] };

const TAX_LABEL: Record<string, string> = { PPN_KELUARAN: "PPN Keluaran", PPN_MASUKAN: "PPN Masukan", PPH_21: "Setoran PPh 21", PPH_23: "Setoran PPh 23", PPH_4_2: "Setoran PPh 4(2)", PPH_25: "Angsuran PPh 25" };
const DIRECTION: Record<FakturCard["direction"], { label: string; account: string; book: string }> = {
  KELUARAN: { label: "Faktur keluaran", account: "Akun pendapatan", book: "piutang" },
  MASUKAN: { label: "Faktur masukan", account: "Akun beban atau aset", book: "utang" },
};
const isoDay = (iso: string) => formatDate(new Date(`${iso}T00:00:00Z`));

/** One proposal as a divided row: eyebrow, title, amount, reason line, then its own fields and buttons (no box in a box). */
function Row({ testId, eyebrow, title, mono, amount, currency, reason, children }: { testId: string; eyebrow: React.ReactNode; title: React.ReactNode; mono?: boolean; amount: bigint; currency: string; reason: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className="space-y-2 py-4 first:pt-0 last:pb-0" data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1 basis-56">
          <p className="eyebrow text-muted-foreground">{eyebrow}</p>
          <p className={cn("mt-0.5 break-words", mono ? "font-mono text-sm" : "font-medium")}>{title}</p>
        </div>
        <Money className="text-base font-semibold" value={amount} currency={currency} />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">{reason}</div>
      {children}
    </li>
  );
}

function KindCard({ kind, title, count, description, action, children }: { kind: ApprovalKind; title: string; count: number; description?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card data-testid={`approvals-${kind}`}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle role="heading" aria-level={2}>
            {title} <span className="num text-muted-foreground">{count}</span>
          </CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {action}
      </CardHeader>
      <CardContent>
        <ul className="divide-y">{children}</ul>
      </CardContent>
    </Card>
  );
}

/**
 * One *Usulan akrual* card: the counterparty and its account, the two lines and the reversal date, the rationale (with *Lihat alasan*),
 * a warning or blocked line, then *Setujui*, *Ubah* (amount and both accounts in the row) and *Tolak*. A refusal tied to a field shows
 * under that field; any other comes back as a toast.
 */
function AccrualItem({ card, label, accounts, readOnly, disabled, withReasoning, onPost, onDismiss }: {
  card: AccrualCard;
  label: string;
  accounts: AccrualAccounts | null;
  readOnly: boolean;
  disabled: boolean;
  withReasoning: (card: AccrualCard, line: (toggle?: React.ReactNode) => React.ReactNode) => React.ReactNode;
  onPost: (edit: { amount: string; debitCode: string; creditCode: string }) => Promise<Record<string, string> | null>;
  onDismiss: () => void;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState("");
  const [debit, setDebit] = useState(card.account.code);
  const [credit, setCredit] = useState(card.credit?.code ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const total = BigInt(card.amount);
  const post = async () => setErrors((await onPost(editing ? { amount, debitCode: debit, creditCode: credit } : { amount: "", debitCode: "", creditCode: credit })) ?? {});
  const line = (side: string, code: string, name: string) => (
    <span className="flex basis-full flex-wrap items-center gap-x-3">
      <span className="w-12 text-xs">{side}</span>
      <span className="min-w-0 flex-1 text-foreground">{code ? `${code} ${name}` : "belum dipilih"}</span>
      <Money className="text-sm" value={total} currency={card.currency} />
    </span>
  );
  return (
    <Row
      testId="approval-accrual"
      eyebrow={
        <>
          {label} · {card.entity} · {isoDay(card.date)} · <span className="text-review">Perlu ditinjau</span>
        </>
      }
      title={
        <>
          {card.counterparty} <span className="font-normal text-muted-foreground">{card.account.code} {card.account.name}</span>
        </>
      }
      amount={total}
      currency={card.currency}
      reason={withReasoning(card, (toggle) => (
        <>
          {line("Debit", card.account.code, card.account.name)}
          {line("Kredit", card.credit?.code ?? "", card.credit?.name ?? "")}
          <span className="basis-full">Dibalik otomatis {isoDay(card.reversalDate)}</span>
          <span className="basis-full text-foreground">
            {card.rationale} {toggle}
          </span>
        </>
      ))}
    >
      {card.blocked && <p className="text-sm font-medium text-review" data-testid="approval-blocked">{card.blocked}</p>}
      {card.warning && (
        <p className="flex items-start gap-2 border-l-2 border-review py-0.5 pl-3 text-sm" data-testid="accrual-warning">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-review" aria-hidden />
          {card.warning}
        </p>
      )}
      {card.noCredit && !credit && !card.blocked && <p className="text-sm font-medium text-review">{card.noCredit}</p>}
      {!readOnly && editing && accounts && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor={`${id}-amount`}>Nominal</FieldLabel>
            <Input id={`${id}-amount`} inputMode="numeric" className="num text-right" placeholder={formatMoney(total, card.currency, { bare: true })} value={amount} aria-invalid={!!errors.amount} disabled={disabled} onChange={(e) => setAmount(e.target.value)} />
            <FieldError>{errors.amount}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-debit`}>Akun debit</FieldLabel>
            <SimpleSelect id={`${id}-debit`} label="Akun debit" value={debit} disabled={disabled} onChange={setDebit} options={accounts.debit.map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }))} />
            <FieldError>{errors.debit}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-credit`}>Akun kredit</FieldLabel>
            <SimpleSelect id={`${id}-credit`} label="Akun kredit" value={credit} disabled={disabled} placeholder="Pilih liabilitas" onChange={setCredit} options={accounts.credit.map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }))} />
            <FieldError>{errors.credit}</FieldError>
          </Field>
        </div>
      )}
      {!readOnly && !editing && Object.keys(errors).length > 0 && <p className="text-sm font-medium text-review">{Object.values(errors)[0]}</p>}
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          {!card.blocked && (
            <>
              <Button variant="outline" size="sm" disabled={disabled || !credit} onClick={() => void post()}>
                <Check /> Setujui
              </Button>
              <Button variant="outline" size="sm" disabled={disabled} aria-expanded={editing} onClick={() => setEditing((e) => !e)}>
                <Pencil /> {editing ? "Batal ubah" : "Ubah"}
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" disabled={disabled} onClick={onDismiss}>
            <X /> Tolak
          </Button>
        </div>
      )}
    </Row>
  );
}

/**
 * Kotak persetujuan: every proposal of the month in one list, kind by kind. Each button calls the owning page's own server action, so
 * every writer, lock, re-check and refusal stays as it is; nothing posts without a click. `readOnly`: a locked month or a viewer.
 */
export function ApprovalQueue({
  clientId,
  year,
  month,
  entityId,
  kinds,
  labels,
  bank,
  bankTotal,
  confident,
  drafts,
  scheduled,
  accruals,
  accrualAccounts,
  faktur,
  fakturAccounts,
  draftAccounts,
  reviewHref,
  adjustHref,
  readOnly,
}: {
  clientId: string;
  year: number;
  month: number;
  /** The company in scope (one company's instalments in *Catat semua*); undefined for the whole group. */
  entityId?: string;
  /** The kinds shown (the `?jenis=` tab, or every kind with a proposal). */
  kinds: ApprovalKind[];
  labels: Record<ApprovalKind, string>;
  bank: BankCard[];
  bankTotal: number;
  confident: { id: string; accountCode: string; taxTag: string | null }[];
  drafts: DraftCard[];
  scheduled: ScheduledCard[];
  accruals: AccrualCard[];
  /** Only when there are accrual cards. */
  accrualAccounts: AccrualAccounts | null;
  faktur: FakturCard[];
  fakturAccounts: Record<FakturCard["direction"], Account[]> | null;
  draftAccounts: Account[];
  /** Review in scope; `&tx=<id>` opens a line. */
  reviewHref: string;
  adjustHref: string;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  // Optimistic: a decided card leaves at once; a refusal brings it back with the message.
  const [done, setDone] = useState<Set<string>>(new Set());
  const [codes, setCodes] = useState<Record<string, string[]>>({});
  const [fakturCode, setFakturCode] = useState<Record<string, string>>({});
  const leave = (ids: string[]) => setDone((d) => new Set([...d, ...ids]));
  const back = (id: string) => setDone((d) => { const n = new Set(d); n.delete(id); return n; });
  const run = async (key: string, fn: () => Promise<Result>, ok: string, ids: string[] = [key]) => {
    setBusy(key);
    leave(ids);
    const r = await fn();
    setBusy(null);
    if (!r.ok) {
      ids.forEach(back);
      toast.error(r.error ?? "Gagal menyimpan.");
      // *Catat semua* stops at its first refusal with the earlier ones posted: the page shows what is left.
      return void router.refresh();
    }
    toast.success(ok);
    router.refresh();
  };

  const accept = (c: BankCard) =>
    run(c.id, () => reviewAction({ bankTxId: c.id, accountCode: c.suggestedCode!, taxTag: c.taxTag as TaxTag | null }), `${c.suggestedCode} ${c.suggestedName ?? ""}`.trim());
  // Bulk: the confident lines one by one, in Review's order, through the same accept; one refusal doesn't stop the rest.
  const sure = confident.filter((c) => !done.has(c.id));
  const acceptConfident = async () => {
    setBusy("confident");
    leave(sure.map((c) => c.id));
    const failed: string[] = [];
    for (const c of sure) {
      const r = await reviewAction({ bankTxId: c.id, accountCode: c.accountCode, taxTag: c.taxTag as TaxTag | null });
      if (!r.ok) {
        failed.push(r.error);
        back(c.id);
      }
    }
    setBusy(null);
    if (failed.length) toast.error(`${sure.length - failed.length} usulan disetujui, ${failed.length} ditolak: ${failed[0]}`);
    else toast.success(`${sure.length} usulan yakin disetujui`);
    router.refresh();
  };

  const codesOf = (d: DraftCard) => codes[d.id] ?? d.lines.map((l) => l.accountCode);
  const openBank = bank.filter((c) => !done.has(c.id));
  const openDrafts = drafts.filter((d) => !done.has(d.id));
  const openScheduled = scheduled.filter((s) => !done.has(`${s.scheduleId}:${s.k}`));
  const openFaktur = faktur.filter((f) => !done.has(f.id));
  const openAccruals = accruals.filter((a) => !done.has(a.id));
  // An accrual's *Setujui* returns the refused field's message to its card (shown under the field) instead of a toast, so the card
  // stays mounted with its *Ubah* fields until the writer has answered (no optimistic leave).
  const postAccrual = async (a: AccrualCard, edit: { amount: string; debitCode: string; creditCode: string }) => {
    setBusy(a.id);
    const r: Result = await postAccrualAction(clientId, a.id, edit);
    setBusy(null);
    if (!r.ok) {
      if (!r.fields) toast.error(r.error ?? "Gagal menyimpan.");
      router.refresh();
      return r.fields ?? null;
    }
    leave([a.id]);
    toast.success(`Akrual dicatat, dibalik ${isoDay(a.reversalDate)}`);
    router.refresh();
    return null;
  };
  const hiddenBank = bankTotal - bank.length;
  const disabled = busy !== null;
  const show = (k: ApprovalKind) => kinds.includes(k);
  // *Lihat alasan* only on AI cards: deterministic ones (rule, memory, guess, 1999 correction, schedule, faktur) say why already.
  const withReasoning = (card: Parameters<typeof hasReasoning>[0], id: string, line: (toggle?: React.ReactNode) => React.ReactNode) =>
    hasReasoning(card) ? <ReasoningDisclosure clientId={clientId} itemId={id}>{line}</ReasoningDisclosure> : line();

  return (
    <div className="space-y-6">
      {!readOnly && sure.length > 0 && show("bank") && (
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={disabled} onClick={acceptConfident} data-testid="approve-confident">
            {busy === "confident" ? <Loader2 className="animate-spin" /> : <CheckCheck />} Setujui {sure.length} usulan yakin
          </Button>
          <span className="text-xs text-muted-foreground">Usulan AI ≥ 80% tanpa petunjuk akuntan, satu per satu seperti di Review.</span>
        </div>
      )}

      {show("bank") && openBank.length > 0 && (
        <KindCard kind="bank" title={labels.bank} count={bankTotal - (bank.length - openBank.length)} description="Mutasi yang masih di 1999. Setujui usulannya apa adanya, atau ubah akun, pajak dan pecahan di Review.">
          {openBank.map((c) => {
            const amount = BigInt(c.amount);
            return (
              <Row
                key={c.id}
                testId="approval-bank"
                eyebrow={`${labels.bank} · ${c.entity} · ${c.bank} · ${c.date}`}
                title={c.description}
                mono
                amount={amount < 0n ? -amount : amount}
                currency={c.currency}
                reason={withReasoning(c, c.id, (toggle) => (
                  <>
                    <MethodBadge method={c.method} />
                    {c.method === "AI" && <span className={cn("num text-xs", c.confidence < 0.7 && "font-medium text-review")}>{c.confidence < 0.7 ? "keyakinan rendah" : "keyakinan"} {Math.round(c.confidence * 100)}%</span>}
                    <span>{amount > 0n ? "Uang masuk" : "Uang keluar"} → {c.suggestedCode ? <span className="text-foreground">{c.suggestedCode} {c.suggestedName}{c.taxTag ? ` · ${TAX_LABEL[c.taxTag] ?? c.taxTag}` : ""}</span> : "belum ada usulan akun"}</span>
                    <span className="basis-full">{c.reason.replace(/^AI: /, "")} {toggle}</span>
                  </>
                ))}
              >
                {c.hints.length > 0 && (
                  <ul className="space-y-1">
                    {c.hints.map((h) => (
                      <li key={h} className="flex items-start gap-2 border-l-2 border-review py-0.5 pl-3 text-sm">
                        <CircleAlert className="mt-0.5 size-4 shrink-0 text-review" aria-hidden />
                        {h}
                      </li>
                    ))}
                  </ul>
                )}
                {!readOnly && (
                  <div className="flex flex-wrap gap-2">
                    {c.suggestedCode && (
                      <Button variant="outline" size="sm" disabled={disabled} onClick={() => accept(c)}>
                        <Check /> Setujui
                      </Button>
                    )}
                    <Link href={`${reviewHref}&tx=${c.id}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                      Ubah di Review <ArrowRight />
                    </Link>
                  </div>
                )}
              </Row>
            );
          })}
          {hiddenBank > 0 && (
            <li className="pt-4 text-sm text-muted-foreground">
              {hiddenBank} mutasi lain menunggu di{" "}
              <Link href={reviewHref} className="drill">Review transaksi</Link>.
            </li>
          )}
        </KindCard>
      )}

      {show("draft") && openDrafts.length > 0 && (
        <KindCard kind="draft" title={labels.draft} count={openDrafts.length} description="Draf AI dari Jelaskan dan koreksi selisih 1999. Akun boleh diganti, nominal tidak.">
          {openDrafts.map((d) => {
            const total = d.lines.reduce((s, l) => s + BigInt(l.debit), 0n);
            return (
              <Row
                key={d.id}
                testId="approval-draft"
                eyebrow={`${labels.draft} · ${d.entity} · ${isoDay(d.date)}`}
                title={d.memo}
                amount={total}
                currency={d.currency}
                reason={withReasoning(d, d.id, (toggle) => (
                  <>
                    <MethodBadge method={d.source === "AI_CONTROL" ? "AI" : "SUSPENSE"} />
                    <span>{d.reason} {toggle}</span>
                  </>
                ))}
              >
                <div className="space-y-2">
                  {d.lines.map((l, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <div className="min-w-0 flex-1 basis-56">
                        <SimpleSelect
                          label={`Akun baris ${i + 1}`}
                          value={codesOf(d)[i]}
                          disabled={readOnly || d.fixed === i || Boolean(d.blocked)}
                          placeholder="Pilih akun"
                          onChange={(v) => setCodes((x) => ({ ...x, [d.id]: codesOf(d).map((c, j) => (j === i ? v : c)) }))}
                          options={draftAccounts.map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }))}
                        />
                      </div>
                      <span className="w-12 text-xs text-muted-foreground">{BigInt(l.debit) > 0n ? "Debit" : "Kredit"}</span>
                      <Money className="w-32 text-right text-sm" value={BigInt(l.debit) > 0n ? BigInt(l.debit) : BigInt(l.credit)} currency={d.currency} />
                    </div>
                  ))}
                </div>
                {d.blocked && <p className="text-sm font-medium text-review" data-testid="approval-blocked">{d.blocked}</p>}
                {!readOnly && (
                  <div className="flex flex-wrap gap-2">
                    {!d.blocked && (
                      <Button variant="outline" size="sm" disabled={disabled} onClick={() => run(d.id, () => postProposalAction(clientId, d.id, codesOf(d)), "Jurnal dicatat")}>
                        <Check /> Setujui
                      </Button>
                    )}
                    {/* A 1999 difference must be corrected before the close: its correction can't be refused. */}
                    {d.source === "AI_CONTROL" && (
                      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => run(d.id, () => dismissProposalAction(clientId, d.id), "Usulan ditolak")}>
                        <X /> Tolak
                      </Button>
                    )}
                  </div>
                )}
              </Row>
            );
          })}
        </KindCard>
      )}

      {show("scheduled") && openScheduled.length > 0 && (
        <KindCard
          kind="scheduled"
          title={labels.scheduled}
          count={openScheduled.length}
          description="Cicilan penyusutan, amortisasi dan akrual yang jatuh tempo sampai bulan ini."
          action={
            !readOnly && openScheduled.length > 1 ? (
              <Button variant="outline" size="sm" disabled={disabled} onClick={() => run("all", () => postAllDueAction(clientId, year, month, entityId), `${openScheduled.length} jurnal terjadwal dicatat`, openScheduled.map((s) => `${s.scheduleId}:${s.k}`))}>
                {busy === "all" && <Loader2 className="animate-spin" />} Catat semua {openScheduled.length}
              </Button>
            ) : undefined
          }
        >
          {openScheduled.map((s) => {
            const key = `${s.scheduleId}:${s.k}`;
            return (
              <Row
                key={key}
                testId="approval-scheduled"
                eyebrow={
                  <>
                    {labels.scheduled} · {s.entity} · {isoDay(s.date)}
                    {s.overdue && <span className="font-medium text-review"> · terlambat</span>}
                  </>
                }
                title={s.memo}
                amount={BigInt(s.amount)}
                currency={s.currency}
                reason={
                  <>
                    <MethodBadge method="SCHEDULE" />
                    <span className="num">Debit {s.debit} · Kredit {s.credit}</span>
                  </>
                }
              >
                {!readOnly && (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" disabled={disabled} onClick={() => run(key, () => postInstallmentAction(clientId, s.scheduleId, s.k), `${s.memo} dicatat`)}>
                      <Check /> Setujui
                    </Button>
                    <Link href={adjustHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                      Ubah di Jurnal Penyesuaian <ArrowRight />
                    </Link>
                  </div>
                )}
              </Row>
            );
          })}
        </KindCard>
      )}

      {show("accrual") && openAccruals.length > 0 && (
        <KindCard kind="accrual" title={labels.accrual} count={openAccruals.length} description="Vendor yang rutin tiap bulan tetapi belum ada di bulan ini. Setujui untuk mencatat akrual yang dibalik otomatis tanggal 1 bulan berikutnya.">
          {openAccruals.map((a) => (
            <AccrualItem
              key={a.id}
              card={a}
              label={labels.accrual}
              accounts={accrualAccounts}
              readOnly={readOnly}
              disabled={disabled}
              withReasoning={(card, line) => withReasoning(card, card.id, line)}
              onPost={(edit) => postAccrual(a, edit)}
              onDismiss={() => run(a.id, () => dismissAccrualAction(clientId, a.id), `Usulan akrual ditolak untuk ${formatPeriod(year, month)}`)}
            />
          ))}
        </KindCard>
      )}

      {show("faktur") && openFaktur.length > 0 && fakturAccounts && (
        <KindCard kind="faktur" title={labels.faktur} count={openFaktur.length} description="Faktur yang dihitung di masa ini tetapi belum ada di buku. Setujui untuk mencatatnya sebagai piutang atau utang.">
          {openFaktur.map((f) => {
            const dir = DIRECTION[f.direction];
            const options = fakturAccounts[f.direction];
            const code = fakturCode[f.id] ?? options.find((a) => a.code === f.preferred)?.code ?? options[0]?.code ?? "";
            return (
              <Row
                key={f.id}
                testId="approval-faktur"
                eyebrow={`${labels.faktur} · ${f.entity} · ${isoDay(f.date)}`}
                title={`${f.number} · ${f.name || "Tanpa nama"}`}
                amount={BigInt(f.dpp) + BigInt(f.ppn)}
                currency="IDR"
                reason={
                  <>
                    <MethodBadge method="CORETAX" />
                    <span>
                      {dir.label} belum ada di buku · DPP <Money value={BigInt(f.dpp)} /> · PPN <Money value={BigInt(f.ppn)} /> · <span className="font-mono text-xs">{f.fileName} {f.sourceRef}</span>
                    </span>
                  </>
                }
              >
                <div className="max-w-md">
                  <SimpleSelect label={dir.account} value={code} disabled={readOnly} placeholder="Pilih akun" onChange={(v) => setFakturCode((x) => ({ ...x, [f.id]: v }))} options={options.map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }))} />
                </div>
                {!readOnly && (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" disabled={disabled || !code} onClick={() => run(f.id, () => bookFakturAction({ clientId, fakturId: f.id, counterCode: code }), `Faktur ${f.number} dicatat sebagai ${dir.book}`)}>
                      <Check /> Setujui
                    </Button>
                  </div>
                )}
              </Row>
            );
          })}
        </KindCard>
      )}
    </div>
  );
}
