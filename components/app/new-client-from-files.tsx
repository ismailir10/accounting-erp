"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileUp, Loader2, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { NextStep } from "@/components/app/page-header";
import { StatusPill } from "@/components/app/status";
import { SimpleSelect } from "@/components/app/simple-select";
import { ClientForm } from "@/components/app/client-form";
import { addClientAction, inboxCheckFileAction, inboxSkipAction, previewClientFileAction } from "@/app/actions";
import type { BankSection } from "@/lib/inbox/check";
import { proposeClient, shortNameOf, type ClientProposal, type PreviewFile, type ProposedAccount, type ProposedKind } from "@/lib/inbox/propose";
import { itemSummary } from "@/lib/inbox/view";
import { MAX_UPLOAD_BYTES, UPLOAD_TOO_BIG } from "@/lib/upload";
import { cn } from "@/lib/utils";

/**
 * *Tambah klien* from files (cycle 2026-10-10-new-client-from-files): the client's name, its statements dropped, one card with the
 * companies, owners and rekening Buku read from them — every value editable — then *Buat klien & impor* creates the client through the
 * same validated path as the manual form and drops the same files into its Unggah, which books them. *Isi manual* is today's form.
 */

type Dropped = { key: string; file: File; preview: PreviewFile | null; error: string | null; reading: boolean; password?: string };
type CardEntity = { key: string; name: string; kind: ProposedKind; fromClientName?: boolean; fromProposal?: boolean; touched?: boolean; removed?: boolean };
export type CardState = { entities: CardEntity[]; owner: Record<string, string>; moved: Record<string, true> };

const OFFLINE = "Koneksi terputus. Periksa internet lalu coba lagi.";
const NEW_OWNER = "__new_owner__";
const KIND_OPTIONS: { value: ProposedKind; label: string }[] = [
  { value: "PT", label: "PT" },
  { value: "CV", label: "CV" },
  { value: "PERORANGAN", label: "Perorangan (pemilik)" },
];
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

/**
 * The card after (more) files were read: what the user decided stays (a rekening they moved, an entity they named, added or removed);
 * everything else follows the new proposal — a rekening first read without a holder moves to the company a later file names, and a
 * proposed entity nobody touched and no rekening uses any more goes.
 */
export function reconcile(p: ClientProposal, prev: CardState | null): CardState {
  const moved = prev?.moved ?? {};
  const owner: Record<string, string> = {};
  for (const e of p.entities) {
    for (const b of e.banks) {
      const kept = moved[b.key] ? prev?.owner[b.key] : undefined;
      owner[b.key] = kept && prev?.entities.some((x) => x.key === kept) ? kept : e.key;
    }
  }
  const used = new Set(Object.values(owner));
  const proposed = new Set(p.entities.map((e) => e.key));
  const entities = (prev?.entities ?? []).filter((x) => proposed.has(x.key) || used.has(x.key) || x.touched || x.removed || !x.fromProposal);
  for (const e of p.entities) if (!entities.some((x) => x.key === e.key)) entities.push({ key: e.key, name: e.name, kind: e.kind, fromClientName: e.fromClientName, fromProposal: true });
  return { entities, owner, moved };
}

/** The rekening keys a file's statements name (Rupiah, read, with a number): a file all of whose rekening were left out isn't booked. */
const fileAccounts = (f: PreviewFile) =>
  f.kind === "BANK" ? (f.sections as BankSection[]).filter((s) => !s.error && (s.currency ?? "IDR") === "IDR" && digits(s.number)).map((s) => `${s.bank}|${digits(s.number)}`) : [];

