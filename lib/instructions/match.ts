import type { Direction } from "@/lib/generated/prisma/enums";
import type { InstructionDraft } from "@/lib/instructions/compile";

/**
 * Whether a bank line is one a *Tandai* or *Tahan* instruction names (cycle 2026-10-18-instruksi-kantor): its description holds the keyword
 * (case-insensitive, as a rule matches), its direction is the one given, and its absolute amount is above (or at least) the minimum.
 * The import, the close control and the preview all use this one test. Amounts are whole Rupiah in bigint.
 */
export type LineCondition = Pick<InstructionDraft, "pattern" | "direction" | "minAmount" | "inclusive">;
export type MatchLine = { description: string; direction: Direction; amount: bigint };
/** A *Tahan di Review* instruction as the import's dial reads it: its typed fields, and the sentence for the held line's reason. */
export type InstructionHold = LineCondition & { sentence: string };

export function matchesLine(i: LineCondition, line: MatchLine): boolean {
  if (i.direction && i.direction !== line.direction) return false;
  if (i.pattern && !line.description.toUpperCase().includes(i.pattern.toUpperCase())) return false;
  if (i.minAmount === null) return true;
  const size = line.amount < 0n ? -line.amount : line.amount;
  return i.inclusive ? size >= i.minAmount : size > i.minAmount;
}
