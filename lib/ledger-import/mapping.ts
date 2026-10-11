import { recordEvent } from "@/lib/audit";
import { createHash } from "node:crypto";
import type { Db, Tx } from "@/lib/db";
import type { AccountTerm, AccountType, MapMethod } from "@/lib/generated/prisma/enums";
import { AI_BATCH_SIZE, ACCOUNT_MAPPING_PROMPT_VERSION, aiConfig, buildMapPrompt, maxTokensFor, type AiProvider, type MapItem } from "@/lib/ai/provider";
import { AiBudgetError, runBudgetedAi } from "@/lib/ai/budget";
import { ACCOUNT_CODES, COA_TEMPLATE, FS_LINES, type FsLine } from "@/lib/coa/template";
import { templateAccounts } from "@/lib/coa/ensure";

/**
 * Source account → client account mapping (accounting-rules §9a, §17).
 * Order: prior mapping → exact name → keyword rules → AI (names only, cached, capped) → none.
 * Suggestions are stored on SourceAccount.suggested*; only `acceptMappings()` (an explicit click) sets accountId.
 */

export type Suggestion = { accountCode: string; method: MapMethod; confidence: number; reason: string };
type ClientAccount = { code: string; name: string; type: AccountType; fsLine: string; isBank: boolean; isSuspense: boolean; isClearing: boolean };

export const normName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Account type from evidence, strongest first (cycle 2026-09-27-mapping-quality):
 *   1. strong name words — "expense", "payable", "receivable", "revenue"… (HoldCo 41000 "Expense Bank Administration" is an expense);
 *   2. the file's own code scheme, learned from its strongly-named accounts (`learnScheme`) — Chickin's 6xxxx/7xxxx are expenses;
 *   3. weak name words — "bank", "deposit", "equipment", "allowance"… ("Bank Charges" 76024 must not become an asset);
 *   4. the leading digit as a last resort.
 * Order inside the strong list matters: payable/prepaid before revenue ("Prepaid Income Tax", "Income Tax Payable"), revenue
 * before rent/pay ("Pendapatan Sewa" is income, "Sewa Peralatan" an expense).
 */
export type CodeScheme = Map<string, AccountType>;

const STRONG: [RegExp, AccountType, RegExp?][] = [
  [/(akumulasi|accumulat).*(penyusutan|depreciation|amortis|amortiz|deplesi|depletion)/, "ASET"], // contra asset, before "depreciation" reads as an expense
  [/(expense|beban|biaya|cost of|cogs|hpp|harga pokok|\bloss\b|manfaat pajak|bank charges?|bank fees?|admin(istrasi)? bank|provisi|materai|stamp duty)/, "BEBAN", /(prepaid|dibayar di ?muka|accrued|accured|payable|\butang\b|\bhutang\b|unearned|diterima di ?muka|deferred|ditangguhkan)/],
  [/(depreciation|penyusutan|amortisasi|amortization|amortisation)/, "BEBAN", /(accumulated|akumulasi|accumulat)/],
  [/(payable|\butang\b|\bhutang\b|accrued|accured|masih harus|liabilit|kewajiban|long term|jangka panjang|non ?bank|\bloan\b|pinjaman|diterima di ?muka|unearned|customer deposits?|deposit pelanggan|uang muka pelanggan)/, "LIABILITAS", /(loan to|piutang|receivable)/],
  [/(receivable|piutang|loan to|placement|penempatan|investment|investasi|tax asset|dibayar di ?muka|prepaid|advance|uang muka)/, "ASET"],
  [/(revenue|income|pendapatan|penjualan|\bsales\b|\bgain\b)/, "PENDAPATAN", /(payable|receivable|tax payable|diterima di ?muka|unearned|deferred|article|pasal|\bpph\b|prepaid)/],
  [/(\bsewa\b|\brent(al)?\b|\bhonor|\bgaji\b|\bupah\b|salar|\bwages\b)/, "BEBAN", /(prepaid|dibayar di ?muka|advance|uang muka|deposit|guarantee|jaminan|receivable|piutang|accrued|accured|payable|\butang\b|\bhutang\b|pembiayaan|liabilit|hak guna|right of use|akumulasi|accumulat|depreciation|penyusutan|amorti)/],
  [/(capital|modal|saham|shares?|agio|premium|retained|laba ditahan|saldo laba|earnings|dividen|prive)/, "EKUITAS"],
];
const WEAK: [RegExp, AccountType][] = [
  [/(akumulasi|accumulat|allowance|penyisihan)/, "ASET"],
  [/(\bkas\b|\bcash\b|\bbank\b|inventory|persediaan|goods|asset|aset|equipment|peralatan|deposit|guarantee|jaminan)/, "ASET"],
];

/** Type from strong name words only; null when the name is ambiguous. */
export function strongType(name: string): AccountType | null {
  const n = normName(name);
  for (const [re, type, not] of STRONG) if (re.test(n) && !(not && not.test(n))) return type;
  return null;
}

/** Leading digit of a client code after any alpha prefix ("1-1000" → "1", "SKP-UNM-12" → "1"). */
export const codeDigit = (code: string) => code.replace(/^[A-Za-z]+-/, "").match(/\d/)?.[0] ?? null;

/**
 * The chart's own numbering, learned from the accounts whose names leave no doubt: for each leading digit the majority
 * type when ≥ 3 accounts agree ≥ 80 %. Per file, because entities' charts differ.
 */
