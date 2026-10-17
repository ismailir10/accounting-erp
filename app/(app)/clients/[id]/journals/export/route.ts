import { prisma } from "@/lib/db";
import { ledgerExportContext, MIXED_EXPORT_ERROR, xlsxResponse } from "@/lib/reports/export-context";
import { journalRegister, parseKindFilter, parseSearch } from "@/lib/reports/journal-register";
import { journalWorkbook, ledgerFileName } from "@/lib/reports/ledger-workbook";

/** GET ?entity&period&range=month|ytd&jenis&q — Jurnal Umum as Excel, the page's filter without paging. A working paper: no export event. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await ledgerExportContext(req, (await params).id);
  if (!ctx) return new Response("Klien tidak ditemukan", { status: 404 });
  if (ctx.mixed || ctx.error) return new Response(ctx.mixed ? MIXED_EXPORT_ERROR : ctx.error, { status: 400 });
  const sp = new URL(req.url).searchParams;
  const kind = parseKindFilter(sp.get("jenis"));
  const search = parseSearch(sp.get("q") ?? undefined, "IDR");
  const reg = await journalRegister(prisma, ctx.scope, { start: ctx.start, end: ctx.end, kinds: kind.kinds, search }, "all");
  const filters = [kind.kinds ? kind.label : null, search ? `pencarian “${search.text}”` : null].filter(Boolean).join(" · ");
  const body = await journalWorkbook(ctx.meta, `${ctx.subtitle}${filters ? ` · ${filters}` : ""}`, reg.entries);
  return xlsxResponse(body, ledgerFileName("jurnal-umum", ctx.title, ctx.range, ctx.end));
}
export const runtime = "nodejs";
