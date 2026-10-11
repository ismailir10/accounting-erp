import { createHash } from "node:crypto";
import type { Db } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { runBudgetedAi } from "@/lib/ai/budget";
import { AiAnswerError, type AiProvider } from "@/lib/ai/provider";
import { formatRupiah } from "@/lib/money";
import { readAmount } from "@/lib/ocr/amount";
export { readAmount };
import { importStatement, type ImportSummary } from "@/lib/import/pipeline";
import { bankName } from "@/lib/banks";
import { readGrid } from "@/lib/import/grid";
import { readMappedDetail, signatureOf, type ColumnMapping } from "@/lib/import/mapped";
import { OcrError, pageImages } from "@/lib/ocr/pages";
import { validDate, proveRows, type OcrRow, type Proof } from "@/lib/ocr/prove";
import { buildOcrPrompt, parseOcrTranscript, OCR_MAX_ROWS, OCR_MAX_TOKENS, OCR_PROMPT_VERSION, OCR_TOKENS_PER_PAGE, type OcrTranscript } from "@/lib/ocr/transcribe";

/**
 * Scanned statements (I2a, accounting-rules 16b): AI transcribes the page images, the running balance proves every row, the accountant
 * fixes what does not tie and imports. The import is the ordinary statement pipeline on a CSV built from the proved rows, so dedupe,
 * continuity, classification and Review are the same as for any file. Nothing posts before the accountant's click.
 */
export const OCR_SETTING = "ai.ocr";

export async function ocrEnabled(db: Pick<Db, "appSetting">): Promise<boolean> {
  return (await db.appSetting.findUnique({ where: { key: OCR_SETTING } }))?.value === "on";
}
export async function setOcrEnabled(db: Pick<Db, "appSetting">, on: boolean) {
  await db.appSetting.upsert({ where: { key: OCR_SETTING }, create: { key: OCR_SETTING, value: on ? "on" : "off" }, update: { value: on ? "on" : "off" } });
}

const OCR_TOKEN_LIMIT = 120_000;
/** Rows a *Periksa baris* draft holds (each is an editable line on the page). */
export const DRAFT_MAX_ROWS = OCR_MAX_ROWS;

/** A file too long for one draft is refused before the draft exists, with what to do. */
export function checkDraftSize(rows: number) {
  if (rows > DRAFT_MAX_ROWS) throw new OcrError(`File ini berisi ${rows.toLocaleString("id-ID")} transaksi; Periksa baris menampung paling banyak 2.000. Pecah filenya per bulan atau per tanggal, lalu baca tiap bagian.`);
}
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

type StoredRow = { date: string; description: string; debit: string | null; credit: string | null; balance: string | null };
const toStored = (r: OcrRow): StoredRow => ({ date: r.date, description: r.description, debit: r.debit?.toString() ?? null, credit: r.credit?.toString() ?? null, balance: r.balance?.toString() ?? null });
const fromStored = (r: StoredRow): OcrRow => ({ date: r.date, description: r.description, debit: r.debit === null ? null : BigInt(r.debit), credit: r.credit === null ? null : BigInt(r.credit), balance: r.balance === null ? null : BigInt(r.balance) });
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

async function bankFor(db: Db, firmId: string, clientId: string, bankAccountId: string) {
  const bank = await db.bankAccount.findFirst({ where: { id: bankAccountId, firmId, entity: { clientId } }, include: { entity: true } });
  if (!bank) throw new OcrError("Rekening tidak ditemukan untuk klien ini.");
  if (bank.currency !== "IDR" || bank.entity.functionalCurrency !== "IDR") throw new OcrError("Periksa baris baru untuk rekening Rupiah.");
  return bank;
}

/** The last imported closing balance of the account before the scan's period: the opening when the scan prints none (never sent to AI). */
async function previousClosing(db: Db, bankAccountId: string, periodStart: string): Promise<bigint | null> {
  const before = /^\d{4}-\d{2}-\d{2}$/.test(periodStart) ? new Date(`${periodStart}T00:00:00Z`) : null;
  const last = await db.statementImport.findFirst({ where: { bankAccountId, ...(before && !Number.isNaN(+before) ? { periodEnd: { lt: before } } : {}) }, orderBy: { periodEnd: "desc" }, select: { closingBalance: true } });
  return last?.closingBalance ?? null;
}

