import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { makePdf, smbcCombinedPdf, table } from "../pdf-fixture";
import { checkFile, type BankSection } from "@/lib/inbox/check";
import { confirmBatch, InboxError, planBatch, skipItems, unlockBatch } from "@/lib/inbox/plan";
import { keyringSize } from "@/lib/inbox/keyring";
import { addBankAccount } from "@/lib/onboarding";
import { toBcaCsv } from "@/lib/demo/writers";
import { createClient } from "@/lib/setup";

const SECRET = "inbox-plan-test-secret-32-characters-long";
beforeEach(async () => {
  vi.stubEnv("SETTINGS_SECRET", SECRET);
  await resetDb();
});
afterEach(() => vi.unstubAllEnvs());

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
const bcaCsv = (month: number, accountNumber: string) =>
  Buffer.from(toBcaCsv({ bank: "BCA", accountNumber, holder: "PT Uji Sejahtera", year: 2026, month, opening: 1_000_000n, rows: [{ date: d(2026, month, 5), description: "SETORAN", amount: 500_000n }] }));

const mandiriPdf = (month: number, password: string) => {
  const mm = String(month).padStart(2, "0");
  return makePdf(
    [
      [
        ...table(800, [[[40, "PT Bank Mandiri (Persero) Tbk"]], [[40, "Nomor Rekening : 2222222222"]], [[40, `Periode : 01/${mm}/2026 - 30/${mm}/2026`]]]),
        ...table(740, [
          [[40, "Tanggal"], [130, "Keterangan"], [360, "Debit"], [440, "Kredit"], [520, "Saldo"]],
          [[40, `01/${mm}/2026`], [130, "SALDO AWAL"], [510, "0,00"]],
          [[40, `04/${mm}/2026`], [130, "TRANSFER DARI PT MITRA UNGGAS"], [430, "20.000.000,00"], [510, "20.000.000,00"]],
        ]),
      ],
    ],
    { userPassword: password },
  );
};

const section = (s: Partial<BankSection>): BankSection => ({ bank: "BNI", number: null, holder: null, currency: "IDR", periodStart: "2026-03-01", periodEnd: "2026-03-31", rows: 3, opening: "1000", closing: "2000", error: null, ...s });

async function setup() {
  const g = await makeGroup();
  const scope = { firmId: g.firm.id, clientId: g.client.id, batchId: "b1" };
  const check = (name: string, data: Buffer, password?: string) => checkFile(db, { ...scope, name, data, password, actorId: "m1" });
  /** A read bank file as the reader would describe it (the holder isn't read from files yet: #143). */
  const fake = (fileName: string, sections: BankSection[]) =>
    db.uploadItem.create({ data: { ...scope, fileName, sha256: fileName, kind: "BANK", status: "CHECKED", sections, periodStart: new Date(sections[0].periodStart), periodEnd: new Date(sections[0].periodEnd) } });
  return { ...g, scope, check, fake, plan: () => planBatch(db, scope) };
}

