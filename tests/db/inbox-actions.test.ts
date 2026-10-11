import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";
import { makePdf, table } from "../pdf-fixture";
import { createClient } from "@/lib/setup";
import { toBcaCsv } from "@/lib/demo/writers";
import { MockProvider } from "@/lib/ai/provider";
import { addPassword } from "@/lib/inbox/keyring";
import { batchItems } from "@/lib/inbox/plan";
import { createIntake, hash } from "@/lib/evidence/store";

// The Unggah actions through the real guard (ADR 0017 §5): only the login token, the AI setting and `after()` scheduling are faked.
const state = vi.hoisted(() => ({ userId: null as string | null, provider: null as unknown, scheduled: 0 }));
vi.mock("@/lib/auth", () => ({ authConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getClaims: async () => ({ data: state.userId ? { claims: { sub: state.userId } } : null }) } }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/settings/ai", async (original) => ({ ...(await original<typeof import("@/lib/settings/ai")>()), resolveProvider: async () => state.provider }));
vi.mock("@/lib/ai/background", () => ({
  scheduleAiRun: async () => {
    state.scheduled++;
    return { id: "run", status: "RUNNING", totalLines: 0, askedLines: 0, suggestedLines: 0, note: null };
  },
  aiRunForView: async () => null,
}));
const actions = await import("@/app/actions");

const SECRET = "inbox-actions-test-secret-32-characters-long";
beforeEach(async () => {
  vi.stubEnv("SETTINGS_SECRET", SECRET);
  await resetDb();
  Object.assign(state, { userId: null, provider: null, scheduled: 0 });
});
afterEach(() => vi.unstubAllEnvs());

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
const bcaCsv = (month: number) =>
  Buffer.from(toBcaCsv({ bank: "BCA", accountNumber: "1111111111", holder: "PT Uji Sejahtera", year: 2026, month, opening: 1_000_000n + 300_000n * BigInt(month - 1), rows: [{ date: d(2026, month, 5), description: "SETORAN TUNAI", amount: 500_000n }, { date: d(2026, month, 9), description: "PEMBELIAN PAKAN", amount: -200_000n }] }));
const PASSWORD = "rahasia-klien-77";
const mandiriPdf = () =>
  makePdf(
    [
      [
        ...table(800, [[[40, "PT Bank Mandiri (Persero) Tbk"]], [[40, "Nomor Rekening : 2222222222"]], [[40, "Periode : 01/03/2026 - 31/03/2026"]]]),
        ...table(740, [
          [[40, "Tanggal"], [130, "Keterangan"], [360, "Debit"], [440, "Kredit"], [520, "Saldo"]],
          [[40, "01/03/2026"], [130, "SALDO AWAL"], [510, "0,00"]],
          [[40, "04/03/2026"], [130, "TRANSFER DARI PT MITRA UNGGAS"], [430, "20.000.000,00"], [510, "20.000.000,00"]],
        ]),
      ],
    ],
    { userPassword: PASSWORD },
  );
const form = (batchId: string, name: string, data: Buffer, password?: string) => {
  const f = new FormData();
  f.set("batchId", batchId);
  f.set("file", new File([new Uint8Array(data)], name));
  if (password) f.set("password", password);
  return f;
};

describe("Unggah actions", () => {
  it("checks, unlocks, plans and books a drop; schedules the AI run once after the last file; never returns the password", async () => {
    const g = await makeGroup();
    state.userId = (await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] })).userId;
    state.provider = new MockProvider();
    const responses: unknown[] = [];
    const keep = <T>(r: T) => (responses.push(r), r);

    const earlier = randomUUID();
    keep(await actions.inboxCheckFileAction(g.client.id, form(earlier, "catatan.md", Buffer.from("# Catatan\n"))));
    const batch = randomUUID();
    const csv = keep(await actions.inboxCheckFileAction(g.client.id, form(batch, "bca-jan.csv", bcaCsv(1))));
    expect(csv).toMatchObject({ ok: true, item: { status: "CHECKED", kind: "BANK", batchId: batch } });
    const locked = keep(await actions.inboxCheckFileAction(g.client.id, form(batch, "mandiri-mar.pdf", mandiriPdf())));
    expect(locked).toMatchObject({ ok: true, item: { status: "NEEDS_PASSWORD" } });

    // The latest drop after a reload: this one, files in processing order.
    const latest = keep(await actions.inboxBatchAction(g.client.id));
    expect(latest).toMatchObject({ ok: true, batchId: batch });
    expect(latest.ok && latest.items.map((i) => i.fileName)).toEqual(["bca-jan.csv", "mandiri-mar.pdf"]);

    expect(await actions.inboxUnlockAction(g.client.id, batch, "   ")).toEqual({ ok: false, error: "Isi kata sandi PDF.", needsPassword: true });
    const unlocked = keep(await actions.inboxUnlockAction(g.client.id, batch, ` ${PASSWORD} `));
    expect(unlocked).toMatchObject({ ok: true, plan: { ready: true, needsPassword: [] } });

    const done: string[] = [];
    let last;
    for (let i = 0; i < 5; i++) {
      const r = keep(await actions.inboxProcessNextAction(g.client.id, batch));
      if (!r.ok) throw new Error(r.error);
      if (!r.item) break;
      done.push(`${r.item.fileName}:${r.item.status}`);
      expect(r.aiRun === null).toBe(r.remaining > 0);
      last = r;
    }
    expect(done).toEqual(["bca-jan.csv:BOOKED", "mandiri-mar.pdf:BOOKED"]);
    expect(last).toMatchObject({ remaining: 0, aiRun: { id: "run" } });
    expect(state.scheduled).toBe(1);

    expect(JSON.stringify(responses)).not.toContain(PASSWORD);
    expect(JSON.stringify(responses)).not.toMatch(/"secret"|"data"/);
  });

  it("refuses a drop id that isn't a uuid and a card that isn't the card's shape", async () => {
    const g = await makeGroup();
    state.userId = (await addMember(g.firm.id, "OWNER")).userId;
    const invalid = { ok: false, error: "Data unggahan tidak valid. Muat ulang halaman lalu coba lagi." };
    expect(await actions.inboxCheckFileAction(g.client.id, form("b1", "a.csv", bcaCsv(1)))).toEqual(invalid);
    expect(await actions.inboxPlanAction(g.client.id, "../x")).toEqual(invalid);
    const batch = randomUUID();
    expect(await actions.inboxConfirmAction(g.client.id, batch, { accounts: [{ bank: "BCA", number: "1", target: { entityId: g.pt.entity.id }, extra: 1 }], numberless: [] } as never)).toEqual(invalid);
    expect(await actions.inboxConfirmAction(g.client.id, batch, { accounts: [], numberless: [] })).toMatchObject({ ok: true, errors: [] });
    expect(await actions.inboxSkipAction(g.client.id, batch, [])).toEqual(invalid);
    const big = form(batch, "besar.pdf", Buffer.alloc(5 * 1024 * 1024 + 1));
    expect(await actions.inboxCheckFileAction(g.client.id, big)).toEqual({ ok: false, error: "File terlalu besar (maks. 5 MB)." });
    expect(await db.uploadItem.count()).toBe(0);
  });

  it("guards every action: a viewer reads only, an akuntan only assigned clients and no keyring, an admin clears it", async () => {
    const g = await makeGroup();
    const other = await db.$transaction((tx) => createClient(tx, g.firm.id, { name: "Klien Dua", industry: "retail", entities: [{ name: "PT Dua", shortName: "Dua", kind: "PT", banks: [] }] }));
    await addPassword(db, { firmId: g.firm.id, clientId: g.client.id, password: PASSWORD });
    const batch = randomUUID();

    expect(await actions.inboxBatchAction(g.client.id)).toEqual({ ok: false, error: "Masuk terlebih dahulu." });

    state.userId = (await addMember(g.firm.id, "VIEWER", { clients: [g.client.id] })).userId;
    expect(await actions.inboxBatchAction(g.client.id)).toEqual({ ok: true, batchId: null, items: [] });
    expect(await actions.inboxCheckFileAction(g.client.id, form(batch, "a.csv", bcaCsv(1)))).toEqual({ ok: false, error: "Peran Peninjau hanya dapat melihat dan mengunduh laporan." });

    state.userId = (await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] })).userId;
    expect(await actions.inboxPlanAction(other.client.id, batch)).toEqual({ ok: false, error: "Klien tidak ditemukan" });
    expect(await actions.inboxProcessNextAction(other.client.id, batch)).toEqual({ ok: false, error: "Klien tidak ditemukan" });
    expect(await actions.inboxKeyringAction(g.client.id)).toEqual({ ok: false, error: "Hanya admin kantor yang dapat mengubah ini." });
    expect(await actions.clearInboxKeyringAction(g.client.id)).toEqual({ ok: false, error: "Hanya admin kantor yang dapat mengubah ini." });
    expect(await actions.inboxDriveListAction(g.client.id, "https://drive.google.com/drive/folders/abc")).toEqual({ ok: false, error: "Hubungkan Google dulu di Dokumen." });
    expect(await actions.inboxDriveFileAction(g.client.id, batch, "abc")).toEqual({ ok: false, error: "Hubungkan Google dulu di Dokumen." });

    state.userId = (await addMember(g.firm.id, "ADMIN")).userId;
    expect(await actions.inboxKeyringAction(g.client.id)).toEqual({ ok: true, count: 1 });
    expect(await actions.inboxKeyringAction(other.client.id)).toEqual({ ok: true, count: 0 });
    expect(await actions.clearInboxKeyringAction(g.client.id)).toEqual({ ok: true, cleared: 1 });
    expect(await actions.inboxKeyringAction(g.client.id)).toEqual({ ok: true, count: 0 });
  });
});

