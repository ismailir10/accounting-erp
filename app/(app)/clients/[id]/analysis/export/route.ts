import { prisma } from "@/lib/db";
import { exportContext } from "@/lib/reports/export-context";
import { FxMissingError, scopeCurrency, scopeEntities } from "@/lib/reports/fx";
import { monthlyBalance, monthlyIncome, ratios } from "@/lib/reports/analysis";
import { analysisWorkbook } from "@/lib/reports/analysis-workbook";
import { formatPeriod } from "@/lib/format";

/** GET ?entity&period — Analisis keuangan as Excel (three sheets). A working paper: no export event. Rupiah (or translated) scopes only. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await exportContext(req, (await params).id);
  if (!ctx) return new Response("Klien tidak ditemukan", { status: 404 });
  if (scopeCurrency(await scopeEntities(prisma, ctx.scope.entityIds)) !== "IDR") return new Response("Unduhan Excel analisis baru untuk pembukuan dalam Rupiah.", { status: 400 });
  const { year, month } = ctx.period;
  try {
    const pl = await monthlyIncome(prisma, ctx.scope, year, month);
    const bs = await monthlyBalance(prisma, ctx.scope, year, month);
    const body = await analysisWorkbook(ctx.meta, year, month, pl, bs, ratios(pl, bs));
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="analisis-${ctx.title.replace(/[^\w-]+/g, "_")}-${formatPeriod(year, month).replace(/\s+/g, "-")}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof FxMissingError) return new Response(e.message, { status: 400 });
    throw e;
  }
}
export const runtime = "nodejs";
