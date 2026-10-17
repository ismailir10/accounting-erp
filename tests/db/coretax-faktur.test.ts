import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { createInvoice, voidInvoice } from "@/lib/receivables/invoices";
import { setContactTaxIdentity, setInvoiceFakturItem } from "@/lib/receivables/faktur-identity";
import { fakturKeluaranDraft, fakturKeluaranFiles, type FakturDraft } from "@/lib/tax/coretax-faktur";
import { bookFaktur, importFaktur } from "@/lib/tax/faktur";
import { importStatement } from "@/lib/import/pipeline";
import { postOpening } from "@/lib/opening";
import { dateOnly } from "@/lib/format";

// Faktur keluaran untuk Coretax (cycle 2026-10-17-coretax-files): which sales invoices go into the file, and why the others don't.
type G = Awaited<ReturnType<typeof makeGroup>>;
let g: G;
const sale = (number: string, contactName: string, extra: Partial<Parameters<typeof createInvoice>[1]> = {}) =>
  createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "SALES", contactName, number, issueDate: "2026-08-10", dpp: "10.000.000", ppn: "1.100.000", counterCode: "4100", ...extra });
const draft = (month = 8) => fakturKeluaranDraft(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month });
const status = (d: FakturDraft) => d.rows.map((r) => [r.number, r.status, r.reasons.map((x) => x.code)]);
const identity = (contactId: string, over: Partial<Parameters<typeof setContactTaxIdentity>[1]>) =>
  setContactTaxIdentity(db, { clientId: g.client.id, contactId, npwp: "", nik: "", nitku: "", address: "", email: "", ...over });
const jasa = (...invoiceIds: string[]) => setInvoiceFakturItem(db, { clientId: g.client.id, invoiceIds, kind: "B", unit: "UM.0030" });

beforeEach(async () => {
  await resetDb();
  g = await makeGroup();
  await db.entity.update({ where: { id: g.pt.entity.id }, data: { npwp: "01.234.567.8-015.000" } });
});