describe("Unggah: a rekening koran handed over from Dokumen", () => {
  /** A file stored in a Dokumen collection, as an upload leaves it. */
  async function stored(firmId: string, clientId: string | undefined, data: Buffer) {
    const intake = await createIntake(db, firmId, clientId);
    const doc = await db.evidenceDocument.create({ data: { firmId, intakeId: intake.id, sourceKey: randomUUID(), name: "bca-jan.csv", path: "bca-jan.csv", mimeType: "text/csv", status: "READY" } });
    const version = await db.evidenceVersion.create({ data: { firmId, documentId: doc.id, hash: hash(data), data: new Uint8Array(data), name: doc.name, size: data.length, extracted: true } });
    return { intakeId: intake.id, versionId: version.id };
  }

  it("starts a new drop for the client's file, opens Unggah to book it, and never books it twice", async () => {
    const g = await makeGroup();
    const other = await db.$transaction((tx) => createClient(tx, g.firm.id, { name: "Klien Dua", industry: "retail", entities: [{ name: "PT Dua", shortName: "Dua", kind: "PT", banks: [] }] }));
    const file = await stored(g.firm.id, g.client.id, bcaCsv(1));
    const foreign = await stored(g.firm.id, other.client.id, bcaCsv(1));
    const firmWide = await stored(g.firm.id, undefined, bcaCsv(1));

    state.userId = (await addMember(g.firm.id, "VIEWER", { clients: [g.client.id] })).userId;
    expect(await actions.inboxFromDocumentAction(file.intakeId, file.versionId)).toEqual({ ok: false, error: "Peran Peninjau hanya dapat melihat dan mengunduh laporan." });

    state.userId = (await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] })).userId;
    expect(await actions.inboxFromDocumentAction(foreign.intakeId, foreign.versionId)).toEqual({ ok: false, error: "Klien tidak ditemukan" });
    expect(await actions.inboxFromDocumentAction(firmWide.intakeId, firmWide.versionId)).toEqual({ ok: false, error: "Hubungkan kumpulan ini ke klien dulu." });
    // A version of another collection, named with this client's collection.
    expect(await actions.inboxFromDocumentAction(file.intakeId, foreign.versionId)).toEqual({ ok: false, error: "Dokumen tidak ditemukan." });
    expect(await db.uploadItem.count()).toBe(0);

    const handed = await actions.inboxFromDocumentAction(file.intakeId, file.versionId);
    const item = await db.uploadItem.findFirstOrThrow();
    expect(handed).toEqual({ ok: true, href: `/clients/${g.client.id}/import?lanjut=${item.batchId}` });
    const latest = await batchItems(db, { firmId: g.firm.id, clientId: g.client.id });
    expect(latest.items).toMatchObject([{ status: "CHECKED", kind: "BANK", evidenceVersionId: file.versionId }]);

    // The known BCA Giro: Unggah books it without asking.
    const booked = await actions.inboxProcessNextAction(g.client.id, latest.batchId!);
    expect(booked).toMatchObject({ ok: true, item: { status: "BOOKED" }, remaining: 0 });

    // Clicked again from Dokumen: Unggah opens as it is, nothing new to book.
    expect(await actions.inboxFromDocumentAction(file.intakeId, file.versionId)).toEqual({ ok: true, href: `/clients/${g.client.id}/import` });
    expect(await db.uploadItem.count()).toBe(1);
  });
});

