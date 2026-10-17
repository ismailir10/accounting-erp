import { formatRate, rateLabel, taxTies, type DocumentType } from "@/lib/tax/bppu-codes";
import { iso, writeXml, type XmlNode } from "@/lib/tax/coretax-faktur-xml";
import { formatRupiah } from "@/lib/money";

/**
 * The bukti potong Unifikasi import file of Coretax (*e-Bupot → BPPU → Impor Data*): one `BpuBulk` XML, elements in the order of DJP's own
 * sample (`bppu.xml`, 2024-11-07) and filled by the rules of the converter *BPPU Excel to XML v.3* (2025-09-04). Pure: a company and its
 * rows in, the XML text out. Cycle docs/cycles/2026-10-17-bppu-files.md.
 *
 * The file carries no PPh: Coretax computes it from DPP × Tarif. So every row must tie to the withholding the books hold (DPP × rate within
 * Rp 1 of it, bigint), or the builder refuses: the slip and the books stay equal. No facility, no government treasurer (constants).
 */
export const BPPU_FORMAT_LABEL = "format DJP bppu.xml / converter v.3";
export const NO_FACILITY = "N/A";
export const NO_GOV_TREASURER = "N/A";

/** The withholder: its NPWP16 (`TIN`) and NITKU (`IDPlaceOfBusinessActivity`, on every slip). */
export type BppuCompany = { tin: string; idtku: string };
export type BppuXmlRow = {
  /** The masa: the bank date's month (rule 5h counts withholding by bank date). */
  year: number;
  month: number;
  /** NPWP16 or NIK of the recipient, and its ID TKU. */
  counterpartTin: string;
  counterpartIdtku: string;
  kop: string;
  /** Whole Rupiah. */
  dpp: bigint;
  /** Hundredths of a percent. */
  rate: number;
  /** The line's withheld amount, never written: the tie check only. */
  withheld: bigint;
  document: DocumentType;
  documentNumber: string;
  documentDate: Date;
  /** The bank date. */
  withholdingDate: Date;
};

function bpu(company: BppuCompany, r: BppuXmlRow): XmlNode {
  if (r.dpp <= 0n) throw new Error("DPP bukti potong harus lebih dari nol.");
  if (!taxTies(r.dpp, r.rate, r.withheld)) throw new Error(`${rateLabel(r.rate)} × DPP ${formatRupiah(r.dpp)} tidak sama dengan PPh dipotong ${formatRupiah(r.withheld)}.`);
  return [
    "Bpu",
    [
      ["TaxPeriodMonth", String(r.month)],
      ["TaxPeriodYear", String(r.year)],
      ["CounterpartTin", r.counterpartTin],
      ["IDPlaceOfBusinessActivityOfIncomeRecipient", r.counterpartIdtku],
      ["TaxCertificate", NO_FACILITY],
      ["TaxObjectCode", r.kop],
      ["TaxBase", r.dpp.toString()],
      ["Rate", formatRate(r.rate)],
      ["Document", r.document],
      ["DocumentNumber", r.documentNumber],
      ["DocumentDate", iso(r.documentDate)],
      ["IDPlaceOfBusinessActivity", company.idtku],
      ["GovTreasurerOpt", NO_GOV_TREASURER],
      ["SP2DNumber", null],
      ["WithholdingDate", iso(r.withholdingDate)],
    ],
  ];
}

/** One file for a company and masa: DJP publishes no per-file limit for BPPU, and a company withholds tens of payments a month. */
export function bppuXml(company: BppuCompany, rows: BppuXmlRow[]): string {
  const out = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<!-- Buku: bukti potong PPh Unifikasi (BPPU) untuk impor Coretax, ${BPPU_FORMAT_LABEL}, belum diuji dengan unggahan nyata. ${rows.length} bukti potong. -->`,
    '<BpuBulk xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
  ];
  writeXml([["TIN", company.tin], ["ListOfBpu", rows.map((r) => bpu(company, r))]], 1, out);
  out.push("</BpuBulk>", "");
  return out.join("\n");
}
