"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Circle, FileText, FileUp, FolderDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusPill } from "@/components/app/status";
import { SimpleSelect } from "@/components/app/simple-select";
import { AiRunStatus, useAiRun } from "@/components/app/ai-run-status";
import { useAccess, WriteBlockedNote } from "@/components/app/access-context";
import {
  inboxBatchAction,
  inboxCheckFileAction,
  inboxConfirmAction,
  inboxDriveFileAction,
  inboxDriveListAction,
  inboxPlanAction,
  inboxProcessNextAction,
  inboxSkipAction,
  inboxUnlockAction,
} from "@/app/actions";
import type { InboxItem } from "@/lib/inbox/check";
import type { ConfirmError, InboxPlan, NewAccount } from "@/lib/inbox/plan";
import type { AiRunView } from "@/lib/ai/run";
import { batchSummary, itemSummary, lineMessage, needsManualPath, OPEN_STATUSES, statusView } from "@/lib/inbox/view";
import { MAX_UPLOAD_BYTES, UPLOAD_TOO_BIG } from "@/lib/upload";
import { cn } from "@/lib/utils";

/**
 * The Unggah page's inbox (cycle 2026-10-10-unggah-inbox): drop any number of files or paste a Drive folder link; every file gets a line
 * that stays. Each step is its own short server action — check one file, plan the drop, unlock / confirm, process one file — so no
 * request handles the whole drop. The page asks only what Buku can't read: one password for the drop, then one card for new rekening.
 */

/** The manual single-file path's tab (`?tab=`); the old `statement` / `ledger` links land there too. */
export const MANUAL_TAB = "cara-lain";
const HISTORY_TAB = "riwayat";
const MANUAL_ANCHOR = "sumber-lain";

type Line = { key: string; fileName: string; item: InboxItem | null; checking: boolean; error: string | null };
type Phase = "idle" | "checking" | "password" | "confirm" | "processing" | "resume" | "done";
type Drive = "ready" | "disconnected" | "off";

const NEW_OWNER = "__new_owner__";
const OFFLINE = "Koneksi terputus. Periksa internet lalu coba lagi.";
const accountKey = (a: Pick<NewAccount, "bank" | "number">) => `${a.bank}|${a.number}`;
const lineOf = (item: InboxItem): Line => ({ key: item.id, fileName: item.fileName, item, checking: false, error: null });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends the page to the manual path under *Cara lain* without a server round trip (the tabs follow `?tab=`). */
function openManualTab() {
  const url = new URL(window.location.href);
  url.searchParams.set("tab", MANUAL_TAB);
  window.history.replaceState(null, "", url);
  document.getElementById(MANUAL_ANCHOR)?.scrollIntoView({ block: "start" });
}

