import { createHash } from "node:crypto";
import type { Db } from "@/lib/db";
import { recordEvent } from "@/lib/audit";
import { runBudgetedAi } from "@/lib/ai/budget";
import { AiAnswerError, type AiProvider, type CloseReviewRow } from "@/lib/ai/provider";
import { scanLedger } from "@/lib/controls/anomaly";
import { accountLineRows, accountSeriesRow, type ReviewLink } from "@/lib/controls/ai-review";
import { formatPeriod } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { allowedNumbers, foreignNumbers } from "@/lib/reports/commentary-ai";
import { changePercent, type ManagementSummary } from "@/lib/reports/management";
import { FLUX_EXPLANATION_MAX_CHARS, FLUX_EXPLANATION_MAX_TOKENS, FLUX_EXPLANATION_PROMPT_VERSION, buildFluxExplanationPrompt, type FluxExplanationInput } from "@/lib/reports/flux-explanation-ai";

/**
 * Penjelasan penggerak (Wawasan keuangan, accounting-rules 20d): why one P&L account moved this month, in words the owner reads. AI may
 * draft it — only for an account the flux scan flags, from the close review's own rows for that account, citing them — and arithmetic
 * checks every number; only the accountant's *Setujui* stores it. A stored explanation keeps the account's series it was approved
 * against: when the books move that series it is stale, and the management pack leaves it out until approved again.
 */
export class ExplanationError extends Error {}

type Key = { clientId: string; entityId: string; year: number; month: number };
/** Per client-month, every draft together (each call reserves its output cap). */
export const FLUX_EXPLANATION_TOKEN_LIMIT = 60_000;
/** Lines sent under the account's movement: the month's largest, as the close review sends them. */
const LINE_ROWS = 10;
const pkOf = (k: Pick<Key, "year" | "month">) => `${k.year}-${String(k.month).padStart(2, "0")}`;
const scopeOf = (k: Key) => `flux:${k.clientId}:${pkOf(k)}`;
const abs = (v: bigint) => (v < 0n ? -v : v);

/** What a stored explanation was approved against: the baseline months and the account's movement in each, then this month. */
type Series = { baseline: string[]; values: string[] };
/** Field by field: JSONB does not keep key order. */
const sameSeries = (stored: unknown, now: Series | null) => {
  const s = stored as Partial<Series> | null;
  return now !== null && JSON.stringify(s?.baseline) === JSON.stringify(now.baseline) && JSON.stringify(s?.values) === JSON.stringify(now.values);
};

async function entityOf(db: Db, k: Key, firmId: string) {
  const entity = await db.entity.findFirst({ where: { id: k.entityId, clientId: k.clientId, client: { firmId } }, select: { id: true, name: true, functionalCurrency: true, client: { select: { name: true } } } });
  if (!entity) throw new ExplanationError("Perusahaan tidak ditemukan.");
  return entity;
}

/**
 * One account's movement and the rows a draft may send: its series row and up to ten of the month's largest lines — the rows the close
 * review sends for it (`accountSeriesRow`, `accountLineRows`), so the payload stays inside ADR 0009's amendment. Null for an account that
 * is not in the chart or has no movement in the month or its baseline.
 */
async function accountRows(db: Db, k: Key, entity: { id: string; functionalCurrency: string }, code: string) {
  const account = await db.account.findUnique({ where: { clientId_code: { clientId: k.clientId, code } } });
  if (!account || (account.type !== "PENDAPATAN" && account.type !== "BEBAN")) return null;
  const scan = await scanLedger(db, k.clientId, entity.id, k.year, k.month);
  const values = scan.series.get(account.id);
  if (!values || values.every((v) => v === 0n)) return null;
  const head = accountSeriesRow(scan, account, values.at(-1)!, entity, k.year, k.month);
  const lines = (await accountLineRows(db, entity, [account.id], k.year, k.month)).slice(0, LINE_ROWS);
  const linked = [head, ...lines];
  return {
    account,
    flagged: scan.flux.some((f) => f.account.id === account.id),
    series: { baseline: scan.baseline, values: values.map(String) } satisfies Series,
    values,
    rows: linked.map((x) => x.row),
    links: new Map(linked.map((x) => [x.link.id, x.link])),
  };
}

/** Every number the rows sent hold, with the names around them: the only numbers an AI draft may state. */
const sentNumbers = (rows: CloseReviewRow[], names: string[]) => allowedNumbers([...names, ...rows.flatMap((r) => [r.text, r.amount, r.date, r.account, r.how ?? ""])]);

