import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction } from "@/lib/review";
import { setWithholdingSlip, type SlipInput } from "@/lib/tax/withholding-slip";
import { removeStatementImport } from "@/lib/imports/remove";
import { deleteClient } from "@/lib/clients/delete";
import { addMember } from "../members";

// Bukti potong detail (cycle 2026-10-17-bppu-files, T1): stored per withheld payment, validated, scoped to the client, audited, never
// posted, allowed in a locked month, and gone with its bank line.
type G = Awaited<ReturnType<typeof makeGroup>>;
let g: G;
let importId: string;
const CSV = [
  "Tanggal;Keterangan;Debet;Kredit;Saldo",
  "01/08/2026;SALDO AWAL;;;500000000",
  "21/08/2026;JASA KONSULTAN HARAPAN;9800000;0;490200000",
  "25/08/2026;SEWA RUKO HJ ROSMIATI;9000000;0;481200000",
  "26/08/2026;BIAYA ADMIN;5000;0;481195000",
  "27/08/2026;TRSF CR PT BANK DIGITAL NUSA;0;9800000;490995000",
  "",
].join("\n");
const line = (text: string) => db.bankTransaction.findFirstOrThrow({ where: { description: { contains: text } } });
const slip = async (text: string, over: Partial<SlipInput> = {}) =>
  setWithholdingSlip(db, { clientId: g.client.id, bankTransactionId: (await line(text)).id, kop: "24-104-03", dpp: "10.000.000", documentType: "CommercialInvoice", documentNumber: "INV-77", documentDate: "2026-08-15", ...over });