/** `handedOver`: Dokumen's *Bukukan lewat Unggah* opened the page on its drop (`?lanjut=<batchId>`) — it books at once when nothing needs asking. */
export function UnggahInbox({ clientId, initial, drive, aiRun: pageRun = null, handedOver = false }: { clientId: string; initial: { batchId: string | null; items: InboxItem[] }; drive: Drive; aiRun?: AiRunView | null; handedOver?: boolean }) {
  const router = useRouter();
  const { canWrite } = useAccess();
  const ai = useAiRun(clientId, pageRun);
  const [batchId, setBatchId] = useState<string | null>(initial.batchId);
  // Passwords that opened this drop's files, offered again when booking: a server without SETTINGS_SECRET keeps none. Memory only.
  const opened = useRef<string[]>([]);
  const [lines, setLines] = useState<Line[]>(() => initial.items.map(lineOf));
  const [phase, setPhase] = useState<Phase>(() => (initial.items.length && !initial.items.some((i) => OPEN_STATUSES.includes(i.status)) ? "done" : "idle"));
  const [plan, setPlan] = useState<InboxPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [ranAi, setRanAi] = useState(false);
  const [drag, setDrag] = useState(false);
  const [driveUrl, setDriveUrl] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [owners, setOwners] = useState<Record<string, string>>({});
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [confirmErrors, setConfirmErrors] = useState<ConfirmError[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const upsert = (item: InboxItem) =>
    setLines((prev) => (prev.some((l) => l.key === item.id) ? prev.map((l) => (l.key === item.id ? lineOf(item) : l)) : [...prev, lineOf(item)]));
  const showPlanLines = (next: InboxPlan) => setLines((prev) => [...next.items.map(lineOf), ...prev.filter((l) => !l.item)]);

  /** Books the drop's files one request at a time until none is left, updating each line as its answer arrives. */
  async function processAll(id: string) {
    setPhase("processing");
    setError(null);
    let ok = true;
    let idle = 0;
    for (let guard = 0; guard < 1000; guard++) {
      const r = await inboxProcessNextAction(clientId, id, opened.current).catch(() => ({ ok: false as const, error: OFFLINE }));
      if (!r.ok) {
        setError(r.error);
        ok = false;
        break;
      }
      setRemaining(r.remaining);
      if (r.aiRun) {
        ai.adopt(r.aiRun);
        setRanAi(true);
      }
      if (r.item) {
        upsert(r.item);
        idle = 0;
        if (r.remaining === 0) break;
      } else if (r.remaining > 0 && idle++ < 30) {
        // Another tab is booking this drop's last files: wait for it rather than stop half-way.
        await wait(2000);
      } else break;
    }
    // The final plan: a file the keyring no longer opens asks again; otherwise every line is final.
    const next = await inboxPlanAction(clientId, id).catch(() => null);
    router.refresh();
    if (next?.ok) apply(next.plan, ok);
    else setPhase(ok ? "done" : "resume");
  }

  /** Shows what the plan still needs, in order: the password, then the confirm card; else waiting files offer *Lanjutkan*. */
  function apply(next: InboxPlan, finished = true) {
    setPlan(next);
    showPlanLines(next);
    const card = next.newAccounts.some((a) => !a.blocked) || next.numberless.length > 0;
    const waiting = next.items.filter((i) => i.status === "CHECKED" || i.status === "PROCESSING").length;
    setRemaining(waiting);
    if (next.needsPassword.length) {
      setPhase("password");
    } else if (card) {
      setOwners((prev) => {
        const o: Record<string, string> = {};
        for (const a of next.newAccounts.filter((x) => !x.blocked)) {
          const proposed = a.proposed && "entityId" in a.proposed ? a.proposed.entityId : NEW_OWNER;
          o[accountKey(a)] = prev[accountKey(a)] ?? proposed;
        }
        return o;
      });
      setPicks((prev) => Object.fromEntries(next.numberless.map((n) => [n.itemId, prev[n.itemId] ?? ""])));
      setPhase("confirm");
    } else if (waiting || !finished) {
      setPhase("resume");
    } else {
      setPhase("done");
    }
  }

  /** After a check, the password or the card: books at once when nothing is asked, else shows what is. */
  async function continueWith(next: InboxPlan) {
    const asks = next.needsPassword.length || next.newAccounts.some((a) => !a.blocked) || next.numberless.length;
    if (!asks && next.items.some((i) => i.status === "CHECKED" || i.status === "PROCESSING")) {
      setPlan(next);
      showPlanLines(next);
      await processAll(next.items[0].batchId);
    } else apply(next);
  }

  // After a reload: an interrupted drop shows what it still needs (a member who can only read sees the lines). A drop handed over from
  // Dokumen carries on as far as it can alone, like a fresh drop; the flag leaves the URL so a later reload asks for *Lanjutkan* again.
  const resumed = useRef(false);
  useEffect(() => {
    if (handedOver) {
      const url = new URL(window.location.href);
      url.searchParams.delete("lanjut");
      window.history.replaceState(null, "", url);
    }
    if (resumed.current || !canWrite || !initial.batchId || !initial.items.some((i) => OPEN_STATUSES.includes(i.status))) return;
    resumed.current = true;
    const id = initial.batchId;
    void (async () => {
      const r = await inboxPlanAction(clientId, id).catch(() => null);
      if (!r) return;
      if (!r.ok) setError(r.error);
      else if (handedOver) {
        setBusy(true);
        try {
          await continueWith(r.plan);
        } finally {
          setBusy(false);
        }
      } else apply(r.plan);
    })();
    // Runs once for the server's batch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Checks the drop's files one by one (each stored and read), then plans the drop and carries on as far as it can alone. */
  async function intake(names: { key: string; fileName: string; tooBig?: boolean }[], check: (index: number, id: string) => Promise<{ ok: true; item: InboxItem } | { ok: false; error: string }>) {
    const id = crypto.randomUUID();
    opened.current = [];
    setBatchId(id);
    setPlan(null);
    setRanAi(false);
    setConfirmErrors([]);
    setPassword("");
    setPasswordError(null);
    setLines(names.map((n) => ({ key: n.key, fileName: n.fileName, item: null, checking: !n.tooBig, error: n.tooBig ? UPLOAD_TOO_BIG : null })));
    setPhase("checking");
    setProgress({ done: 0, total: names.length });
    let stored = 0;
    for (const [index, n] of names.entries()) {
      if (!n.tooBig) {
        const r = await check(index, id).catch(() => ({ ok: false as const, error: OFFLINE }));
        if (r.ok) stored++;
        const item = r.ok ? r.item : null;
        const message = r.ok ? null : r.error;
        setLines((prev) => prev.map((l) => (l.key === n.key ? (item ? lineOf(item) : { ...l, checking: false, error: message }) : l)));
      }
      setProgress({ done: index + 1, total: names.length });
    }
    setProgress(null);
    if (!stored) {
      setPhase("done");
      return;
    }
    const r = await inboxPlanAction(clientId, id).catch(() => ({ ok: false as const, error: OFFLINE }));
    if (!r.ok) {
      setError(r.error);
      setPhase("resume");
      return;
    }
    await continueWith(r.plan);
  }

  async function dropFiles(list: FileList | File[] | null) {
    const files = [...(list ?? [])];
    if (!files.length || busy || !canWrite) return;
    setBusy(true);
    setError(null);
    try {
      await intake(
        files.map((f, i) => ({ key: `file-${i}`, fileName: f.name, tooBig: f.size > MAX_UPLOAD_BYTES })),
        (index, id) => {
          const fd = new FormData();
          fd.set("batchId", id);
          fd.set("file", files[index]);
          return inboxCheckFileAction(clientId, fd);
        },
      );
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function fetchDrive() {
    if (!driveUrl.trim() || busy || !canWrite) return;
    setBusy(true);
    setError(null);
    try {
      const listed = await inboxDriveListAction(clientId, driveUrl.trim()).catch(() => ({ ok: false as const, error: OFFLINE }));
      if (!listed.ok) {
        setError(listed.error);
        return;
      }
      if (!listed.files.length) {
        setError("Folder ini tidak berisi file yang bisa dibaca Buku.");
        return;
      }
      const files = listed.files;
      await intake(
        files.map((f) => ({ key: `drive-${f.id}`, fileName: f.name })),
        (index, id) => inboxDriveFileAction(clientId, id, files[index].id, files[index].resourceKey),
      );
      setDriveUrl("");
    } finally {
      setBusy(false);
    }
  }

  async function unlock() {
    if (!batchId || !plan || !password.trim()) return;
    setBusy(true);
    setPasswordError(null);
    const before = plan.needsPassword.length;
    try {
      const r = await inboxUnlockAction(clientId, batchId, password).catch(() => ({ ok: false as const, error: OFFLINE }));
      if (!r.ok) {
        setPasswordError(r.error);
        return;
      }
      const left = r.plan.needsPassword.length;
      if (left < before && !opened.current.includes(password.trim())) opened.current = [...opened.current, password.trim()].slice(-10);
      setPassword("");
      if (left === before) setPasswordError(`Kata sandi ini tidak membuka ${left === 1 ? "file terkunci" : `${left} file terkunci`}. Coba kata sandi lain.`);
      else if (left) setPasswordError(`${left} file masih terkunci dengan kata sandi lain.`);
      await continueWith(r.plan);
    } finally {
      setBusy(false);
    }
  }

  async function skip(itemIds: string[]) {
    if (!batchId || !itemIds.length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await inboxSkipAction(clientId, batchId, itemIds).catch(() => ({ ok: false as const, error: OFFLINE }));
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setConfirmErrors([]);
      setPasswordError(null);
      await continueWith(r.plan);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!batchId || !plan) return;
    const accounts = plan.newAccounts
      .filter((a) => !a.blocked)
      .map((a) => {
        const choice = owners[accountKey(a)];
        const target = choice && choice !== NEW_OWNER ? { entityId: choice } : { newOwner: { name: a.proposed && "newOwner" in a.proposed ? a.proposed.newOwner.name : (a.holder ?? "Pemilik") } };
        return { bank: a.bank, number: a.number, target, ...(a.overdraft ? { overdraft: true } : {}) };
      });
    const numberless = plan.numberless.filter((n) => picks[n.itemId]).map((n) => ({ itemId: n.itemId, bankAccountId: picks[n.itemId] }));
    setBusy(true);
    setError(null);
    try {
      const r = await inboxConfirmAction(clientId, batchId, { accounts, numberless }).catch(() => ({ ok: false as const, error: OFFLINE }));
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setConfirmErrors(r.errors);
      await continueWith(r.plan);
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    if (!batchId) return;
    setBusy(true);
    try {
      const r = await inboxBatchAction(clientId, batchId).catch(() => null);
      if (r?.ok) setLines((prev) => [...r.items.map(lineOf), ...prev.filter((l) => !l.item)]);
      await processAll(batchId);
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || !canWrite;
  const items = lines.flatMap((l) => (l.item ? [l.item] : []));
  const cardAccounts = plan?.newAccounts.filter((a) => !a.blocked) ?? [];
  const blocked = plan?.newAccounts.filter((a) => a.blocked) ?? [];
  const cardItemIds = [...new Set([...cardAccounts.flatMap((a) => a.itemIds), ...(plan?.numberless.map((n) => n.itemId) ?? [])])];
  const picksMissing = (plan?.numberless ?? []).some((n) => n.options.length > 0 && !picks[n.itemId]);
  const status =
    phase === "checking" && progress ? `Memeriksa file ${Math.min(progress.done + 1, progress.total)} dari ${progress.total}…`
    : phase === "processing" ? `Membukukan… ${remaining} file lagi.`
    : phase === "done" && items.length ? batchSummary(items)
    : null;

  return (
    <div className="space-y-4" data-testid="unggah-inbox">
      <Card>
        <CardContent className="space-y-4">
          <button
            type="button"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              if (!disabled) setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              void dropFiles(e.dataTransfer.files);
            }}
            className={cn(
              "flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              drag ? "border-primary bg-primary-subtle" : "border-input bg-muted/40 hover:bg-muted",
            )}
            data-testid="inbox-drop"
          >
            {busy ? <Loader2 className="size-6 animate-spin text-primary" aria-hidden /> : <FileUp className="size-6 text-primary" aria-hidden />}
            <span className="max-w-prose text-balance">Tarik file klien ke sini — rekening koran, buku besar, neraca, atau dokumen lain. Bisa banyak sekaligus.</span>
            <span className="text-xs text-muted-foreground">
              <span className="font-medium text-primary">Pilih file</span> · maks. 5 MB per file · baris yang sudah pernah diimpor otomatis dilewati
            </span>
          </button>
          <input ref={inputRef} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden data-testid="inbox-file-input" onChange={(e) => void dropFiles(e.target.files)} />
          {drive === "ready" && (
            <Field>
              <FieldLabel htmlFor="inbox-drive">Atau tempel tautan folder Google Drive</FieldLabel>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="inbox-drive"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="https://drive.google.com/drive/folders/…"
                  className="min-w-0 flex-1 basis-56"
                  value={driveUrl}
                  disabled={disabled}
                  onChange={(e) => setDriveUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void fetchDrive()}
                />
                <Button variant="outline" disabled={disabled || !driveUrl.trim()} onClick={() => void fetchDrive()}>
                  <FolderDown /> Ambil
                </Button>
              </div>
            </Field>
          )}
          {drive === "disconnected" && (
            <p className="text-sm text-muted-foreground">
              Atau ambil dari folder Google Drive: hubungkan Google dulu di <Link href="/documents" className="text-primary hover:underline">Dokumen</Link>.
            </p>
          )}
          {error && <p role="alert" className="text-sm text-fail" data-testid="inbox-error">{error}</p>}
          <WriteBlockedNote />
        </CardContent>
      </Card>

      {phase === "password" && plan && (
        <Card data-testid="inbox-password">
          <CardContent className="space-y-3">
            <Field>
              <FieldLabel htmlFor="inbox-pdf-password">Kata sandi PDF</FieldLabel>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="inbox-pdf-password"
                  type="password"
                  autoComplete="off"
                  autoFocus
                  className="min-w-0 flex-1 basis-48 sm:max-w-xs"
                  value={password}
                  disabled={disabled}
                  aria-invalid={!!passwordError}
                  aria-describedby="inbox-pdf-password-help"
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void unlock()}
                />
                <Button disabled={disabled || !password.trim()} onClick={() => void unlock()}>
                  {busy && <Loader2 className="animate-spin" />} Buka
                </Button>
              </div>
              <FieldDescription id="inbox-pdf-password-help">
                {plan.needsPassword.length === 1 ? "1 file terkunci." : `${plan.needsPassword.length} file terkunci.`} Dipakai untuk semua file terkunci di unggahan ini dan disimpan untuk klien ini.
              </FieldDescription>
              {passwordError && <p role="alert" className="text-sm text-fail">{passwordError}</p>}
            </Field>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void skip(plan.needsPassword)}>
              Lewati file terkunci
            </Button>
          </CardContent>
        </Card>
      )}

      {phase === "confirm" && plan && (
        <Card data-testid="inbox-confirm">
          <CardHeader>
            <CardTitle>Rekening baru dari file</CardTitle>
            <CardDescription>Periksa pemiliknya. Tambah & impor membuat rekeningnya lalu membukukan file-nya; Batal hanya menyimpan file-nya di Dokumen.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <ul className="divide-y border-y">
              {cardAccounts.map((a) => {
                const key = accountKey(a);
                const newOwner = a.proposed && "newOwner" in a.proposed ? a.proposed.newOwner.name : null;
                const options = [...plan.entities.map((e) => ({ value: e.id, label: e.name })), ...(newOwner ? [{ value: NEW_OWNER, label: `Pemilik baru: ${newOwner}` }] : [])];
                const failed = confirmErrors.find((e) => e.bank === a.bank && e.number.replace(/\D/g, "") === a.number);
                const id = `owner-${key.replace(/\W/g, "-")}`;
                return (
                  <li key={key} className="space-y-2 px-4 py-3" data-testid="inbox-new-account">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                      <span>
                        Rekening baru · {a.display}
                        {a.holder && <span className="font-normal text-muted-foreground"> a.n. {a.holder}</span>}
                      </span>
                      {a.overdraft && <Badge variant="outline" title="Saldo negatif: dicatat sebagai pinjaman rekening koran (PRK)">PRK</Badge>}
                    </p>
                    {options.length > 1 ? (
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <label htmlFor={id} className="text-muted-foreground">Milik</label>
                        <SimpleSelect id={id} label={`Pemilik ${a.display}`} className="max-w-xs flex-1 basis-48" value={owners[key] ?? ""} options={options} disabled={disabled} onChange={(v) => setOwners((o) => ({ ...o, [key]: v }))} />
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">{entityLabel(options, newOwner)}</p>
                    )}
                    {a.warning && <p className="text-sm text-review">{a.warning}</p>}
                    {failed && <p role="alert" className="text-sm text-fail">{failed.error}</p>}
                  </li>
                );
              })}
              {plan.numberless.map((n) => (
                <li key={n.itemId} className="space-y-2 px-4 py-3">
                  <p className="font-medium">
                    <span className="break-all font-mono text-xs">{n.fileName}</span>: pilih rekeningnya
                  </p>
                  {n.options.length ? (
                    <SimpleSelect
                      id={`pick-${n.itemId}`}
                      label={`Rekening untuk ${n.fileName}`}
                      className="max-w-sm"
                      placeholder="Pilih rekening"
                      value={picks[n.itemId] ?? ""}
                      disabled={disabled}
                      options={n.options.map((o) => ({ value: o.bankAccountId, label: `${o.label} · ${o.entity}` }))}
                      onChange={(v) => setPicks((p) => ({ ...p, [n.itemId]: v }))}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">Klien ini belum punya rekening untuk dipilih. Tambahkan rekening baru di atas dulu; file ini ditanyakan lagi sesudahnya.</p>
                  )}
                </li>
              ))}
              {blocked.map((a) => (
                <li key={accountKey(a)} className="px-4 py-3 text-sm text-muted-foreground">
                  {a.display} ({a.currency}) · {a.blocked}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2 px-4 pt-4">
              <Button disabled={disabled || picksMissing} onClick={() => void confirm()}>
                {busy && <Loader2 className="animate-spin" />} Tambah & impor
              </Button>
              <Button variant="outline" disabled={disabled} onClick={() => void skip(cardItemIds)}>
                Batal
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {phase === "resume" && remaining > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm" data-testid="inbox-resume">
          <p className="min-w-0 flex-1">{remaining === 1 ? "1 file belum selesai dibukukan." : `${remaining} file belum selesai dibukukan.`}</p>
          <Button size="sm" disabled={disabled} onClick={() => void resume()}>
            Lanjutkan
          </Button>
        </div>
      )}

      {lines.length > 0 && (
        <Card data-testid="inbox-list">
          <CardHeader>
            <CardTitle>Unggahan terakhir</CardTitle>
            {status && <CardDescription>{status}</CardDescription>}
          </CardHeader>
          <CardContent className="space-y-3 px-0">
            <ul className="divide-y border-y" aria-live="polite" aria-busy={busy}>
              {lines.map((l) => (
                <LineRow key={l.key} line={l} clientId={clientId} />
              ))}
            </ul>
            {(phase === "done" || phase === "resume") && ai.run && (ranAi || ai.run.status === "RUNNING") && <AiRunStatus run={ai.run} variant="line" className="px-4" />}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** The owner when only one fits: "Milik PT Maju" or "Pemilik baru: Budi Santoso". */
function entityLabel(options: { value: string; label: string }[], newOwner: string | null) {
  const only = options[0];
  if (only && only.value !== NEW_OWNER) return `Milik ${only.label}`;
  return `Pemilik baru: ${newOwner ?? "Pemilik"}`;
}

function LineStatus({ line }: { line: Line }) {
  if (line.checking) return <BusyLabel label="Memeriksa" />;
  if (!line.item) return <StatusPill status="FAIL" label="Gagal" />;
  const s = statusView(line.item.status);
  if (s.tone === "pass") return <StatusPill status="PASS" label={s.label} />;
  if (s.tone === "review") return <StatusPill status="REVIEW" label={s.label} />;
  if (s.tone === "fail") return <StatusPill status="FAIL" label={s.label} />;
  if (s.tone === "busy") return <BusyLabel label={s.label} />;
  const Icon = line.item.status === "KEPT" ? FileText : Circle;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap py-0.5 text-xs font-medium text-muted-foreground">
      <Icon className="size-3.5" aria-hidden />
      {s.label}
    </span>
  );
}

function BusyLabel({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap py-0.5 text-xs font-medium text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      {label}
    </span>
  );
}

function LineRow({ line, clientId }: { line: Line; clientId: string }) {
  const item = line.item;
  const waiting = item && OPEN_STATUSES.includes(item.status);
  const summary = item && waiting ? itemSummary(item) : "";
  const message = item ? lineMessage(item) : line.error;
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-3" data-testid="inbox-line" data-status={item?.status ?? (line.checking ? "UPLOADING" : "FAILED")}>
      <div className="min-w-0 flex-1 basis-60 space-y-1">
        <p className="break-all font-mono text-xs">{line.fileName}</p>
        {summary && <p className="num text-sm">{summary}</p>}
        {message && <p className={cn("text-sm whitespace-pre-line", item?.status === "FAILED" || !item ? "text-fail" : "text-muted-foreground")}>{message}</p>}
        {item?.status === "BOOKED" && item.kind === "LEDGER" && item.ledgerImportId && (
          <Link href={`/clients/${clientId}/import/ledger/${item.ledgerImportId}`} className="inline-flex items-center gap-0.5 text-sm font-medium text-primary hover:underline">
            Lihat impor buku besar <ChevronRight className="size-3.5" aria-hidden />
          </Link>
        )}
        {item?.status === "BOOKED" && item.kind === "BANK" && (
          <Link href={`/clients/${clientId}/review`} className="inline-flex items-center gap-0.5 text-sm font-medium text-primary hover:underline">
            Buka Review <ChevronRight className="size-3.5" aria-hidden />
          </Link>
        )}
        {item?.status === "DRAFT" && item.ledgerImportId && (
          <Link href={`/clients/${clientId}/import/ledger/${item.ledgerImportId}`} className="inline-flex items-center gap-0.5 text-sm font-medium text-primary hover:underline">
            Petakan akun <ChevronRight className="size-3.5" aria-hidden />
          </Link>
        )}
        {item && needsManualPath(item) && (
          <Button variant="outline" size="sm" className="mt-1" onClick={openManualTab}>
            Coba cara lain
          </Button>
        )}
      </div>
      <LineStatus line={line} />
    </li>
  );
}

/** The page's secondary tabs: the import history, and the single-file path (*Cara lain*). Follows `?tab=` without a server round trip. */
export function UnggahTabs({ history, manual }: { history: React.ReactNode; manual: React.ReactNode }) {
  const search = useSearchParams();
  const param = search.get("tab");
  const value = param === MANUAL_TAB || param === "ledger" || param === "statement" ? MANUAL_TAB : HISTORY_TAB;
  const choose = (next: string) => {
    const url = new URL(window.location.href);
    if (next === HISTORY_TAB) url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  };
  return (
    <Tabs value={value} onValueChange={(v) => choose(String(v))} id={MANUAL_ANCHOR} className="scroll-mt-4">
      <TabsList className="max-w-full justify-start overflow-x-auto">
        <TabsTrigger value={HISTORY_TAB}>Riwayat</TabsTrigger>
        <TabsTrigger value={MANUAL_TAB}>Cara lain</TabsTrigger>
      </TabsList>
      <TabsContent value={HISTORY_TAB} className="space-y-6">{history}</TabsContent>
      <TabsContent value={MANUAL_TAB} className="space-y-6">{manual}</TabsContent>
    </Tabs>
  );
}
