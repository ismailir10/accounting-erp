import type { ItemKind } from "@/lib/tax/coretax-codes";

/**
 * The faktur keluaran import file of Coretax (*e-Faktur → Faktur Keluaran → Impor Data*): one `TaxInvoiceBulk` XML, elements in the order
 * of DJP's own sample (*Sample Faktur PK Template v.1.4.xml*, 2025-03-01) and filled by the rules of the v1.6.1 Excel template. Pure: a
 * company and its rows in, the XML text out. Cycle docs/cycles/2026-10-17-coretax-files.md.
 *
 * Every row is kode transaksi 04 (DPP Nilai Lain, PMK 131/2024): DPP Nilai Lain = 11/12 × DPP and PPN = 12 % × DPP Nilai Lain, each to
 * the sen, half up, in bigint sen (accounting-rules 6: never a float). One item per faktur: Qty 1, Price = DPP, no discount, no PPnBM.
 */
export const FORMAT_LABEL = "format DJP v1.4 / template 1.6.1";
/** Coretax takes at most 1,000 faktur per file. */
export const MAX_PER_FILE = 1000;
export const TRX_CODE = "04";
export const VAT_RATE = 12n;
/** REF-KodeNegara: IDN is Indonesia (DJP's v1.4 sample writes IND, which the same list names India). */
export const COUNTRY = "IDN";
/** *NPWP/NIK Pembeli* and *ID TKU Pembeli* of a buyer named by another document than an NPWP. */
export const NO_TIN = "0000000000000000";
export const NO_IDTKU = "000000";

export type FakturSeller = { tin: string; idtku: string };
export type FakturBuyer =
  | { document: "TIN"; tin: string; idtku: string; name: string; address: string; email: string }
  | { document: "National ID"; nik: string; name: string; address: string; email: string };
export type FakturXmlRow = {
  date: Date;
  /** *Referensi*: the invoice number. Coretax numbers the faktur itself. */
  ref: string;
  buyer: FakturBuyer;
  item: { opt: ItemKind; code: string; name: string; unit: string };
  /** Whole Rupiah (the entity's minor unit). */
  dpp: bigint;
};

/** Half up for a non-negative numerator: round(n / d). */
const halfUp = (n: bigint, d: bigint) => (2n * n + d) / (2n * d);

/** DPP Nilai Lain in sen: 11/12 of the DPP, half up. */
export const otherTaxBaseSen = (dpp: bigint) => halfUp(dpp * 100n * 11n, 12n);
/** PPN in sen: 12 % of DPP Nilai Lain (sen), half up — the template's own formula, the only value Coretax takes for kode 04. */
export const vatSen = (otherBaseSen: bigint) => halfUp(otherBaseSen * VAT_RATE, 100n);

export type FakturAmounts = { taxBaseSen: bigint; otherTaxBaseSen: bigint; vatSen: bigint };
export function fakturAmounts(dpp: bigint): FakturAmounts {
  if (dpp < 0n) throw new Error("DPP tidak boleh negatif.");
  const other = otherTaxBaseSen(dpp);
  return { taxBaseSen: dpp * 100n, otherTaxBaseSen: other, vatSen: vatSen(other) };
}

/** Sen as a decimal: whole amounts without decimals (as DJP's sample writes them), others with two. */
export function formatSen(sen: bigint): string {
  const neg = sen < 0n;
  const a = neg ? -sen : sen;
  const whole = (a / 100n).toString();
  const cents = a % 100n;
  return `${neg ? "-" : ""}${whole}${cents === 0n ? "" : `.${cents.toString().padStart(2, "0")}`}`;
}

export const iso = (d: Date) => d.toISOString().slice(0, 10);

/** XML 1.0 text: the five entities escaped, characters XML cannot hold (controls, lone surrogates) dropped. */
export function xmlText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** An element: text, children, or null for `xsi:nil="true"` (the root then declares the xsi namespace). Shared with the BPPU file. */
export type XmlNode = [name: string, value: string | XmlNode[] | null];
type Node = XmlNode;

