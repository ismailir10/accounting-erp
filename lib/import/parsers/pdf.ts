import { extractTextItems, getDocumentProxy } from "unpdf";
import type { BankCode } from "@/lib/generated/prisma/enums";
import { dateOnly } from "@/lib/format";
import { detectBank } from "@/lib/banks";
import { ParseError, AmbiguousDateError, SourceDateError, SourceAmountError, ScanError, type DepositProduct, type ParsedRow, type ParsedStatement } from "@/lib/import/types";
import { dayMonthEvidence, type DayMonthOrder, parseBankAmount, assertSingleSide, calendarDate, CURRENCY_HEADER, closingProvenance, sourceCurrency, closingFromRows, dateParts, MONTHS, monthBoundsOf, periodFromText, SenWatch, splitMarker } from "@/lib/import/parsers/common";

/**
 * Text PDF e-statements (BCA / Mandiri / BRI and similar layouts). No AI: text + positions → table rows,
 * and correctness is proven by the running-balance continuity check downstream (accounting-rules §12).
 *
 * Layout model: one header line names the columns (tanggal · keterangan · debet/kredit or mutasi · saldo).
 * Rows start with a date in the date column. Lines without a date directly below a row continue its description.
 * Numbers are assigned to the nearest amount/balance header by x, so reference numbers inside the description
 * never become amounts.
 */

export class PdfPasswordError extends ParseError {
  constructor(readonly reason: "needed" | "wrong") {
    super(reason === "needed" ? "PDF ini dikunci kata sandi. Masukkan kata sandinya untuk membuka." : "Kata sandi PDF salah. Coba lagi.");
  }
}

type Cell = { x0: number; x1: number; text: string };
export type Line = { page: number; y: number; cells: Cell[] };
/** `skip`: a column left of the description that is neither (row number, branch, journal, teller) — its cells are no description. */
type ColKind = "date" | "desc" | "debit" | "credit" | "amount" | "balance" | "flag" | "currency" | "skip";
type Column = { kind: ColKind; x0: number; x1: number };

