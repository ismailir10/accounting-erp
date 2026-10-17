import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { MockProvider } from "@/lib/ai/provider";

const ai = vi.hoisted(() => ({ provider: null as unknown }));
// Any code path that resolves the workspace's model gets the mock, so a call anywhere would be counted.
vi.mock("@/lib/settings/ai", async (original) => ({ ...(await original<typeof import("@/lib/settings/ai")>()), resolveProvider: async () => ai.provider }));

const { importStatement } = await import("@/lib/import/pipeline");
const { approveInstruction, scopeCharts, turnOffInstruction } = await import("@/lib/instructions/store");
const { parseInstruction, toJson } = await import("@/lib/instructions/compile");
const { previewInstruction } = await import("@/lib/instructions/preview");
const { runControls } = await import("@/lib/controls");
const { heldLine } = await import("@/lib/classify/dial");
const { approvalQueue } = await import("@/lib/approvals/queue");
const { saveAutomation } = await import("@/lib/settings/automation");

/**
 * Instruksi kantor at run time (cycle 2026-10-18-instruksi-kantor, accounting-rules 13, 14): an *Aturan akun* is a rule for the next
 * imports, a *Tahan di Review* only sends more to Review, *Matikan* drops both for what comes next, and nothing at run time reads the
 * sentence or calls a model. Lines already imported never move.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;
const csv = (opening: string, ...rows: string[]) => Buffer.from(["Tanggal;Keterangan;Debet;Kredit;Saldo", `01/08/2026;SALDO AWAL;;;${opening}`, ...rows, ""].join("\n"));
const FIRST = csv(
  "500.000.000,00",
  "03/08/2026;BIAYA ADM;15.000,00;0,00;499.985.000,00",
  "06/08/2026;PINDAH BUKU KE MANDIRI PT UJI SEJAHTERA;150.000.000,00;0,00;349.985.000,00",
);
const SECOND = csv(
  "349.985.000,00",
  "12/08/2026;BIAYA ADM;15.000,00;0,00;349.970.000,00",
  "13/08/2026;TRSF E-BANKING DB PT MAJU JAYA;7.500.000,00;0,00;342.470.000,00",
);
const MANDIRI = csv("0,00", "06/08/2026;PINDAH BUKU DARI BCA PT UJI SEJAHTERA;0,00;150.000.000,00;150.000.000,00");

const importTo = (g: G, which: 0 | 1, data: Buffer, provider: MockProvider | null = null) => importStatement(db, { bankAccountId: g.pt.banks[which].id, fileName: `f${which}.csv`, data, provider });
async function approve(g: G, sentence: string, clientId: string | null, edit: Record<string, unknown> = {}) {
  const accounts = (await scopeCharts(db, { firmId: g.firm.id, clientId })).accounts;
  const r = parseInstruction(sentence, accounts);
  if (!r.ok) throw new Error(r.error);
  const out = await approveInstruction(db, { firmId: g.firm.id, clientId, sentence, fields: { ...toJson(r.draft), ...edit } });
  if (!out.ok) throw new Error(out.error);
  return out.id;
}
/** A client rule for PT MAJU JAYA, as Review's *Selalu gunakan akun ini* makes it. */
const majuRule = (g: G) => db.rule.create({ data: { firmId: g.firm.id, clientId: g.client.id, pattern: "PT MAJU JAYA", direction: "OUT", accountCode: "6120", priority: 60, source: "USER" } });
const lines = async () =>
  (await db.bankTransaction.findMany({ orderBy: [{ date: "asc" }, { rowNumber: "asc" }] })).map((t) => ({ d: t.description, status: t.status, account: t.accountCode, suggested: t.suggestedCode, method: t.method, confidence: t.confidence, tax: t.taxTag, reason: t.reason, paired: t.matchedTxId !== null }));
const line = (text: string, date?: string) => db.bankTransaction.findFirstOrThrow({ where: { description: { contains: text }, ...(date ? { date: new Date(date) } : {}) } });

