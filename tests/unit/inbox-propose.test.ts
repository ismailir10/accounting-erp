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

  it("a multi-entity ledger proposes one company per entity label, the label as its short name (Chickin)", () => {
    const sheet = (name: string, entities: string[]) => ({ sheet: name, mode: "LEDGER" as const, rows: 100, periodStart: "2023-01-01", periodEnd: "2025-12-31", entities });
    const p = proposeClient([
      { fileName: "chickin.xlsx", kind: "LEDGER", status: "CHECKED", message: null, sections: [sheet("10_HC_GL_MASTER", ["HOLDCO"]), sheet("20_OPCO_GL_MASTER", ["SKP", "SPN", "CSP", "CAH", "skp"])] },
    ]);
    expect(p.entities.map((e) => [e.name, e.shortName, e.kind])).toEqual([
      ["HOLDCO", "HOLDCO", "PT"],
      ["SKP", "SKP", "PT"],
      ["SPN", "SPN", "PT"],
      ["CSP", "CSP", "PT"],
      ["CAH", "CAH", "PT"],
    ]);
    expect(p.entities.some((e) => e.fromClientName)).toBe(false);
    expect(p.readable).toBe(true);
  });

  it("a ledger label that is also a bank holder is one entity, with the label as its short name (review of #151)", () => {
    const gl = { sheet: "GL", mode: "LEDGER" as const, rows: 10, periodStart: "2026-01-01", periodEnd: "2026-06-30", entities: ["Belifi", "SKP"] };
    const p = proposeClient([bank("belifi.csv", section("BCA", "7655563814", "BELIFI PT")), { fileName: "gl.xlsx", kind: "LEDGER", status: "CHECKED", message: null, sections: [gl] }]);
    expect(p.entities.map((e) => [e.name, e.shortName, e.banks.length])).toEqual([["PT Belifi", "Belifi", 1], ["SKP", "SKP", 0]]);
    expect(p.entities[0].labelled).toBe(true);
  });

  it("a Neraca without an entity column names the company its title names, not the client (Goers)", () => {
    const neraca = { sheet: "31-05-2026", mode: "NERACA" as const, rows: 23, periodStart: "2026-05-31", periodEnd: "2026-05-31" };
    const p = proposeClient([
      { fileName: "balance_sheet.xlsx", kind: "LEDGER", status: "CHECKED", message: null, sections: [neraca], companyName: "SANRAYA ADI NATTAYA" },
      { fileName: "profit_loss.xlsx", kind: "OTHER", status: "KEPT", message: "Disimpan di Dokumen.", sections: [], companyName: "SANRAYA ADI NATTAYA" },
    ]);
    expect(p.entities).toEqual([{ key: expect.stringContaining("title:"), name: "Sanraya Adi Nattaya", shortName: "Sanraya Adi Nattaya", kind: "PT", banks: [] }]);
    expect(p.clientName).toBe("Sanraya Adi Nattaya");
  });

  it("a company named by a report and by a bank holder is one entity; a legal form in the title sets the kind", () => {
    const neraca = { sheet: "BS", mode: "NERACA" as const, rows: 148, periodStart: "2024-12-31", periodEnd: "2024-12-31" };
    const withBank = proposeClient([
      bank("fkm.csv", section("BCA", "1112223334", "FILOSOFI KOPI MANDIRI PT")),
      { fileName: "pl.xlsx", kind: "LEDGER", status: "CHECKED", message: null, sections: [neraca], companyName: "PT Filosofi Kopi Mandiri" },
    ]);
    expect(withBank.entities.map((e) => e.name)).toEqual(["PT Filosofi Kopi Mandiri"]);
    const cv = proposeClient([{ fileName: "n.xlsx", kind: "LEDGER", status: "CHECKED", message: null, sections: [neraca], companyName: "CV Maju Jaya" }]);
    expect(cv.entities[0]).toMatchObject({ name: "CV Maju Jaya", kind: "CV" });
  });

  it("says which months a rekening skips between its first and last statement (Belifi: Jun and Agu, no Jul)", () => {
    const month = (m: number) => bank(`bca-${m}.pdf`, section("BCA", "7655563814", "PT BELIFI", m));
    const gap = proposeClient([month(6), month(8)]);
    expect(gap.entities[0].banks[0].gaps).toEqual(["Jul 2026"]);
    expect(proposeClient([month(6), month(7), month(8)]).entities[0].banks[0].gaps).toEqual([]);
    expect(proposeClient([month(5), month(8)]).entities[0].banks[0].gaps).toEqual(["Jun–Jul 2026"]);
    expect(proposeClient([month(6)]).entities[0].banks[0].gaps).toEqual([]);
  });

  it("proposes nothing when nothing could be read", () => {
    const p = proposeClient([
      { fileName: "rusak.pdf", kind: "BANK", status: "FAILED", message: "Tanggal tidak terbaca.", sections: [] },
      { fileName: "foto.jpg", kind: "OTHER", status: "KEPT", message: "Disimpan di Dokumen.", sections: [] },
    ]);
    expect(p).toMatchObject({ readable: false, entities: [], clientName: "" });
  });
});
