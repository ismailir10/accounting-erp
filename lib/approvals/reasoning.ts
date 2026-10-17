import type { Db } from "@/lib/db";
import type { Direction } from "@/lib/generated/prisma/enums";
import { aiAccounts, aiCacheKey, aiScope } from "@/lib/ai/classify";
import { DEMO_AI_MODEL } from "@/lib/ai/provider";
import { UNBACKED_CONFIDENCE } from "@/lib/ai/unbacked";
import { accountGroup } from "@/lib/coa/options";
import { isClassifiable, TAX_TAG_LABEL } from "@/lib/coa/template";
import { accountantHints, isSureSuggestion, SURE_CONFIDENCE } from "@/lib/classify/hints";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { resolveAiConfig } from "@/lib/settings/ai";
import { toCsv } from "@/lib/csv";

/**
 * *Lihat alasan* (Phase 2 item 2): the steps behind an AI card — what Buku checked first, what was sent to the model, what came back and
 * what Buku checked after — as a read model over rows that already exist. Nothing is stored, no model is called, no budget is spent.
 * A bank line is linked to its cached answer by recomputing the cache key from its own inputs (never by looking the cache up by
 * counterparty): the key includes firm and client, so a match can't reach another tenant's answer, and a match proves which
 * description and model were used. No match → the panel says so and shows only what the line itself stores.
 */

export class ReasoningError extends Error {}
export const NOT_FOUND = "Usulan tidak ditemukan.";

/** Same-counterparty descriptions tried as the one sent (rule 17 sends one per counterparty and direction per batch). */
const MAX_DESCRIPTIONS = 50;
/** What the prompt keeps of a description (`buildPrompt`). */
const SENT_CHARS = 80;

type Account = { code: string; name: string };
export type Check = { ok: boolean; text: string };

/** Everything a bank line's panel and CSV show, as plain JSON (amounts as minor-unit strings). */
export type BankFacts = {
  kind: "bank";
  id: string;
  line: { date: string; description: string; amount: string; currency: string; bank: string };
  direction: Direction;
  stored: { code: string | null; name: string | null; confidence: number; taxTag: string | null; reason: string };
  /** What the prompt held for this line; null when the cached answer can't be matched (nothing unproven is shown). */
  sent: { client: string; counterparty: string; description: string; accounts: Account[]; withheld: string[]; coaVersion: number } | null;
  /** The cached answer, before Buku changed anything. */
  answer: { code: string; name: string | null; confidence: number; taxTag: string | null; reason: string; model: string; at: string } | null;
  /** Buku replaced an unbacked receivable/payable with the simple guess's account (`demoteUnbacked`). */
  replaced: { from: Account; to: Account; what: string } | null;
  /** Kept the AI's account but capped its confidence: the chart lacks the simple guess's account. */
  capped: string | null;
  inChart: boolean;
  bulk: { ok: true } | { ok: false; why: "low" | "hints" | "none" };
};

/** Models whose answers may be cached for this firm: every model its AI usage names, the configured one, and the demo seed's. */
export async function candidateModels(db: Db, firmId: string): Promise<string[]> {
  const [usage, config] = await Promise.all([db.aiUsage.findMany({ where: { firmId }, distinct: ["model"], select: { model: true } }), resolveAiConfig(db)]);
  return [...new Set([...usage.map((u) => u.model), config.model, DEMO_AI_MODEL].filter(Boolean))];
}

const TRADE_WORDS: Record<Direction, string> = { IN: "piutang usaha", OUT: "utang usaha" };

/**
 * The reasoning behind one AI bank line of the client. Throws `ReasoningError(NOT_FOUND)` for a line of another client or one that is
 * not an AI suggestion (the route answers 404).
 */
