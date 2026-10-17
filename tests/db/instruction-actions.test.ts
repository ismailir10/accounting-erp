import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";
import { createClient } from "@/lib/setup";
import { listEvents } from "@/lib/audit";

const auth = vi.hoisted(() => ({ userId: null as string | null, support: null as string | null }));
vi.mock("@/lib/auth", () => ({ authConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getClaims: async () => ({ data: auth.userId ? { claims: { sub: auth.userId, aal: "aal2" } } : null }) } }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (auth.support ? { value: auth.support } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const actions = await import("@/app/instruction-actions");
const { startSupportSession, SUPPORT_READ_ONLY } = await import("@/lib/auth/support");
const { AI_UNAVAILABLE } = await import("@/lib/instructions/ai");

/**
 * Instruksi kantor's actions (cycle 2026-10-18-instruksi-kantor) through the real guard: *Semua klien* needs `org.settings` (Pemilik,
 * Admin); one client needs `books.write` on it (an assigned Akuntan too). An unassigned client reads as missing; Peninjau, a read-only
 * organisation and a support session are refused. The permission matrix is unchanged.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;
const ADMIN_ONLY = "Hanya admin kantor yang dapat mengubah ini.";
const VIEWER = "Peran Peninjau hanya dapat melihat dan mengunduh laporan.";
const RULE = { kind: "ACCOUNT", pattern: "BIAYA ADM", direction: "OUT", accountCode: "6190", taxTag: null, minAmount: null, inclusive: false } as const;
const as = async (g: G, role: "OWNER" | "ADMIN" | "AKUNTAN" | "VIEWER", clients: string[] = [], name = role.toLowerCase()) => {
  const m = await addMember(g.firm.id, role, { clients, name });
  auth.userId = m.userId;
  return m;
};
const approve = (clientId: string | null, sentence = '"BIAYA ADM" selalu 6190', fields: unknown = RULE) => actions.approveInstructionAction({ sentence, clientId, fields: fields as typeof RULE });

describe("instruction actions", () => {
  let g: G;
  let other: string;
  beforeEach(async () => {
    await resetDb();
    auth.userId = null;
    auth.support = null;
    g = await makeGroup();
    other = (await db.$transaction((tx) => createClient(tx, g.firm.id, { name: "Klien Lain", industry: "", entities: [{ name: "PT Lain", shortName: "Lain", kind: "PT", banks: [] }] }))).client.id;
  });

  it("Pemilik and Admin compile, preview, approve and turn off Semua klien and client instructions, named in Riwayat", async () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      await resetDb();
      g = await makeGroup();
      await as(g, role, [], `Saya ${role}`);
      const compiled = await actions.compileInstructionAction({ sentence: "biaya admin bank selalu 6190", clientId: null });
      expect(compiled).toMatchObject({ ok: true, origin: "PARSER", preview: { draft: { pattern: "BIAYA ADMIN BANK", accountCode: "6190" } } });
      expect((compiled as { accounts: { code: string }[] }).accounts.map((a) => a.code)).toContain("6190");
      expect(await actions.previewInstructionAction({ clientId: null, fields: RULE, origin: "PARSER" })).toMatchObject({ ok: true, preview: { draft: RULE } });
      expect(await approve(null)).toEqual({ ok: true });
      expect(await approve(g.client.id, "tandai pengeluaran > Rp10 jt", { ...RULE, kind: "FLAG", pattern: null, accountCode: null, minAmount: "10000000" })).toEqual({ ok: true });
      const [firmWide, own] = await db.instruction.findMany({ orderBy: { approvedAt: "asc" } });
      expect((await listEvents(db, g.client.id, { kind: "INSTRUCTION" }))[0].actor).toBe(`Saya ${role}`);
      expect(await actions.turnOffInstructionAction({ id: firmWide.id })).toEqual({ ok: true });
      expect(await actions.turnOffInstructionAction({ id: own.id })).toEqual({ ok: true });
      expect(await db.instruction.count({ where: { status: "OFF" } })).toBe(2);
    }
  });

  it("an assigned Akuntan approves and turns off for its client, and is refused for Semua klien", async () => {
    await as(g, "OWNER");
    expect(await approve(null)).toEqual({ ok: true });
    const firmWide = await db.instruction.findFirstOrThrow();
    await as(g, "AKUNTAN", [g.client.id]);
    expect(await actions.compileInstructionAction({ sentence: '"BIAYA ADM" selalu 6190', clientId: null })).toEqual({ ok: false, error: ADMIN_ONLY });
    expect(await actions.aiCompileInstructionAction({ sentence: "kalau ada yang aneh kabari saya", clientId: null })).toEqual({ ok: false, error: ADMIN_ONLY });
    expect(await approve(null, '"GOJEK" selalu 6140', { ...RULE, pattern: "GOJEK", accountCode: "6140" })).toEqual({ ok: false, error: ADMIN_ONLY });
    expect(await actions.turnOffInstructionAction({ id: firmWide.id })).toEqual({ ok: false, error: ADMIN_ONLY });
    expect(await actions.compileInstructionAction({ sentence: '"BIAYA ADM" selalu 6190', clientId: g.client.id })).toMatchObject({ ok: true });
    expect(await approve(g.client.id)).toEqual({ ok: true });
    const own = await db.instruction.findFirstOrThrow({ where: { clientId: g.client.id } });
    expect(await actions.turnOffInstructionAction({ id: own.id })).toEqual({ ok: true });
    expect(await db.instruction.findUniqueOrThrow({ where: { id: firmWide.id } })).toMatchObject({ status: "ACTIVE" });
  });

  it("an unassigned client is refused as missing, for writing and for turning off", async () => {
    await as(g, "OWNER");
    expect(await approve(other)).toEqual({ ok: true });
    const theirs = await db.instruction.findFirstOrThrow();
    await as(g, "AKUNTAN", [g.client.id]);
    expect(await approve(other, '"GOJEK" selalu 6140', { ...RULE, pattern: "GOJEK", accountCode: "6140" })).toEqual({ ok: false, error: "Klien tidak ditemukan" });
    expect(await actions.compileInstructionAction({ sentence: '"GOJEK" selalu 6140', clientId: other })).toEqual({ ok: false, error: "Klien tidak ditemukan" });
    expect(await actions.turnOffInstructionAction({ id: theirs.id })).toEqual({ ok: false, error: "Klien tidak ditemukan" });
    expect(await approve("no-such-client")).toEqual({ ok: false, error: "Klien tidak ditemukan" });
  });

  it("Peninjau is refused with its role message; anonymous callers must sign in", async () => {
    await as(g, "OWNER");
    await approve(g.client.id);
    const own = await db.instruction.findFirstOrThrow();
    await as(g, "VIEWER", [g.client.id]);
    expect(await approve(g.client.id, '"GOJEK" selalu 6140', { ...RULE, pattern: "GOJEK", accountCode: "6140" })).toEqual({ ok: false, error: VIEWER });
    expect(await actions.compileInstructionAction({ sentence: '"GOJEK" selalu 6140', clientId: g.client.id })).toEqual({ ok: false, error: VIEWER });
    expect(await actions.turnOffInstructionAction({ id: own.id })).toEqual({ ok: false, error: VIEWER });
    expect(await approve(null)).toEqual({ ok: false, error: ADMIN_ONLY });
    auth.userId = null;
    expect(await approve(g.client.id)).toEqual({ ok: false, error: "Masuk terlebih dahulu." });
    expect(await actions.turnOffInstructionAction({ id: own.id })).toEqual({ ok: false, error: "Masuk terlebih dahulu." });
    expect(await db.instruction.count()).toBe(1);
  });

  it("refuses while the organisation is read-only, and in a support session", async () => {
    const owner = await as(g, "OWNER");
    await db.accessGrant.deleteMany({ where: { firmId: g.firm.id } });
    await db.accessGrant.create({ data: { firmId: g.firm.id, kind: "TRIAL", startsAt: new Date("2026-09-01T00:00:00Z"), endsAt: new Date("2026-09-15T16:59:59.999Z") } });
    expect(await approve(null)).toMatchObject({ ok: false, error: expect.stringMatching(/^Masa uji coba berakhir/) });
    expect(await approve(g.client.id)).toMatchObject({ ok: false, error: expect.stringMatching(/^Masa uji coba berakhir/) });
    await db.accessGrant.deleteMany({ where: { firmId: g.firm.id } });
    await db.accessGrant.create({ data: { firmId: g.firm.id, kind: "PAID", startsAt: new Date("2026-01-01T00:00:00Z"), endsAt: null } });
    const ops = await db.platformAdmin.create({ data: { userId: randomUUID(), email: `ops-${randomUUID()}@buku.test`, name: "Ops" } });
    const s = await startSupportSession(db, { adminId: ops.id, aal: "aal2", firmId: g.firm.id, asMemberId: owner.id, reason: "Instruksi kantor tidak tampil" });
    auth.userId = ops.userId;
    auth.support = s.id;
    expect(await approve(null)).toEqual({ ok: false, error: SUPPORT_READ_ONLY });
    expect(await approve(g.client.id)).toEqual({ ok: false, error: SUPPORT_READ_ONLY });
    expect(await db.instruction.count()).toBe(0);
  });

  it("crafted input: fields outside the closed schema, a duplicate, and Susun dengan AI without a model", async () => {
    await as(g, "ADMIN");
    expect(await approve(null, '"BIAYA ADM" selalu 6190', { ...RULE, accountCode: "6195" })).toEqual({ ok: false, error: "Akun 6195 tidak ada di bagan akun klien ini.", field: "accountCode" });
    expect(await approve(null, '"BIAYA ADM" selalu 6190', { ...RULE, sneaky: true })).toMatchObject({ ok: false, error: "Isian instruksi tidak dikenal: sneaky." });
    expect(await approve(null, '"BIAYA ADM" selalu 6190', "not an object")).toMatchObject({ ok: false });
    expect(await actions.previewInstructionAction({ clientId: null, fields: { ...RULE, accountCode: "6195" }, origin: "PARSER" })).toEqual({ ok: false, error: "Akun 6195 tidak ada di bagan akun klien ini.", field: "accountCode" });
    expect(await approve(null)).toEqual({ ok: true });
    expect(await approve(null)).toEqual({ ok: false, error: 'Sudah ada instruksi aktif untuk kata kunci ini: ""BIAYA ADM" selalu 6190". Matikan dulu bila ingin menggantinya.' });
    expect(await actions.compileInstructionAction({ sentence: "kalau ada yang aneh kabari saya", clientId: null })).toEqual({ ok: false, error: "Buku belum memahami kalimat ini.", askAi: true });
    expect(await actions.compileInstructionAction({ sentence: "TRANSFER selalu 6190", clientId: null })).toMatchObject({ ok: false, askAi: false });
    expect(await actions.aiCompileInstructionAction({ sentence: "kalau ada yang aneh kabari saya", clientId: null })).toEqual({ ok: false, error: AI_UNAVAILABLE });
    expect(await db.instruction.count()).toBe(1);
  });
});
