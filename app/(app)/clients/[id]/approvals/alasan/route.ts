import { prisma } from "@/lib/db";
import { findClientForMember } from "@/lib/tenant";
import { ReasoningError, reasoningCsv, reasoningFor } from "@/lib/approvals/reasoning";

/**
 * GET ?item=<bank line or draft id, or accrual key> — *Unduh nilai (CSV)* of a *Lihat alasan* panel: the values sent to the AI, returned and checked (an accrual: the history rows and the rule), as a
 * semicolon CSV for Excel id-ID. A working file for anyone who may read the books (not a REPORT_EXPORT); reads only. An item of another
 * client, or one without AI reasoning, is 404.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await findClientForMember(id);
  if (!client) return new Response("Klien tidak ditemukan", { status: 404 });
  const item = new URL(req.url).searchParams.get("item") ?? "";
  try {
    const facts = await reasoningFor(prisma, { firmId: client.firmId, clientId: client.id }, item);
    return new Response(reasoningCsv(facts), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="alasan-${facts.kind === "bank" ? "mutasi" : facts.kind === "draft" ? "draf" : "akrual"}-${item.replace(/[^\w-]+/g, "")}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof ReasoningError) return new Response(e.message, { status: 404 });
    throw e;
  }
}
export const runtime = "nodejs";