export async function bankReasoning(db: Db, scope: { firmId: string; clientId: string }, id: string): Promise<BankFacts> {
  const line = await db.bankTransaction.findFirst({
    where: { id, firmId: scope.firmId, method: "AI", bankAccount: { entity: { clientId: scope.clientId } } },
    include: { bankAccount: { select: { label: true, currency: true, entity: { select: { kind: true } } } } },
  });
  if (!line) throw new ReasoningError(NOT_FOUND);
  const [client, all, models, same] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id: scope.clientId }, select: { id: true, firmId: true, name: true, industry: true, coaVersion: true } }),
    db.account.findMany({ where: { clientId: scope.clientId }, orderBy: { code: "asc" } }),
    candidateModels(db, scope.firmId),
    db.bankTransaction.findMany({
      where: { merchantKey: line.merchantKey, direction: line.direction, bankAccount: { entity: { clientId: scope.clientId } } },
      orderBy: [{ date: "desc" }, { rowNumber: "desc" }],
      take: MAX_DESCRIPTIONS,
      select: { description: true, importId: true },
    }),
  ]);
  const classifiable = all.filter(isClassifiable);
  const nameOf = (code: string | null) => (code ? (classifiable.find((a) => a.code === code)?.name ?? null) : null);
  const kind = line.bankAccount.entity.kind;
  // The prompt as the pipeline, the background run and the seed build it (lib/ai/classify.ts).
  const ai = aiScope(client, kind, classifiable);
  const offered = aiAccounts(ai.accounts).sort((a, b) => a.code.localeCompare(b.code));
  const withheld = ai.accounts.filter((a) => !offered.includes(a)).map((a) => a.code);
  // The line's own description first, then its import's (one batch: the last line of a counterparty is the one sent), then the newest
  // of the rest (a background run's batch); only the first 80 characters reach the prompt.
  const ordered = [...same.filter((s) => s.importId === line.importId), ...same.filter((s) => s.importId !== line.importId)];
  const descriptions = [...new Set([line.description, ...ordered.map((s) => s.description)].map((d) => d.slice(0, SENT_CHARS)))];
  const tries = descriptions.flatMap((sample) => models.map((model) => ({ sample, model, key: aiCacheKey(line.merchantKey, line.direction, client.coaVersion, { firmId: client.firmId, clientId: client.id, model, clientName: ai.clientName, accounts: ai.accounts, sample }) })));
  const rows = new Map((await db.aiSuggestion.findMany({ where: { cacheKey: { in: tries.map((t) => t.key) } } })).map((r) => [r.cacheKey, r]));
  // A cached answer is this line's only when the line still reads as made from it: as given, replaced, or capped (lib/ai/unbacked.ts).
  const fits = (r: { accountCode: string; reason: string }) =>
    (line.suggestedCode === r.accountCode && (line.reason === `AI: ${r.reason}` || line.reason.startsWith(`AI: ${r.reason} · Belum ada `))) ||
    line.reason.startsWith(`AI mengusulkan ${r.accountCode} `);
  const hit = tries.map((t) => ({ ...t, row: rows.get(t.key) })).find((t) => t.row && fits(t.row));

  const answer = hit?.row ? { code: hit.row.accountCode, name: nameOf(hit.row.accountCode), confidence: hit.row.confidence, taxTag: hit.row.taxTag, reason: hit.row.reason, model: hit.row.model, at: hit.row.createdAt.toISOString() } : null;
  const what = TRADE_WORDS[line.direction];
  const replaced = answer && line.suggestedCode && answer.code !== line.suggestedCode ? { from: { code: answer.code, name: answer.name ?? "" }, to: { code: line.suggestedCode, name: nameOf(line.suggestedCode) ?? "" }, what } : null;
  const capped = answer && !replaced && line.reason.includes(" · Belum ada ") ? what : null;
  const option = classifiable.find((a) => a.code === line.suggestedCode);
  const account = option ? { code: option.code, name: option.name, group: accountGroup(option) } : null;
  const hinted = accountantHints({ description: line.description, amount: line.amount, account, wht: "none", entityKind: kind }).length > 0;
  return {
    kind: "bank",
    id: line.id,
    line: { date: line.date.toISOString().slice(0, 10), description: line.description, amount: line.amount.toString(), currency: line.bankAccount.currency, bank: line.bankAccount.label },
    direction: line.direction,
    stored: { code: line.suggestedCode, name: nameOf(line.suggestedCode), confidence: line.confidence, taxTag: line.taxTag, reason: line.reason },
    sent: hit ? { client: ai.clientName, counterparty: line.merchantKey, description: hit.sample, accounts: offered, withheld, coaVersion: client.coaVersion } : null,
    answer,
    replaced,
    capped,
    inChart: Boolean(option),
    // Review's and Kotak's bulk rule (`bulkAcceptable`), with the reason it says no.
    bulk: !line.suggestedCode ? { ok: false, why: "none" } : !isSureSuggestion(line) ? { ok: false, why: "low" } : hinted ? { ok: false, why: "hints" } : { ok: true },
  };
}

