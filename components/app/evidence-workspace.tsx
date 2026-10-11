"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { FileText, ChevronRight, AlertCircle, CheckCircle2, Pause, Play, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { NextStep, PageHeader } from "@/components/app/page-header";
import { SimpleSelect } from "@/components/app/simple-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatDate } from "@/lib/format";
import { ClientForm } from "@/components/app/client-form";
import type { Workspace } from "@/lib/evidence/workspace";
import type { EvidenceUnit } from "@/lib/evidence/types";
import type { NewClientInput } from "@/lib/onboarding";
import { createEvidenceAction, beginEvidenceUploadAction, appendEvidenceUploadAction, finishEvidenceUploadAction, processEvidenceAction, loadEvidenceAction, attachDriveAction, includeEvidenceAction, excludeEvidenceAction, confirmEvidenceAction, decideEvidenceFactAction, resolveEvidenceConflictAction, linkEvidenceClientAction, analyzeEvidenceAction, askEvidenceAction, prepareEvidenceImportAction, postEvidenceBankAction, inboxFromDocumentAction, startGoogleAction, disconnectGoogleAction } from "@/app/actions";
import type { EvidenceAnswer } from "@/lib/evidence/answers";

const roleNames: Record<string, string> = { SOURCE: "Sumber pencatatan", COMPARISON: "Pembanding", CONTEXT: "Konteks" };
const kindNames: Record<string, string> = { BANK: "Rekening koran", LEDGER: "Buku besar", REPORT: "Laporan keuangan", CONTEXT: "Konteks perusahaan", UNKNOWN: "Perlu dikenali" };
const factNames: Record<string, string> = { companyName: "Nama perusahaan", businessActivity: "Kegiatan usaha", industry: "Bidang usaha", legalForm: "Bentuk badan usaha", fiscalYearEnd: "Akhir tahun buku", address: "Alamat", documentKind: "Jenis dokumen", entity: "Entitas", periodStart: "Awal periode", periodEnd: "Akhir periode", currency: "Mata uang" };
const statusNames: Record<string, string> = { READY: "Siap diperiksa", PENDING: "Menunggu proses", ERROR: "Perlu tindakan", MISSING: "Tidak tersedia", DIRECTORY: "Folder", SHORTCUT: "Pintasan", IGNORED: "Dilewati", DONE: "Pemeriksaan selesai", PARTIAL: "Pemeriksaan belum lengkap" };
type Clients = { id: string; name: string }[];