export function learnScheme(accounts: { code: string; name: string }[]): CodeScheme {
  const votes = new Map<string, Map<AccountType, number>>();
  for (const a of accounts) {
    const d = codeDigit(a.code);
    const t = strongType(a.name);
    if (!d || !t) continue;
    const v = votes.get(d) ?? new Map<AccountType, number>();
    v.set(t, (v.get(t) ?? 0) + 1);
    votes.set(d, v);
  }
  const scheme: CodeScheme = new Map();
  for (const [d, v] of votes) {
    const total = [...v.values()].reduce((s, n) => s + n, 0);
    const [type, n] = [...v.entries()].sort((x, y) => y[1] - x[1])[0];
    if (total >= 3 && n / total >= 0.8) scheme.set(d, type);
  }
  return scheme;
}

export function inferType(code: string, name: string, scheme?: CodeScheme): AccountType | null {
  const strong = strongType(name);
  if (strong) return strong;
  const d = codeDigit(code);
  const learned = d ? scheme?.get(d) : undefined;
  if (learned) return learned;
  const n = normName(name);
  for (const [re, type] of WEAK) if (re.test(n)) return type;
  return d === "1" ? "ASET" : d === "2" ? "LIABILITAS" : d === "3" ? "EKUITAS" : d === "4" ? "PENDAPATAN" : d === "5" || d === "6" ? "BEBAN" : null;
}

/** Keyword rules → template codes. First match wins; `type` guards against e.g. "interest income" hitting a bank rule. */
/**
 * A `generic` rule only says which side of the books a name is on ("expense", "payable"). Instead of piling the client's
 * detail into one catch-all, it proposes a new Buku account named after the client's account under that FS line —
 * unless the name itself is a catch-all ("lain-lain", "other", "misc"). Encoded as `new:<FS_LINE>` in `suggestedCode`.
 */
export const NEW_PREFIX = "new:";
export const newFsLineOf = (code: string | null | undefined): FsLine | null =>
  code?.startsWith(NEW_PREFIX) && (code.slice(NEW_PREFIX.length) as FsLine) in FS_LINES ? (code.slice(NEW_PREFIX.length) as FsLine) : null;
const CATCH_ALL_NAME = /(lain ?lain|lainnya|\bother\b|others|misc|sundry|\bumum\b|general|serba ?serbi)/;