describe("candidates", () => {
  it("takes the masa's active sales invoices with PPN only", async () => {
    await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 8, 1), lines: [{ accountCode: "1130", debit: "1110000", credit: "0" }] });
    await sale("SA-1", "PT Lama", { opening: true, issueDate: "2026-08-01", dpp: "1.000.000", ppn: "110.000" });
    await sale("INV-1", "PT Mitra Alfa", { contactNpwp: "09.876.543.2-101.200" });
    await sale("INV-2", "Budi Santoso", { issueDate: "2026-08-12" });
    const voided = await sale("INV-3", "PT Mitra Alfa");
    await voidInvoice(db, { clientId: g.client.id, invoiceId: voided.id, reason: "salah input, dobel dengan INV-1" });
    await sale("INV-4", "PT Mitra Alfa", { issueDate: "2026-09-02" });
    await sale("INV-5", "PT Mitra Alfa", { ppn: "" });
    await createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "PURCHASE", contactName: "PT Pakan", number: "B-1", issueDate: "2026-08-10", dpp: "1.000.000", ppn: "110.000", counterCode: "5100" });

    const d = await draft();
    // Opening, voided, September, zero-PPN and purchase documents are out; the NPWP buyer only lacks the item, the other its identity too.
    expect(status(d)).toEqual([
      ["INV-1", "BLOCKED", ["NO_ITEM"]],
      ["INV-2", "BLOCKED", ["NO_BUYER_ID", "NO_ITEM"]],
    ]);
    expect(d.counts).toEqual({ ready: 0, blocked: 2, inCoretax: 0 });
    expect(d.seller).toEqual({ tin: "0012345678015000", idtku: "0012345678015000000000" });
    expect(d.rows[1].reasons.map((r) => [r.text, r.fix])).toEqual([["NPWP atau NIK pembeli belum diisi.", "BUYER"], ["Barang/jasa dan satuannya belum diatur.", "ITEM"]]);
    expect(fakturKeluaranFiles(d)).toEqual([]);
  });

  it("turns rows Siap as they are fixed, and writes an NPWP buyer as TIN and a NIK buyer as National ID", async () => {
    const a = await sale("INV-1", "PT Mitra Alfa", { contactNpwp: "09.876.543.2-101.200" });
    const b = await sale("INV-2", "Budi Santoso", { issueDate: "2026-08-12", dpp: "1.000.001", ppn: "110.000" });
    await identity(b.contactId, { nik: "3174061502560010" });
    expect(status(await draft())).toEqual([
      ["INV-1", "BLOCKED", ["NO_ITEM"]],
      ["INV-2", "BLOCKED", ["NIK_NO_ADDRESS", "NO_ITEM"]],
    ]);
    await identity(b.contactId, { nik: "3174061502560010", address: "Jl. Kenanga 2, Jakarta" });
    await jasa(a.id, b.id);
    const d = await draft();
    expect(status(d)).toEqual([["INV-1", "READY", []], ["INV-2", "READY", []]]);
    const [file] = fakturKeluaranFiles(d);
    expect(file.rows).toBe(2);
    expect(file.xml).toContain("<TIN>0012345678015000</TIN>");
    expect(file.xml).toContain("<BuyerTin>0098765432101200</BuyerTin>\n\t\t\t<BuyerDocument>TIN</BuyerDocument>");
    expect(file.xml).toContain("<BuyerIDTKU>0098765432101200000000</BuyerIDTKU>");
    expect(file.xml).toContain("<BuyerTin>0000000000000000</BuyerTin>\n\t\t\t<BuyerDocument>National ID</BuyerDocument>\n\t\t\t<BuyerCountry>IDN</BuyerCountry>\n\t\t\t<BuyerDocumentNumber>3174061502560010</BuyerDocumentNumber>");
    expect(file.xml).toContain("<BuyerIDTKU>000000</BuyerIDTKU>");
    // DPP, DPP Nilai Lain, 12 % and PPN tie to the invoice (Rp 110.000 vs Rp 110.000,11: under Rp 1).
    expect(file.xml).toContain("<TaxBase>1000001</TaxBase>\n\t\t\t\t\t<OtherTaxBase>916667.58</OtherTaxBase>\n\t\t\t\t\t<VATRate>12</VATRate>\n\t\t\t\t\t<VAT>110000.11</VAT>");
    expect(file.xml).toContain("<RefDesc>INV-1</RefDesc>");
    expect(file.xml).toContain("<Name>Penjualan kepada PT Mitra Alfa</Name>");
  });

  it("names every block reason: bad NPWP, NIK, NITKU, the PPN formula, and the company", async () => {
    const a = await sale("INV-1", "PT Mitra Alfa");
    const b = await sale("INV-2", "CV Beta");
    const c = await sale("INV-3", "Budi Santoso");
    // A typed 12 % of the DPP, which kode 04 never yields.
    const d12 = await sale("INV-4", "PT Mitra Alfa", { ppn: "1.200.000" });
    await jasa(a.id, b.id, c.id, d12.id);
    // Older entries can hold anything: the export checks them again.
    await db.contact.update({ where: { id: a.contactId }, data: { npwp: "1234" } });
    await db.contact.update({ where: { id: b.contactId }, data: { npwp: "0012345678015000", nitku: "123" } });
    await db.contact.update({ where: { id: c.contactId }, data: { nik: "31740615", address: "Jl. Kenanga 2" } });
    const d = await draft();
    expect(status(d)).toEqual([
      ["INV-1", "BLOCKED", ["BAD_NPWP"]],
      ["INV-2", "BLOCKED", ["BAD_NITKU"]],
      ["INV-3", "BLOCKED", ["BAD_NIK"]],
      ["INV-4", "BLOCKED", ["BAD_NPWP", "PPN_FORMULA"]],
    ]);
    expect(d.rows[3].reasons[1].text).toMatch(/^PPN Rp 1\.200\.000 tidak sama dengan 12% × 11\/12 × DPP \(Rp 1\.100\.000\)\..*kode transaksi selain 04/);

    // Correcting the invoice (void + re-record) clears the PPN reason.
    await voidInvoice(db, { clientId: g.client.id, invoiceId: d12.id, reason: "PPN salah tarif 12 persen" });
    const fixed = await sale("INV-4R", "PT Mitra Alfa");
    await jasa(fixed.id);
    await identity(a.contactId, { npwp: "0012345678015000" });
    expect(status(await draft()).filter(([n]) => n === "INV-1" || n === "INV-4R")).toEqual([["INV-1", "READY", []], ["INV-4R", "READY", []]]);

    // A company without an NPWP blocks the whole file; a stored NITKU that isn't its NPWP's too.
    await db.entity.update({ where: { id: g.pt.entity.id }, data: { npwp: null } });
    const none = await draft();
    expect(none.companyReasons.map((r) => [r.code, r.text, r.fix])).toEqual([["COMPANY_NPWP", "NPWP perusahaan belum diisi, jadi faktur tidak bisa dibuat.", "COMPANY"]]);
    expect(none.counts.ready).toBe(2);
    expect(fakturKeluaranFiles(none)).toEqual([]);
    await db.entity.update({ where: { id: g.pt.entity.id }, data: { npwp: "0012345678015000", nitku: "0999999999999999000000" } });
    expect((await draft()).companyReasons.map((r) => r.code)).toEqual(["COMPANY_NITKU"]);
    await db.entity.update({ where: { id: g.pt.entity.id }, data: { nitku: "0012345678015000000003" } });
    expect((await draft()).seller).toEqual({ tin: "0012345678015000", idtku: "0012345678015000000003" });
  });

  it("prefills the item from the contact's last invoice", async () => {
    const july = await sale("INV-7", "PT Mitra Alfa", { issueDate: "2026-07-10", contactNpwp: "0012345678015999" });
    await setInvoiceFakturItem(db, { clientId: g.client.id, invoiceIds: [july.id], kind: "A", code: "010100", unit: "UM.0003", name: "Pakan juli" });
    await sale("INV-8", "PT Mitra Alfa");
    const [row] = (await draft()).rows;
    expect(row).toMatchObject({ number: "INV-8", status: "READY", item: { kind: "A", code: "010100", unit: "UM.0003", name: "Penjualan kepada PT Mitra Alfa", prefilled: true } });
  });

  it("leaves out an invoice already in Coretax: matched in the ekualisasi, or booked from a faktur", async () => {
    const a = await sale("INV-1", "PT Mitra Alfa", { contactNpwp: "01.234.567.8-015.999" });
    const b = await sale("INV-2", "Budi Santoso", { issueDate: "2026-08-12", dpp: "2.000.000", ppn: "220.000" });
    await identity(b.contactId, { nik: "3174061502560010", address: "Jl. Kenanga 2" });
    await jasa(a.id, b.id);
    expect((await draft()).counts).toEqual({ ready: 2, blocked: 0, inCoretax: 0 });
    const csv = [
      "Nomor Faktur Pajak;Tanggal Faktur Pajak;Masa Pajak;Tahun;NPWP Pembeli;Nama Pembeli;Status Faktur;Harga Jual/Penggantian/DPP;PPN",
      "04002600000000001;10/08/2026;8;2026;0012345678015999;PT Mitra Alfa;APPROVED;10000000;1100000",
      // Masa September: not in August's ekualisasi; booked as an August invoice from the faktur (I5e).
      "04002600000000009;20/08/2026;9;2026;0555;CV Gamma;APPROVED;5000000;550000",
      "",
    ].join("\n");
    await importFaktur(db, { clientId: g.client.id, entityId: g.pt.entity.id, fileName: "keluaran.csv", data: Buffer.from(csv) });
    const f9 = await db.coretaxFaktur.findFirstOrThrow({ where: { number: "04002600000000009" } });
    await bookFaktur(db, { clientId: g.client.id, fakturId: f9.id, counterCode: "4100" });
    const d = await draft();
    expect(d.rows.map((r) => [r.number, r.status, r.coretaxNumber])).toEqual([
      ["INV-2", "READY", null],
      ["INV-1", "IN_CORETAX", "04002600000000001"],
      ["04002600000000009", "IN_CORETAX", "04002600000000009"],
    ]);
    const [file] = fakturKeluaranFiles(d);
    expect(file.rows).toBe(1);
    expect(file.xml).toContain("<RefDesc>INV-2</RefDesc>");
    expect(file.xml).not.toContain("INV-1");
  });

  it("lists bank lines with a PPN split apart and never exports them", async () => {
    await db.rule.create({ data: { firmId: g.firm.id, clientId: g.client.id, pattern: "MITRA", direction: "IN", accountCode: "4100", taxTag: "PPN_KELUARAN", priority: 50, source: "USER" } });
    const csv = ["Tanggal;Keterangan;Debet;Kredit;Saldo", "01/08/2026;SALDO AWAL;;;500000000", "05/08/2026;TRSF CR PT MITRA UNGGAS;0;111000000;611000000", ""].join("\n");
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca.csv", data: Buffer.from(csv), provider: null });
    const d = await draft();
    expect(d.rows).toEqual([]);
    expect(d.bankPpn.map((b) => [b.label, b.ppn])).toEqual([["TRSF CR PT MITRA UNGGAS", 11_000_000n]]);
  });

  it("refuses an individual's books and another client's entity", async () => {
    await expect(fakturKeluaranDraft(db, { clientId: g.client.id, entityId: g.owner.entity.id, year: 2026, month: 8 })).rejects.toThrow("badan usaha (PT/CV)");
    const other = await makeGroup();
    await expect(fakturKeluaranDraft(db, { clientId: other.client.id, entityId: g.pt.entity.id, year: 2026, month: 8 })).rejects.toThrow("Perusahaan tidak ditemukan");
  });
});
