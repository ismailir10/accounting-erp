import { inflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { readCsv } from "@/lib/import/parsers/common";
import { readLines } from "@/lib/import/parsers/pdf";
import { centsToMinor, parseCents } from "@/lib/money";
import { CURRENCY_CODES } from "@/lib/fx/currency";
import { detectTables, readSheets, readTable } from "@/lib/ledger-import/read";
import { asXlsx, sniffFile } from "@/lib/import/workbook";
import type { EvidenceKind, EvidencePassage, EvidenceTable, EvidenceUnit, Extraction } from "./types";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TEXT = 100_000;
const MAX_ROWS = 2_000;
const MAX_PASSAGES = 1_000;
const MAX_SHEETS = 30;
const MAX_COLUMNS = 100;
const TRUNCATED = "Ekstraksi dibatasi; sebagian isi belum diperiksa. Pecah dokumen untuk memeriksa seluruh isi.";
type Row = { locator: string; cells: { text: string; locator: string; numeric?: boolean }[] };

const MONTHS: Record<string, number> = { jan: 1, januari: 1, january: 1, feb: 2, februari: 2, february: 2, mar: 3, maret: 3, march: 3, apr: 4, april: 4, mei: 5, may: 5, jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, aug: 8, agustus: 8, august: 8, sep: 9, september: 9, oct: 10, oktober: 10, october: 10, nov: 11, november: 11, dec: 12, desember: 12, december: 12 };
const DATE_PATTERN = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{4}|\d{1,2}\s+[A-Za-z]+\s+\d{4})\b/g;
function parseDate(value: string): string | null {
  let year: number, month: number, day: number;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const numeric = value.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  const words = value.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (iso) [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (numeric) {
    // A standalone 01/02/2024 has two valid interpretations. Do not guess locale.
    if (Number(numeric[1]) <= 12 && Number(numeric[2]) <= 12 && numeric[1] !== numeric[2]) return null;
    [year, month, day] = [Number(numeric[3]), Number(numeric[2]), Number(numeric[1])];
  } else if (words && MONTHS[words[2].toLowerCase()]) [year, month, day] = [Number(words[3]), MONTHS[words[2].toLowerCase()], Number(words[1])];
  else return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d.toISOString().slice(0, 10) : null;
}

function period(text: string): { start: string | null; end: string | null } {
  for (const line of text.split("\n")) {
    if (!/period|periode|year ended|tahun.*berakhir|as (?:at|of)|per tanggal|tanggal laporan|^(?:date|tanggal)\s*[:|]/i.test(line)) continue;
    const dates = [...line.matchAll(DATE_PATTERN)].map((m) => parseDate(m[0]));
    if (dates.length === 2 && dates[0] && dates[1] && dates[0] <= dates[1]) return { start: dates[0], end: dates[1] };
    if (dates.length === 1 && dates[0]) {
      const end = dates[0];
      if (/year ended|tahun.*berakhir/i.test(line)) {
        const d = new Date(`${end}T00:00:00Z`);
        const month = d.getUTCMonth();
        d.setUTCFullYear(d.getUTCFullYear() - 1);
        // Clamp February 29 to previous February's last day before adding a day.
        if (d.getUTCMonth() !== month) d.setUTCDate(0);
        d.setUTCDate(d.getUTCDate() + 1);
        return { start: d.toISOString().slice(0, 10), end };
      }
      if (/as (?:at|of)|per tanggal|tanggal laporan|^(?:date|tanggal)\s*[:|]/i.test(line)) return { start: null, end };
    }
  }
  return { start: null, end: null };
}

function currencyOf(text: string): string | null {
  const found = new Set(CURRENCY_CODES.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(text)));
  if (/\b(?:rupiah|Rp\.?)\b/i.test(text)) found.add("IDR");
  if (/S\$/.test(text)) found.add("SGD");
  if (/US\$/.test(text)) found.add("USD");
  return found.size === 1 ? [...found][0] : null;
}

