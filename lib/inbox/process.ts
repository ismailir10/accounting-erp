import type { Db } from "@/lib/db";
import type { UploadItem, UploadStatus } from "@/lib/generated/prisma/client";
import type { AiProvider } from "@/lib/ai/provider";
import { importStatement, type ImportSummary } from "@/lib/import/pipeline";
import { ParseError } from "@/lib/import/types";
import { LedgerError } from "@/lib/ledger/post";
import { LedgerImportError, stageImport } from "@/lib/ledger-import/post";
import { MoneyError } from "@/lib/money";
import { infraErrorMessage } from "@/lib/db-errors";
import { itemView, type BankSection, type InboxItem } from "./check";
import { NeedsPasswordError, openWithKeyring } from "./keyring";
import { accountDisplay, planBatch, VALAS_BLOCKED } from "./plan";
import { ALREADY_BOOKED } from "./view";

/**
 * Books one file of a drop at a time (cycle 2026-10-10-unggah-inbox; the page calls this until nothing is left, so no request handles
 * the whole drop). Bank statements go through the existing import — the only writer of bank lines — once per section with a rekening;
 * ledger / Neraca files become a ledger-import draft for the usual mapping check. Nothing else is posted, and no AI is asked: with a
 * model set the import answers from the cache only (`aiLater`) and the action schedules the client's background run after the drop.
 */

type Scope = { firmId: string; clientId: string; batchId: string };
/** `passwords`: the ones that opened this drop's files, offered by the page (a server without SETTINGS_SECRET keeps none). */
export type ProcessInput = Scope & { actorId?: string | null; provider: AiProvider | null; passwords?: readonly string[] };

const LEDGER_DRAFT = "Draf buku besar siap dipetakan.";
const CHOOSE_SHEET = "File ini berisi beberapa tabel. Buka Impor buku besar untuk memilih sheet.";
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

/** The Bahasa message of a refusal the import or ledger staging gives (the same classes `fail()` in app/actions.ts shows as is). */
export function failureMessage(e: unknown): string {
  if (e instanceof ParseError || e instanceof LedgerError || e instanceof LedgerImportError || e instanceof MoneyError || e instanceof NeedsPasswordError) return e.message;
  const infra = infraErrorMessage(e);
  if (infra) return infra;
  console.error(e);
  return "Terjadi kesalahan tak terduga. Coba lagi.";
}

/** "Dibukukan ke BCA ·3814 · Januari 2026 · 242 baris". */
function bookedLine(display: string, s: ImportSummary) {
  const months = s.months.length > 1 ? `${s.months[0]}–${s.months.at(-1)}` : (s.months[0] ?? "");
  if (s.rows > 0 && s.duplicates === s.rows) return `${ALREADY_BOOKED} ke ${display} · ${months} (${s.rows} baris sama, dilewati)`;
  const dupes = s.duplicates ? ` (${s.duplicates} sudah ada, dilewati)` : "";
  return `Dibukukan ke ${display} · ${months} · ${s.rows} baris${dupes}${s.continuityOk ? "" : " · ada celah saldo"}`;
}

type Result = { status: UploadStatus; message: string; statementImportIds?: string[]; ledgerImportId?: string };

async function bookBank(db: Db, row: UploadItem, data: Buffer, input: ProcessInput): Promise<Result> {
  const accounts = await db.bankAccount.findMany({ where: { firmId: input.firmId, entity: { clientId: input.clientId } }, select: { id: true, bank: true, number: true } });
  const sections = row.sections as BankSection[];
  const single = sections.length === 1;
  const booked: string[] = [];
  const failed: string[] = [];
  const notes: string[] = [];
  const ids: string[] = [];
  // The password that opened the file (undefined: none needed), found once through the keyring and reused for every section.
  let key: { password?: string } | null = null;

  for (const s of sections) {
    const display = s.number ? accountDisplay(s.bank, s.number) : row.fileName;
    const say = (list: string[], text: string) => list.push(single ? text : `${display}: ${text}`);
    if ((s.currency ?? "IDR") !== "IDR") {
      notes.push(single ? VALAS_BLOCKED : `${display} (${s.currency}): rekening valas belum bisa dibukukan`);
      continue;
    }
    if (s.error) {
      say(failed, s.error);
      continue;
    }
    const account = s.number && digits(s.number) ? accounts.find((a) => digits(a.number) === digits(s.number)) : accounts.find((a) => a.id === s.bankAccountId);
    if (!account) {
      say(failed, "rekening belum ada di klien ini");
      continue;
    }
    const run = (password?: string) =>
      importStatement(db, { bankAccountId: account.id, fileName: row.fileName, data, provider: input.provider, aiLater: input.provider !== null, password, actorId: input.actorId, evidenceVersionId: row.evidenceVersionId ?? undefined });
    try {
      let summary: ImportSummary;
      if (key) summary = await run(key.password);
      else {
        const opened = await openWithKeyring(db, { firmId: input.firmId, clientId: input.clientId }, async (password) => ({ summary: await run(password), password }), { offered: input.passwords });
        key = { password: opened.result.password };
        summary = opened.result.summary;
      }
      ids.push(summary.importId);
      booked.push(bookedLine(accountDisplay(account.bank, account.number), summary));
    } catch (e) {
      // The keyring no longer opens the file (cleared since it was read): the drop's password field asks again.
      if (e instanceof NeedsPasswordError) return { status: "NEEDS_PASSWORD", message: e.message };
      say(failed, failureMessage(e));
    }
  }
  // One line per account: the page shows them as separate lines (whitespace-pre-line).
  const message = [...booked, ...failed, ...notes].join("\n");
  if (ids.length) return { status: "BOOKED", message, statementImportIds: ids };
  if (failed.length) return { status: "FAILED", message };
  return { status: "KEPT", message: notes.length ? message : "Disimpan di Dokumen." };
}

