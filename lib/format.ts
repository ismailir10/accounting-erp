export { formatRupiah, formatRupiahCompact } from "@/lib/money";

const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

/** Date-only values are stored as UTC midnight; always read with UTC getters. */
export function formatDate(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The WIB calendar day of a timestamp, e.g. an access end at 23:59 WIB → "23 Okt 2026". */
export function formatDateWib(d: Date): string {
  return formatDate(new Date(d.getTime() + 7 * 3600_000));
}

/** Timestamps (not date-only) shown in WIB, e.g. "24 Sep 2026 13.10". */
export function formatDateTime(d: Date): string {
  const wib = new Date(d.getTime() + 7 * 3600_000);
  const hh = String(wib.getUTCHours()).padStart(2, "0");
  const mm = String(wib.getUTCMinutes()).padStart(2, "0");
  return `${formatDate(wib)} ${hh}.${mm}`;
}

/** "1 Maret 2026": the full month name, for statement headings. */
export function formatDateLong(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function formatPeriod(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}

export function formatMonthShort(year: number, month: number): string {
  return `${MONTHS_SHORT[month - 1]} ${String(year).slice(2)}`;
}

export const monthName = (m: number) => MONTHS[m - 1];

/** "Agu 2026": a month in running text (a memo, a rationale). */
export function formatMonthYear(year: number, month: number): string {
  return `${MONTHS_SHORT[month - 1]} ${year}`;
}

export function dateOnly(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

export function periodBounds(year: number, month: number) {
  return { start: dateOnly(year, month, 1), end: new Date(Date.UTC(year, month, 0)) };
}

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "2,5" / "2.5" / "100" (percent, up to two decimals) → basis points; null when not a percent. */
export function percentToBp(text: string): number | null {
  const m = text.trim().replace(/\s*%$/, "").match(/^(\d{1,3})(?:[.,](\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}
