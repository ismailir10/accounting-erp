"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCapability } from "@/lib/auth/session";
import { infraErrorMessage } from "@/lib/db-errors";
import { resolveProvider } from "@/lib/settings/ai";
import { parseInstruction, validateDraft, type DraftField, type DraftJson, type InstructionDraft } from "@/lib/instructions/compile";
import { previewInstruction, type InstructionPreview } from "@/lib/instructions/preview";
import { approveInstruction, InstructionError, scopeCharts, turnOffInstruction } from "@/lib/instructions/store";
import { compileWithAi } from "@/lib/instructions/ai";

/**
 * Instruksi kantor (cycle 2026-10-18-instruksi-kantor): Pengaturan kantor → Instruksi. Every action is guarded by the scope it acts on,
 * with the unchanged permission matrix: *Semua klien* needs `org.settings` (Pemilik, Admin); one client needs `books.write` on that client
 * (Pemilik, Admin, an Akuntan assigned to it — an unassigned client reads as missing). Read-only organisations and support sessions are
 * refused by the guard. *Susun* and the preview are reads; *Susun dengan AI* spends the firm's budget, so it needs the same right as
 * approving. Nothing is stored until *Setujui*.
 */
export type ScopeAccountOption = { code: string; name: string; group: string };
export type CompileResult =
  | { ok: true; origin: "PARSER" | "AI"; preview: InstructionPreview; accounts: ScopeAccountOption[] }
  | { ok: false; error: string; field?: DraftField; /** Not an explicit refusal: *Susun dengan AI* may be offered. */ askAi?: boolean };
type Done = { ok: true } | { ok: false; error: string; field?: DraftField };

const GROUP = { ASET: "Aset", LIABILITAS: "Liabilitas", EKUITAS: "Ekuitas", PENDAPATAN: "Pendapatan", BEBAN: "Beban" } as const;
const text = (v: unknown) => (typeof v === "string" ? v : "");
/** A crafted call may send anything: a client id is a non-empty string, anything else is *Semua klien*. */
const scopeOf = (v: unknown) => (typeof v === "string" && v ? v : null);

async function guard(clientId: string | null) {
  return clientId === null ? requireCapability("org.settings") : requireCapability("books.write", { clientId });
}

/** Runs `fn` behind the scope's guard; a refusal or an infrastructure failure comes back as `{ ok: false, error }`. */
async function guarded<T>(clientId: string | null, fn: (s: Awaited<ReturnType<typeof guard>>) => Promise<T>): Promise<T | { ok: false; error: string }> {
  let session;
  try {
    session = await guard(clientId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Masuk terlebih dahulu." };
  }
  try {
    return await fn(session);
  } catch (e) {
    if (e instanceof InstructionError) return { ok: false, error: e.message };
    console.error(e);
    return { ok: false, error: infraErrorMessage(e) ?? "Terjadi kesalahan tak terduga. Coba lagi." };
  }
}

async function previewFor(firmId: string, clientId: string | null, draft: InstructionDraft, notes: string[], origin: "PARSER" | "AI"): Promise<CompileResult> {
  const scope = await scopeCharts(prisma, { firmId, clientId });
  const preview = await previewInstruction(prisma, { firmId, clientId, draft, notes });
  const accounts = scope.accounts.filter((a) => a.classifiable && !a.transfer).map((a) => ({ code: a.code, name: a.name, group: GROUP[a.type] }));
  return { ok: true, origin, preview, accounts };
}

/** *Susun*: Buku's own reader, then the preview. A refusal says why; "not understood" may offer *Susun dengan AI*. */
export async function compileInstructionAction(input: { sentence: string; clientId: string | null }): Promise<CompileResult> {
  const clientId = scopeOf(input?.clientId);
  return guarded(clientId, async (s) => {
    const scope = await scopeCharts(prisma, { firmId: s.firm.id, clientId });
    const r = parseInstruction(text(input?.sentence), scope.accounts);
    if (!r.ok) return { ok: false, error: r.error, ...(r.field ? { field: r.field } : {}), askAi: !r.refused };
    return previewFor(s.firm.id, clientId, r.draft, r.notes, "PARSER");
  });
}

/** The preview of the fields as edited (or a keyword hint taken); field messages for what the closed schema refuses. */
export async function previewInstructionAction(input: { clientId: string | null; fields: DraftJson; origin: "PARSER" | "AI" }): Promise<CompileResult> {
  const clientId = scopeOf(input?.clientId);
  return guarded(clientId, async (s) => {
    const scope = await scopeCharts(prisma, { firmId: s.firm.id, clientId });
    const v = validateDraft(input?.fields, scope.accounts);
    if (!v.ok) return { ok: false, error: v.error, ...(v.field ? { field: v.field } : {}) };
    return previewFor(s.firm.id, clientId, v.draft, [], input?.origin === "AI" ? "AI" : "PARSER");
  });
}

/** *Susun dengan AI*: one budgeted, cached call for a sentence the reader did not understand; a draft marked *Disusun AI*. */
export async function aiCompileInstructionAction(input: { sentence: string; clientId: string | null }): Promise<CompileResult> {
  const clientId = scopeOf(input?.clientId);
  return guarded(clientId, async (s) => {
    const r = await compileWithAi(prisma, { firmId: s.firm.id, clientId, sentence: text(input?.sentence), provider: await resolveProvider(prisma) });
    if (!r.ok) return { ok: false, error: r.error };
    return previewFor(s.firm.id, clientId, r.draft, [], "AI");
  });
}

/** *Setujui*: the server validates the fields again, decides the origin and stores the instruction with its events. */
export async function approveInstructionAction(input: { sentence: string; clientId: string | null; fields: DraftJson }): Promise<Done> {
  const clientId = scopeOf(input?.clientId);
  const r = await guarded(clientId, (s) => approveInstruction(prisma, { firmId: s.firm.id, clientId, sentence: text(input?.sentence), fields: input?.fields, actorId: s.member.id }));
  if (!r.ok) return r;
  revalidatePath("/", "layout");
  return { ok: true };
}

/** *Matikan*: guarded by the instruction's own scope (an Akuntan may turn off its clients' instructions, never a *Semua klien* one). */
export async function turnOffInstructionAction(input: { id: string }): Promise<Done> {
  let scope: { firmId: string; clientId: string | null } | null;
  try {
    const session = await requireCapability("books.read");
    scope = await prisma.instruction.findFirst({ where: { id: text(input?.id), firmId: session.firm.id }, select: { firmId: true, clientId: true } });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Masuk terlebih dahulu." };
  }
  if (!scope) return { ok: false, error: "Instruksi tidak ditemukan." };
  const r = await guarded(scope.clientId, (s) => turnOffInstruction(prisma, { firmId: s.firm.id, id: text(input?.id), actorId: s.member.id }));
  if (!r.ok) return r;
  revalidatePath("/", "layout");
  return { ok: true };
}
