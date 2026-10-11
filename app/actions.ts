"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getClientForMember, getCurrentMember } from "@/lib/tenant";
import { checkDraftSize, createMappedDraft, createOcrDraft, importOcrDraft, ocrEnabled, updateOcrDraft, type OcrRowInput } from "@/lib/ocr/draft";
import { readGrid } from "@/lib/import/grid";
import { mappingFromJson, MAX_COLUMNS, readMapped, suggestMapping, type ColumnMapping } from "@/lib/import/mapped";
import { forgetLayout } from "@/lib/import/layouts";
import { OcrError } from "@/lib/ocr/pages";
import { clearReportComment, CommentError, draftCommentary, saveReportComment } from "@/lib/reports/report-comment";
import { headers } from "next/headers";
import { appUrl } from "@/lib/supabase/env";
import { formatDate } from "@/lib/format";
import { createUploadLink, revokeUploadLink, uploadPath, UploadLinkError } from "@/lib/upload-links";
import { importStatement, type ImportSummary } from "@/lib/import/pipeline";
import { resolveProvider } from "@/lib/settings/ai";
import { acceptSimilar, reviewTransaction, splitTransaction, unpairTransfer, type SplitPartInput } from "@/lib/review";
import { CloseError, lockPeriod, runControls, unlockPeriod } from "@/lib/controls";
import { LedgerError } from "@/lib/ledger/post";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { reverseEntry } from "@/lib/ledger/reverse";
import { createSchedule, postAllDue, postInstallment, stopSchedule, type ScheduleInput } from "@/lib/adjust/schedules";
import { createAsset, type AssetInput } from "@/lib/assets/register";
import { disposeAsset, type DisposalInput } from "@/lib/assets/dispose";
import { cancelLease, createLease, postLeaseMonths, type LeaseInput } from "@/lib/leases/register";
import { deleteEmployee, importCensus, saveBenefitSetting, saveEmployee, uploadMortality, type BenefitSettingInput, type EmployeeInput } from "@/lib/benefits/census";
import { postBenefits } from "@/lib/benefits/valuation";
import { createInvoice, voidInvoice, type InvoiceInput } from "@/lib/receivables/invoices";
import { setContactChannel } from "@/lib/receivables/channels";
import { settleFifo, settleWithReclass, tagAdvance, unsettle } from "@/lib/receivables/settle";
import { candidateViews, type CandidateView } from "@/lib/receivables/view";
import { postCkpn, saveCkpnSetting, type CkpnSettingInput } from "@/lib/receivables/ckpn";
import { taxPack } from "@/lib/tax/pack";
import { postTax } from "@/lib/tax/post";
import { postPpnOffset } from "@/lib/tax/ppn-offset";
import { deleteInstalment, setInstalment } from "@/lib/tax/instalment";
import { recordInventoryCount } from "@/lib/inventory";
import { acceptSuggestion, addCorrection, addCredit, deleteCorrection, deleteCredit, deleteLoss, dismissSuggestion, setCorrectionPercent, setLoss, setRegime, setTaxMonth, type CorrectionInput, type CreditInput } from "@/lib/tax/records";
import type { TaxPostingKind, TaxRegime } from "@/lib/generated/prisma/enums";
import { AccountMismatchError, AmbiguousDateError, ParseError, ScanError, UnreadableFileError, YearNeededError } from "@/lib/import/types";
import { PdfPasswordError } from "@/lib/import/parsers/pdf";
import { MoneyError, parseMoney } from "@/lib/money";
import { dateOnly } from "@/lib/format";
import { liveUploadFile } from "@/lib/demo/seed";
import { addBankAccount, addClient, addEntity, OnboardingError, setBankAccountBank, type NewClientInput } from "@/lib/onboarding";
import { EntitySettingsError, setFiscalYearEnd, setReportingFramework } from "@/lib/entity-settings";
import { setClientModules } from "@/lib/clients/modules";
import { FormatError, resetReportFormat, saveReportFormat } from "@/lib/reports/format-settings";
import { deleteSubledgerImport, importAging, resolveSubledgerFinding, SubledgerError } from "@/lib/reconcile/subledger";
import { bookFaktur, deleteFaktur, FakturError, importFaktur } from "@/lib/tax/faktur";
import { BupotError, deleteBupot, importBupot } from "@/lib/tax/bupot";
import { OpeningError, postOpening, type OpeningLineInput } from "@/lib/opening";
import { FindingError, resolveOpeningFinding } from "@/lib/findings";
import { removeLedgerImport, removeStatementImport, RemoveImportError } from "@/lib/imports/remove";
import { saveControlNote } from "@/lib/controls/ack";
import { closeHistoryMonth, historyPreview, type HistoryPreview, type YearMonth } from "@/lib/controls/history";
import type { TaxTag, WithholdingKind } from "@/lib/generated/prisma/enums";
import { RateError, upsertRate, validateRateInput } from "@/lib/fx/rates";
import { MAX_UPLOAD_BYTES } from "@/lib/upload";
import { postRevaluation, RevaluationError } from "@/lib/fx/revalue";
import { reviewClose, type CloseReviewView } from "@/lib/controls/ai-review";
import { explainControl, ExplainError, type ControlExplanation } from "@/lib/controls/explain";
import { dismissProposal, postProposal } from "@/lib/adjust/proposals";
import { postSuspenseCorrection, SUSPENSE_NOT_DISMISSABLE, SUSPENSE_PREFIX } from "@/lib/adjust/suspense";
import { AiBudgetError } from "@/lib/ai/budget";
import { AI_LONG_TIMEOUT_MS, AiAnswerError } from "@/lib/ai/provider";
import { aiRunForView, scheduleAiRun } from "@/lib/ai/background";
import type { AiRunView } from "@/lib/ai/run";
import type { AiProvider } from "@/lib/ai/provider";
import { acceptCheck, LedgerImportError, postImport, stageImport } from "@/lib/ledger-import/post";
import { acceptMappings, MappingError, suggestMappings } from "@/lib/ledger-import/mapping";
import { infraErrorMessage } from "@/lib/db-errors";
import { deleteClient, DeleteClientError } from "@/lib/clients/delete";
import { AccessError, requireCapability } from "@/lib/auth/session";
import type { Capability } from "@/lib/auth/permissions";
import { OrgError } from "@/lib/org";
import type { FsLine } from "@/lib/coa/template";
import type { MapMethod } from "@/lib/generated/prisma/enums";

/**
 * Server actions — the only write path from the UI. Each returns {ok, …} or {ok:false, error}
 * with a Bahasa message the UI shows verbatim. Domain errors are expected; others are bugs.
 */
type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; needsPassword?: boolean; needsYear?: boolean; yearGuess?: number | null; fields?: Record<string, string>; suggestBankAccountId?: string; scanned?: { ocrReady: boolean }; mappable?: boolean };

function fail(e: unknown): { ok: false; error: string; needsPassword?: boolean; needsYear?: boolean; yearGuess?: number | null } {
  if (e instanceof PdfPasswordError) return { ok: false, error: e.message, needsPassword: true };
  if (e instanceof YearNeededError) return { ok: false, error: e.message, needsYear: true, yearGuess: e.guess };
  if (e instanceof DeleteClientError || e instanceof AccessError || e instanceof OrgError) return { ok: false, error: e.message };
  if (e instanceof ParseError || e instanceof LedgerError || e instanceof CloseError || e instanceof OpeningError || e instanceof FindingError || e instanceof RemoveImportError || e instanceof MoneyError || e instanceof RateError || e instanceof RevaluationError || e instanceof LedgerImportError || e instanceof MappingError || e instanceof EntitySettingsError || e instanceof FormatError || e instanceof SubledgerError || e instanceof FakturError || e instanceof BupotError) return { ok: false, error: e.message };
  const infra = infraErrorMessage(e);
  console.error(e);
  return { ok: false, error: infra ?? "Terjadi kesalahan tak terduga. Coba lagi." };
}

/**
 * The guard of every client action in this file (ADR 0017): the organisation is open and, for a write, writable; the role has the
 * capability; the client is in the organisation and, for an AKUNTAN or VIEWER, assigned. tests/unit/action-guards.test.ts fails on an
 * exported action that reaches no requireCapability.
 */
async function clientFor(capability: Capability, clientId: string) {
  await requireCapability(capability, { clientId });
  return getClientForMember(clientId);
}

/** Import, review, post, adjust, sign off, lock: the everyday work on a client's books. AI calls count as writes (they spend budget). */
async function writeClient(clientId: string) {
  return clientFor("books.write", clientId);
}

const MAX_UPLOAD = MAX_UPLOAD_BYTES;

/**
 * An import answers without waiting on a paid AI call (cycle 2026-10-10-import-ai-background): with a model set, the pipeline uses only
 * cached answers (`aiLater`) and the client's background run asks about the rest after the response. Without one, today's rules-only import.
 */
async function importOptions() {
  const provider = await resolveProvider(prisma);
  return { provider, aiLater: provider !== null };
}

