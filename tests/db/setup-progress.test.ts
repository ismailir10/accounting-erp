import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { postOpening } from "@/lib/opening";
import { createClient } from "@/lib/setup";
import { setupProgress } from "@/lib/setup-progress";
import { dateOnly } from "@/lib/format";

type G = Awaited<ReturnType<typeof makeGroup>>;

async function statement(g: G, status: "NEEDS_REVIEW" | "POSTED" = "POSTED") {
  const bank = await db.bankAccount.findFirstOrThrow({ where: { entityId: g.pt.entity.id } });
  const imp = await db.statementImport.create({ data: { firmId: g.firm.id, bankAccountId: bank.id, fileName: "bca.csv", format: "BCA", periodStart: dateOnly(2026, 8, 1), periodEnd: dateOnly(2026, 8, 31), openingBalance: 100n, closingBalance: 100n, rowCount: 1, continuityOk: true } });
  await db.bankTransaction.create({ data: { firmId: g.firm.id, importId: imp.id, bankAccountId: bank.id, entityId: g.pt.entity.id, date: dateOnly(2026, 8, 5), description: "BIAYA", merchantKey: "BIAYA", direction: "OUT", amount: 10n, rowNumber: 1, rawRow: "x", hash: "h1", status, method: "RULE", confidence: 0.9, reason: "aturan" } });
}
const opening = (g: G, entity: { id: string }) => postOpening(db, { clientId: g.client.id, entityId: entity.id, date: dateOnly(2026, 7, 31), lines: [{ accountCode: "1110", debit: "100", credit: "0" }] });
const keys = (p: Awaited<ReturnType<typeof setupProgress>>) => p.steps.map((s) => `${s.key}:${s.state}`).join(" ");

