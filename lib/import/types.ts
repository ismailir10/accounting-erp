import type { BankCode } from "@/lib/generated/prisma/enums";

export type ParsedRow = {
  date: Date;
  description: string;
  /** Signed integer Rupiah: + in, − out. */
  amount: bigint;
  balance: bigint | null;
  rowNumber: number;
  rawRow: string;
  /** Workbook sources: the sheet the row is on (row numbers count within it). */
  sheet?: string;
  /** A dated row with no amount, passed by the reader only so the repair can read its amount from the moved balance (else dropped). */
  balanceOnly?: boolean;
  /** What the file wrote, when `repairStatement` changed it (the dedupe still recognises the row as imported before). */
  written?: { amount?: bigint; date?: Date };
};

export type ParsedStatement = {
  format: BankCode;
  /** Explicit currency from the source, when available. Bank imports currently support IDR only. */
  currency?: string;
  /** Distinguish printed evidence from values calculated from the rows under test. */
  provenance?: {
    period: "DECLARED" | "INFERRED";
    opening: "PRINTED" | "DERIVED";
    closing: "PRINTED" | "ROW" | "DERIVED";
  };
  accountNumber: string | null;
  /** Account holder exactly as printed in a supported statement header, when present. */
  holder?: string;
  periodStart: Date;
  periodEnd: Date;
  openingBalance: bigint;
  closingBalance: bigint;
  rows: ParsedRow[];
  /** Combined statements (one PDF, several accounts): the section's account name and currency as printed. */
  section?: { label: string; currency: string };
  /** Choices the parser made that the accountant should know (direction read from the balance, sheets joined). */
  notes?: string[];
  /** Workbook sources: the sheets read into this statement, in date order. */
  sheets?: string[];
  /** This section can't be imported (its repair refused it, rule 12); the other sections of the file still can. */
  error?: string;
  /** Time deposits the file lists besides the transactions (SMBC "Detail Produk Deposito"): file-level, same on every section. */
  deposits?: DepositProduct[];
  /** Read with a layout the firm mapped in *Atur kolom* (no reader knew it): which one, so the result can offer to forget it. */
  layout?: { id: string; label: string };
};

/** A time deposit printed on a statement. `idrBalance` is the bank's IDR equivalent in whole Rupiah. */
export type DepositProduct = { number: string; product: string; currency: string; rate: string | null; maturity: string | null; idrBalance: bigint };

export class ParseError extends Error {}

/** A source currency conflict cannot be bypassed by trying another reader or remembered mapping. */
export class SourceCurrencyError extends ParseError {}

/** A recognized bank's impossible date must not be reinterpreted in another locale. */
export class SourceDateError extends ParseError {}

/** A user-selected date order can resolve this; automatic fallbacks cannot. */
export class AmbiguousDateError extends SourceDateError {}

/** A scan or photo with no text to read (I2a): the import page offers *Baca scan dengan AI* when the workspace switch is on. */
export class ScanError extends ParseError {}

/** A text file no reader (and no remembered layout) could read: the import page offers *Atur kolom*. Same message as the reader's. */
export class UnreadableFileError extends ParseError {}

/** A file a reader recognised whose one statement its repair refused (rule 12): still a bank statement, unlike other unreadable files. */
export class StatementRepairError extends UnreadableFileError {}

/** The file's account number(s) aren't the selected account: the action can offer the client's matching account instead. */
export class AccountMismatchError extends ParseError {
  constructor(message: string, readonly fileNumbers: string[]) {
    super(message);
  }
}

/** Dates without a year and none in the file's content: the accountant supplies it (prefilled with `guess` from the file name). */
export class YearNeededError extends ParseError {
  constructor(readonly guess: number | null) {
    super("File ini tidak mencantumkan tahun (tanggal hanya hari/bulan). Isi tahun bulan pertamanya.");
  }
}

/** Invalid monetary evidence must not be reinterpreted by a fallback reader. */
export class SourceAmountError extends ParseError {}
