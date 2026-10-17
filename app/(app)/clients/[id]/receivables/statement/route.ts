import { prisma } from "@/lib/db";
import { findClientForMember } from "@/lib/tenant";
import { parsePeriod } from "@/lib/scope";
import { toIsoDate } from "@/lib/format";
import { reminderItems } from "@/lib/receivables/reminder";
import { customerStatementPdf } from "@/lib/receivables/statement-pdf";

/**
 * GET ?entity=<id>&contact=<id>&period=YYYY-MM — Surat tagihan: one company's open sales invoices to one customer as a PDF, on the
 * reminder date (cycle 2026-10-17-pengingat-piutang). A read; the client's own document, so no export event (the firm board's *Terkirim*
 * counts the firm's reports).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const client = await findClientForMember((await params).id);
  if (!client) return new Response("Klien tidak ditemukan", { status: 404 });
  const url = new URL(req.url);
  const entity = client.entities.find((e) => e.id === url.searchParams.get("entity"));
  if (!entity) return new Response("Perusahaan tidak ditemukan", { status: 404 });
  const now = new Date();
  const period = parsePeriod(url.searchParams.get("period") ?? undefined, { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });
  const items = await reminderItems(prisma, client.id, entity.id, url.searchParams.get("contact") ?? "", period.end, now);
  if (!items) return new Response("Pelanggan tidak ditemukan", { status: 404 });
  const body = await customerStatementPdf({ company: { name: entity.name, npwp: entity.npwp }, customer: items.contact.name, asOf: items.asOf, currency: entity.functionalCurrency, open: items.open, advance: items.advance });
  const file = `surat-tagihan-${items.contact.name.replace(/[^\w-]+/g, "_")}-${toIsoDate(items.asOf)}.pdf`;
  return new Response(new Uint8Array(body), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${file}"`, "Cache-Control": "no-store" },
  });
}
export const runtime = "nodejs";
