import type { Db } from "@/lib/db";
import { PdfPasswordError } from "@/lib/import/parsers/pdf";
import { decryptSecret, encryptSecret, settingsSecretConfigured } from "@/lib/settings/secret";

/**
 * A client's PDF password keyring (ADR 0018). Server-only: passwords are stored encrypted (`encryptSecret`), tried here and nowhere
 * else, and never returned, logged or written into a message. Another client's keyring is never read.
 */
type Scope = { firmId: string; clientId: string };

/** A locked PDF that neither the offered password nor any stored one opens. The message never names a password. */
export class NeedsPasswordError extends Error {
  constructor(readonly wrongOffered: boolean) {
    super(wrongOffered ? "Kata sandi tidak membuka PDF ini. Coba kata sandi lain." : "PDF ini dikunci kata sandi.");
  }
}

/** Stored passwords, most recently used first; values that no longer decrypt (SETTINGS_SECRET rotated) are skipped. */
async function stored(db: Db, scope: Scope) {
  if (!settingsSecretConfigured()) return [];
  const rows = await db.clientPdfPassword.findMany({ where: scope, orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }], select: { id: true, secret: true } });
  return rows.flatMap((r) => {
    try {
      return [{ id: r.id, password: decryptSecret(r.secret) }];
    } catch {
      return [];
    }
  });
}

/**
 * Opens a file with `tryOpen`: first without a password; when it is a locked PDF, with the offered password(s), then with each
 * stored one. `tryOpen` throws `PdfPasswordError` for a password that doesn't open the file; any other error is the caller's and
 * passes through. `usedOffered`: an offered password opened it (the caller adds it to the keyring). No scope (a client that doesn't
 * exist yet, *Klien baru* from files): only the offered passwords are tried.
 */
export async function openWithKeyring<T>(
  db: Db,
  scope: Scope | null,
  tryOpen: (password?: string) => Promise<T>,
  opts: { offered?: string | readonly string[] } = {},
): Promise<{ result: T; usedKeyring: boolean; usedOffered: boolean }> {
  try {
    return { result: await tryOpen(undefined), usedKeyring: false, usedOffered: false };
  } catch (e) {
    if (!(e instanceof PdfPasswordError)) throw e;
  }
  const offered = [opts.offered ?? []].flat().filter(Boolean);
  for (const password of offered) {
    try {
      return { result: await tryOpen(password), usedKeyring: false, usedOffered: true };
    } catch (e) {
      if (!(e instanceof PdfPasswordError)) throw e;
    }
  }
  for (const key of scope ? await stored(db, scope) : []) {
    if (offered.includes(key.password)) continue;
    try {
      const result = await tryOpen(key.password);
      await db.clientPdfPassword.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
      return { result, usedKeyring: true, usedOffered: false };
    } catch (e) {
      if (!(e instanceof PdfPasswordError)) throw e;
    }
  }
  throw new NeedsPasswordError(offered.length > 0);
}

/**
 * Adds a password that opened one of the client's files, unless the keyring already holds it. Needs SETTINGS_SECRET: without it the
 * password can't be remembered and the caller uses it for this file only.
 */
export async function addPassword(db: Db, input: Scope & { password: string; actorId?: string | null }): Promise<{ added: boolean }> {
  if (!settingsSecretConfigured()) throw new Error("Kata sandi tidak bisa disimpan di server ini; dipakai untuk file ini saja.");
  if (!input.password) return { added: false };
  if (!(await db.client.findFirst({ where: { id: input.clientId, firmId: input.firmId }, select: { id: true } }))) throw new Error("Klien tidak ditemukan.");
  return db.$transaction(async (tx) => {
    // One writer per client keyring, so two files opened by the same new password store it once.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pdf-keyring:${input.clientId}`}, 0))::text`;
    const rows = await tx.clientPdfPassword.findMany({ where: { firmId: input.firmId, clientId: input.clientId }, select: { id: true, secret: true } });
    const same = rows.find((r) => {
      try {
        return decryptSecret(r.secret) === input.password;
      } catch {
        return false;
      }
    });
    if (same) {
      await tx.clientPdfPassword.update({ where: { id: same.id }, data: { lastUsedAt: new Date() } });
      return { added: false };
    }
    await tx.clientPdfPassword.create({ data: { firmId: input.firmId, clientId: input.clientId, secret: encryptSecret(input.password), createdById: input.actorId ?? null, lastUsedAt: new Date() } });
    return { added: true };
  });
}

/** How many passwords the client's keyring holds (Pengaturan klien shows the count, never the values). */
export async function keyringSize(db: Db, clientId: string) {
  return db.clientPdfPassword.count({ where: { clientId } });
}

/** Forgets every stored password of the client: the next locked file asks again. */
export async function clearKeyring(db: Db, scope: Scope) {
  return (await db.clientPdfPassword.deleteMany({ where: scope })).count;
}
