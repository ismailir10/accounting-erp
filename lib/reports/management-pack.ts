import type { Db } from "@/lib/db";
import { formatPeriod } from "@/lib/format";
import { excelAmount, newWorkbook, type WorkbookMeta } from "@/lib/reports/workbook";
import { managementSummary, percentOf } from "@/lib/reports/management";
import { noteForReport } from "@/lib/reports/report-comment";

/** Laporan manajemen bulanan (I4b): Ringkasan with the commentary, and Perubahan Akun. One company, its own currency; read-only. */
export async function managementWorkbook(db: Db, input: { clientId: string; entityId: string; year: number; month: number; meta: WorkbookMeta }): Promise<Buffer> {
  const s = await managementSummary(db, input);
  const book = newWorkbook({ ...input.meta, currency: s.currency });
  const n = (v: bigint) => excelAmount(v, s.currency);
  const { sheet, head } = book;
  const month = formatPeriod(s.period.year, s.period.month);
  const last = formatPeriod(s.previous.year, s.previous.month);
  const unit = `Dalam ${s.currency}`;

  const ws = sheet("Ringkasan", "Laporan manajemen bulanan", `${month} · ${unit}`, [34, 20, 20, 20, 22]);
  // The accountant's approved note while it still matches the books (I5b), else the computed sentences.
  const note = await noteForReport(db, input);
  ws.addRow([note.approved ? "Catatan bulan ini (disetujui akuntan)" : "Catatan bulan ini"]).font = { bold: true };
  for (const line of note.lines) ws.addRow([line]).alignment = { wrapText: false };
  if (note.staleNote) ws.addRow(["Catatan yang disetujui tidak dipakai: angka di buku besar berubah sesudahnya. Kalimat di atas dihitung ulang dari buku besar."]).font = { italic: true, color: { argb: "FFC4213A" } };
  ws.addRow([]);
  head(ws, ["", month, last, "Perubahan", "Tahun berjalan"]);
  const rows: [string, bigint, bigint, bigint | null][] = [
    ["Pendapatan", s.month.revenue, s.last.revenue, s.ytd.revenue],
    ["Laba kotor", s.month.grossProfit, s.last.grossProfit, s.ytd.grossProfit],
    ["Laba bersih", s.month.netProfit, s.last.netProfit, s.ytd.netProfit],
    ["Kas & bank akhir bulan", s.month.cash, s.last.cash, null],
  ];
  for (const [label, a, b, y] of rows) ws.addRow([label, n(a), n(b), n(a - b), y === null ? null : n(y)]);
  const margin = (part: bigint, whole: bigint) => percentOf(part, whole) ?? "–";
  ws.addRow(["Margin kotor", margin(s.month.grossProfit, s.month.revenue), margin(s.last.grossProfit, s.last.revenue), "", margin(s.ytd.grossProfit, s.ytd.revenue)]);
  ws.addRow(["Margin bersih", margin(s.month.netProfit, s.month.revenue), margin(s.last.netProfit, s.last.revenue), "", margin(s.ytd.netProfit, s.ytd.revenue)]);

  const pa = sheet("Perubahan Akun", "Akun laba rugi: bulan ini dibanding rata-rata bulan sebelumnya", `${month} · ${unit} · rata-rata dari bulan aktif sebelumnya (maks. 3)`, [12, 40, 18, 18, 18, 12]);
  head(pa, ["Kode", "Akun", "Bulan ini", "Rata-rata", "Selisih", "%"]);
  if (!s.changes.length) pa.addRow(["", "Belum ada mutasi akun laba rugi."]);
  for (const c of s.changes) pa.addRow([c.code, c.name, n(c.current), c.average === null ? null : n(c.average), n(c.delta), c.average === null ? "–" : (percentOf(c.delta, c.average < 0n ? -c.average : c.average) ?? "–")]);

  return Buffer.from(await book.wb.xlsx.writeBuffer());
}
