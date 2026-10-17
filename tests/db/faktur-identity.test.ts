import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { createInvoice } from "@/lib/receivables/invoices";
import { setContactTaxIdentity, setInvoiceFakturItem } from "@/lib/receivables/faktur-identity";
import { renameEntity } from "@/lib/clients/entities";
import { listEvents } from "@/lib/audit";

// Coretax faktur keluaran (cycle 2026-10-17-coretax-files): the buyer's identity on the contact and the faktur item on the invoice.
type G = Awaited<ReturnType<typeof makeGroup>>;
let g: G;
const sale = (number: string, contactName: string, extra: Partial<Parameters<typeof createInvoice>[1]> = {}) =>
  createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "SALES", contactName, number, issueDate: "2026-08-10", dpp: "10.000.000", ppn: "1.100.000", counterCode: "4100", ...extra });
const identity = (contactId: string, over: Partial<Parameters<typeof setContactTaxIdentity>[1]> = {}) =>
  setContactTaxIdentity(db, { clientId: g.client.id, contactId, npwp: "", nik: "", nitku: "", address: "", email: "", ...over });

beforeEach(async () => {
  await resetDb();
  g = await makeGroup();
});

describe("buyer tax identity", () => {
  it("normalises NPWP / NIK / NITKU, keeps the head office NITKU as the default, and logs which fields changed, never their values", async () => {
    const inv = await sale("INV-1", "PT Mitra Alfa");
    const c = await identity(inv.contactId, { npwp: "01.234.567.8-015.000", nitku: "0012345678015000000000", address: "  Jl. Melati   1, Jakarta ", email: "keu@mitra.co.id" });
    // The head office NITKU is the default, so it is not stored: it follows the NPWP.
    expect(c).toMatchObject({ npwp: "01.234.567.8-015.000", nitku: null, address: "Jl. Melati 1, Jakarta", email: "keu@mitra.co.id", nik: null });
    const branch = await identity(inv.contactId, { npwp: "0012345678015000", nitku: "0012345678015000000001", address: "Jl. Melati 1, Jakarta", email: "keu@mitra.co.id" });
    expect(branch).toMatchObject({ npwp: "0012345678015000", nitku: "0012345678015000000001" });

    const person = await sale("INV-2", "Budi Santoso");
    await identity(person.contactId, { nik: "3174 0615 0256 0010", address: "Jl. Kenanga 2" });
    expect(await db.contact.findUniqueOrThrow({ where: { id: person.contactId } })).toMatchObject({ nik: "3174061502560010", npwp: null, nitku: null });

    const events = await listEvents(db, g.client.id, { kind: "FAKTUR" });
    expect(events.map((e) => e.summary)).toEqual([
      "Identitas pajak Budi Santoso diubah: NIK, alamat",
      "Identitas pajak PT Mitra Alfa diubah: NPWP, NITKU",
      "Identitas pajak PT Mitra Alfa diubah: NPWP, alamat, email",
    ]);
    // Personal data never lands in the change log.
    const logged = JSON.stringify(events);
    for (const pii of ["3174061502560010", "Kenanga", "keu@mitra.co.id", "Melati"]) expect(logged).not.toContain(pii);
    // Saving the same identity again writes nothing.
    await identity(person.contactId, { nik: "3174061502560010", address: "Jl. Kenanga 2" });
    expect(await listEvents(db, g.client.id, { kind: "FAKTUR" })).toHaveLength(3);
  });

  it("refuses a malformed identity field by field, and a contact of another client", async () => {
    const inv = await sale("INV-1", "PT Mitra Alfa");
    await expect(identity(inv.contactId, { npwp: "1234", nik: "12", nitku: "99", email: "bukan email" })).rejects.toMatchObject({
      fields: { npwp: expect.stringContaining("15 atau 16 angka"), nik: "NIK berisi 16 angka.", email: expect.stringContaining("Email tidak valid") },
    });
    await expect(identity(inv.contactId, { nitku: "0012345678015000000000" })).rejects.toMatchObject({ fields: { nitku: "NITKU hanya untuk pembeli ber-NPWP. Isi NPWP-nya dulu." } });
    await expect(identity(inv.contactId, { npwp: "0012345678015000", nitku: "0999999999999999000000" })).rejects.toMatchObject({ fields: { nitku: "NITKU diawali 16 angka NPWP pembeli (0012345678015000)." } });
    await expect(identity(inv.contactId, { npwp: "0012345678015000", nitku: "00123" })).rejects.toMatchObject({ fields: { nitku: expect.stringContaining("22 angka") } });
    await expect(identity(inv.contactId, { nik: "3174A61502560010" })).rejects.toMatchObject({ fields: { nik: "NIK berisi 16 angka." } });

    const other = await makeGroupNamed();
    await expect(setContactTaxIdentity(db, { clientId: other.client.id, contactId: inv.contactId, npwp: "", nik: "", nitku: "", address: "", email: "" })).rejects.toThrow("Pelanggan tidak ditemukan.");
    expect(await listEvents(db, g.client.id, { kind: "FAKTUR" })).toEqual([]);
  });
});

