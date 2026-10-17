import type { EntryKind } from "@/lib/generated/prisma/enums";

/** How each journal kind reads in Bahasa (Buku Besar, Jurnal Umum, the Excel exports). */
export const ENTRY_KIND_LABEL: Record<EntryKind, string> = {
  OPENING: "Saldo awal",
  BANK: "Mutasi bank",
  RECLASS: "Reklasifikasi",
  ADJUSTMENT: "Penyesuaian",
  IMPORTED: "Impor buku besar",
  INVOICE: "Faktur",
};

/** What `entrySource` reads from a journal entry; spread into a Prisma `select`/`include` of `JournalEntry`. */
export const ENTRY_SOURCE_SELECT = {
  kind: true,
  sourceRef: true,
  installment: true,
  bankTransaction: { select: { rowNumber: true, sourceSheet: true, import: { select: { fileName: true } }, bankAccount: { select: { label: true } } } },
  ledgerImport: { select: { fileName: true } },
  invoice: { select: { number: true } },
  voidedInvoice: { select: { number: true } },
  schedule: { select: { memo: true } },
  reverses: { select: { date: true, memo: true } },
} as const;

export type EntrySourceInput = {
  kind: EntryKind;
  sourceRef: string | null;
  installment: number | null;
  bankTransaction: { rowNumber: number; sourceSheet: string | null; import: { fileName: string }; bankAccount: { label: string } } | null;
  ledgerImport: { fileName: string } | null;
  invoice: { number: string } | null;
  voidedInvoice: { number: string } | null;
  schedule: { memo: string } | null;
  reverses: { date: Date; memo: string } | null;
};

/**
 * Where a journal came from, in one line (accounting-rules 5: every entry keeps its source): the statement row behind a bank line,
 * the file rows behind an imported entry, the document behind an invoice, the schedule behind an installment. Null for a journal typed
 * by hand (who posted it is shown next to it).
 */
export function entrySource(e: EntrySourceInput): string | null {
  if (e.bankTransaction) {
    const t = e.bankTransaction;
    return `${t.bankAccount.label} · ${t.import.fileName}, ${t.sourceSheet ? `lembar ${t.sourceSheet}, ` : ""}baris ${t.rowNumber}`;
  }
  if (e.ledgerImport) return `${e.ledgerImport.fileName}${e.sourceRef ? ` · ${e.sourceRef}` : ""}`;
  if (e.invoice) return `Dokumen ${e.invoice.number}`;
  if (e.voidedInvoice) return `Pembatalan dokumen ${e.voidedInvoice.number}`;
  if (e.schedule) return `Jadwal “${e.schedule.memo}”${e.installment ? `, cicilan ${e.installment}` : ""}`;
  if (e.reverses) return `Membalik jurnal “${e.reverses.memo}”`;
  return e.sourceRef;
}