/** After a successful import: hand the lines left on a simple guess to the client's background run. */
async function afterImport(client: { id: string; firmId: string }, provider: AiProvider | null): Promise<AiRunView | null> {
  return provider ? scheduleAiRun(prisma, client, provider) : null;
}

export async function importAction(formData: FormData): Promise<Result<{ summary: ImportSummary; aiRun: AiRunView | null }>> {
  let banks: { id: string; number: string }[] = [];
  let selected = "";
  try {
    const clientId = String(formData.get("clientId"));
    const bankAccountId = String(formData.get("bankAccountId"));
    const file = formData.get("file");
    const password = String(formData.get("password") ?? "") || undefined; // used once to open the PDF, never stored
    const yearText = String(formData.get("year") ?? "").trim();
    const year = yearText ? Number(yearText) : undefined;
    if (year !== undefined && !(Number.isInteger(year) && year >= 2000 && year <= 2100)) return { ok: false, error: "Tahun harus 4 angka, misalnya 2026.", needsYear: true };
    const client = await writeClient(clientId);
    banks = client.entities.flatMap((e) => e.bankAccounts);
    selected = bankAccountId;
    if (!client.entities.some((e) => e.bankAccounts.some((b) => b.id === bankAccountId))) return { ok: false, error: "Pilih rekening bank dulu." };
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Pilih file rekening koran (PDF, CSV, XLS, atau XLSX)." };
    if (file.size > MAX_UPLOAD) return { ok: false, error: "File terlalu besar (maks. 5 MB)." };
    const ai = await importOptions();
    const summary = await importStatement(prisma, { bankAccountId, fileName: file.name, data: Buffer.from(await file.arrayBuffer()), ...ai, password, year, actorId: (await getCurrentMember()).id });
    const aiRun = await afterImport(client, ai.provider);
    revalidatePath(`/clients/${clientId}`, "layout");
    return { ok: true, summary, aiRun };
  } catch (e) {
    // The file belongs to another account of this client: say which, so the form can switch to it in one click.
    if (e instanceof AccountMismatchError) {
      const digits = (s: string) => s.replace(/\D/g, "");
      const match = banks.find((b) => b.id !== selected && e.fileNumbers.some((n) => digits(n) === digits(b.number)));
      return { ...fail(e), suggestBankAccountId: match?.id };
    }
    // A scan or photo: the form offers Baca scan dengan AI when the workspace switch is on and a model is configured (I2a).
    if (e instanceof ScanError) return { ok: false, error: e.message, scanned: { ocrReady: (await ocrEnabled(prisma)) && (await resolveProvider(prisma)) !== null } };
    // A text file no reader knows: the form offers Atur kolom.
    if (e instanceof UnreadableFileError || e instanceof AmbiguousDateError) return { ok: false, error: e.message, mappable: true };
    return fail(e);
  }
}

/** The upload of an Atur kolom step: the client's own bank account and a file within the limit; the bytes are read here, on the server. */
async function mappingUpload(formData: FormData) {
  const client = await writeClient(String(formData.get("clientId")));
  const bankAccountId = String(formData.get("bankAccountId"));
  if (!client.entities.some((e) => e.bankAccounts.some((b) => b.id === bankAccountId))) throw new ParseError("Pilih rekening bank dulu.");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) throw new ParseError("Pilih file rekening koran.");
  if (file.size > MAX_UPLOAD) throw new ParseError("File terlalu besar (maks. 5 MB).");
  const password = String(formData.get("password") ?? "") || undefined; // used once to open the PDF, never stored
  return { client, bankAccountId, file, password, data: Buffer.from(await file.arrayBuffer()) };
}

/** Rows of a grid sheet shown in Atur kolom: the first 60, cells cut to 80 characters (the mapping is read from the whole file later). */
export type GridPreview = { kind: "CSV" | "XLSX" | "PDF"; sheets: { name: string; rows: string[][]; totalRows: number; width: number; suggestion: ColumnMapping }[] };
const PREVIEW_ROWS = 60;

/** Atur kolom, step 1: the file as Buku sees it, with a first guess at the mapping per sheet. Nothing is stored. */
export async function columnGridAction(formData: FormData): Promise<Result<{ grid: GridPreview }>> {
  try {
    const { data, password } = await mappingUpload(formData);
    const grid = await readGrid(data, { password });
    const sheets = grid.sheets.map((s) => {
      const suggestion = suggestMapping(grid, s.name);
      const shown = Math.max(PREVIEW_ROWS, Math.min(s.rows.length, suggestion.firstRow + 20));
      return {
        name: s.name,
        rows: s.rows.slice(0, shown).map((r) => r.slice(0, MAX_COLUMNS).map((c) => (c.length > 80 ? `${c.slice(0, 79)}…` : c))),
        totalRows: s.rows.length,
        width: Math.min(MAX_COLUMNS, Math.max(1, ...s.rows.map((r) => r.length))),
        suggestion,
      };
    });
    return { ok: true, grid: { kind: grid.kind, sheets } };
  } catch (e) {
    return fail(e);
  }
}

export type MappedPreview = { rows: { row: number; date: string; description: string; amount: string; balance: string | null }[]; total: number; notes: string[]; opening: string };

/** Atur kolom, step 2: the first five rows the mapping reads from the whole file, for the accountant to check. Nothing is stored. */
export async function mappedPreviewAction(formData: FormData): Promise<Result<{ preview: MappedPreview }>> {
  try {
    const { data, password, file } = await mappingUpload(formData);
    const mapping = mappingFromJson(String(formData.get("mapping") ?? ""));
    const grid = await readGrid(data, { password });
    const st = readMapped(grid, mapping, { fileName: file.name });
    checkDraftSize(st.rows.length);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return {
      ok: true,
      preview: { rows: st.rows.slice(0, 5).map((r) => ({ row: r.rowNumber, date: iso(r.date), description: r.description, amount: r.amount.toString(), balance: r.balance?.toString() ?? null })), total: st.rows.length, notes: st.notes ?? [], opening: st.openingBalance.toString() },
    };
  } catch (e) {
    if (e instanceof OcrError) return { ok: false, error: e.message };
    return fail(e);
  }
}

/** Atur kolom, step 3: every row read into a draft on Periksa baris (proved by the running balance there, imported only by a click). */
export async function mappedDraftAction(formData: FormData): Promise<Result<{ draftId: string }>> {
  try {
    const { client, bankAccountId, file, password, data } = await mappingUpload(formData);
    const mapping = mappingFromJson(String(formData.get("mapping") ?? ""));
    const draft = await createMappedDraft(prisma, { firmId: client.firmId, clientId: client.id, bankAccountId, fileName: file.name, data, password, mapping, actorId: (await getCurrentMember()).id });
    return { ok: true, draftId: draft.id };
  } catch (e) {
    if (e instanceof OcrError) return { ok: false, error: e.message };
    return fail(e);
  }
}

/** *Lupakan pemetaan ini*: the firm stops reading files of that layout with it; imports already made stay. */
export async function forgetLayoutAction(clientId: string, layoutId: string): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    if (!(await forgetLayout(prisma, client.firmId, layoutId))) return { ok: false, error: "Pemetaan ini sudah tidak tersimpan." };
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Baca scan dengan AI (I2a): one budgeted transcription into a draft the accountant proves and imports; nothing posts here. */
export async function ocrAction(formData: FormData): Promise<Result<{ draftId: string }>> {
  try {
    const clientId = String(formData.get("clientId"));
    const bankAccountId = String(formData.get("bankAccountId"));
    const file = formData.get("file");
    const client = await writeClient(clientId);
    if (!client.entities.some((e) => e.bankAccounts.some((b) => b.id === bankAccountId))) return { ok: false, error: "Pilih rekening bank dulu." };
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Pilih file scan rekening koran." };
    if (file.size > MAX_UPLOAD) return { ok: false, error: "File terlalu besar (maks. 5 MB)." };
    const draft = await createOcrDraft(prisma, { firmId: client.firmId, clientId: client.id, bankAccountId, fileName: file.name, data: Buffer.from(await file.arrayBuffer()), provider: await resolveProvider(prisma), actorId: (await getCurrentMember()).id });
    return { ok: true, draftId: draft.id };
  } catch (e) {
    if (e instanceof OcrError || e instanceof AiBudgetError || e instanceof AiAnswerError) return { ok: false, error: e.message };
    if (e instanceof Error && (e.name === "TimeoutError" || /^(AI \d|Model )/.test(e.message))) {
      console.error(e);
      return { ok: false, error: "AI tidak bisa membaca scan saat ini. Coba lagi nanti, atau minta e-statement." };
    }
    return fail(e);
  }
}

