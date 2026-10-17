import type { Db } from "@/lib/db";
import type { Direction } from "@/lib/generated/prisma/enums";
import { aiAccounts, aiCacheKey, aiScope } from "@/lib/ai/classify";
import { amountOf, DEMO_AI_MODEL, type CloseReviewRow } from "@/lib/ai/provider";
import { UNBACKED_CONFIDENCE } from "@/lib/ai/unbacked";
import { accountGroup } from "@/lib/coa/options";
import { isClassifiable, TAX_TAG_LABEL } from "@/lib/coa/template";
import { accountantHints, isSureSuggestion, SURE_CONFIDENCE } from "@/lib/classify/hints";
import { runControls } from "@/lib/controls";
import { bankLineState, gather, snapshotOf } from "@/lib/controls/ai-review";
import { explainInput, explainKey, storedDropped } from "@/lib/controls/explain";
import { priorCorrection, readLines, type ProposalLine } from "@/lib/adjust/proposals";
import { formatDate, formatMonthYear, monthName, periodBounds, toIsoDate } from "@/lib/format";
import { ACCRUAL_PREFIX, accrualProposals, HISTORY_MONTHS, MIN_MONTHS, NO_AI, parseAccrualKey } from "@/lib/adjust/accruals";
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

// ---- an AI draft (*Jelaskan*, Kotak's *Draf jurnal*) ----

/** The message *Setujui* refuses a stale draft with (lib/adjust/proposals.ts). */
export const STALE = "Buku berubah sejak draf ini dibuat. Minta Jelaskan lagi, atau abaikan draf ini.";

export type DraftFacts = {
  kind: "draft";
  id: string;
  currency: string;
  /** The control as it flags today; null when it passes now or no longer exists. */
  control: { key: string; title: string; scope: string; status: "REVIEW" | "FAIL"; detail: string } | null;
  /** The control's rows today equal the rows sent (the draft's snapshot, *Setujui*'s own proof). */
  fresh: boolean;
  /** The rows sent, each marked cited or not; null when the books changed (nothing unproven is shown). */
  rows: (CloseReviewRow & { cited: boolean })[] | null;
  cited: number;
  /** Proven by recomputing the answer's cache key: the chart sent (its size) and the model; null when it can't be proven. */
  proven: { accounts: number; model: string; at: string | null } | null;
  /** Citations the answer had outside the rows sent; null for an answer cached before they were counted. */
  dropped: number | null;
  memo: string;
  explanation: string;
  lines: ProposalLine[];
  checks: { chart: string[]; balanced: boolean; grounded: boolean | null; bankLine: boolean; blocked: string | null };
};

