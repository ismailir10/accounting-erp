import type { Direction, EntityKind } from "@/lib/generated/prisma/enums";
import type { Classification } from "@/lib/classify/types";
import { financingSuggestion, taxPaymentSuggestion } from "@/lib/classify/financing";

/** The accounts the simple guess files to: a company's sale and expense, a person's other income and Prive. Never removable (lib/coa/manage.ts). */
export const GUESS_CODES = { SALE: "4100", EXPENSE: "6190", PERSONAL_IN: "4910", PRIVE: "3300" } as const;

/**
 * The simple guess when nothing else suggests an account (last in rule 13's order): low confidence, always to review.
 * A company's money in is most often a sale and money out an expense. A person's own books aren't a business: money in is
 * other income until its source is known (from the PT, a loan, a salary), money out is the owner's own use (Prive).
 */
export function simpleGuess(direction: Direction, kind: EntityKind, nameless = false): Classification {
  // A line that names no counterparty ("BI Fast Incoming") is a question for the client, not for a model.
  const ask = nameless ? "Keterangan bank tidak menyebut pihak lawan, tanyakan ke klien. " : "";
  const guess = (accountCode: string, reason: string): Classification => ({ method: "HEURISTIC", accountCode, taxTag: null, confidence: 0.3, reason: `${ask}${reason}` });
  if (kind === "PERORANGAN") {
    return direction === "IN"
      ? guess(GUESS_CODES.PERSONAL_IN, "Tebakan sederhana: uang masuk pribadi — pastikan sumbernya (dari PT, pinjaman, atau penghasilan)")
      : guess(GUESS_CODES.PRIVE, "Tebakan sederhana: uang keluar pribadi dianggap pemakaian pemilik (Prive)");
  }
  return direction === "IN"
    ? guess(GUESS_CODES.SALE, "Tebakan sederhana: uang masuk dianggap penjualan")
    : guess(GUESS_CODES.EXPENSE, "Tebakan sederhana: uang keluar dianggap beban umum");
}

/**
 * A line whose suggestion is only the simple guess above (no rule, memory, AI, financing or tax-payment text behind it). Review never
 * accepts it with Enter alone, and accepting it unchanged teaches Memory nothing (lib/review.ts): "uang keluar dianggap beban umum"
 * learned once would auto-post that counterparty to 6190 on every later import.
 */
export function isSimpleGuess(t: { method: string; description: string; direction: Direction }): boolean {
  return t.method === "HEURISTIC" && !financingSuggestion(t.description, t.direction) && !taxPaymentSuggestion(t.description, t.direction);
}
