import { createHash } from "node:crypto";
import type { Db } from "@/lib/db";
import type { Direction, EntityKind } from "@/lib/generated/prisma/enums";
import { AI_BATCH_SIZE, AI_TIMEOUT_MS, AiTruncatedError, CLASSIFICATION_PROMPT_VERSION, DEMO_AI_MODEL, aiConfig, buildPrompt, maxTokensFor, type AiItem, type AiProvider } from "@/lib/ai/provider";
import { AiBudgetError, runBudgetedAi } from "@/lib/ai/budget";
import type { Classification } from "@/lib/classify/types";
import { ACCOUNT_CODES } from "@/lib/coa/template";

/** Transfers are paired by the matcher or decided by the reviewer, never guessed (use-case feedback UC-B2): 1199 and 1190 never reach the model. */
const NOT_FOR_AI = new Set<string>([ACCOUNT_CODES.CLEARING, ACCOUNT_CODES.INTERCOMPANY]);
export const aiAccounts = <T extends { code: string }>(accounts: T[]) => accounts.filter((a) => !NOT_FOR_AI.has(a.code));

/**
 * A person's own bank lines (the owner beside the PT) are not a business: no trade receivables or payables, no sales or service income,
 * no cost of sales or selling expenses (left with those, the model files a personal transfer as "bayar supplier barang dagang").
 */
const NOT_FOR_PERSON = new Set<string>(["PIUTANG_USAHA", "UTANG_USAHA", "PENDAPATAN_USAHA", "HPP", "BEBAN_PENJUALAN"]);

/** What the model is told about the books a line belongs to, and the accounts it may answer with (rule 19 still drops anything else). */
export function aiScope(client: { name: string; industry: string | null }, kind: EntityKind, accounts: { code: string; name: string; fsLine: string }[]) {
  const person = kind === "PERORANGAN";
  const base = `${client.name} (${client.industry ?? "umum"})`;
  return {
    clientName: person ? `${base}; mutasi ini dari rekening pribadi pemilik (perorangan, bukan badan usaha)` : base,
    accounts: accounts.filter((a) => !person || !NOT_FOR_PERSON.has(a.fsLine)).map((a) => ({ code: a.code, name: a.name })),
  };
}

export type ClassificationCacheContext = { firmId: string; clientId: string; model: string; clientName: string; accounts: { code: string; name: string }[]; sample: string };
export function aiCacheKey(merchantKey: string, direction: Direction, coaVersion: number, scope: ClassificationCacheContext) {
  const prompt = buildPrompt([{ key: merchantKey, direction, sample: scope.sample }], aiAccounts([...scope.accounts]).sort((a, b) => a.code.localeCompare(b.code)), scope.clientName);
  return createHash("sha256").update(JSON.stringify([scope.firmId, scope.clientId, coaVersion, scope.model, CLASSIFICATION_PROMPT_VERSION, prompt])).digest("hex");
}

type Pending = { key: string; direction: Direction; sample: string };

/** What the accountant reads when a classification call fails (Bahasa; the raw provider text is kept short). */
export function aiFailureNote(e: unknown): string {
  const err = e as Error;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return `AI tidak menjawab dalam ${Math.round(AI_TIMEOUT_MS / 1000)} detik, jadi transaksinya memakai tebakan sederhana. Minta saran AI lagi dari halaman Review.`;
  }
  return `AI gagal: ${String(err?.message ?? e).slice(0, 120)}`;
}

