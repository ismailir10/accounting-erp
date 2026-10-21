import { describe, expect, it } from "vitest";
import { categoryOf, compensate, share } from "@/lib/tax/categories";

describe("koreksi fiskal categories", () => {
  it.each([
    ["Beban Jamuan Tamu", "ENTERTAINMENT", 100],
    ["Beban Sumbangan", "DONATION", 100],
    ["Denda Pajak", "PENALTY", 100],
    ["Beban Pulsa & Telepon Seluler", "PHONE_VEHICLE", 50],
    ["Beban PPh 21 Ditanggung Perusahaan", "INCOME_TAX_EXPENSED", 100],
    ["Beban Penyisihan Piutang (CKPN)", "PROVISION", 100],
    ["Beban Imbalan Kerja", "EMPLOYEE_BENEFITS", 100],
  ])("%s → %s at %i %%", (name, key, percent) => expect(categoryOf(name)).toMatchObject({ key, percent }));

  it("leaves ordinary expenses alone", () => {
    for (const n of ["Beban Gaji & Tunjangan", "Beban Jasa Konsultan Pajak", "Beban Transportasi & Logistik", "Beban Kendaraan Operasional", "Beban Natura Karyawan"]) expect(categoryOf(n)).toBeNull();
  });

  it("takes a share half up", () => {
    expect(share(1_000_001n, 50)).toBe(500_001n);
    expect(share(3n, 50)).toBe(2n);
    expect(share(10_000_000n, 100)).toBe(10_000_000n);
  });
});

describe("kompensasi kerugian", () => {
  it("uses losses oldest first up to the fiscal profit and skips expired ones", () => {
    const r = compensate(70_000_000n, 2026, [
      { originYear: 2023, amount: 50_000_000n },
      { originYear: 2020, amount: 40_000_000n }, // expired after 2025
      { originYear: 2021, amount: 30_000_000n }, // last year of use
    ]);
    expect(r.used).toBe(70_000_000n);
    expect(r.rows.map((x) => [x.originYear, x.used, x.remaining, x.expired])).toEqual([
      [2020, 0n, 40_000_000n, true],
      [2021, 30_000_000n, 0n, false],
      [2023, 40_000_000n, 10_000_000n, false],
    ]);
  });

  it("uses nothing in a loss year", () => {
    expect(compensate(-5_000_000n, 2026, [{ originYear: 2024, amount: 1_000n }]).used).toBe(0n);
  });
});
