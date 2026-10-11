import { describe, expect, it, vi } from "vitest";
import { aiCacheKey } from "@/lib/ai/classify";
import { aiMapCacheKey } from "@/lib/ledger-import/mapping";
import { parseEvidenceAnalysis, parseEvidenceAnswerPlan, OpenAiCompatibleProvider, AiAnswerError, buildEvidencePrompt, AI_TIMEOUT_MS, AI_LONG_TIMEOUT_MS, EVIDENCE_TIMEOUT_MS } from "@/lib/ai/provider";
import { reservationTokens } from "@/lib/ai/budget";

describe("evidence AI boundaries", () => {
  const input = { context: "untrusted", passages: [{ locator: "Profil!A1", text: "Citra Ternak PTE LTD. Industri agritech. USD" }] };
  it("retains only verbatim facts at actual source locations", () => {
    expect(parseEvidenceAnalysis(JSON.stringify({ kind: "COMPANY_PROFILE", entity: "Citra Ternak PTE LTD", currency: "USD", periodStart: "2025-02-30", facts: [
      { key: "companyName", value: "Citra Ternak PTE LTD", locator: "Profil!A1" },
      { key: "industry", value: "retail", locator: "Profil!A1" },
      { key: "currency", value: "USD", locator: "wrong!A1" },
      { key: "profit", value: "100000", locator: "Profil!A1" },
    ] }), input)).toEqual({ kind: "COMPANY_PROFILE", entity: "Citra Ternak PTE LTD", currency: "USD", periodStart: null, periodEnd: null, facts: [{ key: "companyName", value: "Citra Ternak PTE LTD", locator: "Profil!A1" }] });
  });
  it("never proposes a country name as the currency (production: \"Mata uang: INDONESIA\")", () => {
    const statement = { context: "", passages: [{ locator: "hal 1", text: "PT CONTOH JAYA, JAKARTA INDONESIA. MATA UANG IDR" }] };
    const analysis = parseEvidenceAnalysis(JSON.stringify({ kind: "BANK", currency: "INDONESIA", facts: [
      { key: "currency", value: "INDONESIA", locator: "hal 1" },
      { key: "currency", value: "IDR", locator: "hal 1" },
    ] }), statement);
    expect(analysis.currency).toBeNull();
    expect(analysis.facts).toEqual([{ key: "currency", value: "IDR", locator: "hal 1" }]);
  });
  it("does not validate facts using truncated text that model never saw", () => {
    const source = { context: "", passages: [{ locator: "p1", text: `${"x".repeat(400)}secret` }] };
    const analysis = parseEvidenceAnalysis(JSON.stringify({ kind: "OTHER", facts: [{ key: "companyName", value: "secret", locator: "p1" }] }), source);
    expect(analysis.facts).toEqual([]);
    expect(buildEvidencePrompt(source).user).not.toContain("secret");
  });
  it("allows only read plans; rejects invented financial answers and invalid dates", () => {
    expect(parseEvidenceAnswerPlan('{"intent":"BALANCE","terms":["kas"],"accountCode":"1110","from":"2025-01-01"}')).toMatchObject({ intent: "BALANCE", accountCode: "1110" });
    for (const answer of [
      '{"intent":"POST","terms":[]}',
      '{"intent":"BALANCE","terms":[],"amount":1000}',
      '{"intent":"SEARCH","terms":[],"sql":"select *"}',
      '{"intent":"SEARCH","terms":[],"from":"2025-02-30"}',
      '{"intent":"SEARCH","terms":[],"from":"2025-12-01","to":"2025-01-01"}',
      '{"intent":"SEARCH","terms":[],"note":null}',
    ]) expect(() => parseEvidenceAnswerPlan(answer)).toThrow();
  });
  it("normalises harmless plan slips instead of rejecting them", () => {
    const terms = Array.from({ length: 10 }, (_, i) => `t${i}`);
    expect(parseEvidenceAnswerPlan(JSON.stringify({ intent: "balance", terms: [...terms, " ", "x".repeat(101), 7], accountCode: "6180 Beban Penyusutan" }))).toEqual({ intent: "BALANCE", terms: terms.slice(0, 8), accountCode: "6180" });
    expect(() => parseEvidenceAnswerPlan('{"intent":"SEARCH","terms":"penjualan"}')).toThrow();
    expect(() => parseEvidenceAnswerPlan('{"intent":"SEARCH","terms":[],"accountCode":"akun kas"}')).toThrow();
  });
  it("treats optional plan fields spelled null or empty as absent", () => {
    expect(parseEvidenceAnswerPlan('{"intent":"SEARCH","terms":["x"],"from":null,"to":null,"entityId":"","accountCode":null}')).toEqual({ intent: "SEARCH", terms: ["x"] });
    expect(parseEvidenceAnswerPlan('{"intent":"SEARCH","terms":["x"],"from":"2024-12-01","to":""}')).toEqual({ intent: "SEARCH", terms: ["x"], from: "2024-12-01", to: "2024-12-01" });
  });
  it("scopes caches to client and firm even with identical chart versions", () => {
    const base = { model: "m1", clientName: "Client", accounts: [{ code: "5100", name: "Pembelian", group: "Beban" }], sample: "merchant", sourceCode: "SRC1" };
    const a = { ...base, firmId: "f1", clientId: "c1" }, b = { ...base, firmId: "f1", clientId: "c2" }, c = { ...base, firmId: "f2", clientId: "c1" };
    expect(new Set([a, b, c].map((scope) => aiCacheKey("key", "IN", 1, scope))).size).toBe(3);
    expect(new Set([a, b, c].map((scope) => aiMapCacheKey("Cloud", "BEBAN", 1, scope))).size).toBe(3);
  });
  it("legacy cache keys change with model, client context, chart definition or source input", () => {
    const scope = { firmId: "f1", clientId: "c1", model: "model1", clientName: "Company (retail)", accounts: [{ code: "5100", name: "Purchases", group: "Expenses" }], sample: "merchant invoice", sourceCode: "S1" };
    const classification = aiCacheKey("merchant", "OUT", 1, scope);
    const mapping = aiMapCacheKey("Cloud hosting", "BEBAN", 1, scope);
    for (const next of [{ ...scope, model: "model2" }, { ...scope, clientName: "Company (agritech)" }, { ...scope, accounts: [{ code: "5100", name: "Inventory", group: "Assets" }] }]) {
      expect(aiCacheKey("merchant", "OUT", 1, next)).not.toBe(classification);
      expect(aiMapCacheKey("Cloud hosting", "BEBAN", 1, next)).not.toBe(mapping);
    }
    expect(aiCacheKey("merchant", "OUT", 1, { ...scope, sample: "other purpose" })).not.toBe(classification);
    expect(aiMapCacheKey("Cloud hosting", "BEBAN", 1, { ...scope, sourceCode: "S2" })).not.toBe(mapping);
    expect(aiMapCacheKey(" CLOUD--HOSTING ", "BEBAN", 1, scope)).toBe(mapping);
  });
  it("bounds UTF-8 bytes conservatively and rejects invalid maximum tokens", () => {
    expect(reservationTokens({ system: "", user: "株" }, 1000)).toBe(1259);
    expect(() => reservationTokens({ system: "", user: "" }, -1)).toThrow();
  });
  it("invalid billed plan carries usage and triggers no retry", async () => {
    let calls = 0;
    const provider = new OpenAiCompatibleProvider({ baseUrl: "https://test.invalid", apiKey: "x", model: "m", maxCallsPerRun: 20, monthlyTokenBudget: 20_000 }, (async () => {
      calls++;
      return new Response(JSON.stringify({ usage: { prompt_tokens: 200, completion_tokens: 30 }, choices: [{ message: { content: '{"intent":"POST","terms":[]}' } }] }));
    }) as typeof fetch);
    const error = await provider.planEvidenceAnswer("post", "").catch((e) => e);
    expect(error).toBeInstanceOf(AiAnswerError);
    expect(error.promptTokens).toBe(200);
    expect(calls).toBe(1);
  });

  it("gives evidence, classification and mapping calls 90 seconds and close review/explain 180", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const provider = new OpenAiCompatibleProvider({ baseUrl: "https://test.invalid", apiKey: "x", model: "m", maxCallsPerRun: 20, monthlyTokenBudget: 20_000 }, (async () =>
      new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [{ message: { content: '{"items":[]}' } }] }))) as typeof fetch);
    const used = async (call: () => Promise<unknown>) => { timeout.mockClear(); await call().catch(() => {}); return timeout.mock.calls.map((c) => c[0]); };
    expect(await used(() => provider.analyzeEvidence({ context: "", passages: [] }))).toEqual([EVIDENCE_TIMEOUT_MS]);
    expect(await used(() => provider.planEvidenceAnswer("Bandingkan Revenue", ""))).toEqual([EVIDENCE_TIMEOUT_MS]);
    expect(await used(() => provider.classify([], [], ""))).toEqual([AI_TIMEOUT_MS]);
    expect(await used(() => provider.mapAccounts([], [], ""))).toEqual([AI_TIMEOUT_MS]);
    expect([EVIDENCE_TIMEOUT_MS, AI_TIMEOUT_MS, AI_LONG_TIMEOUT_MS]).toEqual([90_000, 90_000, 180_000]);
    timeout.mockRestore();
  });
});
