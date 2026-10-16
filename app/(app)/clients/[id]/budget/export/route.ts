import { prisma } from "@/lib/db";
import { exportContext } from "@/lib/reports/export-context";
import { BudgetError, budgetVsActual } from "@/lib/budget";
import { newWorkbook, n } from "@/lib/reports/workbook";
import { formatPeriod, monthName } from "@/lib/format";

/**
 * GET ?entity&period — Anggaran vs realisasi as Excel: the month and the year to date, budget / actual / difference per account, totals.
 * A working paper: no export event. Rupiah scopes only (the workbook writes whole units).
 */
/** A formula's cached result, left out beyond the safe integer range (Excel recalculates it on open). */
const result = (v: bigint) => (typeof n(v) === "number" ? Number(v) : undefined);

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await exportContext(req, (await params).id);
  if (!ctx) return new Response("Klien tidak ditemukan", { status: 404 });
  const { year, month } = ctx.period;
  let vs;
  try {
    vs = await budgetVsActual(prisma, ctx.scope, year, month);
  } catch (e) {
    if (e instanceof BudgetError) return new Response(e.message, { status: 400 });
    throw e;
  }
  if (vs.currency !== "IDR") return new Response("Unduhan Excel anggaran baru untuk pembukuan dalam Rupiah.", { status: 400 });
  const book = newWorkbook(ctx.meta);
  const ws = book.sheet("Anggaran", "Anggaran vs realisasi", `${formatPeriod(year, month)} dan s.d. ${monthName(month)} ${year}`, [44, 17, 17, 17, 17, 17, 17]);
  ws.pageSetup.orientation = "landscape";
  book.head(ws, ["Akun", "Anggaran bulan", "Realisasi bulan", "Selisih bulan", `Anggaran s.d. ${monthName(month)}`, `Realisasi s.d. ${monthName(month)}`, "Selisih s.d."]);
  for (const r of vs.rows) {
    const row = ws.addRow([`${r.code ? `${r.code} ` : ""}${r.label}`, n(r.month[0]), n(r.month[1]), null, n(r.ytd[0]), n(r.ytd[1]), null]);
    row.getCell(4).value = { formula: `C${row.number}-B${row.number}`, result: result(r.month[1] - r.month[0]) };
    row.getCell(7).value = { formula: `F${row.number}-E${row.number}`, result: result(r.ytd[1] - r.ytd[0]) };
    if (r.kind === "total") row.font = { bold: true };
  }
  const body = Buffer.from(await book.wb.xlsx.writeBuffer());
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="anggaran-${ctx.title.replace(/[^\w-]+/g, "_")}-${formatPeriod(year, month).replace(/\s+/g, "-")}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
export const runtime = "nodejs";
