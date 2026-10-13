import ExcelJS from "exceljs";
import { dateOnly } from "@/lib/format";
import { parseCents, parseSubSen } from "@/lib/money";
import { normalizeLedgerRate } from "@/lib/fx/currency";
import { dateParts, dayMonthEvidence, MONTHS, readCsv, type DayMonthOrder } from "@/lib/import/parsers/common";
import { ParseError } from "@/lib/import/types";
import { readableXlsx, sniffFile } from "@/lib/import/workbook";
import type { AccountType } from "@/lib/generated/prisma/enums";
import type { Columns, ColumnKey, LedgerDateOrder, LedgerRow, LedgerTotal, NeracaRow, NeracaTotal, RawCell, RawSheet, ReadResult, TableCandidate, TbGroup, TbLayout, TbRead, TbRow } from "@/lib/ledger-import/types";
import { NO_CODE_PREFIX } from "@/lib/ledger-import/code";

/**
 * Ledger / Neraca files (XLSX, legacy/HTML XLS, CSV/TSV) → rows with `sheet!row` references. No DB, no AI (accounting-rules §15a, §16):
 * the table is found by header names from content, and every problem reading a row is kept on the row for the checks.
 */

const HEADERS: Record<ColumnKey, RegExp> = {
  date: /^(tanggal|tgl\.?|date|entry date|posting date|tanggal transaksi|tanggal jurnal|transaction date)$/i,
  code: /^(kode akun|kode perkiraan|kode|no\.? akun|nomor akun|account code|account no\.?|account number|acc(ount)? code|coa)$/i,
  name: /^(nama akun|nama perkiraan|perkiraan|account name|account|akun|nama)$/i,
  debit: /^(debit|debet|dr|mutasi debit|mutasi debet)(\s*\(.*\))?$/i,
  credit: /^(kredit|credit|cr|mutasi kredit)(\s*\(.*\))?$/i,
  amount: /^(saldo|saldo akhir|jumlah|nilai|balance|amount|closing balance|ending balance)$/i,
  level: /^(level|lvl|tingkat)$/i,
  desc: /^(keterangan|deskripsi|description|uraian|memo|narration|reconstruction logic \/ description)$/i,
  voucher: /^(no\.? bukti|nomor bukti|voucher|no\.? voucher|no\.? jurnal|nomor jurnal|journal no\.?|journal number|transaction no\.?|no\.? transaksi)$/i,
  entity: /^(entitas|entity|perusahaan|company)$/i,
  currency: /^(mata uang|currency|ccy|valuta|curr\.?)$/i,
  rate: /^(kurs|rate|exchange rate|fx rate)$/i,
  notes: /^(notes|catatan|note)$/i,
};
const DATE_HEADER = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/;

/**
 * Header typos (use-case UC-K2: "TRIAL BALANCI", "Adjusment"): a header that matches no column word exactly is compared with the words Buku
 * knows, after normalising. One edit (Damerau: a swap counts once) for a word of 5–8 letters, two for longer, none for shorter words —
 * "Date", "Nama", "Kode" must be spelled right. A header near words of two different columns is left unread.
 */
const FUZZY_WORDS: Partial<Record<ColumnKey, string[]>> = {
  date: ["tanggal", "tanggal transaksi", "tanggal jurnal", "entry date", "posting date", "transaction date"],
  code: ["kode akun", "kode perkiraan", "nomor akun", "account code", "account number"],
  name: ["nama akun", "nama perkiraan", "perkiraan", "account name"],
  debit: ["debit", "debet", "mutasi debit", "mutasi debet"],
  credit: ["kredit", "credit", "mutasi kredit"],
  amount: ["saldo akhir", "jumlah", "balance", "amount", "closing balance", "ending balance"],
  desc: ["keterangan", "deskripsi", "description", "uraian", "narration"],
  voucher: ["nomor bukti", "voucher", "nomor jurnal", "journal number"],
  entity: ["entitas", "entity", "perusahaan", "company"],
  currency: ["mata uang", "currency", "valuta"],
  rate: ["exchange rate"],
  notes: ["catatan"],
};
export const COLUMN_LABEL: Record<ColumnKey, string> = {
  date: "Tanggal", level: "Level", code: "Kode akun", name: "Nama akun", debit: "Debit", credit: "Kredit", amount: "Saldo",
  desc: "Keterangan", voucher: "No. bukti", entity: "Entitas", currency: "Mata uang", rate: "Kurs", notes: "Catatan",
};

