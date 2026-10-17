import type { BupotKind } from "@/lib/tax/bupot-read";

/**
 * Codes of DJP's bukti potong Unifikasi import (BPPU, converter *BPPU Excel to XML v.3*, sheets BPPU and REF), read on 2026-10-17. Pure,
 * so the slip form, the pre-flight and the file builder share them. Cycle docs/cycles/2026-10-17-bppu-files.md.
 *
 * Rates are integers in hundredths of a percent (2 % = 200, 1,75 % = 175), never a float: the tax check is bigint (accounting-rules 6).
 */

/** The withholding kinds a BPPU slip covers. PPh 21 is e-Bupot 21/26, never this file. */
export type SlipKind = "PPH_23" | "PPH_4_2" | "PPH_22";
export const SLIP_KINDS: SlipKind[] = ["PPH_23", "PPH_4_2", "PPH_22"];
export const isSlipKind = (k: string | null | undefined): k is SlipKind => k === "PPH_23" || k === "PPH_4_2" || k === "PPH_22";
export const SLIP_KIND_LABEL: Record<SlipKind, string> = { PPH_23: "PPh 23", PPH_4_2: "PPh 4(2)", PPH_22: "PPh 22" };

export type Kop = { code: string; name: string; rate: number; kind: SlipKind };

/** The short list offered per kind, each with the REF sheet's rate (v.3). Anything else is *Kode lain* with a typed rate. */
export const KOPS: Kop[] = (
  [
    ["24-104-01", "Jasa teknik", 200],
    ["24-104-02", "Jasa manajemen", 200],
    ["24-104-03", "Jasa konsultan", 200],
    ["24-104-06", "Jasa akuntansi, pembukuan dan atestasi", 200],
    ["24-104-07", "Jasa hukum", 200],
    ["24-104-17", "Jasa penyedia tenaga kerja (outsourcing)", 200],
    ["24-104-24", "Jasa software/hardware", 200],
    ["24-104-29", "Perawatan mesin/peralatan", 200],
    ["24-104-30", "Perawatan kendaraan", 200],
    ["24-104-36", "Jasa kebersihan", 200],
    ["24-104-39", "Jasa katering", 200],
    ["24-104-56", "Jasa pengangkutan/ekspedisi", 200],
    ["24-100-02", "Sewa harta selain tanah/bangunan", 200],
    ["24-103-01", "Royalti", 1500],
    ["24-102-01", "Bunga", 1500],
    ["28-403-02", "Sewa tanah dan/atau bangunan", 1000],
    ["28-409-22", "Konstruksi, kualifikasi kecil", 175],
    ["28-409-23", "Konstruksi, tanpa sertifikat", 400],
    ["28-409-24", "Konstruksi, sertifikat selain kecil", 265],
    ["22-900-01", "Pembelian barang oleh BUMN/badan usaha tertentu", 150],
  ] as const
).map(([code, name, rate]) => ({ code, name, rate, kind: kopKind(code) as SlipKind }));

export const KOP_CODE = /^\d{2}-\d{3}-\d{2}$/;
export const listedKop = (code: string | null | undefined) => KOPS.find((k) => k.code === code) ?? null;
/** The kind a Kode Objek Pajak stands for, from its first group (24 = PPh 23, 28 = 4(2), 22, 27 = 26); null for any other. The slip reader uses it too. */
export function kopKind(code: string): BupotKind | null {
  const k = code.replace(/\s/g, "").match(/^(\d{2})/)?.[1];
  return k === "24" ? "PPH_23" : k === "28" ? "PPH_4_2" : k === "22" ? "PPH_22" : k === "27" ? "PPH_26" : null;
}

/** *Jenis Dok. Referensi*: the four spelled the same in DJP's XSD and its REF sheet. */
export const DOCUMENT_TYPES = ["CommercialInvoice", "TaxInvoice", "Contract", "PaymentProof"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const isDocumentType = (s: string | null | undefined): s is DocumentType => DOCUMENT_TYPES.includes(s as DocumentType);
export const DOCUMENT_LABEL: Record<DocumentType, string> = { CommercialInvoice: "Surat tagihan / invoice", TaxInvoice: "Faktur pajak", Contract: "Kontrak", PaymentProof: "Bukti pembayaran" };
/** A faktur pajak number: 16 or 17 digits (Coretax checks that it exists; Buku can't). */
export const FAKTUR_NUMBER = /^\d{16,17}$/;
export const DOCUMENT_NUMBER_MAX = 100;

/** A typed percentage ("2", "1,75", "0.5") in hundredths: up to 2 decimals, above 0 and at most 100. Else null. */
export function parseRate(raw: string | null | undefined): number | null {
  const m = (raw ?? "").trim().replace(/\s*%$/, "").match(/^(\d{1,3})(?:[.,](\d{1,2}))?$/);
  if (!m) return null;
  const r = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return r > 0 && r <= 10_000 ? r : null;
}

/** Hundredths as DJP writes `Rate`: a dot decimal without trailing zeros (200 → "2", 50 → "0.5", 175 → "1.75"). */
export function formatRate(r: number): string {
  const whole = Math.trunc(r / 100);
  const frac = (r % 100).toString().padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** The same, as shown on screen ("1,75%"). */
export const rateLabel = (r: number) => `${formatRate(r).replace(".", ",")}%`;

/** DPP × rate in exact ten-thousandths of a Rupiah. */
const exact = (dpp: bigint, rate: number) => dpp * BigInt(rate);

/** DPP × rate, half up to the Rupiah: what the slip says is withheld. */
export const pphOf = (dpp: bigint, rate: number) => (exact(dpp, rate) * 2n + 10_000n) / 20_000n;

/** The slip and the books agree: DPP × rate is within Rp 1 (strictly) of the withheld amount, computed exactly in bigint. */
export function taxTies(dpp: bigint, rate: number, withheld: bigint): boolean {
  const diff = exact(dpp, rate) - withheld * 10_000n;
  return diff > -10_000n && diff < 10_000n;
}

/** withheld ÷ rate when it divides exactly into whole Rupiah; never a rounded guess (it would always pass `taxTies`). */
export function exactDpp(withheld: bigint, rate: number): bigint | null {
  const n = withheld * 10_000n;
  return n > 0n && n % BigInt(rate) === 0n ? n / BigInt(rate) : null;
}
