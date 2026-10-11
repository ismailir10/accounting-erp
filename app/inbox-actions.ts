"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { AccessError, CLIENT_NOT_FOUND, requireCapability } from "@/lib/auth/session";
import type { Capability } from "@/lib/auth/permissions";
import { MAX_UPLOAD_BYTES, UPLOAD_TOO_BIG } from "@/lib/upload";
import { resolveProvider } from "@/lib/settings/ai";
import { scheduleAiRun } from "@/lib/ai/background";
import type { AiRunView } from "@/lib/ai/run";
import { evidenceEnabled } from "@/lib/evidence/config";
import { downloadDriveFile, DriveError, getDriveFile, listDriveChildren, parseDriveFolderUrl } from "@/lib/evidence/drive";
import { driveToken } from "@/lib/evidence/jobs";
import { OnboardingError } from "@/lib/onboarding";
import { adoptVersion, checkFile, previewFile, type InboxItem } from "@/lib/inbox/check";
import type { PreviewFile } from "@/lib/inbox/propose";
import { batchItems, confirmBatch, InboxError, planBatch, skipItems, unlockBatch, type ConfirmError, type InboxPlan } from "@/lib/inbox/plan";
import { failureMessage, processNext } from "@/lib/inbox/process";
import { clearKeyring, keyringSize, NeedsPasswordError } from "@/lib/inbox/keyring";
import { fetchDriveFile, listDriveFolder, type DriveListedFile, type DriveReader } from "@/lib/inbox/drive";

/**
 * The Unggah page's server actions (cycle 2026-10-10-unggah-inbox). Each request handles one step of a drop — check one file, plan,
 * confirm the card, process one file — so none runs long. Every action names the client first and passes the one guard
 * (requireCapability, ADR 0017); the logic is in lib/inbox. Nothing returned carries a password, the keyring, file bytes or another
 * client's data. Re-exported by the app/actions.ts facade.
 */
type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; needsPassword?: boolean };

const INVALID = "Data unggahan tidak valid. Muat ulang halaman lalu coba lagi.";
const NO_DRIVE = "Hubungkan Google dulu di Dokumen.";

/** Inbox and Drive refusals are Bahasa and shown as is; the rest go through the import's mapping (a bug is logged, never shown). */
function fail(e: unknown): { ok: false; error: string; needsPassword?: boolean } {
  if (e instanceof NeedsPasswordError) return { ok: false, error: e.message, needsPassword: true };
  if (e instanceof AccessError || e instanceof InboxError || e instanceof DriveError || e instanceof OnboardingError) return { ok: false, error: e.message };
  return { ok: false, error: failureMessage(e) };
}

/** The guard: organisation open (and writable for a write), the role's capability, the client this member's. */
async function access(capability: Capability, clientId: string) {
  if (typeof clientId !== "string" || !clientId) throw new AccessError(CLIENT_NOT_FOUND, "CLIENT");
  const session = await requireCapability(capability, { clientId });
  return { firmId: session.firm.id, clientId, memberId: session.member.id };
}

/** A drop's id is a uuid made by the page. */
const batchSchema = z.uuid();
function batchOf(batchId: unknown): string {
  const parsed = batchSchema.safeParse(batchId);
  if (!parsed.success) throw new InboxError(INVALID);
  return parsed.data;
}

/** One dropped file: stored in the client's inbox and read (bank / ledger / other). Books nothing. */
export async function inboxCheckFileAction(clientId: string, form: FormData): Promise<Result<{ item: InboxItem }>> {
  try {
    const who = await access("books.write", clientId);
    const batchId = batchOf(form.get("batchId"));
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Pilih file untuk diunggah." };
    if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: UPLOAD_TOO_BIG };
    const password = String(form.get("password") ?? "").trim() || undefined;
    const item = await checkFile(prisma, { firmId: who.firmId, clientId: who.clientId, batchId, name: file.name, data: Buffer.from(await file.arrayBuffer()), password, actorId: who.memberId });
    return { ok: true, item };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Dokumen's *Bukukan lewat Unggah*: a rekening koran stored in a client's collection becomes a new Unggah drop (its bytes not stored
 * again); the page then books that drop straight away when nothing needs asking (`?lanjut=<batchId>`: only that drop, never a newer
 * one). A file already booked opens Unggah as it is.
 */
export async function inboxFromDocumentAction(intakeId: string, versionId: string): Promise<Result<{ href: string }>> {
  try {
    if (typeof intakeId !== "string" || typeof versionId !== "string" || !intakeId || !versionId) return { ok: false, error: INVALID };
    if (!evidenceEnabled()) throw new InboxError("Dokumen belum diaktifkan di lingkungan ini.");
    const { firm } = await requireCapability("books.write");
    const intake = await prisma.evidenceIntake.findFirst({ where: { id: intakeId, firmId: firm.id }, select: { clientId: true } });
    if (!intake) throw new InboxError("Kumpulan dokumen tidak ditemukan.");
    if (!intake.clientId) throw new InboxError("Hubungkan kumpulan ini ke klien dulu.");
    const who = await access("books.write", intake.clientId);
    const batchId = crypto.randomUUID();
    const item = await adoptVersion(prisma, { firmId: who.firmId, clientId: who.clientId, batchId, versionId, actorId: who.memberId });
    const href = `/clients/${who.clientId}/import`;
    return { ok: true, href: item.batchId === batchId ? `${href}?lanjut=${batchId}` : href };
  } catch (e) {
    if (e instanceof Error && e.message === "Dokumen tidak ditemukan.") return { ok: false, error: e.message };
    return fail(e);
  }
}

/**
 * *Klien baru* from files: one dropped file read for a client that doesn't exist yet — nothing stored, no keyring, only the offered
 * password. The same guard as creating a client (`client.create`).
 */
export async function previewClientFileAction(form: FormData): Promise<Result<{ file: PreviewFile }>> {
  try {
    const { firm } = await requireCapability("client.create");
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Pilih file untuk diunggah." };
    if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: UPLOAD_TOO_BIG };
    const password = String(form.get("password") ?? "").trim().slice(0, 200) || undefined;
    return { ok: true, file: await previewFile(prisma, { firmId: firm.id, name: file.name, data: Buffer.from(await file.arrayBuffer()), password }) };
  } catch (e) {
    return fail(e);
  }
}

