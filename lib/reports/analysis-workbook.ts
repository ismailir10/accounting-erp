import { formatPeriod } from "@/lib/format";
import type { MonthlyBalance, MonthlyIncome, RatioRow, TrendRow } from "@/lib/reports/analysis";
import { n, newWorkbook, type WorkbookMeta } from "@/lib/reports/workbook";

/**
 * Analisis keuangan as Excel: Laba Rugi per bulan (the year-to-date column a SUM of the months), Neraca per bulan and the ratios, from the
 * same rows as the page. Landscape, one page wide.
 */
export async function analysisWorkbook(meta: WorkbookMeta, year: number, month: number, pl: MonthlyIncome, bs: MonthlyBalance, ratioRows: RatioRow[]): Promise<Buffer> {
  const book = newWorkbook(meta);
  const through = `Tahun buku s.d. ${formatPeriod(year, month)}`;
  const col = (i: number) => {
    let s = "";
    for (let k = i + 1; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
    return s;
  };
  const trend = (name: string, title: string, rows: TrendRow[], months: { label: string }[], total: boolean) => {
    const ws = book.sheet(name, title, through, [44, ...months.map(() => 16), ...(total ? [18] : [])]);
    ws.pageSetup.orientation = "landscape";
    book.head(ws, ["Pos", ...months.map((m) => m.label), ...(total ? [`S.d. ${formatPeriod(year, month)}`] : [])]);
    ws.views = [{ state: "frozen", xSplit: 1, ySplit: ws.rowCount }];
    for (const r of rows) {
      if (r.kind === "heading") {
        ws.addRow([r.label]).font = { italic: true, color: { argb: "FF4B5768" } };
        continue;
      }
      const row = ws.addRow([`${r.kind === "account" ? "    " : ""}${r.code ? `${r.code} ` : ""}${r.label}`, ...r.values.map(n)]);
      if (total && r.total !== undefined) {
        // A SUM of the months where it is one (single currency); a translated group's total is its own year-to-date figure.
        const last = col(months.length);
        const sums = r.values.reduce((t, v) => t + v, 0n) === r.total;
        row.getCell(months.length + 2).value = sums ? { formula: `SUM(B${row.number}:${last}${row.number})`, result: Number(r.total) } : n(r.total);
      }
      if (r.kind !== "account") row.font = { bold: r.kind === "total" };
      if (r.kind === "total") row.eachCell((c) => (c.border = { top: { style: "thin" } }));
    }
  };
  trend("Laba Rugi per bulan", "Laba Rugi per bulan", pl.rows, pl.months, true);
  trend("Neraca per bulan", "Neraca per bulan", bs.rows, bs.months, false);
  const ws = book.sheet("Rasio keuangan", "Rasio keuangan", through, [34, 52, ...bs.months.map(() => 14)]);
  ws.pageSetup.orientation = "landscape";
  book.head(ws, ["Rasio", "Rumus", ...bs.months.map((m) => m.label)]);
  let group = "";
  for (const r of ratioRows) {
    if (r.group !== group) {
      ws.addRow([r.group]).font = { italic: true, color: { argb: "FF4B5768" } };
      group = r.group;
    }
    const row = ws.addRow([r.label, r.formula, ...r.values.map((v) => (v === null ? "–" : r.amount ? n(BigInt(v)) : v))]);
    row.eachCell((c, i) => {
      if (i > 2) c.alignment = { horizontal: "right" };
    });
  }
  return Buffer.from(await book.wb.xlsx.writeBuffer());
}
