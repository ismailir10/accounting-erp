import type { Db } from "@/lib/db";
import type { Direction } from "@/lib/generated/prisma/enums";
import type { Prisma } from "@/lib/generated/prisma/client";
import { sortRules, winningRule, type RuleLike } from "@/lib/classify/rules";
import { AUTO_POST_CONFIDENCE } from "@/lib/classify/types";
import { formatPeriod, periodBounds } from "@/lib/format";
import { compiledSentence, duplicateMessage, keywordHints, toJson, type DraftJson, type InstructionDraft } from "@/lib/instructions/compile";
import { activeConflict, INSTRUCTION_PRIORITY, scopeCharts, type InstructionScope } from "@/lib/instructions/store";
import { matchesLine } from "@/lib/instructions/match";

/**
 * The approval screen's evidence (cycle 2026-10-18-instruksi-kantor): what an instruction would have done to each client's latest three
 * months with bank lines. A read: nothing is stored, no model is called. The matcher is the run-time one — `winningRule` for an *Aturan
 * akun*, `matchesLine` for *Tandai* and *Tahan*.
 */
export type PreviewLine = { id: string; date: string; client: string; description: string; amount: string; account: string | null; method: string; status: string };
export type InstructionPreview = {
  sentence: string;
  draft: DraftJson;
  notes: string[];
  hints: string[];
  clients: { id: string; name: string; months: { label: string; count: number }[]; total: number }[];
  matched: number;
  lines: PreviewLine[];
  /** A duplicate or conflicting active instruction: *Setujui* stays off. */
  blocked: string | null;
};

const MONTHS_SHOWN = 3;
const LINES_SHOWN = 20;
const HINTS_SHOWN = 3;
const METHOD_WORD: Record<string, string> = { TRANSFER: "transfer", RULE: "aturan", MEMORY: "pilihan yang diingat", AI: "usulan AI", HEURISTIC: "tebakan", MANUAL: "dipilih reviewer" };

/** Per client, its latest three months that have bank lines (a lagging client still shows examples). */
async function latestMonths(db: Db, clientIds: string[]): Promise<Map<string, { year: number; month: number }[]>> {
  const rows = clientIds.length
    ? await db.$queryRaw<{ clientId: string; y: number; m: number }[]>`
        SELECT "clientId", y, m FROM (
          SELECT e."clientId", EXTRACT(YEAR FROM t."date")::int AS y, EXTRACT(MONTH FROM t."date")::int AS m,
                 row_number() OVER (PARTITION BY e."clientId" ORDER BY EXTRACT(YEAR FROM t."date") DESC, EXTRACT(MONTH FROM t."date") DESC) AS r
          FROM "BankTransaction" t JOIN "Entity" e ON e.id = t."entityId"
          WHERE e."clientId" = ANY(${clientIds})
          GROUP BY e."clientId", EXTRACT(YEAR FROM t."date"), EXTRACT(MONTH FROM t."date")
        ) s WHERE r <= ${MONTHS_SHOWN} ORDER BY y, m`
    : [];
  const out = new Map<string, { year: number; month: number }[]>();
  for (const r of rows) out.set(r.clientId, [...(out.get(r.clientId) ?? []), { year: r.y, month: r.m }]);
  return out;
}

