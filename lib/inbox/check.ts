import type { Db } from "@/lib/db";
import type { UploadItem, UploadKind, UploadStatus } from "@/lib/generated/prisma/client";
import { hash, json } from "@/lib/evidence/store";
import { postableTables } from "@/lib/evidence/extract";
import { parseStatementSections } from "@/lib/import/parsers/index";
import { PdfPasswordError } from "@/lib/import/parsers/pdf";
import { ScanError, SourceAmountError, SourceCurrencyError, SourceDateError, StatementRepairError, UnreadableFileError, YearNeededError, type ParsedStatement } from "@/lib/import/types";
import { sniffFile } from "@/lib/import/workbook";
import type { RememberedLayout } from "@/lib/import/mapped";
import { addPassword, NeedsPasswordError, openWithKeyring } from "./keyring";
import { liveImports, liveOutcome } from "./live";
import type { PreviewFile } from "./propose";
import { storeFile } from "./store";

/** One statement of a bank file as read (amounts in whole Rupiah as strings: JSON has no bigint). */
export type BankSection = {
  bank: string;
  number: string | null;
  holder: string | null;
  currency: string | null;
  periodStart: string;
  periodEnd: string;
  rows: number;
  opening: string;
  closing: string;
  error: string | null;
  /** A section without a readable number: the rekening the accountant chose for it (lib/inbox/plan.ts `confirmBatch`). */
  bankAccountId?: string;
};
/** One table of a ledger / Neraca file the ledger import would read. */
export type LedgerSection = { sheet: string; mode: "LEDGER" | "NERACA"; rows: number; periodStart: string | null; periodEnd: string | null };

/** What the Unggah page shows for one file: no bytes, no password. */
export type InboxItem = {
  id: string;
  batchId: string;
  fileName: string;
  kind: UploadKind;
  status: UploadStatus;
  message: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  sections: BankSection[] | LedgerSection[];
  evidenceVersionId: string | null;
  statementImportIds: string[];
  ledgerImportId: string | null;
  createdAt: string;
};

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