export async function createOcrDraft(db: Db, input: { firmId: string; clientId: string; bankAccountId: string; fileName: string; data: Buffer; provider: AiProvider | null; actorId?: string | null }) {
  if (!(await ocrEnabled(db))) throw new OcrError("Baca scan dengan AI belum diaktifkan. Admin bisa mengaktifkannya di Pengaturan.");
  if (!input.provider?.readStatement) throw new OcrError("AI belum diatur di Pengaturan, atau modelnya tidak bisa membaca gambar.");
  const bank = await bankFor(db, input.firmId, input.clientId, input.bankAccountId);
  const images = await pageImages(input.data);
  const fileHash = createHash("sha256").update(input.data).digest("hex");
  const key = createHash("sha256").update(JSON.stringify([input.firmId, fileHash, input.provider.model, OCR_PROMPT_VERSION])).digest("hex");
  const scope = `ocr:${input.clientId}`;
  const hit = await db.evidenceAiCache.findFirst({ where: { key, firmId: input.firmId, scope } });
  let transcript: OcrTranscript;
  if (hit) transcript = parseOcrTranscript(JSON.stringify(hit.payload));
  else {
    const r = await runBudgetedAi(
      db,
      { firmId: input.firmId, scope, prompt: buildOcrPrompt(images.length), maxCompletionTokens: OCR_MAX_TOKENS + OCR_TOKENS_PER_PAGE * images.length, scopeTokenLimit: OCR_TOKEN_LIMIT, model: input.provider.model, keysRequested: 1, note: `Baca scan ${input.fileName}` },
      async () => {
        const out = await input.provider!.readStatement!({ images });
        let checked: OcrTranscript;
        try { checked = parseOcrTranscript(JSON.stringify(out.transcript)); }
        catch (e) { throw new AiAnswerError(e instanceof Error ? e.message : "Hasil scan tidak valid.", out.promptTokens, out.completionTokens, out.model); }
        if (!checked.rows.length) throw new AiAnswerError("AI tidak menemukan baris transaksi di scan ini.", out.promptTokens, out.completionTokens, out.model);
        return { ...out, transcript: checked };
      },
    );
    transcript = r.transcript;
    await db.evidenceAiCache.upsert({ where: { key }, create: { key, firmId: input.firmId, scope, payload: json(transcript) }, update: {} });
  }
  if (digits(transcript.accountNumber) && digits(transcript.accountNumber) !== digits(bank.number)) {
    throw new OcrError(`Nomor rekening di scan (${transcript.accountNumber}) berbeda dengan rekening terpilih (${bank.number}). Pilih rekening yang sesuai.`);
  }
  const rows: OcrRow[] = transcript.rows.map((r) => ({ date: r.date, description: r.description || "(tanpa keterangan)", debit: readAmount(r.debit), credit: readAmount(r.credit), balance: readAmount(r.balance) }));
  const opening = readAmount(transcript.opening) ?? (await previousClosing(db, bank.id, transcript.periodStart));
  const closing = readAmount(transcript.closing);
  return db.ocrDraft.create({
    data: {
      firmId: input.firmId,
      clientId: input.clientId,
      bankAccountId: bank.id,
      fileName: input.fileName.slice(0, 200),
      fileHash,
      pages: images.length,
      model: input.provider.model,
      header: json({ bank: transcript.bank, accountNumber: transcript.accountNumber, periodStart: transcript.periodStart, periodEnd: transcript.periodEnd, currency: transcript.currency ?? null, openingSource: readAmount(transcript.opening) !== null ? "PRINTED" : opening !== null ? "PREVIOUS" : null }),
      rows: json(rows.map(toStored)),
      opening: opening?.toString() ?? null,
      closing: closing?.toString() ?? null,
      createdById: input.actorId ?? null,
    },
  });
}