/** What went wrong at Google's callback and what the admin does next. Unknown reasons get the general message. */
const googleFailure: Record<string, string> = {
  scope: "Google belum memberi izin membaca Drive. Hubungkan kembali dan centang akses Google Drive di layar persetujuan.",
  invalid_client: "Konfigurasi Google di server tidak cocok (client ID, secret, atau alamat callback). Hubungi pengelola Buku.",
  config: "Koneksi Google belum dikonfigurasi di server. Hubungi pengelola Buku.",
  no_refresh_token: "Google tidak mengirim izin jangka panjang. Cabut akses Buku di akun Google Anda, lalu hubungkan kembali.",
  denied: "Persetujuan dibatalkan di Google. Hubungkan kembali bila ingin membaca folder.",
  state: "Sesi persetujuan kedaluwarsa atau dibuka di peramban lain. Hubungkan kembali.",
};
export function EvidenceHome({ intakes, clients, clientId, connected, googleConfigured, googleResult, googleReason, isAdmin, actions, note }: { isAdmin: boolean; intakes: { id: string; name: string; status: string; clientId: string | null }[]; clients: Clients; clientId?: string; connected: boolean; googleConfigured: boolean; googleResult?: "connected" | "error"; googleReason?: string; actions?: React.ReactNode; note?: React.ReactNode }) {
  const router = useRouter(); const contextParams = useSearchParams(); const contextQuery = new URLSearchParams(); for (const key of ["scope", "period"]) { const value = contextParams.get(key); if (value) contextQuery.set(key, value); } const suffix = contextQuery.size ? `?${contextQuery}` : ""; const [busy, setBusy] = useState(false);
  return <div className="space-y-6">
    <PageHeader title="Dokumen" description="Rekening koran, buku besar, laporan, dan konteks perusahaan dalam satu tempat." actions={actions} />
    {note}
    <NextStep>Unggah file atau tempel tautan Drive untuk diperiksa dan ditanyakan. Isinya tidak otomatis menjadi jurnal; rekening koran bank dibukukan lewat Unggah di klien.</NextStep>
    {googleResult === "connected" && connected && <Alert role="status" className="border-pass/20 bg-pass-subtle text-pass"><CheckCircle2 /><AlertDescription className="text-pass">Google berhasil dihubungkan. Tambahkan dokumen lalu tempel tautan folder.</AlertDescription></Alert>}
    {googleResult === "error" && <Alert className="border-review/30 bg-review-subtle"><AlertCircle /><AlertDescription>{(googleReason && googleFailure[googleReason]) || "Google belum berhasil dihubungkan. Izin mungkin dibatalkan atau sesi kedaluwarsa. Coba hubungkan kembali."}</AlertDescription></Alert>}
    <Button disabled={busy} onClick={async () => { setBusy(true); const r = await createEvidenceAction(clientId); setBusy(false); if (r.ok) router.push(`/documents/${r.data.id}${suffix}`); else toast.error(r.error); }}><Upload className="size-4" /> Tambahkan dokumen</Button>
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card><CardHeader><CardTitle>Kumpulan dokumen</CardTitle></CardHeader><CardContent>
        {!intakes.length ? <p className="text-sm text-muted-foreground">Belum ada dokumen. Klien bisa dibuat setelah file diperiksa.</p> : <ul className="divide-y">{intakes.map(i => <li key={i.id}><Link href={`/documents/${i.id}${suffix}`} className="flex items-center gap-3 py-4"><FileText className="size-5 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block truncate font-medium">{i.name}</span><span className="text-xs text-muted-foreground">{clients.find(c => c.id === i.clientId)?.name ?? "Belum dihubungkan ke klien"} · {statusNames[i.status] ?? i.status}</span></span><ChevronRight className="size-4" /></Link></li>)}</ul>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Google Drive</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
        <p>{connected ? "Google terhubung. Buku membaca folder yang Anda tambahkan." : "Admin kantor menghubungkan sekali, lalu semua anggota bisa menempel tautan folder."}</p>
        {!googleConfigured && <p className="text-muted-foreground">Admin perlu menyiapkan koneksi Google. Unggah manual tetap tersedia.</p>}
        {(googleConfigured || connected) && !isAdmin && <p className="text-muted-foreground">Hanya admin kantor yang dapat menghubungkan atau memutus Google.</p>}
        {(googleConfigured || connected) && isAdmin && <><div className="flex flex-wrap gap-2">
          {googleConfigured && <Button variant="outline" disabled={busy} onClick={async () => { setBusy(true); try { const r = await startGoogleAction(); if (r.ok) window.location.assign(r.url); else toast.error(r.error); } catch { toast.error("Koneksi terputus. Coba hubungkan Google kembali."); } finally { setBusy(false); } }}>{connected ? "Hubungkan ulang" : "Hubungkan Google"}</Button>}
          {connected && <Button variant="outline" disabled={busy} onClick={async () => { setBusy(true); try { const r = await disconnectGoogleAction(); if (r.ok) { toast.success(r.note ?? "Google diputuskan"); router.replace(clientId ? `/clients/${clientId}/documents` : "/documents"); router.refresh(); } else toast.error(r.error); } catch { toast.error("Koneksi terputus. Coba putuskan Google kembali."); } finally { setBusy(false); } }}>Putuskan Google</Button>}
        </div></>}

      </CardContent></Card>
    </div>
  </div>;
}

function proposedClient(workspace: Workspace): NewClientInput {
  const documents = workspace.documents.filter(d => !d.excluded && d.status === "READY");
  const units = documents.flatMap(d => d.versions.filter(v => v.id === d.currentVersionId).flatMap(v => v.units));
  const names = [...new Set(units.map(u => u.entity).filter((v): v is string => Boolean(v)))];
  const currentVersions = new Set(documents.map(d => d.currentVersionId));
  const industry = workspace.facts.filter(f => currentVersions.has(f.versionId) && /industry|businessActivity/i.test(f.key)).sort((a, b) => Number(b.status === "CONFIRMED") - Number(a.status === "CONFIRMED"))[0]?.value ?? "";
  return { name: names[0] ?? "", industry, entities: (names.length ? names : [""]).map(name => {
    const currencies = [...new Set(units.filter(u => u.entity === name).map(u => u.currency).filter((c): c is string => Boolean(c)))];
    return { name, shortName: name, kind: /\b(pte|ltd|limited|llc|inc|llp|plc|gmbh)\b/i.test(name) ? "BADAN_USAHA_ASING" : /^CV\b/i.test(name) ? "CV" : "PT", npwp: "", currency: currencies.length === 1 ? currencies[0] : "", banks: [] };
  }) };
}

export function EvidenceWorkspace({ initial, clients }: { initial: Workspace; clients: Clients }) {
  const [workspace, setWorkspace] = useState(initial); const [busy, setBusy] = useState(false); const [running, setRunning] = useState(false); const [progress, setProgress] = useState("");
  const [url, setUrl] = useState(initial.intake.sourceUrl ?? ""); const [question, setQuestion] = useState(""); const [answer, setAnswer] = useState<EvidenceAnswer | null>(null); const [answerScope, setAnswerScope] = useState(""); const [showClient, setShowClient] = useState(false); const [existingClient, setExistingClient] = useState("");
  const [fileSearch, setFileSearch] = useState(""); const [fileFilter, setFileFilter] = useState("included"); const [filePage, setFilePage] = useState(0);
  const search = useSearchParams(); const router = useRouter(); const scopedEntity = search.get("scope")?.startsWith("entity:") ? search.get("scope")!.slice(7) : ""; const entityId = search.get("entity") === "combined" ? "" : search.get("entity") ?? (workspace.entities.some(e => e.id === scopedEntity) ? scopedEntity : ""); // Question period has its own param: the app-wide `period` must not silently narrow evidence questions.
  const period = search.get("tanya") ?? ""; const globalPeriod = search.get("period");
  const stopped = useRef(false); const mounted = useRef(true); const processing = useRef(false); const autoResumed = useRef(false); const uploadInput = useRef<HTMLInputElement>(null); const id = workspace.intake.id;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stopped.current = true; }; }, []);
  const refresh = useCallback(async () => { if (!mounted.current) return; const r = await loadEvidenceAction(id); if (r.ok && mounted.current) setWorkspace(r.data); }, [id]);
  const run = useCallback(async () => {
    if (processing.current || !mounted.current) return; processing.current = true; stopped.current = false; setRunning(true);
    try { while (!stopped.current) { const r = await processEvidenceAction(id); if (!mounted.current) break; if (!r.ok) { toast.error(r.error); break; } await refresh(); if (r.data.error) toast.error(r.data.error); if (!r.data.more) break; if (r.data.busy) { setProgress("Sesi lain sedang memproses. Progres tersimpan."); break; } } }
    catch { if (mounted.current) toast.error("Pemeriksaan terputus. Progres tersimpan; pilih Lanjutkan pemeriksaan."); }
    finally { processing.current = false; if (mounted.current) { setRunning(false); setProgress(""); } }
  }, [id, refresh]);
  useEffect(() => {
    if (autoResumed.current) return;
    if (!initial.intake.hasPendingWork) { autoResumed.current = true; return; }
    const resume = setTimeout(() => { autoResumed.current = true; void run(); }, 0);
    return () => clearTimeout(resume);
  }, [initial.intake.hasPendingWork, run]);
  async function upload(files: FileList | null) {
    if (!files?.length || processing.current) return; setBusy(true); setAnswer(null);
    try {
      for (const file of Array.from(files)) {
        if (!mounted.current) return;
        setProgress(`Mengunggah ${file.name}`);
        const start = await beginEvidenceUploadAction(id, file.name, file.size); if (!start.ok) { toast.error(start.error); continue; }
        let failed = false;
        for (let offset = 0; offset < file.size; offset += 1024 * 1024) { if (!mounted.current) return; const fd = new FormData(); fd.set("chunk", file.slice(offset, offset + 1024 * 1024)); const r = await appendEvidenceUploadAction(start.data.id, offset, fd); if (!r.ok) { toast.error(r.error); failed = true; break; } }
        if (!failed && mounted.current) { const done = await finishEvidenceUploadAction(start.data.id); if (!done.ok) toast.error(done.error); }
      }
      await refresh();
    } catch { if (mounted.current) toast.error("Unggahan terputus. File yang sudah selesai tetap tersimpan; unggah kembali file lainnya."); }
    finally { if (mounted.current) { setBusy(false); setProgress(""); if (uploadInput.current) uploadInput.current.value = ""; } }
    if (mounted.current) void run();
  }
  async function action(fn: () => Promise<{ ok: boolean; error?: string }>) { setBusy(true); try { const r = await fn(); if (!r.ok) toast.error(r.error); else setAnswer(null); await refresh(); } catch { toast.error("Koneksi terputus. Muat ulang untuk memeriksa hasil sebelum mencoba kembali."); } finally { if (mounted.current) setBusy(false); } }
  async function retryOrToggle(d: Workspace["documents"][number]) {
    const r = await (d.excluded || d.status === "ERROR" ? includeEvidenceAction(id, d.id) : excludeEvidenceAction(id, d.id));
    if (!r.ok || d.excluded || d.status !== "ERROR") return r;
    const processed = await processEvidenceAction(id, undefined, d.id);
    if (!processed.ok) return processed;
    if (processed.data.busy) return { ok: false, error: "Sesi lain sedang memproses. Tunggu lalu coba kembali." };
    return processed.data.error ? { ok: false, error: processed.data.error } : { ok: true };
  }
  function scope(nextEntity: string, nextPeriod: string) { setAnswer(null); const p = new URLSearchParams(search.toString()); p.delete("entity"); p.delete("tanya"); if (nextEntity) p.set("entity", nextEntity); if (nextPeriod) p.set("tanya", nextPeriod); router.replace(`/documents/${id}?${p}`); }
  const pending = workspace.documents.filter(d => !d.excluded && d.status === "PENDING").length;
  const ready = workspace.documents.filter(d => !d.excluded && d.status === "READY").length;
  const errors = workspace.documents.filter(d => !d.excluded && d.status === "ERROR").length;
  const excluded = workspace.documents.filter(d => d.excluded).length;
  const docs = [...workspace.documents].filter(d => (fileFilter === "all" || (fileFilter === "errors" ? d.status === "ERROR" && !d.excluded : fileFilter === "excluded" ? d.excluded : !d.excluded && d.status !== "DIRECTORY")) && `${d.name} ${d.path}`.toLowerCase().includes(fileSearch.toLowerCase())).sort((a, b) => Number(a.excluded) - Number(b.excluded) || Number(b.status === "ERROR") - Number(a.status === "ERROR"));
  const pages = Math.max(1, Math.ceil(docs.length / 20)); const currentPage = Math.min(filePage, pages - 1);
  const visibleDocs = docs.slice(currentPage * 20, (currentPage + 1) * 20);
  return <div className="space-y-6">
    <PageHeader title={workspace.intake.name} description="Bukti sumber tersimpan terpisah dari buku. Setiap versi dapat ditelusuri." actions={<Link href={`/documents?${new URLSearchParams({ scope: search.get("scope") ?? (workspace.intake.clientId ? `client:${workspace.intake.clientId}` : "all"), ...(globalPeriod ? { period: globalPeriod } : {}) })}`} className="text-sm text-primary">Semua dokumen</Link>} />
    <NextStep>{running ? "File sedang diperiksa. Menutup halaman menjeda proses setelah langkah aktif selesai." : workspace.intake.status === "PARTIAL" ? "Pemeriksaan belum lengkap. Periksa kendala di bawah." : pending ? `${pending} file menunggu. Lanjutkan pemeriksaan dari progres tersimpan.` : "Periksa peran sumber dan perbedaan. Anda sudah bisa bertanya tentang dokumen."}</NextStep>
    <p data-testid="evidence-progress" className="text-sm text-muted-foreground">{ready} file siap · {errors} perlu tindakan · {pending} menunggu · {excluded} tidak disertakan. {workspace.documents.length} item ditemukan.{workspace.intake.hasPendingWork && " Pemeriksaan belum selesai."}</p>
    {workspace.intake.issue && <Alert className="border-review/30 bg-review-subtle"><AlertCircle /><AlertDescription>{workspace.intake.issue}</AlertDescription></Alert>}
    <Card><CardHeader><CardTitle>Unggah file atau tempel tautan Drive</CardTitle></CardHeader><CardContent className="space-y-4">
      <div className="flex flex-wrap gap-3"><Button disabled={busy || running} onClick={() => uploadInput.current?.click()}><Upload className="size-4" /> Pilih file</Button><input ref={uploadInput} aria-label="File dokumen" type="file" multiple className="sr-only" onChange={e => void upload(e.target.files)} /><span className="self-center text-xs text-muted-foreground">PDF teks, Excel, CSV atau teks · maks. 10 MB per file</span></div>
      <div className="flex flex-wrap gap-2"><Input aria-label="Tautan folder Drive" placeholder="https://drive.google.com/drive/folders/…" value={url} onChange={e => setUrl(e.target.value)} className="min-w-0 flex-1" /><Button variant="outline" disabled={busy || running || !url} onClick={async () => { setBusy(true); const r = await attachDriveAction(id, url); setBusy(false); if (!r.ok) toast.error(r.error); else { setAnswer(null); await refresh(); void run(); } }}>{workspace.intake.sourceUrl ? "Periksa pembaruan" : "Baca folder"}</Button></div>
      <div className="flex flex-wrap items-center gap-3"><Button size="sm" variant="outline" disabled={busy} onClick={() => { if (running) { stopped.current = true; setProgress("Menunggu langkah aktif selesai; setelah itu proses dijeda."); } else void run(); }}>{running ? <Pause className="size-4" /> : <Play className="size-4" />}{running ? "Jeda setelah langkah ini" : "Lanjutkan pemeriksaan"}</Button><span role="status" className="text-xs text-muted-foreground">{progress || (running ? `${ready + errors} file diperiksa; ${pending} menunggu` : statusNames[workspace.intake.status])}</span></div>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>Tanyakan dokumen dan buku</CardTitle></CardHeader><CardContent className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2"><Field><FieldLabel htmlFor="ask-entity">Entitas</FieldLabel><SimpleSelect id="ask-entity" label="Entitas" disabled={busy} value={entityId} onChange={v => scope(v, period)} options={[{ value: "", label: "Semua entitas dalam kumpulan" }, ...workspace.entities.map(e => ({ value: e.id, label: e.name }))]} /></Field><Field><FieldLabel htmlFor="ask-period">Periode (opsional)</FieldLabel><Input id="ask-period" disabled={busy} type="month" value={period} onChange={e => scope(entityId, e.target.value)} /></Field></div>
      <form className="flex gap-2" onSubmit={async e => { e.preventDefault(); if (busy) return; const askedScope = `${entityId}/${period}`; setBusy(true); setAnswer(null); try { const r = await askEvidenceAction(id, question, entityId || undefined, period || undefined); if (r.ok) { if (mounted.current) { setAnswer(r.data); setAnswerScope(askedScope); } await refresh(); } else toast.error(r.error); } catch { toast.error("Jawaban belum dapat dimuat. Periksa koneksi lalu coba kembali."); } finally { if (mounted.current) setBusy(false); } }}><Input aria-label="Pertanyaan" placeholder="Bandingkan laba tahun lalu, atau cari perjanjian pinjaman…" value={question} onChange={e => setQuestion(e.target.value)} maxLength={2000} /><Button type="submit" variant="outline" disabled={busy || !question.trim()}>Tanyakan</Button></form>
      {answer && answerScope === `${entityId}/${period}` && <AnswerView answer={answer} />}
      {workspace.messages.length > 0 && <details><summary className="cursor-pointer text-sm text-muted-foreground">Pertanyaan sebelumnya ({workspace.messages.length})</summary><div className="mt-4 space-y-6">{workspace.messages.map(m => <div key={m.id}><p className="mb-2 text-sm font-medium">{m.question}</p><AnswerView answer={m.answer as unknown as EvidenceAnswer} /></div>)}</div></details>}
    </CardContent></Card>
    {workspace.conflicts.filter(c => !c.resolved).length > 0 && <Card><CardHeader><CardTitle>Perbedaan sumber</CardTitle></CardHeader><CardContent className="space-y-4">{workspace.conflicts.filter(c => !c.resolved).map(c => <Conflict key={c.id} message={c.message} sources={c.versionIds.map((versionId, index) => ({ versionId, label: workspace.documents.flatMap(d => d.versions).find(v => v.id === versionId)?.name ?? `Sumber ${index + 1}` }))} disabled={busy || running} onResolve={note => action(() => resolveEvidenceConflictAction(id, c.id, note))} />)}</CardContent></Card>}
    {!workspace.intake.clientId && <Card><CardHeader><CardTitle>Hubungkan perusahaan</CardTitle></CardHeader><CardContent className="space-y-4"><p className="text-sm text-muted-foreground">Analisis dokumen tersedia sekarang. Konfirmasi perusahaan sebelum menyiapkan pencatatan.</p><div className="flex flex-wrap gap-2"><SimpleSelect label="Klien yang sudah ada" className="sm:max-w-xs" placeholder="Pilih klien yang sudah ada" value={existingClient} onChange={setExistingClient} options={clients.map(c => ({ value: c.id, label: c.name }))} /><Button variant="outline" disabled={!existingClient || busy || running} onClick={() => void action(() => linkEvidenceClientAction(id, existingClient))}>Hubungkan klien</Button><Button variant="outline" disabled={busy || running} onClick={() => setShowClient(!showClient)}>Periksa usulan klien baru</Button></div>{showClient && <fieldset disabled={busy || running} className="min-w-0"><ClientForm initial={proposedClient(workspace)} evidenceIntakeId={id} onCreated={() => void refresh()} /></fieldset>}</CardContent></Card>}
    <Card><CardHeader><CardTitle>File dan peran sumber</CardTitle></CardHeader><CardContent className="space-y-4">
      <div className="flex flex-wrap gap-2"><Input aria-label="Cari file" placeholder="Cari nama file atau folder…" value={fileSearch} onChange={e => { setFileSearch(e.target.value); setFilePage(0); }} className="min-w-0 flex-1" /><SimpleSelect label="Tampilkan file" className="sm:w-52" value={fileFilter} onChange={v => { setFileFilter(v); setFilePage(0); }} options={[{ value: "included", label: "File disertakan" }, { value: "errors", label: "Perlu tindakan" }, { value: "excluded", label: "Tidak disertakan" }, { value: "all", label: "Semua item dan folder" }]} /></div>
      {!docs.length && <p className="text-sm text-muted-foreground">{workspace.documents.length ? "Tidak ada file yang cocok dengan pencarian dan filter." : "Belum ada file. Unggah beberapa dokumen sekaligus atau tambahkan folder."}</p>}
      {visibleDocs.map(d => { const booked = d.excluded ? null : d.versions.find(v => v.id === d.currentVersionId)?.booked ?? null; return <DocumentDetails key={`${d.id}:${d.status === "ERROR"}`} initialOpen={d.status === "ERROR"}><summary className="flex cursor-pointer items-center gap-3"><FileText className="size-4 shrink-0" /><span className="min-w-0 flex-1"><span className="block break-words font-medium">{d.name}</span><span className="text-xs text-muted-foreground">{booked ? <Link data-testid="evidence-booked" href={booked.href} className="text-primary">{booked.status === "BOOKED" && <CheckCircle2 className="mr-1 inline size-3 text-pass" />}{booked.label}</Link> : d.excluded ? "Tidak disertakan" : statusNames[d.status]} · {d.versions.length} versi</span></span><ChevronRight className="size-4 shrink-0" /></summary>
        <div className="mt-4 space-y-4"><p className="break-all text-xs text-muted-foreground">{d.path}</p>{d.issue && <p role="alert" className="text-sm text-review">{d.issue}</p>}
        <div className="flex flex-wrap gap-2">{d.status !== "IGNORED" && (d.status !== "DIRECTORY" || d.excluded) && <Button size="sm" variant="outline" disabled={busy || running} onClick={() => void action(() => retryOrToggle(d))}>{d.excluded ? "Sertakan" : d.status === "ERROR" ? "Coba kembali" : "Keluarkan dari analisis"}</Button>}
        {d.currentVersionId && !d.excluded && <Button size="sm" variant="outline" disabled={busy || running} onClick={() => void action(async () => { const r = await analyzeEvidenceAction(id, d.currentVersionId!); if (r.ok) toast.message(r.data.note ?? `${r.data.facts} usulan konteks`); return r; })}>Minta usulan konteks AI</Button>}</div>
        {d.versions.map(v => <div key={v.id} className="space-y-3">{v.id !== d.currentVersionId ? <Link href={`/documents/source/${v.id}`} className="text-xs text-primary">Buka versi tersimpan · {formatDate(new Date(v.createdAt))}</Link> : <>{v.issues.map((issue, i) => <p key={i} className="text-sm text-review">{issue}</p>)}{!booked && v.units.map(unit => <UnitReview key={`${v.id}:${unit.key}:${workspace.intake.clientId ?? "new"}:${unit.entity}:${unit.currency}:${unit.periodStart}:${unit.periodEnd}`} unit={unit} versionId={v.id} workspace={workspace} disabled={busy || running || d.excluded} onRefresh={refresh} />)}</>}</div>)}
        {d.status === "ERROR" && /sandi|password/i.test(d.issue ?? "") && <PasswordRetry intakeId={id} documentId={d.id} refresh={refresh} />}</div>
      </DocumentDetails>; })}
      {docs.length > 20 && <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">Halaman {currentPage + 1} dari {pages} · {docs.length} item</p><div className="flex gap-2"><Button size="sm" variant="outline" disabled={currentPage === 0} onClick={() => setFilePage(currentPage - 1)}>Sebelumnya</Button><Button size="sm" variant="outline" disabled={currentPage + 1 >= pages} onClick={() => setFilePage(currentPage + 1)}>Berikutnya</Button></div></div>}
    </CardContent></Card>
    {workspace.facts.length > 0 && <Card><CardHeader><CardTitle>Konteks perusahaan</CardTitle></CardHeader><CardContent className="space-y-3">{workspace.facts.map(f => <div key={f.id} className="flex flex-wrap items-start gap-3 border-b pb-3 last:border-0"><div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{factNames[f.key] ?? f.key}: {f.value}</p><Link className="text-xs text-primary" href={`/documents/source/${f.versionId}?at=${encodeURIComponent(f.locator)}#cited-source`}>{f.locator}</Link><p className="text-xs text-muted-foreground">{f.status === "CONFIRMED" ? "Dikonfirmasi" : f.status === "CONFLICTING" ? "Bertentangan · perlu diperiksa" : "Usulan · belum dikonfirmasi"}</p>{f.sourceWarning && <p className="text-xs text-review">{f.sourceWarning}</p>}</div><Button size="sm" variant="outline" disabled={busy || running || f.status === "CONFIRMED"} onClick={() => void action(() => decideEvidenceFactAction(id, f.id, true))}>Konfirmasi</Button><Button size="sm" variant="ghost" disabled={busy || running} onClick={() => void action(() => decideEvidenceFactAction(id, f.id, false))}>Abaikan</Button></div>)}</CardContent></Card>}

  </div>;
}

