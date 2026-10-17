import type ExcelJS from "exceljs";
import { formatDateLong, formatPeriod } from "@/lib/format";
import { ENTRY_KIND_LABEL } from "@/lib/reports/entry-source";
import type { GlAccount, LedgerRange } from "@/lib/reports/general-ledger";
import type { RegisterEntry } from "@/lib/reports/journal-register";
import type { TbMoveRow, TbRow } from "@/lib/reports/ledger";
import { n, newWorkbook, type WorkbookMeta } from "@/lib/reports/workbook";

/**
 * The ledger as working papers (Jurnal Umum, Buku Besar, Neraca Saldo), drawn from the same functions as the pages — never a second
 * computation. Amounts are Excel numbers; totals and the running balance are formulas over the rows, so a reader can check them.
 * Landscape A4, one page wide.
 */

const DATE = "dd/mm/yyyy";
const xlsx = async (wb: ExcelJS.Workbook) => Buffer.from(await wb.xlsx.writeBuffer());
/** A date-only value as Excel shows it on any machine (the date at UTC midnight is the date). */
const day = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const amount = (v: bigint) => (v === 0n ? null : n(v));
/** The cached value Excel shows before recalculating: exact only within Number's safe range, else left for Excel to compute. */
const result = (v: bigint) => (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : undefined);
/** A SUM over rows `from`..`to`, or a plain zero when the range is empty (a SUM pointing at its own row would be circular). */
const sumOrZero = (col: string, from: number, to: number, v: bigint) => (to < from ? 0 : { formula: `SUM(${col}${from}:${col}${to})`, result: result(v) });

/** "September 2026", or "1 Januari 2026 – 30 September 2026" for the year to date. */
export function rangeLabel(range: LedgerRange, start: Date, end: Date) {
  return range === "ytd" ? `${formatDateLong(start)} – ${formatDateLong(end)}` : formatPeriod(end.getUTCFullYear(), end.getUTCMonth() + 1);
}

export const ledgerFileName = (kind: "jurnal-umum" | "buku-besar" | "neraca-saldo", label: string, range: LedgerRange, end: Date) =>
  `${kind}-${label.replace(/[^\w-]+/g, "_")}-${range === "ytd" ? "sd-" : ""}${formatPeriod(end.getUTCFullYear(), end.getUTCMonth() + 1).replace(/\s+/g, "-")}.xlsx`;

/** Jurnal Umum: one header row per journal (date, kind, entity, memo, source), its lines under it, and the column totals. */
export async function journalWorkbook(meta: WorkbookMeta, subtitle: string, entries: RegisterEntry[]): Promise<Buffer> {
  const { wb, sheet, head } = newWorkbook(meta);
  const ws = sheet("Jurnal Umum", "Jurnal Umum", subtitle, [12, 18, 14, 44, 9, 34, 17, 17, 48]);
  ws.pageSetup.orientation = "landscape";
  head(ws, ["Tanggal", "Jenis", "Entitas", "Keterangan", "Kode", "Akun", "Debit", "Kredit", "Sumber"]);
  const first = ws.rowCount + 1;
  for (const e of entries) {
    const r = ws.addRow([day(e.date), ENTRY_KIND_LABEL[e.kind], e.entity, e.memo, null, null, null, null, [e.source, e.origin, e.reversedOn ? `dibalik ${formatDateLong(e.reversedOn)}` : null].filter(Boolean).join(" · ") || `Dicatat oleh ${e.postedBy}`]);
    r.font = { bold: true };
    r.getCell(1).numFmt = DATE;
    for (const l of e.lines) ws.addRow([null, null, null, l.memo, l.code, l.name, amount(l.debit), amount(l.credit), null]);
  }
  const last = ws.rowCount;
  const debit = entries.reduce((t, e) => t + e.lines.reduce((s, l) => s + l.debit, 0n), 0n);
  const credit = entries.reduce((t, e) => t + e.lines.reduce((s, l) => s + l.credit, 0n), 0n);
  const total = ws.addRow([null, null, null, `Jumlah (${entries.length} jurnal)`]);
  total.font = { bold: true };
  total.getCell(7).value = sumOrZero("G", first, last, debit);
  total.getCell(8).value = sumOrZero("H", first, last, credit);
  total.eachCell((c) => (c.border = { top: { style: "thin" } }));
  ws.views = [{ state: "frozen", ySplit: first - 1 }];
  return xlsx(wb);
}

/**
 * Buku Besar: per account its opening, its lines with the source and a running-balance formula, and its closing. Balances read on the
 * account's normal side (positive = normal), as on the page.
 */
