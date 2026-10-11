"use client";

import { useKeepEarlyFile } from "@/components/app/keep-early-file";
import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, FileText, FileUp, Loader2, ScanText, TableProperties } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { StatusPill } from "@/components/app/status";
import { forgetLayoutAction, importAction, importSampleAction, ocrAction, setBankAccountBankAction } from "@/app/actions";
import { ColumnMapper } from "@/components/app/column-mapper";
import { AiRunStatus, useAiRun } from "@/components/app/ai-run-status";
import { useAccess, WriteBlockedNote } from "@/components/app/access-context";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { BANKS, GROUP_ORDER, bankName } from "@/lib/banks";
import type { ImportSummary } from "@/lib/import/pipeline";
import type { AiRunView } from "@/lib/ai/run";
import { cn } from "@/lib/utils";
import { MAX_UPLOAD_BYTES, UPLOAD_TOO_BIG } from "@/lib/upload";

type BankOption = { id: string; label: string; entity: string; bank: string; number: string };

const METHOD_LABEL: Record<string, string> = { TRANSFER: "Transfer antar rekening", RULE: "Aturan", MEMORY: "Pilihan yang diingat", AI: "Usulan AI", HEURISTIC: "Tebakan sederhana", MANUAL: "Manual" };
/** How the lines were suggested; with AI in the background, the simple guesses waiting for it are their own row. */
function methodRows(r: ImportSummary): [string, number][] {
  const later = r.ai.later ?? 0;
  return Object.entries(r.byMethod)
    .flatMap(([m, n]): [string, number][] => (m === "HEURISTIC" && later > 0 ? [["Untuk saran AI", later], [METHOD_LABEL[m], n - later]] : [[METHOD_LABEL[m], n]]))
    .filter(([, n]) => n > 0);
}

