import type { Db, Tx } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";

/**
 * Riwayat perubahan (ADR 0013): who changed what in a client's books or decisions, written in the same transaction as the change.
 * Append-only (a DB trigger refuses updates). Amounts in `before` / `after` are strings (bigint stays exact through JSON).
 */
export type AuditKind = "CLASSIFY" | "UNPAIR" | "IMPORT_REMOVED" | "CONTROL_NOTE" | "MAPPING" | "FINDING_RESOLVED" | "REPORT_FORMAT" | "FISCAL_YEAR" | "SUBLEDGER" | "DOCUMENT_VOID" | "ADVANCE" | "REPORT_EXPORT" | "MODULES" | "UPLOAD_LINK" | "REPORT_COMMENT" | "FAKTUR" | "BUKTI_POTONG" | "PPH25" | "HISTORY_CLOSE" | "COMPANY_BANK" | "ACCOUNT" | "CREDIT_LIMIT" | "CHECKLIST";

export const AUDIT_KIND_LABEL: Record<AuditKind, string> = {
  CLASSIFY: "Klasifikasi mutasi",
  UNPAIR: "Pasangan transfer dilepas",
  IMPORT_REMOVED: "Impor dihapus",
  CONTROL_NOTE: "Catatan kontrol",
  MAPPING: "Pemetaan akun sumber",
  FINDING_RESOLVED: "Temuan diselesaikan",
  REPORT_FORMAT: "Format laporan",
  FISCAL_YEAR: "Tahun buku",
  SUBLEDGER: "Rekonsiliasi subledger",
  DOCUMENT_VOID: "Dokumen dikeluarkan",
  ADVANCE: "Uang muka ditandai",
  REPORT_EXPORT: "Laporan diunduh",
  MODULES: "Modul klien",
  UPLOAD_LINK: "Tautan unggah klien",
  REPORT_COMMENT: "Catatan laporan",
  FAKTUR: "Faktur Coretax",
  BUKTI_POTONG: "Bukti potong Coretax",
  PPH25: "Angsuran PPh 25",
  HISTORY_CLOSE: "Tutup buku bersama",
  COMPANY_BANK: "Perusahaan & rekening",
  ACCOUNT: "Bagan akun",
  CREDIT_LIMIT: "Batas kredit",
  CHECKLIST: "Checklist tutup buku",
};

export async function recordEvent(
  tx: Tx | Db,
  e: { clientId: string; entityId?: string | null; kind: AuditKind; subject: string; summary: string; before?: Prisma.InputJsonValue; after?: Prisma.InputJsonValue; actorId?: string | null },
) {
  const { firmId } = await tx.client.findUniqueOrThrow({ where: { id: e.clientId }, select: { firmId: true } });
  return tx.auditEvent.create({
    data: { firmId, clientId: e.clientId, entityId: e.entityId ?? null, kind: e.kind, subject: e.subject, summary: e.summary, before: e.before, after: e.after, actorId: e.actorId ?? null },
  });
}

export type AuditView = { id: string; kind: AuditKind; label: string; subject: string; summary: string; actor: string; at: Date; before: unknown; after: unknown };

/** Newest first; optionally one kind or one subject (a bank line's own history). */
export async function listEvents(db: Db, clientId: string, filter: { kind?: AuditKind; subject?: string; take?: number } = {}): Promise<AuditView[]> {
  const rows = await db.auditEvent.findMany({
    where: { clientId, ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.subject ? { subject: filter.subject } : {}) },
    include: { actor: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: filter.take ?? 200,
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as AuditKind,
    label: AUDIT_KIND_LABEL[r.kind as AuditKind] ?? r.kind,
    subject: r.subject,
    summary: r.summary,
    actor: r.actor?.name ?? "Sistem",
    at: r.createdAt,
    before: r.before,
    after: r.after,
  }));
}