/** `strict`: the name alone is ambiguous ("Bahan Baku" is stock or a purchase), so the rule needs the account's type to be known and in `types`. */
const KEYWORDS: { re: RegExp; code: string; types?: AccountType[]; not?: RegExp; generic?: FsLine; template?: boolean; strict?: boolean }[] = [
  // Right-of-use assets (PSAK 116) have their own template accounts, before the general fixed-asset and depreciation words.
  { re: /((akumulasi|accumulated|accumulation).*(right of use|hak guna|\brou\b))|((right of use|hak guna|\brou\b).*(akumulasi|accumulated|accumulation))/, code: ACCOUNT_CODES.ROU_ACCUMULATED, template: true },
  { re: /(penyusutan|depreciation|amorti[sz]ation|amortisasi).*(right of use|hak guna|\brou\b)/, code: ACCOUNT_CODES.ROU_DEPRECIATION, types: ["BEBAN"], template: true },
  { re: /(akumulasi|accumulated|accumulation).*(penyusutan|depreciation|amortization|amortisasi)/, code: "1219" },
  { re: /(penyusutan|depreciation|amortisasi|amortization)/, code: "6180", types: ["BEBAN"] },
  { re: /(rounding|pembulatan)/, code: ACCOUNT_CODES.ROUNDING },
  { re: /(selisih kurs|foreign exchange|exchange (gain|loss)|forex|\bfx\b|revaluation|revaluasi)/, code: ACCOUNT_CODES.FX_GAIN_LOSS },
  // The P&L side of deferred tax ("Penghasilan Pajak Tangguhan (laba rugi)", "Deferred tax expense/benefit") whatever type the file suggests.
  { re: /^(?=.*(pajak tangguhan|deferred tax))(?=.*(laba rugi|penghasilan|manfaat|benefit|income|expense|beban))/, code: ACCOUNT_CODES.DEFERRED_TAX, template: true },
  { re: /(pajak tangguhan|deferred tax)/, code: ACCOUNT_CODES.DEFERRED_TAX_ASSET, types: ["ASET"], template: true },
  { re: /(pajak tangguhan|deferred tax)/, code: ACCOUNT_CODES.DEFERRED_TAX_LIABILITY, types: ["LIABILITAS"], template: true },
  { re: /(pajak tangguhan|deferred tax)/, code: ACCOUNT_CODES.DEFERRED_TAX, types: ["BEBAN"], template: true },
  { re: /(tax.*interest|pajak bunga|interest tax)/, code: "8200", types: ["BEBAN"] },
  { re: /(interest income|pendapatan bunga|jasa giro|bank interest|bunga bank|bunga tabungan|revenue interest|interest revenue)/, code: "4900", types: ["PENDAPATAN"] },
  { re: /(interest expense|beban bunga|bunga pinjaman|interest p2p)/, code: "7110", types: ["BEBAN"] },
  { re: /(bank charge|admin(istrasi)? bank|biaya bank|bank administration|bank admin|provisi|biaya transfer)/, code: "7100", types: ["BEBAN"] },
  // Card and QR payment fees (MDR) and payment-gateway charges are the cost of being paid, with the bank charges, not marketing.
  { re: /(\b(qris|edc|mdr)\b|merchant discount|payment gateway|gateway fee|biaya gateway|\b(xendit|midtrans|doku|flip|ipaymu)\b.*(fee|admin|biaya|charge))/, code: "7100", types: ["BEBAN"], strict: true },
  // A small asset expensed when bought is supplies, not depreciation.
  { re: /(low value asset|aset (ber)?nilai rendah|inventaris kecil|barang modal kecil)/, code: "6160", types: ["BEBAN"], strict: true },
  { re: /(petty cash|kas kecil|cash in transit|\bkas\b|cash on hand)/, code: "1110", types: ["ASET"], not: /bank/ },
  { re: /\b(bank|giro|tabungan|deposito|time deposits?|call a ?c|ocbc|bca|bri|bni|mandiri|cimb|dbs|uob|citibank|permata|bjb|bsi|btn|maybank|panin|danamon|doku|flip|xendit|midtrans)\b/, code: "1120", types: ["ASET"], not: /(non ?bank|payable|utang|hutang|loan|pinjaman)/ },
  // The allowance always goes to its contra account 1135 (created from the template on posting if the client predates it): netted into
  // 1130 it would reduce receivables a second time once CKPN posts to 1135.
  { re: /(allowance|penyisihan|cadangan kerugian|\becl\b|ckpn)/, code: "1135", types: ["ASET"], template: true },
  { re: /(bad debts?|doubtful|piutang tak tertagih|ckpn|\becl\b|(penyisihan|cadangan|penurunan nilai|impairment).*(piutang|receivable))/, code: "6185", types: ["BEBAN"] },
  { re: /(ppn masukan|vat[- ]?in\b|input vat)/, code: "1150", types: ["ASET"] },
  { re: /(prepaid.*(tax|pajak|\bpph\b|article|pasal)|pajak dibayar di ?muka|uang muka pajak|pph .*dibayar di ?muka|tax receivable)/, code: "1180", types: ["ASET"] },
  // Loans to staff and related parties are other receivables, not trade (1140 below).
  { re: /(trade receivable|piutang usaha|accounts? receivable)/, code: "1130", types: ["ASET"], not: /(employee|karyawan|pegawai|staff|related|berelasi|afiliasi|affiliat|\bloan\b|pinjaman)/ },
  { re: /(persediaan|inventory|supplies|perlengkapan|finished goods|barang jadi|raw material)/, code: "1160", types: ["ASET"] },
  // Biological assets (live birds, livestock) are stock in trade here, never "inventaris" (office equipment) below.
  { re: /(biologis|biological)/, code: "1160", types: ["ASET"] },
  { re: /(bahan baku|bahan kemasan|bahan pendukung|bahan habis pakai|barang dagang|merchandise|seragam|apparel)/, code: "1160", types: ["ASET"], strict: true, not: /(pemakaian|penggunaan|pembelian|usage|consumption|purchase|hpp|beban|biaya)/ },
  { re: /(prepaid|dibayar di ?muka|uang muka|advance|deposit|jaminan|guarantee|deferred (expense|charge|cost)|(beban|biaya) ditangguhkan)/, code: "1170", types: ["ASET"] },
  { re: /(piutang|receivable|loan to)/, code: "1140", types: ["ASET"], generic: "PIUTANG_LAIN" },
  { re: /(right of use|\baset hak guna|\brou\b)/, code: ACCOUNT_CODES.ROU_ASSET, types: ["ASET"], template: true },
  { re: /(intangible|tak berwujud|tidak berwujud|lisensi|licen[cs]e|merk\b|trademark|software|hak guna|goodwill)/, code: "1250", types: ["ASET"] },
  { re: /(investment|investasi|penyertaan|placement|penempatan)/, code: "1260", types: ["ASET"] },
  { re: /(fixed asset|asset in progress|aset dalam penyelesaian|construction in progress|aset tetap|equipment|peralatan|kendaraan|vehicle|building|bangunan|renovation|renovasi|furniture|machine|mesin|\bland\b|tanah|inventaris|\bppe\b|\biot\b)/, code: "1210", types: ["ASET"] },
  // After fixed assets and intangibles: "Kendaraan Sewa" is equipment and "Software Subscription" an intangible; a bare asset-side "Sewa …" / "Asuransi …" is a prepayment.
  { re: /(\bsewa\b|\brent\b|asuransi|insurance|langganan|subscription)/, code: "1170", types: ["ASET"], strict: true, not: /(hak guna|sewa guna|right of use|pembiayaan|akumulasi|accumulated|penyusutan|depreciation|piutang|receivable|pendapatan|revenue|income|klaim|claim|kendaraan|peralatan|mesin|bangunan)/ },
  // Payment settlements in transit (EDC/QRIS/e-wallets) are bank-like balances, not the machines, fees or advances that carry the same word.
  { re: /\b(gopay|ovo|shopeepay|linkaja|qris|edc)\b/, code: "1120", types: ["ASET"], strict: true, not: /(mesin|peralatan|machine|equipment|mdr|komisi|commission|fee|biaya|beban|uang muka|deposit|jaminan)/ },
  { re: /(ppn keluaran|vat[- ]?out\b|output vat)/, code: "2130", types: ["LIABILITAS"] },
  { re: /(pph ?21|article 21|pasal 21)/, code: "2140", types: ["LIABILITAS"] },
  { re: /(pph ?23|article 23|pasal 23)/, code: "2141", types: ["LIABILITAS"] },
  { re: /(pph ?29|article 29|pasal 29)/, code: "2146", types: ["LIABILITAS"] },
  { re: /(tax payable|utang pajak|hutang pajak|article 4|article 25|pasal 4|pasal 25|\bpph\b|\bpb ?1\b|pajak (restoran|hotel|hiburan|reklame|parkir|daerah))/, code: "2145", types: ["LIABILITAS"] },
  { re: /(imbalan kerja|employee benefit|post.?employment|pesangon)/, code: "2310", types: ["LIABILITAS"] },
  { re: /(accrued|accured|masih harus dibayar|accrual|akrual)/, code: "2150", types: ["LIABILITAS"] },
  { re: /(unearned|diterima di muka|deferred revenue|customer deposit|uang muka (pelanggan|penjualan|customer|sales)|advance (from|received)|customer advance)/, code: "2160", types: ["LIABILITAS"] },
  { re: /down ?payment/, code: "2160", types: ["LIABILITAS"], strict: true, not: /(supplier|vendor|pemasok|pembelian|purchase|to |ke )/ },
  { re: /(bank loan|utang bank|hutang bank|pinjaman bank|short term bank|kredit modal|credit card|kartu kredit|\bcc\b)/, code: "2210", types: ["LIABILITAS"] },
  { re: /(short ?term|jangka pendek)/, code: "2120", types: ["LIABILITAS"] },
  { re: /(long ?term|jangka panjang|non ?bank|lease|sewa pembiayaan|loan payable|\bloan\b|pinjaman)/, code: "2300", types: ["LIABILITAS"] },
  { re: /(trade payable|utang usaha|hutang usaha|accounts? payable)/, code: "2110", types: ["LIABILITAS"] },
  { re: /(payable|\butang\b|\bhutang\b|current liabilit|kewajiban lancar)/, code: "2120", types: ["LIABILITAS"], generic: "UTANG_LAIN" },
  { re: /(additional paid|agio|premium|tambahan modal|modal tambahan|\bapic\b)/, code: "3110", types: ["EKUITAS"] },
  { re: /(share capital|modal saham|modal disetor|ordinary shares?|pref+er+ed shares?|paid ?up|capital stock)/, code: "3100", types: ["EKUITAS"] },
  { re: /(retained|saldo laba|laba ditahan|saldo awal|opening balance|accumulated (loss|deficit)|earnings|laba tahun berjalan)/, code: ACCOUNT_CODES.RETAINED, types: ["EKUITAS"] },
  { re: /(prive|dividen|dividend|drawing|penarikan (modal|pemilik))/, code: "3300", types: ["EKUITAS"] },
  // "Modal - <pemegang saham>", "Setoran Modal": paid-in capital, unless the words say otherwise.
  { re: /(\bmodal\b|setoran modal)/, code: "3100", types: ["EKUITAS"], strict: true, not: /(kerja|penyertaan|prive|dividen|drawing|penarikan|ditahan)/ },
  // Taxes that are not on income (vehicle tax, land and building tax, stamp duty, regional levies) are operating expenses.
  { re: /((tax|pajak).*(vehicle|kendaraan|pbb|bumi|bangunan|property|properti|stamp|meterai|materai|retribusi|daerah|reklame|parkir))|\b(pkb|pbb|bphtb)\b/, code: "6190", types: ["BEBAN"] },
  { re: /(income tax expense|beban pajak|pph badan|tax expense|corporate tax)/, code: "8100", types: ["BEBAN"], not: /final/ },
  { re: /(final tax|pph final|4\(2\))/, code: "8200", types: ["BEBAN"] },
  { re: /(other income|pendapatan lain|other revenue|\bgain\b|miscellaneous income)/, code: "4910", types: ["PENDAPATAN"], generic: "PENDAPATAN_LAIN" },
  { re: /(sales|penjualan)/, code: "4100", types: ["PENDAPATAN"] },
  { re: /(revenue|pendapatan|service income|fee income|income)/, code: "4110", types: ["PENDAPATAN"], generic: "PENDAPATAN_USAHA" },
  { re: /(purchase|pembelian|material|bahan baku|raw material)/, code: "5100", types: ["BEBAN"] },
  { re: /(cost of|hpp|harga pokok|beban pokok)/, code: "5110", types: ["BEBAN"] },
  // A production cost is cost of sales whatever else the name says; its own account under HPP keeps the client's detail.
  { re: /(production cost|biaya produksi|beban produksi|makloon|maklon|overhead pabrik|factory overhead|direct labou?r|tenaga kerja langsung)/, code: "5110", types: ["BEBAN"], generic: "HPP" },
  { re: /(salary|salaries|gaji|wages|upah|tunjangan|\bthr\b|bonus|payroll|\binterns?(hip)?\b)/, code: "6100", types: ["BEBAN"] },
  { re: /(bpjs|insurance|asuransi|medication|kesehatan|medical)/, code: "6110", types: ["BEBAN"] },
  { re: /(\brent\b|\bsewa\b|lease expense)/, code: "6120", types: ["BEBAN"] },
  { re: /(electric|listrik|water|pdam|internet|telepon|telecommunication|telephone|utilit)/, code: "6130", types: ["BEBAN"] },
  { re: /(travel|transport|perjalanan|bensin|fuel|logistic|pengiriman|delivery|parkir|toll|freight)/, code: "6140", types: ["BEBAN"] },
  { re: /(marketing|advertis|iklan|promosi|promotion|\bads\b|sponsor)/, code: "6150", types: ["BEBAN"] },
  { re: /(office|kantor|stationer|stationary|\batk\b|printing|alat tulis)/, code: "6160", types: ["BEBAN"] },
  { re: /(professional|legal|audit|consultant|konsultan|notaris|jasa profesional|\bagent\b)/, code: "6170", types: ["BEBAN"] },
  { re: /(expense|beban|biaya)/, code: "6190", types: ["BEBAN"], generic: "BEBAN_UMUM_ADM" },
];

