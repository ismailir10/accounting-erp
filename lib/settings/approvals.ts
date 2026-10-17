import type { Db, Tx } from "@/lib/db";
import { recordEvent } from "@/lib/audit";
import { formatRupiah } from "@/lib/money";
import { AMOUNT_MESSAGE, rupiahThreshold } from "@/lib/settings/automation";

/**
 * Persetujuan kedua (cycle 2026-10-18-persetujuan-kedua): per firm, which journals wait for a second member before they post (manual
 * journals and AI drafts, each above an optional whole-Rupiah threshold) and whether reopening a month needs a second admin. Stored on
 * `Firm`; the defaults are the behaviour before the card existed (nothing routed). Saved by admins only (`org.settings`,
 * app/firm-settings-actions.ts); every change is one APPROVAL event in each client's Riwayat perubahan.
 */
export type SecondApproval = {
  manual: boolean;
  /** Whole Rupiah; null = every journal of the source. Kept only while the switch is on. */
  manualAbove: bigint | null;
  aiDraft: boolean;
  aiDraftAbove: bigint | null;
  reopen: boolean;
};

export const DEFAULT_APPROVALS: SecondApproval = { manual: false, manualAbove: null, aiDraft: false, aiDraftAbove: null, reopen: false };

export const APPROVAL_SELECT = { approvalManual: true, approvalManualAbove: true, approvalAiDraft: true, approvalAiDraftAbove: true, approvalReopen: true } as const;
type Row = { approvalManual: boolean; approvalManualAbove: bigint | null; approvalAiDraft: boolean; approvalAiDraftAbove: bigint | null; approvalReopen: boolean };

export const approvalsOf = (f: Row): SecondApproval => ({
  manual: f.approvalManual,
  manualAbove: f.approvalManualAbove,
  aiDraft: f.approvalAiDraft,
  aiDraftAbove: f.approvalAiDraftAbove,
  reopen: f.approvalReopen,
});

export async function readApprovals(db: Db | Tx, firmId: string): Promise<SecondApproval> {
  return approvalsOf(await db.firm.findUniqueOrThrow({ where: { id: firmId }, select: APPROVAL_SELECT }));
}

/** What the form sends: switches as booleans, thresholds as typed. */
export type ApprovalsInput = { manual: boolean; manualAbove: string; aiDraft: boolean; aiDraftAbove: string; reopen: boolean };
export type ApprovalsField = "manualAbove" | "aiDraftAbove";
export type ApprovalsErrors = Partial<Record<ApprovalsField, string>>;

/** A switched-off source keeps no threshold (its input is ignored); a switched-on one reads it as Otomasi reads its cap. */
export function parseApprovals(input: ApprovalsInput): { ok: true; value: SecondApproval } | { ok: false; errors: ApprovalsErrors } {
  const errors: ApprovalsErrors = {};
  const manual = input.manual === true;
  const aiDraft = input.aiDraft === true;
  const manualAbove = manual ? rupiahThreshold(input.manualAbove) : null;
  if (manualAbove === undefined) errors.manualAbove = AMOUNT_MESSAGE;
  const aiDraftAbove = aiDraft ? rupiahThreshold(input.aiDraftAbove) : null;
  if (aiDraftAbove === undefined) errors.aiDraftAbove = AMOUNT_MESSAGE;
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { manual, manualAbove: manualAbove!, aiDraft, aiDraftAbove: aiDraftAbove!, reopen: input.reopen === true } };
}

/** "tanpa persetujuan", "semua nominal" or "di atas Rp 100.000.000". */
export const routeText = (on: boolean, above: bigint | null) => (!on ? "tanpa persetujuan" : above === null ? "semua nominal" : `di atas ${formatRupiah(above)}`);
const reopenText = (on: boolean) => (on ? "dikonfirmasi admin kedua" : "langsung oleh admin");

/** One part per setting that differs, in the card's order: "Jurnal manual: tanpa persetujuan → di atas Rp 100.000.000". */
export function describeApprovalChanges(before: SecondApproval, after: SecondApproval): string[] {
  const out: string[] = [];
  const manual = [routeText(before.manual, before.manualAbove), routeText(after.manual, after.manualAbove)];
  if (manual[0] !== manual[1]) out.push(`Jurnal manual: ${manual[0]} → ${manual[1]}`);
  const ai = [routeText(before.aiDraft, before.aiDraftAbove), routeText(after.aiDraft, after.aiDraftAbove)];
  if (ai[0] !== ai[1]) out.push(`Draf AI: ${ai[0]} → ${ai[1]}`);
  if (before.reopen !== after.reopen) out.push(`Buka kembali bulan: ${reopenText(before.reopen)} → ${reopenText(after.reopen)}`);
  return out;
}

/** Amounts as strings: bigint stays exact through JSON (lib/audit.ts). */
const snapshot = (a: SecondApproval) => ({ ...a, manualAbove: a.manualAbove?.toString() ?? null, aiDraftAbove: a.aiDraftAbove?.toString() ?? null });

/**
 * Validates and saves the card. A save that changes something writes, in the same transaction, one APPROVAL event with before and after
 * into every client's Riwayat perubahan; a save that changes nothing writes nothing. Applies to new journals and requests only: nothing
 * posted is pulled back, and nothing waiting is posted (it is still decided in Kotak persetujuan).
 */
export async function saveApprovals(
  db: Db,
  input: { firmId: string; settings: ApprovalsInput; actorId?: string | null },
): Promise<{ ok: true; changed: boolean } | { ok: false; errors: ApprovalsErrors }> {
  const parsed = parseApprovals(input.settings);
  if (!parsed.ok) return parsed;
  const after = parsed.value;
  return db.$transaction(async (tx) => {
    // Two admins saving at once: the second reads the first's result as its "before".
    await tx.$queryRaw`SELECT id FROM "Firm" WHERE id = ${input.firmId} FOR UPDATE`;
    const before = await readApprovals(tx, input.firmId);
    const changes = describeApprovalChanges(before, after);
    if (!changes.length) return { ok: true as const, changed: false };
    await tx.firm.update({
      where: { id: input.firmId },
      data: { approvalManual: after.manual, approvalManualAbove: after.manualAbove, approvalAiDraft: after.aiDraft, approvalAiDraftAbove: after.aiDraftAbove, approvalReopen: after.reopen },
    });
    const clients = await tx.client.findMany({ where: { firmId: input.firmId }, select: { id: true } });
    for (const c of clients) {
      await recordEvent(tx, { clientId: c.id, kind: "APPROVAL", subject: `firm:${input.firmId}`, summary: changes.join("; "), before: snapshot(before), after: snapshot(after), actorId: input.actorId });
    }
    return { ok: true as const, changed: true };
  });
}

/** The card's "Terakhir diubah …": the newest card save (an APPROVAL event on the firm's subject) of any of the firm's clients. */
export async function lastApprovalsChange(db: Db, firmId: string): Promise<{ at: Date; actor: string } | null> {
  const e = await db.auditEvent.findFirst({
    where: { clientId: { in: (await db.client.findMany({ where: { firmId }, select: { id: true } })).map((c) => c.id) }, kind: "APPROVAL", subject: `firm:${firmId}` },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, actor: { select: { name: true } } },
  });
  return e && { at: e.createdAt, actor: e.actor?.name ?? "Sistem" };
}

/** Active Pemilik and Admin members: with one, admin journals and reopening run without a second person (the card warns). */
export const activeAdminCount = (db: Db | Tx, firmId: string) => db.firmMember.count({ where: { firmId, disabled: false, role: { in: ["OWNER", "ADMIN"] } } });
