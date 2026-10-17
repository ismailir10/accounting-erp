import type { Direction, TaxTag } from "@/lib/generated/prisma/enums";
import type { Classification } from "@/lib/classify/types";

export type RuleLike = {
  id?: string;
  pattern: string;
  direction: Direction | null;
  accountCode: string;
  taxTag: TaxTag | null;
  priority: number;
  clientId?: string | null;
  /** SEED · USER · INSTRUKSI (lib/instructions): only the reason's wording depends on it. */
  source?: string;
};

/** Client rules beat firm rules (unless a matching firm rule is strictly more specific, see matchRule); then lower priority number wins; then longer pattern. */
export function sortRules<T extends RuleLike>(rules: T[]): T[] {
  return [...rules].sort(
    (a, b) =>
      Number(Boolean(b.clientId)) - Number(Boolean(a.clientId)) ||
      a.priority - b.priority ||
      b.pattern.length - a.pattern.length,
  );
}

/**
 * The rule that decides a line (accounting-rules 13), or null; `rules` in `sortRules` order. With `codes` (the client's chart), a rule
 * whose account the client doesn't have is skipped — an older chart may lack a template account added later — so the line goes on to
 * memory / AI / the guess instead of failing the import.
 */
export function winningRule<T extends RuleLike>(rules: T[], description: string, direction: Direction, codes?: ReadonlySet<string>): T | null {
  const text = description.toUpperCase();
  const hits = rules.filter((r) => (!r.direction || r.direction === direction) && (!codes || codes.has(r.accountCode)) && text.includes(r.pattern.toUpperCase()));
  const r = hits[0];
  if (!r) return null;
  if (!r.clientId) return r;
  // A client rule beats firm rules, except a firm rule that says strictly more about the same text: a client's "PAJAK" (tax payments)
  // must not swallow the firm's "PAJAK BUNGA" (final tax on interest, 8200).
  const pattern = r.pattern.toUpperCase();
  return hits.find((f) => !f.clientId && f.pattern.length > pattern.length && f.pattern.toUpperCase().includes(pattern)) ?? r;
}

/** The first rule that matches, as a classification. A rule an Instruksi kantor made says so in its reason. */
export function matchRule(rules: RuleLike[], description: string, direction: Direction, codes?: ReadonlySet<string>): Classification | null {
  const r = winningRule(rules, description, direction, codes);
  if (!r) return null;
  return {
    method: "RULE",
    accountCode: r.accountCode,
    taxTag: r.taxTag,
    confidence: 0.97,
    reason: r.source === "INSTRUKSI" ? `Instruksi kantor: keterangan memuat "${r.pattern}"` : `Aturan: keterangan mengandung "${r.pattern}"`,
  };
}