const HEADER: Record<ColKind, RegExp> = {
  date: /^(tanggal|tgl\.?|date|tanggal transaksi|post(ing)? date|tgl\.? transaksi|trans(action)? date|tgl\.? txn|txn date|tanggal & (waktu|jam)|date & time)$/i,
  desc: /^(keterangan|uraian|uraian transaksi|deskripsi|description|remark|remarks|trans(action)? description|transaction desc|transaction details?|rincian transaksi|narasi|berita)$/i,
  debit: /^(debet|debit|mutasi debet|mutasi debit|(uang |dana )?keluar|withdrawals?|pengeluaran)$/i,
  credit: /^(kredit|credit|mutasi kredit|(uang |dana )?masuk|deposits?|pemasukan)$/i,
  amount: /^(mutasi|jumlah|nominal|amount|transaction amount)$/i,
  balance: /^(saldo|balance|saldo akhir|running balance|ledger balance)$/i,
  flag: /^(db\/cr|d\/k|dk|cr\/db|db\.?\s*\/\s*cr\.?)$/i,
  currency: CURRENCY_HEADER,
  skip: /^(no\.?|#|cbg|cabang|branch|journal( no\.?)?|jurnal|teller|user id)$/i,
};
/** An amount: optional sign and "Rp"/"IDR" before it ("+1.000.000", "-Rp 2.500", "(2.500)"), a DB/CR marker after. */
const NUMBER = /^[+-]?\s*(?:(?:Rp\.?|IDR)\s*)?\(?[+-]?\d+(?:[.,]\d{3})*(?:[.,]\d{1,2})?\)?(?:\s*(DB|CR|DR|D|K|C)\.?)?$/i;
/** Digits with amount punctuation (a separator, sign, brackets or "Rp") and no word: what a damaged amount looks like. A bare "0998" is a code. */
const looksLikeAmount = (t: string) => /^\d[\d.,]*[A-Za-z]+\d/.test(t) || /\d/.test(t) && /[.,+()-]|^(?:Rp|IDR)/i.test(t) && !/[A-Za-z]{3,}/.test(t.replace(/^(?:Rp\.?|IDR)/i, ""));
/** "Aktivitas Rekening / Account Activities – <name> (<CCY>) <number>" — any separator after the last title word. */
const SECTION = /.*(?:account activities|aktivitas rekening)[^\p{L}\p{N}]+(.+?)\s*\(([A-Za-z]{3})\)\s*([0-9A-Za-z]{6,})\s*$/iu;
/** A pocket of a digital bank account (Bank Jago "Kantong Utama · 100200300400"): its own number, its own table. */
const POCKET = /^((?:kantong|pocket)\b.*?)\s*[·:–-]\s*(\d{8,})\s*$/iu;

/** The account section a line opens, if any: SMBC-style "Account Activities – <name> (<CCY>) <number>" or a Jago pocket. */
function sectionOf(line: Line): { label: string; currency: string; number: string } | null {
  const text = lineText(line);
  const m = text.match(SECTION);
  if (m) return { label: m[1].trim(), currency: m[2].toUpperCase(), number: m[3] };
  const p = text.trim().match(POCKET);
  return p ? { label: p[1].trim(), currency: "IDR", number: p[2] } : null;
}
const OPENING = /saldo\s*awal|opening\s*balance|beginning\s*balance|saldo\s*sebelumnya|previous\s*balance|initial\s*balance|last\s*bal(?:ance)?/i;
const CLOSING = /saldo\s*akhir|closing\s*balance|ending\s*balance|current\s*balance/i;
const FOOTER = /^(saldo\s*awal|saldo\s*akhir|mutasi\s*(cr|db|kredit|debet)|total|jumlah|bersambung|halaman|page|opening|closing|ending)\b/i;

/** Only labelled fields and each supported layout's known header cells can name the account holder. */
function holderOfHeader(lines: Line[], format: BankCode): string | undefined {
  if (!["BCA", "BRI", "MANDIRI", "BNI", "SMBC"].includes(format)) return undefined;
  const tableAt = lines.findIndex((line) => headerColumns(line));
  const header = tableAt < 0 ? lines : lines.slice(0, tableAt);
  const clean = (text: string | undefined): string | undefined => {
    const value = text?.replace(/^:\s*/, "").trim();
    if (!value || /^(?:JL\.?|Jalan|Alamat)(?:\s|:|$)/i.test(value) || /^(?:periode|period|tanggal|statement date|cabang|branch|no\.?\s*(?:rekening|rek\.?)|nomor rekening|account (?:no|number)|mata uang|currency|valuta|nama produk|product name|alamat|jalan|jl(?:\.|\s|$)|kantor cabang|saldo|laporan|rekening)\b/i.test(value)) return undefined;
    return value;
  };
  const positioned = (text: string | undefined): string | undefined => {
    const value = clean(text);
    if (!value || /^(?:PT\.?\s+)?BANK\b/i.test(value) || /^(?:BCA|BRI|BNI|SMBC|BRImo|Britama(?:-IDR)?|Tabungan Mandiri|Giro Mandiri|TAPLUS(?: BISNIS| MUDA)?)$/i.test(value)) return undefined;
    return value;
  };
  const nameLabel = /^(?:nama(?:\s+(?:nasabah|pemilik rekening|rekening))?|name|account name)(?:\s*\/\s*(?:name|account name))?(?:\s*:\s*(.*)|\s*)$/i;
  const recipient = /^kepada\s+yth\.?(?:\s*\/\s*to)?(?:\s*:\s*(.*)|\s*)$/i;
  for (const [lineIndex, line] of header.entries()) {
    for (const [cellIndex, cell] of line.cells.entries()) {
      const label = cell.text.match(nameLabel) ?? cell.text.match(recipient);
      if (!label) continue;
      const next = line.cells.slice(cellIndex + 1).find((candidate) => candidate.text.trim() !== ":");
      const value = clean(label[1] || next?.text);
      if (value) return value;
      if (format === "SMBC" && recipient.test(cell.text)) {
        const below = header[lineIndex + 1];
        if (below?.page === line.page && below.cells[0] && Math.abs(below.cells[0].x0 - cell.x0) < 5) {
          const recipientName = positioned(below.cells[0].text);
          if (recipientName) return recipientName;
        }
      }
    }
    const metadata = format === "BCA" ? /^(?:no\.?\s*rekening|nomor rekening|account (?:no|number))\b/i
      : format === "BRI" ? /^periode transaksi$/i
      : format === "BNI" ? /^(?:TAPLUS(?:\s+(?:BISNIS|MUDA))?|BNI\s+TAPLUS|GIRO\s+BNI)\b/i : null;
    if (metadata && line.cells.findIndex((cell, index) => index > 0 && metadata.test(cell.text)) > 0) {
      const value = positioned(line.cells[0].text);
      if (value) return value;
    }
  }
  return undefined;
}

export async function parsePdf(data: Buffer, opts: { password?: string } = {}): Promise<ParsedStatement> {
  return (await parsePdfSections(data, opts))[0];
}

/**
 * Combined statements (e.g. SMBC "Laporan Konsolidasi Rekening") hold several accounts, each under a header like
 * "Aktivitas Rekening / Account Activities – Jenius Main Account (IDR) 90022152088". Each section is parsed and
 * continuity-checked on its own; single-account PDFs return one statement.
 */
export async function parsePdfSections(data: Buffer, opts: { password?: string } = {}): Promise<ParsedStatement[]> {
  const lines = await readLines(data, opts.password);
  if (lines.reduce((n, l) => n + l.cells.reduce((m, c) => m + c.text.replace(/\s/g, "").length, 0), 0) < 20) {
    throw new ScanError("PDF ini hasil scan (tanpa teks). Minta rekening koran versi e-statement, atau ekspor CSV/Excel dari internet banking.");
  }
  const deposits = depositProducts(lines);
  const withDeposits = (st: ParsedStatement): ParsedStatement => (deposits.length ? { ...st, deposits } : st);
  const starts = lines.map((l, i) => ({ i, m: sectionOf(l) })).filter((x) => x.m);
  if (starts.length === 0) return [withDeposits(parseLines(lines))];
  const docText = lines.map(lineText).join("\n");
  const docHeader = lines.slice(0, starts[0].i);
  const format = detectFormat(docHeader.map(lineText).join("\n"));
  const documentHolder = holderOfHeader(docHeader, format);
  const period = periodOf(docText);
  const out: ParsedStatement[] = [];
  starts.forEach(({ i, m }, k) => {
    const segment = lines.slice(i + 1, k + 1 < starts.length ? starts[k + 1].i : lines.length);
    if (!segment.some((l) => headerColumns(l))) return; // a section title without a transaction table
    const section = { label: m!.label, currency: m!.currency };
    const holder = holderOfHeader(segment, format) ?? documentHolder;
    if (section.currency !== "IDR") {
      // A disabled section carries no parsed money. Keep the other accounts selectable.
      out.push({ format, currency: section.currency, accountNumber: m!.number, section, ...(holder ? { holder } : {}),
        periodStart: period?.start ?? new Date(0), periodEnd: period?.end ?? new Date(0),
        openingBalance: 0n, closingBalance: 0n, rows: [],
        error: `Mata uang ${section.currency} belum didukung untuk impor bank. Gunakan rekening koran IDR; nominal tidak dikonversi otomatis.`,
        provenance: { period: period ? "DECLARED" : "INFERRED", opening: "DERIVED", closing: "DERIVED" },
      });
      return;
    }
    const st = parseLines(segment, { period, format, allowEmpty: true });
    out.push(withDeposits({ ...st, currency: "IDR", accountNumber: m!.number, section, ...(holder ? { holder } : {}) }));
  });
  if (!out.length) return [withDeposits(parseLines(lines))];
  // A foreign-currency account the summary page lists with a balance but no activity section this month (readiness finding F2,
  // 2026-10-12): listed like a foreign section — never imported, no money read, no rate — so the accountant sees it and books it.
  const listed = new Set(out.map((st) => (st.accountNumber ?? "").replace(/\D/g, "")));
  for (const p of summaryProducts(docHeader)) {
    if (p.currency === "IDR" || listed.has(p.number)) continue;
    listed.add(p.number);
    out.push({ format, currency: p.currency, accountNumber: p.number, section: { label: p.product, currency: p.currency }, ...(documentHolder ? { holder: documentHolder } : {}),
      periodStart: period?.start ?? new Date(0), periodEnd: period?.end ?? new Date(0),
      openingBalance: 0n, closingBalance: 0n, rows: [],
      error: `Rekening ${p.currency} ini hanya tercantum di ringkasan (bersaldo, tanpa mutasi di laporan ini) dan tidak diimpor. Catat saldonya lewat Saldo Awal atau Jurnal Penyesuaian dengan kurs yang Anda tetapkan.`,
      provenance: { period: period ? "DECLARED" : "INFERRED", opening: "DERIVED", closing: "DERIVED" },
    });
  }
  return out;
}

/**
 * The account table of a consolidated statement's summary page (SMBC "Nama Produk · Nomor Rekening · Mata Uang · … · Saldo"): product,
 * number and currency per row, up to its Total line. Only used to list accounts that have no activity section; amounts aren't read.
 */
export function summaryProducts(lines: Line[]): { product: string; number: string; currency: string }[] {
  const out: { product: string; number: string; currency: string }[] = [];
  let inTable = false;
  for (const line of lines) {
    const text = lineText(line);
    if (/nomor rekening/i.test(text) && /mata uang/i.test(text)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (/^\s*total\b/i.test(text)) {
      inTable = false;
      continue;
    }
    const cells = line.cells.map((c) => c.text.trim()).filter(Boolean);
    const numberAt = cells.findIndex((c) => /^\d{8,16}$/.test(c));
    const currency = cells.slice(numberAt + 1).find((c) => /^[A-Z]{3}$/.test(c));
    if (numberAt < 1 || !currency) continue;
    out.push({ product: cells.slice(0, numberAt).join(" "), number: cells[numberAt], currency });
  }
  return out;
}

const DEPOSIT_TITLE = /detail produk deposito|time deposit product details/i;
const DEPOSIT_END = /^(total\b|detail produk|ini adalah akhir)/i;

/**
 * Time deposits listed after the account activity (SMBC "Detail Produk Deposito / Time Deposit Product Details"): one row per
 * deposit — number, product, currency, rate, tenor, maturity, instruction, balance, IDR equivalent. Read so Saldo Awal can
 * offer them (a deposit pledged for a PRK is the other half of that loan); never posted from here.
 */
export function depositProducts(lines: Line[]): DepositProduct[] {
  const out: DepositProduct[] = [];
  const start = lines.findIndex((l) => DEPOSIT_TITLE.test(lineText(l)));
  if (start < 0) return out;
  for (const line of lines.slice(start + 1)) {
    const text = lineText(line).trim();
    if (DEPOSIT_END.test(text)) break;
    const cells = line.cells.map((c) => c.text.trim());
    const number = cells[0];
    const currency = cells.find((c) => /^[A-Z]{3}$/.test(c));
    const amounts = cells.filter((c) => /^-?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?$/.test(c));
    if (!number || !/\d/.test(number) || !/^[0-9A-Z]{6,}$/i.test(number) || !currency || amounts.length === 0) continue;
    const maturity = cells.map((c) => parseDate(c, null)).find(Boolean) ?? null;
    out.push({
      number,
      product: cells[1] && !/^[A-Z]{3}$/.test(cells[1]) ? cells[1] : "Deposito",
      currency,
      rate: cells.find((c) => /^\d+(?:[.,]\d+)?\s*%$/.test(c))?.replace(/\s/g, "") ?? null,
      maturity: maturity ? maturity.toISOString().slice(0, 10) : null,
      idrBalance: parseBankAmount(amounts[amounts.length - 1]),
    });
  }
  return out;
}

/** Positioned text lines. Exported for `npm run inspect:statement -- --lines` when tuning a new layout. */
export type ReadLinesLimits = { maxPages?: number; maxItems?: number };
type PositionedItem = { str: string; x: number; y: number; width: number; fontSize: number };

/** Bounded evidence reads do not allocate text for all pages concurrently. */
async function boundedTextItems(doc: Awaited<ReturnType<typeof getDocumentProxy>>, maxItems: number): Promise<PositionedItem[][]> {
  const pages: PositionedItem[][] = [];
  let count = 0;
  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number);
    const reader = page.streamTextContent().getReader() as ReadableStreamDefaultReader<Awaited<ReturnType<typeof page.getTextContent>>>;
    const items: PositionedItem[] = [];
    let overLimit = false;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        for (const item of chunk.value.items) {
          if (!("str" in item)) continue;
          if (++count > maxItems) { overLimit = true; continue; }
          // Keep the same positioned-text normalization as unpdf.extractTextItems.
          const [, , c, d, x, y] = item.transform;
          items.push({ str: item.str, x, y, width: item.width, fontSize: Math.hypot(c, d) });
        }
      }
      // Drain the active page without retaining excess items. Cancelling an active
      // PDF.js stream can race its close message; no later page is requested.
      if (overLimit) throw new ParseError(`Teks PDF melebihi batas ${maxItems.toLocaleString("id-ID")} bagian. Pecah PDF menjadi beberapa file lalu unggah kembali.`);
      pages.push(items);
    } finally {
      reader.releaseLock();
      page.cleanup();
    }
  }
  return pages;
}