export type OcrDraftView = {
  id: string;
  clientId: string;
  bankAccountId: string;
  fileName: string;
  pages: number;
  model: string;
  /** DERIVED (Atur kolom only): the first printed balance less its movement — the first rows then prove nothing on their own. */
  header: { bank: string; accountNumber: string; periodStart: string; periodEnd: string; openingSource: "PRINTED" | "PREVIOUS" | "MANUAL" | "DERIVED" | null; currency?: string | null };
  opening: bigint | null;
  closing: bigint | null;
  rows: OcrRow[];
  proof: Proof;
  status: "DRAFT" | "IMPORTED";
  importId: string | null;
  /** OCR: a scan read by AI. MAPPING: a text file read with *Atur kolom* (no AI, no page images). */
  source: "OCR" | "MAPPING";
};

export async function ocrDraft(db: Db, firmId: string, clientId: string, draftId: string): Promise<OcrDraftView> {
  const d = await db.ocrDraft.findFirst({ where: { id: draftId, firmId, clientId } });
  if (!d) throw new OcrError("Draf scan tidak ditemukan.");
  const rows = (d.rows as unknown as StoredRow[]).map(fromStored);
  const opening = d.opening === null ? null : BigInt(d.opening);
  const closing = d.closing === null ? null : BigInt(d.closing);
  const source = d.source === "MAPPING" ? "MAPPING" : "OCR";
  return { id: d.id, clientId: d.clientId, bankAccountId: d.bankAccountId, fileName: d.fileName, pages: d.pages, model: d.model, header: d.header as OcrDraftView["header"], opening, closing, rows, proof: proveRows(rows, opening, closing, { chained: source === "MAPPING", requireClosing: source === "OCR" }), status: d.status as OcrDraftView["status"], importId: d.importId, source };
}

export type OcrRowInput = { date: string; description: string; debit: string; credit: string; balance: string };

/** The accountant's corrections: the whole table, the opening and the closing balance, as typed. Proof re-runs on read. */
export async function updateOcrDraft(db: Db, input: { firmId: string; clientId: string; draftId: string; rows: OcrRowInput[]; opening: string; closing: string }) {
  const d = await ocrDraft(db, input.firmId, input.clientId, input.draftId);
  if (d.status !== "DRAFT") throw new OcrError("Draf ini sudah diimpor.");
  if (input.rows.length > DRAFT_MAX_ROWS) throw new OcrError("Maksimal 2.000 baris.");
  const amount = (t: string, what: string, i: number) => {
    if (!t.trim()) return null;
    const v = readAmount(t);
    if (v === null) throw new OcrError(`Baris ${i + 1}: ${what} "${t}" bukan angka.`);
    return v;
  };
  const rows: OcrRow[] = input.rows.map((r, i) => ({ date: r.date.trim(), description: r.description.trim().slice(0, 240) || "(tanpa keterangan)", debit: amount(r.debit, "debet", i), credit: amount(r.credit, "kredit", i), balance: amount(r.balance, "saldo", i) }));
  const opening = input.opening.trim() ? readAmount(input.opening) : null;
  if (input.opening.trim() && opening === null) throw new OcrError(`Saldo awal "${input.opening}" bukan angka.`);
  const closing = input.closing.trim() ? readAmount(input.closing) : null;
  if (input.closing.trim() && closing === null) throw new OcrError(`Saldo akhir "${input.closing}" bukan angka.`);
  const manualOpening = opening !== d.opening;
  await db.ocrDraft.update({
    where: { id: d.id },
    data: { rows: json(rows.map(toStored)), opening: opening?.toString() ?? null, closing: closing?.toString() ?? null, header: json({ ...d.header, openingSource: manualOpening ? "MANUAL" : d.header.openingSource }) },
  });
  return ocrDraft(db, input.firmId, input.clientId, d.id);
}