/** The drop's confirm card: known rekening, new rekening, files without a number, locked files. */
export async function inboxPlanAction(clientId: string, batchId: string): Promise<Result<{ plan: InboxPlan }>> {
  try {
    const who = await access("books.write", clientId);
    return { ok: true, plan: await planBatch(prisma, { firmId: who.firmId, clientId: who.clientId, batchId: batchOf(batchId) }) };
  } catch (e) {
    return fail(e);
  }
}

/** The drop's one password field: every locked file is read again with it; a password that opens one is kept for the client. */
export async function inboxUnlockAction(clientId: string, batchId: string, password: string): Promise<Result<{ plan: InboxPlan }>> {
  try {
    const who = await access("books.write", clientId);
    const id = batchOf(batchId);
    const value = typeof password === "string" ? password.trim() : "";
    if (!value) return { ok: false, error: "Isi kata sandi PDF.", needsPassword: true };
    if (value.length > 200) return { ok: false, error: "Kata sandi terlalu panjang.", needsPassword: true };
    return { ok: true, plan: await unlockBatch(prisma, { firmId: who.firmId, clientId: who.clientId, batchId: id, password: value, actorId: who.memberId }) };
  } catch (e) {
    return fail(e);
  }
}

const idSchema = z.string().min(1).max(64);
const passwordsSchema = z.array(z.string().min(1).max(200)).max(10);
const confirmSchema = z.strictObject({
  accounts: z
    .array(
      z.strictObject({
        bank: z.string().regex(/^[A-Z0-9_]{2,20}$/),
        number: z.string().min(1).max(40),
        target: z.union([z.strictObject({ entityId: idSchema }), z.strictObject({ newOwner: z.strictObject({ name: z.string().max(120) }) })]),
        label: z.string().max(80).optional(),
        overdraft: z.boolean().optional(),
      }),
    )
    .max(100),
  numberless: z.array(z.strictObject({ itemId: idSchema, bankAccountId: idSchema })).max(500),
});
export type InboxConfirmInput = z.infer<typeof confirmSchema>;

/** *Tambah & impor*: adds the confirmed rekening (and new owners), stores the rekening chosen for files without a number. */
export async function inboxConfirmAction(clientId: string, batchId: string, input: InboxConfirmInput): Promise<Result<{ plan: InboxPlan; errors: ConfirmError[] }>> {
  try {
    const who = await access("books.write", clientId);
    const id = batchOf(batchId);
    const parsed = confirmSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: INVALID };
    const { plan, errors } = await confirmBatch(prisma, { firmId: who.firmId, clientId: who.clientId, batchId: id, actorId: who.memberId, ...parsed.data });
    revalidatePath(`/clients/${who.clientId}`, "layout");
    return { ok: true, plan, errors };
  } catch (e) {
    return fail(e);
  }
}