/** The provider refused the key or the model (wrong key, no access, model on another endpoint): every later call would fail the same way. */
const isConfigFailure = (e: unknown) => {
  const msg = String((e as Error)?.message ?? "");
  return /^AI 40[13]\b/.test(msg) || msg.includes("tidak tersedia lewat /chat/completions");
};
const isTimeout = (e: unknown) => (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";

export type AiRunUsage = {
  calls: number;
  cacheHits: number;
  note?: string;
  /** Unique keys never asked: the run stopped first (call cap, deadline, budget or a stopping failure). */
  remaining: number;
  /** Unique keys asked that came back without a usable suggestion (cut off, failed call, or no answer for that key). */
  unanswered: number;
  /** The run ended early (call cap, budget, refused key/model, two timeouts): a later pass would only repeat it. */
  stopped: boolean;
};

/**
 * Resolve leftovers via cache first, then (budget permitting) the provider in batches of ≤ AI_BATCH_SIZE unique keys,
 * one call at a time, at most AI_MAX_CALLS_PER_RUN calls. Returns suggestions keyed by `${merchantKey}|${direction}`.
 * Never throws on AI failure — failures just leave items for the heuristic fallback:
 * - a cut-off batch is asked once more as two halves (rule 18's only repeat); a cut-off half keeps its simple guesses;
 * - another failed batch keeps its simple guesses and the run moves on;
 * - the budget refusal, a refused key/model, or two timeouts in a row stop the run with a note;
 * - no call starts after `deadline` (epoch ms): the caller resumes later with what is left (`remaining`);
 * - `maxCalls` (default AI_MAX_CALLS_PER_RUN) lets a background run spread one cap over several slices (lib/ai/run.ts).
 * `unansweredKeys` names the keys asked that came back without a usable suggestion, so a resumed run doesn't ask them again.
 */
export async function suggestWithAi(
  tx: Db,
  args: {
    firmId: string;
    clientId: string;
    clientName: string;
    coaVersion: number;
    accounts: { code: string; name: string }[];
    pending: Pending[];
    provider: AiProvider | null;
    deadline?: number;
    maxCalls?: number;
    /** Called as answers settle — once for cached answers, then after every batch — so a caller can apply them and show progress. */
    onBatch?: (settled: { suggestions: Map<string, Classification>; unansweredKeys: string[] }) => Promise<void>;
  },
): Promise<{ suggestions: Map<string, Classification>; usage: AiRunUsage; unansweredKeys: string[] }> {
  args = { ...args, accounts: aiAccounts(args.accounts) };
  const suggestions = new Map<string, Classification>();
  const unique = new Map<string, Pending>();
  for (const p of args.pending) unique.set(`${p.key}|${p.direction}`, p);

  const keyOf = (p: Pending, model = args.provider?.model ?? "disabled") => aiCacheKey(p.key, p.direction, args.coaVersion, { ...args, model, sample: p.sample });
  const keys = [...unique.values()].flatMap(p => [keyOf(p), keyOf(p, DEMO_AI_MODEL)]);
  const cached = await tx.aiSuggestion.findMany({ where: { cacheKey: { in: keys } } });
  const byCache = new Map(cached.map((c) => [c.cacheKey, c]));
  const misses: Pending[] = [];
  for (const [k, p] of unique) {
    const primary = byCache.get(keyOf(p));
    const synthetic = byCache.get(keyOf(p, DEMO_AI_MODEL));
    const hit = primary ?? (synthetic?.model === DEMO_AI_MODEL ? synthetic : undefined);
    if (hit && args.accounts.some((a) => a.code === hit.accountCode)) suggestions.set(k, { method: "AI", accountCode: hit.accountCode, taxTag: hit.taxTag, confidence: hit.confidence, reason: `AI: ${hit.reason}` });
    else misses.push(p);
  }
  const cacheHits = suggestions.size;
  if (cacheHits && args.onBatch) await args.onBatch({ suggestions: new Map(suggestions), unansweredKeys: [] });
  if (misses.length === 0 || !args.provider) {
    return { suggestions, usage: { calls: 0, cacheHits, note: !args.provider && misses.length ? "AI tidak aktif" : undefined, remaining: misses.length, unanswered: 0, stopped: !args.provider && misses.length > 0 }, unansweredKeys: [] };
  }

  const maxCalls = args.maxCalls ?? aiConfig().maxCallsPerRun;
  const queue: { items: Pending[]; half: boolean }[] = [];
  for (let i = 0; i < misses.length; i += AI_BATCH_SIZE) queue.push({ items: misses.slice(i, i + AI_BATCH_SIZE), half: false });

  let calls = 0;
  let asked = 0; // unique keys whose (last) call is done, answered or not
  let truncated = 0; // of those, keys left on simple guesses because the answer was cut off
  const unansweredKeys: string[] = [];
  let timeoutsInRow = 0;
  let stopNote: string | undefined;
  let failureNote: string | undefined;
  let capped = false;
  while (queue.length) {
    if (calls >= maxCalls) { capped = true; break; }
    if (args.deadline !== undefined && Date.now() >= args.deadline) break;
    const { items, half } = queue[0];
    const batch: AiItem[] = items.map((p) => ({ key: p.key, direction: p.direction, sample: p.sample }));
    let answered: { suggestions: Map<string, Classification>; unansweredKeys: string[] } | null = null;
    try {
      const res = await runBudgetedAi(tx, { firmId: args.firmId, scope: `classify:${args.clientId}`, prompt: buildPrompt(batch, args.accounts, args.clientName), maxCompletionTokens: maxTokensFor(batch.length), model: args.provider.model, keysRequested: batch.length, cacheHits }, () => {
        calls++;
        return args.provider!.classify(batch, args.accounts, args.clientName);
      });
      queue.shift();
      timeoutsInRow = 0;
      asked += items.length;
      for (const a of res.answers) {
        const p = items.find((b) => b.key === a.key);
        if (!p || !args.accounts.some((account) => account.code === a.accountCode)) continue;
        await tx.aiSuggestion.upsert({
          where: { cacheKey: keyOf(p) },
          create: { cacheKey: keyOf(p), merchantKey: a.key, direction: p.direction, accountCode: a.accountCode, confidence: a.confidence, taxTag: a.taxTag, reason: a.reason, model: res.model },
          update: {},
        });
        suggestions.set(`${a.key}|${p.direction}`, { method: "AI", accountCode: a.accountCode, taxTag: a.taxTag, confidence: a.confidence, reason: `AI: ${a.reason}` });
      }
      const got = new Map<string, Classification>();
      const missed: string[] = [];
      for (const p of items) {
        const k = `${p.key}|${p.direction}`;
        const s = suggestions.get(k);
        if (s) got.set(k, s);
        else missed.push(k);
      }
      unansweredKeys.push(...missed);
      answered = { suggestions: got, unansweredKeys: missed };
    } catch (e) {
      if (e instanceof AiBudgetError) { stopNote = e.message; break; } // refused before any call: the batch stays unasked
      queue.shift();
      if (e instanceof AiTruncatedError && items.length > 1 && !half) {
        // The one bounded repeat (rule 18): the same keys as two halves, each counted in the cap.
        const mid = Math.floor(items.length / 2);
        queue.unshift({ items: items.slice(0, mid), half: true }, { items: items.slice(mid), half: true });
        timeoutsInRow = 0;
        continue;
      }
      asked += items.length;
      const missed = items.map((p) => `${p.key}|${p.direction}`);
      unansweredKeys.push(...missed);
      await args.onBatch?.({ suggestions: new Map(), unansweredKeys: missed });
      if (e instanceof AiTruncatedError) { truncated += items.length; timeoutsInRow = 0; continue; }
      if (isConfigFailure(e)) { stopNote = aiFailureNote(e); break; }
      if (isTimeout(e)) {
        if (++timeoutsInRow >= 2) { stopNote = aiFailureNote(e); break; }
      } else timeoutsInRow = 0;
      failureNote = aiFailureNote(e); // this batch keeps its simple guesses; the run moves on
    }
    // Outside the try: a failure while the caller applies answers is not the AI's failure.
    if (answered) await args.onBatch?.(answered);
  }
  const note = stopNote
    ?? (capped ? "Batas panggilan AI per proses tercapai." : undefined)
    ?? failureNote
    ?? (truncated ? `${truncated} lawan transaksi tetap tebakan sederhana: jawaban AI terpotong.` : undefined);
  return { suggestions, usage: { calls, cacheHits, note, remaining: misses.length - asked, unanswered: unansweredKeys.length, stopped: !!stopNote || capped }, unansweredKeys };
}
