import type { AccountTerm, AccountType } from "@/lib/generated/prisma/enums";

/** A raw spreadsheet cell: text, number, date, or an Excel error such as "#VALUE!" (kept verbatim for checks). */
export type RawCell = string | number | Date | { error: string } | null;
export type RawSheet = { name: string; rows: RawCell[][] };

export type LedgerMode = "LEDGER" | "NERACA";

export type ColumnKey = "date" | "level" | "code" | "name" | "debit" | "credit" | "amount" | "desc" | "voucher" | "entity" | "currency" | "rate" | "notes";
export type Columns = Partial<Record<ColumnKey, number>>;

/**
 * `columns` is the (first) table. A Neraca printed as two panels side by side (Aset | Kewajiban + Ekuitas) lists every panel in `panels`
 * (`columns` is `panels[0]`); rows of such a file carry the panel's column in their ref ("BS!F12").
 */
export type TableCandidate = {
  sheet: string;
  headerRow: number;
  mode: LedgerMode;
  columns: Columns;
  dataRows: number;
  panels?: Columns[];
  /** Every period column of a Neraca header (a date or "Jan 2026"), the one read included; the others are named on the draft. */
  periods?: { column: number; date: Date }[];
  /** Headers read through a typo ("Kredti" → Kredit), reported on the draft with the cell. */
  typos?: { header: string; label: string; column: number; row: number }[];
  /** A trial balance: its column groups (use-case UC-K2). Stored as a Neraca-mode import: it carries the Saldo Awal. */
  tb?: TbLayout;
};

/** Trial-balance column groups: last year's balance, the Adjustment, the adjusted balance, the movement, the closing balance. */
export type TbGroup = "OPENING" | "UNADJUSTED" | "ADJUSTMENT" | "ADJUSTED" | "MOVEMENT" | "CLOSING";
/** Each group as a Dr/Cr pair or one signed column (debit +); a date written in a group's header. */
export type TbLayout = {
  groups: Partial<Record<TbGroup, { debit?: number; credit?: number; balance?: number }>>;
  dates: Partial<Record<TbGroup, Date>>;
};
/** One TB account row: signed sen per group, debit-positive. */
export type TbRow = {
  ref: string;
  row: number;
  code: string;
  name: string;
  coded: boolean;
  values: Partial<Record<TbGroup, bigint>>;
  /** A group's value exactly, in micro-units, when the file wrote it beyond sen (`parseSubSen`): rule 6a rounds this once. */
  exact?: Partial<Record<TbGroup, bigint>>;
  errors: string[];
};
export type TbRead = {
  layout: TbLayout;
  rows: TbRow[];
  totals: { ref: string; label: string; values: Partial<Record<TbGroup, bigint>> }[];
  opening: Date | null;
  /** One-column groups written with presentation signs (liabilities and equity positive), read debit-positive. */
  flipped?: TbGroup[];
};

/** One ledger line as read from the file. Amounts are signed sen (debit − credit side kept separately). */
export type LedgerRow = {
  /** "sheet!row" (1-based Excel row). */
  ref: string;
  row: number;
  date: Date | null;
  entity: string | null;
  code: string;
  name: string;
  debit: bigint;
  credit: bigint;
  currency: string | null;
  rate: string | null;
  description: string;
  voucher: string | null;
  /** Problems reading this row (non-numeric amount, missing date/account…) — become BLOCK checks. */
  errors: string[];
  /** The file wrote a negative amount; it posts on the other side (same number) and is listed on the draft. */
  negative?: boolean;
  /** As written, when `negative`: a file total sums the columns as written. */
  raw?: { debit: bigint; credit: bigint };
  /** The signed amount (debit − credit) exactly, in micro-units, when the file wrote it beyond sen (`parseSubSen`): rule 6a rounds this once. */
  exact?: bigint;
};

/** A grand-total row of a ledger file (Total/Jumlah, no date): compared with the rows. Signed sen. */
export type LedgerTotal = { ref: string; label: string; debit: bigint; credit: bigint };

export type NeracaRow = {
  ref: string;
  row: number;
  code: string;
  name: string;
  /** Signed sen, debit-positive (assets +, liabilities/equity −, contra accounts flipped by their sign). */
  amount: bigint;
  /** `amount` exactly, in micro-units, when the file wrote it beyond sen (`parseSubSen`): rule 6a rounds this once. */
  exact?: bigint;
  typeHint: AccountType | null;
  /** Current / non-current from the file's sub-heading ("Long-term Liability"); null for equity or unknown. */
  termHint: AccountTerm | null;
  coded: boolean;
  errors: string[];
};

export type NeracaTotal = { ref: string; label: string; amount: bigint; kind: "ASSETS" | "LIAB_EQUITY" | "OTHER" };

/**
 * How a ledger's two-number text dates were read (QA E17), when it needs saying: month/day because a value proves it (`number`), day/month
 * by default because every value fits both (`unsure`), or a file mixing both (`mixed`, examples of each). Absent for plain day/month files.
 */
export type LedgerDateOrder = { order: "DMY" | "MDY"; basis: "number" | "unsure" | "mixed"; examples: string[] };

export type ReadResult =
  | { mode: "LEDGER"; sheet: string; rows: LedgerRow[]; totals?: LedgerTotal[]; dateOrder?: LedgerDateOrder }
  | { mode: "NERACA"; sheet: string; date: Date | null; rows: NeracaRow[]; totals: NeracaTotal[]; tb?: TbRead };
