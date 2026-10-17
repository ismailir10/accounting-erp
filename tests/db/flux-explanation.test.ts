import { beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";
import { postJournal } from "@/lib/ledger/post";
import { dateOnly } from "@/lib/format";
import { MockProvider } from "@/lib/ai/provider";
import { gather } from "@/lib/controls/ai-review";
import { managementSummary } from "@/lib/reports/management";
import { managementWorkbook } from "@/lib/reports/management-pack";
import { deleteClient } from "@/lib/clients/delete";
import { clearFluxExplanation, draftFluxExplanation, fluxExplanations, saveFluxExplanation } from "@/lib/reports/flux-explanation";

// Penjelasan penggerak (Wawasan, accounting-rules 20d): AI drafts from the close review's rows and must cite them, arithmetic checks every
// number, only the accountant's click stores it; it goes stale when the account's movement changes and is offered again next month.
// Server actions through the real guard: only the login token and the provider are faked (no real model, rule 20).
const auth = vi.hoisted(() => ({ userId: null as string | null, provider: null as MockProvider | null }));
vi.mock("@/lib/auth", () => ({ authConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getClaims: async () => ({ data: auth.userId ? { claims: { sub: auth.userId } } : null }) } }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/settings/ai", async (original) => ({ ...(await original<typeof import("@/lib/settings/ai")>()), resolveProvider: async () => auth.provider }));
const { clearFluxExplanationAction, draftFluxExplanationAction, saveFluxExplanationAction } = await import("@/app/actions");

const J = 1_000_000n;
type G = Awaited<ReturnType<typeof makeGroup>>;
let g: G;
const id = async (code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code } } })).id;
const post = async (month: number, day: number, dr: string, cr: string, amount: bigint, memo = `uji ${dr}`) =>
  db.$transaction(async (tx) => postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, month, day), kind: "ADJUSTMENT", memo, lines: [{ accountId: await id(dr), debit: amount }, { accountId: await id(cr), credit: amount }] }));

/** May–Jul usual; August: professional fees 26 jt against 10 jt (flagged), sales a little up (not flagged). */
beforeEach(async () => {
  await resetDb();
  auth.userId = null;
  auth.provider = null;
  g = await makeGroup();
  for (const m of [5, 6, 7]) {
    await post(m, 5, "1130", "4100", 100n * J);
    await post(m, 8, "6170", "1130", 10n * J);
  }
  await post(8, 5, "1130", "4100", 103n * J);
  await post(8, 10, "6170", "2110", 12n * J, "Jasa audit interim");
  await post(8, 11, "6170", "1130", 8n * J, "Konsultan pajak");
  await post(8, 12, "6170", "1130", 6n * J, "Jasa hukum");
});

const k = (month = 8) => ({ clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month });
const mine = (month = 8) => ({ ...k(month), firmId: g.firm.id });
const views = async (month = 8) => fluxExplanations(db, k(month), await managementSummary(db, k(month)));

