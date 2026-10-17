import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { dateOnly } from "@/lib/format";
import { bppuXml, type BppuXmlRow } from "@/lib/tax/coretax-bppu-xml";

// Coretax BPPU XML (cycle 2026-10-17-bppu-files): DJP's bppu.xml element order, constants, dot-decimal rates, the bigint tie to the books.
const fixture = (name: string) => readFileSync(path.join(__dirname, "../fixtures/coretax", name), "utf8");
const tags = (xml: string) => [...xml.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<([A-Za-z0-9]+)[\s/>]/g)].map((m) => m[1]);

const company = { tin: "0012345678015000", idtku: "0012345678015000000000" };
const rows: BppuXmlRow[] = [
  {
    // An NPWP recipient (a 15-digit NPWP written as 16) at its head office.
    year: 2026,
    month: 8,
    counterpartTin: "0098765432101200",
    counterpartIdtku: "0098765432101200000000",
    kop: "24-104-03",
    dpp: 10_000_000n,
    rate: 200,
    withheld: 200_000n,
    document: "CommercialInvoice",
    documentNumber: "INV-77",
    documentDate: dateOnly(2026, 8, 15),
    withholdingDate: dateOnly(2026, 8, 21),
  },
  {
    // A NIK recipient: the NIK with NIK + 000000 as its ID TKU (DJP's sample).
    year: 2026,
    month: 8,
    counterpartTin: "3174061502560010",
    counterpartIdtku: "3174061502560010000000",
    kop: "28-403-02",
    dpp: 10_000_000n,
    rate: 1000,
    withheld: 1_000_000n,
    document: "Contract",
    documentNumber: "SPK/08/2026",
    documentDate: dateOnly(2026, 8, 1),
    withholdingDate: dateOnly(2026, 8, 25),
  },
  {
    // A construction slip at 1,75 % with a document number holding & and <.
    year: 2026,
    month: 8,
    counterpartTin: "0111222333444000",
    counterpartIdtku: "0111222333444000000001",
    kop: "28-409-22",
    dpp: 15_727_371n,
    rate: 175,
    withheld: 275_229n,
    document: "CommercialInvoice",
    documentNumber: "B&R <08>/2026",
    documentDate: dateOnly(2026, 8, 31),
    withholdingDate: dateOnly(2026, 8, 31),
  },
];

describe("BPPU XML", () => {
  it("matches the golden file: NPWP recipient, NIK recipient, a document number with & and <", () => {
    expect(bppuXml(company, rows)).toBe(fixture("bppu-golden.xml"));
  });

  it("writes DJP bppu.xml's element sequence for each slip", () => {
    const djp = tags(fixture("djp-bppu-shape.xml"));
    expect(tags(bppuXml(company, rows.slice(0, 1)))).toEqual(djp);
    const [head, slip] = [djp.slice(0, 3), djp.slice(3)];
    expect(tags(bppuXml(company, rows))).toEqual([...head, ...slip, ...slip, ...slip]);
  });

  it("writes the constants, the masa without a leading zero, yyyy-mm-dd dates and whole-Rupiah DPP", () => {
    const xml = bppuXml(company, [{ ...rows[0], month: 3, dpp: 1n, withheld: 0n, rate: 50, withholdingDate: dateOnly(2026, 3, 2), documentDate: dateOnly(2026, 2, 27) }]);
    expect(xml).toContain("<TaxPeriodMonth>3</TaxPeriodMonth>\n\t\t\t<TaxPeriodYear>2026</TaxPeriodYear>");
    expect(xml).toContain("<TaxCertificate>N/A</TaxCertificate>");
    expect(xml).toContain("<TaxBase>1</TaxBase>\n\t\t\t<Rate>0.5</Rate>");
    expect(xml).toContain("<DocumentDate>2026-02-27</DocumentDate>\n\t\t\t<IDPlaceOfBusinessActivity>0012345678015000000000</IDPlaceOfBusinessActivity>");
    expect(xml).toContain('<GovTreasurerOpt>N/A</GovTreasurerOpt>\n\t\t\t<SP2DNumber xsi:nil="true"/>\n\t\t\t<WithholdingDate>2026-03-02</WithholdingDate>');
    expect(xml).toContain("<!-- Buku: bukti potong PPh Unifikasi (BPPU) untuk impor Coretax, format DJP bppu.xml / converter v.3, belum diuji dengan unggahan nyata. 1 bukti potong. -->");
    // No element for the PPh: Coretax computes it.
    expect(xml).not.toMatch(/<(Pph|PPh|Tax)>/);
    expect(bppuXml(company, [])).toContain("<ListOfBpu>\n\t</ListOfBpu>");
  });

  it("writes rates as DJP's dot decimals: 2, 0.5, 1.75, 2.65", () => {
    const rate = (r: number, dpp: bigint, withheld: bigint) => bppuXml(company, [{ ...rows[0], rate: r, dpp, withheld }]).match(/<Rate>(.*)<\/Rate>/)![1];
    expect([rate(200, 100n, 2n), rate(50, 400n, 2n), rate(175, 400n, 7n), rate(265, 1000n, 26n), rate(1500, 100n, 15n)]).toEqual(["2", "0.5", "1.75", "2.65", "15"]);
  });

  it("refuses a row whose DPP × rate does not tie to the withheld amount within Rp 1, at edges", () => {
    const one = (dpp: bigint, rate: number, withheld: bigint) => () => bppuXml(company, [{ ...rows[0], dpp, rate, withheld }]);
    expect(one(1n, 200, 0n)).not.toThrow();
    expect(one(999_999n, 200, 19_999n)).not.toThrow();
    expect(one(999_999n, 200, 19_998n)).toThrow("2% × DPP Rp 999.999 tidak sama dengan PPh dipotong Rp 19.998.");
    expect(one(1_000_000_000_000n, 200, 20_000_000_000n)).not.toThrow();
    expect(one(1_000_000_000_000n, 200, 20_000_000_001n)).toThrow();
    expect(one(0n, 200, 0n)).toThrow("DPP bukti potong harus lebih dari nol.");
  });
});
