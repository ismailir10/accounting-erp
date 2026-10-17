import { aiAccounts } from "@/lib/ai/classify";
import { createHash } from "node:crypto";
import { bankLineAccounts, citedBankIds } from "@/lib/controls/cited";
import type { Db } from "@/lib/db";
import { runControls } from "@/lib/controls";
import { bankLineState, gather, snapshotOf, CLOSE_REVIEW_TOKEN_LIMIT, type ReviewLink } from "@/lib/controls/ai-review";
import { formatPeriod, periodBounds } from "@/lib/format";
import { runBudgetedAi } from "@/lib/ai/budget";
import { AiAnswerError, amountOf, CONTROL_EXPLAIN_MAX_TOKENS, CONTROL_EXPLAIN_PROMPT_VERSION, buildControlExplainPrompt, parseControlExplain, type AiProvider, type ControlExplainAnswer, type ControlExplainInput } from "@/lib/ai/provider";
import { priorCorrection, saveProposal, type ProposalLine } from "@/lib/adjust/proposals";

/**
 * Close copilot — "Jelaskan" (ADR 0009, accounting-rules 20b). One flagged control, its own rows only, one budgeted and cached call.
 * The answer may carry a draft note (a prefill the accountant saves) and a grounded draft journal, stored as a ProposedEntry that
 * only the accountant's click posts. Nothing here posts, acknowledges, ticks or locks.
 */

export type ControlExplanation = { controlKey: string; explanation: string; suggestion: string; note: string; links: ReviewLink[]; proposal: { id: string; status: string } | null };

export class ExplainError extends Error {}

const scopeOf = (clientId: string, year: number, month: number) => `close:${clientId}:${year}-${String(month).padStart(2, "0")}`;

/** The dropped-citation count a cached *Jelaskan* answer stored, or null for an answer cached before it was counted. */
export function storedDropped(payload: unknown): number | null {
  const v = (payload as { dropped?: unknown } | null)?.dropped;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

export async function explainControl(db: Db, firmId: string, clientId: string, year: number, month: number, controlKey: string, provider: AiProvider): Promise<ControlExplanation> {
  if (!provider.explainControl) throw new ExplainError("Model AI ini belum mendukung penjelasan kontrol.");
  const control = (await runControls(db, clientId, year, month)).find((c) => c.key === controlKey);
  if (!control) throw new ExplainError("Kontrol tidak ditemukan untuk periode ini.");
  if (control.status === "PASS") throw new ExplainError("Kontrol ini sudah lolos; tidak ada yang perlu dijelaskan.");
  const g = await gather(db, clientId, year, month, [control]);
  const reviewed = g.input.controls[0];
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId }, include: { entities: true } });
  // Entity-scoped controls (`kind:<entityId>`) may get a draft journal for that entity; group-level ones get words only.
  const entity = client.entities.find((e) => e.id === controlKey.split(":")[1]) ?? null;
  // Prive (3300) is an owner's withdrawal from a sole proprietorship or a CV partner; a PT or foreign company's draft never uses it.
  const noPrive = entity !== null && (entity.kind === "PT" || entity.kind === "BADAN_USAHA_ASING");
  // Transfers are paired by the matcher or decided by the reviewer, never drafted by the model (accounting-rules 13): no 1190/1199.
  const accounts = aiAccounts(await db.account.findMany({ where: { clientId, isBank: false, ...(noPrive ? { fsLine: { not: "PRIVE" } } : {}) }, select: { code: true, name: true }, orderBy: { code: "asc" } }));
  const input: ControlExplainInput = { client: client.name, period: formatPeriod(year, month), currency: entity?.functionalCurrency ?? client.entities[0]?.functionalCurrency ?? "IDR", accounts, control: reviewed, canDraft: entity !== null, entities: g.input.entities };

  const key = createHash("sha256").update(JSON.stringify([firmId, clientId, input, provider.model, CONTROL_EXPLAIN_PROMPT_VERSION])).digest("hex");
  const scope = scopeOf(clientId, year, month);
  let answer: ControlExplainAnswer;
  const hit = await db.evidenceAiCache.findFirst({ where: { key, firmId, scope } });
  // A stored answer's refs are already filtered, so re-reading it can't recount its dropped citations: the stored count stands.
  if (hit) answer = { ...parseControlExplain(JSON.stringify(hit.payload), input), dropped: storedDropped(hit.payload) ?? 0 };
  else {
    const result = await runBudgetedAi(
      db,
      { firmId, scope, prompt: buildControlExplainPrompt(input), maxCompletionTokens: CONTROL_EXPLAIN_MAX_TOKENS, scopeTokenLimit: CLOSE_REVIEW_TOKEN_LIMIT, model: provider.model, keysRequested: 1, note: "Jelaskan kontrol" },
      async () => {
        const r = await provider.explainControl!(input);
        try {
          const checked = parseControlExplain(JSON.stringify(r), input);
          return { ...r, ...checked, dropped: (r.dropped ?? 0) + checked.dropped };
        } catch { throw new AiAnswerError("Penjelasan AI tidak valid; periksa kontrol secara manual.", r.promptTokens, r.completionTokens, r.model); }
      },
    );
    answer = { explanation: result.explanation, suggestion: result.suggestion, refs: result.refs, note: result.note, entry: result.entry, dropped: result.dropped };
    await db.evidenceAiCache.upsert({ where: { key }, create: { key, firmId, scope, payload: answer }, update: {} });
  }

  let proposal: ControlExplanation["proposal"] = null;
  let suggestion = answer.suggestion;
  if (answer.entry && entity) {
    const lines: ProposalLine[] = answer.entry.lines.map((l) => {
      const minor = amountOf(l.amount, input.currency)!.toString(); // grounded: parsed from a cited row's amount
      return { accountCode: l.accountCode, debit: l.side === "D" ? minor : "0", credit: l.side === "K" ? minor : "0" };
    });
    // Only the rows the answer cites can be the bank line it moves; two cited lines that both fit make the draft ambiguous.
    const bank = await reclassedBankLine(db, entity.id, answer.refs, answer.entry, input.currency);
    const line = bank && bank !== "AMBIGUOUS" ? await db.bankTransaction.findUnique({ where: { id: bank } }) : null;
    const twice = line ? await priorCorrection(db, line, periodBounds(year, month).end) : null;
    if (twice) suggestion = `${twice} Beri catatan pada kontrol ini; tidak perlu jurnal lagi.`;
    else if (bank !== "AMBIGUOUS") {
      const p = await saveProposal(db, { firmId, clientId, entityId: entity.id, year, month, source: "AI_CONTROL", controlKey, key: `AI:${key}`, memo: answer.entry.memo, lines, reason: answer.explanation, refs: answer.refs, bankTransactionId: bank, snapshot: snapshotOf(reviewed.rows, await bankLineState(db, bank)) });
      proposal = { id: p.id, status: p.status };
    }
  }
  return { controlKey, explanation: answer.explanation, suggestion, note: control.status === "REVIEW" ? answer.note : "", links: answer.refs.flatMap((r) => (g.links.has(r) ? [g.links.get(r)!] : [])), proposal };
}

