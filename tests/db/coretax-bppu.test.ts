import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction } from "@/lib/review";
import { createInvoice } from "@/lib/receivables/invoices";
import { settleWithReclass } from "@/lib/receivables/settle";
import { setContactTaxIdentity } from "@/lib/receivables/faktur-identity";
import { setWithholdingSlip, type SlipInput } from "@/lib/tax/withholding-slip";
import { bppuDraft, bppuFile, type BppuDraft } from "@/lib/tax/coretax-bppu";
import { importBupot } from "@/lib/tax/bupot";

// Bukti potong untuk Coretax (cycle 2026-10-17-bppu-files, T3): which payments become slips, what is prefilled, and why the others don't.
type G = Awaited<ReturnType<typeof makeGroup>>;
let g: G;
const CSV = [
  "Tanggal;Keterangan;Debet;Kredit;Saldo",
  "01/08/2026;SALDO AWAL;;;500000000",
  "05/08/2026;TRSF CR PT BANK DIGITAL NUSA;0;9800000;509800000",
  "10/08/2026;TRSF DB CV KONSULTAN A B-77;9800000;0;500000000",
  "15/08/2026;SEWA RUKO HJ ROSMIATI;9000000;0;491000000",
  "16/08/2026;GAJI KARYAWAN AGUSTUS;4750000;0;486250000",
  "20/08/2026;JASA IT SOLUSI;15000000;0;471250000",
  "22/08/2026;BIAYA ADMIN;5000;0;471245000",
  "25/08/2026;JASA KEBERSIHAN CEMERLANG;980000;0;470265000",
  "02/09/2026;TRSF DB CV KONSULTAN A SEPT;7350000;0;462915000",
  "",
].join("\n");
const line = (text: string) => db.bankTransaction.findFirstOrThrow({ where: { description: { contains: text } } });
const draft = (month = 8) => bppuDraft(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month });
const status = (d: BppuDraft) => d.rows.map((r) => [r.description, r.status, r.reasons.map((x) => x.code)]);
const row = (d: BppuDraft, text: string) => d.rows.find((r) => r.description.includes(text))!;
const slip = async (text: string, over: Partial<SlipInput>) =>
  setWithholdingSlip(db, { clientId: g.client.id, bankTransactionId: (await line(text)).id, kop: "", dpp: "", documentType: "", documentNumber: "", documentDate: "", ...over });
const identity = (contactId: string, over: { npwp?: string; nik?: string }) =>
  setContactTaxIdentity(db, { clientId: g.client.id, contactId, npwp: "", nik: "", nitku: "", address: "", email: "", ...over });
const contactId = async (name: string) => (await db.contact.findFirstOrThrow({ where: { clientId: g.client.id, name } })).id;

beforeEach(async () => {
  await resetDb();
  g = await makeGroup();
  await db.entity.update({ where: { id: g.pt.entity.id }, data: { npwp: "01.234.567.8-015.000" } });
  await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca.csv", data: Buffer.from(CSV), provider: null });
  const review = async (text: string, accountCode: string, wht: { kind: "PPH_23" | "PPH_4_2" | "PPH_21"; amount: bigint } | null, taxTag: "PPN_MASUKAN" | null = null) =>
    reviewTransaction(db, { bankTxId: (await line(text)).id, accountCode, taxTag, withholding: wht });
  await review("BANK DIGITAL", "4110", { kind: "PPH_23", amount: 200_000n });
  await review("ROSMIATI", "6120", { kind: "PPH_4_2", amount: 1_000_000n });
  await review("GAJI", "6170", { kind: "PPH_21", amount: 250_000n });
  await review("JASA IT", "6170", { kind: "PPH_23", amount: 275_229n }, "PPN_MASUKAN");
  await review("BIAYA ADMIN", "6190", null);
  await review("KONSULTAN A SEPT", "6170", { kind: "PPH_23", amount: 150_000n });
  // A line still in Review can already carry a withholding (older entries can hold anything): it waits for Review.
  await db.bankTransaction.update({ where: { id: (await line("KEBERSIHAN")).id }, data: { whtKind: "PPH_23", whtAmount: 20_000n } });
  // A purchase invoice from a supplier with a 15-digit NPWP, PPh 23 expected at 2 %, settled by the payment net of it.
  const bill = await createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "PURCHASE", contactName: "CV Konsultan A", contactNpwp: "09.876.543.2-101.200", number: "B-77", issueDate: "2026-08-01", dpp: "10.000.000", counterCode: "6170", whtKind: "PPH_23", whtRate: "2" });
  await settleWithReclass(db, { clientId: g.client.id, invoiceId: bill.id, bankTransactionId: (await line("KONSULTAN A B-77")).id });
});