/** *Batal*: the named files are kept in Dokumen only, never booked. */
export async function inboxSkipAction(clientId: string, batchId: string, itemIds: string[]): Promise<Result<{ plan: InboxPlan }>> {
  try {
    const who = await access("books.write", clientId);
    const id = batchOf(batchId);
    const ids = z.array(idSchema).min(1).max(500).safeParse(itemIds);
    if (!ids.success) return { ok: false, error: INVALID };
    return { ok: true, plan: await skipItems(prisma, { firmId: who.firmId, clientId: who.clientId, batchId: id, itemIds: ids.data }) };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Books the drop's next file (the page calls this until `item` is null). After the last file of a drop that booked a statement, the
 * client's background AI run is scheduled once, so suggestions arrive without a request waiting on a paid call.
 */
export async function inboxProcessNextAction(
  clientId: string,
  batchId: string,
  passwords: string[] = [],
): Promise<Result<{ item: InboxItem | null; remaining: number; aiRun: AiRunView | null }>> {
  try {
    const who = await access("books.write", clientId);
    const id = batchOf(batchId);
    // The passwords that opened this drop's files, held by the page for the drop only (never stored without SETTINGS_SECRET).
    const offered = passwordsSchema.safeParse(passwords);
    if (!offered.success) return { ok: false, error: "Kata sandi tidak valid." };
    const provider = await resolveProvider(prisma);
    const scope = { firmId: who.firmId, clientId: who.clientId, batchId: id };
    const { item, remaining } = await processNext(prisma, { ...scope, actorId: who.memberId, provider, passwords: offered.data });
    let aiRun: AiRunView | null = null;
    if (item && remaining === 0 && provider && (await prisma.uploadItem.count({ where: { ...scope, status: "BOOKED" } }))) {
      aiRun = await scheduleAiRun(prisma, { id: who.clientId, firmId: who.firmId }, provider);
    }
    if (item && (item.status === "BOOKED" || item.status === "DRAFT")) revalidatePath(`/clients/${who.clientId}`, "layout");
    return { ok: true, item, remaining, aiRun };
  } catch (e) {
    return fail(e);
  }
}

/** The lines of a drop — the given one, or the client's latest when none is given (after a reload). Reads only. */
export async function inboxBatchAction(clientId: string, batchId?: string): Promise<Result<{ batchId: string | null; items: InboxItem[] }>> {
  try {
    const who = await access("books.read", clientId);
    const id = batchId === undefined || batchId === null || batchId === "" ? undefined : batchOf(batchId);
    return { ok: true, ...(await batchItems(prisma, { firmId: who.firmId, clientId: who.clientId, batchId: id })) };
  } catch (e) {
    return fail(e);
  }
}

/** The firm's Drive (Dokumen's Google connection), read-only, for a member who may write this client's books. */
async function driveFor(clientId: string): Promise<{ who: Awaited<ReturnType<typeof access>>; token: string }> {
  const who = await access("books.write", clientId);
  if (!evidenceEnabled()) throw new InboxError("Dokumen belum diaktifkan di lingkungan ini.");
  if (!(await prisma.driveConnection.findUnique({ where: { firmId: who.firmId }, select: { firmId: true } }))) throw new InboxError(NO_DRIVE);
  return { who, token: await driveToken(prisma, who.firmId) };
}
const reader = (token: string): DriveReader => ({ get: (id, key) => getDriveFile(token, id, key), list: (id, page, key) => listDriveChildren(token, id, page, key) });

/** A pasted Drive folder link: the files Buku can read in it and its subfolders. Downloads nothing. */
export async function inboxDriveListAction(clientId: string, url: string): Promise<Result<{ files: DriveListedFile[] }>> {
  try {
    const { token } = await driveFor(clientId);
    const root = parseDriveFolderUrl(typeof url === "string" ? url : "");
    return { ok: true, files: await listDriveFolder(reader(token), root) };
  } catch (e) {
    return fail(e);
  }
}

/** One listed Drive file: fetched again by id with the firm's token (name and type from Drive), stored and read like a dropped file. */
export async function inboxDriveFileAction(clientId: string, batchId: string, fileId: string, resourceKey?: string): Promise<Result<{ item: InboxItem }>> {
  try {
    const { who, token } = await driveFor(clientId);
    const id = batchOf(batchId);
    if (typeof fileId !== "string" || (resourceKey !== undefined && typeof resourceKey !== "string")) return { ok: false, error: INVALID };
    const file = await fetchDriveFile({ ...reader(token), download: (f) => downloadDriveFile(token, f) }, fileId, resourceKey || undefined);
    const item = await checkFile(prisma, { firmId: who.firmId, clientId: who.clientId, batchId: id, name: file.name, data: file.data, actorId: who.memberId });
    return { ok: true, item };
  } catch (e) {
    return fail(e);
  }
}

/** Pengaturan klien: how many PDF passwords the client's keyring holds (ADR 0018: admins only, never the values). */
export async function inboxKeyringAction(clientId: string): Promise<Result<{ count: number }>> {
  try {
    const who = await access("org.settings", clientId);
    return { ok: true, count: await keyringSize(prisma, who.clientId) };
  } catch (e) {
    return fail(e);
  }
}

/** Pengaturan klien: forget every stored PDF password of the client; the next locked file asks again. */
export async function clearInboxKeyringAction(clientId: string): Promise<Result<{ cleared: number }>> {
  try {
    const who = await access("org.settings", clientId);
    const cleared = await clearKeyring(prisma, { firmId: who.firmId, clientId: who.clientId });
    revalidatePath(`/clients/${who.clientId}/settings`);
    return { ok: true, cleared };
  } catch (e) {
    return fail(e);
  }
}