export function deterministicSuggestion(
  src: { code: string; name: string; typeHint: AccountType | null; termHint?: AccountTerm | null },
  ctx: { accounts: ClientAccount[]; priorByName: Map<string, string> },
): Suggestion | null {
  const hit = keywordSuggestion(src, ctx);
  return hit?.method === "PRIOR" || hit?.method === "NAME" ? hit : byTerm(src, hit, ctx.accounts);
}

/**
 * A Neraca lists accounts under "Current" / "Long-term" headings: that beats a generic keyword on the wrong side
 * (a payable under "Long-term Liability" is 2300, not 2120). Specific keywords on the right side are kept.
 */
function byTerm(src: { typeHint: AccountType | null; termHint?: AccountTerm | null; code: string; name: string }, hit: Suggestion | null, accounts: ClientAccount[]): Suggestion | null {
  const type = src.typeHint ?? inferType(src.code, src.name);
  if (!src.termHint || (type !== "ASET" && type !== "LIABILITAS")) return hit;
  const acc = hit ? accounts.find((a) => a.code === hit.accountCode) : undefined;
  const section = acc ? FS_LINES[acc.fsLine as FsLine]?.section : undefined;
  const to = (code: string, why: string): Suggestion | null => {
    const target = accounts.find((a) => a.code === code);
    return target ? { accountCode: code, method: "KEYWORD", confidence: 0.75, reason: `${why} → ${target.code} ${target.name}` } : hit;
  };
  if (type === "LIABILITAS" && src.termHint === "NON_CURRENT" && (!acc || section === "LIABILITAS_JANGKA_PENDEK")) return to("2300", "Di file tercantum di bagian liabilitas jangka panjang");
  if (type === "LIABILITAS" && src.termHint === "CURRENT" && section === "LIABILITAS_JANGKA_PANJANG") return to("2120", "Di file tercantum di bagian liabilitas jangka pendek");
  if (type === "ASET" && src.termHint === "NON_CURRENT" && (!acc || section === "ASET_LANCAR") && !acc?.isBank) return to("1260", "Di file tercantum di bagian aset tidak lancar");
  return hit;
}