/** The accountant's corrections on a scan draft; the proof re-runs on the page. */
export async function saveOcrDraftAction(clientId: string, draftId: string, input: { rows: OcrRowInput[]; opening: string; closing: string }): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    await updateOcrDraft(prisma, { firmId: client.firmId, clientId: client.id, draftId, ...input });
    revalidatePath(`/clients/${client.id}/import/ocr/${draftId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof OcrError) return { ok: false, error: e.message };
    return fail(e);
  }
}

/** Import a proved scan draft through the normal statement pipeline (the accountant's click). */
export async function importOcrDraftAction(clientId: string, draftId: string): Promise<Result<{ summary: ImportSummary; aiRun: AiRunView | null }>> {
  try {
    const client = await writeClient(clientId);
    const ai = await importOptions();
    const summary = await importOcrDraft(prisma, { firmId: client.firmId, clientId: client.id, draftId, ...ai, actorId: (await getCurrentMember()).id });
    const aiRun = await afterImport(client, ai.provider);
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, summary, aiRun };
  } catch (e) {
    if (e instanceof OcrError) return { ok: false, error: e.message };
    return fail(e);
  }
}

/** Demo shortcut: import the held-back statement without hunting for the file. */
export async function importSampleAction(clientId: string, bankAccountId: string): Promise<Result<{ summary: ImportSummary; aiRun: AiRunView | null }>> {
  try {
    const client = await writeClient(clientId);
    if (!client.entities.some((e) => e.bankAccounts.some((b) => b.id === bankAccountId))) return { ok: false, error: "Rekening tidak ditemukan." };
    const f = await liveUploadFile();
    const ai = await importOptions();
    const summary = await importStatement(prisma, { bankAccountId, fileName: f.fileName, data: f.data, ...ai, actorId: (await getCurrentMember()).id });
    const aiRun = await afterImport(client, ai.provider);
    revalidatePath(`/clients/${clientId}`, "layout");
    return { ok: true, summary, aiRun };
  } catch (e) {
    return fail(e);
  }
}

async function assertTxInFirm(bankTxId: string) {
  const t = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: bankTxId }, include: { bankAccount: { include: { entity: true } } } });
  await writeClient(t.bankAccount.entity.clientId);
  return t.bankAccount.entity.clientId;
}

/** *Lepas pasangan*: two lines are not one transfer; both go back to Review and are never paired again (UC-B2). */
export async function unpairTransferAction(input: { bankTxId: string }): Promise<Result> {
  try {
    const clientId = await assertTxInFirm(input.bankTxId);
    await unpairTransfer(prisma, { clientId, bankTxId: input.bankTxId, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${clientId}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function reviewAction(input: { bankTxId: string; accountCode: string; taxTag: TaxTag | null; createRule?: boolean; /** Tax withheld (major units); undefined keeps the line's, null removes it. */ withholding?: { kind: WithholdingKind; amount: string } | null; /** Merge a split line back onto this one account (Buku Besar). */ replaceSplit?: boolean }): Promise<Result<{ learned: boolean }>> {
  try {
    const clientId = await assertTxInFirm(input.bankTxId);
    const { withholding, ...rest } = input;
    let parsed: { kind: WithholdingKind; amount: bigint } | null | undefined;
    if (withholding) {
      const t = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: input.bankTxId }, select: { bankAccount: { select: { entity: { select: { functionalCurrency: true } } } } } });
      parsed = { kind: withholding.kind, amount: parseMoney(withholding.amount, t.bankAccount.entity.functionalCurrency) };
    } else parsed = withholding;
    // Memory learns only keys that name a counterparty, and never an unchanged simple guess (lib/review.ts): the toast must not promise more.
    const { learned } = await reviewTransaction(prisma, { ...rest, withholding: parsed, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${clientId}`, "layout");
    return { ok: true, learned };
  } catch (e) {
    return fail(e);
  }
}

