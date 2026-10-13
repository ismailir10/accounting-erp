import { describe, expect, it } from "vitest";
import { formatRupiah, MoneyError, moneyExample, parseMoney, parseRupiah, splitPpn } from "@/lib/money";

describe("parseRupiah", () => {
  it.each([
    ["1.234.567,00", 1234567n],
    ["1,234,567.00", 1234567n],
    ["1500000.00", 1500000n],
    ["2.500", 2500n],
    ["-2.500", -2500n],
    ["(2.500)", -2500n],
    ["Rp 10.000,50", 10001n],
    ["", 0n],
    ["999,99", 1000n],
  ])("%s → %s", (input, expected) => {
    expect(parseRupiah(input)).toBe(expected);
  });

  it("rejects garbage", () => {
    expect(() => parseRupiah("12a4")).toThrow();
  });
});

describe("splitPpn", () => {
  it("always sums back to gross", () => {
    for (const g of [111n, 1_110_000n, 12_345_679n, -5_550_000n, 1n]) {
      const { dpp, ppn } = splitPpn(g);
      expect(dpp + ppn).toBe(g);
    }
  });
  it("11% effective", () => {
    expect(splitPpn(11_100_000n)).toEqual({ dpp: 10_000_000n, ppn: 1_100_000n });
  });
});

describe("formatRupiah", () => {
  it("formats id-ID with accounting negatives", () => {
    expect(formatRupiah(1234567n)).toBe("Rp 1.234.567");
    expect(formatRupiah(-5000n, { accounting: true })).toBe("(Rp 5.000)");
  });
});

import { centsToMinor, formatMoney, parseCents, parseMinor, parseSubSen, roundEntry } from "@/lib/money";

describe("parseCents / parseMinor", () => {
  it("parses strings and spreadsheet floats to sen", () => {
    expect(parseCents("93,375,132.07")).toBe(9_337_513_207n);
    expect(parseCents("1.234.567,89")).toBe(123_456_789n);
    expect(parseCents("(2.500)")).toBe(-250_000n);
    expect(parseCents(93375132.07000001)).toBe(9_337_513_207n);
    expect(parseCents(-0.000004216837158203)).toBe(0n);
    expect(parseCents(0.0049)).toBe(0n);
    expect(parseCents(0.004999999)).toBe(1n); // float noise for 0.005
    expect(parseCents(0.0050000001)).toBe(1n);
    expect(parseCents("1500000")).toBe(150_000_000n);
  });
  it("rejects spreadsheet error cells and text", () => {
    for (const bad of ["#VALUE!", "#REF!", "#NAME?", "abc", "."]) expect(() => parseCents(bad)).toThrow(/tidak valid/);
  });
  it("converts sen to minor units by exponent", () => {
    expect(centsToMinor(150n, "IDR")).toBe(2n);
    expect(centsToMinor(149n, "IDR")).toBe(1n);
    expect(centsToMinor(-150n, "IDR")).toBe(-2n);
    expect(centsToMinor(4497n, "USD")).toBe(4497n);
    expect(parseMinor("12,750.00", "JPY")).toBe(12_750n);
  });
});

describe("one rounding of a sub-sen source amount (rule 6a; readiness finding F1, 2026-10-12)", () => {
  it("keeps the source amount exactly when it has digits beyond sen", () => {
    expect(parseSubSen(1234.497123)).toBe(1_234_497_123n); // a spreadsheet float with six real decimals
    expect(parseSubSen("1234.4951")).toBe(1_234_495_100n); // ("1234.495" alone reads as a thousands group, as before)
    expect(parseSubSen(-1234.497123)).toBe(-1_234_497_123n);
    expect(parseSubSen(1234.5)).toBeUndefined(); // sen are enough
    expect(parseSubSen(93375132.07000001)).toBeUndefined(); // float noise only
    expect(parseSubSen("1.234,497")).toBe(1_234_497_000n);
    expect(parseSubSen("abc")).toBeUndefined();
    expect(parseCents(1234.497123)).toBe(123450n); // sen are unchanged
  });

  it("roundEntry rounds the exact source amount once (no-sen and sen currencies alike)", () => {
    expect(roundEntry([123450n, -123450n], "IDR").rounded).toEqual([1235n, -1235n]); // sen only: a real half rounds up
    expect(roundEntry([123450n, -123450n], "IDR", [1_234_497_000n, -1_234_497_000n]).rounded).toEqual([1234n, -1234n]); // before: rounded twice
    expect(roundEntry([123450n], "JPY", [1_234_497_000n]).rounded).toEqual([1234n]);
    expect(roundEntry([123450n, -123450n], "SGD", [1_234_497_000n, -1_234_497_000n]).rounded).toEqual([123450n, -123450n]);
    expect(roundEntry([123449n], "IDR", [1_234_494_000n]).rounded).toEqual([1234n]);
    // The residue still goes to one 7190 line: 1.234,497 + 765,503 = 2.000,000.
    const r = roundEntry([123450n, 76550n, -200000n], "IDR", [1_234_497_000n, 765_503_000n, undefined]);
    expect(r.rounded).toEqual([1234n, 766n, -2000n]);
    expect(r.rounding).toBe(0n);
    // A sen currency: 0,505 − 10 + 9,495 = 0 in the source → 0,51 − 10,00 + 9,50 and −0,01 to 7190, not a 0,01 imbalance.
    const u = roundEntry([51n, -1000n, 950n], "USD", [505_000n, undefined, 9_495_000n]);
    expect(u).toEqual({ rounded: [51n, -1000n, 950n], rounding: -1n, total: 0n });
  });
});

