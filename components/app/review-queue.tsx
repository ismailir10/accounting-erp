"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, CheckCheck, CircleAlert, Loader2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Kbd } from "@/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AccountPicker } from "@/components/app/account-picker";
import { MethodBadge } from "@/components/app/status";
import { SplitDialog } from "@/components/app/split-dialog";
import { acceptSimilarAction, reviewAction, suggestAgainAction } from "@/app/actions";
import { formatMoney, PPN_EFFECTIVE_PERCENT } from "@/lib/money";
import { DEFAULT_RATE, grossUpWithholding, WITHHOLDING_LABEL } from "@/lib/tax/withholding";
import type { WithholdingKind } from "@/lib/generated/prisma/enums";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { accountantHints } from "@/lib/classify/hints";
import type { AiRunView } from "@/lib/ai/run";
import { AiRunStatus, useAiRun } from "@/components/app/ai-run-status";

export type ReviewItem = {
  id: string;
  date: string;
  entity: string;
  bank: string;
  description: string;
  amount: string; // bigint as string (client boundary)
  currency: string;
  method: string;
  confidence: number;
  reason: string;
  suggestedCode: string | null;
  taxTag: string | null;
  similar: number;
  /** Only the simple guess stands behind the suggestion: Enter doesn't accept it, and accepting it unchanged isn't learned. */
  guess: boolean;
  /** The entity's kind (PT, CV, PERORANGAN…): only a business is a withholding agent in the hints. */
  entityKind?: string;
};
export type AccountOption = { code: string; name: string; group: string };
/** `wht`: tax the counterparty or we withheld ("none" or a kind) at `rate` %, added to the net bank amount (accounting-rules 5h). */
type Choice = { code: string; tax: string; rule: boolean; wht?: string; rate?: string };

// What the tag does to the journal: PPN splits the amount; the PPh tags mark a payment of that tax to the state (a remittance).
const TAX = [
  { value: "none", label: "Tanpa pajak" },
  { value: "PPN_KELUARAN", label: "PPN Keluaran (pisah 11%)" },
  { value: "PPN_MASUKAN", label: "PPN Masukan (pisah 11%)" },
  { value: "PPH_21", label: "Setoran PPh 21" },
  { value: "PPH_23", label: "Setoran PPh 23" },
  { value: "PPH_4_2", label: "Setoran PPh 4(2) / final" },
  { value: "PPH_25", label: "Angsuran PPh 25" },
];
const WHT: Record<"IN" | "OUT", { value: string; label: string }[]> = {
  OUT: [
    { value: "none", label: "Tanpa potongan" },
    { value: "PPH_23", label: "Kita potong PPh 23" },
    { value: "PPH_4_2", label: "Kita potong PPh 4(2)" },
    { value: "PPH_21", label: "Kita potong PPh 21" },
    { value: "PPH_22", label: "Kita potong PPh 22" },
  ],
  IN: [
    { value: "none", label: "Tanpa potongan" },
    { value: "PPH_23", label: "Dipotong PPh 23 oleh pelanggan" },
    { value: "PPH_4_2", label: "Dipotong PPh 4(2) oleh pelanggan" },
    { value: "PPH_22", label: "Dipungut PPh 22 oleh pelanggan" },
  ],
};
type Filter = "all" | "in" | "out" | "guess";

/**
 * Unsaved choices per bank line id, kept in sessionStorage: they survive refreshes, remounts and a reload of the tab, so a
 * correction is never lost before *Simpan*. A tiny external store (useSyncExternalStore) so every card reads the same value.
 */
