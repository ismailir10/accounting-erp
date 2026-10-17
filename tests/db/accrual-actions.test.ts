import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "../helpers";
import { addMember } from "../members";
import { accrualProposals } from "@/lib/adjust/accruals";
import { NOW, qaBooks, TELKOM } from "../accrual-books";

// Usulan akrual through the real server actions and guard (ADR 0017 §5): only the login token is faked.
const auth = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({ authConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getClaims: async () => ({ data: auth.userId ? { claims: { sub: auth.userId } } : null }) } }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const { dismissAccrualAction, postAccrualAction, reasoningAction } = await import("@/app/actions");

beforeEach(async () => { await resetDb(); auth.userId = null; });
const VIEWER_REFUSAL = { ok: false, error: "Peran Peninjau hanya dapat melihat dan mengunduh laporan." };
const signIn = (m: { userId: string }) => { auth.userId = m.userId; };

describe("accrual actions through the guard", () => {
  it("a Peninjau reads Lihat alasan but a crafted Setujui or Tolak is refused; an Akuntan's refused field comes back by name", async () => {
    const { g } = await qaBooks();
    const viewer = await addMember(g.firm.id, "VIEWER", { name: "Vina", clients: [g.client.id] });
    const rina = await addMember(g.firm.id, "AKUNTAN", { name: "Rina", clients: [g.client.id] });
    const outsider = await addMember(g.firm.id, "AKUNTAN", { name: "Tono" });
    const [telkom] = await accrualProposals(db, g.client.id, 2026, 8, { now: NOW });
    expect(telkom.counterparty).toBe(TELKOM);

    signIn(viewer);
    expect(await postAccrualAction(g.client.id, telkom.key)).toEqual(VIEWER_REFUSAL);
    expect(await dismissAccrualAction(g.client.id, telkom.key)).toEqual(VIEWER_REFUSAL);
    const panel = await reasoningAction(g.client.id, telkom.key);
    expect(panel.ok && panel.steps.map((s) => s.label)).toEqual(["Riwayat dibaca", "Aturan", "Bulan ini", "Nominal", "Belum dicatat"]);
    // An Akuntan not assigned to the client reaches nothing.
    signIn(outsider);
    expect((await postAccrualAction(g.client.id, telkom.key)).ok).toBe(false);
    expect(await db.journalEntry.count({ where: { kind: "ADJUSTMENT" } })).toBe(0);

    signIn(rina);
    expect(await postAccrualAction(g.client.id, telkom.key, { amount: "0" })).toEqual({ ok: false, error: "Nominal harus lebih dari nol.", fields: { amount: "Nominal harus lebih dari nol." } });
    expect(await postAccrualAction(g.client.id, telkom.key, { creditCode: "6120" })).toMatchObject({ ok: false, fields: { credit: "Akun kredit harus akun liabilitas, bukan bank, kliring (1190/1199) atau 1999." } });
    expect(await postAccrualAction(g.client.id, telkom.key, { amount: "450.000" })).toEqual({ ok: true });
    expect(await dismissAccrualAction(g.client.id, telkom.key)).toEqual({ ok: false, error: "Usulan akrual ini sudah diputuskan." });
    expect(await db.proposedEntry.findUniqueOrThrow({ where: { key: telkom.key } })).toMatchObject({ status: "POSTED", decidedById: rina.id });
  });
});
