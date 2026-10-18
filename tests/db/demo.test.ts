import { describe, expect, it } from "vitest";
import { db } from "../helpers";
import { liveUploadFile, seedDemo } from "@/lib/demo/seed";
import { verifyBooks } from "@/lib/demo/verify";
import { importStatement } from "@/lib/import/pipeline";
import { runControls } from "@/lib/controls";
import { MockProvider } from "@/lib/ai/provider";
import { masaReport } from "@/lib/tax/masa-report";
import { fakturRecon } from "@/lib/tax/faktur";
import { bankReasoning, bankSteps, DEMO_ANSWER } from "@/lib/approvals/reasoning";
import { accrualProposals } from "@/lib/adjust/accruals";

/** Lihat alasan: every AI line waiting in Review reads its seeded answer back by its recomputed cache key (cycle 2026-10-17-lihat-alasan). */
async function aiLinesMatch() {
  const lines = await db.bankTransaction.findMany({ where: { status: "NEEDS_REVIEW", method: "AI" }, include: { bankAccount: { include: { entity: true } } } });
  expect(lines.length).toBeGreaterThan(0);
  const out = [];
  for (const l of lines) {
    const f = await bankReasoning(db, { firmId: l.firmId, clientId: l.bankAccount.entity.clientId }, l.id);
    expect([l.description, f.answer?.model, f.sent?.description]).toEqual([l.description, "demo-seed", l.description.slice(0, 80)]);
    out.push(f);
  }
  return out;
}

/** Layer 2: the seeded demo (built through the real pipeline) matches generator ground truth. */
describe("demo seed vs ground truth", () => {
  it("seeds, verifies ALL PASS, and the live upload clears transfers while inferred source coverage stays in review with 0 AI calls", async () => {
    await seedDemo(db);
    const before = await verifyBooks(db);
    expect(before.failures).toEqual([]);
    expect(before.checks).toBeGreaterThan(900);

    // Usulan akrual (cycle 2026-10-18-usulan-akrual): every scenario vendor pays every month, so the demo proposes no accrual in any
    // month — Kotak's counts and the investor walk stay as they were.
    for (const c of await db.client.findMany({ select: { id: true } })) {
      for (const month of [3, 4, 5, 6, 7, 8, 9]) expect((await accrualProposals(db, c.id, 2026, month, { now: new Date("2026-12-01T00:00:00Z") })).map((p) => `${month}:${p.key}`)).toEqual([]);
    }

    // A tidy client remits what the previous masa owed: Pajak Masa ties on every demo company, from the opening on.
    const companies = await db.entity.findMany({ where: { kind: { not: "PERORANGAN" } }, select: { id: true, clientId: true } });
    for (const e of companies) for (const month of [3, 4, 5, 6, 7, 8]) {
      const r = await masaReport(db, { clientId: e.clientId, entityId: e.id, year: 2026, month, now: new Date(Date.UTC(2026, 8, 20)) });
      expect(r!.rows.filter((x) => x.status !== "PASS").map((x) => `${month}:${x.key}`)).toEqual([]);
    }

    // The demo's Coretax faktur tie every closed month; August waits on the DP and the machine still in Review.
    for (const e of companies) for (const month of [3, 4, 5, 6, 7, 8]) {
      const f = await fakturRecon(db, { clientId: e.clientId, entityId: e.id, year: 2026, month });
      const open = f.directions.flatMap((d) => d.unmatchedFaktur.map((x) => `${month}:${d.direction}:${x.name}`));
      expect(open).toEqual(month === 8 && f.directions.some((d) => d.unmatchedFaktur.length) ? ["8:KELUARAN:CV PETERNAKAN BERKAH JAYA DP AYAM", "8:MASUKAN:PT AGRO TEKNIK MANDIRI MESIN PAKAN OTOMATIS"] : []);
      expect(f.directions.flatMap((d) => d.unmatchedBook)).toEqual([]);
    }

    // CV Sinar Retail's two August lines (Kotak's and Review's walk): the grosir sale may go in bulk, the rack may not (74 %).
    const reasons = await aiLinesMatch();
    const sinar = (text: string) => bankSteps(reasons.find((f) => f.line.description.includes(text))!);
    expect(sinar("BELANJA GROSIR")[2].lines).toEqual([`4100 Penjualan · keyakinan 83% · pajak – · "Penjualan grosir"`, DEMO_ANSWER]);
    expect(sinar("BELANJA GROSIR")[3].checks!.at(-1)).toEqual({ ok: true, text: "Boleh disetujui massal." });
    expect(sinar("RAK DISPLAY")[3].checks!.at(-1)).toEqual({ ok: false, text: "Tidak ikut setujui massal: keyakinan di bawah 80%." });

    const client = await db.client.findFirstOrThrow({ where: { name: "Grup Ayam Nusantara" } });
    const c0 = Object.fromEntries((await runControls(db, client.id, 2026, 8)).map((c) => [c.key, c.status]));
    expect(c0.intercompany).toBe("REVIEW");

    const bri = await db.bankAccount.findFirstOrThrow({ where: { number: "012301004455509" } });
    const f = await liveUploadFile();
    const provider = new MockProvider({});
    const s = await importStatement(db, { bankAccountId: bri.id, fileName: f.fileName, data: f.data, provider });
    expect(provider.calls).toBe(0); // everything resolved by transfer/memory/cache
    expect(s.needsReview).toBe(1); // the new pharmacy merchant (cached AI suggestion)
    await aiLinesMatch(); // the live upload's line too (its answer is pre-cached by the seed)

    const after = Object.fromEntries((await runControls(db, client.id, 2026, 8)).map((c) => [c.key, c.status]));
    expect(after.intercompany).toBe("PASS");
    expect(after[`bank:${bri.id}`]).toBe("REVIEW");
    expect(after[`cont:${bri.id}`]).toBe("REVIEW"); // CMS rows do not declare full-month coverage
    expect((await verifyBooks(db, { includeLive: true })).failures).toEqual([]);
  }, 120_000);
});