const DRAFTS = "buku:review-drafts";
let memoryDrafts = "{}"; // private mode: no sessionStorage
const listeners = new Set<() => void>();
const snapshot = () => {
  try {
    return sessionStorage.getItem(DRAFTS) ?? "{}";
  } catch {
    return memoryDrafts;
  }
};
const readDrafts = (): Record<string, Choice> => JSON.parse(snapshot());
const writeDrafts = (d: Record<string, Choice>) => {
  const json = JSON.stringify(d);
  try {
    if (Object.keys(d).length) sessionStorage.setItem(DRAFTS, json);
    else sessionStorage.removeItem(DRAFTS);
  } catch {
    memoryDrafts = json;
  }
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The withheld tax for a choice, or null (none / an unreadable rate). The PPN split, when chosen, is part of the gross. */
function withheld(i: ReviewItem, c: Choice): bigint | null {
  if (!c.wht || c.wht === "none") return null;
  const ppn = (i.amount.startsWith("-") ? c.tax === "PPN_MASUKAN" : c.tax === "PPN_KELUARAN") ? PPN_EFFECTIVE_PERCENT : 0n;
  try {
    return grossUpWithholding(BigInt(i.amount), c.rate ?? DEFAULT_RATE[c.wht as WithholdingKind], ppn);
  } catch {
    return null;
  }
}

export function ReviewQueue({
  items,
  accounts,
  scope,
  clientId,
  simpleGuesses = 0,
  aiReady = true,
  canSetUpAi = false,
  aiRun = null,
}: {
  items: ReviewItem[];
  accounts: AccountOption[];
  scope: { entityIds: string[]; period: string };
  clientId?: string;
  /** Lines in scope that only have the simple guess (the AI gave none at import): offer to ask again. */
  simpleGuesses?: number;
  /** An AI key and model are set (Pengaturan or env): asking again can work. */
  aiReady?: boolean;
  /** The member may set the AI key (admin): the banner links to Pengaturan. */
  canSetUpAi?: boolean;
  /** The client's background AI run: while it runs, its progress replaces *Minta saran AI* (a second click would only join it). */
  aiRun?: AiRunView | null;
}) {
  const router = useRouter();
  const ai = useAiRun(clientId, aiRun);
  const aiRunning = ai.run?.status === "RUNNING";
  const [done, setDone] = useState<Set<string>>(new Set());
  // The active card is tracked by id, so refreshes and accepts elsewhere in the list never move it to another transaction.
  const [activeId, setActiveId] = useState<string | null>(null);
  const draftsJson = useSyncExternalStore(subscribe, snapshot, () => "{}");
  const choice = useMemo<Record<string, Choice>>(() => JSON.parse(draftsJson), [draftsJson]);
  // Only the bulk "serupa" action blocks the queue; single accepts are optimistic (the card leaves at once, saves run in order).
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(0);
  // Saves run one after another in acceptance order: the last decision on a merchant key is the one Memory keeps.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [saving, setSaving] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const open = useMemo(() => items.filter((i) => !done.has(i.id)), [items, done]);
  const counts = useMemo(() => ({ all: open.length, in: open.filter((i) => !i.amount.startsWith("-")).length, out: open.filter((i) => i.amount.startsWith("-")).length, guess: open.filter((i) => i.guess).length }), [open]);
  const visible = useMemo(() => {
    const q = query.trim().toUpperCase();
    const digits = q.replace(/[.,\s]/g, "");
    return open.filter((i) => {
      if (filter === "in" && i.amount.startsWith("-")) return false;
      if (filter === "out" && !i.amount.startsWith("-")) return false;
      if (filter === "guess" && !i.guess) return false;
      if (!q) return true;
      return i.description.toUpperCase().includes(q) || (/^\d+$/.test(digits) && i.amount.replace("-", "").includes(digits));
    });
  }, [open, query, filter]);
  const active = Math.max(0, visible.findIndex((i) => i.id === activeId));
  const focus = (idx: number) => {
    const next = visible[Math.max(0, Math.min(idx, visible.length - 1))];
    if (next) setActiveId(next.id);
  };
  // Keyboard moves and accepts bring the active card into view (the list can be long).
  useEffect(() => {
    if (activeId) document.querySelector(`[data-review-id="${activeId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);
  const nameOf = (code: string | null) => accounts.find((a) => a.code === code)?.name ?? "—";

  const suggestion = (i: ReviewItem): Choice => ({ code: i.suggestedCode ?? "", tax: i.taxTag ?? "none", rule: false });
  const get = (i: ReviewItem) => choice[i.id] ?? suggestion(i);
  // A save reads the store at the moment of the click, not the render the handler came from: an account picked a moment before
  // *Simpan* is the one saved, even if React has not re-rendered in between.
  const latest = (i: ReviewItem) => readDrafts()[i.id] ?? suggestion(i);
  const isChanged = (i: ReviewItem, c: Choice) => c.code !== (i.suggestedCode ?? "") || c.tax !== (i.taxTag ?? "none") || (!!c.wht && c.wht !== "none");
  const unsaved = (i: ReviewItem) => !!choice[i.id] && (isChanged(i, choice[i.id]) || choice[i.id].rule);

  const set = (i: ReviewItem, patch: Partial<Choice>) => {
    const all = readDrafts();
    writeDrafts({ ...all, [i.id]: { ...(all[i.id] ?? suggestion(i)), ...patch } });
  };
  const clearDraft = (id: string) => {
    const all = readDrafts();
    delete all[id];
    writeDrafts(all);
  };

  // Leaving the tab with an unsaved correction or a save still running asks first (drafts are kept either way).
  const hasUnsaved = visible.some(unsaved) || saving > 0;
  useEffect(() => {
    if (!hasUnsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsaved]);

  const settle = useCallback(() => {
    inFlight.current -= 1;
    setSaving(inFlight.current);
    if (inFlight.current === 0) router.refresh();
  }, [router]);

  const accept = (i: ReviewItem) => {
    const c = latest(i);
    if (!c.code) return void toast.error("Pilih akun dulu");
    const tax = withheld(i, c);
    if (c.wht && c.wht !== "none" && tax === null) return void toast.error("Tarif pemotongan tidak terbaca. Tulis persen, mis. 2 atau 1,5.");
    // Optimistic: the next card is active at once, so Enter keeps working while this one saves.
    setDone((d) => new Set(d).add(i.id));
    // Accepting the active card moves to the next one (or the previous at the end); accepting another card keeps the active one.
    const at = visible.findIndex((v) => v.id === i.id);
    if (at === active) setActiveId((visible[at + 1] ?? visible[at - 1])?.id ?? null);
    inFlight.current += 1;
    setSaving(inFlight.current);
    const withholding = tax !== null ? { kind: c.wht as WithholdingKind, amount: formatMoney(tax, i.currency, { bare: true }) } : undefined;
    const save = () => reviewAction({ bankTxId: i.id, accountCode: c.code, taxTag: c.tax === "none" ? null : (c.tax as never), createRule: c.rule, withholding }).then((r) => {
      if (!r.ok) {
        setDone((d) => {
          const n = new Set(d);
          n.delete(i.id);
          return n;
        });
        toast.error(r.error);
      } else {
        clearDraft(i.id);
        toast.success(`${c.code} ${nameOf(c.code)}`, {
          description: c.rule
            ? "Aturan baru dibuat"
            : r.learned
              ? "Buku Besar diperbarui · pilihan ini dipakai lagi di impor berikutnya"
              : i.guess && !isChanged(i, c)
                ? "Buku Besar diperbarui · tebakan tidak diingat; centang Selalu gunakan akun ini bila memang begitu"
                : "Buku Besar diperbarui · keterangannya tidak menyebut pengirim atau penerima, jadi tidak diingat",
        });
      }
      settle();
    });
    queue.current = queue.current.then(save, save);
  };

  const acceptSimilar = async (i: ReviewItem) => {
    const c = latest(i);
    if (!c.code) return void toast.error("Pilih akun dulu");
    setBusy(i.id);
    const override = isChanged(i, c) ? { accountCode: c.code, taxTag: c.tax === "none" ? null : (c.tax as never) } : undefined;
    const r = await acceptSimilarAction(i.id, scope, override);
    setBusy(null);
    if (!r.ok) return void toast.error(r.error);
    for (const id of r.ids) clearDraft(id);
    // Keep the place in the list: the first remaining card from the active one on.
    const left = new Set(r.ids);
    setActiveId((visible.slice(active).find((v) => !left.has(v.id)) ?? visible.find((v) => !left.has(v.id)))?.id ?? null);
    setDone((d) => new Set([...d, ...r.ids]));
    toast.success(`${r.ids.length} transaksi serupa dicatat ke ${c.code} ${nameOf(c.code)}`);
    router.refresh();
  };

  // Confident suggestions the reviewer hasn't touched: accepted in one click, in order, through the same saves as Enter.
  // A line with an open accountant hint (capex, a down payment, missing withholding) is never accepted in bulk: it needs a look.
  const hintsFor = (i: ReviewItem, c = get(i)) => accountantHints({ description: i.description, amount: BigInt(i.amount), account: accounts.find((o) => o.code === c.code) ?? null, wht: c.wht ?? "none", entityKind: i.entityKind ?? "PT" });
  const sure = visible.filter((i) => i.method === "AI" && i.confidence >= 0.8 && !unsaved(i) && i.suggestedCode);
  const confident = sure.filter((i) => hintsFor(i).length === 0);
  const hinted = sure.length - confident.length;
  const acceptConfident = () => {
    for (const i of confident) accept(i);
    toast.success(`${confident.length} usulan diterima`);
  };

  const [asking, setAsking] = useState(false);
  const askAi = async () => {
    if (!clientId) return;
    setAsking(true);
    const r = await suggestAgainAction(clientId, scope);
    setAsking(false);
    if (!r.ok) return void toast.error(r.error);
    // The progress line takes over from the button at once; it says the rest.
    if (r.aiRun) ai.adopt(r.aiRun);
    else toast.info("Tidak ada transaksi yang perlu ditanyakan ke AI.");
    router.refresh();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("input, textarea, [role=combobox], [role=listbox], [role=dialog]")) return;
      // Enter on a focused button or checkbox does that control's own action, not "accept the active card".
      if (e.key === "Enter" && el?.closest?.("button, a, [role=button], [role=checkbox], [role=option], select")) return;
      if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); focus(active + 1); }
      if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); focus(active - 1); }
      if (e.key === "Enter" && visible[active] && busy === null) {
        e.preventDefault();
        const i = visible[active];
        // A simple guess is nobody's decision: Enter opens its account instead of posting it (the button still accepts).
        if (i.guess && !unsaved(i)) {
          toast.info("Ini hanya tebakan. Pilih akunnya, atau klik Terima bila memang benar.");
          document.querySelector<HTMLElement>(`[data-review-id="${i.id}"] [aria-label="Akun"]`)?.focus();
          return;
        }
        accept(i);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const savingNote = saving > 0 && (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid="review-saving">
      <Loader2 className="size-3 animate-spin" /> Menyimpan {saving}…
    </span>
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2" data-testid="review-toolbar">
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cari keterangan atau nominal" aria-label="Cari transaksi" className="h-8 w-64 max-w-full" />
      <div className="flex flex-wrap gap-1" role="group" aria-label="Saring transaksi">
        {([["all", "Semua"], ["in", "Uang masuk"], ["out", "Uang keluar"], ["guess", "Tebakan"]] as const).map(([key, label]) => (
          <Button key={key} size="sm" variant={filter === key ? "default" : "outline"} aria-pressed={filter === key} onClick={() => setFilter(key)} disabled={key !== "all" && counts[key] === 0}>
            {label} <span className="num text-xs opacity-80">{counts[key]}</span>
          </Button>
        ))}
      </div>
      {confident.length > 1 && (
        <Button size="sm" variant="outline" className="ml-auto" disabled={busy !== null} onClick={acceptConfident} data-testid="accept-confident">
          <CheckCheck /> Terima {confident.length} usulan AI yakin (≥ 80%)
        </Button>
      )}
      {confident.length > 1 && hinted > 0 && <span className="text-xs text-muted-foreground">{hinted} usulan dengan petunjuk dicek satu per satu</span>}
    </div>
  );

  if (open.length === 0) {
    return (
      <div className="rounded-lg border bg-card px-6 py-12 text-center">
        <CheckCheck className="mx-auto size-8 text-pass" />
        <div className="mt-2 font-medium">Antrean kosong</div>
        <p className="text-sm text-muted-foreground">Tidak ada transaksi menunggu review dalam cakupan ini.</p>
        {savingNote && <div className="mt-2">{savingNote}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="num font-medium text-foreground" data-testid="review-count">{open.length} menunggu</span>
        <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> pindah</span>
        <span><Kbd>Enter</Kbd> terima usulan</span>
        {simpleGuesses > 0 && <span>Tebakan tidak diterima dengan Enter: pilih akunnya sendiri</span>}
        {savingNote}
      </div>
      {ai.run && ai.watched && <AiRunStatus run={ai.run} variant="line" className="rounded-lg border bg-card px-4 py-3" />}
      {simpleGuesses > 0 && clientId && !aiRunning && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-review/40 bg-review-subtle px-4 py-3 text-sm" data-testid="simple-guesses">
          {aiReady ? (
            <>
              <span>{simpleGuesses} transaksi belum punya saran AI.</span>
              <Button variant="outline" size="sm" disabled={asking} onClick={askAi}>
                {asking && <Loader2 className="animate-spin" />} Minta saran AI untuk {simpleGuesses} transaksi
              </Button>
            </>
          ) : (
            <>
              <span>{simpleGuesses} transaksi hanya punya tebakan sederhana karena AI belum diatur. Pilih akunnya langsung{canSetUpAi ? ", atau atur AI dulu." : "; admin bisa mengisi kunci AI di Pengaturan."}</span>
              {canSetUpAi && (
                <Link href="/settings" className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Atur AI di Pengaturan
                </Link>
              )}
            </>
          )}
        </div>
      )}
      {toolbar}
      {visible.length === 0 && <p className="rounded-lg border bg-card px-4 py-6 text-center text-sm text-muted-foreground">Tidak ada transaksi yang cocok dengan pencarian atau saringan ini.</p>}
      <ul className="space-y-2" data-testid="review-list">
        {visible.map((i, idx) => {
          const c = get(i);
          const amt = BigInt(i.amount);
          const changed = isChanged(i, c);
          const tax = withheld(i, c);
          return (
            <li
              key={i.id}
              onClick={() => setActiveId(i.id)}
              data-testid="review-item"
              data-review-id={i.id}
              className={cn("rounded-lg border bg-card p-4", idx === active && "ring-2 ring-primary/40")}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{i.date}</span>·<span>{i.entity}</span>·<span>{i.bank}</span>
                  </div>
                  <div className="mt-1 break-words font-mono text-sm">{i.description}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-muted-foreground">{amt > 0n ? "Uang masuk" : "Uang keluar"}</div>
                  <div className="num text-lg font-semibold">{formatMoney(amt < 0n ? -amt : amt, i.currency)}</div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <MethodBadge method={i.method} />
                <span>{i.reason.replace(/^AI: /, "")}</span>
                {i.method === "AI" && (
                  <span className={cn("num text-xs", i.confidence < 0.7 && "font-medium text-review")}>
                    · {i.confidence < 0.7 ? "keyakinan rendah, cek lagi" : "keyakinan"} {Math.round(i.confidence * 100)}%
                  </span>
                )}
              </div>
              {(() => {
                const hints = hintsFor(i, c);
                return hints.length > 0 && (
                  <ul className="mt-3 space-y-1.5" data-testid="review-hints">
                    {hints.map((h) => (
                      <li key={h.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 border-review py-1 pl-3 text-sm">
                        <CircleAlert className="size-4 shrink-0 text-review" aria-hidden />
                        <span className="min-w-0 flex-1">{h.text}</span>
                        {h.apply && (
                          <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); set(i, h.apply!); }}>{h.applyLabel}</Button>
                        )}
                      </li>
                    ))}
                  </ul>
                );
              })()}
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
                <AccountPicker value={c.code} onChange={(v) => set(i, { code: v })} options={accounts} ariaLabel="Akun" className="w-80 max-w-full" />
                <Select modal={false} value={c.tax} onValueChange={(v) => set(i, { tax: v as string })}>
                  <SelectTrigger className="w-56" aria-label="Pajak">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TAX.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select modal={false} value={c.wht ?? "none"} onValueChange={(v) => set(i, { wht: v as string, rate: v === "none" ? undefined : DEFAULT_RATE[v as WithholdingKind] })}>
                  <SelectTrigger className="w-60" aria-label="Pemotongan PPh">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WHT[amt > 0n ? "IN" : "OUT"].map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                {c.wht && c.wht !== "none" && (
                  <span className="inline-flex items-center gap-1 text-sm text-muted-foreground" data-testid="withholding">
                    <Input aria-label="Tarif pemotongan (%)" value={c.rate ?? ""} onChange={(e) => set(i, { rate: e.target.value })} inputMode="decimal" className="h-8 w-14 text-right" />%
                    {tax !== null && (
                      <span className="num text-xs">
                        · bruto {formatMoney((amt < 0n ? -amt : amt) + tax, i.currency)} · {WITHHOLDING_LABEL[c.wht as WithholdingKind]} {formatMoney(tax, i.currency)}
                      </span>
                    )}
                  </span>
                )}
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Checkbox id={`rule-${i.id}`} aria-label="Selalu gunakan akun ini" checked={c.rule} onCheckedChange={(v) => set(i, { rule: Boolean(v) })} />
                  <label htmlFor={`rule-${i.id}`} className="cursor-pointer">Selalu gunakan akun ini</label>
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {unsaved(i) && <span className="text-xs font-medium text-review" data-testid="unsaved">Belum disimpan</span>}
                  {i.similar > 1 && !(c.wht && c.wht !== "none") && (
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => acceptSimilar(i)}>
                      {busy === i.id && <Loader2 className="animate-spin" />}
                      {changed ? `Simpan untuk ${i.similar} serupa` : `Terima ${i.similar} serupa`}
                    </Button>
                  )}
                  <SplitDialog
                    bankTxId={i.id}
                    amount={i.amount}
                    currency={i.currency}
                    accounts={accounts}
                    onDone={() => {
                      clearDraft(i.id);
                      setDone((d) => new Set(d).add(i.id));
                      router.refresh();
                    }}
                  />
                  <Button size="sm" variant={idx === active ? "default" : "outline"} disabled={busy !== null} onClick={() => accept(i)} data-testid="accept">
                    <Check /> {changed ? "Simpan" : "Terima"}
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
