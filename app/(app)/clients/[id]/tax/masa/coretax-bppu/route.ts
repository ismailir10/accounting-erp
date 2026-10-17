import { prisma } from "@/lib/db";
import { exportContext } from "@/lib/reports/export-context";
import { recordBupotDownload } from "@/lib/reports/export-log";
import { packApplies } from "@/lib/tax/pack";
import { bppuDraft, bppuFile } from "@/lib/tax/coretax-bppu";

/**
 * GET ?entity=<id>&period=YYYY-MM — the masa's *Siap* bukti potong Unifikasi as Coretax's BPPU XML import file (cycle
 * 2026-10-17-bppu-files). Same access as the Pajak Masa workbook; audited as BUKTI_POTONG, not as a report sent.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await exportContext(req, id);
  if (!ctx) return new Response("Klien tidak ditemukan", { status: 404 });
  const entity = ctx.scope.entityIds.length === 1 ? ctx.client.entities.find((e) => e.id === ctx.scope.entityIds[0]) : undefined;
  if (!entity || !packApplies(entity)) return new Response("Bukti potong dibuat untuk satu badan usaha dengan pembukuan Rupiah. Pilih perusahaannya.", { status: 400 });
  const { year, month } = ctx.period;
  const draft = await bppuDraft(prisma, { clientId: ctx.client.id, entityId: entity.id, year, month });
  const file = bppuFile(draft);
  if (!file) return new Response(draft.companyReasons[0]?.text ?? "Belum ada bukti potong yang siap untuk Coretax di masa ini.", { status: 400 });
  await recordBupotDownload(prisma, { clientId: ctx.client.id, entityId: entity.id, scope: entity.name, year, month, count: file.rows });
  const masa = `${year}-${String(month).padStart(2, "0")}`;
  return new Response(file.xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="bppu-${entity.shortName.replace(/[^\w-]+/g, "_")}-${masa}.xml"`,
      "Cache-Control": "no-store",
    },
  });
}
export const runtime = "nodejs";
