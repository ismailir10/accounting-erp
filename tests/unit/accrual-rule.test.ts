import { describe, expect, it } from "vitest";
import { accrualKey, accrualRationale, accrualRule, medianOf, monthsText, parseAccrualKey } from "@/lib/adjust/accruals";

// Usulan akrual (cycle 2026-10-18-usulan-akrual): the pure decision on four monthly amounts (oldest first, 0 = no movement).
const jt = (n: number) => BigInt(Math.round(n * 1_000_000));

describe("accrual rule", () => {
  it("qualifies 3 of 4 and 4 of 4 months; 2 of 4 doesn't", () => {
    expect(accrualRule([jt(4.2), jt(4.2), jt(4.35), jt(4.2)], 1n)).toEqual({ ok: true, median: jt(4.2), index: 3 });
    expect(accrualRule([0n, jt(10), jt(11), jt(12)], 1n)).toEqual({ ok: true, median: jt(11), index: 2 });
    expect(accrualRule([jt(10), 0n, jt(10), jt(10)], 1n)).toMatchObject({ ok: true, median: jt(10), index: 3 });
    expect(accrualRule([0n, 0n, jt(10), jt(10)], 1n)).toMatchObject({ ok: false, why: "few" });
    expect(accrualRule([0n, 0n, 0n, 0n], 1n)).toMatchObject({ ok: false, why: "few" });
  });

  it("a negative month (a refund) disqualifies, even when three others recur", () => {
    expect(accrualRule([-jt(1), jt(10), jt(10), jt(10)], 1n)).toMatchObject({ ok: false, why: "refund" });
    expect(accrualRule([jt(10), jt(10), jt(10), -1n], 1n)).toMatchObject({ ok: false, why: "refund" });
  });

  it("the 25 % band is exact at the boundary: equal qualifies, one minor unit over doesn't", () => {
    // Median 100: 4 × |125 − 100| = 100 ≤ 100 qualifies; 126 is one unit over.
    expect(accrualRule([100n, 100n, 125n], 1n).ok).toBe(true);
    expect(accrualRule([100n, 100n, 126n], 1n)).toMatchObject({ ok: false, why: "band", median: 100n });
    expect(accrualRule([75n, 100n, 100n], 1n).ok).toBe(true);
    expect(accrualRule([74n, 100n, 100n], 1n)).toMatchObject({ ok: false, why: "band" });
    // A median that doesn't divide by four: 4 × |amount − median| ≤ median, never rounded (101: 75,25 → 76 is in, 75 is out).
    expect(accrualRule([76n, 101n, 101n], 1n).ok).toBe(true);
    expect(accrualRule([75n, 101n, 101n], 1n).ok).toBe(false);
    // Rupiah-sized amounts keep exactness: 25.004.000 – 25.007.000 is well inside.
    expect(accrualRule([25_004_000n, 25_005_000n, 25_006_000n, 25_007_000n], 1n)).toEqual({ ok: true, median: 25_006_000n, index: 2 });
  });

  it("the median: three months the middle one; four months the later of the two middle months", () => {
    expect(medianOf([jt(3), 0n, jt(1), jt(2)])).toEqual({ median: jt(2), index: 3 });
    expect(medianOf([jt(1), jt(3), jt(2), 0n])).toEqual({ median: jt(2), index: 2 });
    // Four: the two middle amounts are 2 (Jun) and 3 (May) → the later month, June's 2.
    expect(medianOf([jt(1), jt(3), jt(2), jt(4)])).toEqual({ median: jt(2), index: 2 });
    // …and the other way round: 3 in July, 2 in May → July's 3.
    expect(medianOf([jt(1), jt(2), jt(4), jt(3)])).toEqual({ median: jt(3), index: 3 });
    // An amount one month actually carried, never an average; with equal amounts the latest month that carried it is the proof.
    expect(medianOf([jt(4.2), jt(4.2), jt(4.35), jt(4.2)])).toEqual({ median: jt(4.2), index: 3 });
    expect(medianOf([jt(5), jt(5), jt(5), jt(5)])).toEqual({ median: jt(5), index: 3 });
    expect(medianOf([jt(5), 0n, jt(5)])).toBeNull();
  });

  it("below materiality doesn't qualify; at the floor it does", () => {
    expect(accrualRule([jt(1), jt(1), jt(1)], jt(1) + 1n)).toMatchObject({ ok: false, why: "material", median: jt(1) });
    expect(accrualRule([jt(1), jt(1), jt(1)], jt(1)).ok).toBe(true);
  });

  it("writes the rationale from fixed facts", () => {
    const base = { account: { code: "6120", name: "Beban Sewa" }, currency: "IDR", year: 2026, month: 8, median: 25_007_000n, medianMonth: { year: 2026, month: 7 } };
    const months = [4, 5, 6, 7].map((m, i) => ({ year: 2026, month: m, amount: 25_004_000n + BigInt(i) * 1000n }));
    expect(accrualRationale({ ...base, kind: "bank", counterparty: "HJ MARYAM SEWA GUDANG", months, banks: ["BCA Giro"] })).toBe(
      "HJ MARYAM SEWA GUDANG dibayar ke 6120 Beban Sewa pada Apr, Mei, Jun dan Jul 2026 (Rp 25.004.000 – Rp 25.007.000). Agustus belum ada sampai 31 Agu 2026, dan rekening koran BCA Giro sudah lengkap sampai tanggal itu. Usulan: Rp 25.007.000, nilai tengah riwayat (Jul 2026).",
    );
    const flat = [5, 6, 7].map((m) => ({ year: 2026, month: m, amount: 3_000_000n }));
    expect(accrualRationale({ ...base, kind: "ledger", counterparty: "6120 Beban Sewa", months: flat, banks: [], median: 3_000_000n })).toBe(
      "6120 Beban Sewa tercatat di buku besar yang diimpor pada Mei, Jun dan Jul 2026 (Rp 3.000.000 tiap bulan). Agustus belum ada sampai 31 Agu 2026, dan buku besar Agustus sudah diimpor. Usulan: Rp 3.000.000, nilai tengah riwayat (Jul 2026).",
    );
    expect(accrualRationale({ ...base, kind: "contact", counterparty: "CV Andalas", months: flat, banks: [], median: 3_000_000n })).toBe(
      "Tagihan CV Andalas dicatat ke 6120 Beban Sewa pada Mei, Jun dan Jul 2026 (Rp 3.000.000 tiap bulan). Agustus belum ada tagihan atau pembayarannya sampai 31 Agu 2026. Usulan: Rp 3.000.000, nilai tengah riwayat (Jul 2026).",
    );
    expect(accrualRationale({ ...base, kind: "bank", counterparty: "PLN", months, banks: ["BCA Giro", "Mandiri Giro"] })).toContain("rekening koran BCA Giro dan Mandiri Giro sudah lengkap");
    expect(monthsText([{ year: 2025, month: 11 }, { year: 2025, month: 12 }, { year: 2026, month: 1 }])).toBe("Nov 2025, Des 2025 dan Jan 2026");
  });

  it("keys round-trip, whatever the payee's words", () => {
    for (const bucket of [{ kind: "bank" as const, merchantKey: "PT A: B/C 12" }, { kind: "contact" as const, contactId: "c1" }, { kind: "ledger" as const }]) {
      const key = accrualKey("ent1", 2026, 8, "6120", bucket);
      expect(parseAccrualKey(key)).toEqual({ entityId: "ent1", year: 2026, month: 8, code: "6120", bucket });
    }
    expect(accrualKey("ent1", 2026, 8, "6120", { kind: "ledger" })).toBe("ACCRUAL:ent1:2026-08:6120:ledger");
    expect(parseAccrualKey("ACCRUAL:ent1:2026-13:6120:ledger")).toBeNull();
    expect(parseAccrualKey("SUSPENSE:x")).toBeNull();
  });
});
