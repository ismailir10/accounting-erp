/**
 * A small CSV writer for working files that open in Excel id-ID: semicolon-separated, UTF-8 with a byte-order mark, CRLF lines. Bank
 * text and model text are untrusted, so a cell that a spreadsheet would read as a formula (starting with = + - @, a tab or a carriage
 * return) is neutralised with a leading apostrophe; a plain integer (a minor-unit amount such as -8400000) is left as the number it is.
 * Not a general export framework: the reports have their own Excel writers.
 */

const FORMULA = /^[=+\-@\t\r]/;
const INTEGER = /^-?\d+$/;

/** One cell: neutralised when it could run as a formula, quoted when it holds a separator, a quote or a line break. */
export function csvCell(value: string | number | bigint | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (FORMULA.test(s) && !INTEGER.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The whole file, header first, with the BOM Excel needs to read UTF-8. */
export function toCsv(header: string[], rows: (string | number | bigint | null | undefined)[][]): string {
  return `﻿${[header, ...rows].map((r) => r.map(csvCell).join(";")).join("\r\n")}\r\n`;
}