const money = (v: bigint) => `${v < 0n ? "-" : ""}${formatRupiah(v < 0n ? -v : v, { bare: true })},00`;
const cell = (s: string) => s.replace(/[;\r\n"]+/g, " ").replace(/\s{2,}/g, " ").trim();
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** The proved rows as the semicolon CSV the generic parser reads (opening on a SALDO AWAL line). */
export function draftCsv(rows: OcrRow[], opening: bigint, evidence?: { closing: bigint | null; period?: { start: string; end: string }; currency?: string | null }): string {
  const prefix: string[] = [];
  if (evidence?.currency) prefix.push(`Currency: ${cell(evidence.currency)}`);
  if (evidence?.period) {
    const { start, end } = evidence.period;
    if (!validDate(start) || !validDate(end) || start > end || rows.some((r) => r.date < start || r.date > end)) throw new OcrError("Periode scan tidak valid atau tidak mencakup semua transaksi. Periksa periode dan tanggal pada scan.");
    prefix.push(`Periode: ${dmy(start)} - ${dmy(end)}`);
  }
  const lines = [...prefix, "Tanggal;Keterangan;Debet;Kredit;Saldo", `${dmy(rows[0].date)};SALDO AWAL;;;${money(opening)}`];
  // A row without a printed balance (chained proof, *Atur kolom*) keeps its Saldo cell empty, as the bank printed it.
  for (const r of rows) lines.push(`${dmy(r.date)};${cell(r.description)};${r.debit ? money(r.debit) : ""};${r.credit ? money(r.credit) : ""};${r.balance === null ? "" : money(r.balance)}`);
  if (evidence?.closing !== undefined && evidence.closing !== null) lines.push(`${dmy(evidence.period?.end ?? rows[rows.length - 1].date)};SALDO AKHIR;;;${money(evidence.closing)}`);
  return `${lines.join("\n")}\n`;
}

export async function importOcrDraft(db: Db, input: { firmId: string; clientId: string; draftId: string; provider: AiProvider | null; aiLater?: boolean; actorId?: string | null }): Promise<ImportSummary> {
  const d = await ocrDraft(db, input.firmId, input.clientId, input.draftId);
  if (d.status !== "DRAFT") throw new OcrError("Draf ini sudah diimpor.");
  if (d.source === "OCR" && d.closing === null) throw new OcrError("Saldo akhir yang tercetak belum ada. Salin saldo akhir dari scan sebelum mengimpor.");
  if (!d.proof.importable || d.opening === null) throw new OcrError(`Masih ada ${d.proof.problems} baris yang belum terbukti oleh saldo berjalan. Betulkan dulu sebelum mengimpor.`);
  const base = d.fileName.replace(/\.[A-Za-z0-9]+$/, "");
  const mapped = d.source === "MAPPING";
  const period = !mapped && (d.header.periodStart || d.header.periodEnd)
    ? { start: d.header.periodStart, end: d.header.periodEnd }
    : undefined;
  const csv = draftCsv(d.rows, d.opening, { closing: d.closing, currency: d.header.currency, period });
  const summary = await importStatement(db, {
    bankAccountId: d.bankAccountId,
    fileName: `${base} (${mapped ? "pemetaan kolom" : "OCR"}).csv`,
    data: Buffer.from(csv, "utf8"),
    provider: input.provider,
    aiLater: input.aiLater,
    actorId: input.actorId ?? null,
    // The generated CSV's SALDO AWAL line must not promote an inferred/manual opening to printed evidence.
    sourceProvenance: {
      // OCR header dates are model output and are not reviewed in Periksa baris.
      // Keep them for traceability, but never promote them to independent coverage evidence.
      period: "INFERRED",
      opening: d.header.openingSource === "PRINTED" ? "PRINTED" : "DERIVED",
      closing: !mapped && d.closing !== null ? "PRINTED" : "DERIVED",
    },
  });
  const note = mapped ? "Dibaca dengan pemetaan kolom; setiap baris terbukti oleh saldo berjalan." : `Dibaca AI (${d.model}) dari scan ${d.pages} halaman; setiap baris terbukti oleh saldo berjalan.`;
  const imp = await db.statementImport.findUnique({ where: { id: summary.importId }, select: { parseNotes: true } });
  await db.statementImport.update({ where: { id: summary.importId }, data: { parseNotes: [...(imp?.parseNotes ?? []), note] } });
  await db.ocrDraft.update({ where: { id: d.id }, data: { status: "IMPORTED", importId: summary.importId } });
  // The layout is remembered once its reading has been proved and imported: the next file of it reads without asking.
  const layout = mapped ? (d.header as MappedHeader).layout : undefined;
  if (layout) {
    const { bank } = await db.bankAccount.findUniqueOrThrow({ where: { id: d.bankAccountId }, select: { bank: true } });
    await db.statementLayout.upsert({
      where: { firmId_bank_signature: { firmId: input.firmId, bank, signature: layout.signature } },
      create: { firmId: input.firmId, bank, signature: layout.signature, kind: layout.kind, mapping: json(layout.mapping), label: d.fileName.slice(0, 200), createdById: input.actorId ?? null, lastUsedAt: new Date() },
      update: { kind: layout.kind, mapping: json(layout.mapping), label: d.fileName.slice(0, 200), lastUsedAt: new Date() },
    });
  }
  return { ...summary, notes: [...summary.notes, note] };
}

/** What *Atur kolom* remembers once the draft is imported: the mapping relative to the header row, under the header's signature. */
export type StoredLayout = { signature: string; kind: "CSV" | "XLSX" | "PDF"; mapping: LayoutMapping };
/** A `ColumnMapping` without the sheet (month sheets differ), the first row (title rows vary: it is the row under the header) and the year. */
export type LayoutMapping = Omit<ColumnMapping, "sheet" | "firstRow" | "year">;
type MappedHeader = OcrDraftView["header"] & { layout?: StoredLayout };

/**
 * *Atur kolom*: a text file the readers refused, read with the accountant's mapping into a draft on *Periksa baris* — the same proof by
 * running balance and the same import as a scan, without AI. The grid and the rows come from the uploaded bytes, never from the browser.
 */
export async function createMappedDraft(db: Db, input: { firmId: string; clientId: string; bankAccountId: string; fileName: string; data: Buffer; password?: string; mapping: ColumnMapping; actorId?: string | null }) {
  const bank = await bankFor(db, input.firmId, input.clientId, input.bankAccountId);
  const grid = await readGrid(input.data, { password: input.password });
  const { statement: st, printedOpening } = readMappedDetail(grid, input.mapping, { fileName: input.fileName });
  checkDraftSize(st.rows.length);
  // Opening: a "Saldo awal" row of the file; else the account's last imported closing (as for scans), an independent check of the first
  // rows; else the first balance less its movement, said so (the first rows then prove nothing on their own).
  const previous = printedOpening ? null : await previousClosing(db, bank.id, st.periodStart.toISOString().slice(0, 10));
  const opening = printedOpening ? st.openingBalance : (previous ?? st.openingBalance);
  const openingSource = printedOpening ? "PRINTED" : previous !== null ? "PREVIOUS" : "DERIVED";
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const rows: OcrRow[] = st.rows.map((r) => ({ date: iso(r.date), description: r.description.slice(0, 240), debit: r.amount < 0n ? -r.amount : null, credit: r.amount > 0n ? r.amount : null, balance: r.balance }));
  const signature = signatureOf(grid, input.mapping);
  const { date, description, amount, balance, order } = input.mapping;
  const layout: StoredLayout | undefined = signature ? { signature, kind: grid.kind, mapping: { date, description, amount, balance, order } } : undefined;
  return db.ocrDraft.create({
    data: {
      firmId: input.firmId,
      clientId: input.clientId,
      bankAccountId: bank.id,
      fileName: input.fileName.slice(0, 200),
      fileHash: createHash("sha256").update(input.data).digest("hex"),
      pages: grid.pages,
      model: "",
      source: "MAPPING",
      header: json({ bank: st.format === "GENERIC" ? "" : bankName(st.format), accountNumber: "", periodStart: iso(st.periodStart), periodEnd: iso(st.periodEnd), openingSource, layout }),
      rows: json(rows.map(toStored)),
      opening: opening.toString(),
      closing: null,
      createdById: input.actorId ?? null,
    },
  });
}
