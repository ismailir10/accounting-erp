"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Paperclip, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AccountPicker } from "@/components/app/account-picker";
import { SimpleSelect } from "@/components/app/simple-select";
import { StatusPill } from "@/components/app/status";
import { addAttachmentsAction, adjustmentAction } from "@/app/actions";
import { formatMoney, parseMoney } from "@/lib/money";
import { formatPeriod } from "@/lib/format";
import { formNotice, type SourceRoute } from "@/lib/approvals/second";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Line = { accountCode: string; debit: string; credit: string; memo?: string; departmentId?: string; projectId?: string };
type Tag = { id: string; code: string; name: string };
/** The client's active Departemen & Proyek (lib/dimensions); a line's pickers show only when the client has any. */
export type JournalDimensions = { departments: Tag[]; projects: Tag[] };
/** A journal to start from (*Salin*): its company, memo and lines, amounts as typed text. */
export type JournalCopy = { entityId: string; memo: string; lines: Line[]; /** The source was an accrual reversed on the 1st of its next month. */ reverse: boolean };
/** Typed amount → minor units, or the Bahasa reason it can't be read. */
const read = (s: string, currency: string): { value: bigint; error?: undefined } | { value: 0n; error: string } => {
  try {
    return { value: parseMoney(s, currency) };
  } catch (e) {
    return { value: 0n, error: (e as Error).message };
  }
};

const TEMPLATES: { label: string; memo: string; lines: Line[] }[] = [
  { label: "Penyusutan", memo: "Penyusutan aset tetap bulanan", lines: [{ accountCode: "6180", debit: "", credit: "" }, { accountCode: "1219", debit: "", credit: "" }] },
  { label: "Akrual beban", memo: "Akrual beban yang belum dibayar", lines: [{ accountCode: "6190", debit: "", credit: "" }, { accountCode: "2150", debit: "", credit: "" }] },
  { label: "Piutang usaha", memo: "Pengakuan piutang atas penjualan belum dibayar", lines: [{ accountCode: "1130", debit: "", credit: "" }, { accountCode: "4100", debit: "", credit: "" }] },
  // Money that never touches a statement (the incumbents' kas keluar / kas masuk); the bank's own lines come from the rekening koran.
  { label: "Kas kecil keluar", memo: "Pengeluaran kas kecil", lines: [{ accountCode: "6190", debit: "", credit: "" }, { accountCode: "1110", debit: "", credit: "" }] },
  { label: "Kas kecil masuk", memo: "Penerimaan kas kecil", lines: [{ accountCode: "1110", debit: "", credit: "" }, { accountCode: "4100", debit: "", credit: "" }] },
];

/** `lockedMonths` ("YYYY-MM"): closed months; a date in one is refused by the server, so the form says so before anything is typed. */
const tagOptions = (tags: Tag[], none: string) => [{ value: "", label: none }, ...tags.map((t) => ({ value: t.id, label: `${t.code} · ${t.name}` }))];