function keywordSuggestion(
  src: { code: string; name: string; typeHint: AccountType | null },
  ctx: { accounts: ClientAccount[]; priorByName: Map<string, string> },
): Suggestion | null {
  const n = normName(src.name);
  const prior = ctx.priorByName.get(n);
  if (prior) return { accountCode: prior, method: "PRIOR", confidence: 0.95, reason: "Nama akun sama sudah dipetakan sebelumnya" };
  const exact = ctx.accounts.find((a) => !a.isBank && !a.isSuspense && !a.isClearing && normName(a.name) === n);
  if (exact) return { accountCode: exact.code, method: "NAME", confidence: 0.95, reason: `Nama sama dengan ${exact.code} ${exact.name}` };
  const type = src.typeHint ?? inferType(src.code, src.name);
  for (const k of KEYWORDS) {
    if (!k.re.test(n)) continue;
    if (k.not?.test(n)) continue;
    if (k.types && (type ? !k.types.includes(type) : k.strict)) continue;
    const acc = ctx.accounts.find((a) => a.code === k.code) ?? (k.template ? COA_TEMPLATE.find((a) => a.code === k.code) : undefined);
    if (!acc) continue;
    if (k.generic && !CATCH_ALL_NAME.test(n) && RANGES[k.generic]) {
      return { accountCode: `${NEW_PREFIX}${k.generic}`, method: "NEW", confidence: 0.7, reason: `Hanya kata umum "${n.match(k.re)?.[0]}" yang cocok; usulkan akun baru di ${FS_LINES[k.generic].label} dengan nama dari file` };
    }
    return { accountCode: acc.code, method: "KEYWORD", confidence: 0.8, reason: `Kata kunci "${n.match(k.re)?.[0]}" → ${acc.code} ${acc.name}` };
  }
  return null;
}

export type AccountMapCacheContext = { firmId: string; clientId: string; model: string; clientName: string; accounts: { code: string; name: string; group: string }[]; sourceCode: string };
export function aiMapCacheKey(name: string, typeHint: string | null, coaVersion: number, scope: AccountMapCacheContext) {
  const prompt = buildMapPrompt([{ key: "cache-item", code: scope.sourceCode, name: normName(name), typeHint }], [...scope.accounts].sort((a, b) => a.code.localeCompare(b.code)), scope.clientName);
  return createHash("sha256").update(JSON.stringify(["map", scope.firmId, scope.clientId, coaVersion, scope.model, ACCOUNT_MAPPING_PROMPT_VERSION, prompt])).digest("hex");
}

const TYPE_LABEL: Record<AccountType, string> = { ASET: "Aset", LIABILITAS: "Liabilitas", EKUITAS: "Ekuitas", PENDAPATAN: "Pendapatan", BEBAN: "Beban" };

/** Accounts a source account may map to: the client chart minus bank GL (tied to statements), suspense and clearing. */
async function mappableAccounts(db: Db | Tx, clientId: string): Promise<ClientAccount[]> {
  const all = await db.account.findMany({ where: { clientId }, orderBy: { code: "asc" } });
  return all.filter((a) => !a.isBank && !a.isSuspense && !a.isClearing);
}

/**
 * Fill `suggested*` on every unmapped source account of the client: deterministic first, then AI for the rest.
 * AI runs outside any transaction, one request per ≤15 accounts (AI_BATCH_SIZE), capped by AI_MAX_CALLS_PER_RUN and the monthly budget.
 */