function scaleOf(text: string): string {
  const scales = new Set<string>();
  const currency = `(?:${CURRENCY_CODES.join("|")}|Rp\\.?|Rupiah|US\\$|S\\$)`;
  const magnitude = "(?:thousands?|ribuan|ribu|millions?|jutaan|juta|billions?|miliar|milyar|['’]000(?:[.,]000)?|000s|hundreds|ratusan|lakhs|crores)";
  const currencyHeader = new RegExp(`^\\s*\\(?\\s*${currency}\\s*[|(]?\\s*${magnitude}(?:\\s+${currency})?\\s*\\)?\\s*$`, "i");
  const declaration = /^\s*\(?\s*(?:(?:all\s+)?(?:amounts?|figures?)(?:\s+are)?\s+(?:(?:expressed|stated|presented)\s+)?in\b|(?:disajikan|dinyatakan|angka(?:-angka)?(?:\s+disajikan)?|nilai|nominal)\s+dalam\b|(?:satuan|skala|scale|units?)\s*[:|]|(?:in|dalam)\s+(?:ribuan|ribu|jutaan|juta|miliar|milyar|thousands?|millions?|billions?|hundreds|ratusan|lakhs|crores)\b)/i;
  for (const line of text.split("\n")) {
    // Narrative figures such as "2 juta pelanggan" are never a table-wide multiplier.
    if (!declaration.test(line) && !currencyHeader.test(line)) continue;
    if (/\b(?:hundreds|ratusan|lakhs|crores)\b/i.test(line)) return "UNKNOWN";
    if (/\b(?:thousands?|ribuan|ribu)\b|['’]000(?![0-9.,])|\b000s\b/i.test(line)) scales.add("1000");
    if (/['’]000[.,]000(?![0-9.,])|\b(?:millions?|jutaan|juta)\b/i.test(line)) scales.add("1000000");
    if (/\b(?:billions?|miliar|milyar)\b/i.test(line)) scales.add("1000000000");
  }
  return scales.size > 1 ? "UNKNOWN" : [...scales][0] ?? "1";
}

/** A statement's column header row: date, description, movement (debit+credit or one amount) and balance. */
function statementHeader(rows: Row[]): boolean {
  return rows.some((row) => {
    const cells = row.cells.map((c) => c.text.trim().toLowerCase()).filter(Boolean);
    const has = (re: RegExp) => cells.some((c) => re.test(c));
    return has(/^(?:tanggal|tgl\.?|date|transaction date|tanggal transaksi|posting date|value date)$/) &&
      has(/^(?:keterangan|deskripsi|description|uraian|remarks?|transaksi|transaction details?|particulars)$/) &&
      (has(/^(?:debit|debet|db|withdrawals?)$/) && has(/^(?:kredit|credit|cr|deposits?)$/) || has(/^(?:mutasi|jumlah|amount|nominal)$/)) &&
      has(/^(?:saldo|balance|saldo akhir|running balance)$/);
  });
}

/**
 * Only a table the ledger import can read is a ledger; only a statement-shaped header with bank wording is a bank
 * statement. Keywords elsewhere ("Rekening koran" in a memo, "general ledger" in a title) never make a source.
 */
function kindOf(text: string, rows: Row[], table: boolean): EvidenceKind {
  if (table) return "LEDGER";
  if (/rekening koran|bank statement|account activities|mutasi rekening|no\.? rekening|account (?:no|number)/i.test(text) && statementHeader(rows)) return "BANK";
  if (/neraca|laba rugi|balance sheet|financial statements?|income statement|profit (?:and|&) loss|cash flow|arus kas|trial balance/i.test(text)) return "REPORT";
  if (/company profile|profil perusahaan|company name|nama perusahaan|business activity|kegiatan usaha|business overview/i.test(text)) return "CONTEXT";
  return "UNKNOWN";
}

function numericToken(raw: string, canonicalDecimal = false): string | null {
  const s = raw.trim().replace(/^(?:IDR|USD|SGD|JPY|EUR|AUD|CNY|HKD|MYR|GBP|Rp\.?|US\$|S\$)\s*/i, "");
  if (!/^\(?[+-]?\d+(?:[.,]\d+)*\)?$/.test(s)) return null;
  const unsigned = s.replace(/[()+-]/g, "");
  if (canonicalDecimal) return /^\d+(?:\.\d+)?$/.test(unsigned) ? s : null;
  // One separator with three trailing digits could mean grouping or precision.
  // Keep ambiguous text searchable without treating it as a validated figure.
  if (/^\d+[.,]\d{3}$/.test(unsigned)) return null;
  // Accept integers, grouped thousands, or at most two decimal places.
  if (!/^\d+$/.test(unsigned) && !/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(unsigned) && !/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(unsigned) && !/^\d+[.,]\d{1,2}$/.test(unsigned)) return null;
  return s;
}

function scaledMinor(token: string, currency: string, scale: string, canonicalDecimal: boolean): bigint {
  const negative = /^\(|^-/.test(token);
  let unsigned = token.replace(/[()+-]/g, "");
  let separator: string | null = null;
  if (canonicalDecimal) separator = unsigned.includes(".") ? "." : null;
  else if (unsigned.includes(".") && unsigned.includes(",")) separator = unsigned.lastIndexOf(".") > unsigned.lastIndexOf(",") ? "." : ",";
  else if (/[.,]\d{1,2}$/.test(unsigned)) separator = unsigned.includes(".") ? "." : ",";
  const decimals = separator ? unsigned.length - unsigned.lastIndexOf(separator) - 1 : 0;
  unsigned = unsigned.replace(/[.,]/g, "");
  const scaled = BigInt(unsigned) * BigInt(scale);
  const digits = scaled.toString().padStart(decimals + 1, "0");
  // Scale before rounding. A numeric Excel 1.234 in millions is 1,234,000, not 1,230,000.
  const normalized = decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals).padEnd(4, "0")}` : digits;
  return centsToMinor(parseCents(`${negative ? "-" : ""}${normalized}`), currency);
}
function numericCell(value: ExcelJS.CellValue): boolean {
  return typeof value === "number" || !!value && typeof value === "object" && ("formula" in value || "sharedFormula" in value) && typeof value.result === "number";
}

const MAX_ISSUES = 20;
/** Per-cell issue shapes → one summary line per sheet: count, a few cell addresses, the fix. */
const CELL_ISSUES: { re: RegExp; summary: (n: string, cells: string, rest: string) => string }[] = [
  { re: /^Rumus (\S+) belum memiliki hasil tersimpan\. (.+)$/, summary: (n, cells, rest) => `${n} rumus belum memiliki hasil tersimpan (contoh: ${cells}). ${rest}` },
  { re: /^Tanggal (\S+) tidak valid\. (.+)$/, summary: (n, cells, rest) => `${n} tanggal tidak valid (contoh: ${cells}). ${rest}` },
  { re: /^Angka (\S+) melebihi presisi Excel; (.+)$/, summary: (n, cells, rest) => `${n} angka melebihi presisi Excel (contoh: ${cells}); ${rest}` },
  { re: /^Sel (\S+) berisi kesalahan (.+)\.$/, summary: (n, cells, rest) => `${n} sel berisi kesalahan ${rest} (contoh: ${cells}).` },
  { re: /^Pemisah nominal (\S+) ambigu; (.+)$/, summary: (n, cells, rest) => `${n} pemisah nominal ambigu (contoh: ${cells}); ${rest}` },
  { re: /^Nominal (\S+) belum dapat dipastikan\.()$/, summary: (n, cells) => `${n} nominal belum dapat dipastikan (contoh: ${cells}).` },
];

/**
 * One line per issue kind instead of one per cell: a sheet full of uncached formulas must not render thousands of lines.
 * Sheet-level issues come first (processing limits are detected from them); at most 20 lines, then a count.
 */
function aggregateIssues(issues: string[]): string[] {
  const general: string[] = [];
  const groups = new Map<string, { index: number; rest: string; cells: string[]; original: string }>();
  for (const issue of new Set(issues)) {
    const index = CELL_ISSUES.findIndex((c) => c.re.test(issue));
    if (index < 0) { general.push(issue); continue; }
    const [, locator, rest] = issue.match(CELL_ISSUES[index].re)!;
    const key = `${index}|${rest}`;
    const group = groups.get(key) ?? { index, rest, cells: [], original: issue };
    group.cells.push(locator.slice(locator.lastIndexOf("!") + 1));
    groups.set(key, group);
  }
  const cells = [...groups.values()].map((g) => g.cells.length === 1 ? g.original : CELL_ISSUES[g.index].summary(g.cells.length.toLocaleString("id-ID"), g.cells.slice(0, 3).join(", "), g.rest));
  const all = [...general, ...cells];
  return all.length <= MAX_ISSUES ? all : [...all.slice(0, MAX_ISSUES - 1), `Dan ${(all.length - MAX_ISSUES + 1).toLocaleString("id-ID")} temuan lain.`];
}

/** Header words that are column titles or statuses, never a company name ("Source Type", "GL Entry ID", "PASS"). */
const NOT_A_NAME = /\b(?:id|type|category|year|date|code|status|period|periode|opening|closing|pass|fail|ok|review|total|amount|debit|credit|balance|account|reference)\b/i;
const NAME_LABEL = /^(?:nama perusahaan|company name|entitas|entity)$/i;

/** Company name from a label → value pair only: `Label: value` in one cell, or a row of exactly label and value. */
function entityNames(rows: Row[]): string[] {
  const names: string[] = [];
  for (const row of rows) {
    const cells = row.cells.map((c) => c.text.trim()).filter((t) => t && t !== ":");
    let value: string | undefined;
    if (cells.length === 1) {
      value = cells[0].match(/^(?:nama perusahaan|company name|entitas|entity)\s*:\s*(.+)$/i)?.[1] ??
        cells[0].match(/^((?:PT\.?|CV\.?)\s+.{2,120}|.{2,100}\b(?:Pte\.? Ltd\.?|Limited|Ltd\.?|LLC))$/i)?.[1];
    } else if (cells.length === 2 && NAME_LABEL.test(cells[0].replace(/\s*:$/, ""))) value = cells[1];
    value = value?.trim();
    if (value && /[a-z]/i.test(value) && !NOT_A_NAME.test(value)) names.push(value);
  }
  return [...new Set(names)];
}

function buildUnit(key: string, label: string, rows: Row[], initialIssues: string[] = [], table?: EvidenceTable): EvidenceUnit {
  const issues = [...initialIssues];
  let chars = 0;
  const passages: EvidencePassage[] = [];
  const includedRows: Row[] = [];
  for (const row of rows) {
    const text = row.cells.map((c) => c.text).join(" | ").trim();
    if (!text) continue;
    if (passages.length >= MAX_PASSAGES || chars + text.length > MAX_TEXT) { issues.push(TRUNCATED); break; }
    chars += text.length;
    passages.push({ locator: row.locator, text });
    includedRows.push(row);
  }
  const heading = passages.slice(0, 40).map((p) => p.text).join("\n");
  const kind = kindOf(heading, includedRows.slice(0, 40), Boolean(table));
  const currency = currencyOf(heading);
  const scale = scaleOf(heading);
  // A postable table's coverage comes from its rows; prose such as "Closing … Opening …" is not a balance date.
  const { start: periodStart, end: periodEnd } = table ? { start: table.periodStart, end: table.periodEnd } : period(heading);
  const entities = entityNames(includedRows.slice(0, 15));
  const entity = entities.length === 1 ? entities[0] : null;
  const unit: EvidenceUnit = { key, label, kind, role: kind === "BANK" || kind === "LEDGER" ? "SOURCE" : kind === "REPORT" ? "COMPARISON" : "CONTEXT", entity, periodStart, periodEnd, currency, scale, passages, figures: [], facts: [], issues, ...(table ? { table } : {}) };
  if (!entity && !table?.entities.length) issues.push(entities.length > 1 ? "Lebih dari satu entitas; pilih cakupan dokumen." : "Entitas belum dikenali; konfirmasi perusahaan.");
  if (kind !== "CONTEXT") {
    if (!currency) issues.push("Mata uang belum pasti atau lebih dari satu; konfirmasi per bagian.");
    if (table?.mode === "NERACA" && !periodEnd) issues.push("Tanggal neraca tidak tertulis di file; isi tanggalnya saat konfirmasi.");
    else if (!periodEnd) issues.push("Periode belum pasti; konfirmasi tanggal laporan.");
    if (scale === "UNKNOWN") issues.push("Skala nominal tidak pasti; konfirmasi satuan angka.");
  }
  for (const p of passages) {
    if (entity && p.text.includes(entity) && !unit.facts.some((f) => f.key === "companyName")) unit.facts.push({ key: "companyName", value: entity, locator: p.locator });
    const activity = p.text.match(/(?:kegiatan usaha|bidang usaha|business activity)\s*[:|]\s*(.+)/i);
    if (activity) unit.facts.push({ key: "businessActivity", value: activity[1].slice(0, 500), locator: p.locator });
    if (/year ended|tahun.*berakhir/i.test(p.text) && periodEnd) unit.facts.push({ key: "fiscalYearEnd", value: periodEnd.slice(5), locator: p.locator });
  }
  // Source numbers remain searchable even when ambiguity makes arithmetic unsafe.
  // Structured figures are only emitted for unambiguous single-column report rows.
  const comparativeColumns = includedRows.some((row) => row.cells.filter((cell) => /^(?:19|20)\d{2}$/.test(cell.text.trim()) || parseDate(cell.text.trim())).length > 1);
  if (kind === "REPORT" && comparativeColumns) issues.push("Kolom perbandingan beberapa periode terdeteksi; angka perlu dipetakan per periode sebelum dihitung.");
  if (kind === "REPORT" && currency && scale !== "UNKNOWN" && periodEnd && !comparativeColumns) {
    for (const row of includedRows) {
      const cells = row.cells.filter((c) => c.text.trim());
      let label: string, raw: string, locator: string;
      let numeric = false;
      for (const cell of cells) {
        if (!cell.numeric && /^\(?[+-]?\d+[.,]\d{3}\)?$/.test(cell.text.trim())) issues.push(`Pemisah nominal ${cell.locator} ambigu; angka disimpan sebagai teks sampai format dikonfirmasi.`);
      }
      if (cells.length === 2 && numericToken(cells[1].text, cells[1].numeric) && !numericToken(cells[0].text)) {
        [label, raw, locator] = [cells[0].text, cells[1].text, cells[1].locator];
        numeric = cells[1].numeric ?? false;
      } else if (cells.length === 1) {
        const m = cells[0].text.match(/^(.+?)\s*:\s*((?:(?:IDR|USD|SGD|Rp\.?)\s*)?\(?[+-]?\d[\d.,]*\)?)$/i);
        if (!m || !numericToken(m[2])) continue;
        [label, raw, locator] = [m[1], m[2], cells[0].locator];
      } else continue;
      if (/period|periode|year|tahun|tanggal|date|number|nomor|no\.|kode|code|currency|mata uang|scale|skala/i.test(label)) continue;
      if (/margin|ratio|rasio|percent|persen|%|karyawan|employees?|headcount|volume|kuantitas|quantity|per share|per saham|saham|shares?|pelanggan|customers?|pengguna|users?|subscribers?|langganan|gerai|outlets?|cabang|branches|unit(?:s)?\b|ekor|tonnes?|kilogram|\bkg\b/i.test(label) && !/modal saham|share capital|capital stock/i.test(label)) continue;
      if (!/kas|bank|aset|asset|liabil|utang|hutang|piutang|receivable|payable|equity|ekuitas|modal|capital|pendapatan|revenue|income|penjualan|sales|beban|biaya|expense|cost|laba|rugi|profit|loss|cash|pajak|tax|saldo|balance|persediaan|inventory|depreciation|penyusutan|amorti|dividen|dividend|interest|bunga|investment|investasi|loan|pinjaman|retained|earnings/i.test(label)) continue;
      try {
        const amount = scaledMinor(numericToken(raw, numeric)!, currency, scale, numeric).toString();
        unit.figures.push({ label: label.trim(), raw, amount, currency, periodStart, periodEnd, locator });
      } catch { issues.push(`Nominal ${locator} belum dapat dipastikan.`); }
    }
  }
  unit.issues = aggregateIssues(issues);
  return unit;
}

/** Inspect actual bounded ZIP inflation before ExcelJS can allocate workbook XML. */
function checkWorkbookSize(data: Buffer) {
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { end = i; break; }
  if (end < 0) throw new Error("File Excel tidak bisa dibuka. Simpan ulang sebagai .xlsx.");
  const invalid = () => new Error("Struktur file Excel tidak valid.");
  const entries = data.readUInt16LE(end + 10);
  const directoryStart = data.readUInt32LE(end + 16), directorySize = data.readUInt32LE(end + 12);
  const directoryEnd = directoryStart + directorySize;
  if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || entries !== data.readUInt16LE(end + 8) || directoryEnd !== end || directoryStart > end) throw invalid();
  if (entries > 5000) throw new Error("File Excel terlalu kompleks; pecah menjadi beberapa file.");
  let offset = directoryStart, total = 0;
  const maximum = 64 * 1024 * 1024;
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > directoryEnd || data.readUInt32LE(offset) !== 0x02014b50) throw invalid();
    const flags = data.readUInt16LE(offset + 8), method = data.readUInt16LE(offset + 10);
    const compressed = data.readUInt32LE(offset + 20), declared = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28), extraLength = data.readUInt16LE(offset + 30), commentLength = data.readUInt16LE(offset + 32);
    const local = data.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > directoryEnd || compressed === 0xffffffff || declared === 0xffffffff || local === 0xffffffff || data.readUInt16LE(offset + 34) || flags & 0x41 || ![0, 8].includes(method)) throw invalid();
    if (local + 30 > directoryStart || data.readUInt32LE(local) !== 0x04034b50 || data.readUInt16LE(local + 6) !== flags || data.readUInt16LE(local + 8) !== method) throw invalid();
    const localNameLength = data.readUInt16LE(local + 26), localExtraLength = data.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtraLength;
    if (start > directoryStart || start + compressed > directoryStart || localNameLength !== nameLength || !data.subarray(local + 30, local + 30 + localNameLength).equals(data.subarray(offset + 46, offset + 46 + nameLength))) throw invalid();
    if (!(flags & 8) && (data.readUInt32LE(local + 18) !== compressed || data.readUInt32LE(local + 22) !== declared)) throw invalid();
    if (declared > maximum - total) throw new Error("Isi Excel melebihi batas ekstraksi 64 MiB; pecah file.");
    const payload = data.subarray(start, start + compressed);
    let actual: number;
    try {
      actual = method === 0 ? payload.length : inflateRawSync(payload, { maxOutputLength: Math.max(1, maximum - total) }).length;
    } catch { throw new Error("Isi Excel rusak atau melebihi batas ekstraksi 64 MiB; pecah file."); }
    if (actual !== declared || actual > maximum - total) throw invalid();
    total += actual;
    offset = next;
  }
  if (offset !== directoryEnd) throw invalid();
}

function valueText(value: ExcelJS.CellValue, locator: string, issues: string[]): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      issues.push(`Tanggal ${locator} tidak valid. Periksa sel sumber, hitung ulang rumus jika ada, lalu simpan ulang di Excel.`);
      return "[tanggal tidak valid]";
    }
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) { issues.push(`Angka ${locator} melebihi presisi Excel; gunakan teks nominal asli.`); return "[angka tidak pasti]"; }
    return String(value);
  }
  if (typeof value !== "object") return String(value);
  if ("formula" in value || "sharedFormula" in value) {
    if (value.result === undefined || value.result === null) { issues.push(`Rumus ${locator} belum memiliki hasil tersimpan. Hitung ulang dan simpan di Excel.`); return "[rumus tanpa hasil]"; }
    return valueText(value.result, locator, issues);
  }
  if ("error" in value) { issues.push(`Sel ${locator} berisi kesalahan ${value.error}.`); return value.error; }
  if ("richText" in value) return value.richText.map((p) => p.text).join("");
  if ("text" in value) return value.text;
  return "";
}

/** Sheets the ledger import itself would read (`detectTables` + `readTable`), keyed by sheet name. */
export async function postableTables(name: string, data: Buffer): Promise<Map<string, EvidenceTable>> {
  const out = new Map<string, EvidenceTable>();
  let sheets: Awaited<ReturnType<typeof readSheets>>;
  try { sheets = await readSheets(name, data); } catch { return out; }
  const iso = (d: Date | null | undefined) => d ? d.toISOString().slice(0, 10) : null;
  let candidates: ReturnType<typeof detectTables>;
  try { candidates = detectTables(sheets); } catch { return out; }
  for (const candidate of candidates) {
    try {
      const read = readTable(sheets, candidate);
      if (read.mode === "LEDGER") {
        const dates = read.rows.flatMap((r) => r.date ? [iso(r.date)!] : []).sort();
        out.set(candidate.sheet, { mode: "LEDGER", rows: read.rows.length, entities: [...new Set(read.rows.flatMap((r) => r.entity ? [r.entity] : []))], periodStart: dates[0] ?? null, periodEnd: dates.at(-1) ?? null, currencies: [...new Set(read.rows.flatMap((r) => r.currency ? [r.currency] : []))].sort() });
      } else out.set(candidate.sheet, { mode: "NERACA", rows: read.rows.length, entities: [], periodStart: iso(read.date), periodEnd: iso(read.date), currencies: [] });
    } catch { /* Unreadable table stays evidence; the manual import explains why. */ }
  }
  return out;
}

export async function extractEvidence(name: string, data: Buffer, opts: { password?: string } = {}): Promise<Extraction> {
  if (data.length > MAX_BYTES) throw new Error("File melebihi batas 10 MiB; pecah file sebelum mengunggah.");
  if (/\.(docx?|pptx?|png|jpe?g|gif|webp|heic|tiff?|bmp)$/i.test(name)) throw new Error("Format ini belum didukung. Ekspor sebagai PDF dengan teks, XLSX, XLS, CSV, atau TXT.");
  // Old Excel (and HTML tables banks save as .xls) is read as the .xlsx it converts to; the stored bytes stay the original.
  const legacy = /\.xls$/i.test(name) || sniffFile(data) === "XLS";
  if (legacy || /\.xlsx$/i.test(name)) {
    const book = legacy ? asXlsx(data) : data;
    if (!book) throw new Error("File .xls ini berisi teks, bukan Excel. Simpan sebagai .xlsx atau CSV.");
    checkWorkbookSize(book);
    const workbook = new ExcelJS.Workbook();
    try { await workbook.xlsx.load(book as unknown as ArrayBuffer); } catch { throw new Error("File Excel tidak bisa dibuka. Simpan ulang sebagai .xlsx."); }
    const issues: string[] = workbook.worksheets.length > MAX_SHEETS ? [TRUNCATED] : [];
    const tables = await postableTables(name, data);
    const units = workbook.worksheets.slice(0, MAX_SHEETS).map((sheet) => {
      const rows: Row[] = [], localIssues: string[] = [];
      if (sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLUMNS) localIssues.push(TRUNCATED);
      sheet.eachRow((row, index) => {
        if (index > MAX_ROWS) return;
        const cells: Row["cells"] = [];
        row.eachCell((cell, col) => {
          if (col > MAX_COLUMNS) return;
          const locator = `${sheet.name}!${cell.address}`;
          cells.push({ locator, text: valueText(cell.value, locator, localIssues), numeric: numericCell(cell.value) });
        });
        rows.push({ locator: `${sheet.name}!${index}`, cells });
      });
      return buildUnit(sheet.name, sheet.name, rows, localIssues, tables.get(sheet.name));
    });
    if (!units.length) issues.push("File tidak memiliki lembar yang dapat dibaca.");
    return { units, issues };
  }
  if (/\.pdf$/i.test(name) || data.subarray(0, 5).toString() === "%PDF-") {
    const lines = await readLines(data, opts.password, { maxPages: 300, maxItems: 100_000 });
    if (lines.reduce((n, l) => n + l.cells.map((c) => c.text).join("").trim().length, 0) < 20) throw new Error("PDF hasil scan atau tanpa teks. OCR belum didukung; unggah PDF dengan teks atau CSV/Excel.");
    const rows = lines.slice(0, MAX_ROWS).map((line, index) => ({ locator: `halaman ${line.page}, baris ${index + 1}`, cells: line.cells.map((c) => ({ text: c.text, locator: `halaman ${line.page}, baris ${index + 1}` })) }));
    return { units: [buildUnit("document", name, rows, lines.length > MAX_ROWS ? [TRUNCATED] : [])], issues: [] };
  }
  if (!/\.(csv|txt|md|markdown)$/i.test(name)) throw new Error("Format belum didukung. Gunakan PDF dengan teks, XLSX, CSV, TXT, atau Markdown.");
  const text = data.toString("utf8").replace(/^\uFEFF/, "");
  if (text.includes("\u0000")) throw new Error("File bukan teks UTF-8. Ekspor ulang sebagai UTF-8.");
  const csv = /\.csv$/i.test(name);
  const rawRows = csv ? readCsv(text, text.split(/\r?\n/, 1)[0].includes(";") ? ";" : ",") : text.split(/\r?\n/).map((line) => [line]);
  const rows: Row[] = rawRows.slice(0, MAX_ROWS).map((row, i) => ({ locator: `baris ${i + 1}`, cells: row.slice(0, MAX_COLUMNS).map((text, j) => ({ text, locator: csv ? `CSV!R${i + 1}C${j + 1}` : `baris ${i + 1}` })) }));
  const table = csv ? (await postableTables(name, data)).get("CSV") : undefined;
  return { units: [buildUnit("document", name, rows, rawRows.length > MAX_ROWS || rawRows.some((r) => r.length > MAX_COLUMNS) ? [TRUNCATED] : [], table)], issues: [] };
}