/** The figures *Penggerak* shows for the account (average, difference, %), which the accountant's own words may also use. */
function shownNumbers(values: bigint[], currency: string) {
  const base = values.slice(0, -1);
  const current = values.at(-1)!;
  const average = base.length ? base.reduce((s, v) => s + v, 0n) / BigInt(base.length) : null;
  const delta = current - (average ?? 0n);
  return [formatMoney(current, currency), average === null ? "" : formatMoney(average, currency), formatMoney(abs(delta), currency), changePercent({ delta, average }) ?? ""];
}

export type ExplanationDraft = { text: string; refs: ReviewLink[]; foreign: string[] };

/**
 * One budgeted, cached call for a flagged account; nothing is saved. Citations outside the rows sent are dropped (in the parse) and a
 * draft citing none is refused; the draft comes back with the numbers it holds that the rows do not.
 */
export async function draftFluxExplanation(db: Db, k: Key & { firmId: string; accountCode: string; provider: AiProvider }): Promise<ExplanationDraft> {
  if (!k.provider.draftFluxExplanation) throw new ExplanationError("Model AI ini belum mendukung penjelasan akun.");
  const entity = await entityOf(db, k, k.firmId);
  const a = await accountRows(db, k, entity, k.accountCode);
  if (!a?.flagged) throw new ExplanationError("Susun dengan AI hanya untuk akun yang melewati ambang.");
  const input: FluxExplanationInput = { client: entity.client.name, entity: entity.name, period: formatPeriod(k.year, k.month), currency: entity.functionalCurrency, account: { code: a.account.code, name: a.account.name }, rows: a.rows };
  const key = createHash("sha256").update(JSON.stringify([k.firmId, k.entityId, input, k.provider.model, FLUX_EXPLANATION_PROMPT_VERSION])).digest("hex");
  const scope = scopeOf(k);
  const hit = await db.evidenceAiCache.findFirst({ where: { key, firmId: k.firmId, scope } });
  let answer: { text: string; refs: string[] };
  if (hit) answer = hit.payload as { text: string; refs: string[] };
  else {
    const r = await runBudgetedAi(
      db,
      { firmId: k.firmId, scope, prompt: buildFluxExplanationPrompt(input), maxCompletionTokens: FLUX_EXPLANATION_MAX_TOKENS, scopeTokenLimit: FLUX_EXPLANATION_TOKEN_LIMIT, model: k.provider.model, keysRequested: 1, note: "Penjelasan penggerak" },
      async () => {
        const out = await k.provider.draftFluxExplanation!(input);
        if (!out.text.trim()) throw new AiAnswerError("Penjelasan AI kosong; tulis sendiri.", out.promptTokens, out.completionTokens, out.model);
        return out;
      },
    );
    answer = { text: r.text, refs: r.refs };
    await db.evidenceAiCache.upsert({ where: { key }, create: { key, firmId: k.firmId, scope, payload: answer }, update: {} });
  }
  const refs = answer.refs.filter((id) => a.links.has(id));
  if (!refs.length) throw new ExplanationError("AI tidak mengutip baris; tulis sendiri.");
  return { text: answer.text, refs: refs.map((id) => a.links.get(id)!), foreign: foreignNumbers(answer.text, sentNumbers(a.rows, [input.client, input.entity, input.period, a.account.code, a.account.name])) };
}

/**
 * The accountant's *Setujui*. An AI draft must cite rows still sent for the account and hold no number they do not; the accountant's own
 * or edited words may hold one (they own them) and get the list back as a warning. Allowed in a closed month: commentary, not the books.
 */