export function JournalForm({ clientId, entities, accounts, defaultDate, lockedMonths = [], closeHref, copy, route, dimensions }: { clientId: string; entities: { id: string; name: string; currency: string }[]; accounts: { code: string; name: string; group: string; entityId: string | null }[]; defaultDate: string; lockedMonths?: string[]; closeHref?: string; copy?: JournalCopy; /** Persetujuan kedua's *Jurnal manual* for this member. */ route?: SourceRoute; dimensions?: JournalDimensions }) {
  const router = useRouter();
  const [entityId, setEntityId] = useState(copy && entities.some((e) => e.id === copy.entityId) ? copy.entityId : (entities[0]?.id ?? ""));
  const [date, setDate] = useState(defaultDate);
  const [memo, setMemo] = useState(copy?.memo ?? "");
  const departments = dimensions?.departments ?? [];
  const projects = dimensions?.projects ?? [];
  const [lines, setLines] = useState<Line[]>(copy?.lines.length ? copy.lines.map((l) => ({ ...l })) : [{ accountCode: "", debit: "", credit: "" }, { accountCode: "", debit: "", credit: "" }]);
  const [reverse, setReverse] = useState(copy?.reverse ?? false);
  // Lampiran (lib/ledger/attachments.ts): uploaded to the journal once it is posted.
  const [files, setFiles] = useState<File[]>([]);
  const [filesKey, setFilesKey] = useState(0); // a fresh input after each save
  const [pending, start] = useTransition();
  const lockedMonth = lockedMonths.includes(date.slice(0, 7));
  // An accrual's reversal goes on the first of the next month; a closed month there refuses the whole journal, so say it first.
  const [y, m] = date.split("-").map(Number);
  const nextKey = y && m ? (m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`) : "";
  const nextMonth = nextKey ? formatPeriod(Number(nextKey.slice(0, 4)), Number(nextKey.slice(5))) : "";
  const nextLabel = nextMonth ? `1 ${nextMonth}` : "awal bulan berikutnya";
  const nextLocked = reverse && lockedMonths.includes(nextKey);
  // Amounts are typed in the selected entity's own currency; the server parses them the same way.
  const currency = entities.find((e) => e.id === entityId)?.currency ?? "IDR";
  const cur = currency === "IDR" ? "" : ` (${currency})`;
  const parsed = lines.map((l) => ({ debit: read(l.debit, currency), credit: read(l.credit, currency) }));
  const dr = parsed.reduce((s, p) => s + p.debit.value, 0n);
  const cr = parsed.reduce((s, p) => s + p.credit.value, 0n);
  const error = parsed.flatMap((p) => [p.debit.error, p.credit.error]).find(Boolean);
  const balanced = dr === cr && dr > 0n && !error;
  // Persetujuan kedua: above the firm's threshold the save becomes a request another member approves (the server decides again).
  const notice = balanced ? formNotice(route, dr, currency) : null;
  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  // Typed "152000000" reads back as "152.000.000" once the field is left, so a missing digit is visible.
  const tidy = (i: number, side: "debit" | "credit") => {
    const r = read(lines[i][side], currency);
    if (!r.error && r.value > 0n) setLine(i, { [side]: formatMoney(r.value, currency, { bare: true }) });
  };
  // A bank account belongs to one entity: another entity's books never use it (postJournal refuses it too).
  const usable = accounts.filter((a) => !a.entityId || a.entityId === entityId);
  const changeEntity = (id: string) => {
    setEntityId(id);
    const ok = new Set(accounts.filter((a) => !a.entityId || a.entityId === id).map((a) => a.code));
    setLines((ls) => ls.map((l) => (l.accountCode && !ok.has(l.accountCode) ? { ...l, accountCode: "" } : l)));
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <span className="self-center text-sm text-muted-foreground">Template:</span>
        {TEMPLATES.map((t) => (
          <Button key={t.label} variant="outline" size="sm" onClick={() => { setMemo(t.memo); setLines(t.lines.map((l) => ({ ...l }))); }}>{t.label}</Button>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="journal-entity">Entitas</FieldLabel>
          <Select value={entityId} onValueChange={(v) => changeEntity(v as string)}>
            <SelectTrigger id="journal-entity" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{entities.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="journal-date">Tanggal</FieldLabel>
          <Input id="journal-date" type="date" lang="id-ID" value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={lockedMonth || undefined} />
        </Field>
        <Field>
          <FieldLabel htmlFor="journal-memo">Keterangan</FieldLabel>
          <Input id="journal-memo" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="mis. Penyusutan Agustus" />
        </Field>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow><TableHead className="p-2 pl-3 text-left font-medium">Akun</TableHead><TableHead className="p-2 text-right font-medium">Debit{cur}</TableHead><TableHead className="p-2 text-right font-medium">Kredit{cur}</TableHead><TableHead className="w-10" /></TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l, i) => (
              <TableRow key={i} className="border-t">
                <TableCell className="p-2 pl-3 align-top">
                  <AccountPicker value={l.accountCode} onChange={(v) => setLine(i, { accountCode: v })} options={usable} ariaLabel={`Akun baris ${i + 1}`} className="min-w-64" />
                  <Input aria-label={`Catatan baris ${i + 1}`} value={l.memo ?? ""} onChange={(e) => setLine(i, { memo: e.target.value })} placeholder="Catatan baris (opsional)" maxLength={200} className="mt-1.5 h-8 min-w-64 text-xs" />
                  {(departments.length > 0 || projects.length > 0) && (
                    <div className="mt-1.5 flex min-w-64 gap-1.5">
                      {departments.length > 0 && <SimpleSelect label={`Departemen baris ${i + 1}`} value={l.departmentId ?? ""} onChange={(v) => setLine(i, { departmentId: v })} options={tagOptions(departments, "Tanpa departemen")} className="h-8 text-xs" />}
                      {projects.length > 0 && <SimpleSelect label={`Proyek baris ${i + 1}`} value={l.projectId ?? ""} onChange={(v) => setLine(i, { projectId: v })} options={tagOptions(projects, "Tanpa proyek")} className="h-8 text-xs" />}
                    </div>
                  )}
                </TableCell>
                <TableCell className="p-2 align-top"><Input aria-label={`Debit baris ${i + 1}`} aria-invalid={!!parsed[i].debit.error || undefined} inputMode="decimal" className="num text-right" value={l.debit} onBlur={() => tidy(i, "debit")} onChange={(e) => setLine(i, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} placeholder={formatMoney(0n, currency, { bare: true })} /></TableCell>
                <TableCell className="p-2 align-top"><Input aria-label={`Kredit baris ${i + 1}`} aria-invalid={!!parsed[i].credit.error || undefined} inputMode="decimal" className="num text-right" value={l.credit} onBlur={() => tidy(i, "credit")} onChange={(e) => setLine(i, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} placeholder={formatMoney(0n, currency, { bare: true })} /></TableCell>
                <TableCell className="p-2">{lines.length > 2 && <Button variant="ghost" size="icon-sm" aria-label="Hapus baris" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 /></Button>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="p-2 pl-3"><Button variant="ghost" size="sm" onClick={() => setLines((ls) => [...ls, { accountCode: "", debit: "", credit: "" }])}><Plus /> Tambah baris</Button></TableCell>
              <TableCell className="num p-2 text-right font-semibold">{formatMoney(dr, currency, { bare: true })}</TableCell>
              <TableCell className="num p-2 text-right font-semibold">{formatMoney(cr, currency, { bare: true })}</TableCell>
              <TableCell />
            </TableRow>
          </TableFooter>
        </Table>
      </div>
      <div className="flex items-start gap-2 text-sm">
        <Checkbox id="journal-reverse" checked={reverse} onCheckedChange={(v) => setReverse(v === true)} className="mt-0.5" />
        <label htmlFor="journal-reverse">
          Balik otomatis pada {nextLabel}
          <span className="block text-xs text-muted-foreground">Untuk akrual: Buku mencatat jurnal pembaliknya sekaligus, dengan debit dan kredit ditukar.</span>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor="journal-files" className="inline-flex cursor-pointer items-center gap-1 font-medium text-primary hover:underline">
          <Paperclip className="size-4" /> Lampirkan bukti
        </label>
        <input key={filesKey} id="journal-files" type="file" multiple accept="application/pdf,image/jpeg,image/png" className="sr-only" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
        <span className="text-xs text-muted-foreground" data-testid="journal-files">{files.length ? files.map((f) => f.name).join(", ") : "PDF, JPG atau PNG, maks. 5 MB per file (opsional)"}</span>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {nextLocked && !lockedMonth && (
        <p role="alert" className="rounded-md border border-fail/30 bg-fail-subtle px-3 py-2 text-sm text-fail" data-testid="journal-reverse-locked">
          {nextMonth} sudah ditutup, jadi jurnal pembaliknya ditolak. Hilangkan centang, atau minta admin membuka kembali bulan itu.
        </p>
      )}
      {lockedMonth && (
        <p role="alert" className="rounded-md border border-fail/30 bg-fail-subtle px-3 py-2 text-sm text-fail" data-testid="journal-locked">
          Bulan tanggal ini sudah ditutup, jadi jurnalnya akan ditolak. Pilih tanggal di bulan yang masih terbuka, atau minta admin membuka kembali bulan itu di{" "}
          {closeHref ? <a href={closeHref} className="font-medium underline underline-offset-4">Tutup Buku</a> : "Tutup Buku"} (dengan alasan).
        </p>
      )}
      {notice && <p className="text-sm text-muted-foreground" data-testid="journal-second-notice">{notice.text}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatusPill status={balanced ? "PASS" : "REVIEW"} label={error ? "Periksa nominal" : balanced ? "Seimbang" : dr === cr ? "Isi nominal" : `Selisih ${formatMoney(dr - cr, currency)}`} />
        <Button
          disabled={!balanced || pending || lockedMonth || nextLocked}
          onClick={() =>
            start(async () => {
              const r = await adjustmentAction({ clientId, entityId, date, memo, lines, reverseNextMonth: reverse });
              if (!r.ok) return void toast.error(r.error);
              if (files.length && r.entryId) {
                const form = new FormData();
                form.set("clientId", clientId);
                form.set("entryId", r.entryId);
                for (const f of files) form.append("files", f);
                const a = await addAttachmentsAction(form);
                if (!a.ok) toast.error(`Jurnal tersimpan, tetapi lampirannya tidak: ${a.error}`, { description: "Lampirkan lagi dari Jurnal Umum." });
              } else if (files.length) toast.message("Lampiran menyusul", { description: "Lampirkan dari Jurnal Umum setelah jurnalnya disetujui." });
              setFiles([]);
              setFilesKey((k) => k + 1);
              if (r.pending) toast.success("Jurnal menunggu persetujuan", { description: "Anggota lain menyetujuinya di Kotak persetujuan sebelum dicatat." });
              else if (r.fallback) toast.success("Jurnal penyesuaian tersimpan", { description: "Dicatat tanpa persetujuan kedua: tidak ada anggota lain yang berhak menyetujui." });
              else toast.success(reverse ? `Jurnal penyesuaian tersimpan, dibalik pada ${nextLabel}` : "Jurnal penyesuaian tersimpan");
              setMemo("");
              setReverse(false);
              setLines([{ accountCode: "", debit: "", credit: "" }, { accountCode: "", debit: "", credit: "" }]);
              router.refresh();
            })
          }
        >
          {notice?.waits ? "Ajukan persetujuan" : "Simpan jurnal"}
        </Button>
      </div>
    </div>
  );
}