describe("draft", () => {
  it("sends the close review's rows for the account, cites one, caches the answer and records the budget", async () => {
    const provider = new MockProvider();
    const spy = vi.spyOn(provider, "draftFluxExplanation");
    const d = await draftFluxExplanation(db, { ...mine(), accountCode: "6170", provider });
    expect(d.text).toBe("6170 Beban Jasa Profesional bulan ini Rp 26.000.000; baris terbesar: Jasa audit interim Rp 12.000.000.");
    expect(d.foreign).toEqual([]);
    expect(d.refs).toHaveLength(1);
    expect(d.refs[0]).toMatchObject({ label: expect.stringContaining("Jasa audit interim"), href: `/clients/${g.client.id}/ledger/6170?period=2026-08&entity=${g.pt.entity.id}` });
    // Identical rows to the close review's flux control for this account (series, then the month's lines on it).
    const sent = spy.mock.calls[0][0].rows;
    const review = (await gather(db, g.client.id, 2026, 8)).input.controls.find((c) => c.key === `flux:${g.pt.entity.id}`)!.rows;
    expect(sent).toEqual(review);
    expect(sent.map((r) => r.id.split(":")[0])).toEqual(["akun", "jl", "jl", "jl"]);

    await draftFluxExplanation(db, { ...mine(), accountCode: "6170", provider });
    expect(provider.calls).toBe(1);
    expect(await db.aiUsage.count({ where: { firmId: g.firm.id, note: "Penjelasan penggerak" } })).toBe(1);
    expect(await db.aiReservation.count({ where: { scope: `flux:${g.client.id}:2026-08` } })).toBe(1);
  });

  it("only for a flagged account; a draft citing nothing is not shown; foreign numbers are named", async () => {
    await expect(draftFluxExplanation(db, { ...mine(), accountCode: "4100", provider: new MockProvider() })).rejects.toThrow("Susun dengan AI hanya untuk akun yang melewati ambang.");

    const uncited = new MockProvider({}, "m-uncited");
    uncited.fluxAnswer = JSON.stringify({ text: "Biaya jasa naik karena audit.", refs: ["jl:bukan-baris", "akun:lain:6170"] });
    await expect(draftFluxExplanation(db, { ...mine(), accountCode: "6170", provider: uncited })).rejects.toThrow("AI tidak mengutip baris; tulis sendiri.");

    const inventing = new MockProvider({}, "m-inventing");
    const line = (await gather(db, g.client.id, 2026, 8)).input.controls.find((c) => c.key === `flux:${g.pt.entity.id}`)!.rows[1].id;
    inventing.fluxAnswer = JSON.stringify({ text: "Naik 160 % menjadi sekitar Rp 25 juta karena audit interim Rp 12.000.000.", refs: [line, "jl:asing"] });
    const d = await draftFluxExplanation(db, { ...mine(), accountCode: "6170", provider: inventing });
    expect(d.refs.map((r) => r.id)).toEqual([line]);
    expect(d.foreign).toEqual(["160", "25"]);
    await expect(saveFluxExplanation(db, { ...mine(), accountCode: "6170", text: d.text, source: "AI", refs: [line] })).rejects.toThrow("Penjelasan AI memuat angka yang tidak ada di baris yang dikirim: 160, 25.");
  });
});

