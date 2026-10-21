import type { Classification, ClassifyInput } from "@/lib/classify/types";
import { ACCOUNT_CODES } from "@/lib/coa/template";
import { CHANNEL_WORDS, isGenericKey, merchantKey } from "@/lib/import/normalize";
import { formatDate } from "@/lib/format";
import { formatRupiah } from "@/lib/money";
import { BANK_TEXT_WORDS } from "@/lib/banks";

/**
 * Transfer matcher (accounting-rules 13). Pairs opposite amounts within 2 business days across a client's bank accounts, and only when
 * it is safe to (use-case feedback UC-B2, where a supplier withdrawal netted against a stranger's credit of the same amount):
 * - the description carries a transfer hint or names an own entity — equal amounts alone are too common to trust;
 * - neither description names anyone besides the group's own entities (a supplier, a customer): such a line is a payment, not a transfer;
 * - exactly one candidate on each side. Several candidates are never resolved by picking the nearest date: every line involved goes to
 *   Review with the transfer account suggested and the candidates named.
 * Same entity → 1199 clearing; different entity → 1190 intercompany. A hinted line whose counterpart isn't imported still goes to
 * 1199/1190 when it names an own entity (and nobody else); the clearing controls then surface the open half.
 */
const TRANSFER_HINT = /TRSF|\bTRF\b|TRANSFER|PINDAH ?BUKU|PEMINDAHAN|OVERBOOK|SETOR TUNAI|TARIK TUNAI/i;
const DAY = 86_400_000;
/** A Friday transfer that lands on Tuesday (weekend, SKN clearing) is still the same transfer. */
export const MATCH_BUSINESS_DAYS = 2;
/** Below the auto-post threshold: a transfer suggestion that waits for the reviewer. */
const AMBIGUOUS_CONFIDENCE = 0.8;

/** Banks and their products: naming the other account's bank names no counterparty. */
const BANK_WORDS = new Set(["BANK", "GIRO", "TABUNGAN", ...BANK_TEXT_WORDS]);
/**
 * Words that describe moving the group's own money, or how a bank prints a transfer (Mandiri "Transfer Dana Masuk MCM InhouseTrf",
 * BRI "NBMB … TGL … SDR"), not who it went to. A word missing here only sends an own transfer to Review, never pairs two strangers.
 */
const OWN_TRANSFER_WORDS = new Set(
  ("PEMILIK OWNER SENDIRI ANTAR REKENING REK SWEEP INTERNAL MODAL KEMBALI PENGEMBALIAN TALANGAN OPERASIONAL " +
    "MASUK KELUAR MCM INHOUSETRF INHOUSE NBMB TGL JAM WIB SDR SDRI BPK IBU NO REF CABANG KCP BERITA NOREK ESB").split(" "),
);

/** Legal forms say what kind of body an entity is, not which one: a bank prints "BELIFI" for PT Belifi. */
const LEGAL_FORMS = new Set("PT CV UD PD TBK FIRMA FA KOPERASI PERSERO PERUM YAYASAN".split(" "));

/**
 * Takes the group's own names out of a key's words. A bank may cut a long name ("PT GEMILANG MAHAKAR" for PT Gemilang Mahakarya Nusa)
 * or drop its legal form ("BELIFI" for PT Belifi): a run of at least two of the name's words counts (one when the name, without its
 * legal form, is a single word), the last of them possibly cut short (≥ 3 letters).
 */
function withoutOwnNames(words: string[], ownNames: string[]): string[] {
  const names = ownNames
    .map((n) => merchantKey(n).split(" ").filter((w) => w && !LEGAL_FORMS.has(w)))
    .filter((n) => n.join(" ").length >= 3)
    .sort((a, b) => b.length - a.length);
  const out = [...words];
  for (const name of names) {
    for (let i = 0; i < out.length; i++) {
      let m = 0;
      while (m < name.length && i + m < out.length && out[i + m] === name[m]) m++;
      const cut = i + m < out.length && m < name.length && out[i + m].length >= 3 && name[m].startsWith(out[i + m]) ? 1 : 0;
      if (m + cut < Math.min(2, name.length)) continue;
      const form = i > 0 && LEGAL_FORMS.has(out[i - 1]) ? 1 : 0; // "PT" printed before the name
      out.splice(i - form, m + cut + form);
      i -= 1 + form;
    }
  }
  return out;
}

/**
 * The counterparty a description names besides the group's own entities, or null when it names none. What is left after taking out
 * references, channel words, bank names, own-transfer words and the own entities' names is a name.
 */
