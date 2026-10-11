import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import type { AiItem, AiProvider, AiResult } from "@/lib/ai/provider";
import { driveAiRun, isStalled, latestAiRun, runAiSlice, startAiRun } from "@/lib/ai/run";
import { dateOnly } from "@/lib/format";

type Group = Awaited<ReturnType<typeof makeGroup>>;

/** Never a real model: answers every key with 6160 except `never`; `onCall` runs before it answers. */
class RunProvider implements AiProvider {
  readonly model = "run-test";
  asked: string[] = [];
  contexts: string[] = [];
  offered: string[][] = [];
  calls = 0;
  constructor(private opts: { never?: string[]; onCall?: (items: AiItem[]) => Promise<void> } = {}) {}
  async classify(items: AiItem[], accounts: { code: string; name: string }[] = [], context = ""): Promise<AiResult> {
    this.calls++;
    this.offered.push(accounts.map((a) => a.code));
    this.asked.push(...items.map((i) => i.key));
    this.contexts.push(context);
    await this.opts.onCall?.(items);
    const answers = items.filter((i) => !this.opts.never?.includes(i.key)).map((i) => ({ key: i.key, accountCode: "6160", confidence: 0.8, taxTag: null, reason: "uji" }));
    return { answers, promptTokens: 10 * items.length, completionTokens: 5 * items.length, model: this.model };
  }
  async mapAccounts(): Promise<never> {
    throw new Error("not used");
  }
}

let seq = 0;
/** Lines still in review on a simple guess, one per key, on the entity's first bank. */
async function lines(g: Group, who: "pt" | "owner", keys: string[]) {
  const bank = g[who].banks[0];
  const date = dateOnly(2026, 6, 3);
  const imp = await db.statementImport.create({ data: { firmId: g.firm.id, bankAccountId: bank.id, fileName: `s${++seq}.pdf`, format: "BCA", periodStart: date, periodEnd: date, openingBalance: 0n, closingBalance: 0n, rowCount: keys.length, continuityOk: true } });
  const out = [];
  for (const [i, key] of keys.entries()) {
    out.push(await db.bankTransaction.create({ data: { firmId: g.firm.id, entityId: g[who].entity.id, bankAccountId: bank.id, importId: imp.id, date, description: `TRSF KE ${key}`, merchantKey: key, direction: "OUT", amount: -1_000_000n, rowNumber: i + 1, rawRow: "synthetic", hash: `h${++seq}`, status: "NEEDS_REVIEW", method: "HEURISTIC", confidence: 0.3, reason: "Tebakan sederhana: uang keluar dianggap beban umum", suggestedCode: "6190", accountCode: "1999" } }));
  }
  return out;
}
const keys = (n: number, prefix = "TOKO") => Array.from({ length: n }, (_, i) => `${prefix} ${String(i).padStart(2, "0")}`);
const run = (id: string) => db.aiRun.findUniqueOrThrow({ where: { id } });

