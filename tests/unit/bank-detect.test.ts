import { describe, expect, it } from "vitest";
import { BANKS, BANK_CODES, bankName, bankOfBic, bankOptions, detectBank } from "@/lib/banks";

/** A heading as each bank prints it above the transactions (synthetic, from the banks' documented statements). */
const HEADINGS: Record<string, string> = {
  BCA: "REKENING TAHAPAN\nPT BANK CENTRAL ASIA TBK\nNO. REKENING : 0000012345",
  MANDIRI: "e-Statement\nPT Bank Mandiri (Persero) Tbk\nNomor Rekening 1370000000000",
  BRI: "Rincian Rekening Koran\nPT. BANK RAKYAT INDONESIA (PERSERO) Tbk.",
  BNI: "ACCOUNT STATEMENT\nPT Bank Negara Indonesia (Persero) Tbk\nAccount No : 0000000000",
  BSI: "Laporan Rekening\nPT Bank Syariah Indonesia Tbk",
  BTN: "REKENING KORAN\nPT BANK TABUNGAN NEGARA (PERSERO) TBK",
  CIMB: "Account Statement\nPT Bank CIMB Niaga Tbk",
  PERMATA: "Mutasi Rekening PermataNet",
  DANAMON: "PT Bank Danamon Indonesia Tbk\nRekening Koran",
  OCBC: "OCBC Business · Account Statement",
  PANIN: "PaninBank Internet Banking - Mutasi Rekening",
  MAYBANK: "Maybank2E Account Statement",
  UOB: "UOB Infinity - Account Statement",
  MEGA: "Mega Internet Bisnis\nPT Bank Mega Tbk",
  SINARMAS: "PT Bank Sinarmas Tbk - Mutasi Rekening",
  SMBC: "Laporan Konsolidasi Rekening\nPT Bank SMBC Indonesia Tbk",
  JAGO: "PT Bank Jago Tbk\nKANTONG UTAMA",
  SEABANK: "REKENING KORAN\nNO. REKENING SEABANK: 9000000000",
  BLU: "blu by BCA Digital\nRekening Koran",
  DBS: "PT Bank DBS Indonesia · IDEAL",
  HSBC: "HSBCnet Account Statement",
  CITI: "Citibank N.A., Indonesia Branch · CitiDirect",
  DKI: "PT Bank DKI · Cash Management System",
  BJB: "PT Bank Pembangunan Daerah Jawa Barat dan Banten Tbk (bank bjb)",
  JATIM: "PT Bank Pembangunan Daerah Jawa Timur Tbk (Bank Jatim)",
};

describe("bank registry", () => {
  it("knows 25 banks, each with a picker name, a BIC and at least one format", () => {
    expect(BANKS).toHaveLength(25);
    expect(BANK_CODES).toHaveLength(26);
    expect(new Set(BANK_CODES).size).toBe(26);
    for (const b of BANKS) {
      expect(b.bic.every((x) => /^[A-Z0-9]{8}$/.test(x)), b.code).toBe(true);
      expect(b.formats.length, b.code).toBeGreaterThan(0);
    }
    expect(bankOptions().at(-1)).toEqual({ code: "GENERIC", name: "Bank lain", group: "Lainnya" });
    expect(bankName("GENERIC")).toBe("Bank lain");
    expect(bankName("CIMB")).toBe("CIMB Niaga");
  });

  it("tags each bank's heading with that bank", () => {
    for (const b of BANKS) expect(detectBank(HEADINGS[b.code]), b.code).toBe(b.code);
  });

  it("never takes a bank from a company name that holds a bank's word", () => {
    for (const company of ["PT Permata Hijau Sejahtera", "CV Mega Jaya Abadi", "Toko Jago Sepatu", "PT Panin Life", "UD Danamon Makmur", "PT Sinar Mas Agro", "CV Mandiri Sejahtera", "PT Blue Sky Logistik", "PT Jatim Prima", "PT Living Space Indonesia", "CV Kopramas"]) {
      expect(detectBank(`Rekening Koran\nNama : ${company}\nNo. Rekening : 0000123456`), company).toBe("GENERIC");
    }
  });

  it("tells blu (BCA Digital) from BCA and BSI (ex Bank Syariah Mandiri) from Mandiri", () => {
    expect(detectBank("blu by BCA Digital")).toBe("BLU");
    expect(detectBank("PT Bank Syariah Mandiri")).toBe("BSI");
    expect(detectBank("KlikBCA Bisnis")).toBe("BCA");
    // A BCA statement for a company whose name holds a Mandiri product word stays BCA.
    expect(detectBank("PT BANK CENTRAL ASIA TBK\nPT LIVING SPACE INDONESIA")).toBe("BCA");
    expect(detectBank("Livin' by Mandiri")).toBe("MANDIRI");
  });

  it.each(["Tabungan Mandiri", "Giro Mandiri", "Menara Mandiri 1 Jalan Jenderal Sudirman"])("detects a Mandiri header phrase %s", (header) => {
    expect(detectBank(`e-Statement\n${header}`)).toBe("MANDIRI");
  });
  it.each(["TAPLUS", "TAPLUS BISNIS", "TAPLUS MUDA"])("requires the wondr statement title together with the product %s", (product) => {
    expect(detectBank(`Laporan Mutasi Rekening\nBUDI CONTOH ${product} - 8311100000`)).toBe("BNI");
    expect(detectBank(`Rekening Koran\n${product} - 8311100000`)).toBe("GENERIC");
    expect(detectBank("Laporan Mutasi Rekening\nProduk tidak dikenal")).toBe("GENERIC");
  });

  it("names the bank of a SWIFT BIC, with or without a branch code", () => {
    expect(bankOfBic("CENAIDJA")).toBe("BCA");
    expect(bankOfBic("bmriidjaXXX")).toBe("MANDIRI");
    expect(bankOfBic("BNIAIDJA")).toBe("CIMB");
    expect(bankOfBic("ZZZZZZZZ")).toBeNull();
  });
});
