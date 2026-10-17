import ExcelJS from "exceljs";
import { currencyName, exponentOf } from "@/lib/fx/currency";
import type { Db } from "@/lib/db";
import { formatDateLong, formatDateTime, formatPeriod, periodBounds } from "@/lib/format";
import type { Scope } from "@/lib/reports/ledger";
import type { NoteCell } from "@/lib/reports/notes";
import { statementSet, type SetStatement } from "@/lib/reports/statement-set";

/**
 * The financial statements as one Excel workbook (accounting-rules 1): Neraca, Laba Rugi (with other comprehensive income unless SAK EMKM), Perubahan
 * Ekuitas, Arus Kas, CALK and the directors' statement — drawn from `statementSet`, the same rows as the PDF, never a second computation.
 * Amounts are Excel numbers (text beyond 2^53); the format's subtotals and totals are formulas over the rows they sum. Mixed-currency
 * scopes get Neraca and Laba Rugi only, as on the page.
 */

const NUM = '#,##0;(#,##0);"–"';
/** Thousands as a display format over exact Rupiah cells (the trailing comma divides by 1.000), so every formula stays exact. */
const NUM_THOUSANDS = '#,##0,;(#,##0,);"–"';
export const n = (v: bigint) => (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString());
/** Two decimals for a currency that has them (S$ 1.234,56), else whole units. */
const NUM_DECIMALS = '#,##0.00;(#,##0.00);"–"';

/** An amount in minor units as the Excel number of its currency's major unit: Rp 1.234 → 1234, S$ 1.234,56 (123456 sen) → 1234.56. */
export function excelAmount(v: bigint, currency = "IDR"): number | string {
  const e = exponentOf(currency);
  if (e === 0) return n(v);
  const base = 10n ** BigInt(e);
  const abs = v < 0n ? -v : v;
  const whole = abs / base;
  const text = `${v < 0n ? "-" : ""}${whole}.${String(abs % base).padStart(e, "0")}`;
  // The double must hold every cent: the minor-unit count, not only the whole part, has to be a safe integer.
  return abs <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(text) : text;
}

/** `meta.draft`: why the statements are not final yet (lib/reports/status.ts); printed in red under every sheet's title. Absent = final. */
export type WorkbookMeta = { firm: string; title: string; draft?: string; /** The amounts' currency (default Rupiah); a sheet may name its own. */ currency?: string };

/** A4, one page wide (as many pages tall as it needs): `fitToPage` makes Excel honour the width. */
export const PRINT_SETUP = { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } as const;

/** A workbook whose sheets open with the title block every Buku export uses (client, sheet title, subtitle, unit, firm, draft). */
export function newWorkbook(meta: WorkbookMeta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.firm;
  // Totals are formulas; a cached 0 is not written, so Excel recalculates every formula when the file opens.
  wb.calcProperties.fullCalcOnLoad = true;
  const sheet = (name: string, title: string, subtitle: string, widths: number[], unit: "RUPIAH" | "RIBUAN" = "RUPIAH", currency = meta.currency ?? "IDR") => {
    const ws = wb.addWorksheet(name, { pageSetup: { ...PRINT_SETUP } });
    ws.addRow([meta.title]).font = { bold: true, size: 13 };
    ws.addRow([title]).font = { bold: true };
    ws.addRow([subtitle]);
    ws.addRow([`Dinyatakan dalam ${unit === "RIBUAN" ? "ribuan " : ""}${currencyName(currency)}`]).font = { italic: true };
    ws.addRow([`${meta.firm} · dibuat ${formatDateTime(new Date())}`]).font = { italic: true, color: { argb: "FF4B5768" } };
    if (meta.draft) {
      // The reasons can be long: wrapped across the sheet's columns, not one line running off the page.
      const r = ws.addRow([`DRAF — ${meta.draft}`]);
      r.font = { bold: true, color: { argb: "FFC4213A" } };
      r.alignment = { wrapText: true, vertical: "top" };
      if (widths.length > 1) ws.mergeCells(r.number, 1, r.number, widths.length);
      r.height = 15 * Math.max(1, Math.ceil(`DRAF — ${meta.draft}`.length / Math.max(40, widths.reduce((t, w) => t + w, 0))));
    }
    ws.addRow([]);
    widths.forEach((w, i) => {
      ws.getColumn(i + 1).width = w;
      if (i > 0) ws.getColumn(i + 1).numFmt = unit === "RIBUAN" ? NUM_THOUSANDS : exponentOf(currency) > 0 ? NUM_DECIMALS : NUM;
    });
    return ws;
  };
  const head = (ws: ExcelJS.Worksheet, cells: string[]) => {
    const r = ws.addRow(cells);
    r.font = { bold: true };
    r.eachCell((c) => (c.border = { bottom: { style: "thin" } }));
  };
  return { wb, sheet, head, draft: Boolean(meta.draft) };
}

