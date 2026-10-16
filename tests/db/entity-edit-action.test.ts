import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";
import { postOpening } from "@/lib/opening";
import { dateOnly } from "@/lib/format";

const auth = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({ authConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getClaims: async () => ({ data: auth.userId ? { claims: { sub: auth.userId } } : null }) } }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const { renameEntityAction, updateBankAccountAction, removeBankAccountAction, removeEntityAction } = await import("@/app/actions");

const ADMIN_ONLY = { ok: false, error: "Hanya admin kantor yang dapat menghapus perusahaan atau rekening." };

describe("Perusahaan & rekening actions", () => {
  beforeEach(resetDb);

  it("an akuntan fixes names and numbers, cannot remove; a viewer can do neither — and nothing is removed", async () => {
    const g = await makeGroup();
    const akuntan = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    auth.userId = akuntan.userId;
    expect(await renameEntityAction(g.client.id, g.pt.entity.id, { name: "PT Nama Baru", shortName: "PT Baru", npwp: "" })).toEqual({ ok: true });
    expect(await updateBankAccountAction(g.client.id, g.pt.banks[1].id, { label: "Mandiri Baru", bank: "MANDIRI", number: "2222222222" })).toEqual({ ok: true });
    expect((await db.entity.findUniqueOrThrow({ where: { id: g.pt.entity.id } })).shortName).toBe("PT Baru");
    // Riwayat names who did it.
    expect((await db.auditEvent.findMany({ where: { kind: "COMPANY_BANK" } })).map((e) => e.actorId)).toEqual([akuntan.id, akuntan.id]);
    expect(await removeBankAccountAction(g.client.id, g.pt.banks[1].id)).toEqual(ADMIN_ONLY);
    expect(await removeEntityAction(g.client.id, g.owner.entity.id)).toEqual(ADMIN_ONLY);

    auth.userId = (await addMember(g.firm.id, "VIEWER", { clients: [g.client.id] })).userId;
    expect(await renameEntityAction(g.client.id, g.pt.entity.id, { name: "PT Peninjau", shortName: "PT P", npwp: "" })).toMatchObject({ ok: false });
    expect(await removeEntityAction(g.client.id, g.owner.entity.id)).toEqual(ADMIN_ONLY);
    expect((await db.entity.findUniqueOrThrow({ where: { id: g.pt.entity.id } })).name).toBe("PT Nama Baru");
    expect([await db.bankAccount.count(), await db.entity.count()]).toEqual([3, 2]);
  });

  it("an admin removes what is empty and is told why when something has books", async () => {
    const g = await makeGroup();
    auth.userId = (await addMember(g.firm.id, "ADMIN")).userId;
    await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 7, 31), lines: [{ accountCode: "1101", debit: "1000000", credit: "0" }, { accountCode: "3100", debit: "0", credit: "1000000" }] });
    expect(await removeBankAccountAction(g.client.id, g.pt.banks[0].id)).toEqual({ ok: false, error: "Sudah ada 1 baris jurnal. Rekening yang sudah dipakai tidak bisa dihapus." });
    expect(await removeEntityAction(g.client.id, g.pt.entity.id)).toMatchObject({ ok: false, error: expect.stringMatching(/^Sudah ada 1 jurnal \(termasuk saldo awal\)\./) });
    expect(await removeBankAccountAction(g.client.id, g.pt.banks[1].id)).toEqual({ ok: true });
    expect(await removeEntityAction(g.client.id, g.owner.entity.id)).toEqual({ ok: true });
    expect([await db.bankAccount.count(), await db.entity.count()]).toEqual([1, 1]);
    // The last one stays.
    expect(await removeEntityAction(g.client.id, g.pt.entity.id)).toMatchObject({ ok: false, error: expect.stringMatching(/^Klien harus punya minimal satu/) });
  });

  it("returns the field messages for a bad rename and refuses another organisation's client", async () => {
    const g = await makeGroup(), other = await makeGroup();
    auth.userId = (await addMember(g.firm.id, "ADMIN")).userId;
    expect(await renameEntityAction(g.client.id, g.pt.entity.id, { name: "", shortName: "", npwp: "1" })).toMatchObject({ ok: false, error: "Periksa 2 isian yang ditandai.", fields: { name: "Isi nama badan usaha.", npwp: expect.any(String) } });
    expect(await renameEntityAction(other.client.id, other.pt.entity.id, { name: "Diambil", shortName: "X", npwp: "" })).toMatchObject({ ok: false });
    expect(await updateBankAccountAction(other.client.id, other.pt.banks[1].id, { label: "Diambil", bank: "BCA", number: "2222222222" })).toMatchObject({ ok: false });
    expect(await removeBankAccountAction(other.client.id, other.pt.banks[1].id)).toMatchObject({ ok: false });
    expect(await removeEntityAction(other.client.id, other.owner.entity.id)).toMatchObject({ ok: false });
    // Our client, their entity: the domain's tenant check.
    expect(await removeEntityAction(g.client.id, other.owner.entity.id)).toEqual({ ok: false, error: "Perusahaan tidak ditemukan di klien ini." });
    expect((await db.entity.findUniqueOrThrow({ where: { id: other.pt.entity.id } })).name).toBe("PT Uji Sejahtera");
    expect(await db.bankAccount.count({ where: { entity: { clientId: other.client.id } } })).toBe(3);
  });
});