describe("candidates", () => {
  it("takes the masa's outgoing PPh 23 / 4(2) / 22 lines of the company only", async () => {
    // The owner's account (another entity) with a withholding typed on it: never in the company's file.
    await importStatement(db, { bankAccountId: g.owner.banks[0].id, fileName: "bri.csv", data: Buffer.from("Tanggal;Keterangan;Debet;Kredit;Saldo\n01/08/2026;SALDO AWAL;;;1000000\n12/08/2026;JASA DESAIN;98000;0;902000\n"), provider: null });
    await db.bankTransaction.update({ where: { id: (await line("JASA DESAIN")).id }, data: { whtKind: "PPH_23", whtAmount: 2_000n } });
    const d = await draft();
    // Incoming (the customer's slip), PPh 21, no withholding, September and the other entity are out.
    expect(status(d)).toEqual([
      ["TRSF DB CV KONSULTAN A B-77", "BLOCKED", ["NO_KOP"]],
      ["SEWA RUKO HJ ROSMIATI", "BLOCKED", ["NO_RECIPIENT", "NO_KOP", "NO_DPP", "NO_DOCUMENT"]],
      ["JASA IT SOLUSI", "BLOCKED", ["NO_RECIPIENT", "NO_KOP", "NO_DPP", "NO_DOCUMENT"]],
      ["JASA KEBERSIHAN CEMERLANG", "BLOCKED", ["IN_REVIEW", "NO_RECIPIENT", "NO_KOP", "NO_DPP", "NO_DOCUMENT"]],
    ]);
    expect(d.counts).toEqual({ ready: 0, blocked: 4, inCoretax: 0 });
    expect(d.company).toEqual({ tin: "0012345678015000", idtku: "0012345678015000000000" });
    expect(row(d, "ROSMIATI").reasons.map((r) => [r.text, r.fix])).toEqual([
      ["Penerima belum dipilih.", "SLIP"],
      ["Kode objek pajak belum dipilih.", "SLIP"],
      ["DPP belum diisi.", "SLIP"],
      ["Dokumen referensi belum diisi.", "SLIP"],
    ]);
    expect(row(d, "KEBERSIHAN").reasons[0]).toEqual({ code: "IN_REVIEW", text: "Mutasi ini masih di Review: putuskan dulu akun dan potongannya.", fix: "REVIEW" });
    expect(row(d, "ROSMIATI")).toMatchObject({ kind: "PPH_4_2", gross: 10_000_000n, withheld: 1_000_000n });
    expect(bppuFile(d)).toBeNull();
    expect((await draft(9)).rows.map((r) => r.description)).toEqual(["TRSF DB CV KONSULTAN A SEPT"]);
  });

  it("a line matched to a counted dibuat slip in the masa's recon reads Sudah ada di Coretax and stays out of the file", async () => {
    await slip("KONSULTAN A B-77", { kop: "24-104-03" });
    expect(row(await draft(), "B-77").status).toBe("READY");
    const slips = [
      "Nomor Bukti Potong;Tanggal Pemotongan;Masa Pajak;Tahun Pajak;NPWP/NIK Penerima Penghasilan;Nama Penerima Penghasilan;Kode Objek Pajak;Dasar Pengenaan Pajak (Rp);PPh Dipotong (Rp);Status",
      "2600000123;10/08/2026;8;2026;0098765432101200;CV Konsultan A;24-104-03;10000000;200000;NORMAL",
      // A cancelled slip of the same amount does not count.
      "2600000124;10/08/2026;8;2026;0098765432101200;CV Konsultan A;24-104-03;10000000;1000000;DIBATALKAN",
      "",
    ].join("\n");
    await importBupot(db, { clientId: g.client.id, entityId: g.pt.entity.id, fileName: "bppu.csv", data: Buffer.from(slips) });
    const d = await draft();
    expect(row(d, "B-77")).toMatchObject({ status: "IN_CORETAX", coretaxNumber: "2600000123", reasons: [], xml: null });
    expect(row(d, "ROSMIATI").status).toBe("BLOCKED");
    expect(d.counts).toEqual({ ready: 0, blocked: 3, inCoretax: 1 });
    expect(bppuFile(d)).toBeNull();
  });
});