function DocumentDetails({ initialOpen, children }: { initialOpen: boolean; children: React.ReactNode[] }) {
  const [open, setOpen] = useState(initialOpen);
  return <details className="rounded-lg border p-4" open={open} onToggle={e => setOpen(e.currentTarget.open)}>{children[0]}{open && children.slice(1)}</details>;
}

function Conflict({ message, sources, disabled, onResolve }: { message: string; sources: { versionId: string; label: string }[]; disabled: boolean; onResolve: (note: string) => Promise<void> }) {
  const [note, setNote] = useState(""); return <div className="space-y-2 rounded-md bg-review-subtle p-3"><p className="flex gap-2 text-sm"><AlertCircle className="size-4 shrink-0" />{message}</p>{sources.length > 0 && <div className="flex flex-wrap gap-3">{sources.map(source => <Link key={source.versionId} href={`/documents/source/${source.versionId}`} className="break-all text-xs text-primary">{source.label} <ChevronRight className="inline size-3" /></Link>)}</div>}<p className="text-xs text-muted-foreground">Periksa versi sumber, lalu jelaskan pilihan di bawah.</p><Input aria-label="Alasan pemilihan sumber" value={note} onChange={e => setNote(e.target.value)} placeholder="Sumber mana yang digunakan, dan mengapa?" /><Button size="sm" variant="outline" disabled={disabled || note.trim().length < 8} onClick={() => void onResolve(note)}>Simpan hasil pemeriksaan</Button></div>;
}
function PasswordRetry({ intakeId, documentId, refresh }: { intakeId: string; documentId: string; refresh: () => Promise<void> }) {
  const [password, setPassword] = useState(""); const [busy, setBusy] = useState(false); return <div className="flex gap-2"><Input type="password" aria-label="Sandi PDF" value={password} onChange={e => setPassword(e.target.value)} placeholder="Sandi PDF (tidak disimpan)" /><Button variant="outline" disabled={busy || !password} onClick={async () => { setBusy(true); const included = await includeEvidenceAction(intakeId, documentId); if (!included.ok) toast.error(included.error); else { const r = await processEvidenceAction(intakeId, password, documentId); if (!r.ok) toast.error(r.error); else if (r.data.error) toast.error(r.data.error); } setPassword(""); setBusy(false); await refresh(); }}>Buka PDF</Button></div>;
}
const COLUMN = "__column__";
/** "Buku besar · 3.437 baris · 4 entitas", "Neraca · tanggal belum tertulis". */
function tableSummary(t: NonNullable<EvidenceUnit["table"]>) {
  if (t.mode === "NERACA") return `Neraca · ${t.rows.toLocaleString("id-ID")} akun · ${t.periodEnd ? `per ${formatDate(new Date(t.periodEnd))}` : "tanggal belum tertulis"}`;
  return `Buku besar · ${t.rows.toLocaleString("id-ID")} baris${t.entities.length > 1 ? ` · ${t.entities.length} entitas` : ""}`;
}
/** At most five issues in view; the rest behind a visible disclosure. */
function IssueList({ issues }: { issues: string[] }) {
  if (!issues.length) return null;
  const line = (s: string, i: number) => <p key={i} className="text-xs text-review">{s}</p>;
  return <div className="space-y-1">{issues.slice(0, 5).map(line)}{issues.length > 5 && <details><summary className="cursor-pointer text-xs text-muted-foreground">+{issues.length - 5} lainnya</summary><div className="mt-1 space-y-1">{issues.slice(5).map((s, i) => line(s, i + 5))}</div></details>}</div>;
}
function UnitReview({ unit, versionId, workspace, disabled, onRefresh }: { unit: EvidenceUnit; versionId: string; workspace: Workspace; disabled: boolean; onRefresh: () => Promise<void> }) {
  const saved = workspace.selections.find(s => s.versionId === versionId && s.unitKey === unit.key);
  const table = unit.table;
  const labels = table?.mode === "LEDGER" ? table.entities : [];
  const byLabel = (label: string) => workspace.entities.find(e => [e.shortName, e.name].some(n => n.toLowerCase() === label.trim().toLowerCase()));
  // A ledger naming several entities posts per its entity column; one label picks that entity.
  const initialEntity = saved?.confirmed ? saved.entityId ?? (saved.role === "SOURCE" && labels.length ? COLUMN : "") : labels.length > 1 ? COLUMN : (labels.length === 1 ? byLabel(labels[0])?.id : workspace.entities.find(e => e.name.toLowerCase() === unit.entity?.toLowerCase())?.id) ?? "";
  const currencyOf = (value: string) => value === COLUMN ? labels.map(byLabel).find(Boolean)?.functionalCurrency : workspace.entities.find(e => e.id === value)?.functionalCurrency;
  const [role, setRole] = useState(saved?.role ?? unit.role); const [entity, setEntity] = useState(initialEntity);
  const [from, setFrom] = useState(saved?.periodStart ?? unit.periodStart ?? ""); const [to, setTo] = useState(saved?.periodEnd ?? unit.periodEnd ?? ""); const [currency, setCurrency] = useState(saved?.currency ?? unit.currency ?? (table ? currencyOf(initialEntity) ?? "" : "")); const [bank, setBank] = useState(saved?.bankAccountId ?? "");
  const neraca = table?.mode === "NERACA", bankUnit = unit.kind === "BANK" && !table;
  const [busy, setBusy] = useState(false); const [bankPreview, setBankPreview] = useState<string | null>(null); const [password, setPassword] = useState("");
  // Foreign rows posted as written (default, like the manual import) or converted with the Kurs table.
  const [valas, setValas] = useState<"FUNCTIONAL" | "CONVERT">("FUNCTIONAL");
  const showValas = table?.mode === "LEDGER" && saved?.confirmed && saved.role === "SOURCE" && !saved.importId && (!table.currencies || table.currencies.some(c => c !== saved.currency));
  const intakeId = workspace.intake.id; const router = useRouter();
  const changed = !saved || role !== saved.role || entity !== (saved.entityId ?? (saved.confirmed && saved.role === "SOURCE" && labels.length ? COLUMN : "")) || from !== (saved.periodStart ?? "") || to !== (saved.periodEnd ?? "") || currency !== (saved.currency ?? "") || bank !== (saved.bankAccountId ?? "");
  // A rekening koran of a client's collection books through Unggah, which reads the rekening and period from the file; the role form
  // stays for edge cases behind *Isi manual* (cycle 2026-10-11-dokumen-to-unggah). Firm-wide collections keep the form.
  const handoff = bankUnit && Boolean(workspace.intake.clientId) && !saved?.importId;
  const manual = <>
      <fieldset disabled={disabled || busy || Boolean(saved?.importId)} onChangeCapture={() => setBankPreview(null)} className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3"><Field><FieldLabel>Peran</FieldLabel><SimpleSelect label={`Peran ${unit.label}`} value={role} onChange={setRole} options={Object.entries(roleNames).map(([value, label]) => ({ value, label }))} /></Field><Field><FieldLabel>Entitas</FieldLabel><SimpleSelect label={`Entitas ${unit.label}`} value={entity} onChange={v => { setEntity(v); setBank(""); setCurrency(c => c || currencyOf(v) || ""); }} options={[{ value: "", label: unit.entity ? `Belum dipilih (${unit.entity})` : "Belum dipilih" }, ...(labels.length ? [{ value: COLUMN, label: `Sesuai kolom Entitas di file (${labels.join(", ")})` }] : []), ...workspace.entities.map(e => ({ value: e.id, label: e.name }))]} /></Field><Field><FieldLabel>Mata uang</FieldLabel><Input aria-label={`Mata uang ${unit.label}`} value={currency} onChange={e => setCurrency(e.target.value.toUpperCase())} maxLength={3} placeholder="IDR / SGD / USD" /></Field>{neraca ? <Field><FieldLabel>Tanggal neraca</FieldLabel><Input aria-label={`Tanggal neraca ${unit.label}`} type="date" value={to} onChange={e => { setFrom(e.target.value); setTo(e.target.value); }} /></Field> : <><Field><FieldLabel>Dari</FieldLabel><Input aria-label={`Dari ${unit.label}`} type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field><Field><FieldLabel>Sampai</FieldLabel><Input aria-label={`Sampai ${unit.label}`} type="date" value={to} onChange={e => setTo(e.target.value)} /></Field></>}{bankUnit && <Field><FieldLabel>Rekening</FieldLabel><SimpleSelect label={`Rekening ${unit.label}`} value={bank} onChange={setBank} options={[{ value: "", label: "Belum dipilih" }, ...(workspace.entities.find(e => e.id === entity)?.bankAccounts ?? []).map(b => ({ value: b.id, label: `${b.label} · ${b.number.slice(-4)}` }))]} /></Field>}</fieldset>
      {showValas && <Field className="max-w-md"><FieldLabel htmlFor={`valas-${unit.key}`}>Baris valas</FieldLabel><SimpleSelect id={`valas-${unit.key}`} label={`Baris valas ${unit.label}`} disabled={disabled || busy} value={valas} onChange={v => setValas(v === "CONVERT" ? "CONVERT" : "FUNCTIONAL")} options={[{ value: "FUNCTIONAL", label: "Jumlah sudah dalam mata uang entitas" }, { value: "CONVERT", label: "Konversi dengan kurs" }]} /><FieldDescription>{valas === "CONVERT" ? "Baris valas dikonversi dengan kurs di file, atau kurs di halaman Kurs pada tanggalnya." : "Angka dicatat apa adanya; kolom mata uang hanya informasi. Baris valas tanpa kurs ditandai untuk dicek."}</FieldDescription></Field>}
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={disabled || busy || Boolean(saved?.importId)} onClick={async () => { setBusy(true); const r = await confirmEvidenceAction(intakeId, versionId, unit.key, { role, entityId: entity && entity !== COLUMN ? entity : undefined, periodStart: from || undefined, periodEnd: to || undefined, currency: currency || undefined, bankAccountId: bank || undefined }); if (!r.ok) toast.error(r.error); else { toast.success("Peran sumber dikonfirmasi"); setBankPreview(null); await onRefresh(); } setBusy(false); }}><CheckCircle2 className="size-3" />Konfirmasi peran</Button>
        {saved?.confirmed && saved.role === "SOURCE" && !saved.importId && <Button size="sm" variant="outline" disabled={disabled || busy || changed} onClick={async () => { setBusy(true); const r = await prepareEvidenceImportAction(intakeId, versionId, unit.key, bank || undefined, password || undefined, showValas ? valas : undefined); if (!r.ok) toast.error(r.error); else if (r.data.importId) { await onRefresh(); toast.success("Draf impor siap diperiksa"); } else setBankPreview(`${r.data.rows} transaksi · ${r.data.continuityOk ? "saldo nyambung" : "saldo perlu diperiksa"}`); setBusy(false); }}>Siapkan impor</Button>}
        {saved?.importId && workspace.intake.clientId && <Link className="self-center text-sm text-primary" href={bankUnit ? `/clients/${workspace.intake.clientId}/review` : `/clients/${workspace.intake.clientId}/import/ledger/${saved.importId}`}>Buka hasil impor <ChevronRight className="inline size-3" /></Link>}
      </div>
      {bankUnit && saved?.confirmed && !saved.importId && <Input type="password" aria-label={`Sandi impor ${unit.label}`} placeholder="Sandi PDF bila diperlukan (tidak disimpan)" value={password} onChange={e => setPassword(e.target.value)} />}
      {bankPreview && !changed && <div className="space-y-2 rounded border p-3"><p className="text-sm">{bankPreview}. Pencatatan mengikuti pemeriksaan dan aturan Buku. Transaksi belum pasti masuk antrean review.</p><Button size="sm" variant="outline" disabled={disabled || busy} onClick={async () => { setBusy(true); const r = await postEvidenceBankAction(intakeId, versionId, unit.key, bank, password || undefined); if (!r.ok) toast.error(r.error); else { toast.success("Mutasi dicatat"); setBankPreview(null); setPassword(""); await onRefresh(); } setBusy(false); }}>Konfirmasi dan catat mutasi</Button></div>}
  </>;
  return <div data-testid={`unit-${unit.key}`} className="space-y-3 rounded-md border bg-background p-3"><div className="flex flex-wrap items-center gap-2"><Link className="min-w-0 break-words text-sm font-medium text-primary" href={`/documents/source/${versionId}?at=${encodeURIComponent(unit.passages[0]?.locator ?? "")}`}>{unit.label} <ChevronRight className="inline size-3" /></Link><span className="text-xs text-muted-foreground">{table ? tableSummary(table) : kindNames[unit.kind]}{saved?.confirmed ? changed ? " · Pilihan berubah; konfirmasi kembali" : " · Peran dikonfirmasi" : " · Usulan"}</span></div>{!handoff && <IssueList issues={unit.issues} />}
    {handoff ? <><div className="flex flex-wrap items-center gap-3"><Button size="sm" disabled={disabled || busy} onClick={async () => { setBusy(true); const r = await inboxFromDocumentAction(intakeId, versionId).catch(() => null); if (r?.ok) { router.push(r.href); return; } toast.error(r ? r.error : "Koneksi terputus. Periksa internet lalu coba lagi."); setBusy(false); }}><Upload className="size-4" /> Bukukan lewat Unggah</Button><p className="text-sm text-muted-foreground">Buku membaca rekening dan periodenya dari file.</p></div>
      <details className="group/manual"><summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Isi manual</summary><div className="mt-3 space-y-3"><IssueList issues={unit.issues} />{manual}</div></details></> : manual}
  </div>;
}
function AnswerView({ answer }: { answer: EvidenceAnswer }) {
  return <div className="space-y-3 rounded-lg border bg-background p-4"><p className="text-sm">{answer.text}</p>{answer.rows?.length ? <div className="divide-y">{answer.rows.map((r,i) => <div className="grid gap-1 py-2 text-sm sm:grid-cols-[1fr_2fr]" key={i}><span className="min-w-0 break-words font-medium">{r.label}</span><span className="min-w-0 whitespace-pre-wrap break-words num">{r.value}</span></div>)}</div> : null}<div className="flex flex-wrap gap-3">{answer.citations.map((c,i) => <Link key={i} className="break-all text-xs text-primary" href={`/documents/source/${c.versionId}?at=${encodeURIComponent(c.locator)}#cited-source`}>{c.label} · {c.locator}</Link>)}{answer.links?.map((l,i) => <Link key={i} className="text-xs text-primary" href={l.href}>{l.label}</Link>)}</div>{answer.limitations.map((l,i) => <p key={i} className="text-xs text-muted-foreground">{l}</p>)}</div>;
}
