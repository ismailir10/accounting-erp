import type { Db } from "@/lib/db";
import type { UploadItem } from "@/lib/generated/prisma/client";

type Linked = Pick<UploadItem, "status" | "message" | "statementImportIds" | "ledgerImportId"> & { evidenceVersionId?: string | null };
type Sheet = { id: string; sheet: string; status: "DRAFT" | "POSTED" };
/** `sheets`: every ledger import still there of a stored file with several sheets, by its evidence version (the item holds only the first). */
export type LiveImports = { statements: ReadonlySet<string>; ledgers: ReadonlyMap<string, "DRAFT" | "POSTED">; sheets?: ReadonlyMap<string, readonly Sheet[]> };

export const STATEMENTS_REMOVED = "Impor mutasinya sudah dihapus; file tetap di Dokumen.";
export const DRAFT_DISCARDED = "Draf buku besarnya sudah dihapus; file tetap di Dokumen.";
export const LEDGER_POSTED = "Buku besar dibukukan.";

/**
 * An item's outcome as the books stand now, not as it was written when the file was processed: the import lifecycle (post a ledger
 * draft, discard it, remove a statement import) never writes `UploadItem`, so its status is read against the imports that still exist.
 * A statement whose every import was removed, or a draft that was discarded, is a kept document again; a posted draft is booked.
 */
export function liveOutcome<T extends Linked>(row: T, live: LiveImports): T {
  if (row.status === "BOOKED" && row.statementImportIds.length && !row.statementImportIds.some((id) => live.statements.has(id))) {
    return { ...row, status: "KEPT", message: STATEMENTS_REMOVED, statementImportIds: [] };
  }
  if (row.status === "DRAFT" && row.ledgerImportId) {
    // A workbook staged as one draft per sheet is done only when every sheet is; while one is left, the line points at it (also when
    // the first sheet was the one discarded).
    const sheets = row.evidenceVersionId ? live.sheets?.get(row.evidenceVersionId) : undefined;
    if (sheets?.length) {
      const open = sheets.filter((s) => s.status === "DRAFT");
      if (!open.length) return { ...row, status: "BOOKED", message: LEDGER_POSTED };
      if (open.length === sheets.length && open.some((s) => s.id === row.ledgerImportId)) return row;
      return { ...row, ledgerImportId: open[0].id, message: `${open.length} draf buku besar belum dicatat: ${open.map((s) => s.sheet).join(", ")}.` };
    }
    const state = live.ledgers.get(row.ledgerImportId);
    if (!state) return { ...row, status: "KEPT", message: DRAFT_DISCARDED, ledgerImportId: null };
    if (state === "POSTED") return { ...row, status: "BOOKED", message: LEDGER_POSTED };
  }
  return row;
}

/** The imports the given items link to that still exist (one query each), for `liveOutcome`. */
export async function liveImports(db: Db, firmId: string, rows: readonly Linked[]): Promise<LiveImports> {
  const statementIds = [...new Set(rows.filter((r) => r.status === "BOOKED").flatMap((r) => r.statementImportIds))];
  const ledgerIds = [...new Set(rows.flatMap((r) => (r.status === "DRAFT" && r.ledgerImportId ? [r.ledgerImportId] : [])))];
  const versionIds = [...new Set(rows.flatMap((r) => (r.status === "DRAFT" && r.ledgerImportId && r.evidenceVersionId ? [r.evidenceVersionId] : [])))];
  const [statements, ledgers, ofVersions] = await Promise.all([
    statementIds.length ? db.statementImport.findMany({ where: { firmId, id: { in: statementIds } }, select: { id: true } }) : [],
    ledgerIds.length ? db.ledgerImport.findMany({ where: { firmId, id: { in: ledgerIds } }, select: { id: true, status: true } }) : [],
    versionIds.length ? db.ledgerImport.findMany({ where: { firmId, evidenceVersionId: { in: versionIds } }, orderBy: { createdAt: "asc" }, select: { id: true, status: true, sheetName: true, evidenceVersionId: true } }) : [],
  ]);
  const sheets = new Map<string, Sheet[]>();
  for (const l of ofVersions) sheets.set(l.evidenceVersionId!, [...(sheets.get(l.evidenceVersionId!) ?? []), { id: l.id, sheet: l.sheetName, status: l.status }]);
  return { statements: new Set(statements.map((s) => s.id)), ledgers: new Map(ledgers.map((l) => [l.id, l.status])), sheets };
}

/** The rows with their live outcome. */
export async function withLiveOutcome<T extends Linked>(db: Db, firmId: string, rows: T[]): Promise<T[]> {
  const live = await liveImports(db, firmId, rows);
  return rows.map((r) => liveOutcome(r, live));
}
