import { AUTO_POST_CONFIDENCE, type Classification } from "@/lib/classify/types";
import { formatRupiah } from "@/lib/money";
import type { FirmAutomation } from "@/lib/settings/automation";

/** The firm's automation dial (lib/settings/automation.ts) as the import reads it. */
export type Dial = Pick<FirmAutomation, "transfer" | "rules" | "memory" | "cap">;
/** Why the dial held a line the classifier would have posted: its source's switch is off, or its amount is above the cap. */
export type HoldKind = "transfer" | "rules" | "memory" | "cap";

const SOURCE = { TRANSFER: "transfer", RULE: "rules", MEMORY: "memory" } as const;
const SWITCH_WORD: Record<Exclude<HoldKind, "cap">, string> = { transfer: "transfer", rules: "aturan", memory: "pilihan yang diingat" };
/** The import result's words for each hold ("N ditahan Otomasi kantor (batas nominal, aturan dimatikan)"). */
export const HOLD_LABEL: Record<HoldKind, string> = { cap: "batas nominal", transfer: "transfer dimatikan", rules: "aturan dimatikan", memory: "pilihan yang diingat dimatikan" };

/** "2 ditahan Otomasi kantor (batas nominal, aturan dimatikan)", or null when the dial held nothing. */
export function heldLine(heldBy: Partial<Record<HoldKind, number>>): string | null {
  const kinds = (Object.keys(HOLD_LABEL) as HoldKind[]).filter((k) => (heldBy[k] ?? 0) > 0);
  const n = kinds.reduce((s, k) => s + heldBy[k]!, 0);
  return n > 0 ? `${n} ditahan Otomasi kantor (${kinds.map((k) => HOLD_LABEL[k]).join(", ")})` : null;
}

const abs = (v: bigint) => (v < 0n ? -v : v);

/**
 * Post or hold (accounting-rules 14, cycle 2026-10-17-otomasi): a line posts straight to its account only when its method is
 * TRANSFER, RULE or MEMORY, its confidence is at least AUTO_POST_CONFIDENCE, the firm's switch for that source is on, and its absolute
 * amount is at or below the firm's cap. The dial can only send more to Review: AI, the simple guess and the financing / tax-payment
 * hints never post, whatever it says. A held line keeps its method, confidence and suggestion; its reason says why it waits.
 */
export function decidePosting(c: Pick<Classification, "method" | "confidence" | "reason">, amount: bigint, dial: Dial): { post: boolean; held: HoldKind | null; reason: string } {
  const source = c.method === "TRANSFER" || c.method === "RULE" || c.method === "MEMORY" ? SOURCE[c.method] : null;
  if (!source || c.confidence < AUTO_POST_CONFIDENCE) return { post: false, held: null, reason: c.reason };
  if (!dial[source]) return { post: false, held: source, reason: `Otomasi ${SWITCH_WORD[source]} dimatikan di Pengaturan kantor. ${c.reason}` };
  if (dial.cap !== null && abs(amount) > dial.cap) return { post: false, held: "cap", reason: `Di atas batas otomasi (${formatRupiah(dial.cap)}). ${c.reason}` };
  return { post: true, held: null, reason: c.reason };
}
