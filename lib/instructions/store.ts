import type { Db, Tx } from "@/lib/db";
import type { Instruction, InstructionOrigin } from "@/lib/generated/prisma/client";
import { recordEvent } from "@/lib/audit";
import {
  draftSummary,
  duplicateMessage,
  MAX_SENTENCE,
  parseInstruction,
  REFUSAL,
  sameDraft,
  scopeAccount,
  toJson,
  validateDraft,
  type DraftField,
  type InstructionDraft,
  type InstructionKind,
  type ScopeAccount,
} from "@/lib/instructions/compile";

/**
 * Instruksi kantor in the database (cycle 2026-10-18-instruksi-kantor): the scope an instruction reaches, approval and *Matikan* under the
 * firm's row lock with one Riwayat event per client, and the active instructions run time reads. Who may do it is the caller's check
 * (app/instruction-actions.ts): `org.settings` for *Semua klien*, `books.write` on the client for one client.
 */
export class InstructionError extends Error {}

/** The prompt's cache scope for *Susun dengan AI* (lib/instructions/ai.ts); the origin check reads it. */
export const aiScope = (firmId: string) => `instruksi:${firmId}`;

export type InstructionScope = { firmId: string; clientId: string | null };
export type ScopeCharts = { clients: { id: string; name: string }[]; codes: Map<string, Set<string>>; accounts: ScopeAccount[] };