export async function readLines(data: Buffer, password?: string, limits: ReadLinesLimits = {}): Promise<Line[]> {
  for (const value of [limits.maxPages, limits.maxItems]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new ParseError("Batas ekstraksi PDF tidak valid.");
  }
  let doc;
  try {
    doc = await getDocumentProxy(new Uint8Array(data), { password: password || undefined });
  } catch (e) {
    const err = e as { name?: string; code?: number; message?: string };
    if (err.name === "PasswordException") throw new PdfPasswordError(err.code === 2 ? "wrong" : "needed");
    throw new ParseError("File PDF rusak atau tidak bisa dibuka.");
  }
  try {
    if (limits.maxPages !== undefined && doc.numPages > limits.maxPages) throw new ParseError(`PDF melebihi batas ${limits.maxPages} halaman. Pecah PDF menjadi beberapa file lalu unggah kembali.`);
    const items = limits.maxItems === undefined ? (await extractTextItems(doc)).items : await boundedTextItems(doc, limits.maxItems);
    const out: Line[] = [];
    items.forEach((pageItems, p) => {
      const rows: { y: number; parts: { x: number; w: number; s: string; size: number }[] }[] = [];
      for (const it of pageItems) {
        if (!it.str.trim()) continue;
        const tol = Math.max(2, it.fontSize * 0.35);
        let row = rows.find((r) => Math.abs(r.y - it.y) <= tol);
        if (!row) rows.push((row = { y: it.y, parts: [] }));
        row.parts.push({ x: it.x, w: it.width, s: it.str, size: it.fontSize || 8 });
      }
      rows.sort((a, b) => b.y - a.y); // PDF y grows upwards → top of page first
      for (const r of rows) {
        r.parts.sort((a, b) => a.x - b.x);
        const cells: Cell[] = [];
        for (const part of r.parts) {
          const last = cells[cells.length - 1];
          const gap = last ? part.x - last.x1 : Infinity;
          if (last && gap < part.size * 0.9) {
            last.text += (gap > part.size * 0.15 ? " " : "") + part.s.trim();
            last.x1 = part.x + part.w;
          } else cells.push({ x0: part.x, x1: part.x + part.w, text: part.s.trim() });
        }
        out.push({ page: p + 1, y: r.y, cells });
      }
    });
    return out;
  } finally {
    // unpdf retains caller-owned proxies; release workers and cached page data on every exit.
    await doc.loadingTask.destroy();
  }
}