describe("prefill", () => {
  it("takes the DPP and document from the settled purchase invoice, and the DPP from withheld ÷ rate only when exact", async () => {
    const b77 = row(await draft(), "B-77");
    expect(b77).toMatchObject({ recipient: { name: "CV Konsultan A", fromLine: true }, dpp: 10_000_000n, documentType: "CommercialInvoice", documentNumber: "B-77", kop: null, rate: null, saved: false });
    expect(b77.documentDate?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(b77.prefill).toEqual({ dpp: "INVOICE", kop: false, document: "INVOICE" });

    // A listed code sets DJP's rate; the invoice's DPP holds at 2 %.
    await slip("KONSULTAN A B-77", { kop: "24-104-03" });
    expect(row(await draft(), "B-77")).toMatchObject({ status: "READY", rate: 200, dpp: 10_000_000n, prefill: { dpp: "INVOICE" } });
    // At 15 % neither the invoice's DPP holds nor does 200.000 ÷ 15 % divide exactly: no DPP is guessed.
    await slip("KONSULTAN A B-77", { kop: "24-103-01" });
    expect(row(await draft(), "B-77")).toMatchObject({ dpp: null, prefill: { dpp: null }, reasons: [{ code: "NO_DPP" }] });

    // Rent at 10 %: 1.000.000 ÷ 10 % = 10.000.000 exactly.
    await slip("ROSMIATI", { kop: "28-403-02" });
    expect(row(await draft(), "ROSMIATI")).toMatchObject({ rate: 1000, dpp: 10_000_000n, prefill: { dpp: "DIVISION" } });
    // A PPN-split payment never gets a computed DPP: its DPP is the accountant's to state (275.229 ÷ 2 % would divide exactly).
    await slip("JASA IT", { kop: "24-104-24" });
    expect(row(await draft(), "JASA IT")).toMatchObject({ rate: 200, dpp: null, prefill: { dpp: null } });
  });

  it("next month takes the KOP and document type from the recipient's last slip, never its DPP", async () => {
    await slip("KONSULTAN A B-77", { kop: "24-104-03", dpp: "10.000.000", documentType: "PaymentProof", documentNumber: "BP-1", documentDate: "2026-08-10" });
    await db.bankTransaction.update({ where: { id: (await line("KONSULTAN A SEPT")).id }, data: { contactId: await contactId("CV Konsultan A") } });
    const sept = row(await draft(9), "SEPT");
    expect(sept).toMatchObject({ kop: "24-104-03", rate: 200, documentType: "PaymentProof", documentNumber: null, documentDate: null, prefill: { kop: true, document: "LAST", dpp: "DIVISION" } });
    // 150.000 ÷ 2 % — not August's 10.000.000.
    expect(sept.dpp).toBe(7_500_000n);
    expect(sept.reasons.map((r) => r.code)).toEqual(["NO_DOCUMENT"]);
    // A last slip of another kind is not carried over.
    await slip("KONSULTAN A B-77", { kop: "28-403-02" });
    expect(row(await draft(9), "SEPT")).toMatchObject({ kop: null, prefill: { kop: false } });
  });
});

describe("block reasons", () => {
  it("names each one, and fixing it in place turns the row Siap", async () => {
    // Recipient: a new name on the slip, then its identity.
    await slip("JASA IT", { contactName: "PT IT Solusi", kop: "24-104-24", dpp: "13.761.718", documentType: "TaxInvoice", documentNumber: "12345", documentDate: "2026-08-20" });
    let r = row(await draft(), "JASA IT");
    expect(r.recipient).toMatchObject({ name: "PT IT Solusi", fromLine: false });
    expect(r.reasons.map((x) => x.code)).toEqual(["NO_RECIPIENT_ID", "TAX_DIFF", "BAD_FAKTUR_NUMBER"]);
    expect(r.reasons.map((x) => x.text)).toEqual([
      "NPWP atau NIK PT IT Solusi belum diisi.",
      "2% × DPP Rp 13.761.718 = Rp 275.234, buku mencatat PPh Rp 275.229. Perbaiki DPP di bukti potong, atau jumlah potongannya di Review.",
      "Nomor faktur pajak (12345) harus 16 atau 17 angka.",
    ]);
    expect(r.reasons.find((x) => x.code === "NO_RECIPIENT_ID")!.fix).toBe("RECIPIENT");

    const it = await contactId("PT IT Solusi");
    await db.contact.update({ where: { id: it }, data: { npwp: "1234" } });
    expect(row(await draft(), "JASA IT").reasons[0]).toMatchObject({ code: "BAD_NPWP", text: "NPWP penerima (1234) bukan 15 atau 16 angka." });
    await db.contact.update({ where: { id: it }, data: { npwp: "0111222333444000", nitku: "0999999999999999000001" } });
    expect(row(await draft(), "JASA IT").reasons[0]).toMatchObject({ code: "BAD_NITKU" });
    await db.contact.update({ where: { id: it }, data: { npwp: null, nitku: null, nik: "31740615" } });
    expect(row(await draft(), "JASA IT").reasons[0]).toMatchObject({ code: "BAD_NIK", text: "NIK penerima harus 16 angka." });
    await identity(it, { npwp: "0111222333444000" });

    // A code of another kind blocks with both kinds named.
    await slip("JASA IT", { contactName: "PT IT Solusi", kop: "28-403-02", dpp: "13.761.468", documentType: "TaxInvoice", documentNumber: "0100012292489165", documentDate: "2026-08-20" });
    r = row(await draft(), "JASA IT");
    expect(r.reasons.map((x) => x.text)).toEqual([
      "Kode 28-403-02 adalah PPh 4(2), mutasi mencatat PPh 23. Pilih kode PPh 23, atau ubah jenis potongannya di Review.",
      "10% × DPP Rp 13.761.468 = Rp 1.376.147, buku mencatat PPh Rp 275.229. Perbaiki DPP di bukti potong, atau jumlah potongannya di Review.",
    ]);
    // DPP 13.761.468 × 2 % = 275.229,36: within Rp 1 of the books.
    await slip("JASA IT", { contactName: "PT IT Solusi", kop: "24-104-24", dpp: "13.761.468", documentType: "TaxInvoice", documentNumber: "0100012292489165", documentDate: "2026-08-20" });
    r = row(await draft(), "JASA IT");
    expect(r).toMatchObject({ status: "READY", reasons: [] });
    expect(r.xml).toMatchObject({ counterpartTin: "0111222333444000", counterpartIdtku: "0111222333444000000000", kop: "24-104-24", dpp: 13_761_468n, rate: 200, document: "TaxInvoice" });
  });

  it("the company's NPWP or NITKU blocks the whole file", async () => {
    await slip("KONSULTAN A B-77", { kop: "24-104-03" });
    await db.entity.update({ where: { id: g.pt.entity.id }, data: { npwp: null } });
    let d = await draft();
    expect(d.companyReasons).toEqual([{ code: "COMPANY_NPWP", text: "NPWP perusahaan belum diisi, jadi bukti potong tidak bisa dibuat.", fix: "COMPANY" }]);
    // The row itself is ready; the file is not.
    expect(row(d, "B-77").status).toBe("READY");
    expect(bppuFile(d)).toBeNull();
    await db.entity.update({ where: { id: g.pt.entity.id }, data: { npwp: "0012345678015000", nitku: "0012345678015000" } });
    d = await draft();
    expect(d.companyReasons.map((r) => r.code)).toEqual(["COMPANY_NITKU"]);
    expect(bppuFile(d)).toBeNull();
  });

  it("writes the Siap rows only: an NPWP recipient as NPWP16 with its NITKU, a NIK recipient with NIK + 000000", async () => {
    await slip("KONSULTAN A B-77", { kop: "24-104-03" });
    await slip("ROSMIATI", { contactName: "Hj Rosmiati", kop: "28-403-02", documentType: "Contract", documentNumber: "SPK/08 & sewa", documentDate: "2026-08-01" });
    await identity(await contactId("Hj Rosmiati"), { nik: "3174061502560010" });
    const d = await draft();
    expect(d.counts).toEqual({ ready: 2, blocked: 2, inCoretax: 0 });
    const file = bppuFile(d)!;
    expect(file.rows).toBe(2);
    expect(file.xml.match(/<Bpu>/g)).toHaveLength(2);
    expect(file.xml).toContain("<TIN>0012345678015000</TIN>");
    expect(file.xml).toContain("<CounterpartTin>0098765432101200</CounterpartTin>\n\t\t\t<IDPlaceOfBusinessActivityOfIncomeRecipient>0098765432101200000000</IDPlaceOfBusinessActivityOfIncomeRecipient>");
    expect(file.xml).toContain("<CounterpartTin>3174061502560010</CounterpartTin>\n\t\t\t<IDPlaceOfBusinessActivityOfIncomeRecipient>3174061502560010000000</IDPlaceOfBusinessActivityOfIncomeRecipient>");
    expect(file.xml).toContain("<TaxObjectCode>24-104-03</TaxObjectCode>\n\t\t\t<TaxBase>10000000</TaxBase>\n\t\t\t<Rate>2</Rate>\n\t\t\t<Document>CommercialInvoice</Document>\n\t\t\t<DocumentNumber>B-77</DocumentNumber>\n\t\t\t<DocumentDate>2026-08-01</DocumentDate>");
    expect(file.xml).toContain("<Rate>10</Rate>");
    expect(file.xml).toContain("<DocumentNumber>SPK/08 &amp; sewa</DocumentNumber>");
    expect(file.xml).toContain("<IDPlaceOfBusinessActivity>0012345678015000000000</IDPlaceOfBusinessActivity>");
    // Masa = bank month, WithholdingDate = bank date.
    expect(file.xml).toContain("<TaxPeriodMonth>8</TaxPeriodMonth>");
    expect(file.xml).toContain("<WithholdingDate>2026-08-10</WithholdingDate>");
    expect(file.xml).toContain("<WithholdingDate>2026-08-15</WithholdingDate>");
    expect(file.xml).not.toContain("JASA IT");
  });
});