export async function previewInstruction(db: Db, input: InstructionScope & { draft: InstructionDraft; notes?: string[] }): Promise<InstructionPreview> {
  const d = input.draft;
  const scope = await scopeCharts(db, input);
  const notes = [...(input.notes ?? [])];
  const skipped = d.kind === "ACCOUNT" ? scope.clients.filter((c) => !scope.codes.get(c.id)!.has(d.accountCode!)) : [];
  const reached = scope.clients.filter((c) => !skipped.includes(c));
  const months = await latestMonths(db, reached.map((c) => c.id));
  const key = (y: number, m: number) => y * 100 + m;
  const inWindow = new Map(reached.map((c) => [c.id, new Set((months.get(c.id) ?? []).map((p) => key(p.year, p.month)))]));
  const starts = [...months.values()].flatMap((ps) => ps.map((p) => periodBounds(p.year, p.month).start));
  const from = starts.length ? new Date(Math.min(...starts.map(Number))) : null;
  const direction: { direction?: Direction } = d.direction ? { direction: d.direction } : {};
  const amount = d.minAmount === null ? {} : { OR: [{ amount: d.inclusive ? { gte: d.minAmount } : { gt: d.minAmount } }, { amount: d.inclusive ? { lte: -d.minAmount } : { lt: -d.minAmount } }] };
  // No month in the window means no bank line in scope: the query below then reads nothing.
  const where: Prisma.BankTransactionWhereInput = { bankAccount: { entity: { clientId: { in: from ? reached.map((c) => c.id) : [] } } }, ...(from ? { date: { gte: from } } : {}), ...direction, ...amount, ...(d.pattern ? { description: { contains: d.pattern, mode: "insensitive" } } : {}) };
  const rows = await db.bankTransaction.findMany({
    where,
    select: { id: true, date: true, description: true, direction: true, amount: true, accountCode: true, method: true, status: true, confidence: true, bankAccount: { select: { entity: { select: { clientId: true } } } } },
    orderBy: [{ date: "desc" }, { rowNumber: "asc" }],
  });
  // The window is per client; the query read from the earliest one. The run-time matcher decides, not the SQL filter.
  const candidates = rows.filter((t) => inWindow.get(t.bankAccount.entity.clientId)?.has(key(t.date.getUTCFullYear(), t.date.getUTCMonth() + 1)) && matchesLine(d, t));

  let matched = candidates;
  if (d.kind === "ACCOUNT") {
    const rules = await db.rule.findMany({ where: { firmId: input.firmId, OR: [{ clientId: null }, { clientId: { in: reached.map((c) => c.id) } }] } });
    const proposed: RuleLike = { id: "instruksi-baru", pattern: d.pattern!, direction: d.direction, accountCode: d.accountCode!, taxTag: d.taxTag, priority: INSTRUCTION_PRIORITY, clientId: input.clientId, source: "INSTRUKSI" };
    const sorted = new Map(reached.map((c) => [c.id, sortRules(rules.filter((r) => !r.clientId || r.clientId === c.id))]));
    const withNew = new Map(reached.map((c) => [c.id, sortRules([...sorted.get(c.id)!, proposed])]));
    const transfers = candidates.filter((t) => t.method === "TRANSFER");
    const elsewhere = new Map<string, Set<string>>();
    const kept = new Map<string, number>();
    matched = [];
    for (const t of candidates) {
      if (t.method === "TRANSFER") continue;
      const codes = scope.codes.get(t.bankAccount.entity.clientId)!;
      const winner = winningRule(withNew.get(t.bankAccount.entity.clientId)!, t.description, t.direction, codes);
      if (winner !== proposed) {
        const label = winner ? `aturan ${winner.clientId ? "klien" : "kantor"} ${winner.pattern}` : "aturan lain";
        kept.set(label, (kept.get(label) ?? 0) + 1);
        continue;
      }
      matched.push(t);
      if (t.accountCode === d.accountCode) continue;
      const now = winningRule(sorted.get(t.bankAccount.entity.clientId)!, t.description, t.direction, codes);
      const why = t.status === "NEEDS_REVIEW" ? "menunggu di Review" : now ? `aturan ${now.clientId ? "klien" : "kantor"} ${now.pattern}` : METHOD_WORD[t.method] ?? t.method;
      const code = t.accountCode ?? "dipecah";
      elsewhere.set(code, (elsewhere.get(code) ?? new Set()).add(why));
    }
    const moved = matched.filter((t) => t.accountCode !== d.accountCode).length;
    if (moved) notes.push(`${moved} baris sekarang di akun lain (${[...elsewhere].map(([code, why]) => `${code}, ${[...why].join(" / ")}`).join("; ")}).`);
    for (const [label, n] of kept) notes.push(`${n} baris tetap mengikuti ${label}.`);
    if (transfers.length) notes.push(`${transfers.length} baris tidak terpengaruh, transfer.`);
    if (skipped.length) notes.push(`Dilewati di ${skipped.length} klien karena bagan akunnya tidak memuat ${d.accountCode}: ${skipped.map((c) => c.name).join(", ")}.`);
  } else if (d.kind === "HOLD") {
    const posted = matched.filter((t) => t.status === "POSTED" && ["TRANSFER", "RULE", "MEMORY"].includes(t.method) && t.confidence >= AUTO_POST_CONFIDENCE).length;
    if (posted) notes.push(`${posted} di antaranya dicatat langsung, dan dengan instruksi ini akan menunggu di Review.`);
  }

  const hints: string[] = [];
  if (d.pattern && !rows.length && reached.length) {
    notes.push(`Belum ada mutasi yang memuat "${d.pattern}".`);
    hints.push(...(await rankHints(db, input.firmId, reached.map((c) => c.id), from, d)));
  } else if (!matched.length) notes.push("Tidak ada mutasi yang cocok di tiga bulan terakhir yang berisi mutasi.");

  const name = new Map(scope.clients.map((c) => [c.id, c.name]));
  const clients = reached.map((c) => {
    const ms = (months.get(c.id) ?? []).map((p) => ({ label: formatPeriod(p.year, p.month), count: matched.filter((t) => t.bankAccount.entity.clientId === c.id && key(t.date.getUTCFullYear(), t.date.getUTCMonth() + 1) === key(p.year, p.month)).length }));
    return { id: c.id, name: c.name, months: ms, total: ms.reduce((s, m) => s + m.count, 0) };
  });
  const conflict = await activeConflict(db, input, d);
  const accountName = d.accountCode ? (scope.accounts.find((a) => a.code === d.accountCode)?.name ?? null) : null;
  return {
    sentence: compiledSentence(d, { accountName, firmWide: input.clientId === null }),
    draft: toJson(d),
    notes,
    hints,
    clients,
    matched: matched.length,
    lines: matched.slice(0, LINES_SHOWN).map((t) => ({ id: t.id, date: t.date.toISOString().slice(0, 10), client: name.get(t.bankAccount.entity.clientId)!, description: t.description, amount: t.amount.toString(), account: t.accountCode, method: METHOD_WORD[t.method] ?? t.method, status: t.status })),
    blocked: conflict ? duplicateMessage(conflict.sentence) : null,
  };
}