/** `openingPending`: short names of the entities whose Saldo Awal is still missing; the result then leads with it (the bank balance is prefilled from this upload). */
export function ImportForm({ clientId, banks, sample, openingPending = [], aiRun: pageRun = null }: { clientId: string; banks: BankOption[]; sample?: { bankAccountId: string; fileName: string }; openingPending?: string[]; /** The client's background AI run: shown on the result, or before any upload while it is still running. */ aiRun?: AiRunView | null }) {
  const router = useRouter();
  const ai = useAiRun(clientId, pageRun);
  // The shown result handed lines to the background run (the import action answered with it).
  const [resultRun, setResultRun] = useState(false);
  const { canWrite } = useAccess();
  const [bankId, setBankId] = useState<string>(sample?.bankAccountId ?? banks[0]?.id ?? "");
  const [file, setFileState] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [year, setYear] = useState("");
  const [yearHint, setYearHint] = useState<{ guessed: boolean } | null>(null);
  // A scan or photo (I2a): the error offers Baca scan dengan AI when the workspace switch is on.
  const [scan, setScan] = useState<{ error: string; ocrReady: boolean } | null>(null);
  // A text file no reader knows: the error offers Atur kolom, which opens the mapper below the form.
  const [mappable, setMappable] = useState<{ error: string } | null>(null);
  const [mapping, setMapping] = useState(false);
  // The remembered layout the shown result was read with, until forgotten.
  const [layoutShown, setLayoutShown] = useState(true);
  const setFile = (f: File | null) => {
    if (f && f.size > MAX_UPLOAD_BYTES) {
      toast.error(UPLOAD_TOO_BIG);
      if (inputRef.current) inputRef.current.value = "";
      f = null;
    }
    setFileState(f);
    setPassword("");
    setNeedsPassword(false);
    setYear("");
    setYearHint(null);
    setScan(null);
    setMappable(null);
    setMapping(false);
  };
  const [drag, setDrag] = useState(false);
  const [result, setResult] = useState<ImportSummary | null>(null);
  // The account the shown result was imported into (the select may have moved on since).
  const [resultBankId, setResultBankId] = useState<string | null>(null);
  // The file of the last successful import: "Impor juga ke …" reuses it for another account in the same PDF.
  // With its PDF password (kept in this page only, never sent anywhere else or stored) so another account in it needs no re-typing.
  const [lastFile, setLastFile] = useState<{ file: File; password: string } | null>(null);
  // The file's number belongs to another account of this client: offered inline, one click re-runs with it.
  const [mismatch, setMismatch] = useState<{ error: string; bankId: string } | null>(null);
  const digits = (s: string) => s.replace(/\D/g, "");
  const bankLabel = (id: string) => {
    const b = banks.find((x) => x.id === id);
    return b ? `${b.label} · ${b.number}` : "";
  };
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  // A file chosen before the form hydrated is picked up.
  useKeepEarlyFile(inputRef, (f) => setFileState(f));
  const entities = [...new Set(banks.map((b) => b.entity))];

  const done = (r: Awaited<ReturnType<typeof importAction>>, sent: { file: File; password: string } | null = null, sentTo: string = bankId) => {
    setMismatch(null);
    setScan(null);
    setMappable(null);
    if (!r.ok) {
      if (r.mappable) {
        setMappable({ error: r.error });
        return;
      }
      if (r.scanned) {
        setScan({ error: r.error, ocrReady: r.scanned.ocrReady });
        return;
      }
      if (r.suggestBankAccountId) {
        setMismatch({ error: r.error, bankId: r.suggestBankAccountId });
        return;
      }
      if (r.needsPassword) setNeedsPassword(true);
      if (r.needsYear) {
        // Only prefill on the first ask; never overwrite what the accountant typed.
        if (!yearHint) {
          setYear(r.yearGuess ? String(r.yearGuess) : "");
          setYearHint({ guessed: !!r.yearGuess });
        }
        toast.error(r.error);
        return;
      }
      toast.error(r.error);
      return;
    }
    setResult(r.summary);
    setResultRun(!!r.aiRun);
    if (r.aiRun) ai.adopt(r.aiRun);
    setLayoutShown(true);
    setResultBankId(sentTo);
    if (sent) setLastFile(sent);
    setFile(null);
    toast.success(`${r.summary.rows - r.summary.duplicates} transaksi diproses`);
    router.refresh();
  };

  const submit = (override?: { bankId: string; file: File; password?: string }) =>
    start(async () => {
      const f = override?.file ?? file;
      if (!f) return;
      const pw = override?.password ?? password;
      const fd = new FormData();
      fd.set("clientId", clientId);
      fd.set("bankAccountId", override?.bankId ?? bankId);
      fd.set("file", f);
      if (pw) fd.set("password", pw);
      if (yearHint && year) fd.set("year", year);
      done(await importAction(fd), { file: f, password: pw }, override?.bankId ?? bankId);
    });
  const readScan = () =>
    start(async () => {
      if (!file) return;
      const fd = new FormData();
      fd.set("clientId", clientId);
      fd.set("bankAccountId", bankId);
      fd.set("file", file);
      const r = await ocrAction(fd);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      router.push(`/clients/${clientId}/import/ocr/${r.draftId}`);
    });
  // Re-run the same file for another account. The file (and its password) go back into the form first, so a password or year
  // prompt for that account can be answered with the normal *Proses mutasi*.
  const switchAccount = (id: string, f: File, pw = password) => {
    setBankId(id);
    setFileState(f);
    if (pw) setPassword(pw);
    submit({ bankId: id, file: f, password: pw });
  };
  const resultBank = banks.find((b) => b.id === resultBankId) ?? null;
  // The remembered layout has its own line (with *Lupakan*): its note isn't repeated under "Cara file dibaca".
  const notesShown = result ? (result.layout ? result.notes.filter((n) => !n.startsWith("Dibaca dengan pemetaan kolom tersimpan")) : result.notes) : [];
  const forget = (layoutId: string) =>
    start(async () => {
      const r = await forgetLayoutAction(clientId, layoutId);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setLayoutShown(false);
      toast.success("Pemetaan kolom dilupakan. File berikutnya dengan susunan ini perlu diatur lagi.");
    });
  const recordBank = (id: string, bank: string) =>
    start(async () => {
      const r = await setBankAccountBankAction(clientId, id, bank);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(`Rekening dicatat di ${bankName(bank)}`);
      router.refresh();
    });
  const alsoImport = result && lastFile
    ? result.otherAccounts.filter((o) => !o.imported).flatMap((o) => banks.filter((b) => b.id !== bankId && digits(b.number) === digits(o.number)).map((b) => ({ id: b.id, label: `${b.label} · ${b.number}` })))
    : [];

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <CardHeader>
          <CardTitle>Unggah rekening koran</CardTitle>
          <CardDescription>
            PDF, CSV, Excel atau MT940 dari {BANKS.length} bank, juga PDF bersandi, PDF gabungan beberapa rekening dan salinan kerja Excel satu lembar per bulan. File lain bisa dibaca bila punya kolom tanggal, keterangan, debet/kredit dan saldo.
          </CardDescription>
          <Collapsible>
            <CollapsibleTrigger className="group/trigger inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
              Lihat {BANKS.length} bank <ChevronDown className="size-4 transition-transform group-data-[panel-open]/trigger:rotate-180" aria-hidden />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <dl className="mt-2 space-y-2 text-sm" data-testid="bank-list">
                {GROUP_ORDER.map((g) => (
                  <div key={g} className="grid gap-1 sm:grid-cols-[9.5rem_1fr]">
                    <dt className="eyebrow">{g}</dt>
                    <dd className="text-muted-foreground">{BANKS.filter((b) => b.group === g).map((b) => b.name).sort((a, b) => a.localeCompare(b, "id")).join(", ")}</dd>
                  </div>
                ))}
              </dl>
            </CollapsibleContent>
          </Collapsible>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field>
            <FieldLabel>1. Rekening</FieldLabel>
            <Select value={bankId} onValueChange={(v) => setBankId(v as string)}>
              <SelectTrigger className="w-full" aria-label="Rekening">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {entities.map((e) => (
                  <SelectGroup key={e}>
                    <SelectLabel>{e}</SelectLabel>
                    {banks.filter((b) => b.entity === e).map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.label} · {b.number}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>Rekening tidak ada di daftar? <Link href={`/clients/${clientId}/settings`} className="text-primary hover:underline">Tambahkan di Pengaturan klien</Link>.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>2. File rekening koran</FieldLabel>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                setFile(e.dataTransfer.files[0] ?? null);
              }}
              className={cn(
                "flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-sm transition-colors",
                drag ? "border-primary bg-primary-subtle" : "border-input bg-muted/40 hover:bg-muted",
              )}
            >
              <FileUp className="size-6 text-primary" aria-hidden />
              {file ? <span className="font-medium">{file.name}</span> : <span><span className="font-medium text-primary">Pilih file</span> atau tarik ke sini</span>}
              <span className="text-xs text-muted-foreground">Maks. 5 MB · baris yang sudah pernah diimpor otomatis dilewati</span>
            </button>
            <input ref={inputRef} type="file" accept=".pdf,.csv,.xlsx,.xls,.txt,.sta,.940,.mt940,.jpg,.jpeg,.png" className="sr-only" data-testid="file-input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <FieldDescription>Saldo berjalan dicek di setiap baris. Kalau ada baris yang hilang, hasilnya ditandai Ada celah.</FieldDescription>
          </Field>
          {needsPassword && (
            <Field>
              <FieldLabel htmlFor="pdf-password">Kata sandi PDF</FieldLabel>
              <Input id="pdf-password" type="password" autoComplete="off" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
              <FieldDescription>Biasanya tanggal lahir atau kode dari bank. Hanya dipakai untuk membuka file ini, tidak disimpan.</FieldDescription>
            </Field>
          )}
          {yearHint && (
            <Field>
              <FieldLabel htmlFor="statement-year">Tahun bulan pertama di file</FieldLabel>
              <Input id="statement-year" inputMode="numeric" maxLength={4} autoFocus className="w-32" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, ""))} onKeyDown={(e) => e.key === "Enter" && submit()} />
              <FieldDescription>
                Tanggal di file ini hanya hari dan bulan. {yearHint.guessed ? "Tahun diisi dari nama file; pastikan benar sebelum memproses." : "Isi tahunnya, misalnya 2026."} Bulan berikutnya mengikuti, termasuk pergantian Desember ke Januari.
              </FieldDescription>
            </Field>
          )}
          {scan && file && (
            <div role="alert" className="space-y-2 rounded-md border border-review/40 bg-review-subtle px-3 py-2 text-sm" data-testid="scan-notice">
              <p>{scan.error}</p>
              {scan.ocrReady ? (
                <>
                  <p className="text-muted-foreground">AI bisa menyalin scan ini; setiap baris lalu diperiksa dengan saldo berjalan sebelum Anda mengimpornya.</p>
                  <Button size="sm" variant="outline" disabled={pending} onClick={readScan}>
                    {pending ? <Loader2 className="animate-spin" /> : <ScanText />} Baca scan dengan AI
                  </Button>
                </>
              ) : (
                <p className="text-muted-foreground">Admin kantor bisa menyalakan <span className="font-medium">Baca scan dengan AI</span> di Pengaturan (perlu kunci AI dan model yang bisa membaca gambar).</p>
              )}
            </div>
          )}
          {mappable && file && !mapping && (
            <div role="alert" className="space-y-2 rounded-md border border-review/40 bg-review-subtle px-3 py-2 text-sm" data-testid="mappable-notice">
              <p>{mappable.error}</p>
              <p className="text-muted-foreground">Buku bisa membacanya bila Anda menunjuk kolom tanggal, keterangan, nominal dan saldonya sekali. Susunan ini lalu diingat untuk file berikutnya.</p>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => {
                  // The last result belongs to another file; its primary next step would compete with the mapper's.
                  setResult(null);
                  setMapping(true);
                }}>
                <TableProperties /> Atur kolom
              </Button>
            </div>
          )}
          {mismatch && file && (
            <div role="alert" className="space-y-2 rounded-md border border-review/40 bg-review-subtle px-3 py-2 text-sm" data-testid="account-mismatch">
              <p>{mismatch.error}</p>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => switchAccount(mismatch.bankId, file)}>
                Pakai rekening {bankLabel(mismatch.bankId)}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant={result || mapping ? "outline" : "default"} onClick={() => submit()} disabled={!canWrite || !file || !bankId || pending || (needsPassword && !password) || (!!yearHint && year.length !== 4)}>
              {pending ? <Loader2 className="animate-spin" /> : <FileUp />} Proses mutasi
            </Button>
            {sample && (
              <Button variant="outline" disabled={!canWrite || pending} onClick={() => start(async () => done(await importSampleAction(clientId, sample.bankAccountId), null, sample.bankAccountId))}>
                <FileText /> Pakai file contoh ({sample.fileName})
              </Button>
            )}
            <WriteBlockedNote />
            {sample && (
              <a href={`/demo/${sample.fileName}`} download className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                atau unduh file contohnya
              </a>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2" data-testid="import-result">
        <CardHeader>
          <CardTitle>Hasil</CardTitle>
          <CardDescription>{result ? "Setiap baris sudah dijurnal. Yang usulannya belum pasti masuk antrean review." : "Hasil klasifikasi muncul di sini."}</CardDescription>
        </CardHeader>
        <CardContent>
          {result ? (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-md bg-muted p-2"><div className="num text-xl font-semibold">{result.rows - result.duplicates}</div><div className="text-xs text-muted-foreground">baris baru</div></div>
                <div className="rounded-md bg-pass-subtle p-2 text-pass"><div className="num text-xl font-semibold">{result.posted}</div><div className="text-xs">langsung dijurnal</div></div>
                <div className="rounded-md bg-review-subtle p-2 text-review"><div className="num text-xl font-semibold">{result.needsReview}</div><div className="text-xs">perlu review</div></div>
              </div>
              <ul className="space-y-1">
                {methodRows(result).map(([label, n]) => (
                  <li key={label} className="flex justify-between"><span className="text-muted-foreground">{label}</span><span className="num font-medium">{n}</span></li>
                ))}
              </ul>
              <div className="flex items-center justify-between border-t pt-3">
                <span className="text-muted-foreground">Kesinambungan saldo</span>
                <StatusPill status={result.continuityOk ? "PASS" : "REVIEW"} label={result.continuityOk ? "Nyambung" : "Ada celah"} />
              </div>
              {result.continuityNote && <p className="text-xs text-review">{result.continuityNote}</p>}
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Bank di file</span>
                <span className="text-right">{result.fileBank === "GENERIC" ? "Tidak disebut di file" : bankName(result.fileBank)}</span>
              </div>
              {resultBank && result.fileBank !== "GENERIC" && result.fileBank !== resultBank.bank && (
                <div className="space-y-2 rounded-md bg-review-subtle px-3 py-2 text-xs" data-testid="bank-differs">
                  <p>File ini dari {bankName(result.fileBank)}, rekening {resultBank.label} tercatat di {bankName(resultBank.bank)}.</p>
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => recordBank(resultBank.id, result.fileBank)}>
                    Catat rekening ini sebagai {bankName(result.fileBank)}
                  </Button>
                </div>
              )}
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Periode</span>
                <span className="text-right">{result.months.length > 1 ? `${result.months[0]} – ${result.months.at(-1)} (${result.months.length} bulan)` : result.months[0]}</span>
              </div>
              {result.layout && layoutShown && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted px-3 py-2 text-xs" data-testid="layout-used">
                  <span>Dibaca dengan pemetaan kolom tersimpan (dari {result.layout.label}).</span>
                  <Button size="xs" variant="ghost" disabled={pending} onClick={() => forget(result.layout!.id)}>
                    Lupakan pemetaan ini
                  </Button>
                </div>
              )}
              {notesShown.length > 0 && (
                <div className="space-y-1 rounded-md border px-3 py-2 text-xs" data-testid="import-notes">
                  <div className="eyebrow">Cara file dibaca</div>
                  <ul className="list-disc space-y-1 pl-4 text-muted-foreground">{notesShown.map((n) => <li key={n}>{n}</li>)}</ul>
                </div>
              )}
              {resultRun ? (
                ai.run && <AiRunStatus run={ai.run} variant="row" />
              ) : result.ai.later !== undefined ? (
                // A model is set and nothing was left for the background: the cache answered (or no line needed AI).
                result.ai.cacheHits > 0 && (
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">Saran AI</span>
                    <span className="num">{result.ai.cacheHits} dari jawaban tersimpan</span>
                  </div>
                )
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Panggilan AI</span>
                    <span className="num">{result.ai.calls} panggilan · {result.ai.cacheHits} dari jawaban tersimpan</span>
                  </div>
                  {result.ai.note && <p className="text-xs text-muted-foreground">{result.ai.note}</p>}
                </>
              )}
              {result.duplicates > 0 && <p className="text-xs text-muted-foreground">{result.duplicates} baris dilewati karena sudah pernah diimpor.</p>}
              {result.otherSections.length > 0 && (
                <div className="space-y-2 text-xs text-muted-foreground">
                  File ini juga berisi rekening lain:
                  <ul className="list-disc pl-4">{result.otherSections.map((o) => <li key={o}>{o}</li>)}</ul>
                  {alsoImport.length > 0 && lastFile && (
                    <div className="flex flex-wrap gap-2">
                      {alsoImport.map((b) => (
                        <Button key={b.id} size="sm" variant="outline" disabled={pending} onClick={() => switchAccount(b.id, lastFile.file, lastFile.password)}>
                          Impor juga ke {b.label}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <NextAfterImport clientId={clientId} toReview={result.needsReview || result.pendingReview} openingPending={openingPending.length > 0} />
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Belum ada file yang diproses di sesi ini.</p>
              {ai.run && ai.watched && <AiRunStatus run={ai.run} variant="line" className="border-t pt-3" />}
            </div>
          )}
        </CardContent>
      </Card>
      {mapping && file && mappable && <ColumnMapper clientId={clientId} bankId={bankId} file={file} password={password} reason={mappable.error} onCancel={() => setMapping(false)} />}
    </div>
  );
}

/** One primary button: the next first-run step. Saldo Awal leads while it's missing (its bank lines are prefilled from this file). */
function NextAfterImport({ clientId, toReview, openingPending }: { clientId: string; toReview: number; openingPending: boolean }) {
  const review = { href: `/clients/${clientId}/review`, label: `Review ${toReview} transaksi` };
  if (openingPending) {
    return (
      <>
        <Link href={`/clients/${clientId}/opening`} className={buttonVariants({ className: "w-full" })}>Isi saldo awal</Link>
        {toReview > 0 && <Link href={review.href} className={buttonVariants({ variant: "outline", className: "w-full" })}>{review.label}</Link>}
      </>
    );
  }
  return toReview > 0
    ? <Link href={review.href} className={buttonVariants({ className: "w-full" })}>{review.label}</Link>
    : <Link href={`/clients/${clientId}/close`} className={buttonVariants({ variant: "outline", className: "w-full" })}>Buka Tutup Buku</Link>;
}