describe("Unggah plan: rekening from the files", () => {
  it("routes a known number without a question and lists a new number once for two months", async () => {
    const g = await setup();
    const feb = await g.check("baru-feb.csv", bcaCsv(2, "4444555566"));
    const jan = await g.check("baru-jan.csv", bcaCsv(1, "4444555566"));
    const known = await g.check("giro-mar.csv", bcaCsv(3, "1111111111"));
    const ledger = await g.check("catatan.md", Buffer.from("# Catatan\n"));

    const plan = await g.plan();
    expect(plan.known).toEqual([{ itemId: known.id, number: "1111111111", bankAccountId: g.pt.banks[0].id, label: "BCA Giro" }]);
    expect(plan.newAccounts).toEqual([
      { bank: "BCA", display: "BCA ·5566", number: "4444555566", currency: "IDR", holder: null, overdraft: false, itemIds: [jan.id, feb.id], proposed: { entityId: g.pt.entity.id } },
    ]);
    expect(plan.numberless).toEqual([]);
    expect(plan.ready).toBe(false);
    // Oldest period first, the document last.
    expect(plan.items.map((i) => i.fileName)).toEqual(["baru-jan.csv", "baru-feb.csv", "giro-mar.csv", "catatan.md"]);
    // The waiting files say why, also after a reload.
    const rows = await db.uploadItem.findMany({ where: { id: { in: [jan.id, feb.id, known.id, ledger.id] } } });
    const status = Object.fromEntries(rows.map((r) => [r.fileName, [r.status, r.message]]));
    expect(status["baru-jan.csv"]).toEqual(["NEEDS_ACCOUNT", "Rekening BCA ·5566 belum ada di klien ini. Tambahkan lewat kartu rekening baru."]);
    expect(status["giro-mar.csv"]).toEqual(["CHECKED", null]);
    expect(status["catatan.md"][0]).toBe("KEPT");
  });

  it("splits a combined file: one known section, one new, one foreign-currency section listed but blocked", async () => {
    const g = await setup();
    await addBankAccount(db, g.firm.id, g.client.id, g.pt.entity.id, { bank: "SMBC", number: "90022152088", label: "" });
    const item = await g.check("smbc-mei.pdf", smbcCombinedPdf());
    const plan = await g.plan();
    expect(plan.known).toMatchObject([{ itemId: item.id, number: "90022152088" }]);
    expect(plan.newAccounts).toEqual([
      { bank: "SMBC", display: "SMBC ·2879", number: "05243002879", currency: "IDR", holder: null, overdraft: true, itemIds: [item.id], proposed: { entityId: g.pt.entity.id } },
      { bank: "SMBC", display: "SMBC ·4251", number: "90022164251", currency: "JPY", holder: null, overdraft: false, itemIds: [item.id], proposed: null, blocked: "Rekening valas belum bisa dibukukan; file disimpan di Dokumen." },
    ]);
    expect(plan.items[0]).toMatchObject({ status: "NEEDS_ACCOUNT", message: "Rekening SMBC ·2879 belum ada di klien ini. Tambahkan lewat kartu rekening baru." });
  });

  it("proposes the owner from the holder printed on the file", async () => {
    const g = await setup();
    await g.fake("pt.pdf", [section({ number: "5000000001", holder: "UJI SEJAHTERA PT" })]);
    await g.fake("andi.pdf", [section({ number: "5000000002", holder: "ANDI WIJAYA" })]);
    await g.fake("budi.pdf", [section({ number: "5000000003", holder: "BUDI SANTOSO" })]);
    await g.fake("lain.pdf", [section({ number: "5000000004", holder: "PT LAIN SEKALI" })]);
    await g.fake("usd.pdf", [section({ number: "5000000005", holder: "PT LAIN SEKALI", currency: "USD" })]);
    const plan = await g.plan();
    const by = Object.fromEntries(plan.newAccounts.map((a) => [a.number, a]));
    expect(by["5000000001"]).toMatchObject({ proposed: { entityId: g.pt.entity.id } });
    expect(by["5000000001"].warning).toBeUndefined();
    expect(by["5000000002"]).toMatchObject({ proposed: { entityId: g.owner.entity.id } });
    expect(by["5000000003"]).toMatchObject({ proposed: { newOwner: { name: "Budi Santoso" } } });
    expect(by["5000000003"].warning).toBeUndefined();
    expect(by["5000000004"]).toMatchObject({ proposed: { entityId: g.pt.entity.id }, warning: "Nama di file: PT LAIN SEKALI — bukan perusahaan atau pemilik klien ini. Klien yang benar?" });
    expect(by["5000000005"]).toMatchObject({ proposed: null, blocked: "Rekening valas belum bisa dibukukan; file disimpan di Dokumen." });
    // A file whose only section is foreign currency doesn't wait for a rekening.
    expect(plan.items.find((i) => i.fileName === "usd.pdf")?.status).toBe("CHECKED");
    expect(plan.entities.map((e) => e.shortName)).toEqual(["PT Uji", "Andi"]);
  });

  it("asks for the rekening of a file without a readable number, same bank first", async () => {
    const g = await setup();
    const item = await g.fake("bri.pdf", [section({ bank: "BRI", number: null })]);
    const plan = await g.plan();
    expect(plan.numberless).toHaveLength(1);
    expect(plan.numberless[0]).toMatchObject({ itemId: item.id, fileName: "bri.pdf", bank: "BRI" });
    expect(plan.numberless[0].options.map((o) => o.label)).toEqual(["BRI Tabungan", "BCA Giro", "Mandiri Giro"]);
    expect(plan.items[0]).toMatchObject({ status: "NEEDS_ACCOUNT", message: "Nomor rekening tidak terbaca di file. Pilih rekeningnya." });
    expect(plan.ready).toBe(false);
  });

  it("confirms the card: adds owners once and rekening, stores the numberless choice, frees the waiting files", async () => {
    const g = await setup();
    const budi1 = await g.fake("budi-bni.pdf", [section({ bank: "BNI", number: "5000000003", holder: "BUDI SANTOSO" })]);
    const budi2 = await g.fake("budi-bca.pdf", [section({ bank: "BCA", number: "5000000006", holder: "BUDI SANTOSO", opening: "-500", closing: "-100" })]);
    const pt = await g.fake("pt-bni.pdf", [section({ bank: "BNI", number: "5000000001", holder: "UJI SEJAHTERA PT" })]);
    const short = await g.fake("pendek.pdf", [section({ bank: "BNI", number: "12345" })]);
    const usd = await g.fake("usd.pdf", [section({ number: "5000000005", currency: "USD" })]);
    const bri = await g.fake("bri.pdf", [section({ bank: "BRI", number: null })]);
    const briAccount = g.owner.banks[0].id;

    const { plan, errors } = await confirmBatch(db, {
      ...g.scope,
      actorId: "m1",
      accounts: [
        { bank: "BNI", number: "5000000003", target: { newOwner: { name: "Budi Santoso" } } },
        { bank: "BCA", number: "5000000006", target: { newOwner: { name: "BUDI  SANTOSO" } } },
        { bank: "BNI", number: "5000000001", target: { entityId: g.pt.entity.id }, label: "BNI Operasional" },
        { bank: "BNI", number: "12345", target: { entityId: g.pt.entity.id } },
        { bank: "BNI", number: "5000000005", target: { entityId: g.pt.entity.id } },
        { bank: "BNI", number: "9999999999", target: { entityId: g.pt.entity.id } },
      ],
      numberless: [{ itemId: bri.id, bankAccountId: briAccount }],
    });
    expect(errors).toEqual([
      { bank: "BNI", number: "5000000005", error: "Rekening valas belum bisa dibukukan; file disimpan di Dokumen." },
      { bank: "BNI", number: "9999999999", error: "Rekening ini tidak ada di file unggahan ini." },
      { bank: "BNI", number: "12345", error: "Nomor rekening berisi 6–20 angka." },
    ]);
    const owners = await db.entity.findMany({ where: { clientId: g.client.id, kind: "PERORANGAN" }, include: { bankAccounts: { include: { account: true } } }, orderBy: { name: "asc" } });
    expect(owners.map((o) => [o.name, o.shortName])).toEqual([["Andi Wijaya", "Andi"], ["Budi Santoso", "Budi"]]);
    const budi = owners[1];
    expect(budi.bankAccounts.map((b) => [b.bank, b.number, b.label, b.isOverdraft]).sort()).toEqual([["BCA", "5000000006", "BCA PRK ••0006", true], ["BNI", "5000000003", "BNI ••0003", false]]);
    expect(await db.bankAccount.findFirst({ where: { number: "5000000001" } })).toMatchObject({ entityId: g.pt.entity.id, label: "BNI Operasional" });

    const status = Object.fromEntries(plan.items.map((i) => [i.id, i.status]));
    expect([status[budi1.id], status[budi2.id], status[pt.id], status[bri.id], status[usd.id]]).toEqual(["CHECKED", "CHECKED", "CHECKED", "CHECKED", "CHECKED"]);
    expect(status[short.id]).toBe("NEEDS_ACCOUNT");
    expect(plan.known).toContainEqual({ itemId: bri.id, number: null, bankAccountId: briAccount, label: "BRI Tabungan" });
    const stored = await db.uploadItem.findUniqueOrThrow({ where: { id: bri.id } });
    expect((stored.sections as BankSection[])[0].bankAccountId).toBe(briAccount);
    expect(plan.numberless).toEqual([]);
    expect(plan.newAccounts.map((a) => a.number)).toEqual(["12345", "5000000005"]);
    expect(plan.ready).toBe(false);
  });

  it("refuses another client's entity or rekening before writing anything", async () => {
    const g = await setup();
    await g.fake("baru.pdf", [section({ number: "5000000003" })]);
    const bri = await g.fake("bri.pdf", [section({ bank: "BRI", number: null })]);
    const other = await db.$transaction((tx) => createClient(tx, g.firm.id, { name: "Klien Lain", industry: "retail", entities: [{ name: "PT Lain", shortName: "Lain", kind: "PT", banks: [{ bank: "BRI", number: "7777777777", label: "BRI Lain" }] }] }));
    const otherBank = await db.bankAccount.findFirstOrThrow({ where: { number: "7777777777" } });
    await expect(confirmBatch(db, { ...g.scope, accounts: [{ bank: "BNI", number: "5000000003", target: { entityId: other.entities[0].entity.id } }], numberless: [] })).rejects.toThrow(InboxError);
    await expect(confirmBatch(db, { ...g.scope, accounts: [{ bank: "BNI", number: "5000000003", target: { entityId: g.pt.entity.id } }], numberless: [{ itemId: bri.id, bankAccountId: otherBank.id }] })).rejects.toThrow("Rekening tidak ditemukan di klien ini.");
    await expect(confirmBatch(db, { ...g.scope, firmId: "lain", accounts: [], numberless: [] })).rejects.toThrow("Klien tidak ditemukan.");
    expect(await db.bankAccount.count({ where: { number: "5000000003" } })).toBe(0);
  });

  it("skips the files of the wrong client: kept in Dokumen, never booked", async () => {
    const g = await setup();
    const lain = await g.fake("lain.pdf", [section({ number: "5000000004", holder: "PT LAIN SEKALI" })]);
    const plan = await skipItems(db, { ...g.scope, itemIds: [lain.id, "bukan-milik-batch"] });
    expect(plan.items[0]).toMatchObject({ status: "KEPT", message: "Tidak dibukukan; disimpan di Dokumen." });
    expect(plan.newAccounts).toEqual([]);
    expect(plan.ready).toBe(true);
  });

  it("unlocks every locked file of the drop with one password and keeps it for the client", async () => {
    const g = await setup();
    await g.check("mandiri-agu.pdf", mandiriPdf(8, "rahasia"));
    await g.check("mandiri-sep.pdf", mandiriPdf(9, "rahasia"));
    const before = await g.plan();
    expect(before.needsPassword).toHaveLength(2);
    expect(before.ready).toBe(false);

    const wrong = await unlockBatch(db, { ...g.scope, password: "salah", actorId: "m1" });
    expect(wrong.needsPassword).toHaveLength(2);
    expect(wrong.items.map((i) => i.message)).toEqual(["Kata sandi tidak membuka PDF ini. Coba kata sandi lain.", "Kata sandi tidak membuka PDF ini. Coba kata sandi lain."]);
    expect(await keyringSize(db, g.client.id)).toBe(0);

    const opened = await unlockBatch(db, { ...g.scope, password: "rahasia", actorId: "m1" });
    expect(opened.needsPassword).toEqual([]);
    expect(opened.items.map((i) => [i.fileName, i.status])).toEqual([["mandiri-agu.pdf", "CHECKED"], ["mandiri-sep.pdf", "CHECKED"]]);
    expect(opened.known.map((k) => k.number)).toEqual(["2222222222", "2222222222"]);
    expect(opened.ready).toBe(true);
    expect(await keyringSize(db, g.client.id)).toBe(1);
    // Read again from the stored versions: nothing stored twice; no password in what is returned.
    expect(await db.evidenceVersion.count()).toBe(2);
    expect(JSON.stringify([wrong, opened, await db.uploadItem.findMany()])).not.toMatch(/rahasia|salah/);
  });
});