/** Firm-wide starter rules for common Indonesian bank descriptors. */
export const FIRM_RULES: Omit<RuleLike, "clientId">[] = [
  { pattern: "PAJAK BUNGA", direction: "OUT", accountCode: "8200", taxTag: "PPH_4_2", priority: 10 },
  { pattern: "PAJAK JASA GIRO", direction: "OUT", accountCode: "8200", taxTag: "PPH_4_2", priority: 10 },
  { pattern: "TAX ON INTEREST", direction: "OUT", accountCode: "8200", taxTag: "PPH_4_2", priority: 10 },
  { pattern: "BUNGA", direction: "IN", accountCode: "4900", taxTag: null, priority: 20 },
  { pattern: "INTEREST", direction: "IN", accountCode: "4900", taxTag: null, priority: 20 },
  { pattern: "JASA GIRO", direction: "IN", accountCode: "4900", taxTag: null, priority: 20 },
  // Interest charged out of a bank account is interest on a loan or overdraft (PRK); its tax (PAJAK BUNGA) ranks first.
  { pattern: "BUNGA", direction: "OUT", accountCode: "7110", taxTag: null, priority: 20 },
  { pattern: "INTEREST", direction: "OUT", accountCode: "7110", taxTag: null, priority: 20 },
  { pattern: "BIAYA ADM", direction: "OUT", accountCode: "7100", taxTag: null, priority: 20 },
  { pattern: "BIAYA TRANSFER", direction: "OUT", accountCode: "7100", taxTag: null, priority: 20 },
  { pattern: "BIAYA TRX", direction: "OUT", accountCode: "7100", taxTag: null, priority: 20 },
  { pattern: "BIAYA TXN", direction: "OUT", accountCode: "7100", taxTag: null, priority: 20 },
  { pattern: "FEE PAYMENT", direction: "OUT", accountCode: "7100", taxTag: null, priority: 20 },
  { pattern: "MATERAI", direction: "OUT", accountCode: "7100", taxTag: null, priority: 20 },
  { pattern: "METERAI", direction: "OUT", accountCode: "7100", taxTag: null, priority: 20 },
  { pattern: "STAMP DUTY", direction: "OUT", accountCode: "7100", taxTag: null, priority: 20 },
  { pattern: "ADM BULANAN", direction: "OUT", accountCode: "7100", taxTag: null, priority: 20 },
  { pattern: "SETORAN PPN", direction: "OUT", accountCode: "2130", taxTag: "PPN_KELUARAN", priority: 15 },
  { pattern: "SETOR PPN", direction: "OUT", accountCode: "2130", taxTag: "PPN_KELUARAN", priority: 15 },
  { pattern: "PAJAK PPN", direction: "OUT", accountCode: "2130", taxTag: "PPN_KELUARAN", priority: 15 },
  { pattern: "PPN MASA", direction: "OUT", accountCode: "2130", taxTag: "PPN_KELUARAN", priority: 15 },
  // Remitting withheld tax clears the liability booked when it was withheld (payroll, or the withholding option on a payment), not an
  // expense: filing PPh 21 paid in January for December to salary expense put it in the wrong year (accounting-rules 13a).
  { pattern: "PPH 21", direction: "OUT", accountCode: "2140", taxTag: "PPH_21", priority: 15 },
  { pattern: "PPH21", direction: "OUT", accountCode: "2140", taxTag: "PPH_21", priority: 15 },
  { pattern: "PPH PASAL 21", direction: "OUT", accountCode: "2140", taxTag: "PPH_21", priority: 15 },
  { pattern: "PPH 23", direction: "OUT", accountCode: "2141", taxTag: "PPH_23", priority: 15 },
  { pattern: "PPH23", direction: "OUT", accountCode: "2141", taxTag: "PPH_23", priority: 15 },
  { pattern: "PPH PASAL 23", direction: "OUT", accountCode: "2141", taxTag: "PPH_23", priority: 15 },
  { pattern: "PPH 4(2)", direction: "OUT", accountCode: "2145", taxTag: "PPH_4_2", priority: 15 },
  { pattern: "PPH 4 (2)", direction: "OUT", accountCode: "2145", taxTag: "PPH_4_2", priority: 15 },
  { pattern: "PPH 4 AYAT 2", direction: "OUT", accountCode: "2145", taxTag: "PPH_4_2", priority: 15 },
  { pattern: "PPH PASAL 4", direction: "OUT", accountCode: "2145", taxTag: "PPH_4_2", priority: 15 },
  { pattern: "PPH FINAL", direction: "OUT", accountCode: "2145", taxTag: "PPH_4_2", priority: 15 },
  // PPh 29 (the balance due with the annual return) clears the payable the tax pack posts (2146).
  { pattern: "PPH 29", direction: "OUT", accountCode: "2146", taxTag: null, priority: 15 },
  { pattern: "PPH29", direction: "OUT", accountCode: "2146", taxTag: null, priority: 15 },
  // An instalment is a prepayment credited against the year's PPh badan (accounting-rules 5d), not an expense.
  { pattern: "PPH 25", direction: "OUT", accountCode: "1180", taxTag: "PPH_25", priority: 15 },
  { pattern: "PPH25", direction: "OUT", accountCode: "1180", taxTag: "PPH_25", priority: 15 },
  // Tax payments as the bank prints the state receipt: the KAP-KJS code names the tax. They rank before the
  // words above, so "PPH 23 … 411121-100" files by its code.
  { pattern: "411121", direction: "OUT", accountCode: "2140", taxTag: "PPH_21", priority: 12 },
  { pattern: "411124", direction: "OUT", accountCode: "2141", taxTag: "PPH_23", priority: 12 },
  { pattern: "411128", direction: "OUT", accountCode: "2145", taxTag: "PPH_4_2", priority: 12 },
  { pattern: "411125-100", direction: "OUT", accountCode: "1180", taxTag: "PPH_25", priority: 12 },
  { pattern: "411125100", direction: "OUT", accountCode: "1180", taxTag: "PPH_25", priority: 12 },
  { pattern: "411125-200", direction: "OUT", accountCode: "2146", taxTag: null, priority: 12 },
  { pattern: "411125200", direction: "OUT", accountCode: "2146", taxTag: null, priority: 12 },
  { pattern: "411211", direction: "OUT", accountCode: "2130", taxTag: "PPN_KELUARAN", priority: 12 },
  { pattern: "PAYROLL", direction: "OUT", accountCode: "6100", taxTag: null, priority: 30 },
  { pattern: "GAJI", direction: "OUT", accountCode: "6100", taxTag: null, priority: 30 },
  { pattern: "BPJS", direction: "OUT", accountCode: "6110", taxTag: null, priority: 30 },
  { pattern: "PLN", direction: "OUT", accountCode: "6130", taxTag: null, priority: 40 },
  { pattern: "PDAM", direction: "OUT", accountCode: "6130", taxTag: null, priority: 40 },
  { pattern: "TELKOM", direction: "OUT", accountCode: "6130", taxTag: null, priority: 40 },
  { pattern: "INDIHOME", direction: "OUT", accountCode: "6130", taxTag: null, priority: 40 },
  { pattern: "GOJEK", direction: "OUT", accountCode: "6140", taxTag: null, priority: 50 },
  { pattern: "GRAB", direction: "OUT", accountCode: "6140", taxTag: null, priority: 50 },
];