async function stageLedger(db: Db, row: UploadItem, data: Buffer, input: ProcessInput): Promise<Result> {
  const entities = await db.entity.findMany({ where: { firmId: input.firmId, clientId: input.clientId }, select: { id: true } });
  try {
    const staged = await stageImport(db, {
      firmId: input.firmId,
      clientId: input.clientId,
      fileName: row.fileName,
      data,
      actorId: input.actorId,
      evidenceVersionId: row.evidenceVersionId ?? undefined,
      entityId: entities.length === 1 ? entities[0].id : undefined,
    });
    if (staged.status === "STAGED") return { status: "DRAFT", message: LEDGER_DRAFT, ledgerImportId: staged.importId };
    return { status: "FAILED", message: CHOOSE_SHEET };
  } catch (e) {
    return { status: "FAILED", message: failureMessage(e) };
  }
}

/** A claim older than this is a crashed request's: the file counts as CHECKED again (well past any request's time limit). */
export const STALE_CLAIM_MS = 10 * 60 * 1000;

/**
 * Processes the next CHECKED file of the batch in plan order (bank statements oldest period first, then ledgers) and returns its line
 * with how many files are left (still CHECKED, or being processed by a parallel call). `item` is null when nothing is left to take.
 *
 * Two parallel calls never take the same file: each claims its file with a conditional update (CHECKED → PROCESSING) and moves on to
 * the next one when another call got there first. The claimed file always ends in a final status — an unexpected error makes it
 * FAILED — and a claim left behind by a crashed request is released after `STALE_CLAIM_MS`.
 */
export async function processNext(db: Db, input: ProcessInput): Promise<{ item: InboxItem | null; remaining: number }> {
  const scope = { firmId: input.firmId, clientId: input.clientId, batchId: input.batchId };
  await db.uploadItem.updateMany({ where: { ...scope, status: "PROCESSING", updatedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } }, data: { status: "CHECKED" } });
  const plan = await planBatch(db, scope);
  let claimed: string | null = null;
  for (const next of plan.items.filter((i) => i.status === "CHECKED")) {
    const { count } = await db.uploadItem.updateMany({ where: { id: next.id, ...scope, status: "CHECKED" }, data: { status: "PROCESSING", updatedAt: new Date() } });
    if (count === 1) {
      claimed = next.id;
      break;
    }
  }
  if (!claimed) return { item: null, remaining: await remainingIn(db, scope) };

  let result: Result;
  try {
    const row = await db.uploadItem.findFirstOrThrow({ where: { id: claimed, ...scope } });
    const version = row.evidenceVersionId ? await db.evidenceVersion.findFirst({ where: { id: row.evidenceVersionId, firmId: input.firmId }, select: { data: true } }) : null;
    if (row.kind === "OTHER") result = { status: "KEPT", message: "Disimpan di Dokumen." };
    else if (!version) result = { status: "FAILED", message: "File tidak tersimpan; unggah ulang." };
    else if (row.kind === "BANK") result = await bookBank(db, row, Buffer.from(version.data), input);
    else result = await stageLedger(db, row, Buffer.from(version.data), input);
  } catch (e) {
    // A refusal keeps its Bahasa message; anything else is logged and reads "Terjadi kesalahan tak terduga".
    result = { status: "FAILED", message: failureMessage(e) };
  }

  // If even this write fails, the claim is released after STALE_CLAIM_MS and the file is processed again (duplicate rows are skipped).
  const updated = await db.uploadItem.update({
    where: { id: claimed },
    data: { status: result.status, message: result.message, statementImportIds: result.statementImportIds ?? [], ledgerImportId: result.ledgerImportId ?? null },
  });
  return { item: itemView(updated), remaining: await remainingIn(db, scope) };
}

/** Files of the batch still to process: CHECKED, or claimed by a parallel call (so only the last call to finish sees 0). */
function remainingIn(db: Db, scope: { firmId: string; clientId: string; batchId: string }) {
  return db.uploadItem.count({ where: { ...scope, status: { in: ["CHECKED", "PROCESSING"] } } });
}