const lineText = (l: Line) => l.cells.map((c) => c.text).join(" ");

function headerColumns(line: Line): Column[] | null {
  const cols: Column[] = [];
  for (const c of line.cells) {
    // "Debit (IDR)": the currency in brackets after a label isn't part of it.
    const t = c.text.replace(/\s+/g, " ").replace(/\s*\((?:idr|rp\.?|rupiah|[a-z]{3})\)$/i, "").trim();
    const kindOf = (x: string) => (Object.keys(HEADER) as ColKind[]).find((k) => HEADER[k].test(x));
    // A bilingual label ("Nominal/Amount", "Saldo / Balance"): the part a column word names. "DB/CR" is a label of its own.
    const kind = kindOf(t) ?? t.split(/\s*\/\s*/).map(kindOf).find(Boolean);
    if (kind) cols.push({ kind, x0: c.x0, x1: c.x1 });
  }
  const has = (k: ColKind) => cols.some((c) => c.kind === k);
  const hasMoney = (has("debit") && has("credit")) || has("amount");
  if (!(has("date") && has("desc") && hasMoney)) return null;
  // Keep administrative columns in the geometry: otherwise plain branch/teller numbers can be mistaken for money.
  return cols;
}

function nearest(cols: Column[], cell: Cell, kinds: ColKind[]): Column | null {
  const mid = (cell.x0 + cell.x1) / 2;
  let best: Column | null = null;
  let bestD = Infinity;
  for (const c of cols) {
    const d = Math.abs((c.x0 + c.x1) / 2 - mid);
    if (d < bestD) [best, bestD] = [c, d];
  }
  return best && kinds.includes(best.kind) ? best : null;
}

/** Currency cells must start in their column; long descriptions can overlap its centre without being currency. */
function currencyCell(cols: Column[], cell: Cell): boolean {
  const column = nearest(cols, cell, ["currency"]);
  return column !== null && cell.x0 >= column.x0 - 5;
}

/** Preflight every repeated table before any numeric conversion, using its current column positions. */
function currencyOfLines(lines: Line[], firstHeader: number): string | undefined {
  let columns: Column[] | null = null;
  const values: string[][] = [];
  const headers: string[] = [];
  for (const line of lines.slice(firstHeader)) {
    const current = headerColumns(line);
    if (current) {
      columns = current;
      headers.push(...line.cells.map((cell) => cell.text));
      continue;
    }
    if (!columns) continue;
    for (const cell of line.cells) if (currencyCell(columns, cell)) values.push([cell.text]);
  }
  // Put the extracted values in one synthetic currency column; the remaining headers contribute their explicit units only.
  return sourceCurrency(lines.slice(0, firstHeader).map(lineText), ["Currency", ...headers], [], values);
}

/** The bank a statement's heading names (`lib/banks.ts`), read only from the preamble — never from transactions. GENERIC when none. */
export function detectFormat(headerText: string): BankCode {
  return detectBank(headerText);
}

