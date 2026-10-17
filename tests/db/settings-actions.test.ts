import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { listEvents } from "@/lib/audit";
import { DEFAULT_AUTOMATION, readAutomation } from "@/lib/settings/automation";
import { addMember } from "../members";
import { createFirm } from "@/lib/setup";

const auth = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({ authConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getClaims: async () => ({ data: auth.userId ? { claims: { sub: auth.userId } } : null }) } }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const { saveAiSettingsAction, clearAiKeyAction } = await import("@/app/settings-actions");
const { saveAutomationAction } = await import("@/app/firm-settings-actions");

const roles = { admin: "", akuntan: "", ops: "" };

describe("Pengaturan actions", () => {
  beforeEach(async () => {
    vi.stubEnv("SETTINGS_SECRET", "test-secret-0123456789abcdefghijklmnop");
    await resetDb();
    const firm = await db.$transaction((tx) => createFirm(tx, "KAP Pengaturan"));
    roles.admin = (await addMember(firm.id, "ADMIN")).userId;
    roles.akuntan = (await addMember(firm.id, "AKUNTAN")).userId;
    roles.ops = (await db.platformAdmin.create({ data: { userId: randomUUID(), email: `ops-${randomUUID()}@buku.test`, name: "Ops" } })).userId;
    auth.userId = roles.ops;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses every organisation member, admins included, and writes nothing: the key is Buku's (ADR 0017 §6)", async () => {
    for (const userId of [roles.admin, roles.akuntan]) {
      auth.userId = userId;
      expect(await saveAiSettingsAction({ apiKey: "sk-zen-12345678", model: "m" })).toEqual({ ok: false, error: "Hanya admin Buku yang dapat mengubah ini." });
      expect(await clearAiKeyAction()).toMatchObject({ ok: false });
    }
    expect(await db.appSetting.count()).toBe(0);
  });

  it("refuses anonymous callers", async () => {
    auth.userId = null;
    expect(await saveAiSettingsAction({ apiKey: "sk-zen-12345678", model: "m" })).toEqual({ ok: false, error: "Hanya admin Buku yang dapat mengubah ini." });
  });

  it("saves for a Buku admin and returns only the last 4 characters of the key", async () => {
    const r = await saveAiSettingsAction({ apiKey: "sk-zen-12345678", model: "big-pickle" });
    expect(r).toEqual({ ok: true, keyLast4: "5678" });
    expect(JSON.stringify(r)).not.toContain("sk-zen");
  });
});

describe("Otomasi kantor action (cycle 2026-10-17-otomasi): org.settings, unchanged permission matrix", () => {
  const ON = { transfer: true, rules: true, memory: true, cap: "", fluxFloor: "", fluxPercent: "50" };
  beforeEach(async () => {
    await resetDb();
    auth.userId = null;
  });

  it("Pemilik and Admin save, with one Riwayat event per client naming them", async () => {
    const g = await makeGroup();
    for (const role of ["OWNER", "ADMIN"] as const) {
      const m = await addMember(g.firm.id, role, { name: `Saya ${role}` });
      auth.userId = m.userId;
      expect(await saveAutomationAction({ ...ON, rules: role !== "OWNER", cap: role === "OWNER" ? "100.000.000" : "" })).toEqual({ ok: true, changed: true });
      expect((await listEvents(db, g.client.id, { kind: "AUTOMATION" }))[0].actor).toBe(`Saya ${role}`);
    }
    expect(await readAutomation(db, g.firm.id)).toEqual(DEFAULT_AUTOMATION);
    expect(await listEvents(db, g.client.id, { kind: "AUTOMATION" })).toHaveLength(2);
    // Nothing changed: nothing written.
    expect(await saveAutomationAction(ON)).toEqual({ ok: true, changed: false });
    expect(await listEvents(db, g.client.id, { kind: "AUTOMATION" })).toHaveLength(2);
  });

  it("refuses Akuntan, Peninjau and anonymous callers with the admin message, and saves nothing", async () => {
    const g = await makeGroup();
    for (const role of ["AKUNTAN", "VIEWER"] as const) {
      auth.userId = (await addMember(g.firm.id, role, { clients: [g.client.id] })).userId;
      expect(await saveAutomationAction({ ...ON, rules: false })).toEqual({ ok: false, error: "Hanya admin kantor yang dapat mengubah ini." });
    }
    auth.userId = null;
    expect(await saveAutomationAction({ ...ON, rules: false })).toEqual({ ok: false, error: "Masuk terlebih dahulu." });
    expect(await readAutomation(db, g.firm.id)).toEqual(DEFAULT_AUTOMATION);
    expect(await listEvents(db, g.client.id, { kind: "AUTOMATION" })).toHaveLength(0);
  });

  it("refuses while the organisation is read-only", async () => {
    const g = await makeGroup();
    auth.userId = (await addMember(g.firm.id, "OWNER")).userId;
    await db.accessGrant.deleteMany({ where: { firmId: g.firm.id } });
    await db.accessGrant.create({ data: { firmId: g.firm.id, kind: "TRIAL", startsAt: new Date("2026-09-01T00:00:00Z"), endsAt: new Date("2026-09-15T16:59:59.999Z") } });
    expect(await saveAutomationAction({ ...ON, rules: false })).toMatchObject({ ok: false, error: expect.stringMatching(/^Masa uji coba berakhir/) });
    expect(await readAutomation(db, g.firm.id)).toEqual(DEFAULT_AUTOMATION);
  });

  it("refuses invalid input with field messages and no event; a crafted call switches only on booleans", async () => {
    const g = await makeGroup();
    auth.userId = (await addMember(g.firm.id, "ADMIN")).userId;
    expect(await saveAutomationAction({ ...ON, cap: "abc", fluxPercent: "0" })).toEqual({
      ok: false,
      error: "Periksa isian yang ditandai. Tidak ada yang disimpan.",
      fields: { cap: "Isi nominal Rupiah lebih dari 0, atau kosongkan.", fluxPercent: "Isi persentase bulat dari 1 sampai 1000." },
    });
    expect(await listEvents(db, g.client.id, { kind: "AUTOMATION" })).toHaveLength(0);
    // "yes" is not true: a crafted call can't switch a source on by accident, and a number where text is expected reads as empty.
    expect(await saveAutomationAction({ transfer: "yes", rules: true, memory: true, cap: 5, fluxFloor: "", fluxPercent: "50" } as never)).toEqual({ ok: true, changed: true });
    expect(await readAutomation(db, g.firm.id)).toEqual({ ...DEFAULT_AUTOMATION, transfer: false });
  });
});
