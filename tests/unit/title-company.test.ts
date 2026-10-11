import { describe, expect, it } from "vitest";
import { companyFromTitleRows } from "@/lib/ledger-import/title";

const rows = (...r: (string | number | null)[][]) => r;

describe("company name from a report's title rows", () => {
  it("Jurnal.id: the company is the first line, above the report title (Goers' neraca, laba rugi, arus kas)", () => {
    expect(companyFromTitleRows(rows(["SANRAYA ADI NATTAYA"], ["Balance Sheet"], ["31/05/2026"], ["(in IDR)"], ["Date", null, "31/05/2026"], ["Assets"]))).toBe("SANRAYA ADI NATTAYA");
    expect(companyFromTitleRows(rows(["SANRAYA ADI NATTAYA"], ["Profit & Loss"], ["01/05/2026 - 31/05/2026"], ["(in IDR)"]))).toBe("SANRAYA ADI NATTAYA");
    expect(companyFromTitleRows(rows(["SANRAYA ADI NATTAYA"], ["Arus Kas"], ["01/01/2026 - 31/05/2026"]))).toBe("SANRAYA ADI NATTAYA");
  });

  it("a line with a legal form wins wherever it is among the title rows (Filosofi Kopi's P&L)", () => {
    expect(
      companyFromTitleRows(rows(["Profit Loss Report"], ["PT Filosofi Kopi Mandiri"], ["Generated", "11-04-2025 16:04:04"], ["Period", "2024"], ["Display Mode", "Show Position Only"])),
    ).toBe("PT Filosofi Kopi Mandiri");
    expect(companyFromTitleRows(rows(["Laporan Neraca"], ["CV Maju Jaya"], ["Per 31 Desember 2024"]))).toBe("CV Maju Jaya");
    expect(companyFromTitleRows(rows(["Chickin Technologies Pte Ltd"], ["Trial Balance"]))).toBe("Chickin Technologies Pte Ltd");
  });

  it("returns null when nothing in the title rows is a company (a bare ledger table, a report title alone, dates)", () => {
    expect(companyFromTitleRows(rows(["Date", "Account", "Debit", "Credit"], ["2026-01-01", "Kas", 1, null]))).toBeNull();
    expect(companyFromTitleRows(rows(["Balance Sheet"], ["31/05/2026"], ["Assets"]))).toBeNull();
    expect(companyFromTitleRows(rows(["31/05/2026"], ["Balance Sheet"]))).toBeNull();
    expect(companyFromTitleRows([])).toBeNull();
  });

  it("does not take the first line as a company unless a report title follows it", () => {
    expect(companyFromTitleRows(rows(["Catatan penting"], ["Kas"], ["Piutang"], ["Utang"], ["Modal"]))).toBeNull();
  });
});
