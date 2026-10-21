import { prisma } from "@/lib/db";
import { dimensionWorkbook, incomeByDimension } from "@/lib/reports/by-dimension";
import { FxMissingError, scopeCurrency, scopeEntities } from "@/lib/reports/fx";
import { exportContext, xlsxResponse } from "@/lib/reports/export-context";
import { recordExport } from "@/lib/reports/export-log";
import { DIMENSION_LABEL } from "@/lib/dimensions";
import { financialYear } from "@/lib/fiscal";
import { periodBounds } from "@/lib/format";

/** GET ?entity=<id|combined>&period=YYYY-MM&jenis=DEPARTEMEN|PROYEK&rentang=ytd — Laba Rugi per departemen / proyek as Excel. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ctx = await exportContext(req, id);
    if (!ctx) return new Response("Klien tidak ditemukan", { status: 404 });
    const url = new URL(req.url);
    const kind = url.searchParams.get("jenis") === "PROYEK" ? "PROYEK" : "DEPARTEMEN";
    const { start, end } = periodBounds(ctx.period.year, ctx.period.month);
    const from = url.searchParams.get("rentang") === "ytd" ? financialYear(ctx.client.fiscalYearEndMonth, ctx.period.year, ctx.period.month).start : start;
    const entities = await scopeEntities(prisma, ctx.scope.entityIds);
    const pl = await incomeByDimension(prisma, ctx.scope, from, end, kind);
    // A mixed group's income and expense are translated to Rupiah, as on the page.
    const currency = scopeCurrency(entities);
    const body = await dimensionWorkbook(pl, { ...ctx.meta, currency }, from, end);
    const label = `Laba Rugi per ${DIMENSION_LABEL[kind]}`;
    await recordExport(prisma, { clientId: ctx.client.id, entityId: ctx.scope.entityIds.length === 1 ? ctx.scope.entityIds[0] : null, scope: ctx.title, year: ctx.period.year, month: ctx.period.month, file: kind === "PROYEK" ? "Laba Rugi per Proyek (Excel)" : "Laba Rugi per Departemen (Excel)", final: !ctx.meta.draft });
    return xlsxResponse(body, `${label} - ${ctx.title} - ${ctx.period.year}-${String(ctx.period.month).padStart(2, "0")}.xlsx`.replace(/[\\/:*?"<>|]/g, " "));
  } catch (e) {
    if (e instanceof FxMissingError) return new Response(e.message, { status: 400 });
    throw e;
  }
}
export const runtime = "nodejs";
