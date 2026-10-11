import { describe, expect, it } from "vitest";
import { AiAnswerError, buildPrompt, maxTokensFor, OpenAiCompatibleProvider, parseAiResponse } from "@/lib/ai/provider";

const items = [
  { key: "CV SUMBER VAKSIN", direction: "OUT" as const, sample: "TRSF CV SUMBER VAKSIN" },
  { key: "PT LOGISTIK CEPAT", direction: "OUT" as const, sample: "TRSF PT LOGISTIK CEPAT" },
];
const codes = new Set(["5100", "6140"]);

describe("AI response parsing (prompt-injection safe)", () => {
  it("keeps only known keys and whitelisted codes", () => {
    const text = `Berikut hasilnya: {"items":[{"k":"CV SUMBER VAKSIN","code":"5100","conf":0.8,"tax":"PPN_MASUKAN","why":"obat ternak"},{"k":"PT LOGISTIK CEPAT","code":"9999","conf":1},{"k":"EVIL","code":"6140","conf":1}]}`;
    const out = parseAiResponse(text, items, codes);
    expect(out).toEqual([{ key: "CV SUMBER VAKSIN", accountCode: "5100", confidence: 0.8, taxTag: "PPN_MASUKAN", reason: "obat ternak" }]);
  });
  it("returns [] on malformed JSON instead of throwing", () => {
    expect(parseAiResponse("not json {", items, codes)).toEqual([]);
  });
  it("prompt is compact: one line per account and item", () => {
    const { user } = buildPrompt(items, [{ code: "5100", name: "Pembelian" }], "Grup Uji");
    expect(user.split("\n").length).toBe(1 + 1 + 1 + 1 + items.length);
  });
});

describe("OpenAiCompatibleProvider", () => {
  it("calls /chat/completions once and maps usage", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({ model: "m1", usage: { prompt_tokens: 120, completion_tokens: 30 }, choices: [{ message: { content: '{"items":[{"k":"PT LOGISTIK CEPAT","code":"6140","conf":0.9,"tax":null,"why":"ongkir"}]}' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const p = new OpenAiCompatibleProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", model: "m1", maxCallsPerRun: 20, monthlyTokenBudget: 1000 }, fakeFetch);
    const res = await p.classify(items, [{ code: "6140", name: "Logistik" }], "x");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://gw.test/v1/chat/completions");
    expect(calls[0].body.temperature).toBe(0);
    expect(res.answers[0].accountCode).toBe("6140");
    expect(res.promptTokens).toBe(120);
  });
});

describe("OpenAiCompatibleProvider — answers that can't be used", () => {
  const cfg = { baseUrl: "https://gw.test/v1", apiKey: "k", model: "glm", maxCallsPerRun: 20, monthlyTokenBudget: 1000 };
  const reply = (content: string | null, finish = "stop") =>
    (async () =>
      new Response(JSON.stringify({ model: "glm", usage: { prompt_tokens: 1354, completion_tokens: 220 }, choices: [{ message: { content }, finish_reason: finish }] }), {
        status: 200,
      })) as unknown as typeof fetch;
  const mapItems = [{ key: "a0", code: "9103", name: "Royalti Artis Terutang", typeHint: null }];
  const chart = [{ code: "2120", name: "Utang Lain-lain", group: "Liabilitas" }];

  it("asks for enough output tokens for reasoning models", async () => {
    let body: Record<string, unknown> = {};
    const f = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[]}' }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await new OpenAiCompatibleProvider(cfg, f).mapAccounts(mapItems, chart, "x");
    expect(body.max_tokens).toBe(maxTokensFor(1));
    expect(maxTokensFor(1)).toBeGreaterThanOrEqual(1500);
    // minimax-m3 truncated a 19-line batch at 2 640: a batch must leave room for several thousand reasoning tokens.
    expect(maxTokensFor(19)).toBeGreaterThanOrEqual(8000);
    expect(maxTokensFor(1000)).toBe(12_000);
  });

  it("a truncated answer is an error that carries the billed tokens", async () => {
    const err = await new OpenAiCompatibleProvider(cfg, reply('{"items":[{"k":"a0","co', "length")).mapAccounts(mapItems, chart, "x").catch((e) => e);
    expect(err).toBeInstanceOf(AiAnswerError);
    expect(err.message).toMatch(/terpotong/);
    expect([err.promptTokens, err.completionTokens]).toEqual([1354, 220]);
  });

  it("prose or an empty message is 'tidak terbaca', not zero suggestions", async () => {
    for (const content of ["Saya kira akun ini utang.", null]) {
      const err = await new OpenAiCompatibleProvider(cfg, reply(content)).classify(items, [{ code: "6140", name: "Logistik" }], "x").catch((e) => e);
      expect(err).toBeInstanceOf(AiAnswerError);
      expect(err.message).toMatch(/tidak terbaca/);
    }
  });

  it("valid JSON with no usable code is still a (empty) answer", async () => {
    const res = await new OpenAiCompatibleProvider(cfg, reply('{"items":[{"k":"a0","code":"9999","conf":1}]}')).mapAccounts(mapItems, chart, "x");
    expect(res.answers).toEqual([]);
  });
});

it("a Zen 503 'Endpoint is unavailable' leads with the fix (notes are cut at 120 chars)", async () => {
  const f = (async () => new Response('{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}', { status: 503 })) as unknown as typeof fetch;
  const p = new OpenAiCompatibleProvider({ baseUrl: "https://opencode.ai/zen/v1", apiKey: "k", model: "gpt-5.6-luna", maxCallsPerRun: 20, monthlyTokenBudget: 1000 }, f);
  const err = await p.mapAccounts([{ key: "a0", code: "1", name: "Kas", typeHint: null }], [], "x").catch((e) => e);
  expect(`AI gagal: ${err.message}`.slice(0, 120)).toMatch(/gpt-5\.6-luna tidak tersedia lewat \/chat\/completions \(AI 503\)\. Pilih mis\. glm-5\.3/);
});

it("keeps another gateway's 503 message without recommending Zen models", async () => {
  const f = (async () => new Response("Endpoint is unavailable", { status: 503 })) as unknown as typeof fetch;
  const p = new OpenAiCompatibleProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", model: "custom", maxCallsPerRun: 20, monthlyTokenBudget: 1000 }, f);
  await expect(p.mapAccounts([{ key: "a0", code: "1", name: "Kas", typeHint: null }], [], "x")).rejects.toThrow("AI 503: Endpoint is unavailable");
});
