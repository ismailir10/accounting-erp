import PDFDocument from "pdfkit";
import type { Db } from "@/lib/db";
import { formatDateLong, formatDateTime, periodBounds } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { currencyName, exponentOf } from "@/lib/fx/currency";
import type { Scope } from "@/lib/reports/ledger";
import { toUnit } from "@/lib/reports/format";
import type { NoteCell } from "@/lib/reports/notes";
import { statementSet, type SetRow, type SetStatement, type StatementSet } from "@/lib/reports/statement-set";

/**
 * The financial statements as one PDF ready to send (UC-K3): the same rows as the Excel file (`statementSet`), laid out on A4 with a
 * header on every page (entity, statement, period, unit), a DRAF line while the month isn't closed, and page numbers. Accounts beneath a
 * *Pos* stay in the Excel file; the PDF prints the lines, as a published statement does. In thousands each line rounds and each total
 * adds the printed lines, as on the page.
 */

export const A4 = { width: 595.28, height: 841.89 };
export const M = { left: 50, right: 50, top: 48, bottom: 56 };
export const INK = "#0B1B32";
export const MUTED = "#4B5768";
const FAIL = "#C4213A";
export const RULE = "#C9CFD8";
export const REVIEW = "#8A5300";
/** A management blank, with the punctuation right after it (so a closing "." never wraps onto a line of its own). */
const MANUAL_ONE = /^\[isi oleh manajemen: [^\]]*\][.,;:]?$/;

/**
 * The standard PDF fonts speak WinAnsi only: "−", "≤" or "→" would print as garbage. Known signs get their ASCII spelling; anything else
 * outside WinAnsi becomes "?" rather than a wrong glyph.
 */
const ASCII: Record<string, string> = { "\u2212": "-", "\u2264": "<=", "\u2265": ">=", "\u2192": "->", "\u2190": "<-", "\u2248": "~", "\u2260": "!=", "\u2011": "-", "\u2010": "-", "\u202f": " ", "\u2009": " " };
const CP1252 = new Set([..."€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"]);
export const winAnsi = (s: string) =>
  [...s].map((ch) => {
    const c = ch.codePointAt(0)!;
    if (c === 9 || c === 10 || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || CP1252.has(ch)) return ch;
    return ASCII[ch] ?? "?";
  }).join("");
/** Every string in a value (plain objects and arrays), made WinAnsi; dates and amounts as they are. */
function clean<T>(v: T): T {
  if (typeof v === "string") return winAnsi(v) as T;
  if (Array.isArray(v)) return v.map(clean) as T;
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) as T;
  return v;
}

/** An amount as printed: the set's currency, accounting brackets, a dash for zero. */
export const amountIn = (currency: string) => (v: bigint | null) => (v === null ? "" : v === 0n ? "–" : formatMoney(v, currency, { bare: true, accounting: true }));

/** The values a statement prints: per line in its unit, a format total as the sum of the printed lines it names. */
export function printedValues(rows: SetRow[], unit: StatementSet["unit"], currency = "IDR"): (bigint | null)[][] {
  const byKey = new Map<string, (bigint | null)[]>();
  return rows.map((row) => {
    const values = row.terms
      ? row.values.map((_, c) => row.terms!.reduce((s, t) => s + BigInt(t.sign) * (byKey.get(t.key)?.[c] ?? 0n), 0n))
      : row.values.map((v) => (v === null ? null : toUnit(v, unit, exponentOf(currency))));
    if (row.key) byKey.set(row.key, values);
    return values;
  });
}

