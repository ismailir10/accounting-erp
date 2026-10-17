import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { dateOnly } from "@/lib/format";
import { fakturAmounts, fakturParts, fakturXml, formatSen, MAX_PER_FILE, xmlText, type FakturXmlRow } from "@/lib/tax/coretax-faktur-xml";
import { npwp16, readNitku } from "@/lib/tax/coretax-codes";

// Coretax faktur keluaran XML (cycle 2026-10-17-coretax-files): DJP's element order, kode 04 arithmetic in bigint sen, files of 1,000.
const fixture = (name: string) => readFileSync(path.join(__dirname, "../fixtures/coretax", name), "utf8");
const tags = (xml: string) => [...xml.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<([A-Za-z]+)[\s/>]/g)].map((m) => m[1]);

const seller = { tin: "0012345678015000", idtku: "0012345678015000000000" };
const rows: FakturXmlRow[] = [
  {
    date: dateOnly(2026, 8, 5),
    ref: "INV-081",
    buyer: { document: "TIN", tin: "0987654321012000", idtku: "0987654321012000000000", name: "PT Mitra Unggas Sentosa", address: "", email: "" },
    item: { opt: "B", code: "000000", name: "Jasa konsultasi Agustus 2026", unit: "UM.0030" },
    dpp: 10_000_000n,
  },
  {
    date: dateOnly(2026, 8, 12),
    ref: "INV-082",
    buyer: { document: "National ID", nik: "3174061502560010", name: "Budi Santoso", address: "Jl. Kenanga No. 2, Jakarta", email: "budi@contoh.id" },
    item: { opt: "A", code: "000000", name: "Pakan ayam", unit: "UM.0003" },
    dpp: 1_000_001n,
  },
  {
    date: dateOnly(2026, 8, 31),
    ref: "INV-083/<R&D>",
    buyer: { document: "TIN", tin: "0111222333444000", idtku: "0111222333444000000001", name: "CV Tani & Ternak <Cabang>", address: "Jl. \"Raya\" 'Bogor'", email: "" },
    item: { opt: "B", code: "000000", name: "Sewa alat & mesin", unit: "UM.0024" },
    dpp: 999_999n,
  },
];

describe("faktur keluaran XML", () => {
  it("matches the golden file: NPWP buyer, NIK buyer, a name with & and <", () => {
    expect(fakturXml(seller, rows)).toBe(fixture("faktur-keluaran-golden.xml"));
  });

  it("writes DJP v1.4's element sequence for each faktur", () => {
    const djp = tags(fixture("djp-sample-v1.4-shape.xml"));
    expect(tags(fakturXml(seller, rows.slice(0, 1)))).toEqual(djp);
    const [head, invoice] = [djp.slice(0, 3), djp.slice(3)];
    expect(tags(fakturXml(seller, rows))).toEqual([...head, ...invoice, ...invoice, ...invoice]);
  });

  it("computes DPP Nilai Lain (11/12) and PPN (12 %) to the sen, half up, at edge DPPs", () => {
    const at = (dpp: bigint) => {
      const a = fakturAmounts(dpp);
      return [formatSen(a.taxBaseSen), formatSen(a.otherTaxBaseSen), formatSen(a.vatSen)];
    };
    expect(at(0n)).toEqual(["0", "0", "0"]);
    // 0.91666… → 0.92; 12 % = 0.1104 → 0.11.
    expect(at(1n)).toEqual(["1", "0.92", "0.11"]);
    // 10.08333… → 10.08; 1.2096 → 1.21.
    expect(at(11n)).toEqual(["11", "10.08", "1.21"]);
    // Exact: 916,665.75; 109,999.89.
    expect(at(999_999n)).toEqual(["999999", "916665.75", "109999.89"]);
    expect(at(10_000_000n)).toEqual(["10000000", "9166666.67", "1100000"]);
    // 10^12: 916,666,666,666.666… → .67; 110,000,000,000.0004 → 110,000,000,000 — beyond Number's exact range on the way.
    expect(at(1_000_000_000_000n)).toEqual(["1000000000000", "916666666666.67", "110000000000"]);
    // A whole-Rupiah DPP never lands on an exact half sen in either step (1100·DPP/12 and 12·sen/100 can't end in .5), so half up and
    // banker's rounding agree; the sen are always two digits.
    expect(at(7n)).toEqual(["7", "6.42", "0.77"]);
  });

  it("splits rows into files of at most 1,000, and refuses a bigger file", () => {
    const many = Array.from({ length: 2_345 }, (_, i) => ({ ...rows[0], ref: `INV-${i + 1}` }));
    const parts = fakturParts(many);
    expect(parts.map((p) => p.length)).toEqual([1000, 1000, 345]);
    expect(parts[2][0].ref).toBe("INV-2001");
    expect(fakturParts([])).toEqual([]);
    const xml = fakturXml(seller, parts[1], { index: 2, of: 3 });
    expect(xml).toContain("1000 faktur, bagian 2 dari 3.");
    expect(xml.match(/<TaxInvoice>/g)).toHaveLength(MAX_PER_FILE);
    expect(() => fakturXml(seller, many)).toThrow("Paling banyak 1000 faktur per file.");
  });

  it("escapes markup and drops characters XML can't hold", () => {
    expect(xmlText(`A & B <c> "d" 'e'`)).toBe("A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;");
    expect(xmlText("Toko\u0001 Maju\u0008")).toBe("Toko Maju");
    expect(xmlText("Kopi 😀")).toBe("Kopi 😀");
  });

  it("reads NPWP 15 → 16 digits and a NITKU against its NPWP", () => {
    expect(npwp16("01.234.567.8-015.000")).toBe("0012345678015000");
    expect(npwp16("0012 3456 7801 5000")).toBe("0012345678015000");
    expect(npwp16("1234")).toBeNull();
    expect(npwp16("01.234.567.8-015.00A")).toBeNull();
    expect(readNitku("", "0012345678015000", "pembeli")).toEqual({ ok: true, nitku: null });
    expect(readNitku("0012345678015000000000", "0012345678015000", "pembeli")).toEqual({ ok: true, nitku: null });
    expect(readNitku("0012345678015000000007", "0012345678015000", "pembeli")).toEqual({ ok: true, nitku: "0012345678015000000007" });
    expect(readNitku("0012345678015000000007", null, "pembeli")).toMatchObject({ ok: false });
  });
});
