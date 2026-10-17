import { prisma } from "@/lib/db";
import { exportContext } from "@/lib/reports/export-context";
import { recordFakturDownload } from "@/lib/reports/export-log";
import { packApplies } from "@/lib/tax/pack";
import { fakturKeluaranDraft, fakturKeluaranFiles } from "@/lib/tax/coretax-faktur";

/**
 * GET ?entity=<id>&period=YYYY-MM[&part=n] — the masa's *Siap* faktur keluaran as Coretax's XML import file, 1,000 per part (cycle
 * 2026-10-17-coretax-files). Same access as the Pajak Masa workbook; audited as FAKTUR, not as a report sent.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await exportContext(req, id);
  if (!ctx) return new Response("Klien tidak ditemukan", { status: 404 });
  const entity = ctx.scope.entityIds.length === 1 ? ctx.client.entities.find((e) => e.id === ctx.scope.entityIds[0]) : undefined;
  if (!entity || !packApplies(entity)) return new Response("Faktur keluaran dibuat untuk satu badan usaha dengan pembukuan Rupiah. Pilih perusahaannya.", { status: 400 });
  const { year, month } = ctx.period;
  const draft = await fakturKeluaranDraft(prisma, { clientId: ctx.client.id, entityId: entity.id, year, month });
  const files = fakturKeluaranFiles(draft);
  if (!files.length) return new Response(draft.companyReasons[0]?.text ?? "Belum ada faktur yang siap untuk Coretax di masa ini.", { status: 400 });
  const raw = new URL(req.url).searchParams.get("part");
  const part = raw === null ? 1 : /^\d+$/.test(raw) ? Number(raw) : 0;
  if (part < 1 || part > files.length) return new Response(`File ini terdiri dari ${files.length} bagian.`, { status: 404 });
  const file = files[part - 1];
  await recordFakturDownload(prisma, { clientId: ctx.client.id, entityId: entity.id, scope: entity.name, year, month, count: file.rows, part, parts: files.length });
  const masa = `${year}-${String(month).padStart(2, "0")}`;
  const name = `faktur-keluaran-${entity.shortName.replace(/[^\w-]+/g, "_")}-${masa}${files.length > 1 ? `-bagian-${part}` : ""}.xml`;
  return new Response(file.xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
export const runtime = "nodejs";