/** The clients an instruction of this scope reaches (one, or every client of the firm), their charts, and the union of their accounts. */
export async function scopeCharts(db: Db | Tx, scope: InstructionScope): Promise<ScopeCharts> {
  const clients = await db.client.findMany({ where: { firmId: scope.firmId, ...(scope.clientId ? { id: scope.clientId } : {}) }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  if (scope.clientId && !clients.length) throw new InstructionError("Klien tidak ditemukan.");
  const rows = await db.account.findMany({ where: { clientId: { in: clients.map((c) => c.id) }, archivedAt: null }, select: { clientId: true, code: true, name: true, type: true, fsLine: true, isBank: true, isSuspense: true, isRetained: true, isClearing: true, isIntercompany: true }, orderBy: { code: "asc" } });
  const codes = new Map(clients.map((c) => [c.id, new Set<string>()]));
  const accounts = new Map<string, ScopeAccount>();
  const order = new Map(clients.map((c, i) => [c.id, i]));
  for (const a of rows.sort((x, y) => order.get(x.clientId)! - order.get(y.clientId)! || x.code.localeCompare(y.code))) {
    codes.get(a.clientId)!.add(a.code);
    if (!accounts.has(a.code)) accounts.set(a.code, scopeAccount(a));
  }
  return { clients, codes, accounts: [...accounts.values()].sort((a, b) => a.code.localeCompare(b.code)) };
}

/** A stored instruction's compiled fields. */
export const draftOf = (i: Pick<Instruction, "kind" | "pattern" | "direction" | "accountCode" | "taxTag" | "minAmount" | "inclusive">): InstructionDraft => ({
  kind: i.kind as InstructionKind,
  pattern: i.pattern,
  direction: i.direction,
  accountCode: i.accountCode,
  taxTag: i.taxTag,
  minAmount: i.minAmount,
  inclusive: i.inclusive,
});

/**
 * The active instruction this draft would repeat or contradict in its scope: the same instruction again, or an *Aturan akun* on the same
 * keyword and direction (whatever its account or tax tag: two rules on one text would race).
 */
export async function activeConflict(db: Db | Tx, scope: InstructionScope, d: InstructionDraft): Promise<Pick<Instruction, "id" | "sentence"> | null> {
  const active = await db.instruction.findMany({ where: { firmId: scope.firmId, clientId: scope.clientId, status: "ACTIVE", kind: d.kind }, orderBy: { approvedAt: "asc" } });
  return active.find((i) => sameDraft(draftOf(i), d) || (d.kind === "ACCOUNT" && i.pattern === d.pattern && i.direction === d.direction)) ?? null;
}

/** The AI's cached drafts for this sentence (any model or chart), as *Susun dengan AI* stored them. */
export async function cachedAiDrafts(db: Db | Tx, firmId: string, sentence: string): Promise<unknown[]> {
  const rows = await db.evidenceAiCache.findMany({ where: { firmId, scope: aiScope(firmId), payload: { path: ["sentence"], equals: sentence } }, select: { payload: true } });
  return rows.map((r) => (r.payload as { draft?: unknown }).draft);
}

/** What Riwayat keeps of an instruction: the sentence, kind, compiled fields (amounts as strings), scope, origin and status. */
const snapshot = (i: Instruction) => ({ sentence: i.sentence, ...toJson(draftOf(i)), scope: i.clientId ? "client" : "Semua klien", clientId: i.clientId, origin: i.origin, status: i.status });

type Refused = { ok: false; error: string; field?: DraftField };

/**
 * *Setujui*: validates the approved fields against the scope's charts (the closed schema), decides the origin on the server — the reader's
 * own result for this sentence, else a cached AI answer for it, else a person's edit — and, under the firm's row lock, refuses a duplicate,
 * stores the instruction (an *Aturan akun* also its Rule, priority 5, source INSTRUKSI) and writes one INSTRUCTION event per client.
 */
export async function approveInstruction(
  db: Db,
  input: InstructionScope & { sentence: string; fields: unknown; actorId?: string | null },
): Promise<{ ok: true; id: string; origin: InstructionOrigin } | Refused> {
  const sentence = input.sentence.trim();
  if (!sentence) return { ok: false, error: REFUSAL.empty };
  if (sentence.length > MAX_SENTENCE) return { ok: false, error: REFUSAL.long };
  const scope = await scopeCharts(db, input);
  const v = validateDraft(input.fields, scope.accounts);
  if (!v.ok) return { ok: false, error: v.error, ...(v.field ? { field: v.field } : {}) };
  const d = v.draft;
  const parsed = parseInstruction(sentence, scope.accounts);
  const fromAi = async () => (await cachedAiDrafts(db, input.firmId, sentence)).some((raw) => {
    const a = validateDraft(raw, scope.accounts);
    return a.ok && sameDraft(a.draft, d);
  });
  const origin: InstructionOrigin = parsed.ok && sameDraft(parsed.draft, d) ? "PARSER" : (await fromAi()) ? "AI" : "EDITED";

  return db.$transaction(async (tx) => {
    // Two approvals at once: the second sees the first's instruction as a duplicate.
    await tx.$queryRaw`SELECT id FROM "Firm" WHERE id = ${input.firmId} FOR UPDATE`;
    const conflict = await activeConflict(tx, input, d);
    if (conflict) return { ok: false as const, error: duplicateMessage(conflict.sentence) };
    const row = await tx.instruction.create({
      data: { firmId: input.firmId, clientId: input.clientId, sentence, kind: d.kind, origin, pattern: d.pattern, direction: d.direction, accountCode: d.accountCode, taxTag: d.taxTag, minAmount: d.minAmount, inclusive: d.inclusive, approvedById: input.actorId ?? null },
    });
    if (d.kind === "ACCOUNT") {
      await tx.rule.create({ data: { firmId: input.firmId, clientId: input.clientId, pattern: d.pattern!, direction: d.direction, accountCode: d.accountCode!, taxTag: d.taxTag, priority: INSTRUCTION_PRIORITY, source: "INSTRUKSI", instructionId: row.id } });
    }
    for (const c of scope.clients) {
      await recordEvent(tx, { clientId: c.id, kind: "INSTRUCTION", subject: `instruction:${row.id}`, summary: `Disetujui: "${sentence}" → ${draftSummary(d)}`, before: { status: null }, after: snapshot(row), actorId: input.actorId });
    }
    return { ok: true as const, id: row.id, origin };
  });
}

/** Before every seeded firm rule (10–50) and every Review-made client rule (60): the firm's word beats Buku's starter list. */
export const INSTRUCTION_PRIORITY = 5;

/**
 * *Matikan*: the instruction stays as Dimatikan for history; an *Aturan akun*'s Rule is deleted in the same transaction; a *Tandai* control
 * and a *Tahan* stop for what comes next. No posted line, Review line or note changes. One INSTRUCTION event per client it reached.
 */
export async function turnOffInstruction(db: Db, input: { firmId: string; id: string; actorId?: string | null }): Promise<{ ok: true } | Refused> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Firm" WHERE id = ${input.firmId} FOR UPDATE`;
    const before = await tx.instruction.findFirst({ where: { id: input.id, firmId: input.firmId } });
    if (!before) return { ok: false as const, error: "Instruksi tidak ditemukan." };
    if (before.status === "OFF") return { ok: false as const, error: "Instruksi ini sudah dimatikan." };
    const after = await tx.instruction.update({ where: { id: before.id }, data: { status: "OFF", offAt: new Date(), offById: input.actorId ?? null } });
    await tx.rule.deleteMany({ where: { instructionId: before.id } });
    const clients = await tx.client.findMany({ where: { firmId: input.firmId, ...(before.clientId ? { id: before.clientId } : {}) }, select: { id: true } });
    for (const c of clients) {
      await recordEvent(tx, { clientId: c.id, kind: "INSTRUCTION", subject: `instruction:${before.id}`, summary: `Dimatikan: "${before.sentence}"`, before: snapshot(before), after: snapshot(after), actorId: input.actorId });
    }
    return { ok: true as const };
  });
}

/** The firm's instructions a member may see: *Semua klien* ones and those of the clients they may open. Active first, newest first. */
export async function listInstructions(db: Db, firmId: string, clientIds: "ALL" | string[]) {
  const rows = await db.instruction.findMany({
    where: { firmId, ...(clientIds === "ALL" ? {} : { OR: [{ clientId: null }, { clientId: { in: clientIds } }] }) },
    include: { client: { select: { name: true } }, approvedBy: { select: { name: true } }, offBy: { select: { name: true } } },
    orderBy: [{ status: "asc" }, { approvedAt: "desc" }],
  });
  return rows;
}

/** The active instructions of a kind that reach a client: its own and the firm's *Semua klien* ones. What run time reads. */
export function activeInstructions(db: Db | Tx, firmId: string, clientId: string, kind: InstructionKind) {
  return db.instruction.findMany({ where: { firmId, status: "ACTIVE", kind, OR: [{ clientId: null }, { clientId }] }, orderBy: { approvedAt: "asc" } });
}
