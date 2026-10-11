import type { BankCode } from "@/lib/generated/prisma/enums";

/**
 * The banks Buku knows: one list for the client form, onboarding, the import help, the parsers' bank detection and the transfer
 * matcher's bank words. Adding a bank = one entry here + one `ALTER TYPE "BankCode" ADD VALUE` migration + a fixture for each
 * format it lists (tests/unit/bank-coverage.test.ts fails otherwise).
 *
 * `detect` is matched against the lines *above* a statement's table only (title, bank heading, product name), never transactions,
 * so it names the bank's own words: "Bank Permata", "PermataNet" — never a bare word a company name may hold ("PT Permata Hijau").
 * `bic` (SWIFT/BIC, 8 characters) identifies MT940 files. `words` are the names banks print in transaction text for the
 * transfer matcher (naming another account's bank names no counterparty).
 */
export type BankFormat = {
  /** What the bank's file is, as an accountant would call it. */
  label: string;
  kind: "PDF" | "CSV" | "XLSX" | "MT940";
  /** How Buku knows this layout: `PUBLISHED` = documented by the bank or public parser code; `INFERRED` = a common layout, no public sample. */
  evidence: "REAL" | "PUBLISHED" | "INFERRED";
};

export type BankInfo = {
  code: Exclude<BankCode, "GENERIC">;
  /** Short display name (the picker, labels, the import history). */
  name: string;
  /** Legal / long name. */
  fullName: string;
  group: "Bank besar" | "Bank swasta & asing" | "Bank digital" | "Bank daerah";
  bic: string[];
  detect: RegExp;
  words: string[];
  formats: BankFormat[];
};

const pdf = (label: string, evidence: BankFormat["evidence"] = "PUBLISHED"): BankFormat => ({ label, kind: "PDF", evidence });
const csv = (label: string, evidence: BankFormat["evidence"] = "PUBLISHED"): BankFormat => ({ label, kind: "CSV", evidence });
const xlsx = (label: string, evidence: BankFormat["evidence"] = "PUBLISHED"): BankFormat => ({ label, kind: "XLSX", evidence });
const mt940: BankFormat = { label: "MT940", kind: "MT940", evidence: "PUBLISHED" };

/**
 * Detection order matters where one bank's name is inside another's: blu (BCA Digital) before BCA, BSI (ex Bank Syariah Mandiri)
 * before Mandiri, SMBC before the rest. `detectBank` tries them in this order.
 */
