import { describe, expect, it } from "vitest";
import type { BankSection } from "@/lib/inbox/check";
import { CLIENT_KEY, entityName, proposeClient, shortNameOf, type PreviewFile } from "@/lib/inbox/propose";

/** One statement as the preview reads it; holders as #143's readers will print them. */
const section = (bank: string, number: string | null, holder: string | null, month = 6, extra: Partial<BankSection> = {}): BankSection => ({
  bank,
  number,
  holder,
  currency: "IDR",
  periodStart: `2026-${String(month).padStart(2, "0")}-01`,
  periodEnd: `2026-${String(month).padStart(2, "0")}-30`,
  rows: 3,
  opening: "1000000",
  closing: "1500000",
  error: null,
  ...extra,
});
const bank = (fileName: string, ...sections: BankSection[]): PreviewFile => ({ fileName, kind: "BANK", status: "CHECKED", message: null, sections });

describe("Klien baru from files: the proposal", () => {
  it("groups rekening by holder: a company and its owner, companies first", () => {
    const p = proposeClient([
      bank("budi-bca.csv", section("BCA", "1112223334", "BUDI SANTOSO")),
      bank("belifi-bca-jun.csv", section("BCA", "6044551270", "BELIFI MAHAJAYA NUSANTARA PT")),
      bank("belifi-mandiri.pdf", section("MANDIRI", "1230007654321", "PT. Belifi Mahajaya Nusantara")),
    ]);
    expect(p.clientName).toBe("PT Belifi Mahajaya Nusantara");
    expect(p.entities.map((e) => [e.name, e.shortName, e.kind, e.banks.map((b) => b.display)])).toEqual([
      ["PT Belifi Mahajaya Nusantara", "PT Belifi", "PT", ["BCA ·1270", "Mandiri ·4321"]],
      ["Budi Santoso", "Budi", "PERORANGAN", ["BCA ·3334"]],
    ]);
    expect(p.readable).toBe(true);
    expect(p.unread).toEqual([]);
  });

  it("treats spacing, case, punctuation, word order and the PT prefix as the same holder", () => {
    const p = proposeClient([
      bank("a.csv", section("BCA", "1111111111", "PT  MAJU   JAYA")),
      bank("b.csv", section("BRI", "2222222222", "maju jaya")),
      bank("c.csv", section("BNI", "3333333333", "Jaya Maju, P.T.")),
      bank("d.csv", section("BCA", "4444444444", "budi santoso")),
      bank("e.csv", section("BRI", "5555555555", "SANTOSO BUDI")),
    ]);
    expect(p.entities.map((e) => [e.name, e.kind, e.banks.length])).toEqual([
      ["PT Maju Jaya", "PT", 3],
      ["Budi Santoso", "PERORANGAN", 2],
    ]);
  });

  it("names the legal form a CV holder prints", () => {
    const p = proposeClient([bank("a.csv", section("BCA", "1111111111", "CV SINAR TERANG"))]);
    expect(p.entities[0]).toMatchObject({ name: "CV Sinar Terang", shortName: "CV Sinar", kind: "CV" });
    expect(entityName("budi  santoso")).toBe("Budi Santoso");
    expect(shortNameOf("Budi Santoso", "PERORANGAN")).toBe("Budi");
    expect(shortNameOf("Klien Maju Bersama", "PT")).toBe("Klien Maju Bersama");
  });

  it("without holders proposes one company named after the client, with every rekening", () => {
    const p = proposeClient([
      bank("bca-jun.csv", section("BCA", "6044551270", null, 6)),
      bank("bca-jul.csv", section("BCA", "6044551270", null, 7)),
      bank("mandiri.pdf", section("MANDIRI", "1230007654321", null, 7)),
    ]);
    expect(p.clientName).toBe("");
    expect(p.entities).toHaveLength(1);
    expect(p.entities[0]).toMatchObject({ key: CLIENT_KEY, name: "", kind: "PT", fromClientName: true });
    // One rekening however many months carry it.
    expect(p.entities[0].banks.map((b) => [b.display, b.number, b.months, b.fileNames])).toEqual([
      ["BCA ·1270", "6044551270", "Jun–Jul 2026", ["bca-jun.csv", "bca-jul.csv"]],
      ["Mandiri ·4321", "1230007654321", "Jul 2026", ["mandiri.pdf"]],
    ]);
  });

  it("puts a rekening without a holder under the company the other files name", () => {
    const p = proposeClient([bank("a.csv", section("BCA", "1111111111", "PT MAJU JAYA")), bank("b.csv", section("BRI", "2222222222", null)), bank("c.csv", section("BNI", "3333333333", "BUDI"))]);
    expect(p.entities.map((e) => [e.name, e.banks.map((b) => b.number)])).toEqual([
      ["PT Maju Jaya", ["1111111111", "2222222222"]],
      ["Budi", ["3333333333"]],
    ]);
  });

  it("dedupes a rekening by bank and digits, takes a holder from any of its files", () => {
    const p = proposeClient([bank("jun.csv", section("BCA", "604-455-1270", null, 6)), bank("jul.csv", section("BCA", "6044551270", "PT MAJU JAYA", 7))]);
    expect(p.entities).toHaveLength(1);
    expect(p.entities[0]).toMatchObject({ name: "PT Maju Jaya", kind: "PT" });
    expect(p.entities[0].banks).toHaveLength(1);
    expect(p.entities[0].banks[0]).toMatchObject({ number: "6044551270", holder: "PT MAJU JAYA", fileNames: ["jun.csv", "jul.csv"] });
  });

  it("marks a rekening with a negative balance as PRK", () => {
    const p = proposeClient([bank("prk.csv", section("BCA", "1111111111", null, 6, { opening: "-5000000", closing: "-4000000" })), bank("giro.csv", section("BRI", "2222222222", null))]);
    expect(p.entities[0].banks.map((b) => [b.display, b.isOverdraft])).toEqual([
      ["BCA ·1111", true],
      ["BRI ·2222", false],
    ]);
  });

  it("lists foreign-currency rekening without creating them", () => {
    const p = proposeClient([bank("smbc.pdf", section("SMBC", "90022152088", "PT MAJU JAYA"), section("SMBC", "90022164251", "PT MAJU JAYA", 6, { currency: "USD", error: "Rekening valas" }))]);
    expect(p.entities[0].banks.map((b) => b.number)).toEqual(["90022152088"]);
    expect(p.valas).toEqual([{ key: "SMBC|90022164251", display: "SMBC ·4251", currency: "USD", fileNames: ["smbc.pdf"] }]);
  });

  it("says what it couldn't read and lists ledgers and other documents for Dokumen", () => {
    const p = proposeClient([
      { fileName: "terkunci.pdf", kind: "BANK", status: "NEEDS_PASSWORD", message: "PDF ini dikunci kata sandi.", sections: [] },
      { fileName: "rusak.pdf", kind: "BANK", status: "FAILED", message: "Tanggal tidak terbaca.", sections: [] },
      { fileName: "gl.xlsx", kind: "LEDGER", status: "CHECKED", message: null, sections: [{ sheet: "GL", mode: "LEDGER", rows: 10, periodStart: "2025-01-01", periodEnd: "2025-12-31" }] },
      { fileName: "faktur.pdf", kind: "OTHER", status: "KEPT", message: "Disimpan di Dokumen.", sections: [] },
      bank("tanpa-nomor.pdf", section("BNI", null, null)),
    ]);
    expect(p.unread).toEqual([
      { fileName: "terkunci.pdf", reason: "PDF ini dikunci kata sandi." },
      { fileName: "rusak.pdf", reason: "Tanggal tidak terbaca." },
      { fileName: "tanpa-nomor.pdf", reason: expect.stringContaining("ditanyakan di Unggah") },
    ]);
    expect(p.documents).toEqual(["gl.xlsx", "faktur.pdf"]);
    // A ledger is enough to start the client: one company named after it, without rekening.
    expect(p.readable).toBe(true);
    expect(p.entities).toEqual([{ key: CLIENT_KEY, name: "", shortName: "", kind: "PT", fromClientName: true, banks: [] }]);
  });

  it("proposes nothing when nothing could be read", () => {
    const p = proposeClient([
      { fileName: "rusak.pdf", kind: "BANK", status: "FAILED", message: "Tanggal tidak terbaca.", sections: [] },
      { fileName: "foto.jpg", kind: "OTHER", status: "KEPT", message: "Disimpan di Dokumen.", sections: [] },
    ]);
    expect(p).toMatchObject({ readable: false, entities: [], clientName: "" });
  });
});
