import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addPassword, clearKeyring, keyringSize, NeedsPasswordError, openWithKeyring } from "@/lib/inbox/keyring";
import { PdfPasswordError } from "@/lib/import/parsers/pdf";
import { createClient } from "@/lib/setup";

const SECRET = "inbox-keyring-test-secret-32-characters-long";
beforeEach(async () => {
  vi.stubEnv("SETTINGS_SECRET", SECRET);
  await resetDb();
});
afterEach(() => vi.unstubAllEnvs());

/** A stand-in for a locked PDF reader: opens only with `right`. */
const lockedWith = (right: string) => vi.fn(async (password?: string) => {
  if (password === undefined) throw new PdfPasswordError("needed");
  if (password !== right) throw new PdfPasswordError("wrong");
  return "opened";
});

describe("PDF password keyring", () => {
  it("stores a password encrypted and once; counts and clears", async () => {
    const g = await makeGroup();
    const scope = { firmId: g.firm.id, clientId: g.client.id };
    expect(await addPassword(db, { ...scope, password: "01011980", actorId: "m1" })).toEqual({ added: true });
    expect(await addPassword(db, { ...scope, password: "01011980", actorId: "m1" })).toEqual({ added: false });
    expect(await addPassword(db, { ...scope, password: "rahasia" })).toEqual({ added: true });
    expect(await keyringSize(db, g.client.id)).toBe(2);
    const rows = await db.clientPdfPassword.findMany();
    for (const r of rows) {
      expect(r.secret).toMatch(/^v1:/);
      expect(r.secret).not.toContain("01011980");
      expect(r.secret).not.toContain("rahasia");
    }
    expect(rows.find((r) => r.createdById === "m1")).toBeTruthy();
    expect(await clearKeyring(db, scope)).toBe(2);
    expect(await keyringSize(db, g.client.id)).toBe(0);
  });

  it("refuses to remember a password without SETTINGS_SECRET, and for another firm's client", async () => {
    const g = await makeGroup();
    vi.stubEnv("SETTINGS_SECRET", "");
    await expect(addPassword(db, { firmId: g.firm.id, clientId: g.client.id, password: "rahasia" })).rejects.toThrow(/tidak bisa disimpan/);
    vi.stubEnv("SETTINGS_SECRET", SECRET);
    await expect(addPassword(db, { firmId: "foreign", clientId: g.client.id, password: "rahasia" })).rejects.toThrow(/Klien tidak ditemukan/);
    expect(await db.clientPdfPassword.count()).toBe(0);
  });

  it("opens unlocked files without reading the keyring; tries the offered password, then the stored ones", async () => {
    const g = await makeGroup();
    const scope = { firmId: g.firm.id, clientId: g.client.id };
    const open = vi.fn(async () => "plain");
    expect(await openWithKeyring(db, scope, open)).toEqual({ result: "plain", usedKeyring: false, usedOffered: false });
    expect(open).toHaveBeenCalledTimes(1);

    const locked = lockedWith("rahasia");
    expect(await openWithKeyring(db, scope, locked, { offered: "rahasia" })).toMatchObject({ result: "opened", usedOffered: true, usedKeyring: false });

    await addPassword(db, { ...scope, password: "lain" });
    await addPassword(db, { ...scope, password: "rahasia" });
    const fromKeyring = lockedWith("rahasia");
    expect(await openWithKeyring(db, scope, fromKeyring)).toMatchObject({ result: "opened", usedKeyring: true, usedOffered: false });
    const used = await db.clientPdfPassword.findMany({ orderBy: { lastUsedAt: "desc" } });
    expect(used.every((r) => r.lastUsedAt)).toBe(true);

    // The most recently used password is tried first next time.
    const second = lockedWith("rahasia");
    await openWithKeyring(db, scope, second);
    expect(second.mock.calls.map((c) => c[0])).toEqual([undefined, "rahasia"]);

    // Errors other than a password pass through unchanged.
    await expect(openWithKeyring(db, scope, async () => { throw new Error("rusak"); })).rejects.toThrow("rusak");
  });

  it("asks when nothing opens the file; never tries another client's passwords or values it can't decrypt", async () => {
    const g = await makeGroup();
    const other = await db.$transaction((tx) => createClient(tx, g.firm.id, { name: "Klien Lain", industry: "retail", entities: [{ name: "PT Lain", shortName: "Lain", kind: "PT", banks: [] }] }));
    await addPassword(db, { firmId: g.firm.id, clientId: other.client.id, password: "rahasia" });
    const scope = { firmId: g.firm.id, clientId: g.client.id };
    const locked = lockedWith("rahasia");
    const needed = await openWithKeyring(db, scope, locked).catch((e) => e);
    expect(needed).toBeInstanceOf(NeedsPasswordError);
    expect(needed.wrongOffered).toBe(false);
    expect(locked.mock.calls.map((c) => c[0])).toEqual([undefined]);

    const wrong = await openWithKeyring(db, scope, lockedWith("rahasia"), { offered: "salah" }).catch((e) => e);
    expect(wrong).toBeInstanceOf(NeedsPasswordError);
    expect(wrong.wrongOffered).toBe(true);
    expect(wrong.message).not.toContain("salah");

    await addPassword(db, { ...scope, password: "rahasia" });
    vi.stubEnv("SETTINGS_SECRET", SECRET + "-rotated");
    await expect(openWithKeyring(db, scope, lockedWith("rahasia"))).rejects.toBeInstanceOf(NeedsPasswordError);
  });
});
