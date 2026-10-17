import type { Direction, TaxTag } from "@/lib/generated/prisma/enums";

/**
 * Instruksi kantor's shared words and shapes (cycle 2026-10-18-instruksi-kantor), free of server-only imports so the editor (a client
 * component) can use them. The reader and the validator live in lib/instructions/compile.ts.
 */
export type InstructionKind = "ACCOUNT" | "FLAG" | "HOLD";
/** The draft as JSON carries it (browser, cache, Riwayat): the amount as a string of digits. */
export type DraftJson = { kind: InstructionKind; pattern: string | null; direction: Direction | null; accountCode: string | null; taxTag: TaxTag | null; minAmount: string | null; inclusive: boolean };
export const DRAFT_KEYS = ["kind", "pattern", "direction", "accountCode", "taxTag", "minAmount", "inclusive"] as const;
export type DraftField = (typeof DRAFT_KEYS)[number];

export const KIND_LABEL: Record<InstructionKind, string> = { ACCOUNT: "Aturan akun", FLAG: "Tandai", HOLD: "Tahan di Review" };
export const ORIGIN_LABEL = { PARSER: "Disusun Buku", AI: "Disusun AI", EDITED: "Disunting" } as const;
export const MAX_SENTENCE = 300;
export const PATTERNS_LINE = "Aturan akun: <kata kunci> selalu <akun> · Tandai: tandai pengeluaran > Rp10 jt · Tahan: <kata kunci> selalu ke Review";