export function periodOf(text: string): { start: Date; end: Date } | null {
  const range = periodFromText(text);
  if (range) return range;
  // BRImo declares both bounds with two-digit years, day first like its transaction dates. Other layouts don't
  // print this form, and a bare dd/mm/yy range can't tell day-first from month-first, so only BRImo's title admits it.
  const short = /laporan\s+transaksi\s+finansial/i.test(text) && text.match(/(\d{1,2}\/\d{1,2}\/\d{2})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{2})(?!\d)/);
  if (short) {
    const start = parseDate(short[1], null);
    const end = parseDate(short[2], null);
    if (start && end) return { start, end };
  }
  // wondr shares the month/year across both day bounds: "Periode: 1 - 31 Januari 2026".
  const shared = text.match(/periode\s*:\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  if (shared) {
    const start = parseDate(`${shared[1]} ${shared[3]} ${shared[4]}`, null);
    const end = parseDate(`${shared[2]} ${shared[3]} ${shared[4]}`, null);
    if (start && end) return { start, end };
  }
  // "01 MEI 2026 - 31 MEI 2026" (SMBC and others print month names)
  const long = text.match(/(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\s*[-–]\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/);
  if (long) {
    const a = parseDate(long[1], null);
    const b = parseDate(long[2], null);
    if (a && b) return { start: a, end: b };
  }
  const m = text.match(/periode\s*:?\s*([A-Za-z]+)\s+(\d{4})/i);
  const month = m && MONTHS[m[1].toLowerCase()];
  if (!m || !month) return null;
  const y = Number(m[2]);
  return { start: dateOnly(y, month, 1), end: new Date(Date.UTC(y, month, 0)) };
}

function parseDate(text: string, period: { start: Date; end: Date } | null, order: DayMonthOrder = "DMY"): Date | null {
  const p = dateParts(text, { order });
  if (!p) return null;
  let y = p.y;
  if (y === null) {
    if (!period) return null;
    y = period.start.getUTCFullYear();
    if (p.m < period.start.getUTCMonth() + 1 && period.end.getUTCFullYear() > y) y++; // Dec → Jan statements
  }
  return calendarDate(y, p.m, p.d);
}

/** Points between a lead-in description line and the amount line below it (SMBC prints ~3 pt; rows are ≥ 9 pt apart). */
const LEAD_GAP = 5;

/** A line without administrative column values (row number, branch, journal, teller). */
function withoutSkipped(cells: Cell[], cols: Column[], descCol: Column): Cell[] {
  if (!cols.some((c) => c.kind === "skip")) return [...cells];
  return cells.filter((cell) => {
    const column = nearest(cols, cell, ["skip"]);
    // Long descriptions may overlap a skip column's centre. Only text starting under that column is administrative.
    return !column || !(cell.x1 <= descCol.x0 + 1 || cell.x0 >= column.x0 - 5);
  });
}

function startsWithDate(line: Line, cols: Column[], descCol: Column, period: { start: Date; end: Date } | null, order: DayMonthOrder = "DMY"): boolean {
  const first = withoutSkipped(line.cells, cols, descCol)[0];
  if (!first || first.x0 >= descCol.x0 - 1) return false;
  const tokens = first.text.split(/\s+/);
  return Boolean(parseDate(tokens.slice(0, 3).join(" "), period, order) ?? parseDate(tokens[0], period, order));
}

function money(text: string): { value: bigint; flag: "DB" | "CR" | null } {
  const m = text.trim().match(NUMBER)!;
  const f = m[1]?.toUpperCase();
  const flag = f ? (["DB", "DR", "D"].includes(f) ? "DB" : "CR") : null;
  return { value: parseBankAmount(splitMarker(text).text), flag };
}

/** Generic English tables need file-wide date evidence, just like CSV/XLSX; a bank contract or Tanggal header is day-first. */
function dateOrderOfLines(lines: Line[], firstHeader: number, format: BankCode, period: { start: Date; end: Date } | null): DayMonthOrder {
  if (format !== "GENERIC" || lines[firstHeader].cells.some((cell) => /^(?:tanggal|tgl\b)/i.test(cell.text))) return "DMY";
  let columns: Column[] | null = null;
  const texts: string[] = [];
  for (const line of lines.slice(firstHeader)) {
    const header = headerColumns(line);
    if (header) { columns = header; continue; }
    if (!columns) continue;
    const desc = columns.find((column) => column.kind === "desc")!;
    const first = withoutSkipped(line.cells, columns, desc)[0];
    if (!first || first.x0 >= desc.x0 - 1) continue;
    const candidates = [first.text, first.text.split(/\s+/)[0]];
    const numeric = candidates.find((text) => dayMonthEvidence([text]).numeric.length > 0);
    if (numeric) texts.push(numeric);
  }
  const evidence = dayMonthEvidence(texts);
  if (evidence.dmy && evidence.mdy) throw new SourceDateError("Kolom tanggal PDF mencampur hari/bulan dan bulan/hari. Samakan format tanggal sumber sebelum mengimpor.");
  if (evidence.dmy) return "DMY";
  if (evidence.mdy) return "MDY";
  if (!texts.length) return "DMY";
  const periodOrders: DayMonthOrder[] = [];
  const possible = (["DMY", "MDY"] as const).filter((order) => {
    const dates = texts.map((text) => {
      const parts = dateParts(text, { order });
      if (!parts) return NaN;
      let year = parts.y ?? period?.start.getUTCFullYear() ?? 2000;
      if (parts.y === null && period && parts.m < period.start.getUTCMonth() + 1 && period.end.getUTCFullYear() > year) year++;
      const date = dateOnly(year, parts.m, parts.d);
      if (date.getUTCMonth() + 1 !== parts.m || (period && (+date < +period.start || +date > +period.end))) return NaN;
      return +date;
    });
    if (period && dates.every(Number.isFinite)) periodOrders.push(order);
    return dates.every(Number.isFinite) && (dates.every((date, i) => !i || date >= dates[i - 1]) || dates.every((date, i) => !i || date <= dates[i - 1]));
  });
  if (periodOrders.length === 1) return periodOrders[0];
  if (possible.length === 1) return possible[0];
  if (texts.every((text) => { const parts = dateParts(text)!; return parts.d === parts.m; })) return "DMY";
  throw new AmbiguousDateError("Urutan tanggal PDF belum dapat dipastikan: hari/bulan atau bulan/hari. Gunakan Atur kolom untuk memilih urutannya, atau unggah sumber dengan tanggal YYYY-MM-DD.");
}

function parseLines(lines: Line[], ctx: { period?: { start: Date; end: Date } | null; format?: BankCode; allowEmpty?: boolean } = {}): ParsedStatement {
  const firstHeader = lines.findIndex((l) => headerColumns(l));
  if (firstHeader < 0) {
    throw new ParseError("Tabel transaksi di PDF tidak dikenali (kolom tanggal, keterangan, mutasi/debet-kredit tidak ditemukan). Kirim contoh baris judulnya agar formatnya bisa ditambahkan.");
  }
  const preamble = lines.slice(0, firstHeader).map(lineText).join("\n");
  const holder = holderOfHeader(lines.slice(0, firstHeader), ctx.format ?? detectFormat(preamble));
  const currency = currencyOfLines(lines, firstHeader);
  const allText = lines.map(lineText).join("\n");
  const period = ctx.period ?? periodOf(preamble) ?? periodOf(allText);
  const order = dateOrderOfLines(lines, firstHeader, ctx.format ?? detectFormat(preamble), period);
  // wondr prints its account in the right-hand product cell, never in a transaction.
  const headerCells = lines.slice(0, firstHeader).flatMap((line) => line.cells);
  const rightColumn = (Math.min(...headerCells.map((cell) => cell.x0)) + Math.max(...headerCells.map((cell) => cell.x1))) / 2;
  const productHeader = /laporan\s+mutasi\s+rekening/i.test(preamble)
    ? headerCells.find((cell) => cell.x0 > rightColumn && /^(?:TAPLUS(?:\s+(?:BISNIS|MUDA))?|BNI\s+TAPLUS|GIRO\s+BNI)\b/i.test(cell.text))
    : undefined;
  const wondrAccount = productHeader?.text.match(/^(?:TAPLUS(?:\s+(?:BISNIS|MUDA))?|BNI\s+TAPLUS|GIRO\s+BNI)\s+-\s+(\d{10})$/i)?.[1];
  const accountNumber = productHeader ? wondrAccount ?? null :
    preamble
      .split("\n")
      .filter((t) => /(no\.?\s*rek|nomor rekening|rekening|account)/i.test(t))
      .map((t) => t.match(/\d[\d-]{5,}\d/)?.[0])
      .find(Boolean)
      ?.replace(/-/g, "") ?? null;

  const brimo = /laporan\s+transaksi\s+finansial/i.test(preamble) && /nama\s+produk\s*:?\s*britama(?:-IDR)?\b/i.test(preamble);
  const sen = new SenWatch();
  type Draft = ParsedRow & { flag: "DB" | "CR" | null; parts: string[]; page: number; lastY: number; moneySeen: boolean; unreadable: string | null };
  const drafts: Draft[] = [];
  let cols: Column[] | null = null;
  let current: Draft | null = null;
  let opening: bigint | null = null;
  let closing: bigint | null = null;
  let lineNo = 0;
  let footerPage: number | null = null;
  let summaryValuesAt = -1;
  const brimoFooter = (line: Line) => line.cells.some((cell) => /^created by brimo$/i.test(cell.text)) && !parseDate(line.cells[0]?.text.split(/\s+/)[0] ?? "", period, order);
  // The summary values follow their labels or, when the labels end a page, open the next page under its repeated title.
  // Only the English label row, that page's footer and the next page's title lines may sit in between.
  const brimoSummaryValues = (labelsAt: number): number => {
    const labels = lines[labelsAt];
    let footer = false;
    for (let at = labelsAt + 1; at < lines.length; at++) {
      const line = lines[at];
      if (line.page > labels.page + 1) break;
      if (line.page === labels.page && (footer || (footer = brimoFooter(line)))) continue;
      if (line.cells.every((cell) => NUMBER.test(cell.text.trim()))) return at;
      const between = line.page === labels.page
        ? at === labelsAt + 1 && line.cells.some((cell) => /^opening balance$/i.test(cell.text))
        : !headerColumns(line) && !parseDate(line.cells[0]?.text.split(/\s+/)[0] ?? "", period, order);
      if (!between) break;
    }
    return -1;
  };
  // Description text printed just above a row's amount line (SMBC centres a two-line description on it): held for that row.
  let lead: string[] = [];
  // BCA prints a row's counterparty below it, and across a page break under the repeated header (UC-B1g): the row a new page continues.
  const bca = (ctx.format ?? detectFormat(preamble)) === "BCA";
  let carried: Draft | null = null;
  // The last row of a page, until the next page's header shows whether undated lines below it continue it.
  let pending: Draft | null = null;

  for (const [index, line] of lines.entries()) {
    lineNo++;
    const header = headerColumns(line);
    if (header) {
      cols = header;
      const last = current ?? pending;
      carried = bca && last && line.page > last.page ? last : null;
      pending = null;
      current = null;
      lead = [];
      continue;
    }
    const text = lineText(line);
    if (index === summaryValuesAt) { current = null; continue; }
    if (brimo && brimoFooter(line)) footerPage = line.page;
    if (footerPage === line.page) { current = null; continue; }
    // BRImo prints opening and closing in a horizontal summary only on the last page.
    // Read their own cells, independently of the running balances in the transaction table.
    if (brimo && line.cells.some((cell) => /^saldo awal$/i.test(cell.text)) && line.cells.some((cell) => /^saldo akhir$/i.test(cell.text))) {
      summaryValuesAt = brimoSummaryValues(index);
      const values = lines[summaryValuesAt];
      if (!values || values.cells.length !== line.cells.length) {
        throw new SourceAmountError("Nominal ringkasan BRImo tidak lengkap. Periksa Saldo Awal, total Debet/Kredit, dan Saldo Akhir pada file.");
      }
      const first = line.cells.findIndex((cell) => /^saldo awal$/i.test(cell.text));
      const last = line.cells.findIndex((cell) => /^saldo akhir$/i.test(cell.text));
      values.cells.forEach((cell) => { parseBankAmount(cell.text); sen.check(cell.text, lineNo); });
      opening ??= parseBankAmount(values.cells[first].text);
      closing = parseBankAmount(values.cells[last].text);
      current = null;
      continue;
    }
    // "Saldo Awal : 1.000", bilingual "Saldo Awal/Initial Balance 1.000", BTN "Last Bal : 1,000.00".
    const labelled = text.match(/(saldo\s*awal|saldo\s*sebelumnya|opening\s*balance|beginning\s*balance|starting\s*balance|previous\s*balance|initial\s*balance|last\s*bal(?:ance)?|saldo\s*akhir|closing\s*balance|ending\s*balance|current\s*balance)(?:\s*\/\s*[A-Za-z ]+?)?\s*:?\s*(?:rp\.?\s*)?([\d.,()-]*\d[\d.,()-]*)/i);
    if (labelled && !(cols && parseDate(line.cells[0]?.text ?? "", period, order))) {
      const v = parseBankAmount(labelled[2]);
      if (OPENING.test(labelled[1])) opening ??= v;
      else if (CLOSING.test(labelled[1])) closing = v;
      current = null;
      continue;
    }
    if (!cols) continue;

    const dateCol = cols.find((c) => c.kind === "date")!;
    const descCol = cols.find((c) => c.kind === "desc")!;
    const moneyKinds: ColKind[] = ["debit", "credit", "amount", "balance"];
    const cells = withoutSkipped(line.cells, cols, descCol).filter((cell) => !currencyCell(cols!, cell));
    let date: Date | null = null;
    const first = cells[0];
    if (first && first.x0 < descCol.x0 - 1) {
      // The date may share a cell with a time or the start of the description ("06/08/2026 10:21 TRSF …").
      const tokens = first.text.split(/\s+/);
      const long = parseDate(tokens.slice(0, 3).join(" "), period, order);
      date = long ?? parseDate(tokens[0], period, order);
      if (date) {
        const tail = tokens.slice(long ? 3 : 1).join(" ").replace(/^\d{1,2}[:.]\d{2}(?::\d{2})?\s*(?:WIB|WITA|WIT)?\s*/i, "");
        cells[0] = { ...first, text: tail };
        if (!tail) cells.shift();
      }
    }

    const descParts: string[] = [];
    const nums: { kind: ColKind; text: string; value: bigint; flag: "DB" | "CR" | null }[] = [];
    let flag: "DB" | "CR" | null = null;
    // A figure under an amount column that isn't a readable number ("45.6x8,00"): remembered so its row can't become a silent 0.
    let unreadable: string | null = null;
    for (const c of cells) {
      if (NUMBER.test(c.text) && c.x0 > descCol.x0) {
        const col = nearest(cols, c, moneyKinds);
        if (col) {
          sen.check(c.text, lineNo);
          nums.push({ kind: col.kind, text: c.text, ...money(c.text) });
          continue;
        }
      }
      if (/^(DB|CR|DR|D|K|C)\.?$/i.test(c.text) && c.x0 > descCol.x1) {
        flag = /^(DB|DR|D)\.?$/i.test(c.text) ? "DB" : "CR";
        continue;
      }
      if (c.x0 > descCol.x0 && looksLikeAmount(c.text) && !dateParts(c.text) && nearest(cols, c, moneyKinds)) unreadable ??= c.text;
      if (c.x0 >= dateCol.x1 - 1 || date) descParts.push(c.text);
    }

    if (date) {
      // A second date column (posting date, "Tanggal Pembukuan") isn't part of the description.
      if (descParts.length && parseDate(descParts[0], period, order)) descParts.shift();
      const desc = [...lead, ...descParts].join(" ").replace(/\s+/g, " ").trim();
      const leadRaw = lead.length ? `${lead.join(" / ")} / ` : "";
      lead = [];
      const bal = nums.find((n) => n.kind === "balance");
      carried = null;
      pending = null;
      if (OPENING.test(desc) && nums.every((n) => n.kind === "balance")) {
        // A second Saldo Awal after transactions that doesn't continue the balance is another account read into this one (an SMBC
        // sub-product whose title wasn't recognised, UC-B1d): refused rather than merged. A month's Saldo Awal that continues is fine.
        // "Continues": equal to the last printed balance, or to it plus the signed rows after it (a month whose last row prints none).
        const lastPrinted = drafts.map((d) => d.balance !== null).lastIndexOf(true);
        const abs = (v: bigint) => (v < 0n ? -v : v);
        const signed = (d: Draft) => (d.flag === "DB" ? -abs(d.amount) : d.flag === "CR" ? abs(d.amount) : d.amount);
        const before = lastPrinted >= 0 ? drafts[lastPrinted].balance! : opening;
        const running = before === null ? null : drafts.slice(lastPrinted + 1).reduce((sum, d) => sum + signed(d), before);
        if (bal && opening !== null && drafts.length && before !== null && bal.value !== before && bal.value !== running) {
          throw new ParseError(`File ini tampaknya berisi lebih dari satu rekening: ada baris Saldo Awal kedua di halaman ${line.page} (${desc.slice(0, 40)}) yang tidak melanjutkan saldo sebelumnya. Pisahkan file per rekening, atau kirim contoh judul bagiannya agar formatnya bisa ditambahkan.`);
        }
        if (bal) opening ??= bal.value;
        current = null;
        continue;
      }
      // The column says the direction: BSI prints debits "- 1,000.00" in the Debit column.
      const unsigned = (v: bigint | undefined) => (v === undefined ? 0n : v < 0n ? -v : v);
      assertSingleSide(nums.find((n) => n.kind === "debit")?.text, nums.find((n) => n.kind === "credit")?.text, lineNo);
      const dr = unsigned(nums.find((n) => n.kind === "debit")?.value);
      const cr = unsigned(nums.find((n) => n.kind === "credit")?.value);
      const amt = nums.find((n) => n.kind === "amount");
      current = {
        date,
        description: desc,
        amount: amt ? amt.value : cr - dr,
        balance: bal?.value ?? null,
        rowNumber: lineNo,
        rawRow: `hal. ${line.page} · ${leadRaw}${line.cells.map((c) => c.text).join(" | ")}`,
        flag: amt?.flag ?? flag,
        parts: [desc],
        page: line.page,
        lastY: line.y,
        moneySeen: nums.some((n) => n.kind !== "balance"),
        unreadable,
      };
      if (!amt && dr === 0n && cr === 0n) current.amount = 0n;
      drafts.push(current);
      continue;
    }

    // A text line sitting just above the next row's amounts, nearer to it than to the current row, starts that row's description.
    const next = lines[index + 1];
    if (descParts.length && !nums.length && next && next.page === line.page && !FOOTER.test(text) && startsWithDate(next, cols, descCol, period, order)) {
      const gap = line.y - next.y;
      if (gap >= 0 && gap <= LEAD_GAP && (!current || current.page !== line.page || current.lastY - line.y > gap)) {
        lead.push(descParts.join(" "));
        continue;
      }
    }

    // A "TANGGAL :06/08" line BCA prints between a row and its counterparty is not part of a description, and doesn't end the row.
    const words = descParts.filter((t) => !/^tanggal\s*:\s*\d{1,2}\/\d{1,2}$/i.test(t.trim()));
    if (!nums.length && !words.length && /^tanggal\s*:/i.test(text.trim())) continue;
    descParts.splice(0, descParts.length, ...words);
    // BCA: undated description lines right under a new page's header continue the last row of the page before.
    if (!current && carried && bca && line.page === carried.page + 1 && descParts.length && !nums.length && !FOOTER.test(text)) {
      carried.parts.push(descParts.join(" "));
      carried.description = carried.parts.join(" ").replace(/\s+/g, " ").trim();
      carried.rawRow += ` / hal. ${line.page} · ${line.cells.map((c) => c.text).join(" | ")}`;
      continue;
    }

    // Continuation of the previous row's description (same page, close below, not a footer).
    // A line holding only the row's amount (blu prints it below the date and description) continues it too.
    const amountOnly = !descParts.length && !!current && !current.moneySeen && nums.some((n) => n.kind !== "balance");
    if (current && line.page === current.page && current.lastY - line.y < 30 && !FOOTER.test(text) && (descParts.length || amountOnly)) {
      if (descParts.length) current.parts.push(descParts.join(" "));
      current.description = current.parts.join(" ").replace(/\s+/g, " ").trim();
      current.rawRow += ` / ${line.cells.map((c) => c.text).join(" | ")}`;
      current.lastY = line.y;
      if (unreadable && !current.moneySeen) current.unreadable ??= unreadable;
      if (current.amount === 0n && nums.length) {
        assertSingleSide(nums.find((n) => n.kind === "debit")?.text, nums.find((n) => n.kind === "credit")?.text, lineNo);
        const amt = nums.find((n) => n.kind === "amount")
          ?? nums.find((n) => (n.kind === "credit" || n.kind === "debit") && n.value !== 0n)
          ?? nums.find((n) => n.kind === "credit" || n.kind === "debit");
        if (amt) current.moneySeen = true;
        if (amt) current.amount = amt.kind === "debit" ? -(amt.value < 0n ? -amt.value : amt.value) : amt.kind === "credit" && amt.value < 0n ? -amt.value : amt.value;
        if (amt?.flag) current.flag = amt.flag;
        current.balance ??= nums.find((n) => n.kind === "balance")?.value ?? null;
      }
    } else {
      if (bca && current) pending = current;
      current = null;
    }
  }

  for (const d of drafts) {
    if (d.unreadable) {
      throw new SourceAmountError(`Nominal "${d.unreadable}" di halaman ${d.page} tidak bisa dibaca (baris: ${d.description.slice(0, 60) || "tanpa keterangan"}). Ekspor CSV/Excel dari internet banking, atau kirim contoh barisnya.`);
    }
  }
  if (drafts.length === 0 && !(ctx.allowEmpty && opening !== null)) throw new ParseError("Tidak ada baris transaksi yang terbaca dari PDF ini.");

  // Single amount column: sign from the DB/CR marker, else from the balance movement.
  let prevBalance = opening;
  for (const d of drafts) {
    const abs = d.amount < 0n ? -d.amount : d.amount;
    if (d.flag) d.amount = d.flag === "DB" ? -abs : abs;
    else if (d.amount > 0n && d.balance !== null && prevBalance !== null && prevBalance - abs === d.balance) d.amount = -abs;
    if (d.balance !== null) prevBalance = d.balance;
    else if (prevBalance !== null) prevBalance += d.amount;
  }

  const rows: ParsedRow[] = drafts.map(({ date, description, amount, balance, rowNumber, rawRow }) => ({ date, description, amount, balance, rowNumber, rawRow }));
  const printedOpening = opening !== null;
  if (opening === null) {
    const f = rows[0];
    if (!f) throw new ParseError("Tidak ada baris transaksi yang terbaca dari PDF ini.");
    if (f.balance === null) throw new ParseError("Saldo awal tidak ditemukan di PDF (tidak ada SALDO AWAL dan kolom saldo kosong).");
    opening = f.balance - f.amount;
  }
  const bounds = period ?? monthBoundsOf(rows);
  return {
    format: ctx.format ?? detectFormat(preamble),
    accountNumber,
    ...(holder ? { holder } : {}),
    currency,
    provenance: { period: period ? "DECLARED" : "INFERRED", opening: printedOpening ? "PRINTED" : "DERIVED", closing: closing !== null ? "PRINTED" : closingProvenance(rows) },
    periodStart: bounds.start,
    periodEnd: bounds.end,
    openingBalance: opening,
    closingBalance: closing ?? closingFromRows(rows, opening),
    rows,
    ...(sen.note() ? { notes: [sen.note()!] } : {}),
  };
}