export async function suggestMappings(db: Db, args: { firmId: string; clientId: string; provider: AiProvider | null; useAi: boolean }) {
  const client = await db.client.findUniqueOrThrow({ where: { id: args.clientId, firmId: args.firmId } });
  const accounts = await mappableAccounts(db, args.clientId);
  const sources = await db.sourceAccount.findMany({ where: { clientId: args.clientId }, orderBy: [{ entityId: "asc" }, { code: "asc" }] });
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const codeOfId = new Map((await db.account.findMany({ where: { clientId: args.clientId }, select: { id: true, code: true } })).map((a) => [a.id, a.code]));
  const priorByName = new Map<string, string>();
  for (const s of sources) if (s.accountId) priorByName.set(normName(s.name), codeOfId.get(s.accountId)!);

  const pending = sources.filter((s) => !s.accountId);
  let deterministic = 0;
  const leftovers: typeof pending = [];
  for (const s of pending) {
    const sug = deterministicSuggestion({ code: s.code, name: s.name, typeHint: s.typeHint, termHint: s.termHint }, { accounts, priorByName });
    if (sug) {
      deterministic++;
      await db.sourceAccount.update({ where: { id: s.id }, data: { suggestedCode: sug.accountCode, suggestedBy: sug.method, mapConfidence: sug.confidence, mapReason: sug.reason } });
    } else {
      // The evidence changed (e.g. a richer file re-typed the account) and no rule matches now: an old rule suggestion must not linger.
      if (s.suggestedBy && s.suggestedBy !== "AI") await db.sourceAccount.update({ where: { id: s.id }, data: { suggestedCode: null, suggestedBy: null, mapConfidence: null, mapReason: null } });
      leftovers.push(s);
    }
  }

  let calls = 0;
  let cacheHits = 0;
  let aiAnswered = 0;
  let note: string | undefined;
  if (args.useAi && leftovers.length) {
    const chart = accounts.map((a) => ({ code: a.code, name: a.name, group: `${TYPE_LABEL[a.type]} · ${FS_LINES[a.fsLine as FsLine]?.label ?? a.fsLine}` }));
    const context = `${client.name}${client.industry ? ` (${client.industry})` : ""}`;
    const keyOf = (s: (typeof leftovers)[number]) => aiMapCacheKey(s.name, s.typeHint ?? inferType(s.code, s.name), client.coaVersion, { ...args, model: args.provider?.model ?? "disabled", clientName: context, accounts: chart, sourceCode: s.code });
    const cached = new Map((await db.aiAccountMap.findMany({ where: { cacheKey: { in: leftovers.map(keyOf) } } })).map((c) => [c.cacheKey, c]));
    const misses: typeof leftovers = [];
    for (const s of leftovers) {
      const hit = cached.get(keyOf(s));
      if (hit && byCode.has(hit.accountCode)) {
        cacheHits++;
        await db.sourceAccount.update({ where: { id: s.id }, data: { suggestedCode: hit.accountCode, suggestedBy: "AI", mapConfidence: hit.confidence, mapReason: `AI: ${hit.reason}` } });
      } else {
        if (s.suggestedBy === "AI") await db.sourceAccount.update({ where: { id: s.id }, data: { suggestedCode: null, suggestedBy: null, mapConfidence: null, mapReason: null } });
        misses.push(s);
      }
    }
    // One question per unique (name, type) — the same name in five entities is paid once.
    const unique = new Map<string, (typeof misses)[number]>();
    for (const s of misses) if (!unique.has(keyOf(s))) unique.set(keyOf(s), s);
    const queue = [...unique.values()];
    if (queue.length && !args.provider) note = "AI tidak aktif: isi kunci di Pengaturan, atau petakan manual.";
    else if (queue.length) {
      const cfg = aiConfig();
      for (let i = 0; !note && i < queue.length && calls < cfg.maxCallsPerRun; i += AI_BATCH_SIZE) {
        const batch = queue.slice(i, i + AI_BATCH_SIZE);
        const items: MapItem[] = batch.map((s, j) => ({ key: `a${j}`, code: s.code, name: s.name, typeHint: s.typeHint ?? inferType(s.code, s.name) }));
        try {
          const res = await runBudgetedAi(db, { firmId: args.firmId, scope: `mapping:${args.clientId}`, prompt: buildMapPrompt(items, chart, context), maxCompletionTokens: maxTokensFor(items.length), model: args.provider!.model, keysRequested: items.length, cacheHits, note: "pemetaan akun" }, () => {
            calls++;
            return args.provider!.mapAccounts(items, chart, context);
          });
          for (const a of res.answers) {
            const item = items.find((x) => x.key === a.key);
            // Rule 19: whatever the provider returns, only codes in the client chart survive.
            if (!item || !byCode.has(a.accountCode)) continue;
            const src = batch[items.indexOf(item)];
            const key = keyOf(src);
            await db.aiAccountMap.upsert({
              where: { cacheKey: key },
              create: { cacheKey: key, name: src.name, typeHint: item.typeHint, accountCode: a.accountCode, confidence: a.confidence, reason: a.reason, model: res.model },
              update: {},
            });
            const same = misses.filter((m) => keyOf(m) === key);
            await db.sourceAccount.updateMany({ where: { id: { in: same.map((m) => m.id) } }, data: { suggestedCode: a.accountCode, suggestedBy: "AI", mapConfidence: a.confidence, mapReason: `AI: ${a.reason}` } });
            aiAnswered += same.length;
          }
        } catch (e) {
          note = e instanceof AiBudgetError ? e.message : `AI gagal: ${(e as Error).message.slice(0, 120)}`;
        }
      }
      if (!note && queue.length > calls * AI_BATCH_SIZE) note = "Batas panggilan AI per permintaan tercapai. Klik lagi untuk melanjutkan.";
    }
  }
  return { pending: pending.length, deterministic, cacheHits, aiAnswered, calls, note };
}