describe("faktur item on a sales invoice", () => {
  it("sets Barang/Jasa, code, unit for several invoices at once, keeps names unless given, audited once per call", async () => {
    const a = await sale("INV-1", "PT Mitra Alfa", { description: "Jasa konsultasi Agustus" });
    const b = await sale("INV-2", "Budi Santoso");
    expect(await setInvoiceFakturItem(db, { clientId: g.client.id, invoiceIds: [a.id, b.id], kind: "B", code: "", unit: "UM.0030" })).toBe(2);
    expect(await db.invoice.findMany({ where: { id: { in: [a.id, b.id] } }, orderBy: { number: "asc" }, select: { fakturItemKind: true, fakturItemCode: true, fakturUnit: true, fakturItemName: true } })).toEqual([
      { fakturItemKind: "B", fakturItemCode: "000000", fakturUnit: "UM.0030", fakturItemName: null },
      { fakturItemKind: "B", fakturItemCode: "000000", fakturUnit: "UM.0030", fakturItemName: null },
    ]);
    await setInvoiceFakturItem(db, { clientId: g.client.id, invoiceIds: [a.id], kind: "A", code: "010100", unit: "UM.0018", name: "  Mesin  giling " });
    expect(await db.invoice.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ fakturItemKind: "A", fakturItemCode: "010100", fakturUnit: "UM.0018", fakturItemName: "Mesin giling" });
    // An empty name returns it to the invoice's description.
    await setInvoiceFakturItem(db, { clientId: g.client.id, invoiceIds: [a.id], kind: "A", code: "010100", unit: "UM.0018", name: "" });
    expect((await db.invoice.findUniqueOrThrow({ where: { id: a.id } })).fakturItemName).toBeNull();
    expect((await listEvents(db, g.client.id, { kind: "FAKTUR" })).map((e) => e.summary)).toEqual([
      "Barang/jasa faktur INV-1: Barang 010100, satuan Unit",
      "Barang/jasa faktur INV-1: Barang 010100, satuan Unit, Mesin giling",
      "Barang/jasa faktur untuk 2 faktur: Jasa 000000, satuan Kegiatan",
    ]);
  });

  it("refuses a bad code or unit, a purchase, a voided invoice and another client's invoice", async () => {
    const a = await sale("INV-1", "PT Mitra Alfa");
    const set = (over: Partial<Parameters<typeof setInvoiceFakturItem>[1]>) => setInvoiceFakturItem(db, { clientId: g.client.id, invoiceIds: [a.id], kind: "B", unit: "UM.0030", ...over });
    await expect(set({ kind: "C" })).rejects.toThrow("Pilih Barang atau Jasa.");
    await expect(set({ code: "12" })).rejects.toThrow("Kode barang/jasa berisi 6 angka");
    await expect(set({ unit: "Kegiatan" })).rejects.toThrow("Pilih satuan dari daftar DJP.");
    await expect(set({ invoiceIds: [] })).rejects.toThrow("Pilih faktur yang diatur.");
    const bill = await createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "PURCHASE", contactName: "PT Pakan", number: "B-1", issueDate: "2026-08-10", dpp: "1.000.000", counterCode: "5100" });
    await expect(set({ invoiceIds: [a.id, bill.id] })).rejects.toThrow("Faktur B-1 bukan faktur penjualan aktif");
    const other = await makeGroupNamed();
    await expect(setInvoiceFakturItem(db, { clientId: other.client.id, invoiceIds: [a.id], kind: "B", unit: "UM.0030" })).rejects.toThrow("Faktur tidak ditemukan di klien ini.");
    expect((await db.invoice.findUniqueOrThrow({ where: { id: a.id } })).fakturItemKind).toBeNull();
  });
});

describe("seller NITKU", () => {
  it("is set with the company's data: 22 digits starting with its NPWP16, the head office stored as null", async () => {
    const base = { firmId: g.firm.id, clientId: g.client.id, entityId: g.pt.entity.id, name: "PT Uji Sejahtera", shortName: "PT Uji" };
    await renameEntity(db, { ...base, npwp: "01.234.567.8-015.000", nitku: "0012345678015000000002" });
    expect(await db.entity.findUniqueOrThrow({ where: { id: g.pt.entity.id } })).toMatchObject({ npwp: "01.234.567.8-015.000", nitku: "0012345678015000000002" });
    await renameEntity(db, { ...base, npwp: "01.234.567.8-015.000", nitku: "0012345678015000000000" });
    expect((await db.entity.findUniqueOrThrow({ where: { id: g.pt.entity.id } })).nitku).toBeNull();
    await expect(renameEntity(db, { ...base, npwp: "01.234.567.8-015.000", nitku: "0999999999999999000000" })).rejects.toMatchObject({ fields: { nitku: "NITKU diawali 16 angka NPWP perusahaan (0012345678015000)." } });
    // Without `nitku` the edit keeps it (the form of an older page).
    await renameEntity(db, { ...base, npwp: "01.234.567.8-015.000", nitku: "0012345678015000000002" });
    await renameEntity(db, { ...base, name: "PT Uji Baru", npwp: "01.234.567.8-015.000" });
    expect((await db.entity.findUniqueOrThrow({ where: { id: g.pt.entity.id } })).nitku).toBe("0012345678015000000002");
  });
});

async function makeGroupNamed() {
  const { createClient } = await import("@/lib/setup");
  return db.$transaction(async (tx) => {
    const { client, entities } = await createClient(tx, g.firm.id, { name: "Grup Lain", industry: "agritech", entities: [{ name: "PT Lain", shortName: "PT Lain", kind: "PT", banks: [] }], rules: [] });
    return { client, pt: entities[0] };
  });
}