export async function financialStatementsPdf(db: Db, scope: Scope, year: number, month: number, rawMeta: { firm: string; title: string; draft?: string }): Promise<Buffer> {
  const set = clean(await statementSet(db, scope, year, month));
  const meta = clean(rawMeta);
  const asOf = formatDateLong(periodBounds(year, month).end);
  const doc = new PDFDocument({ size: "A4", margins: M, autoFirstPage: false, bufferPages: true, info: { Title: `Laporan keuangan ${meta.title} ${asOf}`, Author: meta.firm, Creator: "Buku" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  const width = A4.width - M.left - M.right;
  const bottom = A4.height - M.bottom;

  // The page header follows the part being printed; every new page (one per part, and overflow) draws it.
  let header = { title: "", subtitle: "", unit: "", columns: [] as string[], colWidth: 0, size: 9 };
  let pages = 0;
  let reasonsAt = 0;
  doc.on("pageAdded", () => drawHeader());
  function drawHeader() {
    pages += 1;
    doc.x = M.left;
    doc.y = M.top;
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text(meta.title, { width });
    if (header.title) doc.font("Helvetica-Bold").fontSize(10).text(header.title, { width });
    if (header.subtitle) doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(header.subtitle, { width });
    if (header.unit) doc.font("Helvetica-Oblique").text(header.unit, { width });
    // The reasons once, on the first statement page (not on the Surat Pernyataan); every other page still says DRAF.
    if (meta.draft) {
      const first = !reasonsAt && Boolean(header.title);
      if (first) reasonsAt = pages;
      doc.moveDown(0.3).font("Helvetica-Bold").fillColor(FAIL).text(first ? `DRAF — ${meta.draft}` : reasonsAt ? `DRAF — lihat halaman ${reasonsAt}` : "DRAF", { width });
    }
    doc.moveDown(0.6).fillColor(INK);
    if (header.columns.length) {
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(Math.min(8.5, header.size));
      header.columns.forEach((c, i) => doc.text(c, colX(i) + 4, y, { width: header.colWidth - 4, align: "right" }));
      doc.y = y + Math.max(...header.columns.map((c) => doc.heightOfString(c, { width: header.colWidth - 4 }))) + 3;
      doc.moveTo(M.left, doc.y).lineTo(A4.width - M.right, doc.y).strokeColor(RULE).lineWidth(0.5).stroke();
      doc.y += 4;
    }
    doc.x = M.left;
  }
  const colX = (i: number) => A4.width - M.right - (header.columns.length - i) * header.colWidth;
  const startPart = (h: Partial<typeof header>) => {
    header = { title: "", subtitle: "", unit: "", columns: [], colWidth: 0, size: 9, ...h };
    doc.addPage();
  };
  const ensure = (h: number) => {
    if (doc.y + h > bottom) doc.addPage();
  };

  const amount = amountIn(set.currency);
  const unitLine = `Dinyatakan dalam ${set.unit === "RIBUAN" ? "ribuan " : ""}${currencyName(set.currency)}`;
  // The statement of responsibility opens the set, as in an Indonesian report; its own heading is its title.
  if (set.notes) directors(set.notes.directors);
  for (const st of set.statements) statement(st);

  function statement(st: SetStatement) {
    const n = Math.max(1, st.columns.length, ...st.rows.map((r) => r.values.length));
    const values = printedValues(st.rows, set.unit, set.currency);
    // Columns as wide as the widest printed amount (bold, at 9 pt); when they'd squeeze the labels below 30% of the line, the type shrinks.
    doc.font("Helvetica-Bold").fontSize(9);
    const amounts = Math.max(0, ...values.flatMap((vs, i) => (st.rows[i].detail ? [] : vs.map((v) => doc.widthOfString(amount(v))))));
    // A column header ("1 Maret – 31 Juli 2026") on one line when it fits the room a column may take.
    doc.fontSize(8.5);
    const heads = Math.max(0, ...st.columns.map((c) => doc.widthOfString(c)));
    doc.fontSize(9);
    const widest = Math.max(amounts, heads) + 8;
    const room = (width * 0.7) / n;
    const size = widest > room ? Math.max(6, (9 * room) / widest) : 9;
    const colWidth = Math.min(room, Math.max(widest, Math.min(95, (width * 0.55) / n)));
    startPart({ title: st.title, subtitle: st.subtitle, unit: unitLine, columns: st.columns, colWidth, size });
    const labelWidth = width - n * colWidth - 8;
    st.rows.forEach((row, i) => {
      if (row.detail) return;
      const font = row.bold ? "Helvetica-Bold" : "Helvetica";
      doc.font(font).fontSize(size);
      const indent = (row.indent ?? 0) * 10;
      const h = Math.max(doc.heightOfString(row.label, { width: labelWidth - indent }), doc.currentLineHeight()) + 3;
      const total = Boolean(row.terms);
      // A section heading (a bold line without figures) gets air above it.
      if (i > 0 && row.bold && row.values.length === 0) doc.y += 5;
      ensure(h + (total ? 4 : 0));
      doc.font(font).fontSize(size); // a new page's header leaves its own font
      if (total) {
        doc.moveTo(A4.width - M.right - n * colWidth + 10, doc.y).lineTo(A4.width - M.right, doc.y).strokeColor(RULE).lineWidth(0.5).stroke();
        doc.y += 2;
      }
      const y = doc.y;
      doc.fillColor(INK).text(row.label, M.left + indent, y, { width: labelWidth - indent });
      values[i].forEach((v, c) => doc.text(amount(v), A4.width - M.right - (values[i].length - c) * colWidth, y, { width: colWidth, align: "right", lineBreak: false }));
      doc.y = y + h;
      doc.x = M.left;
    });
  }

  const notes = set.notes;
  if (notes) {
    // CALK (in the set's currency: its tables are the registers and schedules behind the statements)
    startPart({ title: "Catatan atas Laporan Keuangan", subtitle: `Per ${asOf} dan untuk periode yang berakhir pada tanggal tersebut`, unit: `Dinyatakan dalam ${currencyName(set.currency)}` });
    const cell = (c: NoteCell) => (typeof c === "bigint" ? amount(c) : (c ?? ""));
    for (const note of notes.notes) {
      // The heading stays with what follows it: a short note whole; else its paragraphs (up to two) and its table's header and two rows.
      doc.font("Helvetica").fontSize(9);
      const lead = note.paragraphs.slice(0, 2).reduce((t, p) => t + doc.heightOfString(p, { width }) + 4, 0);
      const rows = note.tables.reduce((t, x) => t + x.rows.length + (x.total ? 1 : 0) + 1, 0);
      ensure(18 + lead + (rows <= 8 ? rows * 13 + note.tables.length * 8 : note.tables.length ? 3 * 13 : 0));
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK).text(`${note.number}. ${note.title.toUpperCase()}`, M.left, doc.y, { width });
      doc.moveDown(0.3);
      for (const p of note.paragraphs) {
        doc.font("Helvetica").fontSize(9);
        ensure(doc.heightOfString(p, { width }) + 4);
        // *[isi oleh manajemen: …]* in review colour, so the blank is seen before the PDF goes out.
        const parts = p.split(/(\[isi oleh manajemen: [^\]]*\][.,;:]?)/).filter(Boolean);
        if (parts.length === 1 && !MANUAL_ONE.test(p)) doc.text(p, M.left, doc.y, { width, align: "justify" });
        else
          parts.forEach((part, k) =>
            doc.fillColor(MANUAL_ONE.test(part) ? REVIEW : INK).text(part, k === 0 ? M.left : undefined, k === 0 ? doc.y : undefined, { width, continued: k < parts.length - 1 }),
          );
        doc.fillColor(INK);
        doc.moveDown(0.4);
      }
      for (const t of note.tables) table(t.columns, t.rows.map((r) => r.map(cell)), t.total?.map(cell));
      doc.moveDown(0.6);
    }
  }

  // Pernyataan Direksi (Pemilik/Pengurus for a CV, a firm or an individual): the signer's details to fill, then room to sign over a meterai.
  function directors(lines: string[]) {
    startPart({});
    doc.moveDown(1);
    lines.forEach((text, i) => {
      const head = i < 3;
      if (text === "Meterai Rp10.000") {
        doc.moveDown(1.5);
        doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(text, M.left, doc.y, { width });
        doc.moveDown(3);
        return;
      }
      doc.font(head ? "Helvetica-Bold" : "Helvetica").fontSize(head ? 10.5 : 9.5).fillColor(INK);
      // A sub-item ("   b. …") keeps its indent on every wrapped line; the place-and-date line gets air above it.
      const inset = /^\s+/.test(text) ? 14 : 0;
      if (/^_+, _+$/.test(text)) doc.moveDown(1);
      ensure(doc.heightOfString(text.trim(), { width: width - inset }) + 6);
      doc.text(text.trim(), M.left + inset, doc.y, { width: width - inset, align: head ? "center" : "left" });
      doc.moveDown(head && i === 2 ? 1.2 : 0.5);
    });
  }

  function table(columns: string[], rows: string[][], total?: string[]) {
    const first = Math.max(width * 0.34, width - (columns.length - 1) * 115); // "1 Januari – 31 Maret 2026" fits one line
    const rest = columns.length > 1 ? (width - first) / (columns.length - 1) : 0;
    const x = (i: number) => (i === 0 ? M.left : M.left + first + (i - 1) * rest);
    const w = (i: number) => (i === 0 ? first - 6 : rest);
    const heightOf = (cells: string[], bold: boolean) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5);
      return Math.max(...cells.map((c, i) => doc.heightOfString(c || " ", { width: w(i) }))) + 3;
    };
    const rule = () => {
      doc.moveTo(M.left, doc.y).lineTo(A4.width - M.right, doc.y).strokeColor(RULE).lineWidth(0.5).stroke();
      doc.y += 2;
    };
    const line = (cells: string[], bold: boolean, head = false) => {
      const h = heightOf(cells, bold);
      // A table that runs onto a new page repeats its column header there.
      if (!head && doc.y + h > bottom) {
        doc.addPage();
        line(columns, true, true);
        rule();
      }
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).fillColor(INK);
      const y = doc.y;
      cells.forEach((c, i) => doc.text(c, x(i), y, { width: w(i), align: i === 0 ? "left" : "right" }));
      doc.y = y + h;
    };
    // The header never ends a page: it starts where two rows fit under it.
    ensure(heightOf(columns, true) + 2 + rows.slice(0, 2).reduce((t, r) => t + heightOf(r, false), 0));
    line(columns, true, true);
    rule();
    for (const r of rows) line(r, false);
    if (total) line(total, true);
    doc.x = M.left;
    doc.moveDown(0.4);
  }

  // Page numbers and the firm on every page (the bottom margin is lifted so the footer doesn't open a page of its own).
  const range = doc.bufferedPageRange();
  const stamp = `${meta.firm} · dibuat ${formatDateTime(new Date())}`;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED);
    doc.text(stamp, M.left, A4.height - 36, { width: width / 2, lineBreak: false });
    doc.text(`Halaman ${i - range.start + 1} dari ${range.count}`, M.left + width / 2, A4.height - 36, { width: width / 2, align: "right", lineBreak: false });
    doc.page.margins.bottom = keep;
  }
  doc.end();
  return done;
}
