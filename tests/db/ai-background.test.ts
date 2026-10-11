import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { MockProvider, type AiItem } from "@/lib/ai/provider";
import { importStatement } from "@/lib/import/pipeline";
import { AI_RUN_BUDGET_MS, FUNCTION_LIMIT_MS, latestAiRun, resumeAiRun, runInBackground, startAiRun } from "@/lib/ai/run";
import { AI_TIMEOUT_MS } from "@/lib/ai/provider";
import { continueRun, requestNextSlice } from "@/lib/ai/background";
import { dateOnly } from "@/lib/format";
import type { Db } from "@/lib/db";

type Group = Awaited<ReturnType<typeof makeGroup>>;

const csv = (rows: string[]) => Buffer.from(["Tanggal;Keterangan;Debet;Kredit;Saldo", ...rows, ""].join("\n"));
// August teaches the cache one counterparty; September repeats it, adds a new one twice, and a line that names no one.
const august = csv(["01/08/2026;SALDO AWAL;;;10.000.000", "05/08/2026;TRSF KELUAR TOKO SINAR JAYA;1.000.000;;9.000.000"]);
const september = csv([
  "01/09/2026;SALDO AWAL;;;9.000.000",
  "03/09/2026;TRSF KELUAR TOKO SINAR JAYA;500.000;;8.500.000",
  "04/09/2026;TRSF KELUAR CV BARU MAKMUR;200.000;;8.300.000",
  "05/09/2026;TRSF KELUAR CV BARU MAKMUR;100.000;;8.200.000",
  "06/09/2026;BI FAST INCOMING;;1.000.000;9.200.000",
]);
const answer = (accountCode: string) => ({ accountCode, confidence: 0.8, taxTag: null, reason: "uji" });
/** Never a real model; counts and names what it was asked. */
function spy(table: Record<string, ReturnType<typeof answer>> = {}) {
  const provider = new MockProvider(table);
  const asked: string[] = [];
  const classify = provider.classify.bind(provider);
  provider.classify = async (items: AiItem[]) => {
    asked.push(...items.map((i) => i.key));
    return classify(items);
  };
  return { provider, asked };
}