// ---- presentation (pure: the panel's steps and the CSV's rows) ----

export type ReasoningStep = {
  label: string;
  lines: string[];
  /** Muted, after the lines. */
  note?: string;
  checks?: Check[];
  /** A draft's rows sent, each marked cited or not (date, text, amount, account, how). */
  rows?: { date: string; text: string; amount: string; account: string; how: string; cited: boolean }[];
};

const pct = (c: number) => `${Math.round(c * 100)}%`;
const taxLabel = (t: string | null) => (t ? (TAX_TAG_LABEL[t as keyof typeof TAX_TAG_LABEL] ?? t) : "–");
const accountText = (code: string | null, name: string | null) => (code ? `${code} ${name ?? ""}`.trim() : "belum ada akun");
const isDemo = (model: string) => model === DEMO_AI_MODEL;
const DIRECTION_TEXT: Record<Direction, string> = { IN: "uang masuk", OUT: "uang keluar" };

export const CHECKED_FIRST =
  "Saat impor tidak ada pasangan transfer, aturan, memori klien, atau teks pinjaman, modal atau pajak yang cocok, jadi baris ini ditanyakan ke AI.";
export const NOT_SENT = "Nominal, tanggal, saldo dan nomor rekening tidak dikirim.";
export const NO_MATCH =
  "Jawaban AI asli tidak bisa dicocokkan lagi karena bagan akun atau model berubah sejak usulan ini dibuat. Yang tampil: usulan yang tersimpan di baris ini.";
export const DEMO_ANSWER = "Jawaban demo, tanpa panggilan AI";
const BULK_NO: Record<"low" | "hints" | "none", string> = {
  low: `Tidak ikut setujui massal: keyakinan di bawah ${pct(SURE_CONFIDENCE)}`,
  hints: "Tidak ikut setujui massal: ada catatan akuntan di atas",
  none: "Tidak ikut setujui massal: belum ada akun usulan",
};

const accountsText = (s: NonNullable<BankFacts["sent"]>) => `${s.accounts.length} akun${s.withheld.length ? `, tanpa ${s.withheld.join(" dan ")}` : ""}`;

/** The bank line's five steps, in the panel's words. */
export function bankSteps(f: BankFacts): ReasoningStep[] {
  const said = f.answer ?? { code: f.stored.code ?? "", name: f.stored.name, confidence: f.stored.confidence, taxTag: f.stored.taxTag, reason: f.stored.reason.replace(/^AI: /, ""), model: null, at: null };
  const checks: Check[] = [];
  if (f.stored.code) checks.push(f.inChart ? { ok: true, text: `Kode ${f.stored.code} ada di bagan akun klien.` } : { ok: false, text: `Kode ${f.stored.code} tidak ada di bagan akun klien.` });
  if (f.replaced) checks.push({ ok: false, text: `Diganti: AI mengusulkan ${accountText(f.replaced.from.code, f.replaced.from.name)}, tetapi belum ada ${f.replaced.what} tercatat untuk entitas ini, jadi usulannya ${accountText(f.replaced.to.code, f.replaced.to.name)} dengan keyakinan paling tinggi ${pct(UNBACKED_CONFIDENCE)}.` });
  if (f.capped) checks.push({ ok: false, text: `Keyakinan dibatasi ${pct(UNBACKED_CONFIDENCE)}: belum ada ${f.capped} tercatat untuk entitas ini.` });
  checks.push(f.bulk.ok ? { ok: true, text: "Boleh disetujui massal." } : { ok: false, text: `${BULK_NO[f.bulk.why]}.` });
  return [
    { label: "Dicek dulu tanpa AI", lines: [CHECKED_FIRST] },
    f.sent
      ? {
          label: "Dikirim ke AI",
          lines: [`Klien: "${f.sent.client}"`, `Arah: ${DIRECTION_TEXT[f.direction]}`, `Pihak lawan: ${f.sent.counterparty}`, `Keterangan: "${f.sent.description}"`, `Daftar akun: ${accountsText(f.sent)}`],
          note: NOT_SENT,
        }
      : { label: "Dikirim ke AI", lines: [NO_MATCH], note: NOT_SENT },
    {
      label: "Jawaban AI",
      lines: [
        `${accountText(said.code, said.name)} · keyakinan ${pct(said.confidence)} · pajak ${taxLabel(said.taxTag)} · "${said.reason}"`,
        ...(said.model ? [isDemo(said.model) ? DEMO_ANSWER : `${said.model}, ${formatDate(new Date(said.at!))}`] : []),
      ],
    },
    { label: "Diperiksa Buku", lines: [], checks },
    { label: "Belum dicatat", lines: ["Baris ini tetap di 1999 sampai Anda menyetujuinya."] },
  ];
}

