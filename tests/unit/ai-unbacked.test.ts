import { describe, expect, it } from "vitest";
import { accountLookup, demoteUnbacked, UNBACKED_CONFIDENCE } from "@/lib/ai/unbacked";
import type { Classification } from "@/lib/classify/types";

const chart = accountLookup([
  { code: "1130", name: "Piutang Usaha", fsLine: "PIUTANG_USAHA" },
  { code: "2110", name: "Utang Usaha", fsLine: "UTANG_USAHA" },
  { code: "4100", name: "Penjualan", fsLine: "PENDAPATAN_USAHA" },
  { code: "6190", name: "Beban Umum", fsLine: "BEBAN_UMUM" },
  { code: "4910", name: "Penghasilan Lain Pribadi", fsLine: "PENDAPATAN_LAIN" },
  { code: "3300", name: "Prive", fsLine: "PRIVE" },
]);
const ai = (accountCode: string, extra: Partial<Classification> = {}): Classification => ({ method: "AI", accountCode, taxTag: "PPN_KELUARAN", confidence: 0.85, reason: "Pelunasan piutang usaha", ...extra });
const none = { receivable: false, payable: false };

describe("demoteUnbacked: replace an AI receivable/payable the books don't hold", () => {
  it("money in with no receivable → Penjualan, 0.55, reason says why, tax tag cleared", () => {
    const r = demoteUnbacked(ai("1130"), "IN", "PT", chart, none);
    expect(r).toMatchObject({ method: "AI", accountCode: "4100", taxTag: null, confidence: UNBACKED_CONFIDENCE });
    expect(r.reason).toBe("AI mengusulkan 1130 Piutang Usaha, tetapi tidak ada piutang usaha tercatat untuk entitas ini: dianggap penjualan tunai (4100 Penjualan).");
    expect(r.reason).not.toMatch(/Pelunasan/);
  });

  it("money out with no payable → Beban Umum", () => {
    const r = demoteUnbacked(ai("2110", { confidence: 0.88 }), "OUT", "PT", chart, none);
    expect(r).toMatchObject({ accountCode: "6190", confidence: UNBACKED_CONFIDENCE });
    expect(r.reason).toMatch(/tidak ada utang usaha tercatat/);
  });

  it("keeps a lower confidence than the cap", () => {
    expect(demoteUnbacked(ai("1130", { confidence: 0.4 }), "IN", "PT", chart, none).confidence).toBe(0.4);
  });

  it("a person's books get the person's guess accounts", () => {
    expect(demoteUnbacked(ai("1130"), "IN", "PERORANGAN", chart, none).accountCode).toBe("4910");
    expect(demoteUnbacked(ai("2110"), "OUT", "PERORANGAN", chart, none).accountCode).toBe("3300");
  });

  it("is left alone when the books hold a receivable (or payable) by the row's date", () => {
    const c = ai("1130");
    expect(demoteUnbacked(c, "IN", "PT", chart, { receivable: true, payable: false })).toBe(c);
    const p = ai("2110");
    expect(demoteUnbacked(p, "OUT", "PT", chart, { receivable: false, payable: true })).toBe(p);
  });

  it("checks the side that matters: a payable on the books does not back a receipt", () => {
    expect(demoteUnbacked(ai("1130"), "IN", "PT", chart, { receivable: false, payable: true }).accountCode).toBe("4100");
  });

  it("leaves other accounts and other methods alone", () => {
    const sale = ai("4100");
    expect(demoteUnbacked(sale, "IN", "PT", chart, none)).toBe(sale);
    const rule = ai("1130", { method: "RULE", confidence: 0.95 });
    expect(demoteUnbacked(rule, "IN", "PT", chart, none)).toBe(rule);
    const wrongSide = ai("2110");
    expect(demoteUnbacked(wrongSide, "IN", "PT", chart, none)).toBe(wrongSide);
  });

  it("keeps the AI's account, demoted with the old reason, when the chart lacks the fallback", () => {
    const thin = accountLookup([{ code: "1130", name: "Piutang Usaha", fsLine: "PIUTANG_USAHA" }]);
    const r = demoteUnbacked(ai("1130"), "IN", "PT", thin, none);
    expect(r).toMatchObject({ accountCode: "1130", confidence: UNBACKED_CONFIDENCE, taxTag: "PPN_KELUARAN" });
    expect(r.reason).toBe("Pelunasan piutang usaha · Belum ada piutang usaha tercatat untuk entitas ini: periksa apakah ini penjualan tunai.");
  });
});