describe("setupProgress", () => {
  beforeEach(resetDb);

  it("a new client starts with the upload, then Saldo Awal only after a statement exists", async () => {
    const g = await makeGroup();
    const p = await setupProgress(db, g.client.id, { period: { year: 2026, month: 8 } });
    expect(keys(p)).toBe("import:current opening:todo review:todo close:todo");
    expect(p.current).toBe("import");
    expect(p.next).toMatchObject({ href: `/clients/${g.client.id}/import`, cta: "Unggah rekening koran" });
    expect(p.needsOpening).toEqual([]);
  });

  it("after the upload it asks for Saldo Awal only for entities whose statement is in, PT before the owner, then moves on", async () => {
    const g = await makeGroup();
    await statement(g, "NEEDS_REVIEW");
    let p = await setupProgress(db, g.client.id);
    expect(p.current).toBe("opening");
    // The owner's statement isn't uploaded yet: nothing to prefill, so not asked (the bank control names the gap).
    expect(p.needsOpening.map((e) => e.shortName)).toEqual(["PT Uji"]);
    const ownerBank = await db.bankAccount.findFirstOrThrow({ where: { entityId: g.owner.entity.id } });
    await db.statementImport.create({ data: { firmId: g.firm.id, bankAccountId: ownerBank.id, fileName: "bri.csv", format: "BRI", periodStart: dateOnly(2026, 8, 1), periodEnd: dateOnly(2026, 8, 31), openingBalance: 1n, closingBalance: 1n, rowCount: 0, continuityOk: true } });
    p = await setupProgress(db, g.client.id);
    expect(p.needsOpening.map((e) => e.shortName)).toEqual(["PT Uji", "Andi"]);
    expect(p.next).toMatchObject({ href: `/clients/${g.client.id}/opening`, cta: "Isi saldo awal" });
    await opening(g, g.pt.entity);
    await opening(g, g.owner.entity);
    p = await setupProgress(db, g.client.id);
    expect(p.needsOpening).toEqual([]);
    expect(p.current).toBe("review");
    expect(p.next?.text).toMatch(/^1 transaksi perlu dicek/);
  });

  it("goes to the close once nothing waits for review, and is done when the period is locked", async () => {
    const g = await makeGroup();
    await statement(g);
    await opening(g, g.pt.entity);
    let p = await setupProgress(db, g.client.id, { period: { year: 2026, month: 8 } });
    expect(keys(p)).toBe("import:done opening:done review:done close:current");
    expect(p.next).toMatchObject({ cta: "Tutup buku" });
    await db.period.create({ data: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 8, status: "LOCKED" } });
    p = await setupProgress(db, g.client.id, { period: { year: 2026, month: 8 } });
    expect(p.current).toBeNull();
    expect(p.next).toBeNull();
  });

  it("a missing statement of a later month points back to the upload, after Saldo Awal", async () => {
    const g = await makeGroup();
    await statement(g);
    await opening(g, g.pt.entity);
    const p = await setupProgress(db, g.client.id, { period: { year: 2026, month: 9 }, missingStatements: ["Rekonsiliasi Mandiri Giro"] });
    expect(p.current).toBe("import");
    expect(p.next?.text).toBe("Mutasi Mandiri Giro untuk September 2026 belum diimpor.");
  });

  it("an owner without a bank account never needs a Saldo Awal", async () => {
    const firm = await db.$transaction(async (tx) => {
      const f = await tx.firm.create({ data: { name: "KJA Uji" } });
      const { client } = await createClient(tx, f.id, {
        name: "Klien Uji", industry: "jasa",
        entities: [
          { name: "PT Solo", shortName: "PT Solo", kind: "PT", banks: [{ bank: "BCA", number: "1", label: "BCA" }] },
          { name: "Budi", shortName: "Budi", kind: "PERORANGAN", banks: [] },
        ],
        rules: [],
      });
      return { f, client };
    });
    const bank = await db.bankAccount.findFirstOrThrow({ where: { entity: { clientId: firm.client.id } } });
    await db.statementImport.create({ data: { firmId: firm.f.id, bankAccountId: bank.id, fileName: "a.csv", format: "BCA", periodStart: dateOnly(2026, 8, 1), periodEnd: dateOnly(2026, 8, 31), openingBalance: 1n, closingBalance: 1n, rowCount: 0, continuityOk: true } });
    let p = await setupProgress(db, firm.client.id);
    expect(p.needsOpening.map((e) => e.shortName)).toEqual(["PT Solo"]);
    const pt = await db.entity.findFirstOrThrow({ where: { clientId: firm.client.id, kind: "PT" } });
    await postOpening(db, { clientId: firm.client.id, entityId: pt.id, date: dateOnly(2026, 7, 31), lines: [{ accountCode: "1110", debit: "1", credit: "0" }] });
    p = await setupProgress(db, firm.client.id);
    expect(p.needsOpening).toEqual([]);
    expect(p.current).toBe("close");
  });

  it("a client with no bank accounts starts with Unggah (rekening come from the files) and continues a draft", async () => {
    const g = await db.$transaction(async (tx) => {
      const f = await tx.firm.create({ data: { name: "KJA Uji" } });
      const { client } = await createClient(tx, f.id, { name: "Klien Buku", industry: "jasa", entities: [{ name: "PT Buku", shortName: "PT Buku", kind: "PT", banks: [] }], rules: [] });
      return { f, client };
    });
    const p = await setupProgress(db, g.client.id);
    expect(p.hasBanks).toBe(false);
    expect(p.next).toMatchObject({ text: "Unggah rekening koran atau file pembukuan klien. Rekening baru ditambahkan dari file.", href: `/clients/${g.client.id}/import`, cta: "Unggah" });
    const draft = await db.ledgerImport.create({ data: { firmId: g.f.id, clientId: g.client.id, fileName: "neraca.xlsx", fileHash: "h", sheetName: "Neraca", mode: "NERACA", periodStart: dateOnly(2026, 7, 31), periodEnd: dateOnly(2026, 7, 31), rowCount: 3, data: {} } });
    expect((await setupProgress(db, g.client.id)).next).toMatchObject({ href: `/clients/${g.client.id}/import/ledger/${draft.id}`, cta: "Lanjutkan impor" });
    await db.ledgerImport.update({ where: { id: draft.id }, data: { status: "POSTED" } });
    const p2 = await setupProgress(db, g.client.id);
    expect(p2.steps.find((s) => s.key === "import")?.state).toBe("done");
    expect(p2.needsOpening).toEqual([]);
  });
});