describe("roundEntry (rule 6a)", () => {
  it("keeps Σ exact via one rounding residue", () => {
    // 3 lines of Rp 0.50 debit vs one Rp 1.50 credit: each rounds up, residue −1 on 7190
    const { rounded, rounding, total } = roundEntry([50n, 50n, 50n, -150n], "IDR");
    expect(rounded).toEqual([1n, 1n, 1n, -2n]);
    expect(total).toBe(0n);
    expect(rounded.reduce((s, r) => s + r, 0n) + rounding).toBe(total);
    expect(rounding).toBe(-1n);
  });
  it("no residue for 2-decimal currencies", () => {
    expect(roundEntry([4497n, -4497n], "SGD").rounding).toBe(0n);
  });
  it("reports an unbalanced total separately from rounding", () => {
    const r = roundEntry([500_000_000n, -1_000_000_000n], "IDR");
    expect(r.total).toBe(-5_000_000n);
    expect(r.rounding).toBe(0n);
  });
});

describe("formatMoney", () => {
  it("formats by currency, IDR unchanged", () => {
    expect(formatMoney(1_234_567n, "IDR")).toBe("Rp 1.234.567");
    expect(formatMoney(19_650_000n, "SGD")).toBe("S$ 196.500,00");
    expect(formatMoney(-4_497n, "USD", { accounting: true })).toBe("(US$ 44,97)");
    expect(formatMoney(5n, "SGD", { bare: true })).toBe("0,05");
    expect(formatMoney(12_750n, "JPY")).toBe("¥ 12.750");
  });
});

describe("parseMoney (typed major units → minor units of the entity currency)", () => {
  it.each([
    ["IDR", "", 0n],
    ["IDR", "   ", 0n],
    ["IDR", "100", 100n],
    ["IDR", "1500000", 1_500_000n],
    ["IDR", "1.500.000", 1_500_000n],
    ["IDR", " 12.500.000,00 ", 12_500_000n],
    ["IDR", "Rp 1.000", 1_000n],
    ["IDR", "Rp. 1.000", 1_000n],
    ["IDR", "idr 1.000", 1_000n],
    ["IDR", "-1.234", -1_234n],
    ["IDR", "(1.234)", -1_234n],
    ["JPY", "1.500", 1_500n],
    ["SGD", "100", 10_000n],
    ["SGD", "12,34", 1_234n],
    ["SGD", "12,3", 1_230n],
    ["SGD", "1.500.000,50", 150_000_050n],
    ["SGD", "1.000,00", 100_000n],
    ["SGD", "1.000,000", 100_000n],
    ["SGD", "S$ 100", 10_000n],
    ["SGD", "SGD 100", 10_000n],
    ["SGD", "-0,01", -1n],
    ["USD", "US$ 44,97", 4_497n],
    ["USD", "(44,97)", -4_497n],
  ])("%s %j → %s", (currency, input, expected) => {
    expect(parseMoney(input, currency)).toBe(expected);
  });

  it.each([
    ["IDR", "12a4"],
    ["IDR", "1.5"],
    ["IDR", "100.50"],
    ["IDR", "1500.000"],
    ["IDR", "1.50.000"],
    ["IDR", "1,234,567"],
    ["IDR", "1,234,567.00"],
    ["IDR", "1,2,3"],
    ["IDR", "--1"],
    ["IDR", "(-1)"],
    ["IDR", ","],
    ["IDR", ",50"],
    ["IDR", "S$ 100"],
    ["SGD", "Rp 100"],
    ["USD", "S$ 100"],
    ["SGD", "100.50"],
    ["SGD", "1e3"],
  ])("rejects %s %j as unreadable", (currency, input) => {
    expect(() => parseMoney(input, currency)).toThrow(MoneyError);
    expect(() => parseMoney(input, currency)).toThrow(/tidak bisa dibaca/);
  });

  it("rejects decimals the currency doesn't have, never rounds", () => {
    expect(() => parseMoney("100,5", "IDR")).toThrow('Rupiah tidak memakai angka desimal: "100,5".');
    expect(() => parseMoney("1.000,50", "IDR")).toThrow(MoneyError);
    expect(() => parseMoney("1,005", "SGD")).toThrow('Dolar Singapura paling banyak 2 angka di belakang koma: "1,005".');
  });

  it("gives an example in the entity's own notation", () => {
    expect(moneyExample("IDR")).toBe("1.250.000");
    expect(moneyExample("SGD")).toBe("1.250,50");
    expect(() => parseMoney("abc", "SGD")).toThrow("misalnya 1.250,50");
  });

  it("round-trips formatMoney output", () => {
    for (const currency of ["IDR", "SGD", "USD", "JPY"]) {
      for (const v of [0n, 1n, 99n, 100n, 123_456_789n, -1n, -100_001n]) {
        expect(parseMoney(formatMoney(v, currency, { bare: true }), currency)).toBe(v);
        expect(parseMoney(formatMoney(v, currency), currency)).toBe(v);
        expect(parseMoney(formatMoney(v, currency, { accounting: true }), currency)).toBe(v);
      }
    }
  });
});
