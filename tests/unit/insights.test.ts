import { describe, expect, it } from "vitest";
import { margins, runOf, trend, type Figures } from "@/lib/reports/insights";
import { formatMonthShort } from "@/lib/format";

// Wawasan (cycle 2026-10-17-wawasan-keuangan): trend and margin findings on fixed monthly statements, true in either direction.
const J = 1_000_000n;
const months = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ year: 2026, month: from + i, key: `2026-${String(from + i).padStart(2, "0")}`, label: formatMonthShort(2026, from + i) }));
/** A month from revenue and cost of sales (operating expenses 10 jt, no other items or tax). */
const fig = (revenue: bigint, cogs: bigint, opex = 10n * J): Figures => ({ revenue, cogs, grossProfit: revenue - cogs, operatingProfit: revenue - cogs - opex, netProfit: revenue - cogs - opex });
const sum = (xs: Figures[]): Figures => xs.reduce((a, b) => ({ revenue: a.revenue + b.revenue, cogs: a.cogs + b.cogs, grossProfit: a.grossProfit + b.grossProfit, operatingProfit: a.operatingProfit + b.operatingProfit, netProfit: a.netProfit + b.netProfit }));

describe("runOf", () => {
  it("counts months moving the same way through the last, from 2", () => {
    expect(runOf([1n, 2n, 3n, 4n])).toEqual({ up: true, months: 3 });
    expect(runOf([5n, 1n, 2n])).toBeNull();
    expect(runOf([9n, 5n, 3n])).toEqual({ up: false, months: 2 });
    expect(runOf([1n, 3n, 3n])).toBeNull();
    expect(runOf([4n])).toBeNull();
  });
});

describe("trend", () => {
  it("a rising year: last month, the average, the run, highest and lowest", () => {
    const f = [fig(100n * J, 60n * J), fig(110n * J, 64n * J), fig(120n * J, 66n * J), fig(150n * J, 80n * J)];
    const t = trend(months(4), f, "IDR");
    const net = t.metrics.find((m) => m.key === "netProfit")!;
    expect(net).toMatchObject({ current: 60n * J, previous: 44n * J, change: 16n * J, changePercent: "36,3 %", average: 36_666_666n, run: { up: true, months: 3 } });
    expect(net.high).toMatchObject({ key: "2026-04", value: 60n * J });
    expect(net.low).toMatchObject({ key: "2026-01", value: 30n * J });
    expect(t.sentence).toBe("Pendapatan April 2026 Rp 150.000.000, naik 25,0 % dari Maret 2026; laba bersih Rp 60.000.000, naik 36,3 % dari Maret 2026 dan naik 3 bulan berturut-turut.");
  });

  it("a falling year says turun, into a loss", () => {
    const f = [fig(150n * J, 80n * J), fig(120n * J, 70n * J), fig(100n * J, 95n * J)];
    const t = trend(months(3), f, "IDR");
    const net = t.metrics.find((m) => m.key === "netProfit")!;
    expect(net).toMatchObject({ current: -5n * J, change: -45n * J, run: { up: false, months: 2 } });
    expect(net.high.key).toBe("2026-01");
    expect(net.low.key).toBe("2026-03");
    expect(t.sentence).toBe("Pendapatan Maret 2026 Rp 100.000.000, turun 16,6 % dari Februari 2026; rugi bersih Rp 5.000.000, turun 112,5 % dari Februari 2026 dan turun 2 bulan berturut-turut.");
    expect(t.sentence).not.toMatch(/naik/);
  });

  it("a flat month says sama dengan; a zero last month falls back to the amount", () => {
    const flat = trend(months(2), [fig(100n * J, 50n * J), fig(100n * J, 50n * J)], "IDR");
    expect(flat.sentence).toBe("Pendapatan Februari 2026 Rp 100.000.000, sama dengan Januari 2026; laba bersih Rp 40.000.000, sama dengan Januari 2026.");
    expect(flat.metrics[0].run).toBeNull();
    const fromZero = trend(months(2), [fig(0n, 0n, 0n), fig(50n * J, 0n, 0n)], "IDR");
    expect(fromZero.metrics[0].changePercent).toBeNull();
    expect(fromZero.sentence).toMatch(/^Pendapatan Februari 2026 Rp 50\.000\.000, naik Rp 50\.000\.000 dari Januari 2026/);
  });

  it("the first month of the year has nothing to compare", () => {
    const t = trend(months(1, 7), [fig(100n * J, 50n * J)], "IDR");
    expect(t.compared).toBe(false);
    expect(t.metrics[0]).toMatchObject({ previous: null, change: null, average: null, run: null });
    expect(t.sentence).toBe("Juli 2026 adalah bulan pertama tahun buku ini, jadi belum ada bulan pembanding.");
  });
});

describe("margins", () => {
  it("as Rasio keuangan, with the change in points and the side that moved it", () => {
    const f = [fig(100n * J, 60n * J), fig(103_200_000n, 70_800_000n)];
    const m = margins(f, sum(f), months(2));
    const gross = m.rows.find((r) => r.key === "gpm")!;
    expect(gross).toMatchObject({ previous: "40,0 %", current: "31,4 %", ytd: "35,6 %", points: -86n });
    expect(m.sentence).toBe("Margin laba kotor turun 8,6 poin: beban pokok naik 18,0 %, pendapatan naik 3,2 %.");
  });

  it("a rising margin reads naik; an unchanged one tetap", () => {
    const up = margins([fig(100n * J, 70n * J), fig(100n * J, 60n * J)], fig(200n * J, 130n * J), months(2));
    expect(up.sentence).toBe("Margin laba kotor naik 10,0 poin: beban pokok turun 14,2 %, pendapatan tetap.");
    const same = margins([fig(100n * J, 60n * J), fig(200n * J, 120n * J)], fig(300n * J, 180n * J), months(2));
    expect(same.sentence).toBe("Margin laba kotor tetap 40,0 %, sama dengan Januari 2026.");
  });

  it("zero revenue computes no margin; the first month has no comparison", () => {
    const zero = margins([fig(100n * J, 60n * J), fig(0n, 0n)], fig(100n * J, 60n * J), months(2));
    expect(zero.rows.map((r) => r.current)).toEqual([null, null, null]);
    expect(zero.rows[0].points).toBeNull();
    expect(zero.sentence).toBe("Pendapatan bulan ini nol, jadi margin tidak dihitung.");
    const lastZero = margins([fig(0n, 0n), fig(100n * J, 60n * J)], fig(100n * J, 60n * J), months(2));
    expect(lastZero.sentence).toBe("Margin laba kotor 40,0 %; Januari 2026 tidak ada pendapatan untuk dibandingkan.");
    const first = margins([fig(100n * J, 60n * J)], fig(100n * J, 60n * J), months(1));
    expect(first.sentence).toBe("Margin laba kotor 40,0 %; belum ada bulan pembanding di tahun buku ini.");
  });
});