/**
 * Up to three keywords the bank may print for what was typed (`keywordHints`): drawn from the scope's rule patterns and the merchant keys
 * of its window, ranked by how many typed words they cover, then by lines matched; a hint that matches nothing is not offered.
 */
async function rankHints(db: Db, firmId: string, clientIds: string[], from: Date | null, d: InstructionDraft): Promise<string[]> {
  if (!from) return [];
  const rules = await db.rule.findMany({ where: { firmId, OR: [{ clientId: null }, { clientId: { in: clientIds } }] }, select: { pattern: true } });
  const keys = await db.bankTransaction.findMany({ where: { bankAccount: { entity: { clientId: { in: clientIds } } }, date: { gte: from }, ...(d.direction ? { direction: d.direction } : {}) }, distinct: ["merchantKey"], select: { merchantKey: true } });
  const fits = keywordHints(d.pattern!, [...rules.map((r) => r.pattern), ...keys.map((k) => k.merchantKey)]);
  const counted = await Promise.all(
    fits.map(async (hint) => ({
      hint,
      words: hint.split(" ").length,
      lines: await db.bankTransaction.count({ where: { bankAccount: { entity: { clientId: { in: clientIds } } }, date: { gte: from }, ...(d.direction ? { direction: d.direction } : {}), description: { contains: hint, mode: "insensitive" } } }),
    })),
  );
  return counted
    .filter((c) => c.lines > 0)
    .sort((a, b) => b.words - a.words || b.lines - a.lines || a.hint.localeCompare(b.hint))
    .slice(0, HINTS_SHOWN)
    .map((c) => c.hint);
}

