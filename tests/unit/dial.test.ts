import { describe, expect, it } from "vitest";
import { decidePosting, heldLine, type Dial } from "@/lib/classify/dial";
import { AUTO_POST_CONFIDENCE } from "@/lib/classify/types";
import { DEFAULT_AUTOMATION } from "@/lib/settings/automation";

/** Post or hold (accounting-rules 14, cycle 2026-10-17-otomasi): one pure function of (classification, amount, dial). */
const ON: Dial = { transfer: true, rules: true, memory: true, cap: null };
const rule = { method: "RULE" as const, confidence: 0.97, reason: 'Aturan: "BIAYA ADM"' };
const memory = { method: "MEMORY" as const, confidence: 0.95, reason: 'Pernah dikonfirmasi 3× untuk "HJ MARYAM"' };
const pair = { method: "TRANSFER" as const, confidence: 0.99, reason: "Transfer antar rekening sendiri (pasangan ditemukan)" };
const unpaired = { method: "TRANSFER" as const, confidence: 0.92, reason: "Transfer antar rekening sendiri (pasangan belum diimpor)" };

describe("decidePosting", () => {
  it("the default dial posts exactly what the fixed test posted before: TRANSFER, RULE, MEMORY at ≥ 0.9, any amount", () => {
    expect(DEFAULT_AUTOMATION).toMatchObject(ON);
    for (const c of [rule, memory, pair, unpaired]) {
      for (const amount of [-6_500n, 2_000_000_000n, -(10n ** 15n)]) expect(decidePosting(c, amount, DEFAULT_AUTOMATION)).toEqual({ post: true, held: null, reason: c.reason });
    }
    // Below the threshold: the ambiguous transfer (0.8) waits, as before, and it is not the dial's doing.
    expect(decidePosting({ method: "TRANSFER", confidence: 0.8, reason: "Tidak dipasangkan otomatis" }, -5n, ON)).toEqual({ post: false, held: null, reason: "Tidak dipasangkan otomatis" });
    expect(AUTO_POST_CONFIDENCE).toBe(0.9);
  });

  it("AI, the simple guess and the financing hints never post, with every switch on and no cap", () => {
    for (const method of ["AI", "HEURISTIC", "MANUAL"] as const) {
      for (const confidence of [0.55, 0.9, 0.99, 1]) {
        expect(decidePosting({ method, confidence, reason: "x" }, -1n, ON)).toEqual({ post: false, held: null, reason: "x" });
      }
    }
  });

  it("each switch off holds its source only, and says so before the classifier's reason", () => {
    expect(decidePosting(rule, -15_000n, { ...ON, rules: false })).toEqual({ post: false, held: "rules", reason: 'Otomasi aturan dimatikan di Pengaturan kantor. Aturan: "BIAYA ADM"' });
    expect(decidePosting(memory, -15_000n, { ...ON, memory: false })).toEqual({ post: false, held: "memory", reason: 'Otomasi pilihan yang diingat dimatikan di Pengaturan kantor. Pernah dikonfirmasi 3× untuk "HJ MARYAM"' });
    expect(decidePosting(pair, 1n, { ...ON, transfer: false })).toEqual({ post: false, held: "transfer", reason: "Otomasi transfer dimatikan di Pengaturan kantor. Transfer antar rekening sendiri (pasangan ditemukan)" });
    expect(decidePosting(unpaired, 1n, { ...ON, transfer: false }).held).toBe("transfer");
    // The other sources are not affected.
    expect(decidePosting(memory, -15_000n, { ...ON, rules: false }).post).toBe(true);
    expect(decidePosting(rule, -15_000n, { ...ON, transfer: false, memory: false }).post).toBe(true);
  });

  it("the cap compares the absolute amount: equal posts, one Rupiah above holds, money out too", () => {
    const capped = { ...ON, cap: 100_000_000n };
    expect(decidePosting(rule, -100_000_000n, capped).post).toBe(true);
    expect(decidePosting(rule, 100_000_000n, capped).post).toBe(true);
    expect(decidePosting(rule, -100_000_001n, capped)).toEqual({ post: false, held: "cap", reason: 'Di atas batas otomasi (Rp 100.000.000). Aturan: "BIAYA ADM"' });
    expect(decidePosting(pair, 150_000_000n, capped)).toEqual({ post: false, held: "cap", reason: "Di atas batas otomasi (Rp 100.000.000). Transfer antar rekening sendiri (pasangan ditemukan)" });
    // A source switched off is the reason given, whatever the amount.
    expect(decidePosting(rule, -150_000_000n, { ...capped, rules: false }).held).toBe("rules");
    // The cap never makes an AI line post.
    expect(decidePosting({ method: "AI", confidence: 0.99, reason: "x" }, -1n, capped).post).toBe(false);
  });
});

describe("heldLine", () => {
  it("counts the held lines with their reasons, and says nothing when the dial held none", () => {
    expect(heldLine({})).toBeNull();
    expect(heldLine({ cap: 0 })).toBeNull();
    expect(heldLine({ rules: 1, cap: 2 })).toBe("3 ditahan Otomasi kantor (batas nominal, aturan dimatikan)");
    expect(heldLine({ memory: 1, transfer: 1 })).toBe("2 ditahan Otomasi kantor (transfer dimatikan, pilihan yang diingat dimatikan)");
  });
});