export async function ledgerWorkbook(meta: WorkbookMeta, subtitle: string, accounts: GlAccount[]): Promise<Buffer> {
  const { wb, sheet, head } = newWorkbook(meta);
  const ws = sheet("Buku Besar", "Buku Besar", `${subtitle} · saldo menurut saldo normal akun`, [12, 44, 18, 14, 48, 17, 17, 18]);
  ws.pageSetup.orientation = "landscape";
  head(ws, ["Tanggal", "Keterangan", "Jenis", "Entitas", "Sumber", "Debit", "Kredit", "Saldo"]);
  ws.views = [{ state: "frozen", ySplit: ws.rowCount }];
  for (const a of accounts) {
    ws.addRow([`${a.account.code} ${a.account.name}`]).font = { bold: true };
    const open = ws.addRow([null, a.priorYearProfit !== 0n ? "Saldo awal (termasuk laba rugi tahun-tahun lalu)" : "Saldo awal", null, null, null, null, null, n(a.opening)]);
    open.font = { italic: true };
    const debitSide = a.account.normalBalance === "DEBIT";
    let prev = open.number;
    for (const l of a.lines) {
      const r = ws.addRow([day(l.date), l.memo, ENTRY_KIND_LABEL[l.kind], l.entity, l.source, amount(l.debit), amount(l.credit)]);
      r.getCell(1).numFmt = DATE;
      r.getCell(8).value = { formula: debitSide ? `H${prev}+F${r.number}-G${r.number}` : `H${prev}-F${r.number}+G${r.number}`, result: result(l.balance) };
      prev = r.number;
    }
    const close = ws.addRow([null, "Saldo akhir"]);
    close.font = { bold: true };
    // An account with an opening and no movement has no line rows: its movement is zero, not a SUM over its own closing row.
    close.getCell(6).value = sumOrZero("F", open.number + 1, close.number - 1, a.debit);
    close.getCell(7).value = sumOrZero("G", open.number + 1, close.number - 1, a.credit);
    close.getCell(8).value = { formula: `H${prev}`, result: result(a.closing) };
    close.eachCell((c) => (c.border = { top: { style: "thin" } }));
    ws.addRow([]);
  }
  if (!accounts.length) ws.addRow(["Tidak ada saldo atau transaksi di periode ini."]);
  return xlsx(wb);
}

const side = (net: bigint) => [net > 0n ? n(net) : null, net < 0n ? n(-net) : null];

/**
 * Neraca Saldo: saldo awal, mutasi and saldo akhir, each debit and credit (or the closing only, for a mixed-currency group translated to
 * IDR), with total formulas so debit = credit is visible.
 */
export async function trialBalanceWorkbook(meta: WorkbookMeta, subtitle: string, rows: TbMoveRow[] | TbRow[]): Promise<Buffer> {
  const { wb, sheet, head } = newWorkbook(meta);
  const moves = rows.length > 0 && "opening" in rows[0];
  const ws = sheet("Neraca Saldo", "Neraca Saldo", subtitle, moves ? [10, 40, 17, 17, 17, 17, 17, 17] : [10, 40, 18, 18]);
  ws.pageSetup.orientation = "landscape";
  if (moves) {
    const g = ws.addRow(["", "", "Saldo awal", "", "Mutasi", "", "Saldo akhir", ""]);
    g.font = { bold: true };
    ws.mergeCells(g.number, 3, g.number, 4);
    ws.mergeCells(g.number, 5, g.number, 6);
    ws.mergeCells(g.number, 7, g.number, 8);
    g.eachCell((c) => (c.alignment = { horizontal: "center" }));
    head(ws, ["Kode", "Akun", "Debit", "Kredit", "Debit", "Kredit", "Debit", "Kredit"]);
  } else head(ws, ["Kode", "Akun", "Debit", "Kredit"]);
  ws.views = [{ state: "frozen", ySplit: ws.rowCount }];
  const first = ws.rowCount + 1;
  const shown = (rows as (TbMoveRow | TbRow)[]).filter((r) => r.net !== 0n || ("opening" in r && (r.periodDebit || r.periodCredit || r.opening)));
  const sums = new Array<bigint>(moves ? 6 : 2).fill(0n);
  for (const r of shown) {
    const values = "opening" in r && moves ? [r.opening > 0n ? r.opening : 0n, r.opening < 0n ? -r.opening : 0n, r.periodDebit, r.periodCredit, r.debit, r.credit] : [r.debit, r.credit];
    values.forEach((v, i) => (sums[i] += v));
    ws.addRow([r.account.code, r.account.name, ...("opening" in r && moves ? [...side(r.opening), amount(r.periodDebit), amount(r.periodCredit), ...side(r.net)] : side(r.net))]);
  }
  const last = ws.rowCount;
  const total = ws.addRow(["", "Jumlah"]);
  total.font = { bold: true };
  sums.forEach((v, i) => (total.getCell(3 + i).value = sumOrZero(String.fromCharCode(67 + i), first, last, v)));
  total.eachCell((c) => (c.border = { top: { style: "thin" } }));
  return xlsx(wb);
}
