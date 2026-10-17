import type { AccountType, Direction, TaxTag } from "@/lib/generated/prisma/enums";
import { isClassifiable, TAX_TAG_LABEL } from "@/lib/coa/template";
import { isGenericKey } from "@/lib/import/normalize";
import { formatRupiah } from "@/lib/money";
import { DRAFT_KEYS, KIND_LABEL, MAX_SENTENCE, type DraftField, type DraftJson, type InstructionKind } from "@/lib/instructions/labels";

/**
 * Instruksi kantor (cycle 2026-10-18-instruksi-kantor, accounting-rules 13, 14, 22d, 20e): a plain-Bahasa sentence read by Buku's own
 * deterministic reader into exactly one compiled form, validated by one closed schema (the same for the reader's and the AI's output).
 * Pure: no database, no model. Nothing here runs at import or control time; run time reads only the stored typed fields.
 */
export { DRAFT_KEYS, KIND_LABEL, MAX_SENTENCE, ORIGIN_LABEL, PATTERNS_LINE, type DraftField, type DraftJson, type InstructionKind } from "@/lib/instructions/labels";
export type InstructionDraft = {
  kind: InstructionKind;
  /** Upper case, 3–60 characters; a case-insensitive substring of the bank description. */
  pattern: string | null;
  direction: Direction | null;
  accountCode: string | null;
  taxTag: TaxTag | null;
  /** Whole Rupiah. */
  minAmount: bigint | null;
  /** With minAmount: true = at least, false = strictly above. */
  inclusive: boolean;
};
/** One account of the charts in scope (their union by code): what the reader and the validator may target. */
export type ScopeAccount = { code: string; name: string; type: AccountType; classifiable: boolean; transfer: boolean };

/** An account row (or a template seed) as the reader sees it. */
export const scopeAccount = (a: { code: string; name: string; type: AccountType; fsLine: string; isBank?: boolean; isSuspense?: boolean; isRetained?: boolean; isClearing?: boolean; isIntercompany?: boolean }): ScopeAccount => ({
  code: a.code,
  name: a.name,
  type: a.type,
  classifiable: isClassifiable({ isBank: !!a.isBank, isSuspense: !!a.isSuspense, isRetained: !!a.isRetained, fsLine: a.fsLine }),
  transfer: !!a.isClearing || !!a.isIntercompany,
});

export const NOT_UNDERSTOOD = "Buku belum memahami kalimat ini.";
export const REFUSAL = {
  empty: "Tulis instruksinya dulu.",
  long: `Instruksi maksimal ${MAX_SENTENCE} karakter.`,
  journal: "Instruksi tidak membuat jurnal. Untuk jurnal berulang, pakai Jadwal di Jurnal Penyesuaian.",
  flux: "Ambang fluktuasi diatur di Pengaturan kantor → Otomasi.",
  holdAmount: "Untuk menahan semua mutasi di atas nominal tertentu, isi Batas nominal di Otomasi. Instruksi tahan perlu kata kunci.",
  split: "Pecah transaksi dilakukan per mutasi, di Review atau Buku Besar.",
  ai: "Instruksi kantor tidak mengatur AI atau persetujuan. Usulan AI selalu menunggu persetujuan Anda.",
  date: "Syarat tanggal belum didukung. Instruksi berlaku sejak disetujui.",
  multiple: "Tulis satu instruksi per baris.",
  fraction: "Nominal harus bulat dalam Rupiah, tanpa sen.",
  transfer: "Transfer antar rekening dipasangkan oleh Buku, bukan oleh aturan.",
} as const;
export const genericKeyword = (k: string) => `Kata kunci "${k}" tidak menyebut pengirim atau penerima, jadi tidak bisa dijadikan aturan.`;
export const notTarget = (code: string) => `Akun ${code} tidak bisa menjadi tujuan aturan.`;
export const notInChart = (code: string) => `Akun ${code} tidak ada di bagan akun klien ini.`;
export const duplicateMessage = (sentence: string) => `Sudah ada instruksi aktif untuk kata kunci ini: "${sentence}". Matikan dulu bila ingin menggantinya.`;

