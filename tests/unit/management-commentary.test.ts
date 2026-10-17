import { describe, expect, it } from "vitest";
import { commentary, percentOf, type ManagementSummary } from "@/lib/reports/management";

const base = (over: Partial<ManagementSummary> = {}): ManagementSummary => ({
  period: { year: 2026, month: 8 },
  previous: { year: 2026, month: 7 },
  currency: "IDR",
  month: { revenue: 112_500_000n, grossProfit: 40_000_000n, netProfit: 15_000_000n, cash: 80_000_000n },
  last: { revenue: 100_000_000n, grossProfit: 35_000_000n, netProfit: 12_000_000n, cash: 95_000_000n },
  ytd: { revenue: 800_000_000n, grossProfit: 300_000_000n, netProfit: 90_000_000n },
  movers: [],
  changes: [],
  baseline: [],
  ...over,
});

describe("percentOf", () => {
  it("one decimal, signed, null without a positive base", () => {
    expect(percentOf(12_500_000n, 100_000_000n)).toBe("12,5 %");
    expect(percentOf(-5n, 100n)).toBe("−5,0 %");
    expect(percentOf(5n, 0n)).toBeNull();
  });
});

describe("commentary", () => {
  it("says up and down as they are, with amounts and the margin", () => {
    expect(commentary(base())).toEqual([
      "Pendapatan Agustus 2026 Rp 112.500.000, naik Rp 12.500.000 (12,5 %) dari Juli 2026.",
      "Laba bersih bulan ini Rp 15.000.000, margin bersih 13,3 %.",
      "Kas & bank akhir bulan Rp 80.000.000, berkurang Rp 15.000.000 dari akhir Juli 2026.",
    ]);
    const down = commentary(base({ month: { revenue: 90_000_000n, grossProfit: 0n, netProfit: -4_000_000n, cash: 95_000_000n } }));
    expect(down[0]).toBe("Pendapatan Agustus 2026 Rp 90.000.000, turun Rp 10.000.000 (10,0 %) dari Juli 2026.");
    expect(down[1]).toBe("Bulan ini rugi bersih Rp 4.000.000.");
    expect(down[2]).toBe("Kas & bank akhir bulan tetap Rp 95.000.000.");
  });

  it("no revenue either month; movers named with their baseline", () => {
    const s = commentary(
      base({
        month: { revenue: 0n, grossProfit: 0n, netProfit: -1_000n, cash: 0n },
        last: { revenue: 0n, grossProfit: 0n, netProfit: 0n, cash: 0n },
        movers: [{ code: "6100", name: "Beban Gaji", type: "BEBAN", current: 30_000_000n, average: 18_000_000n, delta: 12_000_000n }],
      }),
    );
    expect(s[0]).toBe("Belum ada pendapatan tercatat di Agustus 2026 maupun Juli 2026.");
    expect(s[s.length - 1]).toBe("6100 Beban Gaji: Rp 30.000.000 bulan ini, lebih tinggi Rp 12.000.000 dari rata-rata bulan sebelumnya (Rp 18.000.000).");
  });
});
