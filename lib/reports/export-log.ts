import type { Db } from "@/lib/db";
import { recordEvent } from "@/lib/audit";
import { getWorkspaceSession } from "@/lib/auth/session";
import { logSupportView } from "@/lib/auth/support";
import { formatPeriod } from "@/lib/format";

/**
 * One download's line in the history. Logging never blocks the download: a failure is reported to the server log only. A Buku admin's
 * download in a support session goes to Buku's support log instead, never to the organisation's Riwayat (ADR 0017 §2).
 */
async function logDownload(db: Db, clientId: string, summary: string, write: (actorId: string | null) => Promise<unknown>) {
  try {
    const session = await getWorkspaceSession();
    if (session?.support) return await logSupportView(db, session.support.id, `${clientId} · ${summary}`, "EXPORT");
    await write(session?.member?.id ?? null);
  } catch (err) {
    console.error("recordExport", err);
  }
}

/**
 * A report that left Buku (ADR 0014: the close is measured to the first report sent after the lock). One `REPORT_EXPORT` event per
 * download, subject `period:YYYY-MM`.
 */
export async function recordExport(
  db: Db,
  e: { clientId: string; entityId?: string | null; scope: string; year: number; month: number; file: "Laporan keuangan (Excel)" | "Laporan keuangan (PDF)" | "Kertas kerja PPh Badan" | "Paket kredit bank" | "Laporan manajemen" | "Kertas kerja pajak masa" | "Laba Rugi per Departemen (Excel)" | "Laba Rugi per Proyek (Excel)"; final: boolean },
) {
  const summary = `${e.file} · ${e.scope} · ${formatPeriod(e.year, e.month)} · ${e.final ? "final" : "draf"}`;
  await logDownload(db, e.clientId, summary, (actorId) =>
    recordEvent(db, {
      clientId: e.clientId,
      entityId: e.entityId ?? null,
      kind: "REPORT_EXPORT",
      subject: `period:${e.year}-${String(e.month).padStart(2, "0")}`,
      summary,
      after: { file: e.file, scope: e.scope, final: e.final },
      actorId,
    }),
  );
}

/**
 * The Coretax faktur keluaran XML (cycle 2026-10-17-coretax-files): a `FAKTUR` event, never `REPORT_EXPORT` — a file prepared for the
 * firm to upload is not a report sent to the client, so the firm board's *Terkirim* stays as it was.
 */
export async function recordFakturDownload(db: Db, e: { clientId: string; entityId: string; scope: string; year: number; month: number; count: number; part: number; parts: number }) {
  const summary = `XML faktur keluaran ${e.scope} masa ${formatPeriod(e.year, e.month)} diunduh: ${e.count} faktur${e.parts > 1 ? ` (bagian ${e.part} dari ${e.parts})` : ""}`;
  await logDownload(db, e.clientId, summary, (actorId) =>
    recordEvent(db, {
      clientId: e.clientId,
      entityId: e.entityId,
      kind: "FAKTUR",
      subject: `coretax:${e.entityId}:${e.year}-${String(e.month).padStart(2, "0")}`,
      summary,
      after: { count: e.count, part: e.part, parts: e.parts },
      actorId,
    }),
  );
}

/** The Coretax BPPU XML (cycle 2026-10-17-bppu-files): a `BUKTI_POTONG` event, never `REPORT_EXPORT` (*Terkirim* stays as it was). */
export async function recordBupotDownload(db: Db, e: { clientId: string; entityId: string; scope: string; year: number; month: number; count: number }) {
  const summary = `XML bukti potong ${e.scope} masa ${formatPeriod(e.year, e.month)} diunduh: ${e.count} bukti potong`;
  await logDownload(db, e.clientId, summary, (actorId) =>
    recordEvent(db, {
      clientId: e.clientId,
      entityId: e.entityId,
      kind: "BUKTI_POTONG",
      subject: `coretax-bppu:${e.entityId}:${e.year}-${String(e.month).padStart(2, "0")}`,
      summary,
      after: { count: e.count },
      actorId,
    }),
  );
}