export class MappingError extends Error {}

/**
 * The accountant's explicit accept (rule 9a). `items` = source account id → client account code, or
 * `{ newAccount: { fsLine, name } }` to create a client account under an FS line (never a special code).
 * Built for whole files (hundreds of accounts): the chart is read once, new codes are allocated in memory,
 * created in one statement and the mappings written per target account — a handful of queries, not one per row.
 */
export async function acceptMappings(
  db: Db,
  clientId: string,
  items: { sourceAccountId: string; accountCode?: string; newAccount?: { fsLine: FsLine; name: string }; method: MapMethod }[],
  actorId?: string | null,
) {
  return db.$transaction(
    async (tx) => {
      const sources = await tx.sourceAccount.findMany({ where: { id: { in: items.map((i) => i.sourceAccountId) }, clientId } });
      if (sources.length !== new Set(items.map((i) => i.sourceAccountId)).size) throw new MappingError("Akun sumber tidak ditemukan untuk klien ini");
      const nameOf = new Map(sources.map((x) => [x.id, x.name]));
      const client = await tx.client.findUniqueOrThrow({ where: { id: clientId }, select: { firmId: true } });
      const chart = await tx.account.findMany({ where: { clientId }, select: { id: true, code: true, name: true, isBank: true, isSuspense: true, isClearing: true } });
      const byCode = new Map(chart.map((a) => [a.code, a]));
      const used = new Set(chart.map((a) => a.code));
      // One shared client chart: the same name from several entities (or accepted twice) is one account, not one per row.
      const byName = new Map<string, string>();
      for (const a of chart) if (!a.isBank && !a.isSuspense && !a.isClearing) byName.set(normName(a.name), a.code);

      // A template account the client predates (e.g. 1135) is created on first use when its code is free.
      const templateCodes = [...new Set(items.flatMap((it) => (!it.newAccount && it.accountCode && !byCode.has(it.accountCode) && COA_TEMPLATE.some((a) => a.code === it.accountCode) ? [it.accountCode] : [])))];
      if (templateCodes.length) {
        await templateAccounts(tx, clientId, templateCodes);
        for (const a of await tx.account.findMany({ where: { clientId, code: { in: templateCodes } }, select: { id: true, code: true, name: true, isBank: true, isSuspense: true, isClearing: true } })) {
          byCode.set(a.code, a);
          used.add(a.code);
          if (!a.isBank && !a.isSuspense && !a.isClearing) byName.set(normName(a.name), a.code);
        }
      }

      const toCreate: { code: string; name: string; fsLine: FsLine }[] = [];
      const plan: { sourceAccountId: string; code: string; mappedBy: MapMethod }[] = [];
      for (const it of items) {
        let code = it.accountCode;
        // A `new:<FS_LINE>` suggestion accepted as-is creates the account under that line, named after the client's account.
        const suggestedLine = it.newAccount ? null : newFsLineOf(it.accountCode);
        const newAccount = it.newAccount ?? (suggestedLine ? { fsLine: suggestedLine, name: nameOf.get(it.sourceAccountId)! } : null);
        if (newAccount) {
          const existing = byName.get(normName(newAccount.name));
          if (existing) code = existing;
          else {
            code = allocateAccountCode(newAccount.fsLine, used);
            used.add(code);
            byName.set(normName(newAccount.name), code);
            toCreate.push({ code, name: newAccount.name, fsLine: newAccount.fsLine });
          }
        } else {
          const acc = code ? byCode.get(code) : undefined;
          if (!acc || acc.isBank || acc.isSuspense || acc.isClearing) throw new MappingError(`Akun ${code ?? "(kosong)"} tidak bisa dipakai untuk pemetaan`);
        }
        plan.push({ sourceAccountId: it.sourceAccountId, code: code!, mappedBy: newAccount ? "NEW" : it.method });
      }

      if (toCreate.length) {
        await tx.account.createMany({ data: toCreate.map((a) => ({ firmId: client.firmId, clientId, ...newAccountData(a.fsLine, a.name), code: a.code })) });
        for (const a of await tx.account.findMany({ where: { clientId, code: { in: toCreate.map((x) => x.code) } }, select: { id: true, code: true, name: true, isBank: true, isSuspense: true, isClearing: true } })) byCode.set(a.code, a);
        // The chart changed, so cached AI answers keyed on the old chart no longer apply.
        await tx.client.update({ where: { id: clientId }, data: { coaVersion: { increment: 1 } } });
      }

      const groups = new Map<string, { accountId: string; mappedBy: MapMethod; ids: string[] }>();
      for (const p of plan) {
        const accountId = byCode.get(p.code)!.id;
        const k = `${accountId}|${p.mappedBy}`;
        const g = groups.get(k) ?? { accountId, mappedBy: p.mappedBy, ids: [] };
        g.ids.push(p.sourceAccountId);
        groups.set(k, g);
      }
      // Riwayat (ADR 0013): a source account moved from one client account to another (a first mapping is part of its import).
      const codeOf = new Map((await tx.account.findMany({ where: { clientId }, select: { id: true, code: true, name: true } })).map((a) => [a.id, `${a.code} ${a.name}`]));
      for (const g of groups.values()) {
        for (const s of sources.filter((x) => g.ids.includes(x.id) && x.accountId && x.accountId !== g.accountId)) {
          await recordEvent(tx, {
            clientId,
            entityId: s.entityId,
            kind: "MAPPING",
            subject: `source:${s.id}`,
            summary: `Akun sumber ${s.code} ${s.name}: ${codeOf.get(s.accountId!) ?? "?"} → ${codeOf.get(g.accountId) ?? "?"} (jurnal yang sudah dicatat tidak ikut pindah)`,
            before: { account: codeOf.get(s.accountId!) ?? null },
            after: { account: codeOf.get(g.accountId) ?? null },
            actorId,
          });
        }
        await tx.sourceAccount.updateMany({ where: { id: { in: g.ids }, clientId }, data: { accountId: g.accountId, mappedBy: g.mappedBy, mappedById: actorId ?? null } });
      }
      return { mapped: items.length, created: toCreate.length };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}

/** Code ranges per FS line for "Buat akun baru". Special codes are skipped. */
const RANGES: Partial<Record<FsLine, [number, number]>> = {
  KAS_SETARA_KAS: [1111, 1129],
  PIUTANG_USAHA: [1131, 1139],
  PIUTANG_LAIN: [1141, 1149],
  PERSEDIAAN: [1161, 1169],
  PAJAK_DIBAYAR_DIMUKA: [1181, 1189],
  BIAYA_DIBAYAR_DIMUKA: [1171, 1179],
  ASET_TETAP: [1211, 1218],
  AKUM_PENYUSUTAN: [1220, 1229],
  ASET_TIDAK_LANCAR_LAIN: [1251, 1299],
  UTANG_USAHA: [2111, 2119],
  UTANG_PAJAK: [2146, 2149],
  UTANG_LAIN: [2121, 2129],
  UTANG_BANK: [2211, 2219],
  UTANG_JANGKA_PANJANG: [2301, 2399],
  MODAL: [3101, 3199],
  SALDO_LABA: [3201, 3299],
  PENDAPATAN_USAHA: [4101, 4199],
  PENDAPATAN_LAIN: [4911, 4999],
  HPP: [5101, 5999],
  BEBAN_PENJUALAN: [6141, 6159],
  BEBAN_UMUM_ADM: [6191, 6999],
  BEBAN_LAIN: [7101, 7189],
  BEBAN_PAJAK: [8101, 8199],
};
/** FS lines under which "Buat akun baru" can create a client account, in template order. */
export const NEW_ACCOUNT_FS_LINES = (Object.keys(FS_LINES) as FsLine[]).filter((k) => RANGES[k]).map((k) => ({ key: k, label: FS_LINES[k].label }));

// Template codes are skipped too: accounts added to the template later (1135, 1181, 2146 …) are created on first use and must stay free.
const SPECIAL = new Set(["1190", "1199", "1999", "3200", "3900", "7190", "7200", ...Array.from({ length: 9 }, (_, i) => `110${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `220${i + 1}`), ...COA_TEMPLATE.map((a) => a.code)]);
const SECTION_TYPE: Record<string, AccountType> = { ASET_LANCAR: "ASET", ASET_TIDAK_LANCAR: "ASET", LIABILITAS_JANGKA_PENDEK: "LIABILITAS", LIABILITAS_JANGKA_PANJANG: "LIABILITAS", EKUITAS: "EKUITAS" };

/** Next free code under an FS line's range, then under its anchor (1140 → 114001 … 114099, 1140100 … 1140999; sorts right after 1140). */
export function allocateAccountCode(fsLine: FsLine, used: Set<string>): string {
  const range = RANGES[fsLine];
  if (!range) throw new MappingError(`Akun baru tidak bisa dibuat di ${FS_LINES[fsLine]?.label ?? fsLine}`);
  let code: string | null = null;
  for (let c = range[0]; c <= range[1]; c++) if (!used.has(String(c)) && !SPECIAL.has(String(c))) (code ??= String(c));
  for (let i = 1; !code && i <= 999; i++) {
    const c = `${range[0] - 1}${String(i).padStart(2, "0")}`;
    if (!used.has(c)) code = c;
  }
  if (!code) throw new MappingError(`Rentang kode untuk ${FS_LINES[fsLine].label} sudah penuh`);
  return code;
}

/** One new client account under an FS line (the batched path is acceptMappings). */
export async function createClientAccount(tx: Tx, clientId: string, fsLine: FsLine, name: string): Promise<string> {
  const client = await tx.client.findUniqueOrThrow({ where: { id: clientId }, select: { firmId: true } });
  const code = allocateAccountCode(fsLine, new Set((await tx.account.findMany({ where: { clientId }, select: { code: true } })).map((a) => a.code)));
  await tx.account.create({ data: { firmId: client.firmId, clientId, ...newAccountData(fsLine, name), code } });
  // The chart changed, so cached AI answers keyed on the old chart no longer apply.
  await tx.client.update({ where: { id: clientId }, data: { coaVersion: { increment: 1 } } });
  return code;
}

function newAccountData(fsLine: FsLine, name: string) {
  const section = FS_LINES[fsLine].section;
  const type: AccountType =
    SECTION_TYPE[section] ?? (fsLine === "PENDAPATAN_USAHA" || fsLine === "PENDAPATAN_LAIN" ? "PENDAPATAN" : "BEBAN");
  const normalBalance = type === "ASET" || type === "BEBAN" ? (fsLine === "AKUM_PENYUSUTAN" ? "CREDIT" : "DEBIT") : "CREDIT";
  return { name: name.slice(0, 80), type, normalBalance, fsLine } as const;
}