describe("instructions in the import", () => {
  beforeEach(async () => {
    await resetDb();
    ai.provider = null;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("no instruction = today, and instructions turned off leave the next import exactly as if there had been none", async () => {
    const run = async (withOff: boolean) => {
      await resetDb();
      const g = await makeGroup();
      await majuRule(g);
      if (withOff) {
        for (const [s, c] of [['"BIAYA ADM" selalu 6190', null], ["PT MAJU JAYA selalu ke Review", g.client.id], ["tandai pengeluaran > Rp10 jt", g.client.id]] as const) {
          expect(await turnOffInstruction(db, { firmId: g.firm.id, id: await approve(g, s, c) })).toEqual({ ok: true });
        }
      }
      const s1 = await importTo(g, 0, FIRST);
      const s2 = await importTo(g, 0, SECOND);
      return { s: [s1, s2].map((s) => ({ posted: s.posted, needsReview: s.needsReview, held: s.held, heldBy: s.heldBy, byMethod: s.byMethod })), lines: await lines(), controls: (await runControls(db, g.client.id, 2026, 8)).map((c) => ({ title: c.title, scope: c.scope, status: c.status, detail: c.detail, key: c.key.replace(/[a-z0-9]{20,}/g, "<id>") })) };
    };
    const today = await run(false);
    expect(today.lines).toEqual([
      { d: "BIAYA ADM", status: "POSTED", account: "7100", suggested: "7100", method: "RULE", confidence: 0.97, tax: null, reason: 'Aturan: keterangan mengandung "BIAYA ADM"', paired: false },
      { d: "PINDAH BUKU KE MANDIRI PT UJI SEJAHTERA", status: "POSTED", account: "1199", suggested: "1199", method: "TRANSFER", confidence: 0.92, tax: null, reason: "Transfer antar rekening sendiri (pasangan belum diimpor)", paired: false },
      { d: "BIAYA ADM", status: "POSTED", account: "7100", suggested: "7100", method: "RULE", confidence: 0.97, tax: null, reason: 'Aturan: keterangan mengandung "BIAYA ADM"', paired: false },
      { d: "TRSF E-BANKING DB PT MAJU JAYA", status: "POSTED", account: "6120", suggested: "6120", method: "RULE", confidence: 0.97, tax: null, reason: 'Aturan: keterangan mengandung "PT MAJU JAYA"', paired: false },
    ]);
    expect(today.s.every((s) => s.held === 0)).toBe(true);
    expect(today.controls.some((c) => c.key.startsWith("instr:"))).toBe(false);
    expect(await run(true)).toEqual(today);
  });

  it("an approved Aturan akun posts the next import's matching line to its account with the instruction's reason; lines posted before stay", async () => {
    const g = await makeGroup();
    await importTo(g, 0, FIRST);
    const before = await db.bankTransaction.findMany({ orderBy: { id: "asc" } });
    const entriesBefore = await db.journalEntry.findMany({ orderBy: { id: "asc" }, include: { lines: { orderBy: { id: "asc" } } } });
    await approve(g, "biaya admin bank selalu 6190", null, { pattern: "BIAYA ADM" });
    expect(await db.bankTransaction.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    const s = await importTo(g, 0, SECOND);
    expect(s).toMatchObject({ held: 0, byMethod: { RULE: 1 } });
    expect(await line("BIAYA ADM", "2026-08-12")).toMatchObject({ status: "POSTED", accountCode: "6190", method: "RULE", confidence: 0.97, reason: 'Instruksi kantor: keterangan memuat "BIAYA ADM"' });
    const posted = await db.journalEntry.findFirstOrThrow({ where: { bankTransactionId: (await line("BIAYA ADM", "2026-08-12")).id }, include: { lines: { include: { account: true } } } });
    expect(posted.lines.map((l) => [l.account.code, l.debit, l.credit]).sort()).toEqual([["1101", 0n, 15_000n], ["6190", 15_000n, 0n]]);
    // The line imported before the instruction is untouched: same row, same entries.
    expect(await db.bankTransaction.findUniqueOrThrow({ where: { id: (await line("BIAYA ADM", "2026-08-03")).id } })).toEqual(before.find((t) => t.description === "BIAYA ADM"));
    const entriesAfter = await db.journalEntry.findMany({ where: { id: { in: entriesBefore.map((e) => e.id) } }, orderBy: { id: "asc" }, include: { lines: { orderBy: { id: "asc" } } } });
    expect(entriesAfter).toEqual(entriesBefore);
  });

  it("a client rule on the same text still wins in its client", async () => {
    const g = await makeGroup();
    await db.rule.create({ data: { firmId: g.firm.id, clientId: g.client.id, pattern: "BIAYA ADM", direction: "OUT", accountCode: "7100", priority: 60, source: "USER" } });
    await approve(g, '"BIAYA ADM" selalu 6190', null);
    await importTo(g, 0, SECOND);
    expect(await line("BIAYA ADM")).toMatchObject({ status: "POSTED", accountCode: "7100", reason: 'Aturan: keterangan mengandung "BIAYA ADM"' });
  });

  it("with the dial's Aturan off, a line an instruction rule matches waits in Review like any rule match", async () => {
    const g = await makeGroup();
    await approve(g, '"BIAYA ADM" selalu 6190', g.client.id);
    await saveAutomation(db, { firmId: g.firm.id, settings: { transfer: true, rules: false, memory: true, cap: "", fluxFloor: "", fluxPercent: "50" } });
    const s = await importTo(g, 0, SECOND);
    expect(s.heldBy).toMatchObject({ rules: 1 });
    expect(await line("BIAYA ADM")).toMatchObject({ status: "NEEDS_REVIEW", accountCode: "1999", suggestedCode: "6190", method: "RULE", confidence: 0.97, reason: 'Otomasi aturan dimatikan di Pengaturan kantor. Instruksi kantor: keterangan memuat "BIAYA ADM"' });
  });

  it("Tahan di Review: a line a rule would post waits on 1999 with its suggestion, counted as held by instruksi kantor, in Kotak but never in the bulk accept", async () => {
    const g = await makeGroup();
    await majuRule(g);
    await approve(g, "PT MAJU JAYA selalu ke Review", g.client.id);
    const s = await importTo(g, 0, SECOND);
    expect(s).toMatchObject({ posted: 1, needsReview: 1, held: 1, heldBy: { instruction: 1 } });
    expect(heldLine(s.heldBy)).toBe("1 ditahan Otomasi kantor (instruksi kantor)");
    const maju = await line("PT MAJU JAYA");
    expect(maju).toMatchObject({ status: "NEEDS_REVIEW", accountCode: "1999", suggestedCode: "6120", method: "RULE", confidence: 0.97, reason: 'Ditahan instruksi kantor "PT MAJU JAYA selalu ke Review". Aturan: keterangan mengandung "PT MAJU JAYA"' });
    const q = await approvalQueue(db, { clientId: g.client.id, year: 2026, month: 8 });
    expect(q.bank.find((c) => c.id === maju.id)).toMatchObject({ suggestedCode: "6120", confident: false, reason: expect.stringMatching(/^Ditahan instruksi kantor/) });
    expect(q.confident.some((c) => c.id === maju.id)).toBe(false);
    // The other line of the file posts as before.
    expect(await line("BIAYA ADM")).toMatchObject({ status: "POSTED", accountCode: "7100" });
  });

  it("a held transfer pair stays linked: the new half waits, the earlier half on the transfer account is linked and untouched", async () => {
    const g = await makeGroup();
    await importTo(g, 0, FIRST);
    const earlier = await line("PINDAH BUKU KE");
    await approve(g, '"DARI BCA" selalu ke Review', g.client.id);
    const s = await importTo(g, 1, MANDIRI);
    expect(s).toMatchObject({ held: 1, heldBy: { instruction: 1 } });
    const fresh = await line("PINDAH BUKU DARI");
    expect(fresh).toMatchObject({ status: "NEEDS_REVIEW", accountCode: "1999", suggestedCode: "1199", method: "TRANSFER", matchedTxId: earlier.id, reason: 'Ditahan instruksi kantor ""DARI BCA" selalu ke Review". Transfer antar rekening sendiri (pasangan ditemukan)' });
    const after = await db.bankTransaction.findUniqueOrThrow({ where: { id: earlier.id } });
    expect(after).toEqual({ ...earlier, matchedTxId: fresh.id });
  });

  it("no free text at run time: an import, runControls and the preview with active instructions of every kind make zero provider calls", async () => {
    const mock = new MockProvider();
    ai.provider = mock;
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    const g = await makeGroup();
    await majuRule(g);
    await approve(g, '"BIAYA ADM" selalu 6190', null);
    await approve(g, "PT MAJU JAYA selalu ke Review", g.client.id);
    await approve(g, "tandai pengeluaran > Rp 5 jt", g.client.id);
    await importTo(g, 0, FIRST, mock);
    const s = await importTo(g, 0, SECOND, mock);
    expect(s.held).toBe(1);
    const controls = await runControls(db, g.client.id, 2026, 8);
    expect(controls.filter((c) => c.key.startsWith("instr:")).map((c) => [c.scope, c.status])).toEqual([["PT Uji", "REVIEW"], ["Andi", "PASS"]]);
    for (const sentence of ['"BIAYA ADM" selalu 6195', "PT SINAR selalu ke Review", "tandai penerimaan > Rp 1 jt"]) {
      const accounts = (await scopeCharts(db, { firmId: g.firm.id, clientId: g.client.id })).accounts;
      const r = parseInstruction(sentence.replace("6195", "6190"), accounts);
      if (!r.ok) throw new Error(r.error);
      await previewInstruction(db, { firmId: g.firm.id, clientId: g.client.id, draft: r.draft });
    }
    expect(mock.calls).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.aiUsage.count()).toBe(0);
  });
});