describe("background AI run", () => {
  beforeEach(resetDb);
  afterEach(() => vi.unstubAllEnvs());

  it("nothing on a simple guess: no run", async () => {
    const g = await makeGroup();
    expect(await startAiRun(db, { firmId: g.firm.id, clientId: g.client.id })).toBeNull();
    expect(await db.aiRun.count()).toBe(0);
    expect(await latestAiRun(db, g.client.id)).toBeNull();
  });

  it("progress moves batch by batch: the second call already sees the first batch counted and applied", async () => {
    const g = await makeGroup();
    await lines(g, "pt", keys(30)); // two batches of 15
    const started = (await startAiRun(db, { firmId: g.firm.id, clientId: g.client.id }))!;
    const seen: { asked: number; suggested: number; applied: number }[] = [];
    const provider = new RunProvider({
      onCall: async () => {
        const r = await run(started.id);
        seen.push({ asked: r.askedLines, suggested: r.suggestedLines, applied: await db.bankTransaction.count({ where: { method: "AI" } }) });
      },
    });
    await driveAiRun(db, started.id, { provider });
    expect(seen).toEqual([{ asked: 0, suggested: 0, applied: 0 }, { asked: 15, suggested: 15, applied: 15 }]);
    expect(await run(started.id)).toMatchObject({ status: "DONE", totalLines: 30, askedLines: 30, suggestedLines: 30, calls: 2 });
  });

  it("runs to completion: suggestions on every line, nothing posted", async () => {
    const g = await makeGroup();
    const created = await lines(g, "pt", [...keys(20), "TOKO 00"]); // 21 lines, 20 unique keys
    const started = (await startAiRun(db, { firmId: g.firm.id, clientId: g.client.id }))!;
    expect([started.status, started.totalLines, started.askedLines, started.calls]).toEqual(["RUNNING", 21, 0, 0]);
    expect(isStalled(started)).toBe(true); // no worker yet: a page view would resume it
    const journals = await db.journalEntry.count();

    const provider = new RunProvider();
    const r = await driveAiRun(db, started.id, { provider });
    expect(r).toMatchObject({ status: "DONE", done: true });
    const done = await run(started.id);
    expect(done).toMatchObject({ status: "DONE", totalLines: 21, askedLines: 21, suggestedLines: 21, calls: 2, note: null, skippedKeys: [], leaseToken: null, leaseUntil: null });
    expect(done.finishedAt).not.toBeNull();
    expect(provider.calls).toBe(2); // 15 + 5 unique keys
    for (const t of await db.bankTransaction.findMany({ where: { id: { in: created.map((c) => c.id) } } })) {
      expect([t.status, t.method, t.suggestedCode, t.accountCode, t.reason]).toEqual(["NEEDS_REVIEW", "AI", "6160", "1999", "AI: uji"]);
    }
    expect(await db.journalEntry.count()).toBe(journals);
    expect((await latestAiRun(db, g.client.id))?.id).toBe(started.id);
    expect(isStalled(done)).toBe(false);
    // Nothing left: the next start makes no run.
    expect(await startAiRun(db, { firmId: g.firm.id, clientId: g.client.id })).toBeNull();
  });

  it("a second start joins the running run and counts the new lines in", async () => {
    const g = await makeGroup();
    await lines(g, "pt", keys(2));
    const first = (await startAiRun(db, { firmId: g.firm.id, clientId: g.client.id }))!;
    await lines(g, "owner", keys(3, "WARUNG"));
    const second = (await startAiRun(db, { firmId: g.firm.id, clientId: g.client.id }))!;
    expect(second.id).toBe(first.id);
    expect(second.totalLines).toBe(5);
    expect(await db.aiRun.count()).toBe(1);
    await expect(startAiRun(db, { firmId: "another-firm", clientId: g.client.id })).rejects.toThrow();
  });

  it("two starts at once make one run", async () => {
    const g = await makeGroup();
    await lines(g, "pt", keys(3));
    const [a, b] = await Promise.all([startAiRun(db, { firmId: g.firm.id, clientId: g.client.id }), startAiRun(db, { firmId: g.firm.id, clientId: g.client.id })]);
    expect(a!.id).toBe(b!.id);
    expect(await db.aiRun.count()).toBe(1);
    // The database itself refuses a second RUNNING run; a finished one doesn't count.
    await expect(db.aiRun.create({ data: { firmId: g.firm.id, clientId: g.client.id } })).rejects.toThrow();
    await db.aiRun.create({ data: { firmId: g.firm.id, clientId: g.client.id, status: "DONE", finishedAt: new Date() } });
  });

  it("a line accepted while the run works keeps the accountant's decision", async () => {
    const g = await makeGroup();
    const [accepted, other] = await lines(g, "pt", ["TOKO ABC", "TOKO XYZ"]);
    const provider = new RunProvider({
      onCall: async () => {
        await db.bankTransaction.update({ where: { id: accepted.id }, data: { status: "REVIEWED", accountCode: "6190" } });
      },
    });
    const started = (await startAiRun(db, { firmId: g.firm.id, clientId: g.client.id }))!;
    await driveAiRun(db, started.id, { provider });
    const a = await db.bankTransaction.findUniqueOrThrow({ where: { id: accepted.id } });
    expect([a.status, a.method, a.suggestedCode, a.accountCode]).toEqual(["REVIEWED", "HEURISTIC", "6190", "6190"]);
    expect((await db.bankTransaction.findUniqueOrThrow({ where: { id: other.id } })).method).toBe("AI");
    expect(await run(started.id)).toMatchObject({ status: "DONE", askedLines: 2, suggestedLines: 1 });
  });

  it("a slice after its deadline does nothing and leaves the run for the next drive", async () => {
    const g = await makeGroup();
    await lines(g, "pt", keys(3));
    const started = (await startAiRun(db, { firmId: g.firm.id, clientId: g.client.id }))!;
    const provider = new RunProvider();
    expect(await runAiSlice(db, started.id, { provider, deadline: Date.now() - 1 })).toMatchObject({ status: "RUNNING", done: false, claimed: false });
    expect(provider.calls).toBe(0);
    const still = await run(started.id);
    expect([still.status, still.askedLines, still.leaseToken, still.leaseUntil]).toEqual(["RUNNING", 0, null, null]);
    expect(isStalled(still)).toBe(true);
    await driveAiRun(db, started.id, { provider });
    expect(await run(started.id)).toMatchObject({ status: "DONE", suggestedLines: 3, calls: 1 });
  });

  it("a lease held by another worker: no work", async () => {
    const g = await makeGroup();
    await lines(g, "pt", keys(3));
    const started = (await startAiRun(db, { firmId: g.firm.id, clientId: g.client.id }))!;
    const until = new Date(Date.now() + 60_000);
    await db.aiRun.update({ where: { id: started.id }, data: { leaseToken: "other", leaseUntil: until } });
    const provider = new RunProvider();
    expect(await driveAiRun(db, started.id, { provider })).toMatchObject({ status: "RUNNING", claimed: false });
    expect(provider.calls).toBe(0);
    const held = await run(started.id);
    expect([held.leaseToken, held.leaseUntil?.getTime(), held.askedLines]).toEqual(["other", until.getTime(), 0]);
    expect(isStalled(held)).toBe(false);
  });

  it("a key asked and left unanswered is not asked again in the same run", async () => {
    const g = await makeGroup();
    await lines(g, "pt", keys(20));
    const started = (await startAiRun(db, { firmId: g.firm.id, clientId: g.client.id }))!;
    const deadline = Date.now() + 1_000;
    // The first call outlasts the slice's deadline, so the second batch waits for the next slice.
    const provider = new RunProvider({
      never: ["TOKO 00"],
      onCall: async () => {
        while (Date.now() <= deadline) await new Promise((r) => setTimeout(r, 50));
      },
    });
    expect(await runAiSlice(db, started.id, { provider, deadline })).toMatchObject({ status: "RUNNING", done: false, claimed: true });
    const mid = await run(started.id);
    expect(mid).toMatchObject({ status: "RUNNING", askedLines: 15, suggestedLines: 14, calls: 1, skippedKeys: ["TOKO 00|OUT"], totalLines: 20, leaseToken: null });
    expect(mid.heartbeatAt.getTime()).toBeGreaterThan(started.heartbeatAt.getTime());

    await driveAiRun(db, started.id, { provider });
    expect(provider.asked.filter((k) => k === "TOKO 00")).toHaveLength(1);
    expect(provider.calls).toBe(2);
    expect(await run(started.id)).toMatchObject({ status: "DONE", askedLines: 20, suggestedLines: 19, calls: 2, skippedKeys: ["TOKO 00|OUT"] });
  });

  it("the monthly budget refusal ends the run with its message; lines keep their simple guess", async () => {
    vi.stubEnv("AI_MONTHLY_TOKEN_BUDGET", "1");
    const g = await makeGroup();
    const [line] = await lines(g, "pt", keys(3));
    const started = (await startAiRun(db, { firmId: g.firm.id, clientId: g.client.id }))!;
    const provider = new RunProvider();
    await driveAiRun(db, started.id, { provider });
    const done = await run(started.id);
    expect(done).toMatchObject({ status: "DONE", askedLines: 0, suggestedLines: 0, calls: 0 });
    expect(done.note).toMatch(/^Kuota token AI bulan ini tidak cukup/);
    expect(provider.calls).toBe(0);
    expect((await db.bankTransaction.findUniqueOrThrow({ where: { id: line.id } })).method).toBe("HEURISTIC");
  });

  it("the call cap holds across slices", async () => {
    vi.stubEnv("AI_MAX_CALLS_PER_RUN", "2");
    const g = await makeGroup();
    await lines(g, "pt", keys(3));
    const started = (await startAiRun(db, { firmId: g.firm.id, clientId: g.client.id }))!;
    await db.aiRun.update({ where: { id: started.id }, data: { calls: 2 } }); // earlier slices used the run's calls
    const provider = new RunProvider();
    await driveAiRun(db, started.id, { provider });
    expect(provider.calls).toBe(0);
    expect(await run(started.id)).toMatchObject({ status: "DONE", calls: 2, note: "Batas panggilan AI per proses tercapai." });
  });

  it("no provider: done with a note, nothing asked", async () => {
    const g = await makeGroup();
    const [line] = await lines(g, "pt", keys(2));
    const started = (await startAiRun(db, { firmId: g.firm.id, clientId: g.client.id }))!;
    expect(await driveAiRun(db, started.id, { provider: null })).toMatchObject({ status: "DONE", done: true });
    expect(await run(started.id)).toMatchObject({ status: "DONE", note: "AI belum diatur", askedLines: 0, calls: 0, leaseToken: null });
    expect((await db.bankTransaction.findUniqueOrThrow({ where: { id: line.id } })).method).toBe("HEURISTIC");
  });

  it("asks about the owner's lines as a person's books", async () => {
    const g = await makeGroup();
    await lines(g, "pt", ["TOKO ABC"]);
    const own = await lines(g, "owner", ["TOKO EMAS ANTAM"]);
    const started = (await startAiRun(db, { firmId: g.firm.id, clientId: g.client.id }))!;
    const provider = new RunProvider();
    await driveAiRun(db, started.id, { provider });
    expect(provider.calls).toBe(2); // one pass per kind of books
    expect(provider.contexts.filter((c) => /perorangan/.test(c))).toHaveLength(1);
    const ownCall = provider.asked.indexOf("TOKO EMAS ANTAM"); // one key per call here
    expect(provider.contexts[ownCall]).toMatch(/perorangan/);
    expect(provider.offered[ownCall]).not.toContain("1130"); // no trade receivables for a person
    expect(provider.offered[1 - ownCall]).toContain("1130");
    expect((await db.bankTransaction.findUniqueOrThrow({ where: { id: own[0].id } })).method).toBe("AI");
    expect(await run(started.id)).toMatchObject({ status: "DONE", suggestedLines: 2 });
  });
});