export function NewClientStart({ company, manual: manualAtStart }: { company: boolean; manual: boolean }) {
  const router = useRouter();
  const [manual, setManual] = useState(manualAtStart);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [industry, setIndustry] = useState("");
  const [dropped, setDropped] = useState<Dropped[]>([]);
  const [card, setCard] = useState<CardState | null>(null);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [focusError, setFocusError] = useState(0);
  const [created, setCreated] = useState<{ href: string; failed: string[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  // The first marked field takes the focus once the card is editable again, so the message is where the user is looking.
  useEffect(() => {
    if (focusError && !busy) document.querySelector<HTMLElement>("[data-testid=client-proposal] [aria-invalid=true], #client-name[aria-invalid=true]")?.focus();
  }, [focusError, busy]);

  const previews = useMemo(() => dropped.flatMap((d) => (d.preview ? [d.preview] : [])), [dropped]);
  const proposal = useMemo(() => (previews.length ? proposeClient(previews) : null), [previews]);
  const accounts = useMemo(() => new Map((proposal?.entities ?? []).flatMap((e) => e.banks.map((b) => [b.key, b] as const))), [proposal]);
  const locked = dropped.filter((d) => d.preview?.status === "NEEDS_PASSWORD");

  function setUrl(manualMode: boolean) {
    const url = new URL(window.location.href);
    if (manualMode) url.searchParams.set("manual", "1");
    else url.searchParams.delete("manual");
    window.history.replaceState(null, "", url);
  }
  function toManual(e?: React.MouseEvent) {
    e?.preventDefault();
    setManual(true);
    setUrl(true);
  }

  /** Reads the given files one by one (nothing stored), then updates the card. */
  async function read(list: Dropped[], offered?: string) {
    // Files read again (a password) keep their place; new ones go last.
    let next = [...dropped.map((d) => list.find((l) => l.key === d.key) ?? d), ...list.filter((l) => !dropped.some((d) => d.key === l.key))];
    const put = (d: Dropped) => {
      next = next.map((x) => (x.key === d.key ? d : x));
      setDropped(next);
    };
    setDropped(next);
    for (const [i, d] of list.entries()) {
      if (d.file.size > MAX_UPLOAD_BYTES) {
        put({ ...d, reading: false, error: UPLOAD_TOO_BIG });
        continue;
      }
      setStatus(`Membaca file ${i + 1} dari ${list.length}…`);
      const fd = new FormData();
      fd.set("file", d.file);
      if (offered) fd.set("password", offered);
      const r = await previewClientFileAction(fd).catch(() => ({ ok: false as const, error: OFFLINE }));
      if (r.ok) put({ ...d, reading: false, error: null, preview: r.file, ...(offered && r.file.status !== "NEEDS_PASSWORD" ? { password: offered } : {}) });
      else put({ ...d, reading: false, error: r.error });
    }
    setStatus(null);
    const files = next.flatMap((d) => (d.preview ? [d.preview] : []));
    if (!files.length) return next;
    const p = proposeClient(files);
    setCard((prev) => reconcile(p, prev));
    if (!nameTouched && p.clientName) setName((n) => n || p.clientName);
    return next;
  }

  async function drop(list: FileList | null) {
    const files = [...(list ?? [])];
    if (!files.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      await read(files.map((file) => ({ key: `f${seq.current++}`, file, preview: null, error: null, reading: true })));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function unlock() {
    const value = password.trim();
    if (!value || busy) return;
    setBusy(true);
    setPasswordError(null);
    try {
      const before = locked.length;
      const next = await read(locked.map((d) => ({ ...d, reading: true })), value);
      // Only an answer that came back still locked says the password is wrong; a lost request says why it was lost.
      const lost = next.find((d) => locked.some((l) => l.key === d.key) && d.error);
      if (lost) {
        setPasswordError(lost.error);
        return;
      }
      const left = next.filter((d) => d.preview?.status === "NEEDS_PASSWORD").length;
      setPassword("");
      if (left === before) setPasswordError(`Kata sandi ini tidak membuka ${left === 1 ? "file terkunci" : `${left} file terkunci`}. Coba kata sandi lain.`);
      else if (left) setPasswordError(`${left} file masih terkunci dengan kata sandi lain.`);
    } finally {
      setBusy(false);
    }
  }

  const dropField = (key: string) => setFields((f) => (key in f ? Object.fromEntries(Object.entries(f).filter(([k]) => k !== key)) : f));
  const entityName = (e: CardEntity) => (e.fromClientName && !e.touched ? name : e.name);
  const setEntity = (key: string, patch: Partial<CardEntity>) => setCard((c) => c && { ...c, entities: c.entities.map((e) => (e.key === key ? { ...e, ...patch } : e)) });
  function moveAccount(accountKey: string, target: string) {
    setCard((c) => {
      if (!c) return c;
      const moved = { ...c.moved, [accountKey]: true as const };
      if (target !== NEW_OWNER) return { ...c, owner: { ...c.owner, [accountKey]: target }, moved };
      const key = `pemilik-${seq.current++}`;
      return { entities: [...c.entities, { key, name: "", kind: "PERORANGAN" }], owner: { ...c.owner, [accountKey]: key }, moved };
    });
  }

  async function create() {
    if (!card || busy) return;
    let leaving = false;
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const active = card.entities.filter((e) => !e.removed);
      const banksOf = (key: string) => [...accounts.values()].filter((a) => card.owner[a.key] === key);
      const sent = active.map((e) => ({ entity: e, banks: banksOf(e.key) }));
      const r = await addClientAction({
        name,
        industry,
        entities: sent.map(({ entity, banks }) => {
          const n = entityName(entity).trim();
          return { name: n, shortName: shortNameOf(n, entity.kind), kind: entity.kind, npwp: "", banks: banks.map((b) => ({ bank: b.bank, number: b.number, label: "", isOverdraft: b.isOverdraft })) };
        }),
      }).catch(() => ({ ok: false as const, error: OFFLINE, fields: undefined }));
      if (!r.ok) {
        // The onboarding rules' field paths, back on the card's own rows.
        const marks: Record<string, string> = {};
        for (const [path, message] of Object.entries(r.fields ?? {})) {
          const m = /^entities\.(\d+)(?:\.banks\.(\d+))?/.exec(path);
          if (path === "name") marks.name = message;
          else if (m && m[2] !== undefined) marks[`bank:${sent[+m[1]]?.banks[+m[2]]?.key}`] = message;
          else if (m) marks[`entity:${sent[+m[1]]?.entity.key}`] = message;
        }
        setFields(marks);
        // One marked field already says it on its row; several are counted here too.
        setError(Object.keys(marks).length === 1 ? null : r.error);
        setFocusError((n) => n + 1);
        return;
      }

      // The same files into the new client's Unggah, as one drop: each stored and read there, with the password that opened it.
      const batchId = crypto.randomUUID();
      const uploads = dropped.filter((d) => d.file.size <= MAX_UPLOAD_BYTES);
      const leftOut = new Set([...accounts.keys()].filter((k) => !active.some((e) => e.key === card.owner[k])));
      const skip: string[] = [];
      const failed: string[] = [];
      for (const [i, d] of uploads.entries()) {
        setStatus(`Mengunggah file ${i + 1} dari ${uploads.length}…`);
        const fd = new FormData();
        fd.set("batchId", batchId);
        fd.set("file", d.file);
        if (d.password) fd.set("password", d.password);
        const u = await inboxCheckFileAction(r.clientId, fd).catch(() => ({ ok: false as const, error: OFFLINE }));
        if (!u.ok) {
          failed.push(`${d.file.name}: ${u.error}`);
          continue;
        }
        // A file whose every rekening was left out of the client stays in Dokumen only (Decision 3).
        const keys = d.preview ? fileAccounts(d.preview) : [];
        if (keys.length && keys.every((k) => leftOut.has(k))) skip.push(u.item.id);
      }
      if (skip.length) await inboxSkipAction(r.clientId, batchId, skip).catch(() => null);
      toast.success(`${name.trim()} ditambahkan`);
      if (failed.length) {
        // The client exists: say which files didn't reach it and why, and let the user go on to Unggah (where they can drop them again).
        setStatus(null);
        setCreated({ href: `/clients/${r.clientId}/import?lanjut=${batchId}`, failed });
        return;
      }
      setStatus("Membuka Unggah…");
      leaving = true;
      router.push(`/clients/${r.clientId}/import?lanjut=${batchId}`);
    } finally {
      // Navigating away: the button stays busy so a second click can't make the client twice.
      if (!leaving) setBusy(false);
    }
  }

  if (manual) {
    return (
      <div className="space-y-4">
        <NextStep>
          {company ? "Isi nama perusahaan dan entitasnya, lalu simpan." : "Isi nama klien dan perusahaannya, lalu simpan."} Setelah itu Anda diarahkan ke Impor untuk mengunggah rekening koran pertama.
        </NextStep>
        <p className="text-sm text-muted-foreground">
          Punya rekening korannya?{" "}
          <Link
            href="/clients/new"
            className="font-medium text-primary hover:underline"
            onClick={(e) => {
              e.preventDefault();
              setManual(false);
              setUrl(false);
            }}
          >
            Mulai dari file
          </Link>
        </p>
        <ClientForm defaults={{ name, industry }} />
      </div>
    );
  }

  const active = card?.entities.filter((e) => !e.removed) ?? [];
  const removed = card?.entities.filter((e) => e.removed) ?? [];
  const reading = dropped.some((d) => d.reading);
  const showCard = !!proposal && proposal.readable && !!card;
  const nothingRead = dropped.length > 0 && !reading && !locked.length && (!proposal || !proposal.readable);
  const ownerOptions = [...active.map((e) => ({ value: e.key, label: entityName(e).trim() || (e.kind === "PERORANGAN" ? "Pemilik baru" : "Perusahaan klien") })), { value: NEW_OWNER, label: "Pemilik baru…" }];

  return (
    <div className="space-y-4">
      <NextStep>
        {company ? "Tarik rekening koran perusahaan Anda, periksa usulan Buku, lalu buat bukunya." : "Isi nama klien dan tarik rekening korannya, periksa usulan Buku, lalu buat kliennya."}
      </NextStep>
      <Card>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="client-name">Nama klien</FieldLabel>
              <Input
                id="client-name"
                value={name}
                aria-invalid={!!fields.name}
                disabled={busy && !reading}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                  dropField("name");
                }}
                placeholder="mis. Grup Maju Bersama"
              />
              <FieldError>{fields.name}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="client-industry">Bidang usaha</FieldLabel>
              <Input id="client-industry" value={industry} disabled={busy && !reading} onChange={(e) => setIndustry(e.target.value)} placeholder="mis. distributor bahan bangunan" />
              <FieldDescription>Opsional. Dipakai AI sebagai konteks saat mengusulkan akun.</FieldDescription>
            </Field>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              if (!busy) setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              void drop(e.dataTransfer.files);
            }}
            className={cn(
              "flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              drag ? "border-primary bg-primary-subtle" : "border-input bg-muted/40 hover:bg-muted",
            )}
            data-testid="client-files-drop"
          >
            {busy ? <Loader2 className="size-6 animate-spin text-primary" aria-hidden /> : <FileUp className="size-6 text-primary" aria-hidden />}
            <span className="max-w-prose text-balance">Tarik rekening koran klien ke sini — Buku menyiapkan perusahaan, pemilik dan rekeningnya.</span>
            <span className="text-xs text-muted-foreground">
              <span className="font-medium text-primary">Pilih file</span> · bisa banyak sekaligus · maks. 5 MB per file
            </span>
          </button>
          <input ref={inputRef} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden data-testid="client-file-input" onChange={(e) => void drop(e.target.files)} />
          <p className="text-sm text-muted-foreground">
            Belum ada file?{" "}
            <Link href="/clients/new?manual=1" className="font-medium text-primary hover:underline" onClick={toManual}>
              Isi manual
            </Link>
          </p>
          {dropped.length > 0 && (
            <ul className="divide-y rounded-lg border" aria-live="polite" aria-busy={busy} data-testid="client-files">
              {dropped.map((d) => (
                <FileLine key={d.key} item={d} />
              ))}
            </ul>
          )}
          {status && <p className="text-sm text-muted-foreground">{status}</p>}
        </CardContent>
      </Card>

      {locked.length > 0 && (
        <Card data-testid="client-files-password">
          <CardContent className="space-y-3">
            <Field>
              <FieldLabel htmlFor="client-pdf-password">Kata sandi PDF</FieldLabel>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="client-pdf-password"
                  type="password"
                  autoComplete="off"
                  className="min-w-0 flex-1 basis-48 sm:max-w-xs"
                  value={password}
                  disabled={busy}
                  aria-invalid={!!passwordError}
                  aria-describedby="client-pdf-password-help"
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void unlock()}
                />
                <Button variant="outline" disabled={busy || !password.trim()} onClick={() => void unlock()}>
                  Buka
                </Button>
              </div>
              <FieldDescription id="client-pdf-password-help">
                {locked.length === 1 ? "1 file terkunci." : `${locked.length} file terkunci.`} Dipakai untuk semua file terkunci dan disimpan untuk klien ini. Tanpa kata sandi, file-nya ditanyakan lagi di Unggah.
              </FieldDescription>
              {passwordError && <p role="alert" className="text-sm text-fail">{passwordError}</p>}
            </Field>
          </CardContent>
        </Card>
      )}

      {nothingRead && (
        <Card data-testid="client-files-unread">
          <CardHeader>
            <CardTitle>Tidak ada yang bisa dibaca dari file ini</CardTitle>
            <CardDescription>Buku tidak menemukan rekening koran atau buku besar di file yang ditarik. Tarik file lain, atau isi data klien secara manual.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => toManual()}>Isi manual</Button>
          </CardContent>
        </Card>
      )}

      {showCard && (
        <Card data-testid="client-proposal">
          <CardHeader>
            <CardTitle>Usulan dari file</CardTitle>
            <CardDescription>Periksa nama dan pemilik setiap rekening. Buat klien & impor membuat klien, perusahaan dan rekeningnya, lalu membukukan file-nya di Unggah.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 px-0">
            <ul className="divide-y border-y">
              {active.map((e, i) => {
                const banks = [...accounts.values()].filter((a) => card!.owner[a.key] === e.key);
                const err = fields[`entity:${e.key}`];
                return (
                  <li key={e.key} className="space-y-3 px-4 py-4" data-testid="proposal-entity">
                    <div className="flex flex-wrap items-start gap-2">
                      <Field className="min-w-0 flex-1 basis-60">
                        <FieldLabel htmlFor={`proposal-name-${i}`}>{e.kind === "PERORANGAN" ? "Nama pemilik" : "Nama perusahaan"}</FieldLabel>
                        <Input
                          id={`proposal-name-${i}`}
                          value={entityName(e)}
                          aria-invalid={!!err}
                          disabled={busy}
                          placeholder={e.kind === "PERORANGAN" ? "mis. Budi Santoso" : "mis. PT Maju Bersama Sejahtera"}
                          onChange={(ev) => {
                            setEntity(e.key, { name: ev.target.value, touched: true });
                            dropField(`entity:${e.key}`);
                          }}
                        />
                        <FieldError>{err}</FieldError>
                      </Field>
                      <Field className="w-full sm:w-52">
                        <FieldLabel htmlFor={`proposal-kind-${i}`}>Jenis</FieldLabel>
                        <SimpleSelect id={`proposal-kind-${i}`} label={`Jenis ${entityName(e) || "entitas"}`} value={e.kind} options={KIND_OPTIONS} disabled={busy} onChange={(v) => setEntity(e.key, { kind: v as ProposedKind })} />
                      </Field>
                      <Button variant="ghost" size="sm" className="sm:mt-6" disabled={busy} onClick={() => setEntity(e.key, { removed: true })}>
                        <Trash2 /> Hapus
                      </Button>
                    </div>
                    {banks.length ? (
                      <ul className="space-y-2">
                        {banks.map((a) => (
                          <AccountRow key={a.key} account={a} value={e.key} options={ownerOptions} disabled={busy} error={fields[`bank:${a.key}`]} onMove={(v) => moveAccount(a.key, v)} />
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">Tanpa rekening bank. Buku ini diisi dari file buku besar atau neraca.</p>
                    )}
                  </li>
                );
              })}
              {removed.map((e) => {
                const count = [...accounts.values()].filter((a) => card!.owner[a.key] === e.key).length;
                return (
                  <li key={e.key} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm text-muted-foreground">
                    <span className="min-w-0 flex-1">
                      {entityName(e) || "Entitas"} tidak dibuat{count ? ` — ${count} rekening; file-nya disimpan di Dokumen tanpa dibukukan` : ""}.
                    </span>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEntity(e.key, { removed: false })}>
                      <Undo2 /> Kembalikan
                    </Button>
                  </li>
                );
              })}
              {proposal!.valas.map((v) => (
                <li key={v.key} className="px-4 py-3 text-sm text-muted-foreground">
                  {v.display} ({v.currency}) · Rekening valas belum bisa dibukukan; file disimpan di Dokumen.
                </li>
              ))}
            </ul>
            <div className="space-y-2 px-4">
              {error && <p role="alert" className="text-sm text-fail" data-testid="client-proposal-error">{error}</p>}
              {created ? (
                <div className="space-y-2" data-testid="client-upload-failed">
                  <div role="alert" className="space-y-1 text-sm text-fail">
                    <p>Klien sudah dibuat, tetapi {created.failed.length === 1 ? "1 file" : `${created.failed.length} file`} belum masuk. Tarik lagi di Unggah:</p>
                    <ul className="list-disc pl-5">
                      {created.failed.map((f) => (
                        <li key={f} className="break-all">{f}</li>
                      ))}
                    </ul>
                  </div>
                  <Button onClick={() => router.push(created.href)}>Buka Unggah</Button>
                </div>
              ) : (
                <Button disabled={busy || reading} onClick={() => void create()}>
                  {busy && !reading && <Loader2 className="animate-spin" />} Buat klien & impor
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function AccountRow({ account: a, value, options, disabled, error, onMove }: { account: ProposedAccount; value: string; options: { value: string; label: string }[]; disabled: boolean; error?: string; onMove: (v: string) => void }) {
  const id = `owner-${a.key.replace(/\W/g, "-")}`;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg bg-muted/40 px-3 py-2" data-testid="proposal-account">
      <div className="min-w-0 flex-1 basis-56 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="num">{a.display}</span>
          {a.isOverdraft && <Badge variant="outline" title="Saldo negatif: dicatat sebagai pinjaman rekening koran (PRK)">PRK</Badge>}
        </p>
        <p className="text-xs text-muted-foreground">
          {[a.months, a.holder ? `a.n. ${a.holder}` : null, a.fileNames.length === 1 ? "1 file" : `${a.fileNames.length} file`].filter(Boolean).join(" · ")}
        </p>
        {error && <p role="alert" className="text-sm text-fail">{error}</p>}
      </div>
      <div className="flex items-center gap-2 text-sm">
        <label htmlFor={id} className="text-muted-foreground">Milik</label>
        <SimpleSelect id={id} label={`Pemilik ${a.display}`} className="w-48" value={value} options={options} disabled={disabled} onChange={onMove} />
      </div>
    </li>
  );
}

function FileLine({ item }: { item: Dropped }) {
  const p = item.preview;
  const summary = p && p.status !== "NEEDS_PASSWORD" ? itemSummary(p) : "";
  const message = item.error ?? (p && (p.status === "FAILED" || p.status === "NEEDS_PASSWORD") ? p.message : null);
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-3 py-2" data-testid="client-file" data-status={item.reading ? "READING" : item.error ? "ERROR" : p?.status}>
      <div className="min-w-0 flex-1 basis-60 space-y-0.5">
        <p className="break-all font-mono text-xs">{item.file.name}</p>
        {summary && <p className="num text-sm">{summary}</p>}
        {message && <p className={cn("text-sm", p?.status === "NEEDS_PASSWORD" ? "text-muted-foreground" : "text-fail")}>{message}</p>}
      </div>
      <FileStatus item={item} />
    </li>
  );
}

function FileStatus({ item }: { item: Dropped }) {
  const p = item.preview;
  if (item.reading) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap py-0.5 text-xs font-medium text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Membaca
      </span>
    );
  }
  if (item.error || !p || p.status === "FAILED") return <StatusPill status="FAIL" label="Tidak terbaca" />;
  if (p.status === "NEEDS_PASSWORD") return <StatusPill status="REVIEW" label="Perlu kata sandi" />;
  const label = p.kind === "BANK" ? "Rekening koran" : "Akan disimpan di Dokumen";
  return <span className="shrink-0 whitespace-nowrap py-0.5 text-xs font-medium text-muted-foreground">{label}</span>;
}
