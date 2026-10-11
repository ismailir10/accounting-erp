import type { RawCell } from "./types";

/**
 * The company a report names in its title rows. Accounting packages print it above the report ("SANRAYA ADI NATTAYA / Balance Sheet /
 * 31/05/2026") or below its name ("Profit Loss Report / PT Filosofi Kopi Mandiri / Period …"). Used by *Tambah klien* to propose the
 * real company instead of the client's working name; nothing is stored. Null when no title row reads as a company.
 */

const LEGAL_FORM = /^(?:PT\.?|CV\.?|UD\.?|PD\.?)\s+\S.{1,100}$|\S.{1,100}\s(?:Pte\.?\s?Ltd\.?|Tbk\.?|Limited|Ltd\.?|LLC)$/i;
/** Words of a report's own title and metadata lines: never the company. */
const REPORT_WORD =
  /\b(?:balance sheet|neraca|profit\s*(?:&|and)?\s*loss|laba\s*rugi|arus kas|cash flow|general ledger|buku besar|trial balance|income statement|statement|laporan|report|period|periode|generated|display|mode|currency|mata uang|in idr|dalam rupiah|date|tanggal|account|akun|jurnal|assets?|aset|total)\b/i;
const DATE_LIKE = /\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\b\d{4}[/.-]\d{1,2}[/.-]\d{1,2}\b/;
const TITLE_ROWS = 8;

const text = (c: RawCell | undefined) => (typeof c === "string" ? c.trim().replace(/\s+/g, " ") : "");

export function companyFromTitleRows(rows: RawCell[][]): string | null {
  // Title rows have a cell or two; a row of column headers or data is not one.
  const lines: string[] = [];
  for (const row of rows.slice(0, TITLE_ROWS)) {
    // A merged title repeats in every cell it spans, so count distinct texts, and any number or date makes it a data row.
    const cells = [...new Set(row.map(text).filter(Boolean))];
    const onlyText = row.every((c) => c === null || c === "" || typeof c === "string");
    lines.push(onlyText && cells.length >= 1 && cells.length <= 2 ? cells[0] : "");
  }
  const named = (t: string) => t.length >= 3 && t.length <= 100 && /\p{L}/u.test(t) && !DATE_LIKE.test(t) && !REPORT_WORD.test(t);

  const legal = lines.find((t) => t && LEGAL_FORM.test(t) && named(t));
  if (legal) return legal;
  // Without a legal form: the first line, when a report title follows it ("SANRAYA ADI NATTAYA" above "Balance Sheet").
  const first = lines.findIndex(Boolean);
  if (first === -1 || first > 1 || !named(lines[first])) return null;
  return lines.slice(first + 1, first + 4).some((t) => t && REPORT_WORD.test(t)) ? lines[first] : null;
}
