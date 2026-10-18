import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { MockProvider } from "@/lib/ai/provider";
import { AI_FAILED, AI_NOT_NEEDED, AI_UNAVAILABLE, compileWithAi } from "@/lib/instructions/ai";
import { AI_ACCOUNT, AI_AMOUNT, AI_NONE, AI_PATTERN, buildInstructionPrompt, type InstructionAiInput } from "@/lib/instructions/ai-prompt";
import { REFUSAL, toJson } from "@/lib/instructions/compile";
import { approveInstruction } from "@/lib/instructions/store";

/**
 * *Susun dengan AI* (cycle 2026-10-18-instruksi-kantor, accounting-rules 20e) with MockProvider only: a closed schema, grounded in the
 * sentence and the account list, one budgeted call cached by sentence, accounts, model and prompt version; a draft until a person approves.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;
const SENTENCE = "kalau PT SINAR ABADI kirim uang, saya mau lihat dulu";
const answer = (o: Record<string, unknown>) => JSON.stringify({ kind: "HOLD", pattern: "PT SINAR ABADI", direction: "IN", accountCode: null, taxTag: null, minAmount: null, inclusive: false, ...o });
const mock = (text: string | null) => {
  const m = new MockProvider();
  m.instructionAnswer = text;
  return m;
};
const ask = (g: G, provider: MockProvider | null, sentence = SENTENCE) => compileWithAi(db, { firmId: g.firm.id, clientId: g.client.id, sentence, provider });

describe("Susun dengan AI", () => {
  beforeEach(resetDb);

  it("a valid answer becomes a draft; the second ask is a cache hit with no call and no budget; approving it unchanged is Disusun AI", async () => {
    const g = await makeGroup();
    const m = mock(answer({}));
    expect(await ask(g, m)).toEqual({ ok: true, draft: { kind: "HOLD", pattern: "PT SINAR ABADI", direction: "IN", accountCode: null, taxTag: null, minAmount: null, inclusive: false } });
    expect(m.calls).toBe(1);
    const spent = { usage: await db.aiUsage.count(), reserved: await db.aiReservation.aggregate({ _sum: { tokens: true } }) };
    expect(spent.usage).toBe(1);
    expect((await db.aiUsage.findFirstOrThrow()).note).toBe("Instruksi kantor");
    expect(await ask(g, m)).toMatchObject({ ok: true });
    expect(m.calls).toBe(1);
    expect({ usage: await db.aiUsage.count(), reserved: await db.aiReservation.aggregate({ _sum: { tokens: true } }) }).toEqual(spent);
    const draft = (await ask(g, m)) as { ok: true; draft: Parameters<typeof toJson>[0] };
    expect(await approveInstruction(db, { firmId: g.firm.id, clientId: g.client.id, sentence: SENTENCE, fields: toJson(draft.draft) })).toMatchObject({ ok: true, origin: "AI" });
  });

  it("an edited AI draft is Disunting", async () => {
    const g = await makeGroup();
    const r = (await ask(g, mock(answer({})))) as { ok: true; draft: Parameters<typeof toJson>[0] };
    expect(await approveInstruction(db, { firmId: g.firm.id, clientId: g.client.id, sentence: SENTENCE, fields: toJson({ ...r.draft, direction: null }) })).toMatchObject({ ok: true, origin: "EDITED" });
  });

  it("refuses an unknown key, a second object, NONE, a keyword or an amount not in the sentence, an account outside the list", async () => {
    const cases: [string, string, string?][] = [
      [answer({ reason: "x" }), AI_NONE],
      [`${answer({})}\n${answer({})}`, AI_NONE],
      [`[${answer({})}]`, AI_NONE],
      ["bukan json", AI_NONE],
      [answer({ kind: "NONE" }), AI_NONE],
      [answer({ pattern: "PT SINAR JAYA" }), AI_PATTERN],
      [answer({ minAmount: "50000000" }), AI_AMOUNT, "kalau PT SINAR ABADI kirim uang di atas 5 jt, saya mau lihat dulu"],
      [answer({ kind: "ACCOUNT", direction: "OUT", accountCode: "9999" }), AI_ACCOUNT],
      [answer({ kind: "ACCOUNT", direction: "OUT", accountCode: "1199" }), AI_ACCOUNT],
      [answer({ pattern: "TRSF" }), 'Kata kunci "TRSF" tidak menyebut pengirim atau penerima, jadi tidak bisa dijadikan aturan.', "kalau ada TRSF masuk, saya mau lihat dulu"],
    ];
    for (const [text, error, sentence] of cases) {
      await resetDb();
      const fresh = await makeGroup();
      expect(await ask(fresh, mock(text), sentence)).toEqual({ ok: false, error });
    }
    // An amount the sentence does hold is kept, in whole Rupiah.
    await resetDb();
    expect(await ask(await makeGroup(), mock(answer({ minAmount: "5000000" })), "kalau PT SINAR ABADI kirim uang di atas 5 jt, saya mau lihat dulu")).toMatchObject({ ok: true, draft: { minAmount: 5_000_000n } });
  });

  it("an exhausted budget returns the budget message and calls nothing", async () => {
    const g = await makeGroup();
    await db.firm.update({ where: { id: g.firm.id }, data: { aiMonthlyTokenBudget: 10 } });
    const m = mock(answer({}));
    expect(await ask(g, m)).toEqual({ ok: false, error: expect.stringMatching(/^Kuota token AI bulan ini tidak cukup/) });
    expect(m.calls).toBe(0);
  });

  it("only for a sentence the reader did not understand, only with a model; a failed call is said plainly", async () => {
    const g = await makeGroup();
    const m = mock(answer({}));
    expect(await ask(g, m, "akrualkan sewa Rp 5 jt setiap bulan")).toEqual({ ok: false, error: REFUSAL.journal });
    expect(await ask(g, m, '"BIAYA ADM" selalu 6190')).toEqual({ ok: false, error: AI_NOT_NEEDED });
    expect(m.calls).toBe(0);
    expect(await ask(g, null)).toEqual({ ok: false, error: AI_UNAVAILABLE });
    const broken = new MockProvider();
    broken.compileInstruction = async () => {
      throw new Error("AI 503: down");
    };
    expect(await ask(g, broken)).toEqual({ ok: false, error: AI_FAILED });
    expect(await db.aiUsage.findFirstOrThrow({ where: { ok: false } })).toMatchObject({ note: expect.stringMatching(/^Instruksi kantor — AI gagal/) });
  });

  it("the payload is the sentence and the account list (code and name), never 1190/1199 or the books", () => {
    const { user } = buildInstructionPrompt({ sentence: SENTENCE, accounts: [{ code: "6190", name: "Beban Umum Lain-lain" }] });
    expect(JSON.parse(user)).toEqual({ sentence: SENTENCE, accounts: [{ code: "6190", name: "Beban Umum Lain-lain" }] });
  });

  it("the account list sent leaves out banks, suspense, retained earnings and transfer accounts", async () => {
    const g = await makeGroup();
    let sent: { code: string }[] = [];
    const m = Object.assign(new MockProvider(), {
      compileInstruction: async (input: InstructionAiInput) => {
        sent = input.accounts;
        return { text: answer({}), promptTokens: 1, completionTokens: 1, model: "mock" };
      },
    });
    await ask(g, m);
    const codes = sent.map((a) => a.code);
    expect(codes).toContain("6190");
    for (const code of ["1101", "1999", "3200", "3290", "1190", "1199"]) expect(codes).not.toContain(code);
  });
});