let seq = 0;
/** Lines still in review on a simple guess, one per key (as tests/db/ai-run.test.ts). */
async function lines(g: Group, keys: string[]) {
  const bank = g.pt.banks[0];
  const date = dateOnly(2026, 6, 3);
  const imp = await db.statementImport.create({ data: { firmId: g.firm.id, bankAccountId: bank.id, fileName: `bg${++seq}.pdf`, format: "BCA", periodStart: date, periodEnd: date, openingBalance: 0n, closingBalance: 0n, rowCount: keys.length, continuityOk: true } });
  for (const [i, key] of keys.entries()) {
    await db.bankTransaction.create({ data: { firmId: g.firm.id, entityId: g.pt.entity.id, bankAccountId: bank.id, importId: imp.id, date, description: `TRSF KE ${key}`, merchantKey: key, direction: "OUT", amount: -1_000_000n, rowNumber: i + 1, rawRow: "synthetic", hash: `bg${++seq}`, status: "NEEDS_REVIEW", method: "HEURISTIC", confidence: 0.3, reason: "Tebakan sederhana: uang keluar dianggap beban umum", suggestedCode: "6190", accountCode: "1999" } });
  }
}
const keys = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix} ${String(i).padStart(2, "0")}`);

describe("import first, AI after (aiLater)", () => {
  beforeEach(resetDb);
  afterEach(() => vi.unstubAllEnvs());

  it("makes no AI call inside the import, applies cached answers and hands the rest to the background run", async () => {
    const g = await makeGroup();
    const bank = g.pt.banks[0].id;
    // Inline (seed and tests): the August import asks the model and stores its answer.
    const first = spy({ "KELUAR TOKO SINAR JAYA": answer("6160") });
    await importStatement(db, { bankAccountId: bank, fileName: "agu.csv", data: august, provider: first.provider });
    expect(first.asked).toEqual(["KELUAR TOKO SINAR JAYA"]);

    const later = spy({ "KELUAR TOKO SINAR JAYA": answer("6160"), "KELUAR CV BARU MAKMUR": answer("6150") });
    const summary = await importStatement(db, { bankAccountId: bank, fileName: "sep.csv", data: september, provider: later.provider, aiLater: true });
    expect(later.provider.calls).toBe(0);
    // One cached answer; the two CV BARU MAKMUR lines wait for the run; the nameless line is a question for the client, not the model.
    expect(summary.ai).toEqual({ calls: 0, cacheHits: 1, later: 2 });
    expect(JSON.stringify(summary)).not.toContain("AI tidak aktif");
    const rows = await db.bankTransaction.findMany({ where: { bankAccountId: bank, date: { gte: dateOnly(2026, 9, 1) } }, orderBy: { rowNumber: "asc" } });
    expect(rows.map((r) => [r.merchantKey, r.status, r.method, r.suggestedCode])).toEqual([
      ["KELUAR TOKO SINAR JAYA", "NEEDS_REVIEW", "AI", "6160"],
      ["KELUAR CV BARU MAKMUR", "NEEDS_REVIEW", "HEURISTIC", "6190"],
      ["KELUAR CV BARU MAKMUR", "NEEDS_REVIEW", "HEURISTIC", "6190"],
      [rows[3].merchantKey, "NEEDS_REVIEW", "HEURISTIC", "4100"],
    ]);

    // After the response: the background run asks about the rest, once, and posts nothing.
    const journals = await db.journalEntry.count();
    await runInBackground(db, { firmId: g.firm.id, clientId: g.client.id, provider: later.provider });
    expect(later.asked).toEqual(["KELUAR CV BARU MAKMUR"]);
    const run = (await latestAiRun(db, g.client.id))!;
    expect(run).toMatchObject({ status: "DONE", totalLines: 2, askedLines: 2, suggestedLines: 2, calls: 1 });
    const after = await db.bankTransaction.findMany({ where: { bankAccountId: bank, merchantKey: "KELUAR CV BARU MAKMUR" } });
    expect(after.map((r) => [r.status, r.method, r.suggestedCode, r.accountCode])).toEqual([["NEEDS_REVIEW", "AI", "6150", "1999"], ["NEEDS_REVIEW", "AI", "6150", "1999"]]);
    expect(await db.journalEntry.count()).toBe(journals);
  });

  it("without aiLater the import is unchanged: no provider says AI tidak aktif", async () => {
    const g = await makeGroup();
    const summary = await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "sep.csv", data: september, provider: null });
    expect(summary.ai).toMatchObject({ calls: 0, cacheHits: 0, note: "AI tidak aktif" });
    expect(summary.ai.later).toBeUndefined();
  });
});

describe("runInBackground", () => {
  beforeEach(resetDb);
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does nothing when no line is on a simple guess", async () => {
    const g = await makeGroup();
    const { provider } = spy();
    await runInBackground(db, { firmId: g.firm.id, clientId: g.client.id, provider });
    expect([provider.calls, await db.aiRun.count()]).toEqual([0, 0]);
  });

  it("drives a second run once when lines joined just as the first finished", async () => {
    const g = await makeGroup();
    await lines(g, keys(3, "TOKO"));
    const { provider, asked } = spy(Object.fromEntries([...keys(3, "TOKO"), ...keys(2, "BARU")].map((k) => [k, answer("6160")])));
    // A concurrent import commits its lines after the slice's recount, right before the run is marked DONE.
    let joined = false;
    const racing = new Proxy(db, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop !== "aiRun") return typeof value === "function" ? value.bind(target) : value;
        return new Proxy(value, {
          get(model, method) {
            const fn = Reflect.get(model, method);
            if (method !== "update") return typeof fn === "function" ? fn.bind(model) : fn;
            return async (args: { data: { status?: string } }) => {
              if (args.data.status === "DONE" && !joined) {
                joined = true;
                await lines(g, keys(2, "BARU"));
              }
              return model.update(args as Parameters<typeof model.update>[0]);
            };
          },
        });
      },
    }) as Db;
    await runInBackground(racing, { firmId: g.firm.id, clientId: g.client.id, provider });
    expect(joined).toBe(true);
    expect(asked).toEqual([...keys(3, "TOKO"), ...keys(2, "BARU")]);
    const runs = await db.aiRun.findMany({ orderBy: { createdAt: "asc" } });
    expect(runs.map((r) => [r.status, r.totalLines, r.suggestedLines])).toEqual([["DONE", 3, 3], ["DONE", 2, 2]]);
    expect(await db.bankTransaction.count({ where: { method: "HEURISTIC" } })).toBe(0);
  });

  it("does not start again for lines the run left behind (call cap): they wait for the next import or Minta saran AI", async () => {
    vi.stubEnv("AI_MAX_CALLS_PER_RUN", "1");
    const g = await makeGroup();
    await lines(g, keys(20, "TOKO"));
    const { provider } = spy(Object.fromEntries(keys(20, "TOKO").map((k) => [k, answer("6160")])));
    await runInBackground(db, { firmId: g.firm.id, clientId: g.client.id, provider });
    expect(provider.calls).toBe(1);
    const runs = await db.aiRun.findMany();
    expect(runs.map((r) => [r.status, r.calls, r.suggestedLines, r.note])).toEqual([["DONE", 1, 15, "Batas panggilan AI per proses tercapai."]]);
  });

  it("never throws: an error is logged without the client's data and the run can resume later", async () => {
    const g = await makeGroup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { provider } = spy();
    await expect(runInBackground(db, { firmId: "another-firm", clientId: g.client.id, provider })).resolves.toEqual({ continueRunId: null });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/^AI run for client .* stopped: /);
  });

  it("a slice leaves room for its last call inside the function limit", () => {
    expect(AI_RUN_BUDGET_MS + AI_TIMEOUT_MS).toBeLessThanOrEqual(FUNCTION_LIMIT_MS - 20_000);
  });

  it("a time box that ends with work left asks for the next slice; a finished run doesn't", async () => {
    const g = await makeGroup();
    await lines(g, keys(40, "TOKO"));
    const slow = spy(Object.fromEntries(keys(40, "TOKO").map((k) => [k, answer("6160")])));
    const classify = slow.provider.classify.bind(slow.provider);
    slow.provider.classify = async (items: AiItem[]) => {
      await new Promise((r) => setTimeout(r, 40));
      return classify(items);
    };
    const first = await runInBackground(db, { firmId: g.firm.id, clientId: g.client.id, provider: slow.provider, budgetMs: 20 });
    const run = (await db.aiRun.findFirstOrThrow())!;
    expect(first).toEqual({ continueRunId: run.id });
    expect(run.status).toBe("RUNNING");
    expect(run.leaseUntil).toBeNull(); // released: the next slice may claim it
    const rest = await runInBackground(db, { firmId: g.firm.id, clientId: g.client.id, provider: slow.provider });
    expect(rest).toEqual({ continueRunId: null });
    expect((await db.aiRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("DONE");
  });

  it("continues only a stalled run of an organisation with active access", async () => {
    const g = await makeGroup();
    await lines(g, keys(3, "TOKO"));
    const run = (await startAiRun(db, { firmId: g.firm.id, clientId: g.client.id }))!;
    const scheduled: string[] = [];
    const schedule = () => void scheduled.push(run.id);
    const now = new Date();

    await db.aiRun.update({ where: { id: run.id }, data: { leaseUntil: new Date(now.getTime() + 60_000) } });
    expect(await continueRun(db, run.id, { now, schedule })).toBe(false); // a worker holds it
    await db.aiRun.update({ where: { id: run.id }, data: { leaseUntil: null } });
    expect(await continueRun(db, run.id, { now, schedule })).toBe(true); // stalled, organisation ACTIVE (createFirm's open grant)
    expect(scheduled).toEqual([run.id]);

    await db.firm.update({ where: { id: g.firm.id }, data: { suspendedAt: new Date(now.getTime() - 1000) } });
    expect(await continueRun(db, run.id, { now, schedule })).toBe(false); // suspended: no AI work
    await db.firm.update({ where: { id: g.firm.id }, data: { suspendedAt: null } });
    await db.accessGrant.updateMany({ where: { firmId: g.firm.id }, data: { revokedAt: new Date(now.getTime() - 1000) } });
    await db.accessGrant.create({ data: { firmId: g.firm.id, kind: "TRIAL", startsAt: new Date(now.getTime() - 10 * 86_400_000), endsAt: new Date(now.getTime() - 86_400_000) } });
    expect(await continueRun(db, run.id, { now, schedule })).toBe(false); // read-only: no AI work
    expect(scheduled).toHaveLength(1);

    await db.accessGrant.create({ data: { firmId: g.firm.id, kind: "PAID", startsAt: new Date(now.getTime() - 1000), endsAt: null } });
    await db.aiRun.update({ where: { id: run.id }, data: { status: "DONE" } });
    expect(await continueRun(db, run.id, { now, schedule })).toBe(false); // finished
    expect(await continueRun(db, "cmv2unknown00000000000000", { now, schedule })).toBe(false);
  });

  it("resuming drives only the run it validated: a run that finished in the meantime never starts a new one", async () => {
    const g = await makeGroup();
    await lines(g, keys(3, "TOKO"));
    const run = (await startAiRun(db, { firmId: g.firm.id, clientId: g.client.id }))!;
    // Another worker finished it at the call cap with the lines still on a simple guess (Codex review of #145).
    await db.aiRun.update({ where: { id: run.id }, data: { status: "DONE", finishedAt: new Date(), note: "Batas panggilan AI tercapai." } });
    const late = spy(Object.fromEntries(keys(3, "TOKO").map((k) => [k, answer("6160")])));
    expect(await resumeAiRun(db, run.id, { provider: late.provider })).toEqual({ continueRunId: null });
    expect(late.asked).toEqual([]);
    expect(await db.aiRun.count()).toBe(1);

    // A stalled run is worked to the end, as the same run.
    const g2 = await makeGroup();
    await lines(g2, keys(2, "WARUNG"));
    const stalled = (await startAiRun(db, { firmId: g2.firm.id, clientId: g2.client.id }))!;
    const resumed = spy(Object.fromEntries(keys(2, "WARUNG").map((k) => [k, answer("6160")])));
    expect(await resumeAiRun(db, stalled.id, { provider: resumed.provider })).toEqual({ continueRunId: null });
    expect(resumed.asked).toHaveLength(2);
    expect((await db.aiRun.findUniqueOrThrow({ where: { id: stalled.id } })).status).toBe("DONE");
    expect(await db.aiRun.count({ where: { clientId: g2.client.id } })).toBe(1);
  });

  it("asks for the next slice with a signed token, only when the app can sign it", async () => {
    vi.stubEnv("APP_URL", "https://buku.test/");
    vi.stubEnv("SETTINGS_SECRET", "k".repeat(40));
    const sent: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    expect(await requestNextSlice("cmv2abc123def456ghi789jk", fetchImpl)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://buku.test/api/ai-run");
    expect(sent[0].body).toMatchObject({ runId: "cmv2abc123def456ghi789jk", exp: expect.any(Number), sig: expect.any(String) });
    expect(JSON.stringify(sent[0].body)).not.toContain("k".repeat(40));

    vi.stubEnv("SETTINGS_SECRET", "");
    expect(await requestNextSlice("cmv2abc123def456ghi789jk", fetchImpl)).toBe(false);
    expect(sent).toHaveLength(1);
  });
});

