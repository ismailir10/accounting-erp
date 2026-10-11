import type { Db } from "@/lib/db";
import type { UploadItem } from "@/lib/generated/prisma/client";

type Linked = Pick<UploadItem, "status" | "message" | "statementImportIds" | "ledgerImportId">;
export type LiveImports = { statements: ReadonlySet<string>; ledgers: ReadonlyMap<string, "DRAFT" | "POSTED"> };

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
  const [statements, ledgers] = await Promise.all([
    statementIds.length ? db.statementImport.findMany({ where: { firmId, id: { in: statementIds } }, select: { id: true } }) : [],
    ledgerIds.length ? db.ledgerImport.findMany({ where: { firmId, id: { in: ledgerIds } }, select: { id: true, status: true } }) : [],
  ]);
  return { statements: new Set(statements.map((s) => s.id)), ledgers: new Map(ledgers.map((l) => [l.id, l.status])) };
}

/** The rows with their live outcome. */
export async function withLiveOutcome<T extends Linked>(db: Db, firmId: string, rows: T[]): Promise<T[]> {
  const live = await liveImports(db, firmId, rows);
  return rows.map((r) => liveOutcome(r, live));
}
