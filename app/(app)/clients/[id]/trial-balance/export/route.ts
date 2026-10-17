import { prisma } from "@/lib/db";
import { formatDateLong } from "@/lib/format";
import { ledgerExportContext, xlsxResponse } from "@/lib/reports/export-context";
import { FxMissingError } from "@/lib/reports/fx";
import { trialBalance, trialBalanceMovement } from "@/lib/reports/ledger";
import { ledgerFileName, trialBalanceWorkbook } from "@/lib/reports/ledger-workbook";

/**
 * GET ?entity&period&range=month|ytd — Neraca Saldo as Excel: saldo awal, mutasi, saldo akhir (a mixed-currency group: the closing,
 * translated to Rupiah, as on the page). A working paper: no export event.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await ledgerExportContext(req, (await params).id);
  if (!ctx) return new Response("Klien tidak ditemukan", { status: 404 });
  if (ctx.error) return new Response(ctx.error, { status: 400 });
  try {
    const rows = ctx.mixed ? await trialBalance(prisma, ctx.scope, ctx.end) : await trialBalanceMovement(prisma, ctx.scope, ctx.start, ctx.end);
    const body = await trialBalanceWorkbook(ctx.meta, ctx.mixed ? `Per ${formatDateLong(ctx.end)} · dijabarkan ke Rupiah` : ctx.subtitle, rows);
    return xlsxResponse(body, ledgerFileName("neraca-saldo", ctx.title, ctx.range, ctx.end));
  } catch (e) {
    if (e instanceof FxMissingError) return new Response(e.message, { status: 400 });
    throw e;
  }
}
export const runtime = "nodejs";