/** Pecah transaksi: a combined bank line across accounts; the parts must add up to the line (lib/review.ts). */
export async function splitTransactionAction(input: { bankTxId: string; parts: SplitPartInput[] }): Promise<Result> {
  try {
    const clientId = await assertTxInFirm(input.bankTxId);
    await splitTransaction(prisma, { bankTxId: input.bankTxId, parts: input.parts, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${clientId}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * *Minta saran AI* on Review: starts (or joins) the client's background run, which covers every line of the client still on a simple
 * guess (lib/ai/run.ts) and works after the response. Suggestions only; nothing posts. `aiRun` is null when no line needs asking.
 */
export async function suggestAgainAction(clientId: string, scope: { entityIds: string[]; period: string }): Promise<Result<{ aiRun: AiRunView | null }>> {
  try {
    const client = await writeClient(clientId);
    if (!scope || !/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(scope.period) || !scope.entityIds.length || scope.entityIds.some((id) => !client.entities.some((e) => e.id === id))) return { ok: false, error: "Cakupan review tidak valid. Muat ulang halaman." };
    const provider = await resolveProvider(prisma);
    if (!provider) return { ok: false, error: "AI belum diatur di Pengaturan, jadi belum ada saran AI. Pilih akunnya langsung." };
    const aiRun = await scheduleAiRun(prisma, client, provider);
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, aiRun };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Progress of the client's background AI run for the import result and Review. Reading is enough to see it; a stalled run is resumed
 * only for a member who may write the books (resuming spends AI budget). Returns the progress view only, never keys or lease details.
 */
export async function aiRunStatusAction(clientId: string): Promise<Result<{ aiRun: AiRunView | null }>> {
  try {
    const client = await clientFor("books.read", clientId);
    const canWrite = await requireCapability("books.write", { clientId: client.id }).then(
      () => true,
      (e) => {
        if (e instanceof AccessError) return false;
        throw e;
      },
    );
    return { ok: true, aiRun: await aiRunForView(prisma, client, { canWrite }) };
  } catch (e) {
    return fail(e);
  }
}

export async function acceptSimilarAction(
  bankTxId: string,
  scope: { entityIds: string[]; period: string },
  choice?: { accountCode: string; taxTag: TaxTag | null },
): Promise<Result<{ ids: string[] }>> {
  try {
    const clientId = await assertTxInFirm(bankTxId);
    const client = await writeClient(clientId);
    const source = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: bankTxId } });
    if (!scope || !/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(scope.period) || !scope.entityIds.length || scope.entityIds.some(id => !client.entities.some(e => e.id === id)) || !scope.entityIds.includes(source.entityId)) return { ok: false, error: "Cakupan review tidak valid. Muat ulang halaman." };
    const through = new Date(Date.UTC(Number(scope.period.slice(0, 4)), Number(scope.period.slice(5)), 0));
    if (source.date > through) return { ok: false, error: "Transaksi berada di luar periode review." };
    if (choice && !(await prisma.account.findFirst({ where: { clientId, code: choice.accountCode, isBank: false, isSuspense: false } }))) return { ok: false, error: `Akun ${choice.accountCode} tidak ada di bagan akun klien ini.` };
    const ids = await acceptSimilar(prisma, bankTxId, { entityIds: scope.entityIds, through }, (await getCurrentMember()).id, choice);
    revalidatePath(`/clients/${clientId}`, "layout");
    return { ok: true, ids };
  } catch (e) {
    return fail(e);
  }
}

async function periodFor(clientId: string, year: number, month: number, opts: { mustBeOpen?: boolean } = {}) {
  const client = await writeClient(clientId);
  const period = await prisma.period.upsert({
    where: { clientId_year_month: { clientId, year, month } },
    create: { firmId: client.firmId, clientId, year, month },
    update: {},
  });
  if (opts.mustBeOpen && period.status === "LOCKED") throw new CloseError("Periode sudah ditutup. Buka kembali dulu untuk mengubah.");
  return period;
}

export async function ackControlAction(clientId: string, year: number, month: number, controlKey: string, note: string): Promise<Result> {
  try {
    if (note.trim().length < 5) return { ok: false, error: "Tulis catatan singkat (min. 5 karakter)." };
    const period = await periodFor(clientId, year, month, { mustBeOpen: true });
    const ackedById = (await getCurrentMember()).id;
    // The note answers the control as it reads now; when its detail changes the note stops clearing it (lib/controls runControls).
    const control = (await runControls(prisma, clientId, year, month)).find((c) => c.key === controlKey);
    await saveControlNote(prisma, { clientId, periodId: period.id, year, month, controlKey, title: control ? `${control.title} · ${control.scope}` : undefined, note, detail: control?.detail ?? null, actorId: ackedById });
    revalidatePath(`/clients/${clientId}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function signoffAction(clientId: string, year: number, month: number, key: string, done: boolean): Promise<Result> {
  try {
    const period = await periodFor(clientId, year, month, { mustBeOpen: true });
    const doneById = (await getCurrentMember()).id;
    if (done) await prisma.closeSignoff.upsert({ where: { periodId_key: { periodId: period.id, key } }, create: { periodId: period.id, key, doneById }, update: { doneById, doneAt: new Date() } });
    else await prisma.closeSignoff.deleteMany({ where: { periodId: period.id, key } });
    revalidatePath(`/clients/${clientId}/close`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function lockAction(clientId: string, year: number, month: number): Promise<Result> {
  try {
    await writeClient(clientId);
    await lockPeriod(prisma, clientId, year, month, "Ditutup dari halaman Tutup Buku", (await getCurrentMember()).id);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Admin only, in reverse order of closing, with a reason that is kept in the unlock log (lib/controls unlockPeriod). */
export async function unlockAction(clientId: string, year: number, month: number, reason: string): Promise<Result> {
  try {
    await clientFor("period.unlock", clientId);
    await unlockPeriod(prisma, clientId, year, month, await getCurrentMember(), reason);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Tutup bulan-bulan sebelumnya (lib/controls/history): what each open month before the selected one still flags, earliest first. */
export async function historyPreviewAction(clientId: string, year: number, month: number): Promise<Result<{ preview: HistoryPreview }>> {
  try {
    await clientFor("books.read", clientId);
    return { ok: true, preview: await historyPreview(prisma, clientId, { year, month }) };
  } catch (e) {
    return fail(e);
  }
}

/**
 * One month of that run (the browser calls it month by month, so each call stays short and shows progress). Admin only; the month's
 * controls must still read as previewed. `last` revalidates the pages once at the end instead of after every month.
 */
export async function closeHistoryMonthAction(clientId: string, until: YearMonth, target: YearMonth, note: string, fingerprint: string, last: boolean): Promise<Result> {
  try {
    await clientFor("close.batch", clientId);
    await closeHistoryMonth(prisma, { clientId, until, month: { year: target.year, month: target.month }, note, fingerprint, actor: await getCurrentMember() });
    if (last) revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    if (last) revalidatePath("/", "layout");
    return fail(e);
  }
}

/** *Balik jurnal* on a manual adjustment (lib/ledger/reverse.ts): tenant checked through the entry's client. */
export async function reverseEntryAction(input: { entryId: string; date: string }): Promise<Result> {
  try {
    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: input.entryId }, select: { entity: { select: { clientId: true } } } });
    const client = await writeClient(entry.entity.clientId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return { ok: false, error: "Pilih tanggal jurnal pembalik." };
    await reverseEntry(prisma, { clientId: client.id, entryId: input.entryId, date: new Date(`${input.date}T00:00:00Z`), actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function adjustmentAction(input: {
  clientId: string;
  entityId: string;
  date: string;
  memo: string;
  lines: { accountCode: string; debit: string; credit: string }[];
}): Promise<Result<{ entryId: string }>> {
  try {
    const client = await writeClient(input.clientId);
    const entry = await postAdjustment(prisma, { clientId: client.id, entityId: input.entityId, date: new Date(`${input.date}T00:00:00Z`), memo: input.memo, lines: input.lines, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, entryId: entry.id };
  } catch (e) {
    return fail(e);
  }
}

/** Adjustment schedules (accounting-rules 5a): create, post an installment or every due one, stop. */
export async function createScheduleAction(input: Omit<ScheduleInput, "actorId">): Promise<Result<{ scheduleId: string }>> {
  try {
    const client = await writeClient(input.clientId);
    const s = await createSchedule(prisma, { ...input, clientId: client.id, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, scheduleId: s.id };
  } catch (e) {
    return fail(e);
  }
}

/** Register a fixed asset (and its depreciation schedule, in the same transaction). Nothing posts. */
export async function createAssetAction(input: Omit<AssetInput, "actorId">): Promise<Result<{ assetId: string }>> {
  try {
    const client = await writeClient(input.clientId);
    const a = await createAsset(prisma, { ...input, clientId: client.id, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, assetId: a.id };
  } catch (e) {
    return fail(e);
  }
}

/** Lease register (rule 5f): registration posts the commencement entry; monthly journals and cancellation by click. */
export async function createLeaseAction(input: Omit<LeaseInput, "actorId">) {
  return taxWrite(input.clientId, (clientId, actorId) => createLease(prisma, { ...input, clientId, actorId }));
}
export async function postLeaseMonthsAction(input: { clientId: string; entityId: string; year: number; month: number }) {
  return taxWrite(input.clientId, (clientId, actorId) => postLeaseMonths(prisma, { ...input, clientId, actorId }));
}
export async function cancelLeaseAction(clientId: string, leaseId: string) {
  return taxWrite(clientId, (id, actorId) => cancelLease(prisma, { clientId: id, leaseId, actorId }));
}

/** Employee benefits (rule 5g): census, the firm's mortality table, assumptions, and the valuation journal by click. */
async function uploaded(formData: FormData, what: string) {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) throw new LedgerError(`Pilih file ${what} (XLSX, XLS, atau CSV).`);
  if (file.size > MAX_UPLOAD) throw new LedgerError("File terlalu besar (maks. 5 MB).");
  return { fileName: file.name, data: Buffer.from(await file.arrayBuffer()) };
}
export async function importCensusAction(formData: FormData): Promise<Result<{ added: number; updated: number }>> {
  try {
    const client = await writeClient(String(formData.get("clientId")));
    const r = await importCensus(prisma, { clientId: client.id, entityId: String(formData.get("entityId")), ...(await uploaded(formData, "sensus karyawan")) });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, ...r };
  } catch (e) {
    return fail(e);
  }
}
export async function uploadMortalityAction(formData: FormData): Promise<Result<{ tableId: string }>> {
  try {
    const client = await writeClient(String(formData.get("clientId")));
    const t = await uploadMortality(prisma, { firmId: client.firmId, name: String(formData.get("name") ?? ""), ...(await uploaded(formData, "tabel mortalita")) });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, tableId: t.id };
  } catch (e) {
    return fail(e);
  }
}
export async function saveEmployeeAction(input: EmployeeInput) {
  return taxWrite(input.clientId, (clientId) => saveEmployee(prisma, { ...input, clientId }));
}
export async function deleteEmployeeAction(clientId: string, employeeId: string) {
  return taxWrite(clientId, (id) => deleteEmployee(prisma, { clientId: id, employeeId }));
}
export async function saveBenefitSettingAction(input: BenefitSettingInput) {
  return taxWrite(input.clientId, (clientId) => saveBenefitSetting(prisma, { ...input, clientId }));
}
export async function postBenefitsAction(input: { clientId: string; entityId: string; year: number; month: number }) {
  return taxWrite(input.clientId, (clientId, actorId) => postBenefits(prisma, { ...input, clientId, actorId }));
}

/** The accountant's click: one disposal entry (rule 5b). */
export async function disposeAssetAction(input: Omit<DisposalInput, "actorId">): Promise<Result<{ entryId: string }>> {
  try {
    const client = await writeClient(input.clientId);
    const r = await disposeAsset(prisma, { ...input, clientId: client.id, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, entryId: r.entryId };
  } catch (e) {
    return fail(e);
  }
}

/** Record a sales invoice or purchase bill (posts its journal unless it is a Saldo Awal item). */
export async function createInvoiceAction(input: Omit<InvoiceInput, "actorId">): Promise<Result<{ invoiceId: string }>> {
  try {
    const client = await writeClient(input.clientId);
    const inv = await createInvoice(prisma, { ...input, clientId: client.id, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, invoiceId: inv.id };
  } catch (e) {
    return fail(e);
  }
}

/** Bank lines that could settle an invoice (read-only). */
export async function settleCandidatesAction(clientId: string, invoiceId: string): Promise<Result<{ candidates: CandidateView[] }>> {
  try {
    const client = await writeClient(clientId);
    return { ok: true, candidates: await candidateViews(prisma, client.id, invoiceId) };
  } catch (e) {
    return fail(e);
  }
}

/** Settle an invoice with a bank line; a line not on the invoice's account is classified to it first (reviewer's writer). */
export async function settleAction(input: { clientId: string; invoiceId: string; bankTransactionId: string; amount?: string | null; withheld?: string | null; whtKind?: WithholdingKind | null }): Promise<Result> {
  try {
    const client = await writeClient(input.clientId);
    await settleWithReclass(prisma, { ...input, clientId: client.id, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Cocokkan FIFO (UC-B5): one bank line across a contact's open invoices, oldest first; the rest stays as their advance. */
export async function settleFifoAction(input: { clientId: string; bankTransactionId: string; contactId: string }): Promise<Result<{ settled: { number: string; amount: string }[]; rest: string; contact: string }>> {
  try {
    const client = await writeClient(input.clientId);
    const r = await settleFifo(prisma, { clientId: client.id, bankTransactionId: input.bankTransactionId, contactId: input.contactId, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, settled: r.settled.map((x) => ({ number: x.number, amount: x.amount.toString() })), rest: r.rest.toString(), contact: r.contact };
  } catch (e) {
    return fail(e);
  }
}

/** Marks a bank line as a contact's advance (uang muka), or clears it. */
export async function tagAdvanceAction(input: { clientId: string; bankTransactionId: string; contactId: string | null }): Promise<Result> {
  try {
    const client = await writeClient(input.clientId);
    await tagAdvance(prisma, { clientId: client.id, bankTransactionId: input.bankTransactionId, contactId: input.contactId, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** A customer's sales channel (UC-B5): free text, "" clears it. */
export async function setContactChannelAction(input: { clientId: string; contactId: string; channel: string }): Promise<Result<{ channel: string | null }>> {
  try {
    const client = await writeClient(input.clientId);
    const c = await setContactChannel(prisma, { clientId: client.id, contactId: input.contactId, channel: String(input.channel ?? "") });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, channel: c.channel };
  } catch (e) {
    return fail(e);
  }
}

/** Keluarkan dokumen (UC-B5): reverses a wrongly entered invoice or bill on its own date, with the reason. */
export async function voidInvoiceAction(input: { clientId: string; invoiceId: string; reason: string }): Promise<Result> {
  try {
    const client = await writeClient(input.clientId);
    await voidInvoice(prisma, { clientId: client.id, invoiceId: input.invoiceId, reason: String(input.reason ?? ""), actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function unsettleAction(clientId: string, settlementId: string): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    await unsettle(prisma, { clientId: client.id, settlementId });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Tax pack (accounting-rules 5d): every write is tenant-checked and returns the verbatim Bahasa error. */
async function taxWrite(clientId: string, write: (clientId: string, actorId: string) => Promise<unknown>): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    await write(client.id, (await getCurrentMember()).id);
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function setRegimeAction(input: { clientId: string; entityId: string; year: number; regime: TaxRegime }) {
  return taxWrite(input.clientId, (clientId) => setRegime(prisma, { ...input, clientId }));
}
export async function addCorrectionAction(input: Omit<CorrectionInput, "actorId">) {
  return taxWrite(input.clientId, (clientId, actorId) => addCorrection(prisma, { ...input, clientId, actorId }));
}
export async function deleteCorrectionAction(clientId: string, correctionId: string) {
  return taxWrite(clientId, (id) => deleteCorrection(prisma, { clientId: id, correctionId }));
}
/** The amount is read again from the ledger here, never taken from the page. */
export async function acceptSuggestionAction(input: { clientId: string; entityId: string; year: number; month: number; accountCode: string; percent?: number }) {
  return taxWrite(input.clientId, async (clientId, actorId) => {
    const pack = await taxPack(prisma, clientId, input.entityId, input.year, input.month);
    const s = pack?.suggestions.find((x) => x.code === input.accountCode);
    if (!s) throw new LedgerError("Usulan ini sudah tidak berlaku. Muat ulang halaman.");
    await acceptSuggestion(prisma, { clientId, entityId: input.entityId, year: input.year, accountCode: s.code, amount: s.amount, percent: input.percent, actorId });
  });
}
export async function setCorrectionPercentAction(clientId: string, correctionId: string, percent: number) {
  return taxWrite(clientId, (id) => setCorrectionPercent(prisma, { clientId: id, correctionId, percent }));
}
export async function setLossAction(input: { clientId: string; entityId: string; year: number; originYear: number; amount: string }) {
  return taxWrite(input.clientId, (clientId, actorId) => setLoss(prisma, { ...input, clientId, actorId }));
}
export async function deleteLossAction(clientId: string, lossId: string) {
  return taxWrite(clientId, (id) => deleteLoss(prisma, { clientId: id, lossId }));
}
export async function dismissSuggestionAction(input: { clientId: string; entityId: string; year: number; key: string }) {
  return taxWrite(input.clientId, (clientId) => dismissSuggestion(prisma, { ...input, clientId }));
}
export async function addCreditAction(input: Omit<CreditInput, "actorId">) {
  return taxWrite(input.clientId, (clientId, actorId) => addCredit(prisma, { ...input, clientId, actorId }));
}
export async function deleteCreditAction(clientId: string, creditId: string) {
  return taxWrite(clientId, (id) => deleteCredit(prisma, { clientId: id, creditId }));
}
/** The masa pajak of a PPh 25 instalment: which year's credit it is (lib/tax/records.ts). */
export async function setTaxMonthAction(clientId: string, bankTransactionId: string, month: string) {
  return taxWrite(clientId, (id) => setTaxMonth(prisma, { clientId: id, bankTransactionId, month }));
}
/** The accountant's click: the tax journal of a kind, as the difference from what is already booked. */
export async function saveCkpnSettingAction(input: CkpnSettingInput) {
  return taxWrite(input.clientId, (clientId) => saveCkpnSetting(prisma, { ...input, clientId }));
}
export async function postCkpnAction(input: { clientId: string; entityId: string; year: number; month: number }) {
  return taxWrite(input.clientId, (clientId, actorId) => postCkpn(prisma, { ...input, clientId, actorId }));
}

/** Month-end stock count (rule 5i): the typed value is read in the entity's currency; the journal is the difference from the books. */
export async function recordInventoryCountAction(input: { clientId: string; entityId: string; year: number; month: number; amount: string; note?: string }) {
  return taxWrite(input.clientId, async (clientId, actorId) => {
    const entity = await prisma.entity.findFirst({ where: { id: input.entityId, clientId } });
    if (!entity) throw new LedgerError("Pilih entitas.");
    if (!input.amount.trim()) throw new LedgerError("Isi nilai persediaan hasil stock opname (0 bila habis).");
    const amount = parseMoney(input.amount, entity.functionalCurrency);
    return recordInventoryCount(prisma, { clientId, entityId: entity.id, year: input.year, month: input.month, amount, note: input.note, actorId });
  });
}

export async function postTaxAction(input: { clientId: string; entityId: string; year: number; month: number; kind: TaxPostingKind }) {
  return taxWrite(input.clientId, (clientId, actorId) => postTax(prisma, { ...input, clientId, actorId }));
}

export async function postPpnOffsetAction(input: { clientId: string; entityId: string; year: number; month: number }) {
  return taxWrite(input.clientId, (clientId, actorId) => postPpnOffset(prisma, { ...input, clientId, actorId }));
}

export async function setInstalmentAction(input: { clientId: string; entityId: string; from: string; amount: string }) {
  return taxWrite(input.clientId, (clientId, actorId) => setInstalment(prisma, { ...input, clientId, actorId }));
}
export async function deleteInstalmentAction(input: { clientId: string; id: string }) {
  return taxWrite(input.clientId, (clientId, actorId) => deleteInstalment(prisma, { ...input, clientId, actorId }));
}

export async function postInstallmentAction(clientId: string, scheduleId: string, k: number): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    await postInstallment(prisma, { clientId: client.id, scheduleId, k, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function postAllDueAction(clientId: string, year: number, month: number): Promise<Result<{ posted: number }>> {
  try {
    const client = await writeClient(clientId);
    const posted = await postAllDue(prisma, { clientId: client.id, year, month, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, posted };
  } catch (e) {
    return fail(e);
  }
}

export async function stopScheduleAction(clientId: string, scheduleId: string): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    await stopSchedule(prisma, { clientId: client.id, scheduleId });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function addClientAction(input: NewClientInput): Promise<Result<{ clientId: string }>> {
  try {
    const { firm, member } = await requireCapability("client.create");
    const client = await addClient(prisma, firm.id, input, member);
    revalidatePath("/", "layout");
    return { ok: true, clientId: client.id };
  } catch (e) {
    if (e instanceof OnboardingError) return { ok: false, error: e.message, fields: e.fields };
    return fail(e);
  }
}

type NewEntityInput = NewClientInput["entities"][number];

/** "Tambah rekening" on an entity of an existing client. `fields` keys ("bank.number") say what to fix. */
export async function addBankAccountAction(clientId: string, entityId: string, input: NewEntityInput["banks"][number]): Promise<Result<{ bankAccountId: string }>> {
  try {
    const client = await writeClient(clientId);
    const bank = await addBankAccount(prisma, client.firmId, client.id, entityId, input);
    revalidatePath("/", "layout");
    return { ok: true, bankAccountId: bank.id };
  } catch (e) {
    if (e instanceof OnboardingError) return { ok: false, error: e.message, fields: e.fields };
    return fail(e);
  }
}

/** The import result's *Catat sebagai <bank>*: the account's bank follows the file's. */
export async function setBankAccountBankAction(clientId: string, bankAccountId: string, bank: string): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    await setBankAccountBank(prisma, client.id, bankAccountId, bank);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    if (e instanceof OnboardingError) return { ok: false, error: e.message };
    return fail(e);
  }
}

/** "Tambah perusahaan atau pemilik" on an existing client. */
export async function addEntityAction(clientId: string, input: NewEntityInput): Promise<Result<{ entityId: string }>> {
  try {
    const client = await clientFor("client.create", clientId);
    const entity = await addEntity(prisma, client.firmId, client.id, input);
    revalidatePath("/", "layout");
    return { ok: true, entityId: entity.id };
  } catch (e) {
    if (e instanceof OnboardingError) return { ok: false, error: e.message, fields: e.fields };
    return fail(e);
  }
}

/** Which standard an entity's CALK and statements name (wording only, lib/reports/framework.ts). */
export async function saveReportingFrameworkAction(clientId: string, entityId: string, framework: string): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    await setReportingFramework(prisma, { clientId: client.id, entityId, framework });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** The client's financial-year end (tahun buku): which year its reports count from. Refused once a month is closed. */
export async function saveFiscalYearEndAction(clientId: string, endMonth: number): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    const member = await getCurrentMember();
    await setFiscalYearEnd(prisma, { clientId: client.id, endMonth, actorId: member.id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Which adjustment and subledger modules the client's menu shows (ADR 0014 §2). Presentation only; any member; logged. */
export async function saveClientModulesAction(clientId: string, modules: string[]): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    const member = await getCurrentMember();
    await setClientModules(prisma, { clientId: client.id, modules, actorId: member.id });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Rekonsiliasi subledger (UC-A1): a client's aging file at a date, compared with the ledger. */
export async function importAgingAction(formData: FormData): Promise<Result<{ status: string; difference: string; notes: string[]; rows: number }>> {
  try {
    const client = await writeClient(String(formData.get("clientId")));
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Pilih file aging (XLSX, XLS atau CSV)." };
    if (file.size > MAX_UPLOAD) return { ok: false, error: "File terlalu besar (maks. 5 MB)." };
    const kind = String(formData.get("kind"));
    const r = await importAging(prisma, {
      clientId: client.id,
      entityId: String(formData.get("entityId")),
      kind: kind as "RECEIVABLE" | "PAYABLE",
      asOf: String(formData.get("asOf") ?? ""),
      fileName: file.name,
      data: Buffer.from(await file.arrayBuffer()),
      accountCodes: formData.getAll("accounts").map(String).filter(Boolean),
      threshold: String(formData.get("threshold") ?? ""),
      actorId: (await getCurrentMember()).id,
    });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, status: r.status, difference: r.difference.toString(), notes: r.notes, rows: r.rows };
  } catch (e) {
    return fail(e);
  }
}

/** Ekualisasi PPN (I5c): one Coretax faktur export for a company; keluaran or masukan is read from the file. */
export async function importFakturAction(formData: FormData): Promise<Result<{ direction: string; created: number; updated: number; unchanged: number; masas: string[]; notes: string[] }>> {
  try {
    const client = await writeClient(String(formData.get("clientId")));
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Pilih file daftar faktur dari Coretax (XLSX, XLS atau CSV)." };
    if (file.size > MAX_UPLOAD) return { ok: false, error: "File terlalu besar (maks. 5 MB)." };
    const r = await importFaktur(prisma, { clientId: client.id, entityId: String(formData.get("entityId")), fileName: file.name, data: Buffer.from(await file.arrayBuffer()), actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, direction: r.direction, created: r.created, updated: r.updated, unchanged: r.unchanged, masas: r.masas.map((m) => `${m.year}-${String(m.month).padStart(2, "0")}`), notes: r.notes };
  } catch (e) {
    return fail(e);
  }
}

export async function bookFakturAction(input: { clientId: string; fakturId: string; counterCode: string }): Promise<Result<{ number: string }>> {
  try {
    const client = await writeClient(input.clientId);
    const inv = await bookFaktur(prisma, { clientId: client.id, fakturId: input.fakturId, counterCode: input.counterCode, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, number: inv.number };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteFakturAction(input: { clientId: string; entityId: string; direction: "KELUARAN" | "MASUKAN"; year: number; month: number }): Promise<Result<{ count: number }>> {
  try {
    const client = await writeClient(input.clientId);
    if (input.direction !== "KELUARAN" && input.direction !== "MASUKAN") return { ok: false, error: "Jenis faktur tidak dikenal." };
    const count = await deleteFaktur(prisma, { clientId: client.id, entityId: input.entityId, direction: input.direction, year: input.year, month: input.month, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, count };
  } catch (e) {
    return fail(e);
  }
}

/** Bukti potong Unifikasi (I5d): one Coretax slip export for a company; dibuat or diterima is read from the file. */
export async function importBupotAction(formData: FormData): Promise<Result<{ direction: string; created: number; updated: number; unchanged: number; masas: string[]; notes: string[] }>> {
  try {
    const client = await writeClient(String(formData.get("clientId")));
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Pilih file daftar bukti potong dari Coretax (XLSX, XLS atau CSV)." };
    if (file.size > MAX_UPLOAD) return { ok: false, error: "File terlalu besar (maks. 5 MB)." };
    const r = await importBupot(prisma, { clientId: client.id, entityId: String(formData.get("entityId")), fileName: file.name, data: Buffer.from(await file.arrayBuffer()), actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, direction: r.direction, created: r.created, updated: r.updated, unchanged: r.unchanged, masas: r.masas.map((m) => `${m.year}-${String(m.month).padStart(2, "0")}`), notes: r.notes };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteBupotAction(input: { clientId: string; entityId: string; direction: "DIBUAT" | "DITERIMA"; year: number; month: number }): Promise<Result<{ count: number }>> {
  try {
    const client = await writeClient(input.clientId);
    if (input.direction !== "DIBUAT" && input.direction !== "DITERIMA") return { ok: false, error: "Jenis bukti potong tidak dikenal." };
    const count = await deleteBupot(prisma, { clientId: client.id, entityId: input.entityId, direction: input.direction, year: input.year, month: input.month, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, count };
  } catch (e) {
    return fail(e);
  }
}

export async function resolveSubledgerFindingAction(input: { clientId: string; findingId: string; explanation: string }): Promise<Result> {
  try {
    const client = await writeClient(input.clientId);
    await resolveSubledgerFinding(prisma, { clientId: client.id, findingId: input.findingId, explanation: input.explanation, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteSubledgerImportAction(clientId: string, importId: string): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    await deleteSubledgerImport(prisma, { clientId: client.id, importId, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** A client's report format (UC-K3): labels, order, headings and totals of its Laba Rugi and Neraca. Presentation only; refusals name the line. */
export async function saveReportFormatAction(clientId: string, format: unknown): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    const member = await getCurrentMember();
    await saveReportFormat(prisma, { clientId: client.id, actorId: member.id, format });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function resetReportFormatAction(clientId: string): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    const member = await getCurrentMember();
    await resetReportFormat(prisma, { clientId: client.id, actorId: member.id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function openingAction(input: { clientId: string; entityId: string; date: string; lines: OpeningLineInput[] }): Promise<Result<{ finding: string | null }>> {
  try {
    const client = await writeClient(input.clientId);
    const m = input.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return { ok: false, error: "Isi tanggal saldo awal." };
    const { finding } = await postOpening(prisma, { clientId: client.id, entityId: input.entityId, date: dateOnly(Number(m[1]), Number(m[2]), Number(m[3])), lines: input.lines, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, finding: finding?.label ?? null };
  } catch (e) {
    return fail(e);
  }
}

/** Resolves a Temuan with the accountant's written decision (ADR 0012). */
export async function resolveFindingAction(input: { clientId: string; findingId: string; accountCode: string; decision: string }): Promise<Result> {
  try {
    const client = await writeClient(input.clientId);
    await resolveOpeningFinding(prisma, { clientId: client.id, findingId: input.findingId, accountCode: input.accountCode, decision: input.decision, actorId: (await getCurrentMember()).id });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Demo reset is operator-only tooling; never truncate shared workspace data from a session. */
export async function resetDemoAction(): Promise<Result> {
  await requireCapability("books.read");
  return { ok: false, error: "Reset data hanya tersedia melalui alat operator di lingkungan demo." };
}

/** Kurs page: typed-in rates are firm data (source MANUAL) and win over rates taken from files. */
export async function saveRateAction(input: { clientId: string; currency: string; quote: string; date: string; kind: string; rate: string; note?: string }): Promise<Result> {
  try {
    const client = await writeClient(input.clientId);
    const row = validateRateInput(input);
    await upsertRate(prisma, client.firmId, { ...row, source: "MANUAL", note: input.note?.trim().slice(0, 200) || null });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteRateAction(clientId: string, rateId: string): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    const { count } = await prisma.exchangeRate.deleteMany({ where: { id: rateId, firmId: client.firmId } });
    if (!count) return { ok: false, error: "Kurs tidak ditemukan." };
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Month-end FX revaluation — posted only on this explicit click (rule 6b). */
export async function revaluationAction(clientId: string, entityId: string, year: number, month: number): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    if (!client.entities.some((e) => e.id === entityId)) return { ok: false, error: "Entitas tidak ditemukan." };
    await postRevaluation(prisma, client.id, entityId, year, month, (await getCurrentMember()).id);
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** AI close review (ADR 0009): explains flagged controls and proposes actions. Never posts, acks or locks. */
export async function closeReviewAction(clientId: string, year: number, month: number): Promise<Result<{ review: CloseReviewView }>> {
  try {
    const client = await writeClient(clientId);
    const provider = await resolveProvider(prisma);
    if (!provider) return { ok: false, error: "AI belum diatur di Pengaturan. Kontrol tetap berjalan tanpa AI." };
    return { ok: true, review: await reviewClose(prisma, client.firmId, client.id, year, month, provider) };
  } catch (e) {
    if (e instanceof AiBudgetError || e instanceof AiAnswerError) return { ok: false, error: e.message };
    if (e instanceof Error && e.name === "TimeoutError") {
      console.error(e);
      return { ok: false, error: `AI tidak menjawab dalam ${Math.round(AI_LONG_TIMEOUT_MS / 60_000)} menit. Kontrol tetap berjalan; coba lagi nanti.` };
    }
    if (e instanceof Error && /^(AI \d|Model )/.test(e.message)) {
      console.error(e);
      return { ok: false, error: "AI tidak tersedia saat ini. Kontrol tetap berjalan; coba lagi nanti." };
    }
    return fail(e);
  }
}

/** Close copilot (accounting-rules 20b): one flagged control explained; a draft journal is stored, never posted here. */
export async function explainControlAction(clientId: string, year: number, month: number, controlKey: string): Promise<Result<{ explanation: ControlExplanation }>> {
  try {
    const client = await writeClient(clientId);
    await periodFor(client.id, year, month, { mustBeOpen: true });
    const provider = await resolveProvider(prisma);
    if (!provider) return { ok: false, error: "AI belum diatur di Pengaturan. Kontrol tetap berjalan tanpa AI." };
    const explanation = await explainControl(prisma, client.firmId, client.id, year, month, controlKey, provider);
    if (explanation.proposal) revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, explanation };
  } catch (e) {
    if (e instanceof AiBudgetError || e instanceof AiAnswerError || e instanceof ExplainError) return { ok: false, error: e.message };
    if (e instanceof Error && e.name === "TimeoutError") {
      console.error(e);
      return { ok: false, error: `AI tidak menjawab dalam ${Math.round(AI_LONG_TIMEOUT_MS / 60_000)} menit. Kontrol tetap berjalan; coba lagi nanti.` };
    }
    if (e instanceof Error && /^(AI \d|Model )/.test(e.message)) {
      console.error(e);
      return { ok: false, error: "AI tidak tersedia saat ini. Kontrol tetap berjalan; coba lagi nanti." };
    }
    return fail(e);
  }
}

export async function postProposalAction(clientId: string, proposalId: string, accounts: string[]): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    const actorId = (await getCurrentMember()).id;
    if (proposalId.startsWith(SUSPENSE_PREFIX)) await postSuspenseCorrection(prisma, { firmId: client.firmId, clientId: client.id, lineId: proposalId.slice(SUSPENSE_PREFIX.length), accounts, actorId });
    else await postProposal(prisma, { clientId: client.id, proposalId, accounts, actorId });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function dismissProposalAction(clientId: string, proposalId: string): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    const actorId = (await getCurrentMember()).id;
    if (proposalId.startsWith(SUSPENSE_PREFIX)) return { ok: false, error: SUSPENSE_NOT_DISMISSABLE };
    await dismissProposal(prisma, { clientId: client.id, proposalId, actorId });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ─── Ledger / Neraca import (accounting-rules §15a) ───────────────────────────

export async function stageLedgerAction(
  formData: FormData,
): Promise<Result<{ importId?: string; candidates?: { sheet: string; mode: "LEDGER" | "NERACA"; dataRows: number }[] }>> {
  try {
    const client = await writeClient(String(formData.get("clientId")));
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Pilih file buku besar atau neraca (XLSX atau CSV)." };
    if (file.size > MAX_UPLOAD) return { ok: false, error: "File terlalu besar (maks. 5 MB)." };
    const entityId = String(formData.get("entityId") ?? "") || undefined;
    if (entityId && !client.entities.some((e) => e.id === entityId)) return { ok: false, error: "Entitas tidak ditemukan." };
    const date = String(formData.get("date") ?? "");
    const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const res = await stageImport(prisma, {
      firmId: client.firmId,
      clientId: client.id,
      fileName: file.name,
      data: Buffer.from(await file.arrayBuffer()),
      sheet: String(formData.get("sheet") ?? "") || undefined,
      entityId,
      date: m ? dateOnly(Number(m[1]), Number(m[2]), Number(m[3])) : undefined,
      currencyMode: formData.get("currencyMode") === "CONVERT" ? "CONVERT" : "FUNCTIONAL",
      actorId: (await getCurrentMember()).id,
    });
    if (res.status === "CHOOSE_SHEET") return { ok: true, candidates: res.candidates.map((c) => ({ sheet: c.sheet, mode: c.mode, dataRows: c.dataRows })) };
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, importId: res.importId };
  } catch (e) {
    return fail(e);
  }
}

export async function acceptCheckAction(clientId: string, checkId: string): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    await acceptCheck(prisma, client.id, checkId);
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Fills suggestions only (rules, then AI when asked). Nothing is mapped until acceptMappingsAction. */
export async function suggestMappingsAction(clientId: string, useAi: boolean): Promise<Result<{ note?: string; aiAnswered: number; calls: number }>> {
  try {
    const client = await writeClient(clientId);
    const r = await suggestMappings(prisma, { firmId: client.firmId, clientId: client.id, provider: useAi ? await resolveProvider(prisma) : null, useAi });
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, note: r.note, aiAnswered: r.aiAnswered, calls: r.calls };
  } catch (e) {
    return fail(e);
  }
}

export async function acceptMappingsAction(
  clientId: string,
  items: { sourceAccountId: string; accountCode?: string; newAccount?: { fsLine: string; name: string }; method: string }[],
): Promise<Result<{ mapped: number }>> {
  try {
    const client = await writeClient(clientId);
    const methods = ["PRIOR", "NAME", "KEYWORD", "AI", "MANUAL", "NEW"];
    if (items.some((i) => !methods.includes(i.method))) return { ok: false, error: "Metode pemetaan tidak dikenal." };
    const r = await acceptMappings(
      prisma,
      client.id,
      items.map((i) => ({ sourceAccountId: i.sourceAccountId, accountCode: i.accountCode, newAccount: i.newAccount ? { fsLine: i.newAccount.fsLine as FsLine, name: i.newAccount.name } : undefined, method: i.method as MapMethod })),
      (await getCurrentMember()).id,
    );
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, mapped: r.mapped };
  } catch (e) {
    return fail(e);
  }
}

export async function postLedgerImportAction(clientId: string, importId: string): Promise<Result<{ entries: number }>> {
  try {
    const client = await writeClient(clientId);
    const r = await postImport(prisma, client.id, importId, (await getCurrentMember()).id);
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true, entries: r.entries };
  } catch (e) {
    return fail(e);
  }
}

export async function discardLedgerDraftAction(clientId: string, importId: string): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    const count = await prisma.$transaction(async (tx) => {
      const { count } = await tx.ledgerImport.deleteMany({ where: { id: importId, clientId: client.id, status: "DRAFT" } });
      // A draft prepared from Dokumen can be prepared again after discarding it.
      if (count) await tx.evidenceSelection.updateMany({ where: { firmId: client.firmId, importId }, data: { importId: null } });
      return count;
    });
    if (!count) return { ok: false, error: "Draf tidak ditemukan atau sudah dicatat." };
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// Public UI action facade; explicit async exports are required by Next.js.
import * as evidenceActions from "./evidence-actions";
import * as googleActions from "./google-actions";
import * as inboxActions from "./inbox-actions";
export async function createEvidenceAction(...args: Parameters<typeof evidenceActions.createEvidenceAction>) { return evidenceActions.createEvidenceAction(...args); }
export async function loadEvidenceAction(...args: Parameters<typeof evidenceActions.loadEvidenceAction>) { return evidenceActions.loadEvidenceAction(...args); }
export async function beginEvidenceUploadAction(...args: Parameters<typeof evidenceActions.beginEvidenceUploadAction>) { return evidenceActions.beginEvidenceUploadAction(...args); }
export async function appendEvidenceUploadAction(...args: Parameters<typeof evidenceActions.appendEvidenceUploadAction>) { return evidenceActions.appendEvidenceUploadAction(...args); }
export async function finishEvidenceUploadAction(...args: Parameters<typeof evidenceActions.finishEvidenceUploadAction>) { return evidenceActions.finishEvidenceUploadAction(...args); }
export async function processEvidenceAction(...args: Parameters<typeof evidenceActions.processEvidenceAction>) { return evidenceActions.processEvidenceAction(...args); }
export async function attachDriveAction(...args: Parameters<typeof evidenceActions.attachDriveAction>) { return evidenceActions.attachDriveAction(...args); }
export async function includeEvidenceAction(...args: Parameters<typeof evidenceActions.includeEvidenceAction>) { return evidenceActions.includeEvidenceAction(...args); }
export async function excludeEvidenceAction(...args: Parameters<typeof evidenceActions.excludeEvidenceAction>) { return evidenceActions.excludeEvidenceAction(...args); }
export async function confirmEvidenceAction(...args: Parameters<typeof evidenceActions.confirmEvidenceAction>) { return evidenceActions.confirmEvidenceAction(...args); }
export async function decideEvidenceFactAction(...args: Parameters<typeof evidenceActions.decideEvidenceFactAction>) { return evidenceActions.decideEvidenceFactAction(...args); }
export async function resolveEvidenceConflictAction(...args: Parameters<typeof evidenceActions.resolveEvidenceConflictAction>) { return evidenceActions.resolveEvidenceConflictAction(...args); }
export async function createEvidenceClientAction(...args: Parameters<typeof evidenceActions.createEvidenceClientAction>) { return evidenceActions.createEvidenceClientAction(...args); }
export async function linkEvidenceClientAction(...args: Parameters<typeof evidenceActions.linkEvidenceClientAction>) { return evidenceActions.linkEvidenceClientAction(...args); }
export async function analyzeEvidenceAction(...args: Parameters<typeof evidenceActions.analyzeEvidenceAction>) { return evidenceActions.analyzeEvidenceAction(...args); }
export async function askEvidenceAction(...args: Parameters<typeof evidenceActions.askEvidenceAction>) { return evidenceActions.askEvidenceAction(...args); }
export async function prepareEvidenceImportAction(...args: Parameters<typeof evidenceActions.prepareEvidenceImportAction>) { return evidenceActions.prepareEvidenceImportAction(...args); }
export async function postEvidenceBankAction(...args: Parameters<typeof evidenceActions.postEvidenceBankAction>) { return evidenceActions.postEvidenceBankAction(...args); }
export async function startGoogleAction(...args: Parameters<typeof googleActions.startGoogleAction>) { return googleActions.startGoogleAction(...args); }
export async function disconnectGoogleAction(...args: Parameters<typeof googleActions.disconnectGoogleAction>) { return googleActions.disconnectGoogleAction(...args); }
export async function inboxCheckFileAction(...args: Parameters<typeof inboxActions.inboxCheckFileAction>) { return inboxActions.inboxCheckFileAction(...args); }
export async function inboxFromDocumentAction(...args: Parameters<typeof inboxActions.inboxFromDocumentAction>) { return inboxActions.inboxFromDocumentAction(...args); }
export async function previewClientFileAction(...args: Parameters<typeof inboxActions.previewClientFileAction>) { return inboxActions.previewClientFileAction(...args); }
export async function inboxPlanAction(...args: Parameters<typeof inboxActions.inboxPlanAction>) { return inboxActions.inboxPlanAction(...args); }
export async function inboxUnlockAction(...args: Parameters<typeof inboxActions.inboxUnlockAction>) { return inboxActions.inboxUnlockAction(...args); }
export async function inboxConfirmAction(...args: Parameters<typeof inboxActions.inboxConfirmAction>) { return inboxActions.inboxConfirmAction(...args); }
export async function inboxSkipAction(...args: Parameters<typeof inboxActions.inboxSkipAction>) { return inboxActions.inboxSkipAction(...args); }
export async function inboxProcessNextAction(...args: Parameters<typeof inboxActions.inboxProcessNextAction>) { return inboxActions.inboxProcessNextAction(...args); }
export async function inboxBatchAction(...args: Parameters<typeof inboxActions.inboxBatchAction>) { return inboxActions.inboxBatchAction(...args); }
export async function inboxDriveListAction(...args: Parameters<typeof inboxActions.inboxDriveListAction>) { return inboxActions.inboxDriveListAction(...args); }
export async function inboxDriveFileAction(...args: Parameters<typeof inboxActions.inboxDriveFileAction>) { return inboxActions.inboxDriveFileAction(...args); }
export async function inboxKeyringAction(...args: Parameters<typeof inboxActions.inboxKeyringAction>) { return inboxActions.inboxKeyringAction(...args); }
export async function clearInboxKeyringAction(...args: Parameters<typeof inboxActions.clearInboxKeyringAction>) { return inboxActions.clearInboxKeyringAction(...args); }

/** Admin only: removes a client and all its books after the typed-name confirmation (lib/clients/delete.ts). */
/** Hapus impor (ADR 0013): admin only; the lib refuses closed months and imports something else rests on. */
export async function removeImportAction(input: { clientId: string; importId: string; kind: "statement" | "ledger"; reason: string }): Promise<Result> {
  try {
    const client = await clientFor("import.remove", input.clientId);
    const member = await getCurrentMember();
    const args = { clientId: client.id, importId: input.importId, reason: input.reason, actor: { id: member.id, role: member.role } };
    if (input.kind === "statement") await removeStatementImport(prisma, args);
    else await removeLedgerImport(prisma, args);
    revalidatePath(`/clients/${client.id}`, "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteClientAction(clientId: string, confirmName: string): Promise<Result> {
  let member;
  try {
    member = (await requireCapability("client.delete", { clientId })).member;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Hanya admin kantor yang dapat menghapus klien." };
  }
  try {
    const client = await getClientForMember(clientId);
    const r = await deleteClient(prisma, { firmId: client.firmId, clientId: client.id, confirmName });
    console.info(`client deleted: firm=${client.firmId} client=${client.id} name="${r.name}" by member=${member.id} at ${new Date().toISOString()}`);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Tautan unggah klien (I1d): a secret upload-only link for the client, shown once. Any member; audited. */
export async function createUploadLinkAction(clientId: string, days: number): Promise<{ ok: true; url: string; expires: string } | { ok: false; error: string }> {
  try {
    const client = await writeClient(clientId);
    const member = await getCurrentMember();
    const { link, token } = await createUploadLink(prisma, { firmId: client.firmId, clientId: client.id, days, actorId: member.id });
    revalidatePath(`/clients/${client.id}/import`);
    return { ok: true, url: `${await publicOrigin()}${uploadPath(token)}`, expires: formatDate(link.expiresAt) };
  } catch (e) {
    if (e instanceof UploadLinkError) return { ok: false, error: e.message };
    return fail(e);
  }
}
export async function revokeUploadLinkAction(clientId: string, linkId: string): Promise<Result> {
  try {
    const client = await writeClient(clientId);
    const member = await getCurrentMember();
    await revokeUploadLink(prisma, { firmId: client.firmId, clientId: client.id, linkId, actorId: member.id });
    revalidatePath(`/clients/${client.id}/import`);
    return { ok: true };
  } catch (e) {
    if (e instanceof UploadLinkError) return { ok: false, error: e.message };
    return fail(e);
  }
}
/** APP_URL when set, else this request's own origin (as the login emails do). */
async function publicOrigin() {
  const base = appUrl();
  if (base) return base;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** Catatan manajemen (I5b, accounting-rules 20c): one AI draft of the computed sentences, numbers checked; nothing is saved here. */
export async function draftCommentaryAction(k: { clientId: string; entityId: string; year: number; month: number }): Promise<{ ok: true; text: string; foreign: string[] } | { ok: false; error: string }> {
  try {
    const client = await writeClient(k.clientId);
    const provider = await resolveProvider(prisma);
    if (!provider) return { ok: false, error: "AI belum diatur di Pengaturan. Kalimat otomatis tetap dipakai." };
    const d = await draftCommentary(prisma, { ...k, clientId: client.id, firmId: client.firmId, provider });
    return { ok: true, ...d };
  } catch (e) {
    if (e instanceof AiBudgetError || e instanceof AiAnswerError || e instanceof CommentError) return { ok: false, error: e.message };
    if (e instanceof Error && (e.name === "TimeoutError" || /^(AI \d|Model )/.test(e.message))) {
      console.error(e);
      return { ok: false, error: "AI tidak tersedia saat ini. Kalimat otomatis tetap dipakai; coba lagi nanti." };
    }
    return fail(e);
  }
}
export async function saveReportCommentAction(k: { clientId: string; entityId: string; year: number; month: number; text: string; source: "AI" | "ACCOUNTANT" }): Promise<{ ok: true; foreign: string[] } | { ok: false; error: string }> {
  try {
    const client = await writeClient(k.clientId);
    const member = await getCurrentMember();
    const r = await saveReportComment(prisma, { ...k, clientId: client.id, firmId: client.firmId, actorId: member.id });
    revalidatePath(`/clients/${client.id}/reports`);
    return { ok: true, ...r };
  } catch (e) {
    if (e instanceof CommentError) return { ok: false, error: e.message };
    return fail(e);
  }
}
export async function clearReportCommentAction(k: { clientId: string; entityId: string; year: number; month: number }): Promise<Result> {
  try {
    const client = await writeClient(k.clientId);
    const member = await getCurrentMember();
    await clearReportComment(prisma, { ...k, clientId: client.id, firmId: client.firmId, actorId: member.id });
    revalidatePath(`/clients/${client.id}/reports`);
    return { ok: true };
  } catch (e) {
    if (e instanceof CommentError) return { ok: false, error: e.message };
    return fail(e);
  }
}
