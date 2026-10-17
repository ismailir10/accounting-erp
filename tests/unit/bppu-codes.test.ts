import { describe, expect, it } from "vitest";
import { exactDpp, formatRate, KOPS, kopKind, listedKop, parseRate, pphOf, rateLabel, taxTies } from "@/lib/tax/bppu-codes";
import { kindOf } from "@/lib/tax/bupot-read";

// BPPU codes (cycle 2026-10-17-bppu-files): DJP's REF rates for the short list, rates in hundredths, the bigint tax check, the exact DPP.
describe("Kode Objek Pajak list", () => {
  it("carries the REF sheet v.3 rate and the kind of each code's first group", () => {
    const at = (code: string) => [listedKop(code)?.rate, listedKop(code)?.kind];
    expect(at("24-104-03")).toEqual([200, "PPH_23"]);
    expect(at("24-103-01")).toEqual([1500, "PPH_23"]);
    expect(at("24-102-01")).toEqual([1500, "PPH_23"]);
    expect(at("28-403-02")).toEqual([1000, "PPH_4_2"]);
    expect(at("28-409-22")).toEqual([175, "PPH_4_2"]);
    expect(at("28-409-23")).toEqual([400, "PPH_4_2"]);
    expect(at("28-409-24")).toEqual([265, "PPH_4_2"]);
    expect(at("22-900-01")).toEqual([150, "PPH_22"]);
    expect(listedKop("24-104-99")).toBeNull();
    expect(KOPS).toHaveLength(20);
    expect(new Set(KOPS.map((k) => k.code)).size).toBe(20);
    expect(KOPS.filter((k) => k.kind === "PPH_23").map((k) => k.rate)).toEqual([...Array(13).fill(200), 1500, 1500]);
  });

  it("reads the kind from the first group, the same way the Coretax slip reader does", () => {
    expect([kopKind("24-104-03"), kopKind("28-403-02"), kopKind("22-900-01"), kopKind("27-100-99"), kopKind("21-100-01")]).toEqual(["PPH_23", "PPH_4_2", "PPH_22", "PPH_26", null]);
    expect(kindOf("28-403-02", "PPh 23")).toBe("PPH_4_2");
    expect(kindOf("", "PPh 4(2) final")).toBe("PPH_4_2");
  });
});

describe("rates in hundredths of a percent", () => {
  it("parses up to two decimals, above 0 and at most 100", () => {
    expect(["2", "1,75", "0.5", "2.65", "10", "15", "100", " 1,5 % "].map(parseRate)).toEqual([200, 175, 50, 265, 1000, 1500, 10000, 150]);
    expect(["", "0", "0,00", "1,755", "101", "-2", "2,5,1", "dua"].map(parseRate)).toEqual(Array(8).fill(null));
  });

  it("writes DJP's dot decimal without trailing zeros", () => {
    expect([200, 50, 175, 265, 1000, 1500, 150, 5, 10000, 210].map(formatRate)).toEqual(["2", "0.5", "1.75", "2.65", "10", "15", "1.5", "0.05", "100", "2.1"]);
    expect(rateLabel(175)).toBe("1,75%");
  });
});

describe("DPP × rate against the withheld amount, in bigint", () => {
  it("ties within Rp 1 and refuses Rp 1 or more, at edge DPPs", () => {
    // 1 × 2 % = 0,02: within Rp 1 of 0 and of… nothing else.
    expect(taxTies(1n, 200, 0n)).toBe(true);
    expect(taxTies(1n, 200, 1n)).toBe(true);
    expect(taxTies(1n, 200, 2n)).toBe(false);
    // 999.999 × 2 % = 19.999,98.
    expect(taxTies(999_999n, 200, 20_000n)).toBe(true);
    expect(taxTies(999_999n, 200, 19_999n)).toBe(true);
    expect(taxTies(999_999n, 200, 19_998n)).toBe(false);
    expect(taxTies(999_999n, 200, 20_001n)).toBe(false);
    // 10^12 × 1,75 % = 17.500.000.000 exactly: Rp 1 either side is off.
    expect(taxTies(1_000_000_000_000n, 175, 17_500_000_000n)).toBe(true);
    expect(taxTies(1_000_000_000_000n, 175, 17_500_000_001n)).toBe(false);
    expect(taxTies(1_000_000_000_000n, 175, 17_499_999_999n)).toBe(false);
    // The PPN-split line of qa-tax-split: DPP 13.761.468 × 2 % = 275.229,36 vs 275.229.
    expect(taxTies(13_761_468n, 200, 275_229n)).toBe(true);
    expect(taxTies(13_761_718n, 200, 275_229n)).toBe(false); // off by Rp 5
  });

  it("rounds the slip's PPh half up for display", () => {
    expect([pphOf(10_000_000n, 200), pphOf(999_999n, 200), pphOf(13_761_468n, 200), pphOf(25n, 200), pphOf(75n, 200)]).toEqual([200_000n, 20_000n, 275_229n, 1n, 2n]);
  });

  it("prefills a DPP only when withheld ÷ rate is exact, never a rounded guess", () => {
    expect(exactDpp(200_000n, 200)).toBe(10_000_000n);
    expect(exactDpp(1_000_000n, 1000)).toBe(10_000_000n);
    expect(exactDpp(175_000n, 175)).toBe(10_000_000n);
    // 275.229 ÷ 1,75 % = 15.727.371,43…: refused, as is a zero withholding.
    expect(exactDpp(275_229n, 175)).toBeNull();
    expect(exactDpp(100n, 265)).toBeNull();
    expect(exactDpp(0n, 200)).toBeNull();
  });
});
