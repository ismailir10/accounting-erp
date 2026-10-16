import { prisma } from "@/lib/db";
import { findClientForMember, getCurrentFirm } from "@/lib/tenant";
import { parsePeriod, resolveEntityScope } from "@/lib/scope";
import { reasonText, reportStatus } from "@/lib/reports/status";
import { parseRange, rangeBounds } from "@/lib/reports/general-ledger";
import { rangeLabel } from "@/lib/reports/ledger-workbook";
import { isMixed, scopeCurrency, scopeEntities } from "@/lib/reports/fx";

/**
 * What both statement downloads (Excel and PDF) need from `?entity=<id|combined>&period=YYYY-MM`: the client in the firm, the scope, the
 * period, the title, and why the statements are still a draft (absent once the month is closed). Null when the client isn't the firm's.
 */
export async function exportContext(req: Request, clientId: string) {
  const client = await findClientForMember(clientId);
  if (!client) return null;
  const url = new URL(req.url);
  const scope = resolveEntityScope(url.searchParams.get("entity") ?? undefined, client.entities);
  const now = new Date();
  const period = parsePeriod(url.searchParams.get("period") ?? undefined, { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });
  const title = scope.mode === "combined" ? `${client.name} (gabungan)` : client.entities.find((e) => e.id === scope.value)!.name;
  const firm = await getCurrentFirm();
  const status = await reportStatus(prisma, client.id, scope.entityIds, period.year, period.month);
  const draft = status.locked ? undefined : status.reasons.length ? `belum final: ${status.reasons.map(reasonText).join("; ")}; bulan belum ditutup.` : "bulan belum ditutup.";
  return { client, scope: { clientId: client.id, entityIds: scope.entityIds }, period, title, meta: { firm: firm.name, title, draft } };
}

/**
 * The ledger downloads (Jurnal Umum, Buku Besar, Neraca Saldo): the statements' context plus `?range=month|ytd` and its dates. Their
 * Excel writes Rupiah, so a single-currency scope in another currency gets `error` rather than a file in the wrong unit.
 */
export async function ledgerExportContext(req: Request, clientId: string) {
  const ctx = await exportContext(req, clientId);
  if (!ctx) return null;
  const range = parseRange(new URL(req.url).searchParams.get("range"));
  const bounds = await rangeBounds(prisma, ctx.client.id, range, ctx.period);
  const entities = await scopeEntities(prisma, ctx.scope.entityIds);
  const mixed = isMixed(entities);
  // A mixed group is translated to Rupiah where a report can be (Neraca Saldo); journals and ledger lines can't be, so those refuse it.
  const error = !mixed && scopeCurrency(entities) !== "IDR" ? "Unduhan Excel buku besar baru untuk pembukuan dalam Rupiah." : null;
  return { ...ctx, range, ...bounds, subtitle: rangeLabel(range, bounds.start, bounds.end), mixed, error };
}

export const MIXED_EXPORT_ERROR = "Pembukuan grup ini memakai mata uang yang berbeda. Pilih satu perusahaan untuk mengunduh.";

export const xlsxResponse = (body: Buffer, fileName: string) =>
  new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