export const normalizeHeader = (t: string) => t.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Optimal-string-alignment distance (insert, delete, substitute, swap of neighbours), capped: returns max + 1 once beyond `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

const allowance = (word: string) => (word.replace(/ /g, "").length >= 9 ? 2 : word.replace(/ /g, "").length >= 5 ? 1 : 0);

/** The one key whose words are nearest to `text` within their allowance; undefined when none, or when two keys are equally near. */
export function nearestWord<K extends string>(text: string, words: Partial<Record<K, string[]>>): { key: K; word: string } | undefined {
  const t = normalizeHeader(text);
  if (!t) return undefined;
  let best: { key: K; word: string; d: number } | undefined;
  let tie = false;
  for (const [key, list] of Object.entries(words) as [K, string[]][]) {
    for (const w of list) {
      const max = allowance(w);
      if (!max && t !== w) continue;
      const d = t === w ? 0 : editDistance(t, w, max);
      if (d > max) continue;
      if (!best || d < best.d) [best, tie] = [{ key, word: w, d }, false];
      else if (d === best.d && best.key !== key) tie = true;
    }
  }
  return best && !tie ? { key: best.key, word: best.word } : undefined;
}
/** Account codes contain a digit: "1-1000", "11001", "7-PF-BANK TRANSFER BCA", "SKP-UNM-01" — never a heading like "Long-term Liability". */
const CODE = /^(?=[^ ]*\d)[0-9A-Za-z][0-9A-Za-z.\-_/]*$|^\d+-[0-9A-Za-z\-_. ]+$|^\d+(?: \d+)+$/;
const EXCEL_ERROR = /^#(VALUE!|REF!|NAME\?|DIV\/0!|N\/A|NULL!|NUM!|ERROR!|SPILL!|CALC!)$/i;

// ─── Workbook → raw sheets ────────────────────────────────────────────────────

function toRaw(v: ExcelJS.CellValue): RawCell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") return EXCEL_ERROR.test(v.trim()) ? { error: v.trim() } : v;
  if (typeof v === "object") {
    if ("error" in v && v.error) return { error: String(v.error) };
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("formula" in v || "sharedFormula" in v) {
      const r = (v as { result?: ExcelJS.CellValue }).result;
      return r === undefined ? null : toRaw(r);
    }
    if ("text" in v) return String((v as { text: unknown }).text);
    if ("hyperlink" in v) return String((v as { hyperlink: unknown }).hyperlink);
  }
  return String(v);
}

/** The file's kind comes from its bytes (a `.xls` may be old Excel, an HTML table or text); the name is only shown. */
export async function readSheets(_fileName: string, data: Buffer): Promise<RawSheet[]> {
  if (sniffFile(data) === "PDF") throw new ParseError("File PDF tidak bisa dibaca sebagai buku besar atau neraca. Unggah XLSX, XLS, atau CSV.");
  const xlsx = await readableXlsx(data);
  if (xlsx) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
    } catch {
      throw new ParseError("File Excel tidak bisa dibuka. Simpan ulang sebagai .xlsx lalu coba lagi.");
    }
    return wb.worksheets.map((ws) => {
      const rows: RawCell[][] = [];
      ws.eachRow({ includeEmpty: true }, (row, n) => {
        rows[n - 1] = (row.values as ExcelJS.CellValue[]).slice(1).map(toRaw);
      });
      for (let i = 0; i < rows.length; i++) rows[i] ??= [];
      return { name: ws.name, rows };
    });
  }
  const text = data.toString("utf8");
  const first = text.split("\n")[0];
  const delimiter = first.includes("\t") ? "\t" : first.includes(";") ? ";" : ",";
  return [{ name: "CSV", rows: readCsv(text, delimiter).map((r) => r.map((c) => (c === "" ? null : EXCEL_ERROR.test(c) ? { error: c } : c))) }];
}

// ─── Cell helpers ─────────────────────────────────────────────────────────────

export function cellText(c: RawCell | undefined): string {
  if (c === null || c === undefined) return "";
  // Excel can store a date cell ExcelJS can't convert (Invalid Date); treat it as text that no reader matches.
  if (c instanceof Date) return Number.isFinite(c.getTime()) ? c.toISOString().slice(0, 10) : "[tanggal tidak valid]";
  if (typeof c === "object") return c.error;
  return String(c).trim();
}

function isBlank(c: RawCell | undefined) {
  return cellText(c) === "";
}

/** The cell's amount in micro-units when it has digits beyond sen (`parseSubSen`), else undefined. */
function cellSubSen(c: RawCell | undefined): bigint | undefined {
  return typeof c === "number" || typeof c === "string" ? parseSubSen(c) : undefined;
}

/** debit − credit exactly in micro-units, when either side has digits beyond sen; else undefined. */
function exactOf(debit: RawCell | undefined, credit: RawCell | undefined, debitCents: bigint, creditCents: bigint): bigint | undefined {
  const d = cellSubSen(debit);
  const k = cellSubSen(credit);
  if (d === undefined && k === undefined) return undefined;
  return (d ?? debitCents * 10_000n) - (k ?? creditCents * 10_000n);
}

/** Signed sen, or an error string when the cell isn't a number. Blank = 0. */
function cellCents(c: RawCell | undefined): bigint | string {
  if (c === null || c === undefined) return 0n;
  if (typeof c === "object" && !(c instanceof Date)) return c.error;
  if (c instanceof Date) return "tanggal, bukan angka";
  try {
    return parseCents(c);
  } catch {
    return `"${String(c).slice(0, 30)}"`;
  }
}

export function cellDate(c: RawCell | undefined, order: DayMonthOrder = "DMY"): Date | null {
  if (c instanceof Date) return Number.isFinite(c.getTime()) ? dateOnly(c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate()) : null;
  const t = cellText(c).replace(/^'/, "");
  // A calendar-impossible date (31/02/1990) is unreadable, never rolled into the next month.
  const real = (y: number, mo: number, d: number) => {
    const out = dateOnly(y, mo, d);
    return out.getUTCFullYear() === y && out.getUTCMonth() + 1 === mo && out.getUTCDate() === d ? out : null;
  };
  let m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return order === "MDY" ? real(Number(m[3]), Number(m[1]), Number(m[2])) : real(Number(m[3]), Number(m[2]), Number(m[1]));
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return real(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

// ─── Table detection ──────────────────────────────────────────────────────────

/** A period column header: a date ("31/01/2026", a date cell, "31 Jan 2026") or a month ("Jan 2026", "Januari 2026", "Feb-26" → month end). */
export function periodHeader(c: RawCell | undefined): Date | null {
  const d = cellDate(c);
  if (d) return d;
  const t = cellText(c);
  const p = dateParts(t);
  if (p?.y) return dateOnly(p.y, p.m, p.d);
  const m = t.match(/^([A-Za-z]{3,9})\.?[\s/-]+(\d{2}|\d{4})$/);
  const month = m ? MONTHS[m[1].toLowerCase()] : undefined;
  if (!m || !month) return null;
  const y = Number(m[2].length === 2 ? `20${m[2]}` : m[2]);
  return dateOnly(y, month + 1, 0); // day 0 of the next month = the month's last day
}

/** ERP exports head the amount column "Value"; alone that word says little (pivots), so it counts only beside a "Level" column. */
const VALUE_HEADER = /^value$/i;
const hasLevelHeader = (row: RawCell[]) => row.some((c) => HEADERS.level.test(cellText(c).replace(/\s+/g, " ")));
const headerKey = (t: string, withValue: boolean): ColumnKey | undefined =>
  (Object.keys(HEADERS) as ColumnKey[]).find((k) => HEADERS[k].test(t)) ?? (withValue && VALUE_HEADER.test(t) ? "amount" : undefined) ?? nearestWord(t, FUZZY_WORDS)?.key;

export type HeaderTypo = NonNullable<TableCandidate["typos"]>[number];

function headerColumns(row: RawCell[], typos?: HeaderTypo[], rowIndex = 0): Columns {
  const cols: Columns = {};
  const withValue = hasLevelHeader(row);
  row.forEach((c, i) => {
    const t = cellText(c).replace(/\s+/g, " ");
    if (!t) return;
    for (const key of Object.keys(HEADERS) as ColumnKey[]) {
      if (cols[key] === undefined && HEADERS[key].test(t)) {
        cols[key] = i;
        return;
      }
    }
    if (cols.amount === undefined && (DATE_HEADER.test(t) || periodHeader(c) || (withValue && VALUE_HEADER.test(t)))) {
      cols.amount = i;
      return;
    }
    const near = nearestWord(t, FUZZY_WORDS);
    if (near && cols[near.key] === undefined) {
      cols[near.key] = i;
      typos?.push({ header: t, label: COLUMN_LABEL[near.key], column: i, row: rowIndex });
    }
  });
  return cols;
}

/**
 * A Neraca printed as two panels side by side (Aset | Kewajiban + Ekuitas) repeats its whole column set on one header row.
 * Split only when every part is a complete Neraca table on its own (account + amount, no date), so a header that merely repeats one
 * word ("Date" … "Transaction Date") stays one table.
 */
function headerPanels(row: RawCell[]): Columns[] {
  const parts: Columns[] = [{}];
  const withValue = hasLevelHeader(row);
  row.forEach((c, i) => {
    const t = cellText(c).replace(/\s+/g, " ");
    if (!t) return;
    const key = headerKey(t, withValue);
    if (!key) return;
    let cur = parts[parts.length - 1];
    if (cur[key] !== undefined) {
      cur = {};
      parts.push(cur);
    }
    cur[key] = i;
  });
  const whole = (p: Columns) => p.date === undefined && (p.code !== undefined || p.name !== undefined) && p.amount !== undefined;
  return parts.length > 1 && parts.every(whole) ? parts : [];
}

const SPACED_CODE = /^\d+(?: \d+)+$/;

/** ERP exports name the code column "Account" and the words "Description": read them as code and name when the "name" column holds codes. */
function codesInNameColumn(rows: RawCell[][], headerRow: number, cols: Columns): Columns {
  if (cols.code !== undefined || cols.name === undefined || cols.desc === undefined) return cols;
  const cells = rows.slice(headerRow + 1, headerRow + 41).map((r) => cellText(r?.[cols.name!])).filter(Boolean);
  if (cells.length < 3 || cells.filter((t) => CODE.test(t) || SPACED_CODE.test(t)).length < cells.length * 0.6) return cols;
  const { desc, ...rest } = cols;
  return { ...rest, code: cols.name, name: desc };
}

const REPORT_TITLES: [RegExp, "LABA_RUGI" | "ARUS_KAS"][] = [
  [/^(laporan )?(laba rugi|laba\/rugi|profit (&|and) loss|profit and loss statement|income statement|statement of profit or loss)$/i, "LABA_RUGI"],
  [/^(laporan )?(arus kas|cash ?flows?|statement of cash flows?)$/i, "ARUS_KAS"],
];
/**
 * ERP exports prefix or suffix the title ("PnL Profit Loss Report", "All Branch Profit Loss Report"): a short row of at most three cells that
 * calls itself a report/laporan/statement and does not name ledger accounts ("Buku Besar Akun Laba Rugi" is a ledger of P&L accounts).
 */
const REPORT_WORD = /\b(report|laporan|statement)\b/i;
const LEDGER_WORD = /(ledger|buku besar|\bakun\b|accounts?\b|ikhtisar|mutasi)/i;
const LOOSE_TITLES: [RegExp, "LABA_RUGI" | "ARUS_KAS"][] = [
  [/\b(laba rugi|profit\s*(&|and)?\s*loss|income statement)\b/i, "LABA_RUGI"],
  [/\b(arus kas|cash ?flows?)\b/i, "ARUS_KAS"],
];

/** A sheet whose title rows (the first 8, as accounting systems print them) name a Laba Rugi or Arus Kas report — never a Neraca to post. */
export function reportKind(sheet: RawSheet): "LABA_RUGI" | "ARUS_KAS" | null {
  for (const row of sheet.rows.slice(0, 8)) {
    const text = cellText((row ?? []).find((c) => !isBlank(c)) ?? null);
    const hit = REPORT_TITLES.find(([re]) => re.test(text));
    if (hit) return hit[1];
    const short = text.length <= 60 && (row ?? []).filter((c) => !isBlank(c)).length <= 3 && REPORT_WORD.test(text) && !LEDGER_WORD.test(text) && !/\b(balance|neraca|posisi keuangan)\b/i.test(text);
    const loose = short ? LOOSE_TITLES.find(([re]) => re.test(text)) : undefined;
    if (loose) return loose[1];
  }
  return null;
}

/** Every sheet region that looks like a ledger (date + account + debit/credit) or a Neraca (account + amount). */
export function detectTables(sheets: RawSheet[]): TableCandidate[] {
  const out: TableCandidate[] = [];
  for (const sheet of sheets) {
    if (reportKind(sheet)) continue;
    const limit = Math.min(sheet.rows.length, 30);
    let found = false;
    for (let r = 0; r < limit && !found; r++) {
      // A trial balance first: its group labels would otherwise read as one Neraca amount column.
      const tb = tbLayout(sheet.rows, r);
      if (tb) {
        const dataRows = sheet.rows.slice(tb.headerRow + 1).filter((row) => row && row.some((c) => !isBlank(c))).length;
        if (dataRows > 0) {
          out.push({ sheet: sheet.name, headerRow: tb.headerRow, mode: "NERACA", columns: tb.columns, dataRows, tb: tb.tb, ...(tb.typos.length ? { typos: tb.typos } : {}) });
          found = true;
          continue;
        }
      }
      const typos: HeaderTypo[] = [];
      const cols = headerColumns(sheet.rows[r] ?? [], typos, r);
      // Only typos the table actually reads (codesInNameColumn may re-assign a column).
      const used = (c: Columns) => typos.filter((t) => Object.values(c).includes(t.column));
      const hasAccount = cols.code !== undefined || cols.name !== undefined;
      const hasDrCr = cols.debit !== undefined && cols.credit !== undefined;
      const dataRows = sheet.rows.slice(r + 1).filter((row) => row && row.some((c) => !isBlank(c))).length;
      if (cols.date !== undefined && hasAccount && hasDrCr && dataRows > 0) {
        out.push({ sheet: sheet.name, headerRow: r, mode: "LEDGER", columns: cols, dataRows, ...(typos.length ? { typos: used(cols) } : {}) });
        found = true;
      } else if (cols.date === undefined && hasAccount && (cols.amount !== undefined || hasDrCr) && dataRows > 0) {
        const panels = headerPanels(sheet.rows[r] ?? []).map((p) => codesInNameColumn(sheet.rows, r, p));
        if (panels.length > 1) out.push({ sheet: sheet.name, headerRow: r, mode: "NERACA", columns: panels[0], panels, dataRows, ...(typos.length ? { typos: panels.flatMap(used) } : {}) });
        else {
          const columns = codesInNameColumn(sheet.rows, r, cols);
          const periods = periodColumns(sheet.rows[r] ?? [], columns.amount);
          out.push({ sheet: sheet.name, headerRow: r, mode: "NERACA", columns, dataRows, ...(typos.length ? { typos: used(columns) } : {}), ...(periods ? { periods } : {}) });
        }
        found = true;
      }
    }
    if (!found) {
      const jurnal = detectJurnalNeraca(sheet);
      if (jurnal) out.push(jurnal);
    }
  }
  return out;
}

/** A header with several period columns (Jan … Jun): all of them, when the column read is one of them and there are two or more. */
function periodColumns(row: RawCell[], read: number | undefined): { column: number; date: Date }[] | undefined {
  if (read === undefined) return undefined;
  const periods = row.flatMap((c, column) => {
    const date = periodHeader(c);
    return date ? [{ column, date }] : [];
  });
  return periods.length > 1 && periods.some((p) => p.column === read) ? periods : undefined;
}

/**
 * Jurnal (Mekari) Neraca exports have no "kode akun" header: a "Date | | 31/05/2026" row, then
 * `code | name | amount` rows under section headings. Found by shape, not by file name.
 */
function detectJurnalNeraca(sheet: RawSheet): TableCandidate | null {
  const limit = Math.min(sheet.rows.length, 30);
  for (let r = 0; r < limit; r++) {
    const row = sheet.rows[r] ?? [];
    const dateCol = row.findIndex((c, i) => i > 0 && (DATE_HEADER.test(cellText(c)) || c instanceof Date));
    if (dateCol < 0) continue;
    const coded = sheet.rows.slice(r + 1).filter((x) => x && CODE.test(cellText(x[0])) && !isBlank(x[1]) && typeof cellCents(x[dateCol]) === "bigint").length;
    const periods = periodColumns(row, dateCol);
    if (coded >= 3) return { sheet: sheet.name, headerRow: r, mode: "NERACA", columns: { code: 0, name: 1, amount: dateCol }, dataRows: coded, ...(periods ? { periods } : {}) };
  }
  return null;
}

// ─── Trial balance with column groups (use-case UC-K2) ──────────────────────────

/**
 * A trial balance prints, per account, several balances side by side: last year's, the Adjustment, the adjusted balance, the movement,
 * the closing balance — each as a Dr/Cr pair or one signed column. The group is named in the header itself ("Adjustment Dr") or on a
 * label row above the Dr/Cr row (a merged cell, carried to the right until the next label).
 */
const TB_GROUP_WORDS: Record<TbGroup, string[]> = {
  OPENING: ["saldo awal", "beginning balance", "opening balance", "saldo akhir tahun lalu", "akhir tahun lalu", "tahun lalu", "prior year", "previous year"],
  // The textbook worksheet (Neraca Saldo Sebelum Penyesuaian | Jurnal Penyesuaian | Setelah Penyesuaian): balances at the worksheet date.
  UNADJUSTED: ["sebelum penyesuaian", "saldo sebelum penyesuaian", "unadjusted", "unadjusted balance", "before adjustment", "before adjustments"],
  ADJUSTMENT: ["adjustment", "adjustments", "penyesuaian", "jurnal penyesuaian", "koreksi", "aje", "adj"],
  ADJUSTED: ["setelah penyesuaian", "saldo setelah penyesuaian", "adjusted balance", "adjusted", "after adjustment", "after adjustments", "audited"],
  MOVEMENT: ["mutasi", "movement", "movements", "mutation", "transaksi", "perubahan"],
  CLOSING: ["saldo akhir", "ending balance", "closing balance", "ending", "closing"],
};
export const TB_GROUP_LABEL: Record<TbGroup, string> = { OPENING: "Saldo awal", UNADJUSTED: "Sebelum penyesuaian", ADJUSTMENT: "Adjustment", ADJUSTED: "Setelah penyesuaian", MOVEMENT: "Mutasi", CLOSING: "Saldo akhir" };
const TB_PHRASES = (Object.entries(TB_GROUP_WORDS) as [TbGroup, string[]][]).flatMap(([g, ws]) => ws.map((w) => [g, w] as const)).sort((a, b) => b[1].length - a[1].length);
const SIDE_WORDS = { debit: ["debit", "debet"], credit: ["kredit", "credit"] };
const SIDE_TOKEN = /^(dr|cr|d|k|db|kr|debit|debet|kredit|credit)$/;
const DATE_IN_TEXT = /(\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4})/g;

/** The Dr/Cr side a header names ("Dr", "Kredit", "Kredti"), from its own words. */
function sideOf(text: string): "debit" | "credit" | undefined {
  for (const tok of normalizeHeader(text).split(" ")) {
    if (/^(dr|db|d|debit|debet)$/.test(tok)) return "debit";
    if (/^(cr|kr|k|kredit|credit)$/.test(tok)) return "credit";
    const near = tok.length >= 5 ? nearestWord(tok, SIDE_WORDS) : undefined;
    if (near) return near.key;
  }
  return undefined;
}

/** The group a header names, without its side and date words; `typo` when it was read through one. */
function groupOf(text: string): { group: TbGroup; typo: boolean } | undefined {
  const words = normalizeHeader(text.replace(DATE_IN_TEXT, " ")).split(" ").filter((w) => w && !SIDE_TOKEN.test(w) && !/^\d+$/.test(w));
  const rest = ` ${words.join(" ")} `;
  const hit = TB_PHRASES.find(([, w]) => rest.includes(` ${w} `));
  if (hit) return { group: hit[0], typo: false };
  const near = words.length ? nearestWord(words.join(" "), TB_GROUP_WORDS) : undefined;
  return near ? { group: near.key, typo: true } : undefined;
}

/** A date written in a header or title ("Saldo 31/12/2025", "Per 30 Juni 2026"). */
function datesIn(text: string): Date[] {
  return [...text.matchAll(DATE_IN_TEXT)].flatMap((m) => {
    const p = dateParts(m[1]);
    return p?.y ? [dateOnly(p.y, p.m, p.d)] : [];
  });
}

/**
 * The trial-balance layout of a header at row `r`, or null. Two rows (group labels, then Dr/Cr) or one (each header names group and side).
 * Needs an account column and at least two complete groups (Dr and Cr, or one signed column).
 */
function tbLayout(rows: RawCell[][], r: number): { headerRow: number; columns: Columns; tb: TbLayout; typos: HeaderTypo[] } | null {
  const top = rows[r] ?? [];
  const next = rows[r + 1] ?? [];
  const width = Math.max(top.length, next.length);
  const headerTypos: HeaderTypo[] = [];
  const cols = headerColumns(top, headerTypos, r);
  if (cols.date !== undefined) return null;
  const bareSide = (c: RawCell | undefined) => { const t = cellText(c); return t && normalizeHeader(t).split(" ").length <= 2 ? sideOf(t) : undefined; };
  const twoRow = next.filter((c) => bareSide(c)).length >= 4;
  const below = twoRow ? headerColumns(next, headerTypos, r + 1) : {};
  const columns: Columns = { code: cols.code ?? below.code, name: cols.name ?? below.name };
  if (columns.code === undefined && columns.name === undefined) return null;
  const groups: TbLayout["groups"] = {};
  const dates: TbLayout["dates"] = {};
  // Typos in the account headers too, when this table reads them.
  const typos: HeaderTypo[] = headerTypos.filter((x) => x.column === columns.code || x.column === columns.name);
  // A bare "Debit | Kredit" pair beside named groups ("Saldo Awal | Debit | Kredit | Saldo Akhir") is the period's movement.
  const bare: { debit?: number; credit?: number } = {};
  const take = (g: TbGroup, side: "debit" | "credit" | "balance", c: number) => {
    const slot = (groups[g] ??= {});
    if (slot[side] === undefined) slot[side] = c;
  };
  let label: { group: TbGroup; typo: boolean } | undefined;
  // "Saldo 31/12/2025" … "Saldo 30/06/2026": balances named by their date, the earlier one opening, the later one closing.
  const dated: { column: number; date: Date }[] = [];
  for (let c = 0; c < width; c++) {
    if (c === columns.code || c === columns.name) {
      label = undefined;
      continue;
    }
    const t = cellText(top[c]);
    if (twoRow) {
      if (t) {
        label = groupOf(t);
        if (label?.typo) typos.push({ header: t, label: TB_GROUP_LABEL[label.group], column: c, row: r });
        const d = label && datesIn(t)[0];
        if (label && d) dates[label.group] = d;
      }
      const side = sideOf(cellText(next[c]));
      if (label && side) take(label.group, side, c);
    } else if (t) {
      const g = groupOf(t);
      // Only a plain side word ("Debit", "Kredit", "Dr", "Cr"): "Mvt Dr" in a derived engine sheet is not a movement column.
      const plain = normalizeHeader(t);
      const side = !g && /^(debit|debet|dr|kredit|credit|cr)$/.test(plain) ? sideOf(plain) : undefined;
      if (side && bare[side] === undefined) bare[side] = c;
      const d0 = datesIn(t)[0];
      if (!g && d0 && /^(saldo|balance)\b/i.test(normalizeHeader(t))) dated.push({ column: c, date: d0 });
      if (!g) continue;
      if (g.typo) typos.push({ header: t, label: TB_GROUP_LABEL[g.group], column: c, row: r });
      const d = datesIn(t)[0];
      if (d) dates[g.group] = d;
      take(g.group, sideOf(t) ?? "balance", c);
    }
  }
  if (dated.length === 2 && +dated[0].date !== +dated[1].date) {
    const [early, late] = [...dated].sort((a, b) => +a.date - +b.date);
    if (!groups.OPENING) [groups.OPENING, dates.OPENING] = [{ balance: early.column }, early.date];
    if (!groups.CLOSING) [groups.CLOSING, dates.CLOSING] = [{ balance: late.column }, late.date];
  }
  // A group is amounts: a column with no number under it (blank, or a yes/no note like "Pooling Adj Integrated?") is not one (Chickin
  // foundation sheet: "Net Movement", "Closing … Impact" empty beside the Debit | Credit balances).
  const data = rows.slice((twoRow ? r + 1 : r) + 1);
  const numeric = (c: number | undefined) => c !== undefined && data.some((row) => !isBlank(row?.[c]) && typeof cellCents(row?.[c]) === "bigint");
  for (const g of Object.keys(groups) as TbGroup[]) {
    const slot = groups[g]!;
    if (![slot.debit, slot.credit, slot.balance].some(numeric)) {
      delete groups[g];
      delete dates[g];
    }
  }
  if (!twoRow && !groups.MOVEMENT && bare.debit !== undefined && bare.credit !== undefined && Object.keys(groups).length) groups.MOVEMENT = { debit: bare.debit, credit: bare.credit };
  const complete = (Object.entries(groups) as [TbGroup, TbLayout["groups"][TbGroup]][]).filter(([, s]) => s && ((s.debit !== undefined && s.credit !== undefined) || s.balance !== undefined));
  if (complete.length < 2) return null;
  const tb: TbLayout = { groups: Object.fromEntries(complete.map(([g, s]) => [g, s!.debit !== undefined && s!.credit !== undefined ? { debit: s!.debit, credit: s!.credit } : { balance: s!.balance }])), dates };
  return { headerRow: twoRow ? r + 1 : r, columns, tb, typos };
}

// ─── Readers ──────────────────────────────────────────────────────────────────

const RATE_NOTE = /\b(?:rate|kurs)\s*[:=]\s*([0-9][0-9.,]*)/i;

const TOTAL_LABEL = /^(grand\s+)?(total|jumlah)\b/i;

export function readLedger(sheet: RawSheet, t: TableCandidate): { rows: LedgerRow[]; totals: LedgerTotal[]; dateOrder?: LedgerDateOrder } {
  const c = t.columns;
  const rows: LedgerRow[] = [];
  const totals: LedgerTotal[] = [];
  // Day/month or month/day for the whole file, from its text dates (date cells are unambiguous): month/day only when a value proves it.
  const dateTexts = c.date === undefined ? [] : sheet.rows.slice(t.headerRow + 1).map((row) => (row?.[c.date!] instanceof Date ? "" : cellText(row?.[c.date!])));
  const ev = dayMonthEvidence(dateTexts);
  const order: DayMonthOrder = ev.mdy && !ev.dmy ? "MDY" : "DMY";
  const dateOrder: LedgerDateOrder | undefined =
    ev.dmy && ev.mdy
      ? { order, basis: "mixed", examples: [ev.dmy, ev.mdy] }
      : ev.mdy
        ? { order, basis: "number", examples: [ev.mdy] }
        : !ev.dmy && ev.numeric.length >= 2
          ? { order, basis: "unsure", examples: ev.numeric.slice(0, 1) }
          : undefined;
  for (let r = t.headerRow + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] ?? [];
    if (row.every(isBlank)) continue;
    const get = (k: ColumnKey) => (c[k] === undefined ? undefined : row[c[k]!]);
    const code = cellText(get("code"));
    const name = cellText(get("name"));
    const dateCell = get("date");
    const debitCell = get("debit");
    const creditCell = get("credit");
    // Section/total/banner rows: no account and no amounts.
    if (!code && !name && isBlank(debitCell) && isBlank(creditCell)) continue;
    // A total row has no readable date and says Total/Jumlah in its account cells or, with no account, anywhere in the row (often in
    // the date column itself): kept for the tie-out.
    const totalLabel = !cellDate(dateCell, order) && (TOTAL_LABEL.test(code || name) || (!code && !name && row.some((x) => TOTAL_LABEL.test(cellText(x)))));
    if (totalLabel) {
      const d = cellCents(debitCell);
      const k = cellCents(creditCell);
      if (typeof d === "bigint" && typeof k === "bigint") totals.push({ ref: `${sheet.name}!${r + 1}`, label: (code || name || row.map(cellText).find((x) => TOTAL_LABEL.test(x)) || "Total").slice(0, 80), debit: d, credit: k });
      continue;
    }

    const errors: string[] = [];
    const date = cellDate(dateCell, order);
    if (!date) errors.push(isBlank(dateCell) ? "tanggal kosong" : `tanggal tidak dikenali: ${cellText(dateCell)}`);
    if (!code && !name) errors.push("akun kosong");
    const debit = cellCents(debitCell);
    const credit = cellCents(creditCell);
    if (typeof debit === "string") errors.push(`debit bukan angka: ${debit}`);
    if (typeof credit === "string") errors.push(`kredit bukan angka: ${credit}`);
    let d = typeof debit === "bigint" ? debit : 0n;
    let k = typeof credit === "bigint" ? credit : 0n;
    // Negative amounts belong on the other side (the same number); the draft lists these rows.
    const negative = d < 0n || k < 0n;
    const raw = { debit: d, credit: k };
    if (d < 0n) [d, k] = [0n, k - d];
    if (k < 0n) [d, k] = [d - k, 0n];
    const notes = cellText(get("notes"));
    const rateText = cellText(get("rate")) || notes.match(RATE_NOTE)?.[1] || "";
    rows.push({
      ref: `${sheet.name}!${r + 1}`,
      row: r + 1,
      date,
      entity: cellText(get("entity")) || null,
      code: code || name,
      name: name || code,
      debit: d,
      credit: k,
      currency: cellText(get("currency")).toUpperCase() || null,
      rate: rateText ? normalizeLedgerRate(rateText) : null,
      description: cellText(get("desc")).replace(/\s+/g, " ").slice(0, 300),
      voucher: cellText(get("voucher")) || null,
      errors,
      ...(negative ? { negative: true, raw } : {}),
      ...(() => {
        const exact = exactOf(debitCell, creditCell, raw.debit, raw.credit);
        return exact === undefined ? {} : { exact };
      })(),
    });
  }
  return { rows, totals, ...(dateOrder ? { dateOrder } : {}) };
}

const SECTION_ASSET = /^(assets?|aset|aktiva|harta)\b/i;
/**
 * Asset sub-headings that can open a Neraca on their own ("Current Assets" with no "Assets" row above): they are ASET too. Every one
 * but "Current" is long-term, and TERM_NON_CURRENT matches the same words in singular and plural.
 */
const SECTION_ASSET_SUB = /^(current|fixed|other|non.?current|intangible|tangible)\s+(assets?)\b/i;
const SECTION_LIAB = /^(liabilit|kewajiban|utang|hutang|current liabilit|long-term liabilit)/i;
const SECTION_EQUITY = /^(equity|ekuitas|modal)\b/i;
const SECTION_LIAB_EQUITY = /(liabilit.*(equity|ekuitas)|kewajiban.*(ekuitas|modal)|pasiva)/i;
/** Sub-headings that say how long a balance runs (Jurnal: "Current Assets", "Fixed Assets", "Long-term Liability"). */
const TERM_NON_CURRENT = /(long.?term|jangka panjang|non.?current|tidak lancar|(fixed|other|intangible|tangible)\s+assets?|aset tetap|aktiva tetap|tak berwujud|tidak berwujud|aset lain|depreciation|penyusutan|amorti)/i;
const TERM_CURRENT = /(\bcurrent\b|\blancar\b|jangka pendek|short.?term)/i;

/** "Periode", "Per", "As of", or a bare "Tanggal"/"Date" — not "Tanggal Cetak" / "Date printed". */
const PERIOD_LABEL = /^(period|periode|per|as of|as at|tanggal|date|posisi)\s*:?$/i;

/** The Neraca date: the amount header when it is a date, else a date beside a "Periode/Period/Per" label, else the first date above the table. */
function neracaDate(sheet: RawSheet, t: TableCandidate): Date | null {
  const header = sheet.rows[t.headerRow] ?? [];
  const fromHeader = t.columns.amount !== undefined ? periodHeader(header[t.columns.amount]) : null;
  if (fromHeader) return fromHeader;
  const above = sheet.rows.slice(0, t.headerRow);
  for (const row of above) {
    const cells = row ?? [];
    if (!PERIOD_LABEL.test(cellText(cells[0]))) continue;
    for (const cell of cells.slice(1)) {
      const d = cellDate(cell);
      if (d) return d;
    }
  }
  for (const row of above) for (const cell of row ?? []) {
    const d = cellDate(cell);
    if (d) return d;
  }
  return null;
}

/** Excel column letters of a 0-based index (0 → A, 26 → AA). */
export function columnLetter(i: number): string {
  let n = i + 1;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function readNeraca(sheet: RawSheet, t: TableCandidate): { date: Date | null; rows: NeracaRow[]; totals: NeracaTotal[] } {
  const date = neracaDate(sheet, t);
  const panels = t.panels?.length ? t.panels : [t.columns];
  const rows: NeracaRow[] = [];
  const totals: NeracaTotal[] = [];
  for (const c of panels) {
    // A side-by-side file keeps each panel's column in the ref so two rows on the same sheet row stay distinguishable.
    const at = (r: number) => `${sheet.name}!${panels.length > 1 ? columnLetter(c.code ?? c.name ?? 0) : ""}${r + 1}`;
    let section: AccountType | null = null;
    let term: NeracaRow["termHint"] = null;
    const body = sheet.rows.slice(t.headerRow + 1);
    const levelOf = (row: RawCell[] | undefined) => {
      const text = c.level !== undefined ? cellText(row?.[c.level]) : "";
      const n = text === "" ? NaN : Number(text);
      return Number.isFinite(n) ? n : null;
    };
    for (let r = t.headerRow + 1; r < sheet.rows.length; r++) {
      const row = sheet.rows[r] ?? [];
      if (row.every(isBlank)) continue;
      const codeCell = c.code !== undefined ? cellText(row[c.code]) : "";
      const nameCell = c.name !== undefined ? cellText(row[c.name]) : "";
      // A panel that ends before the other one leaves its cells blank on the remaining rows.
      if (panels.length > 1 && !codeCell && !nameCell && isBlank(c.amount !== undefined ? row[c.amount] : undefined)) continue;
      const label = codeCell && !CODE.test(codeCell) ? codeCell : nameCell;
      const hasCode = !!codeCell && CODE.test(codeCell);
      const amountCell = c.amount !== undefined ? row[c.amount] : undefined;
      const raw = c.amount !== undefined ? cellCents(amountCell) : (() => {
        const d = cellCents(row[c.debit!]);
        const k = cellCents(row[c.credit!]);
        return typeof d === "string" ? d : typeof k === "string" ? k : d - k;
      })();

      // A coded group row of a hierarchical chart (zero value, next row one level deeper) is a heading, not an account.
      const level = levelOf(row);
      const isGroup = hasCode && level !== null && raw === 0n && (() => {
        for (const next of body.slice(r - t.headerRow)) {
          if (!next || (c.code !== undefined && !CODE.test(cellText(next[c.code])))) continue;
          const nl = levelOf(next);
          return nl !== null && nl > level;
        }
        return false;
      })();

      if (isGroup || (!hasCode && isBlank(amountCell) && (c.amount !== undefined || (isBlank(row[c.debit!]) && isBlank(row[c.credit!]))))) {
        // Section heading. A new main section resets the term; a sub-heading ("Fixed Assets") sets it.
        const before: AccountType | null = section;
        const headingTerm = TERM_NON_CURRENT.test(label) ? "NON_CURRENT" : TERM_CURRENT.test(label) ? "CURRENT" : null;
        if (SECTION_LIAB_EQUITY.test(label) || SECTION_LIAB.test(label)) section = "LIABILITAS";
        else if (SECTION_EQUITY.test(label)) section = "EKUITAS";
        else if (SECTION_ASSET.test(label) || SECTION_ASSET_SUB.test(label)) section = "ASET";
        if (section !== before) term = headingTerm;
        else if (headingTerm) term = headingTerm;
        continue;
      }
      if (/^(total|jumlah)\b/i.test(label) && !hasCode) {
        if (typeof raw === "bigint") {
          const kind = SECTION_LIAB_EQUITY.test(label) ? "LIAB_EQUITY" : /^(total|jumlah)\s+(assets?|aset|aktiva)$/i.test(label) ? "ASSETS" : "OTHER";
          totals.push({ ref: at(r), label, amount: raw, kind });
        }
        continue;
      }
      if (typeof raw === "bigint" && raw === 0n && !hasCode) continue;
      const errors: string[] = [];
      if (typeof raw === "string") errors.push(`saldo bukan angka: ${raw}`);
      const cents = typeof raw === "bigint" ? raw : 0n;
      // Presentation sign → debit-positive: assets as shown; liabilities & equity flipped.
      const debitPositive = c.amount === undefined ? cents : section === "LIABILITAS" || section === "EKUITAS" ? -cents : cents;
      const typeHint: AccountType | null = section === "LIABILITAS" && SECTION_EQUITY.test(nameCell) ? "EKUITAS" : section;
      const exact = typeof raw !== "bigint" ? undefined : c.amount !== undefined ? cellSubSen(amountCell) : (() => {
        const d = cellCents(row[c.debit!]);
        const k = cellCents(row[c.credit!]);
        return typeof d === "bigint" && typeof k === "bigint" ? exactOf(row[c.debit!], row[c.credit!], d, k) : undefined;
      })();
      rows.push({
        // Same sign rule as the amount.
        ...(exact === undefined ? {} : { exact: c.amount !== undefined && (section === "LIABILITAS" || section === "EKUITAS") ? -exact : exact }),
        ref: at(r),
        row: r + 1,
        code: hasCode ? codeCell : `${NO_CODE_PREFIX}${label}`,
        name: hasCode ? nameCell || codeCell : label,
        amount: debitPositive,
        typeHint: guessEquity(label, typeHint),
        termHint: guessEquity(label, typeHint) === "EKUITAS" ? null : term,
        coded: hasCode,
        errors,
      });
    }
  }
  return { date, rows, totals };
}

/** Uncoded "Current Period Earnings" / "Laba tahun berjalan" rows sit in equity even under a combined L&E heading. */
function guessEquity(label: string, t: AccountType | null): AccountType | null {
  if (t === "LIABILITAS" && /(earning|laba|retained|capital|modal|saham|share|premium|agio|dividen|comprehensive)/i.test(label)) return "EKUITAS";
  return t;
}

const PRINT_ROW = /\b(cetak|dicetak|print|printed|export|diekspor|diunduh|download|generated|dibuat)\b/i;
const PERIOD_ROW = /\b(per|periode|period|as of|as at|s\.?\s?d|sampai|hingga|until|to)\b/i;

/**
 * The period a title states ("Periode 1 Januari 2026 s.d. 30 Juni 2026", "Per 30/06/2026"): rows naming a period win over other rows; a
 * print or export date ("Dicetak: 15/07/2026") never counts. The closing is the latest date; an opening only when the closing's own row
 * starts the period too (a 1st of the month means the day before).
 */
function titlePeriod(sheet: RawSheet, before: number): { closing: Date | null; opening: Date | null } {
  const rows = sheet.rows.slice(0, before).map((row) => {
    const text = (row ?? []).map(cellText).join(" ");
    const dates = (row ?? []).flatMap((c) => (c instanceof Date && Number.isFinite(c.getTime()) ? [dateOnly(c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate())] : datesIn(cellText(c))));
    return { text, dates: dates.sort((a, b) => +a - +b) };
  }).filter((r) => r.dates.length && !PRINT_ROW.test(r.text));
  const named = rows.filter((r) => PERIOD_ROW.test(r.text));
  const pool = named.length ? named : rows;
  const best = pool.reduce<(typeof pool)[number] | null>((a, b) => (!a || +b.dates[b.dates.length - 1] > +a.dates[a.dates.length - 1] ? b : a), null);
  if (!best) return { closing: null, opening: null };
  const closing = best.dates[best.dates.length - 1];
  const first = best.dates.length > 1 && +best.dates[0] < +closing ? best.dates[0] : null;
  return { closing, opening: first ? (first.getUTCDate() === 1 ? new Date(+first - 86_400_000) : first) : null };
}

/**
 * A trial balance's rows. The closing date is the closing group's header date, else the latest title date; the opening date is the opening
 * group's header date, else the day before a period's first day in the title ("1 Januari 2026" → 31 Des 2025), else unknown (the import
 * then assumes the year end before the closing date and says so).
 */
export function readTb(sheet: RawSheet, t: TableCandidate): { date: Date | null; rows: NeracaRow[]; tb: TbRead } {
  const layout = t.tb!;
  const c = t.columns;
  const rows: TbRow[] = [];
  const totals: TbRead["totals"] = [];
  const groups = Object.entries(layout.groups) as [TbGroup, { debit?: number; credit?: number; balance?: number }][];
  // Section headings (Aset / Liabilitas / Ekuitas) type the rows and tell a presentation-signed balance column (liabilities positive).
  const sections = new Map<TbRow, AccountType>();
  let section: AccountType | null = null;
  for (let r = t.headerRow + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] ?? [];
    if (row.every(isBlank)) continue;
    const codeCell = c.code !== undefined ? cellText(row[c.code]) : "";
    const nameCell = c.name !== undefined ? cellText(row[c.name]) : "";
    const hasCode = !!codeCell && CODE.test(codeCell);
    const label = codeCell && !hasCode ? codeCell : nameCell;
    const cells = groups.flatMap(([, s]) => [s.debit, s.credit, s.balance]).filter((x): x is number => x !== undefined).map((i) => row[i]);
    if (!hasCode && cells.every(isBlank)) {
      // heading
      if (SECTION_LIAB_EQUITY.test(label) || SECTION_LIAB.test(label)) section = "LIABILITAS";
      else if (SECTION_EQUITY.test(label)) section = "EKUITAS";
      else if (SECTION_ASSET.test(label) || SECTION_ASSET_SUB.test(label)) section = "ASET";
      continue;
    }
    const values: TbRow["values"] = {};
    const exact: NonNullable<TbRow["exact"]> = {};
    const errors: string[] = [];
    for (const [g, s] of groups) {
      const parts = s.balance !== undefined ? [cellCents(row[s.balance])] : [cellCents(row[s.debit!]), cellCents(row[s.credit!])];
      const bad = parts.find((p): p is string => typeof p === "string");
      if (bad) {
        errors.push(`${TB_GROUP_LABEL[g]} bukan angka: ${bad}`);
        continue;
      }
      values[g] = parts.length === 1 ? (parts[0] as bigint) : (parts[0] as bigint) - (parts[1] as bigint);
      const x = s.balance !== undefined ? cellSubSen(row[s.balance]) : exactOf(row[s.debit!], row[s.credit!], parts[0] as bigint, parts[1] as bigint);
      if (x !== undefined) exact[g] = x;
    }
    const ref = `${sheet.name}!${r + 1}`;
    if (/^(total|jumlah)\b/i.test(label) && !hasCode) {
      if (!errors.length) totals.push({ ref, label, values });
      continue;
    }
    if (!hasCode && !errors.length && Object.values(values).every((v) => v === 0n)) continue;
    const tbRow: TbRow = { ref, row: r + 1, code: hasCode ? codeCell : `${NO_CODE_PREFIX}${label}`, name: hasCode ? nameCell || codeCell : label, coded: hasCode, values, ...(Object.keys(exact).length ? { exact } : {}), errors };
    if (section) sections.set(tbRow, guessEquity(label, section) ?? section);
    rows.push(tbRow);
  }
  // A one-column group that only balances with liabilities and equity turned around was written with presentation signs (as a Neraca
  // prints them): read it debit-positive, like the Neraca reader does. A Dr/Cr pair carries its own side.
  const flipped: TbGroup[] = [];
  for (const [g, s] of groups) {
    if (s.balance === undefined) continue;
    const credit = (r: TbRow) => sections.get(r) === "LIABILITAS" || sections.get(r) === "EKUITAS";
    const raw = rows.reduce((sum, r) => sum + (r.values[g] ?? 0n), 0n);
    const turned = rows.reduce((sum, r) => sum + (credit(r) ? -(r.values[g] ?? 0n) : (r.values[g] ?? 0n)), 0n);
    if (raw !== 0n && turned === 0n) {
      flipped.push(g);
      for (const r of rows) {
        if (!credit(r)) continue;
        if (r.values[g] !== undefined) r.values[g] = -r.values[g]!;
        if (r.exact?.[g] !== undefined) r.exact[g] = -r.exact[g]!;
      }
    }
  }
  const title = titlePeriod(sheet, t.headerRow);
  const closing = layout.dates.CLOSING ?? layout.dates.ADJUSTED ?? layout.dates.UNADJUSTED ?? title.closing;
  const opening = layout.dates.OPENING ?? (title.closing && closing && +title.closing === +closing ? title.opening : null);
  const balance = (r: TbRow) => r.values.CLOSING ?? r.values.ADJUSTED ?? r.values.OPENING ?? r.values.UNADJUSTED ?? 0n;
  return {
    date: closing,
    // The closing balances, so every reader of a Neraca-mode table (evidence, previews) sees the accounts and the date.
    rows: rows.map((r) => ({ ref: r.ref, row: r.row, code: r.code, name: r.name, amount: balance(r), typeHint: sections.get(r) ?? null, termHint: null, coded: r.coded, errors: r.errors })),
    tb: { layout, rows, totals, opening, ...(flipped.length ? { flipped } : {}) },
  };
}

export function readTable(sheets: RawSheet[], t: TableCandidate): ReadResult {
  const sheet = sheets.find((s) => s.name === t.sheet);
  if (!sheet) throw new ParseError(`Sheet "${t.sheet}" tidak ditemukan`);
  if (t.tb) return { mode: "NERACA", sheet: t.sheet, totals: [], ...readTb(sheet, t) };
  if (t.mode === "LEDGER") return { mode: "LEDGER", sheet: t.sheet, ...readLedger(sheet, t) };
  return { mode: "NERACA", sheet: t.sheet, ...readNeraca(sheet, t) };
}
