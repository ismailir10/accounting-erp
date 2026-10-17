import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";
import { createFirm } from "@/lib/setup";
import { checklistMonth } from "@/lib/checklist/view";

// Checklist tutup buku through the real server actions and guard (ADR 0017 §5): only the login token is faked.
const auth = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({ authConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getClaims: async () => ({ data: auth.userId ? { claims: { sub: auth.userId } } : null }) } }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const { acceptChecklistAction, addChecklistTaskAction, markChecklistAction, removeChecklistTaskAction, signoffAction, updateChecklistTaskAction } = await import("@/app/actions");

beforeEach(async () => { await resetDb(); auth.userId = null; });

const ADMIN_ONLY = { ok: false, error: "Hanya admin kantor yang dapat mengatur checklist." };
const VIEWER_REFUSAL = { ok: false, error: "Peran Peninjau hanya dapat melihat dan mengunduh laporan." };

async function team() {
  const g = await makeGroup();
  const admin = await addMember(g.firm.id, "ADMIN", { name: "Budi" });
  const rina = await addMember(g.firm.id, "AKUNTAN", { name: "Rina", clients: [g.client.id] });
  const sari = await addMember(g.firm.id, "AKUNTAN", { name: "Sari", clients: [g.client.id] });
  const viewer = await addMember(g.firm.id, "VIEWER", { name: "Vina", clients: [g.client.id] });
  const outsider = await addMember(g.firm.id, "AKUNTAN", { name: "Tono" });
  return { g, admin, rina, sari, viewer, outsider };
}
const signIn = (m: { userId: string }) => { auth.userId = m.userId; };
const rows = async (clientId: string) => (await checklistMonth(db, { clientId, year: 2026, month: 8 })).rows;