describe("Unggah: the latest drop", () => {
  it("is the client's most recent batch, never another client's", async () => {
    const g = await makeGroup();
    const other = await db.$transaction((tx) => createClient(tx, g.firm.id, { name: "Klien Dua", industry: "retail", entities: [{ name: "PT Dua", shortName: "Dua", kind: "PT", banks: [] }] }));
    const row = (clientId: string, batchId: string, fileName: string, at: Date) =>
      db.uploadItem.create({ data: { firmId: g.firm.id, clientId, batchId, fileName, sha256: fileName, kind: "OTHER", status: "KEPT", createdAt: at } });
    await row(g.client.id, "old", "lama.pdf", d(2026, 9, 1));
    await row(g.client.id, "new", "baru.pdf", d(2026, 10, 1));
    await row(other.client.id, "foreign", "lain.pdf", d(2026, 10, 5));
    const scope = { firmId: g.firm.id, clientId: g.client.id };
    expect(await batchItems(db, scope)).toMatchObject({ batchId: "new", items: [{ fileName: "baru.pdf" }] });
    expect(await batchItems(db, { ...scope, batchId: "old" })).toMatchObject({ batchId: "old", items: [{ fileName: "lama.pdf" }] });
    expect(await batchItems(db, { ...scope, batchId: "foreign" })).toEqual({ batchId: "foreign", items: [] });
  });
});
