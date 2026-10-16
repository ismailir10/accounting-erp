import { prisma } from "@/lib/db";
import { ledgerExportContext, MIXED_EXPORT_ERROR, xlsxResponse } from "@/lib/reports/export-context";
import { generalLedger } from "@/lib/reports/general-ledger";
import { ledgerFileName, ledgerWorkbook } from "@/lib/reports/ledger-workbook";

/** GET ?entity&period&range=month|ytd[&account=<code>] — Buku Besar as Excel: every account, or one. A working paper: no export event. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await ledgerExportContext(req, (await params).id);
  if (!ctx) return new Response("Klien tidak ditemukan", { status: 404 });
  if (ctx.mixed || ctx.error) return new Response(ctx.mixed ? MIXED_EXPORT_ERROR : ctx.error, { status: 400 });
  const code = new URL(req.url).searchParams.get("account") ?? undefined;
  const accounts = await generalLedger(prisma, ctx.scope, ctx.start, ctx.end, { accountCode: code });
  const body = await ledgerWorkbook(ctx.meta, ctx.subtitle, accounts);
  return xlsxResponse(body, ledgerFileName("buku-besar", code ? `${ctx.title}-${code}` : ctx.title, ctx.range, ctx.end));
}
export const runtime = "nodejs";