describe("checklist actions through the guard", () => {
  it("setting up is admin work; an AKUNTAN and a viewer are refused verbatim", async () => {
    const { g, admin, rina, viewer } = await team();
    signIn(rina);
    expect(await acceptChecklistAction(g.client.id, 2026, 8, rina.id, null)).toEqual(ADMIN_ONLY);
    signIn(viewer);
    expect(await acceptChecklistAction(g.client.id, 2026, 8, rina.id, null)).toEqual(ADMIN_ONLY);
    signIn(admin);
    expect(await acceptChecklistAction(g.client.id, 2026, 8, rina.id, admin.id)).toEqual({ ok: true, count: 9 });
    const docs = (await rows(g.client.id)).find((r) => r.key === "docs")!;

    signIn(rina);
    expect(await updateChecklistTaskAction(g.client.id, 2026, 8, docs.id, { title: "x", assigneeId: rina.id, reviewerId: null, dueDay: 5 })).toEqual(ADMIN_ONLY);
    expect(await removeChecklistTaskAction(g.client.id, 2026, 8, docs.id)).toEqual(ADMIN_ONLY);
    expect(await addChecklistTaskAction(g.client.id, 2026, 8, { kind: "AUTO", key: "tax", assigneeId: rina.id, reviewerId: null, dueDay: 10 })).toEqual(ADMIN_ONLY);
    // A Manual task of her own is a write any AKUNTAN on the client may make.
    expect(await addChecklistTaskAction(g.client.id, 2026, 8, { kind: "MANUAL", title: "Minta faktur", assigneeId: rina.id, reviewerId: admin.id, dueDay: 7 })).toEqual({ ok: true });

    signIn(viewer);
    expect(await addChecklistTaskAction(g.client.id, 2026, 8, { kind: "MANUAL", title: "Saya", assigneeId: viewer.id, reviewerId: null, dueDay: 7 })).toEqual(VIEWER_REFUSAL);
    expect(await markChecklistAction(g.client.id, 2026, 8, docs.id, "done", true)).toEqual(VIEWER_REFUSAL);

    signIn(admin);
    expect(await updateChecklistTaskAction(g.client.id, 2026, 8, docs.id, { title: docs.title, assigneeId: rina.id, reviewerId: viewer.id, dueDay: 10 })).toEqual({ ok: false, error: "Vina berperan Peninjau (hanya melihat), jadi tidak dapat menjadi Pereviu." });
    expect(await updateChecklistTaskAction(g.client.id, 2026, 8, docs.id, { title: docs.title, assigneeId: rina.id, reviewerId: admin.id, dueDay: 11 })).toEqual({ ok: true });
    // What a browser can send is not trusted: an unknown kind or month is refused in Bahasa, not as a database error.
    expect(await addChecklistTaskAction(g.client.id, 2026, 8, { kind: "SIGNOFF", title: "x", assigneeId: rina.id, reviewerId: null, dueDay: 5 } as never)).toEqual({ ok: false, error: "Jenis tugas tidak dikenal." });
    expect(await markChecklistAction(g.client.id, 2026, 13, docs.id, "done", true)).toEqual({ ok: false, error: "Periode tidak valid. Muat ulang halaman." });
  });

  it("ticks and reviews follow the task's rules, from the checklist and from Tutup Buku alike", async () => {
    const { g, admin, rina, sari } = await team();
    signIn(admin);
    await acceptChecklistAction(g.client.id, 2026, 8, rina.id, admin.id);
    const docs = (await rows(g.client.id)).find((r) => r.key === "docs")!;

    signIn(sari);
    expect(await markChecklistAction(g.client.id, 2026, 8, docs.id, "done", true)).toEqual({ ok: false, error: "Hanya Pelaksana tugas ini atau admin kantor yang dapat mengubah status selesainya." });
    expect(await signoffAction(g.client.id, 2026, 8, "docs", true)).toEqual({ ok: false, error: "Hanya Pelaksana tugas ini atau admin kantor yang dapat mengubah status selesainya." });
    signIn(rina);
    expect(await signoffAction(g.client.id, 2026, 8, "docs", true)).toEqual({ ok: true });
    expect((await rows(g.client.id)).find((r) => r.key === "docs")).toMatchObject({ status: "SELESAI", done: { by: "Rina" } });
    expect(await markChecklistAction(g.client.id, 2026, 8, docs.id, "review", true)).toEqual({ ok: false, error: "Anda yang menandai tugas ini selesai, jadi tidak dapat mereviunya sendiri." });
    signIn(admin);
    expect(await markChecklistAction(g.client.id, 2026, 8, docs.id, "review", true)).toEqual({ ok: true });
    expect((await rows(g.client.id)).find((r) => r.key === "docs")).toMatchObject({ status: "DIREVIU", review: { by: "Budi" } });
    signIn(rina);
    expect(await signoffAction(g.client.id, 2026, 8, "docs", false)).toEqual({ ok: false, error: "Tugas ini sudah direviu. Batalkan reviunya dulu sebelum membatalkan selesai." });
  });

  it("an unassigned AKUNTAN and another organisation see the client as missing; a read-only organisation writes nothing", async () => {
    const { g, admin, rina, outsider } = await team();
    signIn(admin);
    await acceptChecklistAction(g.client.id, 2026, 8, rina.id, null);
    const docs = (await rows(g.client.id)).find((r) => r.key === "docs")!;
    signIn(outsider);
    expect(await markChecklistAction(g.client.id, 2026, 8, docs.id, "done", true)).toEqual({ ok: false, error: "Klien tidak ditemukan" });
    const foreign = await db.$transaction((tx) => createFirm(tx, "KAP Lain"));
    signIn(await addMember(foreign.id, "OWNER", { name: "Bos lain" }));
    expect(await acceptChecklistAction(g.client.id, 2026, 8, rina.id, null)).toEqual({ ok: false, error: "Klien tidak ditemukan" });
    expect(await markChecklistAction(g.client.id, 2026, 8, docs.id, "done", true)).toEqual({ ok: false, error: "Klien tidak ditemukan" });

    await db.accessGrant.deleteMany({ where: { firmId: g.firm.id } });
    await db.accessGrant.create({ data: { firmId: g.firm.id, kind: "TRIAL", startsAt: new Date("2026-09-01T00:00:00Z"), endsAt: new Date("2026-09-15T16:59:59.999Z") } });
    signIn(rina);
    expect(await markChecklistAction(g.client.id, 2026, 8, docs.id, "done", true)).toMatchObject({ ok: false, error: expect.stringMatching(/^Masa uji coba berakhir/) });
    expect(await db.closeSignoff.count()).toBe(0);
  });
});
