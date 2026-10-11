import { isClassifiable } from "@/lib/coa/template";
import type { Db } from "@/lib/db";
import type { AiProvider } from "@/lib/ai/provider";
import { aiScope, suggestWithAi } from "@/lib/ai/classify";
import { demoteUnbacked, tradeBacking, type TradeBacking } from "@/lib/ai/unbacked";
import { isSimpleGuess } from "@/lib/classify/fallback";
import { isGenericKey } from "@/lib/import/normalize";
import type { Classification } from "@/lib/classify/types";

/**
 * Lines still in review that only got the simple guess (the AI call failed, was capped or off at import). Financing text and tax payments are
 * left out: their balance-sheet suggestion comes without an AI call (rule 13). Without `entityIds`/`through`: every entity of the client, any date.
 */
export async function simpleGuessRows(db: Db, args: { clientId: string; entityIds?: string[]; through?: Date }) {
  const rows = await db.bankTransaction.findMany({
    where: {
      ...(args.entityIds ? { entityId: { in: args.entityIds } } : {}),
      bankAccount: { entity: { clientId: args.clientId } },
      status: "NEEDS_REVIEW",
      method: "HEURISTIC",
      ...(args.through ? { date: { lte: args.through } } : {}),
    },
    orderBy: [{ date: "asc" }, { rowNumber: "asc" }],
  });
  // Lines that name no counterparty stay with the client question; a model can only guess them.
  return rows.filter((r) => isSimpleGuess(r) && !isGenericKey(r.merchantKey));
}

export type SimpleGuessRow = Awaited<ReturnType<typeof simpleGuessRows>>[number];
export const lineKey = (r: { merchantKey: string; direction: string }) => `${r.merchantKey}|${r.direction}`;

/**
 * Ask the AI about these simple-guess lines and replace their suggestion — the one implementation behind *Minta saran AI* and the
 * background run (lib/ai/run.ts). Cache, batches ≤ 15 unique keys, call cap, monthly budget and chart whitelist come from
 * `suggestWithAi` (rules 17–19); call it outside any transaction. Only lines still in review on a simple guess change; they stay on
 * 1999 until the accountant accepts (rule 14). Nothing is posted.
 */
export async function suggestForRows(
  db: Db,
  args: {
    clientId: string;
    rows: SimpleGuessRow[];
    provider: AiProvider | null;
    deadline?: number;
    maxCalls?: number;
    /** After every settled batch: how many of `rows` it settled and how many it updated (the background run's progress). */
    onProgress?: (p: { settledLines: number; updatedLines: number }) => Promise<void>;
  },
) {
  const { rows } = args;
  let updated = 0, calls = 0, cacheHits = 0, remaining = 0, stopped = false;
  const notes: string[] = [];
  /** Keys settled in this pass: answered (cache or model) or asked and left unanswered. */
  const settled = new Set<string>();
  const unansweredKeys: string[] = [];
  if (!rows.length) return { updated, calls, cacheHits, remaining, stopped, notes, settled, unansweredKeys };
  const client = await db.client.findUniqueOrThrow({ where: { id: args.clientId } });
  const accounts = (await db.account.findMany({ where: { clientId: client.id }, orderBy: { code: "asc" } })).filter(isClassifiable);
  const kinds = new Map((await db.entity.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.entityId))] } }, select: { id: true, kind: true } })).map((e) => [e.id, e.kind]));
  const backings = new Map<string, (asOf: Date) => TradeBacking>();
  const fsLineOf = (code: string) => accounts.find((a) => a.code === code)?.fsLine;
  // One pass per kind of books: a person's lines are asked about as a person's (lib/ai/classify.ts aiScope).
  for (const kind of new Set(rows.map((r) => kinds.get(r.entityId)!))) {
    const group = rows.filter((r) => kinds.get(r.entityId) === kind);
    const scope = aiScope(client, kind, accounts);
    // Applied as each batch settles, so Review fills in while the run works.
    const apply = async (b: { suggestions: Map<string, Classification>; unansweredKeys: string[] }) => {
      let updatedLines = 0;
      for (const r of group) {
        const found = b.suggestions.get(lineKey(r));
        if (!found) continue;
        // Same demotion as at import: a receivable/payable the entity's books don't hold (lib/ai/unbacked.ts).
        if (!backings.has(r.entityId)) backings.set(r.entityId, await tradeBacking(db, r.entityId));
        const s = demoteUnbacked(found, r.direction, fsLineOf, backings.get(r.entityId)!(r.date));
        // Only while it is still waiting: a line accepted meanwhile keeps the accountant's decision.
        const res = await db.bankTransaction.updateMany({
          where: { id: r.id, status: "NEEDS_REVIEW", method: "HEURISTIC" },
          data: { method: "AI", suggestedCode: s.accountCode, taxTag: s.taxTag, confidence: s.confidence, reason: s.reason },
        });
        updatedLines += res.count;
      }
      updated += updatedLines;
      const keys = new Set([...b.suggestions.keys(), ...b.unansweredKeys]);
      await args.onProgress?.({ settledLines: group.filter((r) => keys.has(lineKey(r))).length, updatedLines });
    };
    const ai = await suggestWithAi(db, {
      firmId: client.firmId,
      clientId: client.id,
      clientName: scope.clientName,
      coaVersion: client.coaVersion,
      accounts: scope.accounts,
      pending: group.map((r) => ({ key: r.merchantKey, direction: r.direction, sample: r.description })),
      provider: args.provider,
      deadline: args.deadline,
      maxCalls: args.maxCalls === undefined ? undefined : Math.max(0, args.maxCalls - calls),
      onBatch: apply,
    });
    calls += ai.usage.calls;
    cacheHits += ai.usage.cacheHits;
    remaining += ai.usage.remaining;
    if (ai.usage.note) notes.push(ai.usage.note);
    for (const k of ai.suggestions.keys()) settled.add(k);
    for (const k of ai.unansweredKeys) { settled.add(k); unansweredKeys.push(k); }
    if (ai.usage.stopped) { stopped = true; break; } // budget, cap or a stopping failure: no second pass (rules 17–18)
  }
  return { updated, calls, cacheHits, remaining, stopped, notes, settled, unansweredKeys };
}
