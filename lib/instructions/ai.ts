import { createHash } from "node:crypto";
import type { Db } from "@/lib/db";
import { aiAccounts } from "@/lib/ai/classify";
import { AiBudgetError, runBudgetedAi } from "@/lib/ai/budget";
import type { AiProvider } from "@/lib/ai/provider";
import { MAX_SENTENCE, NOT_UNDERSTOOD, parseInstruction, REFUSAL, toJson, type DraftJson, type InstructionDraft } from "@/lib/instructions/compile";
import { AI_NONE, buildInstructionPrompt, INSTRUCTION_MAX_TOKENS, INSTRUCTION_PROMPT_VERSION, readInstructionAnswer, type InstructionAiInput } from "@/lib/instructions/ai-prompt";
import { aiScope, scopeCharts, type InstructionScope } from "@/lib/instructions/store";

/**
 * *Susun dengan AI* (accounting-rules 20e, cycle 2026-10-18-instruksi-kantor): called only from the editor on the accountant's click, never
 * from an import, a control or the preview. Only for a sentence Buku's reader did not understand (an explicit refusal stays a refusal).
 * One budgeted call (`runBudgetedAi`, scope `instruksi:<firm>`), cached by the sentence, the account list, the model and the prompt
 * version, never retried. The answer is a draft; nothing is stored but the cache.
 */
export type AiCompiled = { ok: true; draft: InstructionDraft } | { ok: false; error: string };
/** What the cache keeps per answer: the sentence (the origin check finds it by it) and the draft, or why the answer was not used. */
type Cached = { sentence: string; draft: DraftJson | null; error: string | null };

export const AI_UNAVAILABLE = "AI belum aktif untuk kantor ini. Tulis dengan salah satu pola di bawah.";
export const AI_NOT_NEEDED = "Buku sudah bisa menyusun kalimat ini tanpa AI. Klik Susun.";
export const AI_FAILED = "AI tidak dapat dihubungi. Coba lagi nanti, atau tulis dengan salah satu pola di bawah.";

export const instructionAiKey = (firmId: string, input: InstructionAiInput, model: string) => createHash("sha256").update(JSON.stringify([firmId, input, model, INSTRUCTION_PROMPT_VERSION])).digest("hex");

export async function compileWithAi(db: Db, input: InstructionScope & { sentence: string; provider: AiProvider | null }): Promise<AiCompiled> {
  const sentence = input.sentence.trim();
  if (!sentence) return { ok: false, error: REFUSAL.empty };
  if (sentence.length > MAX_SENTENCE) return { ok: false, error: REFUSAL.long };
  if (!input.provider?.compileInstruction) return { ok: false, error: AI_UNAVAILABLE };
  const scope = await scopeCharts(db, input);
  const own = parseInstruction(sentence, scope.accounts);
  if (own.ok) return { ok: false, error: AI_NOT_NEEDED };
  if (own.refused || own.error !== NOT_UNDERSTOOD) return { ok: false, error: own.error };

  // The accounts a rule may target, by code and name only; never 1190/1199 (transfers are paired by Buku, rule 13).
  const ai: InstructionAiInput = { sentence, accounts: aiAccounts(scope.accounts.filter((a) => a.classifiable && !a.transfer)).map((a) => ({ code: a.code, name: a.name })) };
  const key = instructionAiKey(input.firmId, ai, input.provider.model);
  const hit = await db.evidenceAiCache.findFirst({ where: { key, firmId: input.firmId, scope: aiScope(input.firmId) } });
  let cached: Cached;
  if (hit) cached = hit.payload as Cached;
  else {
    let text: string;
    try {
      const provider = input.provider;
      text = (
        await runBudgetedAi(
          db,
          { firmId: input.firmId, scope: aiScope(input.firmId), prompt: buildInstructionPrompt(ai), maxCompletionTokens: INSTRUCTION_MAX_TOKENS, model: provider.model, keysRequested: 1, note: "Instruksi kantor" },
          () => provider.compileInstruction!(ai),
        )
      ).text;
    } catch (e) {
      if (e instanceof AiBudgetError) return { ok: false, error: e.message };
      console.error(e);
      return { ok: false, error: AI_FAILED };
    }
    const read = readInstructionAnswer(text, ai, scope.accounts);
    cached = { sentence, draft: read.ok ? toJson(read.draft) : null, error: read.ok ? null : read.error };
    await db.evidenceAiCache.upsert({ where: { key }, create: { key, firmId: input.firmId, scope: aiScope(input.firmId), payload: cached }, update: {} });
  }
  if (!cached.draft) return { ok: false, error: cached.error ?? AI_NONE };
  // Checked again: the charts may have changed since the answer was cached.
  const again = readInstructionAnswer(JSON.stringify(cached.draft), ai, scope.accounts);
  return again.ok ? { ok: true, draft: again.draft } : { ok: false, error: again.error };
}