export async function financialStatementsWorkbook(db: Db, scope: Scope, year: number, month: number, meta: WorkbookMeta): Promise<Buffer> {
  const book = newWorkbook(meta);
  await addStatementSheets(db, book, scope, year, month);
  return Buffer.from(await book.wb.xlsx.writeBuffer());
}

/** The statement set's sheets (and CALK + directors' statement when the scope has them) added to `book`. */
export async function addStatementSheets(db: Db, book: ReturnType<typeof newWorkbook>, scope: Scope, year: number, month: number) {
  const { wb, sheet, head, draft } = book;
  const set = await statementSet(db, scope, year, month);
  const cur = periodBounds(year, month).end;

  /** A statement's rows; a format total becomes an Excel formula over the rows it sums (rows not printed are 0 and left out). */
  const statement = (st: SetStatement) => {
    const ws = sheet(st.name, st.title, st.subtitle, st.widths, set.unit, set.currency);
    if (st.columns.length) head(ws, ["", ...st.columns]);
    const rowOf = new Map<string, number>();
    const letter = (c: number) => String.fromCharCode(66 + c); // B, C, …
    for (const row of st.rows) {
      const r = ws.addRow([`${" ".repeat((row.indent ?? 0) * 2)}${row.label}`, ...row.values.map((v) => (v === null ? null : excelAmount(v, set.currency)))]);
      if (row.bold) r.font = { bold: true };
      if (row.terms)
        row.values.forEach((v, c) => {
          const parts = row.terms!.filter((x) => rowOf.has(x.key)).map((x, i) => `${x.sign < 0 ? "-" : i ? "+" : ""}${letter(c)}${rowOf.get(x.key)}`);
          const value = excelAmount(v ?? 0n, set.currency);
          if (parts.length) r.getCell(c + 2).value = { formula: parts.join(""), result: typeof value === "number" ? value : Number(value) };
        });
      if (row.key) rowOf.set(row.key, r.number);
    }
  };
  for (const st of set.statements) statement(st);
  const notes = set.notes;
  if (!notes) return;

  // CALK
  const ck = sheet("CALK", "Catatan atas Laporan Keuangan", `Per ${formatDateLong(cur)} dan untuk periode yang berakhir pada tanggal tersebut${draft ? " (draf)" : ""}`, [60, 20, 20, 20, 20], "RUPIAH", set.currency);
  const cell = (c: NoteCell) => (typeof c === "bigint" ? excelAmount(c, set.currency) : c);
  for (const note of notes.notes) {
    ck.addRow([`${note.number}. ${note.title.toUpperCase()}`]).font = { bold: true };
    for (const p of note.paragraphs) {
      const r = ck.addRow([p]);
      r.alignment = { wrapText: true, vertical: "top" };
      ck.mergeCells(r.number, 1, r.number, 5);
    }
    for (const t of note.tables) {
      head(ck, t.columns);
      for (const row of t.rows) ck.addRow(row.map(cell));
      if (t.total) ck.addRow(t.total.map(cell)).font = { bold: true };
    }
    ck.addRow([]);
  }

  // Pernyataan Direksi (Pemilik/Pengurus for a CV, a firm or an individual)
  const pd = wb.addWorksheet(set.signatory.sheet, { pageSetup: { ...PRINT_SETUP } });
  pd.getColumn(1).width = 100;
  notes.directors.forEach((text, i) => {
    const r = pd.addRow([text]);
    r.alignment = { wrapText: true, horizontal: i < 3 ? "center" : "left" };
    if (i < 3) r.font = { bold: true };
  });
}

export const statementsFileName = (label: string, year: number, month: number, ext: "xlsx" | "pdf" = "xlsx") =>
  `laporan-keuangan-${label.replace(/[^\w-]+/g, "_")}-${formatPeriod(year, month).replace(/\s+/g, "-")}.${ext}`;
