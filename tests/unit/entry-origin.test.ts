import { describe, expect, it } from "vitest";
import { originText } from "@/lib/reports/entry-origin";

describe("entry origin", () => {
  it("names a draft by its kind and, for Jelaskan, the control it explained", () => {
    expect(originText({ kind: "draft", source: "AI_CONTROL", control: "Kewajaran pembukuan" })).toBe("Usulan AI (Jelaskan · Kewajaran pembukuan)");
    expect(originText({ kind: "draft", source: "AI_CONTROL", control: null })).toBe("Usulan AI (Jelaskan)");
    expect(originText({ kind: "draft", source: "SUSPENSE", control: null })).toBe("Koreksi selisih 1999");
  });

  it("names the Coretax file and row of a booked faktur", () => {
    expect(originText({ kind: "faktur", fileName: "faktur-agu.xlsx", sourceRef: "Sheet1!4" })).toBe("Faktur Coretax faktur-agu.xlsx Sheet1!4");
  });

  it("says whether the reviewer accepted the suggestion as it was or changed it", () => {
    const ai = { accountCode: "6120", taxTag: null, method: "AI", confidence: 0.92 };
    expect(originText({ kind: "review", suggestion: ai, accountCode: "6120", taxTag: null })).toBe("Usulan AI 6120 (92 %) disetujui");
    expect(originText({ kind: "review", suggestion: ai, accountCode: "6130", taxTag: null })).toBe("Usulan AI 6120 (92 %) diubah ke 6130");
    // A tax tag is part of the decision: the same account with another tag is a change.
    expect(originText({ kind: "review", suggestion: { ...ai, taxTag: "PPN_MASUKAN" }, accountCode: "6120", taxTag: null })).toBe("Usulan AI 6120 PPN Masukan (92 %) diubah ke 6120");
    // Only an AI suggestion carries a confidence; a simple guess is named as one.
    expect(originText({ kind: "review", suggestion: { accountCode: "6190", taxTag: null, method: "HEURISTIC", confidence: 0.3 }, accountCode: "6190", taxTag: null })).toBe("Tebakan 6190 disetujui");
  });
});