/** A row's amount as sent ("-Rp 4.000.000", "(US$ 1,00)") as signed minor units, or null. */
export function signedMinor(text: string, currency: string): bigint | null {
  const v = amountOf(text, currency);
  return v === null ? null : /^\s*[-(]/.test(text) ? -v : v;
}

/**
 * The reasoning behind one AI draft of the client (`ProposedEntry`, source AI_CONTROL). The rows sent are the control's rows today,
 * shown only while the draft's snapshot still matches them. Throws `ReasoningError(NOT_FOUND)` for another client's proposal.
 */
export async function draftReasoning(db: Db, scope: { firmId: string; clientId: string }, id: string): Promise<DraftFacts> {
  const p = await db.proposedEntry.findFirst({ where: { id, firmId: scope.firmId, clientId: scope.clientId, source: "AI_CONTROL" }, include: { entity: { select: { functionalCurrency: true } } } });
  if (!p || !p.controlKey) throw new ReasoningError(NOT_FOUND);
  const currency = p.entity.functionalCurrency;
  const lines = readLines(p.lines);
  const cacheKey = p.key.startsWith("AI:") ? p.key.slice(3) : null;
  const flagged = (await runControls(db, scope.clientId, p.year, p.month)).find((c) => c.key === p.controlKey && c.status !== "PASS");
  let fresh = false;
  let rows: DraftFacts["rows"] = null;
  let proven: DraftFacts["proven"] = null;
  if (flagged) {
    const g = await gather(db, scope.clientId, p.year, p.month, [flagged]);
    const reviewed = g.input.controls[0];
    fresh = p.snapshot !== null && snapshotOf(reviewed.rows, await bankLineState(db, p.bankTransactionId)) === p.snapshot;
    if (fresh) {
      rows = reviewed.rows.map((r) => ({ ...r, cited: p.refs.includes(r.id) }));
      const { input } = await explainInput(db, scope.clientId, p.year, p.month, reviewed, g.input.entities);
      const model = (await candidateModels(db, scope.firmId)).find((m) => explainKey(scope.firmId, scope.clientId, input, m) === cacheKey);
      if (model) proven = { accounts: input.accounts.length, model, at: null };
    }
  }
  const cached = cacheKey ? await db.evidenceAiCache.findFirst({ where: { key: cacheKey, firmId: scope.firmId } }) : null;
  if (proven && cached) proven.at = cached.createdAt.toISOString();

  const chart = new Map((await db.account.findMany({ where: { clientId: scope.clientId, code: { in: lines.map((l) => l.accountCode) } }, select: { code: true, isBank: true } })).map((a) => [a.code, a]));
  const debit = lines.reduce((s, l) => s + BigInt(l.debit), 0n);
  const credit = lines.reduce((s, l) => s + BigInt(l.credit), 0n);
  // As *Setujui* re-checks it: every amount equals a cited row's amount (rule 20b).
  const citedAmounts = new Set(rows?.filter((r) => r.cited).map((r) => amountOf(r.amount, currency)));
  const line = p.bankTransactionId ? await db.bankTransaction.findFirst({ where: { id: p.bankTransactionId, entityId: p.entityId } }) : null;
  return {
    kind: "draft",
    id: p.id,
    currency,
    control: flagged ? { key: flagged.key, title: flagged.title, scope: flagged.scope, status: flagged.status as "REVIEW" | "FAIL", detail: flagged.detail } : null,
    fresh,
    rows,
    cited: p.refs.length,
    proven,
    dropped: cached ? storedDropped(cached.payload) : null,
    memo: p.memo,
    explanation: p.reason,
    lines,
    checks: {
      chart: lines.filter((l) => !chart.get(l.accountCode) || chart.get(l.accountCode)!.isBank).map((l) => l.accountCode),
      balanced: debit === credit && debit > 0n,
      grounded: rows ? lines.every((l) => citedAmounts.has(BigInt(l.debit) || BigInt(l.credit))) : null,
      bankLine: Boolean(p.bankTransactionId),
      blocked: line ? await priorCorrection(db, line, periodBounds(p.year, p.month).end) : null,
    },
  };
}

const STATUS_TEXT = { REVIEW: "Perlu dicek", FAIL: "Gagal" } as const;
const contextNote = (accounts: number | null) =>
  `Juga nama klien, periode, mata uang, daftar ${accounts === null ? "akun" : `${accounts} akun`} (tanpa akun bank, 1190 dan 1199) dan perusahaan grup.`;
const droppedText = (n: number | null) => (n === null ? "Kutipan yang dibuang: tidak tercatat." : n === 0 ? "Tidak ada kutipan di luar baris yang dikirim." : `${n} kutipan di luar baris yang dikirim dibuang.`);

function draftChecks(f: DraftFacts): Check[] {
  const c = f.checks;
  const out: Check[] = [
    c.chart.length ? { ok: false, text: `Akun ${c.chart.join(", ")} tidak ada di bagan akun atau adalah akun bank.` } : { ok: true, text: "Setiap akun ada di bagan akun dan bukan akun bank." },
    c.balanced ? { ok: true, text: "Debit sama dengan kredit." } : { ok: false, text: "Debit tidak sama dengan kredit." },
  ];
  if (c.grounded !== null) out.push(c.grounded ? { ok: true, text: "Setiap jumlah sama dengan jumlah baris yang dikutip." } : { ok: false, text: "Ada jumlah yang tidak berasal dari baris yang dikutip." });
  if (c.bankLine) out.push({ ok: true, text: "Memindahkan satu baris bank: dicatat lewat Review." });
  if (c.blocked) out.push({ ok: false, text: c.blocked });
  out.push(f.fresh ? { ok: true, text: "Buku belum berubah sejak draf dibuat." } : { ok: false, text: STALE });
  return out;
}

/** The draft's five steps, in the panel's words. */
export function draftSteps(f: DraftFacts): ReasoningStep[] {
  return [
    {
      label: "Kontrol menandai",
      lines: f.control ? [`${f.control.title} · ${f.control.scope} · ${STATUS_TEXT[f.control.status]}`, f.control.detail] : ["Kontrol yang menandai draf ini sudah lolos atau tidak ada lagi."],
    },
    f.rows
      ? { label: "Dikirim ke AI", lines: [], rows: f.rows.map((r) => ({ date: r.date, text: r.text, amount: r.amount, account: r.account, how: r.how ?? "", cited: r.cited })), note: contextNote(f.proven?.accounts ?? null) }
      : { label: "Dikirim ke AI", lines: ["Baris yang dikirim tidak ditampilkan karena buku berubah sejak draf ini dibuat."] },
    {
      label: "Jawaban AI",
      lines: [
        "Penjelasan dan draf jurnal di atas.",
        f.rows ? `Mengutip ${f.rows.filter((r) => r.cited).length} dari ${f.rows.length} baris.` : `Mengutip ${f.cited} baris.`,
        droppedText(f.dropped),
        ...(f.proven ? [f.proven.at ? `${f.proven.model}, ${formatDate(new Date(f.proven.at))}` : f.proven.model] : []),
      ],
    },
    { label: "Diperiksa Buku", lines: [], checks: draftChecks(f) },
    { label: "Belum dicatat", lines: ["Tidak ada yang dicatat sampai Anda menyetujui draf ini."] },
  ];
}

export function draftCsvRows(f: DraftFacts): CsvRow[] {
  const control = f.control ? `Kontrol tutup buku ${f.control.key}` : "Kontrol tutup buku";
  const out: CsvRow[] = f.control
    ? [row("Kontrol menandai", "Judul", f.control.title, control), row("Kontrol menandai", "Perusahaan", f.control.scope, control), row("Kontrol menandai", "Status", STATUS_TEXT[f.control.status], control), row("Kontrol menandai", "Detail", f.control.detail, control)]
    : [row("Kontrol menandai", "Status", "Lolos atau tidak ada lagi", control)];
  if (f.rows) {
    for (const r of f.rows) out.push(["Dikirim ke AI", "Baris", r.text, r.date, r.amount, signedMinor(r.amount, f.currency)?.toString() ?? null, f.currency, r.account, r.how ?? null, r.cited ? "ya" : "tidak", r.id]);
    out.push(row("Dikirim ke AI", "Juga dikirim", contextNote(f.proven?.accounts ?? null), "Konteks klien"));
  } else out.push(row("Dikirim ke AI", "Tidak ditampilkan", STALE, "Cuplikan baris draf"));
  const source = f.proven ? `Cache jawaban AI, ${f.proven.model}` : "Draf tersimpan";
  out.push(row("Jawaban AI", "Penjelasan", f.explanation, source), row("Jawaban AI", "Memo", f.memo, source));
  f.lines.forEach((l, i) => {
    const debit = BigInt(l.debit);
    const amount = debit || BigInt(l.credit);
    out.push(["Jawaban AI", `Baris jurnal ${i + 1}`, debit ? "Debit" : "Kredit", null, formatMoney(amount, f.currency), amount.toString(), f.currency, l.accountCode, null, null, source]);
  });
  out.push(row("Jawaban AI", "Kutipan dibuang", f.dropped ?? "tidak tercatat", source));
  if (f.proven) out.push(row("Jawaban AI", "Model", f.proven.model, source));
  out.push(...checkRows(draftChecks(f)));
  return out;
}

// ---- an accrual proposal (Kotak's *Usulan akrual*, deterministic: no AI) ----

type AccrualRow = { date: string; text: string; source: string; amount: string; ref: string };
export type AccrualFacts = {
  kind: "accrual";
  id: string;
  currency: string;
  bucket: "bank" | "contact" | "ledger";
  counterparty: string;
  account: Account;
  credit: Account | null;
  /** The four months read, oldest first: each month's amount (minor units) and rows. */
  months: { label: string; amount: string; rows: AccrualRow[] }[];
  moved: number;
  median: string;
  medianMonth: string;
  floor: string;
  /** The month's last day ("31 Agu 2026") and name ("Agustus"). */
  until: string;
  monthName: string;
  banks: string[];
  reversal: string;
  warning: string | null;
  blocked: string | null;
};

/**
 * The reasoning behind one accrual proposal of the client, recomputed from the books (nothing stored, no model). Throws
 * `ReasoningError(NOT_FOUND)` for another client's key or one no longer proposed (decided, or the payment arrived).
 */
export async function accrualReasoning(db: Db, scope: { firmId: string; clientId: string }, id: string, now?: Date): Promise<AccrualFacts> {
  const k = parseAccrualKey(id);
  const entity = k ? await db.entity.findFirst({ where: { id: k.entityId, clientId: scope.clientId, firmId: scope.firmId }, select: { id: true } }) : null;
  const p = k && entity ? (await accrualProposals(db, scope.clientId, k.year, k.month, { entityIds: [entity.id], now })).find((x) => x.key === id) : undefined;
  if (!p) throw new ReasoningError(NOT_FOUND);
  return {
    kind: "accrual",
    id: p.key,
    currency: p.entity.functionalCurrency,
    bucket: p.bucket.kind,
    counterparty: p.counterparty,
    account: { code: p.account.code, name: p.account.name },
    credit: p.credit ? { code: p.credit.code, name: p.credit.name } : null,
    months: p.history.map((h) => ({ label: formatMonthYear(h.year, h.month), amount: h.amount.toString(), rows: h.lines.map((l) => ({ date: toIsoDate(l.date), text: l.text, source: l.source, amount: l.amount.toString(), ref: l.ref })) })),
    moved: p.history.filter((h) => h.amount !== 0n).length,
    median: p.amount.toString(),
    medianMonth: formatMonthYear(p.medianMonth.year, p.medianMonth.month),
    floor: p.floor.toString(),
    until: formatDate(p.date),
    monthName: monthName(p.month),
    banks: p.banks,
    reversal: formatDate(p.reversalDate),
    warning: p.warning,
    blocked: p.blocked,
  };
}

const accrualMoney = (f: AccrualFacts, minor: string) => formatMoney(BigInt(minor), f.currency);

function accrualRule(f: AccrualFacts): Check[] {
  const median = accrualMoney(f, f.median);
  return [
    { ok: true, text: `Ada di ${f.moved} dari ${HISTORY_MONTHS} bulan (paling sedikit ${MIN_MONTHS}), tidak ada bulan yang minus.` },
    { ok: true, text: `Setiap bulan dalam 25 % dari nilai tengah ${median}.` },
    { ok: true, text: `Nilai tengah ${median} tidak kurang dari batas materialitas ${accrualMoney(f, f.floor)}.` },
  ];
}

function accrualMonth(f: AccrualFacts): string[] {
  const out =
    f.bucket === "bank"
      ? [`Tidak ada mutasi ${f.counterparty} sampai ${f.until}.`, `Rekening koran ${f.banks.join(" dan ")} lengkap sampai ${f.until}.`]
      : f.bucket === "contact"
        ? [`Tidak ada tagihan atau pembayaran ${f.counterparty} sampai ${f.until}.`]
        : [`Tidak ada baris ${f.account.code} di buku besar yang diimpor sampai ${f.until}.`, `Buku besar ${f.monthName} sudah diimpor.`];
  return [...out, ...(f.warning ? [f.warning] : [])];
}

/** The accrual's five steps, in the panel's words. */
export function accrualSteps(f: AccrualFacts): ReasoningStep[] {
  const account = `${f.account.code} ${f.account.name}`;
  return [
    {
      label: "Riwayat dibaca",
      lines: f.months.map((m) => (m.rows.length ? `${m.label}: ${accrualMoney(f, m.amount)} (${m.rows.length} baris)` : `${m.label}: tidak ada`)),
      rows: f.months.flatMap((m) => m.rows.map((r) => ({ date: r.date, text: r.text, amount: accrualMoney(f, r.amount), account: f.account.code, how: r.source, cited: true }))),
    },
    { label: "Aturan", lines: [], checks: accrualRule(f), note: NO_AI },
    { label: "Bulan ini", lines: accrualMonth(f) },
    {
      label: "Nominal",
      lines: [
        `${accrualMoney(f, f.median)}, nilai tengah riwayat (${f.medianMonth}).`,
        `Debit ${account} · Kredit ${f.credit ? `${f.credit.code} ${f.credit.name}` : "dipilih akuntan"} · dibalik otomatis ${f.reversal}.`,
      ],
    },
    { label: "Belum dicatat", lines: [f.blocked ?? "Tidak ada yang dicatat sampai Anda menyetujui usulan ini."] },
  ];
}

export function accrualCsvRows(f: AccrualFacts): CsvRow[] {
  const minor = (v: string): [string, string] => [accrualMoney(f, v), v];
  const out: CsvRow[] = [];
  for (const m of f.months) {
    for (const r of m.rows) out.push(["Riwayat dibaca", "Baris", r.text, r.date, ...minor(r.amount), f.currency, f.account.code, r.source, "ya", r.ref]);
    out.push(["Riwayat dibaca", `Bulan ${m.label}`, m.rows.length ? `${m.rows.length} baris` : "tidak ada", null, ...minor(m.amount), f.currency, f.account.code, null, null, "Jumlah baris bulan ini"]);
  }
  out.push(...accrualRule(f).map((c) => row("Aturan", "Lolos", c.text, "Aturan Usulan akrual")));
  out.push(["Aturan", "Batas materialitas", "1 % volume Laba Rugi rata-rata bulanan", null, ...minor(f.floor), f.currency, null, null, null, "Pindai buku besar"]);
  out.push(...accrualMonth(f).map((t) => row("Bulan ini", "Fakta", t, "Buku besar dan rekening koran")));
  out.push(["Nominal", "Nilai tengah", f.medianMonth, null, ...minor(f.median), f.currency, f.account.code, null, null, "Aturan Usulan akrual"]);
  out.push(row("Nominal", "Tanpa AI", NO_AI, "Aturan Usulan akrual"));
  return out;
}

// ---- one entry point for the action and the download ----

export type ReasoningFacts = BankFacts | DraftFacts | AccrualFacts;

/** A Kotak or Review item of the client by id: an AI bank line, an AI draft or an accrual proposal (its key). Anything else is NOT_FOUND. */
export async function reasoningFor(db: Db, scope: { firmId: string; clientId: string }, id: string): Promise<ReasoningFacts> {
  if (id.startsWith(ACCRUAL_PREFIX)) return accrualReasoning(db, scope, id);
  const isLine = (await db.bankTransaction.count({ where: { id } })) > 0;
  return isLine ? bankReasoning(db, scope, id) : draftReasoning(db, scope, id);
}

export const reasoningSteps = (f: ReasoningFacts) => (f.kind === "bank" ? bankSteps(f) : f.kind === "draft" ? draftSteps(f) : accrualSteps(f));
export const reasoningCsv = (f: ReasoningFacts) => toCsv(CSV_HEADER, f.kind === "bank" ? bankCsvRows(f) : f.kind === "draft" ? draftCsvRows(f) : accrualCsvRows(f));