export type Refusal = { ok: false; error: string; field?: DraftField; /** An explicit refusal: *Susun dengan AI* is not offered. */ refused: boolean };
export type Compiled = { ok: true; draft: InstructionDraft; notes: string[] } | Refusal;

// ---- amounts -------------------------------------------------------------------------------------------------------------------

const UNIT: Record<string, number> = { jt: 6, juta: 6, rb: 3, ribu: 3, k: 3, m: 9, miliar: 9, milyar: 9, mlr: 9 };
const NUMBER = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?`;
const UNITS = String.raw`jt|juta|rb|ribu|miliar|milyar|mlr|m|k`;
/** An amount as written: "Rp10 jt", "10 juta", "Rp 10.000.000", "500 rb", "1,5 M". Groups: rp, number, unit. */
const AMOUNT = String.raw`(rp\.?\s*)?(${NUMBER})(?:\s*(${UNITS})\b)?`;
const OPERATOR = String.raw`(>=|≥|>|lebih dari|di atas|diatas|melebihi|minimal|paling sedikit|sekurang-kurangnya|mulai|min\.)`;
const INCLUSIVE = new Set([">=", "≥", "minimal", "paling sedikit", "sekurang-kurangnya", "mulai", "min."]);

class FractionError extends Error {}
class MultipleError extends Error {}

/** Whole Rupiah from a number and its unit, in bigint (never a float). Null = not an amount; FractionError = a fraction of a Rupiah. */
function readNumber(text: string, unit: string | undefined): bigint | null {
  const power = unit ? UNIT[unit] : 0;
  let whole: string;
  let fraction = "";
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(text)) {
    const [w, f] = text.split(",");
    whole = w.replace(/\./g, "");
    fraction = f ?? "";
  } else if (/^\d+(?:,\d+)?$/.test(text)) {
    [whole, fraction = ""] = text.split(",");
  } else if (/^\d+\.\d{1,2}$/.test(text) && power > 0) {
    [whole, fraction] = text.split("."); // "1.5 jt": a dot before one or two digits is a decimal point only with a unit
  } else return null;
  if (whole.length > 15) return null;
  const extra = fraction.slice(power);
  if (/[1-9]/.test(extra)) throw new FractionError();
  return BigInt(whole) * 10n ** BigInt(power) + BigInt(fraction.slice(0, power).padEnd(power, "0") || "0");
}

/** Every amount the sentence writes as money (with Rp, a unit, thousands dots or after an operator): the only amounts an AI draft may use. */
export function amountsIn(sentence: string): bigint[] {
  const text = normalise(sentence);
  const out: bigint[] = [];
  for (const m of text.matchAll(new RegExp(String.raw`(?:${OPERATOR}\s*)?${AMOUNT}`, "g"))) {
    const [, op, rp, num, unit] = m;
    if (!op && !rp && !unit && !/\./.test(num)) continue; // a bare number is an account code or a reference, not money
    try {
      const v = readNumber(num, unit);
      if (v !== null && v > 0n) out.push(v);
    } catch (e) {
      if (!(e instanceof FractionError)) throw e;
    }
  }
  return out;
}

/** The first "operator amount" clause: its value, operator and where it sits, so the reader can cut it out. */
function amountClause(text: string): { value: bigint; inclusive: boolean; start: number; end: number } | null {
  const m = new RegExp(String.raw`${OPERATOR}\s*${AMOUNT}`).exec(text);
  if (!m) return null;
  const value = readNumber(m[3], m[4]);
  if (value === null) return null;
  return { value, inclusive: INCLUSIVE.has(m[1]), start: m.index, end: m.index + m[0].length };
}

// ---- the reader ----------------------------------------------------------------------------------------------------------------

const QUOTE = /["“”„'‘’]([^"“”„'‘’]{1,80})["“”„'‘’]/;
const PLACEHOLDER = "⁣kw⁣";
const normalise = (s: string) => ` ${s.toLowerCase().replace(/->|=>|→/g, " → ").replace(/\s+/g, " ").trim()} `;

const MONTHS = "januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember";
const REFUSALS: [RegExp, string][] = [
  [new RegExp(String.raw`\b(sebelum|setelah|sesudah|sejak|mulai|sampai|hingga|bulan)\s+(tanggal|tgl|${MONTHS})\b|\btanggal\s+\d|\btgl\.?\s*\d`), REFUSAL.date],
  [/\b(jurnal|akrual\w*|akru\w*|susutkan|penyusutan|disusutkan|amortisasi\w*|setiap bulan|tiap bulan)\b/, REFUSAL.journal],
  [/\b(bagi|dibagi|bagikan|pecah|dipecah|split|sebagian)\b|\b\d+\s*\/\s*\d+\b/, REFUSAL.split],
  [/%|\b(naik|turun|fluktuasi|persen)\b/, REFUSAL.flux],
  [/\b(ai|minta persetujuan|persetujuan|disetujui|partner harus|approval|approve)\b/, REFUSAL.ai],
];

const IN_WORDS = ["uang masuk", "transfer masuk", "penerimaan", "setoran", "masuk", "terima", "diterima"];
const OUT_WORDS = ["uang keluar", "transfer keluar", "pengeluaran", "pembayaran", "keluar", "bayar", "dibayar"];
const DIRECTION_OF = new Map<string, Direction>([...IN_WORDS.map((w) => [w, "IN"] as const), ...OUT_WORDS.map((w) => [w, "OUT"] as const)]);
/** A leading direction phrase ("uang masuk dari", "pembayaran ke", "semua mutasi"): its direction, if any, and the rest. */
const LEAD = new RegExp(String.raw`^(?:(?:semua|setiap)\s+)?(?:(?:mutasi|transaksi)(?:\s+|$))?(${[...IN_WORDS, ...OUT_WORDS].join("|")})?(?:\s+(?:dari|ke|kepada|untuk|oleh))?(?:\s+|$)`);

function lead(text: string): { direction: Direction | null; rest: string } {
  const m = LEAD.exec(text.trim());
  if (!m || !m[0]) return { direction: null, rest: text.trim() };
  return { direction: m[1] ? DIRECTION_OF.get(m[1])! : null, rest: text.trim().slice(m[0].length) };
}

/** The keyword as stored: the quoted text when there is one, else the fragment without filler words, upper case. */
function keywordOf(fragment: string, quoted: string | null): { pattern: string | null; direction: Direction | null } {
  let f = fragment.replace(/[.,;:!?]+/g, " ").replace(/\s+/g, " ").trim();
  let direction: Direction | null = null;
  // "BIAYA ADM" keluar → 6190: a direction word right after the keyword.
  const tail = /\s(keluar|masuk)$/.exec(` ${f}`);
  if (tail) {
    direction = DIRECTION_OF.get(tail[1])!;
    f = f.slice(0, f.length - tail[1].length).trim();
  }
  f = f.replace(/^(?:(?:yang|keterangan(?:nya)?|memuat|berisi|mengandung|dari|ke|kepada|untuk|dengan)\s+)+/, "").replace(/\s+(?:yang|selalu)$/, "").trim();
  // "BIAYA ADM dan BIAYA TRF selalu 7100": two keywords are two instructions.
  if (/(?:^|\s)dan(?:\s|$)/.test(f.replace(PLACEHOLDER, " "))) throw new MultipleError();
  if (quoted !== null) return { pattern: f.includes(PLACEHOLDER) ? quoted.trim().replace(/\s+/g, " ").toUpperCase() || null : null, direction };
  return { pattern: f ? f.toUpperCase() : null, direction };
}

const TAX_WORDS: [RegExp, TaxTag][] = [
  [/\bppn masukan\b/, "PPN_MASUKAN"],
  [/\bppn keluaran\b/, "PPN_KELUARAN"],
  [/\bpph\s*21\b/, "PPH_21"],
  [/\bpph\s*23\b/, "PPH_23"],
  [/\bpph\s*4\s*(?:\(\s*2\s*\)|ayat\s*2)/, "PPH_4_2"],
  [/\bpph\s*25\b/, "PPH_25"],
];

const fail = (error: string, refused: boolean, field?: DraftField): Refusal => ({ ok: false, error, refused, ...(field ? { field } : {}) });
const notUnderstood = () => fail(NOT_UNDERSTOOD, false);

/** The account part of an *Aturan akun*: a code or a name matching exactly one account, optionally a tax tag by its label. */
function readAccount(part: string, accounts: ScopeAccount[]): { code: string; taxTag: TaxTag | null } | Refusal {
  let text = part.replace(/[.;!?]+\s*$/, "").trim();
  const tags = TAX_WORDS.filter(([re]) => re.test(text));
  if (tags.length > 1) return fail(REFUSAL.multiple, true);
  const taxTag = tags[0]?.[1] ?? null;
  if (tags.length) text = text.replace(tags[0][0], " ").replace(/\b(dengan|pajak|dan)\b|[+,]/g, " ").replace(/\s+/g, " ").trim();
  const codes = text.match(/\b\d{3,6}\b/g) ?? [];
  if (codes.length > 1) return fail(REFUSAL.multiple, true);
  if (codes.length === 1) return { code: codes[0], taxTag };
  const name = text.replace(/^akun\s+/, "").trim();
  if (!name) return notUnderstood();
  const hits = accounts.filter((a) => a.name.toLowerCase() === name);
  if (hits.length === 1) return { code: hits[0].code, taxTag };
  if (hits.length > 1) return fail(`Nama akun "${name}" cocok dengan lebih dari satu akun. Tulis kodenya.`, true, "accountCode");
  return notUnderstood();
}

const TYPE_DIRECTION: Partial<Record<AccountType, { direction: Direction; word: string }>> = { BEBAN: { direction: "OUT", word: "uang keluar, karena %s akun beban" }, PENDAPATAN: { direction: "IN", word: "uang masuk, karena %s akun pendapatan" } };

/**
 * Buku's own reader (deterministic). Returns one compiled draft and notes for the preview, an explicit refusal with its reason, or
 * "not understood" (`refused: false`, where *Susun dengan AI* may be offered). The draft has already passed `validateDraft`.
 */
export function parseInstruction(sentence: string, accounts: ScopeAccount[]): Compiled {
  const raw = sentence.trim();
  if (!raw) return fail(REFUSAL.empty, true);
  if (raw.length > MAX_SENTENCE) return fail(REFUSAL.long, true);
  if (raw.split(/\r?\n/).filter((l) => l.trim()).length > 1 || raw.includes(";")) return fail(REFUSAL.multiple, true);
  const q = QUOTE.exec(raw);
  const quoted = q ? q[1] : null;
  const t = normalise(q ? raw.replace(q[0], ` ${PLACEHOLDER} `) : raw);
  for (const [re, message] of REFUSALS) if (re.test(t)) return fail(message, true);
  const flag = /^ (tandai|cek|periksa|awasi|daftar(?:kan)?)\b/.test(t);
  const verbs = (t.match(/\bselalu\b/g)?.length ?? 0) + (t.match(/ → | = /g)?.length ?? 0);
  if (verbs > 1 || (flag && verbs > 0)) return fail(REFUSAL.multiple, true);

  let r: Compiled;
  try {
    if (flag) r = readFlag(t.replace(/^ \S+/, ""), quoted);
    else if (/^ tahan\b/.test(t) || /\b(?:ke|di|masuk) review\b/.test(t)) r = readHold(t, quoted);
    else r = readRule(t, quoted, accounts);
  } catch (e) {
    if (e instanceof FractionError) return fail(REFUSAL.fraction, true, "minAmount");
    if (e instanceof MultipleError) return fail(REFUSAL.multiple, true);
    throw e;
  }
  if (!r.ok) return r;
  const v = validateDraft(toJson(r.draft), accounts);
  return v.ok ? { ok: true, draft: v.draft, notes: r.notes } : v;
}

function readFlag(body: string, quoted: string | null): Compiled {
  const clause = amountClause(body);
  if (!clause) return notUnderstood();
  // Words on either side of the amount are the direction phrase and the keyword ("tandai pengeluaran > Rp10 jt ke TOKOPEDIA" too).
  const before = body.slice(0, clause.start) + " " + body.slice(clause.end);
  const { direction, rest } = lead(before);
  const kw = keywordOf(rest, quoted);
  return { ok: true, draft: { kind: "FLAG", pattern: kw.pattern, direction: direction ?? kw.direction, accountCode: null, taxTag: null, minAmount: clause.value, inclusive: clause.inclusive }, notes: [] };
}

function readHold(t: string, quoted: string | null): Compiled {
  const clause = amountClause(t);
  let body = clause ? t.slice(0, clause.start) + " " + t.slice(clause.end) : t;
  body = body.replace(/^\s*tahan\b/, " ").replace(/\b(?:selalu\s+)?(?:masuk\s+|dikirim\s+)?(?:ke|di)\s+review\b/, " ").replace(/\bselalu\b/, " ");
  const { direction, rest } = lead(body);
  const kw = keywordOf(rest, quoted);
  if (!kw.pattern) return clause ? fail(REFUSAL.holdAmount, true) : notUnderstood();
  return { ok: true, draft: { kind: "HOLD", pattern: kw.pattern, direction: direction ?? kw.direction, accountCode: null, taxTag: null, minAmount: clause?.value ?? null, inclusive: clause?.inclusive ?? false }, notes: [] };
}

function readRule(t: string, quoted: string | null, accounts: ScopeAccount[]): Compiled {
  if (amountClause(t)) return notUnderstood();
  const { direction: led, rest } = lead(t);
  const body = ` ${rest} `;
  const verb =
    /\sselalu\s+(?:(?:masuk|dicatat|dibukukan|catat)\s+)?(?:(?:ke|di)\s+)?(?:akun\s+)?/.exec(body) ??
    / → | = /.exec(body) ??
    [...body.matchAll(/\s(?:masuk\s+)?ke\s+(?:akun\s+)?/g)].at(-1) ??
    null;
  if (!verb || verb.index === undefined) return notUnderstood();
  const kw = keywordOf(body.slice(0, verb.index), quoted);
  if (!kw.pattern) return notUnderstood();
  const target = readAccount(body.slice(verb.index + verb[0].length), accounts);
  if ("ok" in target) return target;
  let direction = led ?? kw.direction;
  const notes: string[] = [];
  if (!direction) {
    const type = accounts.find((a) => a.code === target.code)?.type;
    const inferred = type ? TYPE_DIRECTION[type] : undefined;
    if (inferred) {
      direction = inferred.direction;
      notes.push(`Arah: ${inferred.word.replace("%s", target.code)}.`);
    }
  }
  return { ok: true, draft: { kind: "ACCOUNT", pattern: kw.pattern, direction, accountCode: target.code, taxTag: target.taxTag, minAmount: null, inclusive: false }, notes };
}

// ---- the closed schema ---------------------------------------------------------------------------------------------------------

export const toJson = (d: InstructionDraft): DraftJson => ({ ...d, minAmount: d.minAmount === null ? null : d.minAmount.toString() });

const KINDS = new Set<string>(["ACCOUNT", "FLAG", "HOLD"]);
const TAX_TAGS = new Set<string>(Object.keys(TAX_TAG_LABEL));

/**
 * The one validator for the reader's output, the AI's answer and the accountant's edits: exactly the draft's keys, each of its type,
 * and the rules a run-time form needs (a keyword naming someone, 3–60 characters; an account a rule may target in a chart in scope;
 * an amount above zero in whole Rupiah; nothing a kind does not use). Duplicates against active instructions are checked with the
 * database (lib/instructions/store.ts).
 */
export function validateDraft(raw: unknown, accounts: ScopeAccount[]): { ok: true; draft: InstructionDraft } | Refusal {
  const bad = (error: string, field?: DraftField) => fail(error, false, field);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad(NOT_UNDERSTOOD);
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !(DRAFT_KEYS as readonly string[]).includes(k));
  if (unknown.length) return bad(`Isian instruksi tidak dikenal: ${unknown.slice(0, 3).join(", ")}.`);
  const missing = DRAFT_KEYS.filter((k) => !(k in o));
  if (missing.length) return bad(`Isian instruksi kurang: ${missing.join(", ")}.`);
  if (typeof o.kind !== "string" || !KINDS.has(o.kind)) return bad("Jenis instruksi tidak dikenal.", "kind");
  const kind = o.kind as InstructionKind;

  if (o.pattern !== null && typeof o.pattern !== "string") return bad("Kata kunci tidak valid.", "pattern");
  const pattern = typeof o.pattern === "string" ? o.pattern.replace(/\s+/g, " ").trim().toUpperCase() || null : null;
  if (pattern === null && kind !== "FLAG") return bad("Isi kata kuncinya.", "pattern");
  if (pattern !== null && (pattern.length < 3 || pattern.length > 60)) return bad("Kata kunci harus 3–60 karakter.", "pattern");
  if (pattern !== null && isGenericKey(pattern)) return { ...bad(genericKeyword(pattern), "pattern"), refused: true };

  if (o.direction !== null && o.direction !== "IN" && o.direction !== "OUT") return bad("Arah tidak valid.", "direction");
  const direction = o.direction as Direction | null;

  if (o.accountCode !== null && typeof o.accountCode !== "string") return bad("Akun tidak valid.", "accountCode");
  const accountCode = typeof o.accountCode === "string" ? o.accountCode.trim() || null : null;
  if (kind === "ACCOUNT") {
    if (!accountCode) return bad("Pilih akunnya.", "accountCode");
    const a = accounts.find((x) => x.code === accountCode);
    if (!a) return { ...bad(notInChart(accountCode), "accountCode"), refused: true };
    if (a.transfer) return { ...bad(REFUSAL.transfer, "accountCode"), refused: true };
    if (!a.classifiable) return { ...bad(notTarget(accountCode), "accountCode"), refused: true };
  } else if (accountCode !== null) return bad("Hanya aturan akun yang memakai akun.", "accountCode");

  if (o.taxTag !== null && (typeof o.taxTag !== "string" || !TAX_TAGS.has(o.taxTag))) return bad("Pajak tidak dikenal.", "taxTag");
  const taxTag = o.taxTag as TaxTag | null;
  if (taxTag !== null && kind !== "ACCOUNT") return bad("Hanya aturan akun yang memakai pajak.", "taxTag");

  let minAmount: bigint | null = null;
  if (typeof o.minAmount === "bigint") minAmount = o.minAmount;
  else if (typeof o.minAmount === "string" && /^\d{1,15}$/.test(o.minAmount)) minAmount = BigInt(o.minAmount);
  else if (typeof o.minAmount === "number" && Number.isSafeInteger(o.minAmount)) minAmount = BigInt(o.minAmount);
  else if (o.minAmount !== null) return bad("Isi nominal Rupiah bulat lebih dari 0.", "minAmount");
  if (minAmount !== null && (minAmount <= 0n || minAmount >= 10n ** 15n)) return bad("Isi nominal Rupiah bulat lebih dari 0.", "minAmount");
  if (kind === "FLAG" && minAmount === null) return bad("Isi nominalnya.", "minAmount");
  if (kind === "ACCOUNT" && minAmount !== null) return bad("Aturan akun tidak memakai nominal.", "minAmount");
  if (typeof o.inclusive !== "boolean") return bad("Pilih di atas atau minimal.", "inclusive");
  return { ok: true, draft: { kind, pattern, direction, accountCode, taxTag, minAmount, inclusive: minAmount !== null && o.inclusive } };
}

export const sameDraft = (a: InstructionDraft, b: InstructionDraft) => DRAFT_KEYS.every((k) => a[k] === b[k]);

// ---- words ---------------------------------------------------------------------------------------------------------------------

const DIRECTION_WORD = { IN: "masuk", OUT: "keluar", BOTH: "keduanya" } as const;
const dirWord = (d: Direction | null) => DIRECTION_WORD[d ?? "BOTH"];
const subject = (d: Direction | null) => (d === "OUT" ? "Mutasi keluar" : d === "IN" ? "Mutasi masuk" : "Mutasi");
const noun = (d: Direction | null) => (d === "OUT" ? "pengeluaran" : d === "IN" ? "penerimaan" : "mutasi");
const threshold = (d: Pick<InstructionDraft, "minAmount" | "inclusive">) => (d.minAmount === null ? "" : `${d.inclusive ? "minimal" : "di atas"} ${formatRupiah(d.minAmount)}`);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A *Tandai* control's title: "Pengeluaran di atas Rp 10.000.000", with the keyword when there is one. */
export const flagTitle = (d: Pick<InstructionDraft, "direction" | "minAmount" | "inclusive" | "pattern">) => capital(`${noun(d.direction)} ${threshold(d)}${d.pattern ? ` yang memuat "${d.pattern}"` : ""}`);
/** A *Tandai* control with nothing to list: "Tidak ada pengeluaran di atas Rp 10.000.000". */
export const flagNone = (d: Pick<InstructionDraft, "direction" | "minAmount" | "inclusive" | "pattern">) => `Tidak ada ${flagTitle(d).charAt(0).toLowerCase()}${flagTitle(d).slice(1)}`;

/** The structured form as one sentence, as the preview and the list show it. */
export function compiledSentence(d: InstructionDraft, o: { accountName?: string | null; firmWide: boolean }): string {
  const memuat = `yang keterangannya memuat "${d.pattern}"`;
  if (d.kind === "ACCOUNT") {
    const account = [d.accountCode, o.accountName].filter(Boolean).join(" ");
    return `${subject(d.direction)} ${memuat} → ${account}${d.taxTag ? `, ${TAX_TAG_LABEL[d.taxTag]}` : ""}, ${o.firmWide ? "sebelum aturan kantor lain" : "sebelum aturan lain klien ini"}.`;
  }
  if (d.kind === "FLAG") return `Tandai di Tutup Buku: ${flagTitle(d).charAt(0).toLowerCase()}${flagTitle(d).slice(1)}.`;
  return `${subject(d.direction)} ${memuat}${d.minAmount !== null ? `, ${threshold(d)},` : ""} menunggu di Review.`;
}

/** Riwayat's short form: `Aturan akun: keluar, memuat "BIAYA ADM" → 6190`. */
export function draftSummary(d: InstructionDraft): string {
  const parts: string[] = [dirWord(d.direction)];
  if (d.kind === "FLAG") parts.push(threshold(d));
  if (d.pattern) parts.push(`memuat "${d.pattern}"${d.kind === "ACCOUNT" ? ` → ${d.accountCode}${d.taxTag ? ` ${TAX_TAG_LABEL[d.taxTag]}` : ""}` : ""}`);
  if (d.kind === "HOLD" && d.minAmount !== null) parts.push(threshold(d));
  return `${KIND_LABEL[d.kind]}: ${parts.join(", ")}`;
}

// ---- keyword hints -------------------------------------------------------------------------------------------------------------

/**
 * Keywords the bank may print for what was typed (its abbreviations): each word of the hint is a prefix, of at least 3 letters, of the
 * typed words, in order. "BIAYA ADM" for "BIAYA ADMIN BANK". The caller ranks them by lines matched.
 */
export function keywordHints(typed: string, candidates: string[]): string[] {
  const words = typed.toUpperCase().split(/\s+/).filter(Boolean);
  const want = words.join(" ");
  const out = new Set<string>();
  for (const c of candidates) {
    const hint = c.toUpperCase().replace(/\s+/g, " ").trim();
    if (!hint || hint === want || out.has(hint)) continue;
    const parts = hint.split(" ");
    let i = 0;
    const fits = parts.every((p) => {
      if (p.length < 3) return false;
      while (i < words.length && !words[i].startsWith(p)) i++;
      if (i === words.length) return false;
      i++;
      return true;
    });
    if (fits) out.add(hint);
  }
  return [...out];
}
