import { CURRENCY_CODES, isCurrency } from "@/lib/fx/currency";
/** Source-reported evidence, never a stored GL balance or authority to post. */
export type EvidenceKind = "BANK" | "LEDGER" | "REPORT" | "CONTEXT" | "UNKNOWN";
export type EvidenceRole = "SOURCE" | "COMPARISON" | "CONTEXT";
export type EvidencePassage = { locator: string; text: string };
export type EvidenceFigure = {
  label: string;
  raw: string;
  /** Exact currency minor units, serialized for persistence and UI. */
  amount: string;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  locator: string;
};
export type EvidenceFact = { key: string; value: string; locator: string };
/**
 * A "Mata uang" fact is a currency code from the registry ("IDR"), never a word the AI read off the page ("INDONESIA" from a
 * statement's address block). Checked where a fact is proposed, stored and confirmed.
 */
export const factAllowed = (key: string, value: string) => key !== "currency" || isCurrency(value);
/** Prisma filter hiding currency facts stored before the check existed. */
export const HIDE_INVALID_CURRENCY_FACTS = { NOT: { key: "currency", value: { notIn: [...CURRENCY_CODES] } } };
/** A table the ledger import can post (`detectTables`), read at extraction time. Absent on older extractions. */
export type EvidenceTable = {
  mode: "LEDGER" | "NERACA";
  rows: number;
  /** Distinct non-empty labels of the ledger's entity column. */
  entities: string[];
  /** Ledger: first/last row date. Neraca: the balance date written in the file, else null. */
  periodStart: string | null;
  periodEnd: string | null;
  /** Distinct row currencies (ledger rows with a currency column). Absent on older extractions. */
  currencies?: string[];
};
export type EvidenceUnit = {
  key: string;
  label: string;
  kind: EvidenceKind;
  role: EvidenceRole;
  entity: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  currency: string | null;
  /** Decimal multiplier, or UNKNOWN when source scale conflicts. */
  scale: string;
  passages: EvidencePassage[];
  figures: EvidenceFigure[];
  facts: EvidenceFact[];
  issues: string[];
  table?: EvidenceTable;
};
export type Extraction = { units: EvidenceUnit[]; issues: string[] };