/** Tab-indented like DJP's samples; an empty text element is self-closed, as there. */
export function writeXml(nodes: Node[], depth: number, out: string[]) {
  const pad = "\t".repeat(depth);
  for (const [name, value] of nodes) {
    if (value === null) out.push(`${pad}<${name} xsi:nil="true"/>`);
    else if (Array.isArray(value)) {
      out.push(`${pad}<${name}>`);
      writeXml(value, depth + 1, out);
      out.push(`${pad}</${name}>`);
    } else out.push(value === "" ? `${pad}<${name}/>` : `${pad}<${name}>${xmlText(value)}</${name}>`);
  }
}

function taxInvoice(seller: FakturSeller, r: FakturXmlRow): Node {
  const a = fakturAmounts(r.dpp);
  const b = r.buyer;
  const tin = b.document === "TIN";
  return [
    "TaxInvoice",
    [
      ["TaxInvoiceDate", iso(r.date)],
      ["TaxInvoiceOpt", "Normal"],
      ["TrxCode", TRX_CODE],
      ["AddInfo", ""],
      ["CustomDoc", ""],
      ["CustomDocMonthYear", ""],
      ["RefDesc", r.ref],
      ["FacilityStamp", ""],
      ["SellerIDTKU", seller.idtku],
      ["BuyerTin", tin ? b.tin : NO_TIN],
      ["BuyerDocument", b.document],
      ["BuyerCountry", COUNTRY],
      ["BuyerDocumentNumber", tin ? "-" : b.nik],
      ["BuyerName", b.name],
      // DJP's spelling.
      ["BuyerAdress", b.address],
      ["BuyerEmail", b.email],
      ["BuyerIDTKU", tin ? b.idtku : NO_IDTKU],
      [
        "ListOfGoodService",
        [
          [
            "GoodService",
            [
              ["Opt", r.item.opt],
              ["Code", r.item.code],
              ["Name", r.item.name],
              ["Unit", r.item.unit],
              ["Price", formatSen(a.taxBaseSen)],
              ["Qty", "1"],
              ["TotalDiscount", "0"],
              ["TaxBase", formatSen(a.taxBaseSen)],
              ["OtherTaxBase", formatSen(a.otherTaxBaseSen)],
              ["VATRate", VAT_RATE.toString()],
              ["VAT", formatSen(a.vatSen)],
              ["STLGRate", "0"],
              ["STLG", "0"],
            ],
          ],
        ],
      ],
    ],
  ];
}

/** One file: the seller and up to MAX_PER_FILE rows; `part` names its place when the masa needs several files. */
export function fakturXml(seller: FakturSeller, rows: FakturXmlRow[], part?: { index: number; of: number }): string {
  if (rows.length > MAX_PER_FILE) throw new Error(`Paling banyak ${MAX_PER_FILE} faktur per file.`);
  const out = [
    '<?xml version="1.0" encoding="utf-8" ?>',
    `<!-- Buku: faktur keluaran untuk impor Coretax, ${FORMAT_LABEL}, belum diuji dengan unggahan nyata. ${rows.length} faktur${part && part.of > 1 ? `, bagian ${part.index} dari ${part.of}` : ""}. -->`,
    '<TaxInvoiceBulk xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="TaxInvoice.xsd">',
  ];
  writeXml([["TIN", seller.tin], ["ListOfTaxInvoice", rows.map((r) => taxInvoice(seller, r))]], 1, out);
  out.push("</TaxInvoiceBulk>", "");
  return out.join("\n");
}

/** Rows in files of at most MAX_PER_FILE, in order. */
export function fakturParts<T>(rows: T[], size = MAX_PER_FILE): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < rows.length; i += size) parts.push(rows.slice(i, i + size));
  return parts;
}