export function itemView(row: UploadItem): InboxItem {
  return {
    id: row.id,
    batchId: row.batchId,
    fileName: row.fileName,
    kind: row.kind,
    status: row.status,
    message: row.message,
    periodStart: day(row.periodStart),
    periodEnd: day(row.periodEnd),
    sections: row.sections as BankSection[] | LedgerSection[],
    evidenceVersionId: row.evidenceVersionId,
    statementImportIds: row.statementImportIds,
    ledgerImportId: row.ledgerImportId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The account holder printed on the statement. Remove the cast when #143 (bank-reader-fixes) lands and `holder` is on ParsedStatement. */
function holderOf(st: ParsedStatement): string | null {
  return (st as { holder?: string }).holder ?? null;
}

function bankSection(st: ParsedStatement): BankSection {
  return {
    bank: st.format,
    number: st.accountNumber,
    holder: holderOf(st),
    currency: st.section?.currency ?? st.currency ?? null,
    periodStart: day(st.periodStart)!,
    periodEnd: day(st.periodEnd)!,
    rows: st.rows.length,
    opening: st.openingBalance.toString(),
    closing: st.closingBalance.toString(),
    error: st.error ?? null,
  };
}

/** Tables the ledger import would read; none for PDFs and for files that aren't spreadsheets or CSV tables. */
async function ledgerSections(name: string, data: Buffer): Promise<LedgerSection[]> {
  if (sniffFile(data) === "PDF") return [];
  const tables = await postableTables(name, data);
  return [...tables].map(([sheet, t]) => ({ sheet, mode: t.mode, rows: t.rows, periodStart: t.periodStart, periodEnd: t.periodEnd }));
}

const span = (starts: (string | null)[], ends: (string | null)[]) => {
  const s = starts.filter((x): x is string => !!x).sort();
  const e = ends.filter((x): x is string => !!x).sort();
  return { periodStart: s[0] ? new Date(s[0]) : null, periodEnd: e.length ? new Date(e.at(-1)!) : null };
};

type Outcome = { kind: UploadKind; status: UploadStatus; message: string | null; sections: BankSection[] | LedgerSection[]; periodStart: Date | null; periodEnd: Date | null };
const outcome = (kind: UploadKind, status: UploadStatus, message: string | null): Outcome => ({ kind, status, message, sections: [], periodStart: null, periodEnd: null });
const KEPT = "Disimpan di Dokumen.";
const ledgerOutcome = (sections: LedgerSection[], message: string | null): Outcome => ({ kind: "LEDGER", status: "CHECKED", message, sections, ...span(sections.map((t) => t.periodStart), sections.map((t) => t.periodEnd)) });

/** A refusal that only a real bank statement produces: the reader's message is the answer (year, date order, amounts, currency). */
const statementRefusal = (e: unknown) => e instanceof YearNeededError || e instanceof SourceDateError || e instanceof SourceAmountError || e instanceof SourceCurrencyError;

/** The firm's *Atur kolom* layouts, tried only when every reader refuses a file, as the import itself does. */
async function firmLayouts(db: Db, firmId: string) {
  return (await db.statementLayout.findMany({ where: { firmId }, select: { id: true, label: true, signature: true, mapping: true } })).map((l) => ({
    ...l,
    mapping: l.mapping as unknown as RememberedLayout["mapping"],
  }));
}

type Read = { sections: ParsedStatement[] } | { error: unknown };

/**
 * Reads a file with the readers, with or without a password. Only a password refusal throws (for `openWithKeyring`); other errors come
 * back as values: a password that opened the file still opened it, whatever the reader says next.
 */
function opener(name: string, data: Buffer, layouts: Awaited<ReturnType<typeof firmLayouts>>) {
  return async (password?: string): Promise<Read> => {
    try {
      return { sections: await parseStatementSections(name, data, { password, layouts }) };
    } catch (e) {
      if (e instanceof PdfPasswordError) throw e;
      return { error: e };
    }
  };
}

/** What an opened file is (bank / ledger / other), from what the readers made of it. */
async function outcomeOf(name: string, data: Buffer, read: Read, note: string | null): Promise<Outcome> {
  if ("sections" in read) {
    // A ledger with a balance column reads as a generic statement too: a postable ledger table wins over the generic reader.
    if (read.sections.every((st) => st.format === "GENERIC")) {
      const ledger = await ledgerSections(name, data);
      if (ledger.length) return ledgerOutcome(ledger, note);
    }
    const sections = read.sections.map(bankSection);
    const period = span(sections.map((s) => s.periodStart), sections.map((s) => s.periodEnd));
    const failed = sections.every((s) => s.error);
    return { kind: "BANK", status: failed ? "FAILED" : "CHECKED", message: failed ? sections[0].error : note, sections, ...period };
  }

  const e = read.error;
  if (e instanceof ScanError) return outcome("OTHER", "KEPT", e.message);
  if (statementRefusal(e)) return outcome("BANK", "FAILED", (e as Error).message);
  if (e instanceof UnreadableFileError) {
    const ledger = await ledgerSections(name, data);
    if (ledger.length) return ledgerOutcome(ledger, note);
    if (e instanceof StatementRepairError) return outcome("BANK", "FAILED", e.message);
  }
  return outcome("OTHER", "KEPT", KEPT);
}

/** An item's columns for what `classify` read. */
const outcomeData = (r: Outcome) => ({ kind: r.kind, status: r.status, message: r.message, periodStart: r.periodStart, periodEnd: r.periodEnd, sections: json(r.sections) });

const locked = (data: Buffer, e: NeedsPasswordError) => outcome(sniffFile(data) === "PDF" ? "BANK" : "OTHER", "NEEDS_PASSWORD", e.message);

/** Reads what a file is (bank / ledger / other), opening a locked PDF with the offered password or the client's keyring. Writes no item. */
async function classify(db: Db, input: Omit<CheckInput, "batchId">): Promise<Outcome> {
  const { name, data } = input;
  // The firm's layouts: a recurring export the firm once mapped is a bank statement here too. Its rekening is asked in the card;
  // booking reads it with that bank's layouts.
  const tryOpen = opener(name, data, await firmLayouts(db, input.firmId));
  let opened;
  try {
    opened = await openWithKeyring(db, { firmId: input.firmId, clientId: input.clientId }, tryOpen, { offered: input.password });
  } catch (e) {
    if (e instanceof NeedsPasswordError) return locked(data, e);
    throw e;
  }
  let note: string | null = null;
  if (opened.usedOffered) {
    try {
      await addPassword(db, { firmId: input.firmId, clientId: input.clientId, password: input.password!, actorId: input.actorId });
    } catch (e) {
      note = e instanceof Error ? e.message : null;
    }
  }
  return outcomeOf(name, data, opened.result, note);
}

/**
 * *Klien baru* from files (cycle 2026-10-10-new-client-from-files): reads a dropped file for a client that doesn't exist yet. Nothing is
 * stored and no keyring is read — a locked PDF opens only with the offered password. The page drops the same files into the new client's
 * Unggah afterwards, where they are stored and read again.
 */
export async function previewFile(db: Db, input: { firmId: string; name: string; data: Buffer; password?: string }): Promise<PreviewFile> {
  const fileName = input.name.trim().slice(0, 240) || "file";
  const tryOpen = opener(fileName, input.data, await firmLayouts(db, input.firmId));
  let result: Outcome;
  try {
    result = await outcomeOf(fileName, input.data, (await openWithKeyring(db, null, tryOpen, { offered: input.password })).result, null);
  } catch (e) {
    if (!(e instanceof NeedsPasswordError)) throw e;
    result = locked(input.data, e);
  }
  return { fileName, kind: result.kind, status: result.status, message: result.message, sections: result.sections };
}

type CheckInput = { firmId: string; clientId: string; batchId: string; name: string; data: Buffer; password?: string; actorId?: string | null };

/**
 * Stores one dropped file in the client's inbox and reads what it is — bank statement, ledger / Neraca, or another document — without
 * writing any journal. The outcome is an `UploadItem` row (the page's persistent per-file line); booking happens later (T3).
 */
export async function checkFile(db: Db, input: CheckInput): Promise<InboxItem> {
  const fileName = input.name.trim().slice(0, 240) || "file";
  const base = { firmId: input.firmId, clientId: input.clientId, batchId: input.batchId, fileName };
  let stored;
  try {
    stored = await storeFile(db, { firmId: input.firmId, clientId: input.clientId, name: fileName, data: input.data });
  } catch (e) {
    // A foreign or missing client is refused outright; a file the store refuses (size, capacity) still gets its line.
    if (e instanceof Error && e.message === "Klien tidak ditemukan.") throw e;
    const message = e instanceof Error ? e.message : "File tidak bisa disimpan.";
    return itemView(await db.uploadItem.create({ data: { ...base, sha256: hash(input.data), kind: "OTHER", status: "FAILED", message } }));
  }
  const result = await classify(db, { ...input, name: fileName });
  return itemView(await db.uploadItem.create({ data: { ...base, sha256: stored.sha256, evidenceVersionId: stored.versionId, ...outcomeData(result) } }));
}

/**
 * Dokumen's *Bukukan lewat Unggah* (cycle 2026-10-11-dokumen-to-unggah): a file already stored in one of this client's Dokumen
 * collections becomes a line of a new Unggah drop — read exactly like a dropped file (keyring included), its bytes not stored again.
 * A version Unggah already booked or staged returns that line and creates none, so a second click never books twice.
 */
export async function adoptVersion(db: Db, input: { firmId: string; clientId: string; batchId: string; versionId: string; actorId?: string | null }): Promise<InboxItem> {
  const { firmId, clientId } = input;
  const version = await db.evidenceVersion.findFirst({
    where: { id: input.versionId, firmId, document: { firmId, intake: { firmId, clientId } } },
    select: { id: true, name: true, hash: true, data: true },
  });
  if (!version) throw new Error("Dokumen tidak ditemukan.");
  // As the books stand now: a line counts as done only while every import it made still exists (a combined file with one section's
  // import removed is handed over again; booking it skips the sections still there as duplicates) or its ledger draft is live.
  const earlier = await db.uploadItem.findMany({ where: { firmId, clientId, evidenceVersionId: version.id, status: { in: ["BOOKED", "DRAFT"] } }, orderBy: { createdAt: "desc" } });
  const live = await liveImports(db, firmId, earlier);
  const done = earlier.find((r) => {
    const now = liveOutcome(r, live);
    if (now.status === "DRAFT" || (now.status === "BOOKED" && now.ledgerImportId)) return true;
    return now.status === "BOOKED" && r.statementImportIds.every((id) => live.statements.has(id));
  });
  if (done) return itemView(done);
  const fileName = version.name.trim().slice(0, 240) || "file";
  const result = await classify(db, { firmId, clientId, name: fileName, data: Buffer.from(version.data), actorId: input.actorId });
  return itemView(await db.uploadItem.create({ data: { firmId, clientId, batchId: input.batchId, fileName, sha256: version.hash, evidenceVersionId: version.id, ...outcomeData(result) } }));
}

/**
 * Reads an item's stored file again — the same bytes, not stored twice — offering `password` (the Unggah page's one password field for
 * every locked file of a drop). The item takes the new outcome: opened files become CHECKED, still-locked ones stay NEEDS_PASSWORD.
 */
export async function recheckItem(db: Db, row: UploadItem, input: { password?: string; actorId?: string | null }): Promise<InboxItem> {
  if (!row.evidenceVersionId) return itemView(row);
  const version = await db.evidenceVersion.findFirstOrThrow({ where: { id: row.evidenceVersionId, firmId: row.firmId }, select: { data: true } });
  const result = await classify(db, { firmId: row.firmId, clientId: row.clientId, name: row.fileName, data: Buffer.from(version.data), password: input.password, actorId: input.actorId });
  return itemView(await db.uploadItem.update({ where: { id: row.id }, data: outcomeData(result) }));
}