/**
 * A two-line draft that takes a cited bank line off its current account (the reverse side, its full amount) and onto another
 * one is a re-classification of that line: it must post through the review writer, never as a free journal (rule 3).
 * A draft that touches a cited bank line's account any other way (split amounts, several lines, several bank lines) can't go
 * through that writer, so it gets no draft at all ("AMBIGUOUS") rather than a free journal that would leave the lines mis-coded.
 */
export async function reclassedBankLine(db: Db, entityId: string, citedIds: string[], entry: NonNullable<ControlExplainAnswer["entry"]>, currency: string): Promise<string | null | "AMBIGUOUS"> {
  if (citedIds.length === 0) return null;
  const txs = await db.bankTransaction.findMany({ where: { id: { in: await citedBankIds(db, entityId, citedIds) }, entityId, accountCode: { not: null } }, orderBy: { id: "asc" } });
  const offLine = (t: (typeof txs)[number]) => {
    const abs = t.amount < 0n ? -t.amount : t.amount;
    const reverse = t.amount > 0n ? "D" : "K"; // money in was credited to its account: moving it off debits that account
    return { abs, from: entry.lines.find((l) => l.accountCode === t.accountCode && l.side === reverse && amountOf(l.amount, currency) === abs) };
  };
  // Conservative: any line on a cited bank line's current account moves that line (in one piece or split), so only the one
  // shape the reviewer's writer can post — the full amount off, the same amount onto one other account — gets a draft.
  // Any account a bank line's postings use (its classification, a tax split, suspense) counts: moving any part moves the line.
  const parts = await bankLineAccounts(db, txs);
  const touched = txs.filter((t) => entry.lines.some((l) => parts.get(t.id)!.has(l.accountCode)));
  if (touched.length === 0) return null;
  const [t] = touched;
  const { abs, from } = offLine(t);
  const single = touched.length === 1 && entry.lines.length === 2 && !!from && entry.lines.some((l) => l !== from && !parts.get(t.id)!.has(l.accountCode) && amountOf(l.amount, currency) === abs);
  return single ? t.id : "AMBIGUOUS";
}
