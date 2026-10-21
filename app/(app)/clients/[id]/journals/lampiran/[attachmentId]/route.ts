import { prisma } from "@/lib/db";
import { findClientForMember } from "@/lib/tenant";
import { attachmentFile } from "@/lib/ledger/attachments";

/**
 * GET — one lampiran jurnal (lib/ledger/attachments.ts) as a download, for a member who may open the client; any other id is 404. Always
 * an attachment with the type its bytes were checked to be, never rendered in the app's origin.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; attachmentId: string }> }) {
  const { id, attachmentId } = await params;
  const client = await findClientForMember(id);
  if (!client) return new Response("Klien tidak ditemukan", { status: 404 });
  const file = await attachmentFile(prisma, client.id, attachmentId);
  if (!file) return new Response("Lampiran tidak ditemukan", { status: 404 });
  const ascii = file.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export const runtime = "nodejs";