export async function saveFluxExplanation(db: Db, k: Key & { firmId: string; accountCode: string; text: string; source: "AI" | "ACCOUNTANT"; refs?: string[]; actorId?: string | null }): Promise<{ foreign: string[] }> {
  const entity = await entityOf(db, k, k.firmId);
  const text = k.text.replace(/\s+\n/g, "\n").trim();
  if (!text) throw new ExplanationError("Isi penjelasannya dulu.");
  if (text.length > FLUX_EXPLANATION_MAX_CHARS) throw new ExplanationError("Penjelasan maksimal 1.000 karakter.");
  if (k.source !== "AI" && k.source !== "ACCOUNTANT") throw new ExplanationError("Sumber penjelasan tidak dikenal.");
  const a = await accountRows(db, k, entity, k.accountCode);
  if (!a) throw new ExplanationError(`Akun ${k.accountCode} tidak bergerak di bulan ini atau bulan pembandingnya.`);
  const names = [entity.client.name, entity.name, formatPeriod(k.year, k.month), a.account.code, a.account.name];
  const refs = k.source === "AI" ? [...new Set(k.refs ?? [])].filter((id) => a.links.has(id)) : [];
  let foreign: string[];
  if (k.source === "AI") {
    if (!a.flagged) throw new ExplanationError("Penjelasan AI hanya untuk akun yang melewati ambang.");
    if (!refs.length) throw new ExplanationError("Baris yang dikutip AI sudah berubah. Susun ulang atau tulis sendiri.");
    foreign = foreignNumbers(text, sentNumbers(a.rows, names));
    if (foreign.length) throw new ExplanationError(`Penjelasan AI memuat angka yang tidak ada di baris yang dikirim: ${foreign.join(", ")}. Ubah sendiri atau susun ulang.`);
  } else {
    foreign = foreignNumbers(text, sentNumbers(a.rows, [...names, ...shownNumbers(a.values, entity.functionalCurrency)]));
  }
  await db.$transaction(async (tx) => {
    const data = { text, source: k.source, series: a.series, refs, approvedById: k.actorId ?? null, approvedAt: new Date() };
    await tx.fluxExplanation.upsert({
      where: { entityId_year_month_accountCode: { entityId: k.entityId, year: k.year, month: k.month, accountCode: a.account.code } },
      create: { firmId: k.firmId, clientId: k.clientId, entityId: k.entityId, year: k.year, month: k.month, accountCode: a.account.code, ...data },
      update: data,
    });
    await recordEvent(tx, { clientId: k.clientId, entityId: k.entityId, kind: "REPORT_COMMENT", subject: `period:${pkOf(k)}`, summary: `Penjelasan ${a.account.code} ${a.account.name} ${entity.name} disetujui (${k.source === "AI" ? "disusun AI" : "ditulis akuntan"})`, after: { account: a.account.code, text, source: k.source }, actorId: k.actorId ?? null });
  });
  return { foreign };
}

export async function clearFluxExplanation(db: Db, k: Key & { firmId: string; accountCode: string; actorId?: string | null }) {
  const entity = await entityOf(db, k, k.firmId);
  await db.$transaction(async (tx) => {
    const { count } = await tx.fluxExplanation.deleteMany({ where: { clientId: k.clientId, entityId: k.entityId, year: k.year, month: k.month, accountCode: k.accountCode } });
    if (count) await recordEvent(tx, { clientId: k.clientId, entityId: k.entityId, kind: "REPORT_COMMENT", subject: `period:${pkOf(k)}`, summary: `Penjelasan ${k.accountCode} ${entity.name} dihapus`, actorId: k.actorId ?? null });
  });
}

export type ExplanationView = { code: string; text: string; source: "AI" | "ACCOUNTANT"; approvedAt: Date; approvedBy: string | null; stale: boolean };

/**
 * The month's approved explanations for one company, each checked against the account's series in `summary` (the management summary
 * of the same company and month), and last month's text per account — offered again with *Pakai lagi*, never approved for anyone.
 */
export async function fluxExplanations(db: Db, k: Key, summary: Pick<ManagementSummary, "baseline" | "changes">): Promise<{ current: Map<string, ExplanationView>; previous: Map<string, string> }> {
  const prevIndex = k.year * 12 + k.month - 2;
  const prev = { year: Math.floor(prevIndex / 12), month: (prevIndex % 12) + 1 };
  const [rows, before] = await Promise.all([
    db.fluxExplanation.findMany({ where: { clientId: k.clientId, entityId: k.entityId, year: k.year, month: k.month } }),
    db.fluxExplanation.findMany({ where: { clientId: k.clientId, entityId: k.entityId, year: prev.year, month: prev.month }, select: { accountCode: true, text: true } }),
  ]);
  const names = new Map((await db.firmMember.findMany({ where: { id: { in: rows.flatMap((r) => (r.approvedById ? [r.approvedById] : [])) } }, select: { id: true, name: true } })).map((m) => [m.id, m.name]));
  const seriesOf = (code: string): Series | null => {
    const c = summary.changes.find((x) => x.code === code);
    return c ? { baseline: summary.baseline, values: c.series.map(String) } : null;
  };
  return {
    current: new Map(
      rows.map((r) => [
        r.accountCode,
        { code: r.accountCode, text: r.text, source: r.source as "AI" | "ACCOUNTANT", approvedAt: r.approvedAt, approvedBy: r.approvedById ? (names.get(r.approvedById) ?? null) : null, stale: !sameSeries(r.series, seriesOf(r.accountCode)) },
      ]),
    ),
    previous: new Map(before.map((r) => [r.accountCode, r.text])),
  };
}