beforeEach(async () => {
  await resetDb();
  g = await makeGroup();
  importId = (await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca-agu.csv", data: Buffer.from(CSV), provider: null })).importId!;
  const review = async (text: string, accountCode: string, kind: "PPH_23" | "PPH_4_2" | null, amount = 0n) =>
    reviewTransaction(db, { bankTxId: (await line(text)).id, accountCode, taxTag: null, withholding: kind ? { kind, amount } : null });
  await review("KONSULTAN", "6170", "PPH_23", 200_000n);
  await review("ROSMIATI", "6120", "PPH_4_2", 1_000_000n);
  await review("BIAYA ADMIN", "6190", null);
  await review("BANK DIGITAL", "4110", "PPH_23", 200_000n);
});

describe("setWithholdingSlip", () => {
  it("stores the slip detail with DJP's rate for a listed code, and records it in Riwayat without posting anything", async () => {
    const before = await db.journalLine.count();
    const tx = await line("KONSULTAN");
    const s = await slip("KONSULTAN", { rate: "99" });
    expect(s).toMatchObject({ bankTransactionId: tx.id, contactId: null, kop: "24-104-03", rate: 200, dpp: 10_000_000n, documentType: "CommercialInvoice", documentNumber: "INV-77", entityId: g.pt.entity.id, clientId: g.client.id });
    expect(s.documentDate?.toISOString()).toBe("2026-08-15T00:00:00.000Z");
    // The withholding stays the line's: kind and amount untouched, no journal written.
    expect(await line("KONSULTAN")).toMatchObject({ whtKind: "PPH_23", whtAmount: 200_000n });
    expect(await db.journalLine.count()).toBe(before);
    const [event] = await db.auditEvent.findMany({ where: { subject: `slip:${tx.id}` } });
    expect(event).toMatchObject({ kind: "BUKTI_POTONG", summary: "Bukti potong JASA KONSULTAN HARAPAN 21 Agu 2026: kode 24-104-03 (2%), DPP Rp 10.000.000, surat tagihan / invoice INV-77 (15 Agu 2026)" });

    // Saving again updates the one row; Kode lain takes the typed rate.
    const again = await slip("KONSULTAN", { kop: "24-104-99", rate: "1,75", dpp: "", documentType: "", documentNumber: "", documentDate: "" });
    expect(again).toMatchObject({ id: s.id, kop: "24-104-99", rate: 175, dpp: null, documentType: null, documentNumber: null, documentDate: null });
    expect(await db.withholdingSlip.count()).toBe(1);
  });

  it("names the recipient of a line with no contact: an existing contact or a new name; never tags the line", async () => {
    const existing = await db.contact.create({ data: { firmId: g.firm.id, clientId: g.client.id, name: "Hj Rosmiati", nik: "3174061502560010" } });
    expect(await slip("ROSMIATI", { contactId: existing.id, kop: "28-403-02" })).toMatchObject({ contactId: existing.id, rate: 1000 });
    const created = await slip("KONSULTAN", { contactName: "  CV  Konsultan Harapan " });
    const contact = await db.contact.findFirstOrThrow({ where: { clientId: g.client.id, name: "CV Konsultan Harapan" } });
    expect(created.contactId).toBe(contact.id);
    expect((await line("KONSULTAN")).contactId).toBeNull();
    // The same name again reuses the contact (upsert by name, as invoices do).
    await slip("KONSULTAN", { contactName: "CV Konsultan Harapan" });
    expect(await db.contact.count({ where: { clientId: g.client.id, name: "CV Konsultan Harapan" } })).toBe(1);
    // A line already tied to a contact keeps it; another recipient is refused.
    await db.bankTransaction.update({ where: { id: (await line("ROSMIATI")).id }, data: { contactId: existing.id } });
    expect(await slip("ROSMIATI", { contactId: existing.id })).toMatchObject({ contactId: null });
    await expect(slip("ROSMIATI", { contactName: "Orang Lain" })).rejects.toThrow("Penerima mutasi ini sudah Hj Rosmiati; ubah lewat Piutang & Utang.");
  });

  it("refuses what can't be stored: a line without company withholding, a bad code, rate, DPP, document or date", async () => {
    await expect(slip("BIAYA ADMIN")).rejects.toThrow("Bukti potong hanya untuk pembayaran badan usaha Rupiah yang dipotong PPh 23, 4(2) atau 22.");
    // A customer's withholding (money in) is their slip, never ours.
    await expect(slip("BANK DIGITAL")).rejects.toThrow("Bukti potong hanya untuk pembayaran");
    await expect(slip("KONSULTAN", { kop: "24104.03" })).rejects.toThrow("Kode objek pajak ditulis NN-NNN-NN, mis. 24-104-03.");
    await expect(slip("KONSULTAN", { kop: "24-999-01", rate: "" })).rejects.toThrow("Tarif berupa persen");
    await expect(slip("KONSULTAN", { kop: "24-999-01", rate: "1,755" })).rejects.toThrow("Tarif berupa persen");
    await expect(slip("KONSULTAN", { kop: "24-999-01", rate: "101" })).rejects.toThrow("Tarif berupa persen");
    await expect(slip("KONSULTAN", { dpp: "0" })).rejects.toThrow("DPP harus lebih dari nol.");
    await expect(slip("KONSULTAN", { dpp: "-5" })).rejects.toThrow("DPP harus lebih dari nol.");
    await expect(slip("KONSULTAN", { dpp: "10.000.000,50" })).rejects.toThrow("tidak memakai angka desimal");
    await expect(slip("KONSULTAN", { documentType: "DeedOfEngagement" })).rejects.toThrow("Pilih jenis dokumen referensi dari daftar.");
    await expect(slip("KONSULTAN", { documentDate: "2026-02-30" })).rejects.toThrow("Tanggal dokumen tidak valid.");
    await expect(slip("KONSULTAN", { documentNumber: "x".repeat(101) })).rejects.toThrow("Nomor dokumen paling panjang 100 karakter.");
    // A code of another kind is stored: the pre-flight blocks it with the reason (bppuDraft).
    expect(await slip("KONSULTAN", { kop: "28-403-02" })).toMatchObject({ kop: "28-403-02", rate: 1000 });
    expect(await db.withholdingSlip.count()).toBe(1);
  });

  it("is scoped to the client: another client's line and contact are refused", async () => {
    const other = await makeGroup();
    const theirs = await db.contact.create({ data: { firmId: other.firm.id, clientId: other.client.id, name: "PT Rahasia" } });
    await expect(setWithholdingSlip(db, { clientId: other.client.id, bankTransactionId: (await line("KONSULTAN")).id, kop: "", dpp: "", documentType: "", documentNumber: "", documentDate: "" })).rejects.toThrow("Mutasi tidak ditemukan di klien ini.");
    await expect(slip("KONSULTAN", { contactId: theirs.id })).rejects.toThrow("Penerima tidak ditemukan di klien ini.");
    expect(await db.withholdingSlip.count()).toBe(0);
  });

  it("may be set in a locked month: it moves no figure", async () => {
    const admin = await addMember(g.firm.id, "ADMIN");
    await db.period.updateMany({ where: { clientId: g.client.id, year: 2026, month: 8 }, data: { status: "LOCKED", lockedById: admin.id, lockedAt: new Date() } });
    expect(await db.period.count({ where: { clientId: g.client.id, year: 2026, month: 8, status: "LOCKED" } })).toBe(1);
    expect(await slip("KONSULTAN")).toMatchObject({ kop: "24-104-03" });
  });

  it("goes with its bank line when the import is removed, and with the client", async () => {
    await slip("KONSULTAN");
    const admin = await addMember(g.firm.id, "ADMIN");
    await removeStatementImport(db, { clientId: g.client.id, importId, reason: "salah rekening, impor ulang", actor: { id: admin.id, role: "ADMIN" } });
    expect(await db.withholdingSlip.count()).toBe(0);

    const again = await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca-agu.csv", data: Buffer.from(CSV), provider: null });
    expect(again.importId).toBeTruthy();
    await reviewTransaction(db, { bankTxId: (await line("KONSULTAN")).id, accountCode: "6170", taxTag: null, withholding: { kind: "PPH_23", amount: 200_000n } });
    await slip("KONSULTAN", { contactName: "CV Konsultan Harapan" });
    await deleteClient(db, { firmId: g.firm.id, clientId: g.client.id, confirmName: "Grup Uji" });
    expect(await db.withholdingSlip.count()).toBe(0);
  });

  it("the database refuses a DPP of zero, a rate out of range and a code without a rate", async () => {
    const tx = await line("KONSULTAN");
    const base = { firmId: g.firm.id, clientId: g.client.id, entityId: g.pt.entity.id, bankTransactionId: tx.id };
    await expect(db.withholdingSlip.create({ data: { ...base, dpp: 0n } })).rejects.toThrow(/WithholdingSlip_dpp_positive/);
    await expect(db.withholdingSlip.create({ data: { ...base, kop: "24-104-03", rate: 10_001 } })).rejects.toThrow(/WithholdingSlip_rate_range/);
    await expect(db.withholdingSlip.create({ data: { ...base, kop: "24-104-03" } })).rejects.toThrow(/WithholdingSlip_kop_rate_paired/);
  });
});
