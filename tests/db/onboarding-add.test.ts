import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addBankAccount, addEntity, OnboardingError } from "@/lib/onboarding";

const bank = (number: string, extra: Partial<{ bank: "BCA" | "MANDIRI" | "BRI" | "SMBC" | "GENERIC"; label: string; isOverdraft: boolean }> = {}) => ({ bank: "BCA" as const, number, label: "", isOverdraft: false, ...extra });
const owner = (banks: ReturnType<typeof bank>[] = []) => ({ name: "Budi Santoso", shortName: "Budi", kind: "PERORANGAN" as const, npwp: "", banks });
const fieldsOf = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as OnboardingError;

describe("adding to an existing client", () => {
  beforeEach(resetDb);

  it("adds a bank account to an entity on the next free GL code, PRK on 22xx, in that entity's books", async () => {
    const g = await makeGroup(); // 1101 BCA, 1102 Mandiri (PT), 1103 BRI (owner)
    const added = await addBankAccount(db, g.firm.id, g.client.id, g.pt.entity.id, bank("5550001234", { label: "BCA Tabungan" }));
    expect(await db.account.findUniqueOrThrow({ where: { id: added.accountId } })).toMatchObject({ code: "1104", name: "BCA Tabungan (PT Uji)", type: "ASET", isBank: true, clientId: g.client.id });
    const prk = await addBankAccount(db, g.firm.id, g.client.id, g.owner.entity.id, bank("6660001234", { bank: "MANDIRI", isOverdraft: true }));
    expect(await db.account.findUniqueOrThrow({ where: { id: prk.accountId } })).toMatchObject({ code: "2201", type: "LIABILITAS", fsLine: "UTANG_BANK" });
    expect(added).toMatchObject({ entityId: g.pt.entity.id, number: "5550001234", label: "BCA Tabungan", isOverdraft: false });
  });

  it("checks the account like the new-client form and says what to fix", async () => {
    const g = await makeGroup();
    expect((await fieldsOf(addBankAccount(db, g.firm.id, g.client.id, g.pt.entity.id, bank("12")))).fields).toEqual({ "bank.number": "Nomor rekening berisi 6–20 angka." });
    expect((await fieldsOf(addBankAccount(db, g.firm.id, g.client.id, g.pt.entity.id, bank("")))).fields).toEqual({ "bank.number": "Isi nomor rekening." });
    // A number already on any account of the client (here: the owner's BRI) can't be added again.
    expect((await fieldsOf(addBankAccount(db, g.firm.id, g.client.id, g.pt.entity.id, bank("3333333333")))).fields).toEqual({ "bank.number": "Nomor ini sudah dipakai rekening lain di klien ini." });
    expect(await db.bankAccount.count()).toBe(3);
  });

  it("stops at nine bank accounts per client and reuses no code", async () => {
    const g = await makeGroup();
    for (let i = 0; i < 6; i++) await addBankAccount(db, g.firm.id, g.client.id, g.pt.entity.id, bank(`77000000${i}0`));
    expect((await db.account.findMany({ where: { clientId: g.client.id, isBank: true } })).length).toBe(9);
    await expect(addBankAccount(db, g.firm.id, g.client.id, g.pt.entity.id, bank("8800000000"))).rejects.toThrow("Maksimal 9 rekening bank per klien.");
    expect(await db.bankAccount.count()).toBe(9);
    expect(await db.account.count({ where: { clientId: g.client.id, code: "1101" } })).toBe(1);
  });

  it("adds an owner (or company) with an optional first account; the client keeps one COA", async () => {
    const g = await makeGroup();
    const before = await db.account.count({ where: { clientId: g.client.id } });
    const e = await addEntity(db, g.firm.id, g.client.id, owner([bank("9990001234", { bank: "SMBC", label: "Jenius Budi" })]));
    expect(e).toMatchObject({ clientId: g.client.id, kind: "PERORANGAN", shortName: "Budi", functionalCurrency: "IDR", reportingFramework: "SAK_EMKM" }); // a person's own books default to SAK EMKM; the group still reports on its highest framework
    const acct = await db.bankAccount.findFirstOrThrow({ where: { entityId: e.id }, include: { account: true } });
    expect(acct.account).toMatchObject({ code: "1104", name: "Jenius Budi (Budi)" });
    // Its bank account, and — the client's third company — an intercompany account per company (Antar entitas per pihak).
    expect(await db.account.count({ where: { clientId: g.client.id } })).toBe(before + 1 + 3);
    const noBank = await addEntity(db, g.firm.id, g.client.id, { ...owner(), name: "PT Baru Sejahtera", shortName: "", kind: "PT" });
    expect(noBank.shortName).toBe("PT Baru Sejahtera");
    expect(await db.bankAccount.count({ where: { entityId: noBank.id } })).toBe(0);
  });

  it("rejects an entity without a name, with keys the form can mark", async () => {
    const g = await makeGroup();
    expect((await fieldsOf(addEntity(db, g.firm.id, g.client.id, { ...owner(), name: " " }))).fields).toEqual({ "entity.name": "Isi nama pemilik." });
    expect(await db.entity.count({ where: { clientId: g.client.id } })).toBe(2);
  });

  it("never touches another firm's client or entity", async () => {
    const g = await makeGroup(), other = await makeGroup();
    expect((await fieldsOf(addEntity(db, g.firm.id, other.client.id, owner()))).fields).toEqual({ entity: "Klien tidak ditemukan." });
    expect((await fieldsOf(addBankAccount(db, g.firm.id, g.client.id, other.pt.entity.id, bank("5550001234")))).fields).toEqual({ entityId: "Perusahaan tidak ditemukan di klien ini." });
    expect((await fieldsOf(addBankAccount(db, other.firm.id, g.client.id, g.pt.entity.id, bank("5550001234")))).fields).toEqual({ entityId: "Perusahaan tidak ditemukan di klien ini." });
    expect(await db.entity.count({ where: { clientId: other.client.id } })).toBe(2);
  });
});
