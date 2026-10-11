import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { AI_BATCH_SIZE, AiAnswerError, AiTruncatedError, maxTokensFor, type AiItem, type AiProvider, type AiResult } from "@/lib/ai/provider";
import { suggestWithAi } from "@/lib/ai/classify";

/** Never a real model: answers every key with 6190, or fails the way the script says for this call (1-based). */
class BatchProvider implements AiProvider {
  readonly model = "batch-test";
  sizes: number[] = [];
  constructor(private fail: (call: number, items: AiItem[]) => Error | null = (_c, items) => (items.length > 8 ? truncated() : null)) {}
  async classify(items: AiItem[]): Promise<AiResult> {
    this.sizes.push(items.length);
    const err = this.fail(this.sizes.length, items);
    if (err) throw err;
    return { answers: items.map((i) => ({ key: i.key, accountCode: "6190", confidence: 0.8, taxTag: null, reason: "uji" })), promptTokens: 10 * items.length, completionTokens: 5 * items.length, model: this.model };
  }
  async mapAccounts(): Promise<never> {
    throw new Error("not used");
  }
}
const truncated = () => new AiTruncatedError("Jawaban AI terpotong (batas 12000 token). Coba lagi atau pilih model lain.", 1000, 12_000, "batch-test");
const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

async function run(provider: AiProvider, n = 40, extra: { deadline?: number } = {}) {
  const g = await makeGroup();
  const pending = Array.from({ length: n }, (_, i) => ({ key: `TOKO ${String(i).padStart(2, "0")}`, direction: "OUT" as const, sample: `TRSF KE TOKO ${i}` }));
  return suggestWithAi(db, { firmId: g.firm.id, clientId: g.client.id, clientName: "Grup Uji", coaVersion: 1, accounts: [{ code: "6190", name: "Beban Lain" }], pending, provider, ...extra });
}

describe("classification batches (reasoning models)", () => {
  beforeEach(resetDb);
  afterEach(() => vi.unstubAllEnvs());

  it("asks 15 per call with room to think", () => {
    expect(AI_BATCH_SIZE).toBe(15);
    expect(maxTokensFor(AI_BATCH_SIZE)).toBe(12_000);
    expect(maxTokensFor(1)).toBe(9_200);
  });

  it("splits a cut-off batch once into halves and answers every key", async () => {
    const provider = new BatchProvider();
    const r = await run(provider);
    expect(provider.sizes).toEqual([15, 7, 8, 15, 7, 8, 10, 5, 5]);
    expect(r.suggestions.size).toBe(40);
    expect(r.usage).toEqual({ calls: 9, cacheHits: 0, note: undefined, remaining: 0, unanswered: 0, stopped: false });
    expect(await db.aiUsage.count()).toBe(9);
    expect(await db.aiSuggestion.count()).toBe(40);
  });

  it("a model that cuts off everything: the run still reaches the end, keys keep simple guesses, never past the cap", async () => {
    const provider = new BatchProvider(() => truncated());
    const r = await run(provider);
    expect(provider.sizes).toEqual([15, 7, 8, 15, 7, 8, 10, 5, 5]); // halves are not split again
    expect(r.suggestions.size).toBe(0);
    expect(r.usage).toMatchObject({ calls: 9, remaining: 0, unanswered: 40, stopped: false, note: "40 lawan transaksi tetap tebakan sederhana: jawaban AI terpotong." });
    expect(r.usage.calls).toBeLessThanOrEqual(20);
  });

  it("another failure skips that batch only and the run moves on", async () => {
    const provider = new BatchProvider((call) => (call === 1 ? new AiAnswerError("Jawaban AI tidak terbaca (bukan JSON). Coba lagi atau pilih model lain.", 100, 50, "batch-test") : null));
    const r = await run(provider, 30);
    expect(provider.sizes).toEqual([15, 15]);
    expect(r.suggestions.size).toBe(15);
    expect(r.usage).toMatchObject({ calls: 2, remaining: 0, unanswered: 15, stopped: false, note: "AI gagal: Jawaban AI tidak terbaca (bukan JSON). Coba lagi atau pilih model lain." });
  });

  it("a refused key stops the run: every later call would fail the same way", async () => {
    const provider = new BatchProvider(() => new Error('AI 401: {"error":"invalid key"}'));
    const r = await run(provider);
    expect(provider.sizes).toEqual([15]);
    expect(r.usage).toMatchObject({ calls: 1, remaining: 25, unanswered: 15, stopped: true, note: 'AI gagal: AI 401: {"error":"invalid key"}' });
  });

  it("the monthly budget refusal stops the run with its message", async () => {
    vi.stubEnv("AI_MONTHLY_TOKEN_BUDGET", "1");
    const provider = new BatchProvider();
    const r = await run(provider);
    expect(provider.sizes).toEqual([]);
    expect(r.usage).toMatchObject({ calls: 0, remaining: 40, unanswered: 0, stopped: true });
    expect(r.usage.note).toMatch(/^Kuota token AI bulan ini tidak cukup/);
  });

  it("two timeouts in a row stop the run", async () => {
    const provider = new BatchProvider(() => timeout());
    const r = await run(provider);
    expect(provider.sizes).toEqual([15, 15]);
    expect(r.usage).toMatchObject({ calls: 2, remaining: 10, unanswered: 30, stopped: true });
    expect(r.usage.note).toMatch(/^AI tidak menjawab dalam 90 detik/);
  });

  it("one timeout followed by an answer keeps going", async () => {
    const provider = new BatchProvider((call, items) => (call === 1 ? timeout() : items.length > 8 ? truncated() : null));
    const r = await run(provider);
    expect(provider.sizes).toEqual([15, 15, 7, 8, 10, 5, 5]);
    expect(r.suggestions.size).toBe(25);
    expect(r.usage).toMatchObject({ calls: 7, remaining: 0, unanswered: 15, stopped: false });
    expect(r.usage.note).toMatch(/^AI tidak menjawab dalam 90 detik/);
  });

  it("no call starts after the deadline; what is left is reported, not a failure", async () => {
    const provider = new BatchProvider();
    const r = await run(provider, 40, { deadline: Date.now() - 1 });
    expect(provider.sizes).toEqual([]);
    expect(r.usage).toEqual({ calls: 0, cacheHits: 0, note: undefined, remaining: 40, unanswered: 0, stopped: false });
  });

  it("stops at AI_MAX_CALLS_PER_RUN, halves included", async () => {
    vi.stubEnv("AI_MAX_CALLS_PER_RUN", "2");
    const provider = new BatchProvider();
    const r = await run(provider);
    expect(provider.sizes).toEqual([15, 7]);
    expect(r.suggestions.size).toBe(7);
    expect(r.usage).toMatchObject({ calls: 2, remaining: 33, unanswered: 0, stopped: true, note: "Batas panggilan AI per proses tercapai." });
  });

  it("cached keys cost nothing on the next run", async () => {
    const provider = new BatchProvider();
    const g = await makeGroup();
    const args = { firmId: g.firm.id, clientId: g.client.id, clientName: "Grup Uji", coaVersion: 1, accounts: [{ code: "6190", name: "Beban Lain" }], provider, pending: Array.from({ length: 20 }, (_, i) => ({ key: `K${i}`, direction: "IN" as const, sample: `K${i}` })) };
    await suggestWithAi(db, args);
    const calls = provider.sizes.length;
    const again = await suggestWithAi(db, args);
    expect(provider.sizes.length).toBe(calls);
    expect(again.usage).toEqual({ calls: 0, cacheHits: 20, note: undefined, remaining: 0, unanswered: 0, stopped: false });
  });
});
