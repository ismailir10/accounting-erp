import type { Tx } from "@/lib/db";
import type { EntryKind } from "@/lib/generated/prisma/enums";

/**
 * Nomor bukti (cycle 2026-10-20-paritas-inti): PREFIX-YYMM-NNNN, a series per company, prefix and month, as Indonesian vouchers restart
 * monthly. The prefix says what the journal is: SA Saldo Awal, BM / BK bank masuk / keluar (by the bank line's side), RK reklasifikasi,
 * JP penyesuaian (typed journals, reversals, schedule instalments, tax and lease postings), JI impor buku besar, FJ / FB faktur
 * penjualan / tagihan pembelian (by the document's direction). The migration numbered older journals with the same rules, telling an
 * invoice by its receivable line.
 */
export const NUMBER_PREFIX_LABEL: Record<string, string> = {
  SA: "Saldo awal",
  BM: "Bank masuk",
  BK: "Bank keluar",
  RK: "Reklasifikasi",
  JP: "Jurnal penyesuaian",
  JI: "Impor buku besar",
  FJ: "Faktur penjualan",
  FB: "Tagihan pembelian",
};

type PrefixLine = { debit: bigint; credit: bigint; account: { isBank: boolean; fsLine: string } };

export type InvoiceSeries = "FJ" | "FB";

/** An invoice document's series by its direction. */
export const invoiceSeries = (direction: "SALES" | "PURCHASE"): InvoiceSeries => (direction === "SALES" ? "FJ" : "FB");

/**
 * The series of a journal. An invoice journal's comes from its document (`series`, given by lib/receivables/invoices.ts: the direction's
 * for a new document, the original's for a void, so a void stays in its original's series): a purchase bill may be recharged to a
 * receivable account, so the lines alone can't tell a sale from a bill. Without one, a receivable line means a sale.
 */
export function numberPrefix(kind: EntryKind, lines: PrefixLine[], series?: InvoiceSeries | null): string {
  switch (kind) {
    case "OPENING":
      return "SA";
    case "BANK":
      return lines.some((l) => l.account.isBank && l.credit > 0n) ? "BK" : "BM";
    case "RECLASS":
      return "RK";
    case "ADJUSTMENT":
      return "JP";
    case "IMPORTED":
      return "JI";
    case "INVOICE":
      if (series) return series;
      return lines.some((l) => l.account.fsLine === "PIUTANG_USAHA") ? "FJ" : "FB";
  }
}

export const formatNumber = (prefix: string, year: number, month: number, n: number) =>
  `${prefix}-${String(year % 100).padStart(2, "0")}${String(month).padStart(2, "0")}-${String(n).padStart(4, "0")}`;

/**
 * The next number of the series, taken inside the posting transaction: the counter row is locked until commit, so two posts at once get
 * two numbers and a rolled-back post gives its number back.
 */
export async function nextNumber(tx: Tx, entityId: string, prefix: string, date: Date): Promise<string> {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const [row] = await tx.$queryRaw<{ last: number }[]>`
    INSERT INTO "JournalSequence" ("entityId", "prefix", "year", "month", "last") VALUES (${entityId}, ${prefix}, ${year}, ${month}, 1)
    ON CONFLICT ("entityId", "prefix", "year", "month") DO UPDATE SET "last" = "JournalSequence"."last" + 1
    RETURNING "last"`;
  return formatNumber(prefix, year, month, Number(row.last));
}

/** A typed search that looks like a voucher number ("jp-2512-3", "BM-2511-0001"), in its stored form; else null. */
export function parseNumberQuery(q: string): string | null {
  const m = q.trim().toUpperCase().match(/^([A-Z]{2})[-/ ]?(\d{4})[-/ ]?(\d{1,6})$/);
  if (!m || !NUMBER_PREFIX_LABEL[m[1]]) return null;
  return `${m[1]}-${m[2]}-${m[3].padStart(4, "0")}`;
}