export function thirdPartyName(description: string, ownNames: string[]): string | null {
  const words = withoutOwnNames(merchantKey(description).split(" ").filter(Boolean), ownNames);
  const rest = words.filter((w) => /^[A-Z]{2,}$/.test(w) && !BANK_WORDS.has(w) && !OWN_TRANSFER_WORDS.has(w) && !CHANNEL_WORDS.has(w));
  return rest.length && !isGenericKey(rest.join(" ")) ? rest.join(" ") : null;
}

/** Weekdays after the earlier date up to and including the later one (Saturday and Sunday don't count; no holiday calendar). */
export function businessDaysApart(a: Date, b: Date): number {
  const [from, to] = +a <= +b ? [a, b] : [b, a];
  let n = 0;
  for (let t = +from + DAY; t <= +to; t += DAY) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}

/** `matched`: already half of a pair. `pairRefused`: the reviewer took it out of a pair (*Lepas pasangan*); never paired again. */
export type TransferCandidate = ClassifyInput & { matched?: boolean; pairRefused?: boolean };

export function matchTransfers(
  items: TransferCandidate[],
  ownNames: { entityId: string; names: string[] }[],
  /** The intercompany account to record a balance with that company on (its own `1190NN` in a group of three or more, else 1190). */
  intercompanyCode: (counterpartyEntityId: string) => string = () => ACCOUNT_CODES.INTERCOMPANY,
): Map<string, Classification> {
  const result = new Map<string, Classification>();
  const allNames = ownNames.flatMap((e) => e.names);
  ownNames = spellings(ownNames);
  const looksLikeTransfer = (i: TransferCandidate) => !i.matched && !i.pairRefused && (TRANSFER_HINT.test(i.description) || mentionsOwn(i, ownNames));
  const clean = (i: TransferCandidate) => !thirdPartyName(i.description, allNames);
  const hinted = items.filter((i) => looksLikeTransfer(i) && clean(i));
  // Lines with transfer words that name someone else: payments, never paired; their equal-amount counterpart is not left to chance either.
  const naming = items.filter((i) => looksLikeTransfer(i) && !clean(i));
  const outs = hinted.filter((i) => i.amount < 0n);
  const ins = hinted.filter((i) => i.amount > 0n);
  const fits = (o: TransferCandidate, i: TransferCandidate) => i.bankAccountId !== o.bankAccountId && i.amount === -o.amount && businessDaysApart(i.date, o.date) <= MATCH_BUSINESS_DAYS;
  const candidatesOf = new Map(outs.map((o) => [o.id, ins.filter((i) => fits(o, i))]));
  const outsFor = (i: TransferCandidate) => outs.filter((o) => candidatesOf.get(o.id)!.includes(i));
  // `a`'s side of a transfer with `b`: its own money moving (1199), or a balance with b's company, on that company's account.
  const codeFor = (a: TransferCandidate, b: TransferCandidate) => (a.entityId === b.entityId ? ACCOUNT_CODES.CLEARING : intercompanyCode(b.entityId));
  const named = (xs: TransferCandidate[]) => xs.map((y) => `${formatDate(y.date)} ${formatRupiah(y.amount < 0n ? -y.amount : y.amount)}`).join("; ");

  for (const o of outs) {
    const cands = candidatesOf.get(o.id)!;
    if (!cands.length) continue;
    const rivals = outsFor(cands[0]);
    if (cands.length === 1 && rivals.length === 1) {
      const partner = cands[0];
      const same = partner.entityId === o.entityId;
      const reason = same ? "Transfer antar rekening sendiri (pasangan ditemukan)" : "Transfer antar entitas grup (pasangan ditemukan)";
      const c = { method: "TRANSFER" as const, taxTag: null, confidence: 0.99, reason };
      result.set(o.id, { ...c, accountCode: codeFor(o, partner), matchedTxId: partner.id });
      result.set(partner.id, { ...c, accountCode: codeFor(partner, o), matchedTxId: o.id });
      continue;
    }
    // Several lines could be each other's other half: none is chosen. Each one involved waits in Review naming the others.
    const group = new Set([o, ...cands, ...cands.flatMap(outsFor)]);
    for (const x of group) {
      if (result.has(x.id)) continue;
      const own = x.amount < 0n ? candidatesOf.get(x.id)! : outsFor(x); // the lines that could really be its other half
      const others = [...group].filter((y) => y !== x);
      result.set(x.id, {
        method: "TRANSFER",
        accountCode: codeFor(x, own[0]),
        taxTag: null,
        confidence: AMBIGUOUS_CONFIDENCE,
        reason: `Tidak dipasangkan otomatis: ${others.length} mutasi lain bernominal sama ikut cocok (${named(others)}). Pilih akunnya di Review`,
      });
    }
  }

  // Unpaired but hinted: names another group entity → 1190; names its own entity → 1199.
  // Either way the counterpart is pending import; the clearing/intercompany controls track it. Except when a line of the same amount
  // that names someone else sits on the other side: then it may be that line's money, and the reviewer decides.
  for (const i of hinted) {
    if (result.has(i.id) || !TRANSFER_HINT.test(i.description)) continue;
    const lookalike = naming.filter((n) => (i.amount < 0n ? fits(i, n) : fits(n, i)));
    const d = i.description.toUpperCase();
    const other = ownNames.find((e) => e.entityId !== i.entityId && e.names.some((n) => says(d, n)));
    const self = ownNames.find((e) => e.entityId === i.entityId && e.names.some((n) => says(d, n)));
    const code = other ? intercompanyCode(other.entityId) : self ? ACCOUNT_CODES.CLEARING : null;
    if (!code) continue;
    if (lookalike.length) {
      result.set(i.id, {
        method: "TRANSFER",
        accountCode: code,
        taxTag: null,
        confidence: AMBIGUOUS_CONFIDENCE,
        reason: `Bernominal sama dengan mutasi yang menyebut pihak lain (${named(lookalike)}): bukan pasangan otomatis, periksa di Review`,
      });
    } else if (other) {
      result.set(i.id, { method: "TRANSFER", accountCode: code, taxTag: null, confidence: 0.92, reason: "Transfer ke/dari entitas grup (pasangan belum diimpor)" });
    } else {
      result.set(i.id, { method: "TRANSFER", accountCode: code, taxTag: null, confidence: 0.92, reason: "Transfer antar rekening sendiri (pasangan belum diimpor)" });
    }
  }

  // Names another group entity, and all that is left is a short code printed beside the name (BCA BI-FAST "… KE 002 ALFI YANDRA KBB"):
  // too unsure to post, too likely the group's own money to leave on the simple guess (an expense). It waits in Review on 1190.
  // A remark may also repeat one word of the payer's own name ("… Belifi ALFI YANDRA" from PT Belifi Mahajaya Nusantara): that word is the
  // payer, not a third party. Only here, where the result waits in Review; one word never makes a line clean enough to post.
  const ownWords = new Map(ownNames.map((e) => [e.entityId, new Set(e.names.flatMap((n) => merchantKey(n).split(" ")).filter((w) => w.length >= 4 && !LEGAL_FORMS.has(w)))]));
  for (const i of naming) {
    if (result.has(i.id) || !TRANSFER_HINT.test(i.description)) continue;
    const self = ownWords.get(i.entityId);
    const rest = (thirdPartyName(i.description, allNames)?.split(" ") ?? []).filter((w) => !self?.has(w));
    if (rest.some((w) => w.length > 3)) continue;
    const d = i.description.toUpperCase();
    const other = ownNames.find((e) => e.entityId !== i.entityId && e.names.some((n) => says(d, n)));
    const name = other?.names.find((n) => says(d, n));
    if (!name) continue;
    result.set(i.id, {
      method: "TRANSFER",
      accountCode: intercompanyCode(other!.entityId),
      taxTag: null,
      confidence: AMBIGUOUS_CONFIDENCE,
      reason: rest.length
        ? `Menyebut entitas grup ${name}, ditambah "${rest.join(" ")}" yang bukan nama dikenal: periksa sebelum dicatat antar entitas`
        : `Menyebut entitas grup ${name} dan nama perusahaan pengirim sendiri: periksa sebelum dicatat antar entitas`,
    });
  }
  return result;
}

/** The names an entity goes by in bank text: as registered, and without its legal form ("PT BELIFI" is printed "BELIFI"). */
function spellings(ownNames: { entityId: string; names: string[] }[]) {
  return ownNames.map((e) => ({
    entityId: e.entityId,
    names: [...new Set(e.names.flatMap((n) => {
      const bare = n.split(/\s+/).filter((w) => w && !LEGAL_FORMS.has(w)).join(" ");
      return bare.length >= 3 && bare !== n ? [n, bare] : [n];
    }))],
  }));
}

/** A whole-word mention: "BELIFI" in "TRSF KE BELIFI", not in "BELIFIX". */
const says = (description: string, name: string) => new RegExp(`(^|[^A-Z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Z0-9])`).test(description);

function mentionsOwn(i: ClassifyInput, ownNames: { entityId: string; names: string[] }[]) {
  const d = i.description.toUpperCase();
  return ownNames.some((e) => e.names.some((n) => says(d, n)));
}
