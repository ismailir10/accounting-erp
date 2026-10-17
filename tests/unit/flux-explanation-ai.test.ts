import { describe, expect, it } from "vitest";
import { buildFluxExplanationPrompt, parseFluxExplanation, type FluxExplanationInput } from "@/lib/reports/flux-explanation-ai";
import { allowedNumbers, foreignNumbers } from "@/lib/reports/commentary-ai";

// Penjelasan penggerak (accounting-rules 20d): the parse keeps only citations of rows that were sent; the number check names the rest.
const input: FluxExplanationInput = {
  client: "Grup Uji",
  entity: "PT Uji",
  period: "Juli 2026",
  currency: "IDR",
  account: { code: "6170", name: "Beban Jasa Profesional" },
  rows: [
    { id: "akun:e1:6170", date: "", text: "Mutasi 6170 Beban Jasa Profesional: Apr 26 Rp 10.000.000 · Jul 26 Rp 17.450.000", amount: "Rp 17.450.000", account: "6170", how: "sisi normal debit" },
    { id: "jl:a", date: "2026-07-14", text: "Konsultan pajak", amount: "Rp 9.000.000", account: "6170", how: "mutasi bank" },
  ],
};

describe("flux explanation prompt", () => {
  it("sends the rows and nothing else of the books", () => {
    const { user, system } = buildFluxExplanationPrompt(input);
    expect(JSON.parse(user).rows).toEqual(input.rows);
    expect(system).toMatch(/refs/);
  });

  it("drops citations outside the rows sent, keeps the text, and refuses an empty answer", () => {
    expect(parseFluxExplanation('```json\n{"text":"Konsultan pajak  Rp 9.000.000.","refs":["jl:a","jl:x","jl:a",3]}\n```', input)).toEqual({ text: "Konsultan pajak Rp 9.000.000.", refs: ["jl:a"] });
    expect(parseFluxExplanation('{"text":"Tanpa kutipan."}', input).refs).toEqual([]);
    expect(() => parseFluxExplanation('{"text":"  ","refs":["jl:a"]}', input)).toThrow();
    expect(() => parseFluxExplanation("bukan json", input)).toThrow();
  });

  it("a number that was not sent is foreign", () => {
    const allowed = allowedNumbers(input.rows.flatMap((r) => [r.text, r.amount, r.date]));
    expect(foreignNumbers("Konsultan pajak Rp 9.000.000 pada 14 Juli, naik 74,5 % dari Rp 10.000.000.", allowed)).toEqual(["74,5"]);
  });
});
