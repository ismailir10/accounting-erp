"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCapability } from "@/lib/auth/session";
import { infraErrorMessage } from "@/lib/db-errors";
import { saveAutomation, type AutomationErrors, type AutomationInput } from "@/lib/settings/automation";
import { saveApprovals, type ApprovalsErrors, type ApprovalsInput } from "@/lib/settings/approvals";

/**
 * Settings an organisation's own admins save (Pengaturan kantor → Umum), guarded by `org.settings` (Pemilik, Admin): refused for
 * Akuntan and Peninjau, while the organisation is read-only, and in a support session. Kept apart from app/settings-actions.ts,
 * whose settings are Buku's (Buku admins only).
 */
type Result<F = AutomationErrors> = { ok: true; changed: boolean } | { ok: false; error: string; fields?: F };

/** Otomasi kantor (cycle 2026-10-17-otomasi): the automation dial and flux thresholds, with one Riwayat event per client. */
export async function saveAutomationAction(input: AutomationInput): Promise<Result> {
  let session;
  try {
    session = await requireCapability("org.settings");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Masuk terlebih dahulu." };
  }
  try {
    // A crafted call may send anything: only booleans switch, only strings are read as amounts.
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    const settings: AutomationInput = { transfer: input?.transfer === true, rules: input?.rules === true, memory: input?.memory === true, cap: text(input?.cap), fluxFloor: text(input?.fluxFloor), fluxPercent: text(input?.fluxPercent) };
    const r = await saveAutomation(prisma, { firmId: session.firm.id, settings, actorId: session.member.id });
    if (!r.ok) return { ok: false, error: "Periksa isian yang ditandai. Tidak ada yang disimpan.", fields: r.errors };
    if (r.changed) revalidatePath("/", "layout");
    return { ok: true, changed: r.changed };
  } catch (e) {
    console.error(e);
    return { ok: false, error: infraErrorMessage(e) ?? "Terjadi kesalahan tak terduga. Coba lagi." };
  }
}

/** Persetujuan kedua (cycle 2026-10-18-persetujuan-kedua): which journals and reopenings need a second member, one Riwayat event per client. */
export async function saveApprovalsAction(input: ApprovalsInput): Promise<Result<ApprovalsErrors>> {
  let session;
  try {
    session = await requireCapability("org.settings");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Masuk terlebih dahulu." };
  }
  try {
    // A crafted call may send anything: only booleans switch, only strings are read as amounts.
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    const settings: ApprovalsInput = { manual: input?.manual === true, manualAbove: text(input?.manualAbove), aiDraft: input?.aiDraft === true, aiDraftAbove: text(input?.aiDraftAbove), reopen: input?.reopen === true };
    const r = await saveApprovals(prisma, { firmId: session.firm.id, settings, actorId: session.member.id });
    if (!r.ok) return { ok: false, error: "Periksa isian yang ditandai. Tidak ada yang disimpan.", fields: r.errors };
    if (r.changed) revalidatePath("/", "layout");
    return { ok: true, changed: r.changed };
  } catch (e) {
    console.error(e);
    return { ok: false, error: infraErrorMessage(e) ?? "Terjadi kesalahan tak terduga. Coba lagi." };
  }
}