export const BANKS: BankInfo[] = [
  {
    code: "BLU", name: "blu (BCA Digital)", fullName: "PT Bank Digital BCA", group: "Bank digital", bic: ["ROYBIDJ1"],
    detect: /bca\s*digital|\bblu\s*(?:by|dari)\s*bca|bluaccount|\bblu\s*account/i, words: ["BLU"], formats: [pdf("e-statement blu")],
  },
  {
    code: "BSI", name: "BSI", fullName: "PT Bank Syariah Indonesia", group: "Bank besar", bic: ["BSMDIDJA"],
    detect: /bank\s+syariah\s+indonesia|\bBSI\b|bsi\s*mobile|bank\s+syariah\s+mandiri/i, words: ["BSI"], formats: [pdf("e-statement BSI")],
  },
  {
    code: "SMBC", name: "SMBC / Jenius", fullName: "PT Bank SMBC Indonesia (d/h BTPN)", group: "Bank swasta & asing", bic: ["SUNIIDJA"],
    detect: /\bSMBC\b|bank smbc indonesia|jenius|\bBTPN\b|touchbiz/i, words: ["SMBC", "JENIUS", "BTPN"],
    formats: [pdf("Laporan Konsolidasi Rekening (Touchbiz / Jenius)", "REAL")],
  },
  {
    code: "MANDIRI", name: "Mandiri", fullName: "PT Bank Mandiri (Persero) Tbk", group: "Bank besar", bic: ["BMRIIDJA"],
    // The bank's own names: account holders are often called "… Mandiri …".
    detect: /bank\s+mandiri|\blivin['’]?(?![a-z])|\bkopra\b|mandiri\s+(?:online|cash|cms|direct)|\bMCM\b|\b(?:tabungan|giro|menara)\s+mandiri\b/i, words: ["MANDIRI", "MDR"],
    formats: [xlsx("Livin' / MCM (Excel)"), pdf("e-Statement (Livin')"), pdf("rekening koran tabungan"), pdf("MCM / Kopra account statement"), csv("Kopra / MCM (CSV)"), mt940],
  },
  {
    code: "BRI", name: "BRI", fullName: "PT Bank Rakyat Indonesia (Persero) Tbk", group: "Bank besar", bic: ["BRINIDJA"],
    detect: /\bBRI\b|bank rakyat|\bbrimo\b|\bqlola\b|\bibbiz\b|nama\s+produk\s*:?\s*britama(?:-IDR)?\b/i, words: ["BRI", "SIMPEDES", "BRITAMA"],
    formats: [csv("BRImo / CMS (CSV)"), csv("internet banking (CSV)"), pdf("Rincian Rekening Koran"), pdf("IBBIZ Laporan Transaksi Finansial"), pdf("BRImo Laporan Transaksi Finansial"), xlsx("QLola (Excel)"), mt940],
  },
  {
    code: "BCA", name: "BCA", fullName: "PT Bank Central Asia Tbk", group: "Bank besar", bic: ["CENAIDJA"],
    detect: /\bBCA\b|bank central asia|klikbca/i, words: ["BCA", "TAHAPAN", "XPRESI"],
    formats: [pdf("e-statement Tahapan / Giro", "REAL"), csv("KlikBCA Bisnis (CSV)"), csv("KlikBCA Individual (CSV)"), pdf("KlikBCA mutasi rekening (cetak PDF)"), mt940],
  },
  {
    code: "BNI", name: "BNI", fullName: "PT Bank Negara Indonesia (Persero) Tbk", group: "Bank besar", bic: ["BNINIDJA"],
    detect: /\bBNI\b|bank negara indonesia|bnidirect|\bwondr\b|laporan\s+mutasi\s+rekening[\s\S]*\btaplus(?:\s+(?:bisnis|muda))?\b/i, words: ["BNI"],
    formats: [csv("BNIDirect (CSV)"), xlsx("BNIDirect (Excel)"), xlsx("BNI Mobile (Excel)"), pdf("BNI account statement (korporat)"), pdf("e-statement tabungan"), pdf("wondr Laporan Mutasi Rekening")],
  },
  {
    code: "BTN", name: "BTN", fullName: "PT Bank Tabungan Negara (Persero) Tbk", group: "Bank besar", bic: ["BTANIDJA"],
    detect: /\bBTN\b|bank tabungan negara/i, words: ["BTN"], formats: [pdf("rekening koran BTN")],
  },
  {
    code: "CIMB", name: "CIMB Niaga", fullName: "PT Bank CIMB Niaga Tbk", group: "Bank swasta & asing", bic: ["BNIAIDJA"],
    detect: /cimb\s*niaga|\bCIMB\b|\bocto\s*(?:mobile|clicks)|bizchannel/i, words: ["CIMB", "NIAGA", "OCTO"],
    formats: [csv("OCTO / BizChannel (CSV)"), xlsx("OCTO (Excel)"), pdf("e-statement CIMB Niaga"), mt940],
  },
  {
    code: "PERMATA", name: "Permata", fullName: "PT Bank Permata Tbk", group: "Bank swasta & asing", bic: ["BBBAIDJA"],
    detect: /bank\s+permata|permatanet|permata\s*(?:me|mobile|e-business|bank)\b|\bpermatabank/i, words: ["PERMATA"],
    formats: [csv("PermataNet (CSV)"), xlsx("PermataNet (Excel)")],
  },
  {
    code: "DANAMON", name: "Danamon", fullName: "PT Bank Danamon Indonesia Tbk", group: "Bank swasta & asing", bic: ["BDINIDJA"],
    detect: /bank\s+danamon|danamon\s+(?:cash\s*connect|online)|d-bank\s*pro/i, words: ["DANAMON"], formats: [csv("Danamon Cash Connect (CSV)", "INFERRED")],
  },
  {
    code: "OCBC", name: "OCBC", fullName: "PT Bank OCBC NISP Tbk", group: "Bank swasta & asing", bic: ["NISPIDJA"],
    detect: /\bOCBC\b|ocbc\s*nisp|bank\s+nisp/i, words: ["OCBC", "NISP"], formats: [csv("OCBC Business / Velocity (CSV)", "INFERRED"), mt940],
  },
  {
    code: "PANIN", name: "Panin", fullName: "PT Bank Panin Indonesia Tbk", group: "Bank swasta & asing", bic: ["PINBIDJA"],
    detect: /panin\s*bank|bank\s+panin\b|paninbank/i, words: ["PANIN"], formats: [xlsx("Panin internet banking (Excel)", "INFERRED")],
  },
  {
    code: "MAYBANK", name: "Maybank", fullName: "PT Bank Maybank Indonesia Tbk", group: "Bank swasta & asing", bic: ["IBBKIDJA"],
    detect: /\bmaybank\b|\bM2E\b|maybank2e/i, words: ["MAYBANK"], formats: [mt940],
  },
  {
    code: "UOB", name: "UOB", fullName: "PT Bank UOB Indonesia", group: "Bank swasta & asing", bic: ["BBIJIDJA"],
    detect: /\bUOB\b|united overseas bank/i, words: ["UOB"], formats: [mt940],
  },
  {
    code: "MEGA", name: "Bank Mega", fullName: "PT Bank Mega Tbk", group: "Bank swasta & asing", bic: ["MEGAIDJA"],
    detect: /bank\s+mega\b|mega\s+internet\s+bisnis|\bm-smile\b/i, words: ["MEGA"], formats: [xlsx("Mega internet banking (Excel)", "INFERRED")],
  },
  {
    code: "SINARMAS", name: "Sinarmas", fullName: "PT Bank Sinarmas Tbk", group: "Bank swasta & asing", bic: ["SBJKIDJA"],
    detect: /bank\s+sinarmas|\bsimobi/i, words: ["SINARMAS"], formats: [pdf("e-statement Sinarmas", "INFERRED")],
  },
  {
    code: "DBS", name: "DBS", fullName: "PT Bank DBS Indonesia", group: "Bank swasta & asing", bic: ["DBSBIDJA"],
    detect: /\bDBS\b|digibank/i, words: ["DBS", "DIGIBANK"], formats: [mt940],
  },
  {
    code: "HSBC", name: "HSBC", fullName: "PT Bank HSBC Indonesia", group: "Bank swasta & asing", bic: ["HSBCIDJA"],
    detect: /\bHSBC\b|hsbcnet/i, words: ["HSBC"], formats: [mt940],
  },
  {
    code: "CITI", name: "Citibank", fullName: "Citibank N.A. Indonesia", group: "Bank swasta & asing", bic: ["CITIIDJX"],
    detect: /\bcitibank\b|citidirect/i, words: ["CITIBANK", "CITI"], formats: [mt940],
  },
  {
    code: "JAGO", name: "Bank Jago", fullName: "PT Bank Jago Tbk", group: "Bank digital", bic: ["JAGBIDJA"],
    detect: /bank\s+jago|jago\s+syariah/i, words: ["JAGO"], formats: [pdf("e-statement Jago (per kantong)")],
  },
  {
    code: "SEABANK", name: "SeaBank", fullName: "PT Bank Seabank Indonesia", group: "Bank digital", bic: ["SSPIIDJA"],
    detect: /\bseabank\b/i, words: ["SEABANK"], formats: [pdf("rekening koran SeaBank")],
  },
  {
    code: "DKI", name: "Bank DKI", fullName: "PT Bank DKI", group: "Bank daerah", bic: ["BDKIIDJ1"],
    detect: /bank\s+dki|\bjakone\b/i, words: ["DKI", "JAKONE"], formats: [csv("CMS Bank DKI (CSV)", "INFERRED")],
  },
  {
    code: "BJB", name: "bank bjb", fullName: "PT Bank Pembangunan Daerah Jawa Barat dan Banten Tbk", group: "Bank daerah", bic: ["PDJBIDJA"],
    detect: /bank\s+bjb|\bbjb\b|bank\s+jabar/i, words: ["BJB"], formats: [xlsx("bjb internet banking (Excel)", "INFERRED")],
  },
  {
    code: "JATIM", name: "Bank Jatim", fullName: "PT Bank Pembangunan Daerah Jawa Timur Tbk", group: "Bank daerah", bic: ["PDJTIDJ1"],
    detect: /bank\s+jatim|bank\s+pembangunan\s+daerah\s+jawa\s+timur/i, words: ["JATIM"], formats: [mt940],
  },
];

/** Every bank code a bank account may carry, in picker order (the list above sorted by group, then *Bank lain*). */
export const BANK_CODES = [...BANKS.map((b) => b.code), "GENERIC"] as const satisfies readonly BankCode[];

const BY_CODE = new Map<string, BankInfo>(BANKS.map((b) => [b.code, b]));

export function bankInfo(code: string): BankInfo | null {
  return BY_CODE.get(code) ?? null;
}

/** The name to show for a bank code: "Bank lain" for GENERIC. */
export function bankName(code: string): string {
  return BY_CODE.get(code)?.name ?? "Bank lain";
}

export const GROUP_ORDER: BankInfo["group"][] = ["Bank besar", "Bank swasta & asing", "Bank digital", "Bank daerah"];

/** The picker's options: grouped, big banks first, *Bank lain* last. */
export function bankOptions(): { code: BankCode; name: string; group: string }[] {
  const sorted = GROUP_ORDER.flatMap((g) => BANKS.filter((b) => b.group === g).sort((a, b) => a.name.localeCompare(b.name, "id")));
  return [...sorted.map((b) => ({ code: b.code, name: b.name, group: b.group })), { code: "GENERIC", name: "Bank lain", group: "Lainnya" }];
}

/**
 * The bank a statement's heading names, or GENERIC. Read only from the lines above the first table. BCA e-statements print their
 * notes letter-spaced ("B C A b e r h a k …"), which loses the word breaks: collapsed, the capitals "BCA" still stand apart.
 */
export function detectBank(headerText: string): BankCode {
  for (const b of BANKS) if (b.detect.test(headerText)) return b.code;
  const collapsed = headerText.replace(/(\p{L}) (?=\p{L}(?: |$))/gmu, "$1");
  if (/(?<![A-Z])BCA(?![A-Z])/.test(collapsed)) return "BCA";
  return "GENERIC";
}

/** The bank of a SWIFT BIC (8 or 11 characters, branch code ignored), or null. */
export function bankOfBic(bic: string): BankCode | null {
  const head = bic.trim().toUpperCase().slice(0, 8);
  return BANKS.find((b) => b.bic.includes(head))?.code ?? null;
}

/** Bank names as printed in transaction text (upper case): the transfer matcher's bank words. */
export const BANK_TEXT_WORDS: string[] = [...new Set(BANKS.flatMap((b) => b.words))];