describe("approve, stale, next month, remove", () => {
  it("saves with who and when; the pack carries it while the movement holds, then leaves it out and says so", async () => {
    const member = await addMember(g.firm.id, "AKUNTAN", { name: "Rina" });
    const provider = new MockProvider();
    const d = await draftFluxExplanation(db, { ...mine(), accountCode: "6170", provider });
    expect(await saveFluxExplanation(db, { ...mine(), accountCode: "6170", text: d.text, source: "AI", refs: d.refs.map((r) => r.id), actorId: member.id })).toEqual({ foreign: [] });
    const v = (await views()).current.get("6170")!;
    expect(v).toMatchObject({ source: "AI", approvedBy: "Rina", stale: false, text: d.text });
    expect(v.approvedAt).toBeInstanceOf(Date);
    const stored = await db.fluxExplanation.findFirstOrThrow();
    expect(stored.series).toEqual({ baseline: ["2026-05", "2026-06", "2026-07"], values: ["10000000", "10000000", "10000000", "26000000"] });
    expect(stored.refs).toEqual(d.refs.map((r) => r.id));

    const sheet = async () => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await managementWorkbook(db, { ...k(), meta: { firm: "KJA Uji", title: "PT Uji" } })) as unknown as ArrayBuffer);
      return wb.getWorksheet("Perubahan Akun")!;
    };
    let pa = await sheet();
    expect(pa.getSheetValues().flat()).toContain("Penjelasan");
    const row = (ws: ExcelJS.Worksheet, code: string) => { let found: ExcelJS.Row | null = null; ws.eachRow((r) => { if (r.getCell(1).value === code) found = r; }); return found! as ExcelJS.Row; };
    expect(row(pa, "6170").getCell(7).value).toBe(d.text);

    // A reclass moves part of the month off 6170: the explanation no longer matches its movement.
    await post(8, 20, "6190", "6170", 2n * J, "Reklas biaya");
    expect((await views()).current.get("6170")!.stale).toBe(true);
    pa = await sheet();
    expect(row(pa, "6170").getCell(7).value).toBeNull();
    const text = pa.getSheetValues().flat().map(String).join(" | ");
    expect(text).toContain("Penjelasan 6170 tidak dipakai: angka di buku besar berubah setelah disetujui.");
  });

  it("the accountant's own words may hold another number, with a warning; next month offers it; Hapus removes it", async () => {
    // Figures shown on Penggerak (average, difference, %) are not foreign; a target is.
    expect(await saveFluxExplanation(db, { ...mine(), accountCode: "6170", text: "Audit interim Rp 12.000.000 membuat beban naik Rp 16.000.000 (160,0 %) di atas rata-rata Rp 10.000.000; tahun depan dianggarkan Rp 30.000.000.", source: "ACCOUNTANT" })).toEqual({ foreign: ["30.000.000"] });
    await expect(saveFluxExplanation(db, { ...mine(), accountCode: "6130", text: "x", source: "ACCOUNTANT" })).rejects.toThrow("Akun 6130 tidak bergerak di bulan ini atau bulan pembandingnya.");
    await expect(saveFluxExplanation(db, { ...k(), firmId: "kantor-lain", accountCode: "6170", text: "x", source: "ACCOUNTANT" })).rejects.toThrow("Perusahaan tidak ditemukan.");

    await post(9, 10, "6170", "1130", 40n * J);
    const sep = await views(9);
    expect(sep.current.size).toBe(0); // nothing approved for the accountant
    expect(sep.previous.get("6170")).toMatch(/^Audit interim Rp 12\.000\.000/);

    await clearFluxExplanation(db, { ...mine(), accountCode: "6170" });
    expect((await views()).current.size).toBe(0);
    expect(await db.auditEvent.count({ where: { kind: "REPORT_COMMENT" } })).toBe(2);
  });

  it("deleting the client removes its explanations and its draft cache", async () => {
    await draftFluxExplanation(db, { ...mine(), accountCode: "6170", provider: new MockProvider() });
    await saveFluxExplanation(db, { ...mine(), accountCode: "6170", text: "Audit interim.", source: "ACCOUNTANT" });
    await deleteClient(db, { firmId: g.firm.id, clientId: g.client.id, confirmName: "Grup Uji" });
    expect(await db.fluxExplanation.count()).toBe(0);
    expect(await db.evidenceAiCache.count({ where: { scope: { startsWith: "flux:" } } })).toBe(0);
  });
});

describe("actions", () => {
  it("a viewer is refused every write; an akuntan drafts, approves and removes", async () => {
    auth.provider = new MockProvider();
    const input = { ...k(), accountCode: "6170" };
    auth.userId = (await addMember(g.firm.id, "VIEWER", { clients: [g.client.id] })).userId;
    const refused = { ok: false, error: "Peran Peninjau hanya dapat melihat dan mengunduh laporan." };
    expect(await draftFluxExplanationAction(input)).toEqual(refused);
    expect(await saveFluxExplanationAction({ ...input, text: "Audit interim.", source: "ACCOUNTANT", refs: [] })).toEqual(refused);
    expect(await clearFluxExplanationAction(input)).toEqual(refused);
    expect(await db.fluxExplanation.count()).toBe(0);
    expect(auth.provider.calls).toBe(0);

    auth.userId = (await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] })).userId;
    const d = await draftFluxExplanationAction(input);
    if (!d.ok) throw new Error(d.error);
    expect(await saveFluxExplanationAction({ ...input, text: d.draft.text, source: "AI", refs: d.draft.refs.map((r) => r.id) })).toEqual({ ok: true, foreign: [] });
    expect(await db.fluxExplanation.count()).toBe(1);
    expect(await clearFluxExplanationAction(input)).toEqual({ ok: true });
    expect(await db.fluxExplanation.count()).toBe(0);

    auth.provider = null;
    expect(await draftFluxExplanationAction(input)).toEqual({ ok: false, error: "AI belum diatur di Pengaturan. Tulis penjelasannya sendiri." });
  });
});