/** The CSV's columns: one row per value sent, per value returned and per check, each with its source. */
export const CSV_HEADER = ["Bagian", "Butir", "Nilai", "Tanggal", "Jumlah", "Jumlah (satuan terkecil)", "Mata uang", "Akun", "Cara", "Dikutip", "Sumber"];
type CsvRow = (string | number | null)[];
/** A row with only the first three columns and a source. */
const row = (part: string, item: string, value: string | number, source: string): CsvRow => [part, item, value, null, null, null, null, null, null, null, source];
const checkRows = (checks: Check[]) => checks.map((c) => row("Diperiksa Buku", c.ok ? "Lolos" : "Perlu dicek", c.text, "Pemeriksaan Buku"));

export function bankCsvRows(f: BankFacts): CsvRow[] {
  const out: CsvRow[] = [];
  if (f.sent) {
    const s = f.sent;
    out.push(
      row("Dikirim ke AI", "Klien", s.client, "Nama dan bidang usaha klien"),
      row("Dikirim ke AI", "Arah", f.direction, "Arah mutasi"),
      row("Dikirim ke AI", "Pihak lawan", s.counterparty, "Pihak lawan yang dibaca Buku dari keterangan"),
      row("Dikirim ke AI", "Keterangan", s.description, `${SENT_CHARS} karakter pertama keterangan mutasi dengan pihak lawan ini`),
      ...s.accounts.map((a): CsvRow => ["Dikirim ke AI", "Akun ditawarkan", a.name, null, null, null, null, a.code, null, null, `Bagan akun klien versi ${s.coaVersion}`]),
    );
  } else out.push(row("Dikirim ke AI", "Tidak cocok", NO_MATCH, "Cache jawaban AI"));
  const a = f.answer;
  const source = a ? (isDemo(a.model) ? DEMO_ANSWER : `Cache jawaban AI, ${a.model}`) : "Usulan tersimpan di baris ini";
  const code = a?.code ?? f.stored.code;
  out.push(
    ["Jawaban AI", "Akun", a?.name ?? f.stored.name ?? "", null, null, null, null, code, null, null, source],
    row("Jawaban AI", "Keyakinan", (a?.confidence ?? f.stored.confidence).toString(), source),
    row("Jawaban AI", "Pajak", (a ? a.taxTag : f.stored.taxTag) ?? "tanpa pajak", source),
    row("Jawaban AI", "Alasan", a?.reason ?? f.stored.reason.replace(/^AI: /, ""), source),
  );
  if (a) out.push(row("Jawaban AI", "Model", a.model, source), row("Jawaban AI", "Waktu", a.at, source));
  out.push(...checkRows(bankSteps(f)[3].checks ?? []));
  // The amount is shown for reference only: it never reached the model.
  const amount = BigInt(f.line.amount);
  out.push(["Tidak dikirim", "Nominal", "tidak dikirim", f.line.date, formatMoney(amount, f.line.currency), amount.toString(), f.line.currency, null, null, null, `Mutasi ${f.line.bank}`]);
  return out;
}

export const bankCsv = (f: BankFacts) => toCsv(CSV_HEADER, bankCsvRows(f));
