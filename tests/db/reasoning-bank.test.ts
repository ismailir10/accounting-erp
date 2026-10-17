import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { MockProvider } from "@/lib/ai/provider";
import { importStatement } from "@/lib/import/pipeline";
import { merchantKey } from "@/lib/import/normalize";
import { createClient } from "@/lib/setup";
import { UNBACKED_CONFIDENCE } from "@/lib/ai/unbacked";
import { bankReasoning, bankSteps, NO_MATCH, NOT_FOUND } from "@/lib/approvals/reasoning";

const ATK_1 = "TRSF KELUAR TOKO ALAT TULIS MURNI NOTA 0815";
const ATK_2 = "TRSF KELUAR TOKO ALAT TULIS MURNI NOTA 0822";
const csv = (rows: string[]) => Buffer.from(["Tanggal;Keterangan;Debet;Kredit;Saldo", ...rows, ""].join("\n"));
const KEY = merchantKey(ATK_1);
const provider = () =>
  new MockProvider({
    [KEY]: { accountCode: "6160", confidence: 0.9, taxTag: null, reason: "Perlengkapan kantor" },
    [merchantKey("TRSF MASUK PT PELANGGAN SETIA")]: { accountCode: "1130", confidence: 0.85, taxTag: null, reason: "Pelunasan piutang usaha" },
  });
const lines = (bankAccountId: string) => db.bankTransaction.findMany({ where: { bankAccountId }, orderBy: [{ date: "asc" }, { rowNumber: "asc" }] });
/** What reading a panel could change: the AI cache, usage and runs, the lines, journals and proposals. */
const footprint = async () => [await db.aiSuggestion.count(), await db.aiUsage.count(), await db.aiRun.count(), await db.journalEntry.count(), await db.proposedEntry.count(), await db.evidenceAiCache.count(), JSON.stringify(await db.bankTransaction.findMany({ orderBy: { id: "asc" } }), (_, v) => (typeof v === "bigint" ? v.toString() : v))];

describe("Lihat alasan — an AI bank line", () => {
  beforeEach(resetDb);

  it("finds its cached answer by recomputing the key: the model, the description sent and the chart offered; reading writes nothing", async () => {
    const g = await makeGroup();
    expect(KEY).toBe("KELUAR TOKO ALAT TULIS MURNI NOTA"); // both notes share one counterparty
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "agu.csv", data: csv(["01/08/2026;SALDO AWAL;;;10.000.000", `15/08/2026;${ATK_1};250.000;;9.750.000`]), provider: provider() });
    const [line] = await lines(g.pt.banks[0].id);
    expect([line.method, line.suggestedCode]).toEqual(["AI", "6160"]);

    const before = await footprint();
    const f = await bankReasoning(db, { firmId: g.firm.id, clientId: g.client.id }, line.id);
    expect(await footprint()).toEqual(before);
    expect(f.answer).toMatchObject({ code: "6160", name: "Beban Perlengkapan Kantor", confidence: 0.9, reason: "Perlengkapan kantor", model: "mock" });
    expect(f.sent).toMatchObject({ client: "Grup Uji (agritech)", counterparty: KEY, description: ATK_1, withheld: ["1190", "1199"] });
    expect(f.sent!.accounts.map((a) => a.code)).not.toContain("1199");
    expect(f.sent!.accounts.map((a) => a.code)).not.toContain("1999");
    expect([f.replaced, f.capped, f.inChart, f.bulk]).toEqual([null, null, true, { ok: true }]);

    const steps = bankSteps(f);
    expect(steps.map((s) => s.label)).toEqual(["Dicek dulu tanpa AI", "Dikirim ke AI", "Jawaban AI", "Diperiksa Buku", "Belum dicatat"]);
    // Exactly the fields sent: client, direction, counterparty, description (≤ 80), the number of accounts — no amount, date or number.
    expect(steps[1].lines).toEqual([`Klien: "Grup Uji (agritech)"`, "Arah: uang keluar", `Pihak lawan: ${KEY}`, `Keterangan: "${ATK_1}"`, `Daftar akun: ${f.sent!.accounts.length} akun, tanpa 1190 dan 1199`]);
    expect(steps[1].lines.join(" ")).not.toMatch(/250|2026|1111111111/);
    expect(steps[2].lines[1]).toMatch(/^mock, \d+ \w{3} \d{4}$/);
    expect(steps[3].checks).toEqual([{ ok: true, text: "Kode 6160 ada di bagan akun klien." }, { ok: true, text: "Boleh disetujui massal." }]);
  });

  it("names the description that was sent: the batch's last one for its counterparty, each import its own", async () => {
    const g = await makeGroup();
    // One batch: one item per counterparty, so the later note is what the model read for both lines.
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "agu.csv", data: csv(["01/08/2026;SALDO AWAL;;;10.000.000", `15/08/2026;${ATK_1};250.000;;9.750.000`, `22/08/2026;${ATK_2};100.000;;9.650.000`]), provider: provider() });
    const [a, b] = await lines(g.pt.banks[0].id);
    for (const l of [a, b]) expect((await bankReasoning(db, { firmId: g.firm.id, clientId: g.client.id }, l.id)).sent?.description).toBe(ATK_2);
    // Another month, another batch, another description: its own.
    const sept = "TRSF KELUAR TOKO ALAT TULIS MURNI NOTA 0903";
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "sep.csv", data: csv(["01/09/2026;SALDO AWAL;;;9.650.000", `03/09/2026;${sept};50.000;;9.600.000`]), provider: provider() });
    const c = (await lines(g.pt.banks[0].id))[2];
    expect((await bankReasoning(db, { firmId: g.firm.id, clientId: g.client.id }, c.id)).sent?.description).toBe(sept);
    expect((await bankReasoning(db, { firmId: g.firm.id, clientId: g.client.id }, a.id)).sent?.description).toBe(ATK_2);
  });

  it("shows the original account of a receivable Buku replaced, below the bulk accept", async () => {
    const g = await makeGroup();
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "agu.csv", data: csv(["01/08/2026;SALDO AWAL;;;10.000.000", "05/08/2026;TRSF MASUK PT PELANGGAN SETIA;;5.000.000;15.000.000"]), provider: provider() });
    const [line] = await lines(g.pt.banks[0].id);
    const f = await bankReasoning(db, { firmId: g.firm.id, clientId: g.client.id }, line.id);
    expect([f.stored.code, f.stored.confidence, f.answer?.code, f.answer?.confidence]).toEqual(["4100", UNBACKED_CONFIDENCE, "1130", 0.85]);
    expect(f.replaced).toEqual({ from: { code: "1130", name: "Piutang Usaha" }, to: { code: "4100", name: "Penjualan" }, what: "piutang usaha" });
    const steps = bankSteps(f);
    expect(steps[2].lines[0]).toBe(`1130 Piutang Usaha · keyakinan 85% · pajak – · "Pelunasan piutang usaha"`);
    expect(steps[3].checks).toEqual([
      { ok: true, text: "Kode 4100 ada di bagan akun klien." },
      { ok: false, text: "Diganti: AI mengusulkan 1130 Piutang Usaha, tetapi belum ada piutang usaha tercatat untuk entitas ini, jadi usulannya 4100 Penjualan dengan keyakinan paling tinggi 55%." },
      { ok: false, text: "Tidak ikut setujui massal: keyakinan di bawah 80%." },
    ]);
  });

  it("says the answer can't be matched once the chart version moved, and shows only the stored suggestion", async () => {
    const g = await makeGroup();
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "agu.csv", data: csv(["01/08/2026;SALDO AWAL;;;10.000.000", `15/08/2026;${ATK_1};250.000;;9.750.000`]), provider: provider() });
    const [line] = await lines(g.pt.banks[0].id);
    await db.client.update({ where: { id: g.client.id }, data: { coaVersion: { increment: 1 } } }); // an account added in Bagan akun
    const f = await bankReasoning(db, { firmId: g.firm.id, clientId: g.client.id }, line.id);
    expect([f.sent, f.answer, f.replaced]).toEqual([null, null, null]);
    const steps = bankSteps(f);
    expect(steps[1].lines).toEqual([NO_MATCH]);
    expect(steps[2].lines).toEqual([`6160 Beban Perlengkapan Kantor · keyakinan 90% · pajak – · "Perlengkapan kantor"`]); // no model, no date
  });

  it("never matches another client's answer for the same counterparty, and refuses another client's line", async () => {
    const g = await makeGroup();
    const other = await db.$transaction((tx) => createClient(tx, g.firm.id, { name: "Klien Lain", industry: "agritech", entities: [{ name: "PT Lain", shortName: "PT Lain", kind: "PT", banks: [{ bank: "BCA", number: "9999999999", label: "BCA Lain" }] }], rules: [] }));
    const file = csv(["01/08/2026;SALDO AWAL;;;10.000.000", `15/08/2026;${ATK_1};250.000;;9.750.000`]);
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "agu.csv", data: file, provider: provider() });
    await importStatement(db, { bankAccountId: other.entities[0].banks[0].id, fileName: "agu.csv", data: file, provider: null });
    const [mine] = await lines(g.pt.banks[0].id);
    const [theirs] = await lines(other.entities[0].banks[0].id);
    // Even a line reading exactly as the first client's answer finds nothing: the key holds the client.
    await db.bankTransaction.update({ where: { id: theirs.id }, data: { method: "AI", suggestedCode: mine.suggestedCode, confidence: mine.confidence, reason: mine.reason } });
    const f = await bankReasoning(db, { firmId: g.firm.id, clientId: other.client.id }, theirs.id);
    expect([f.sent, f.answer]).toEqual([null, null]);
    await expect(bankReasoning(db, { firmId: g.firm.id, clientId: other.client.id }, mine.id)).rejects.toThrow(NOT_FOUND);
    // A line that is not an AI suggestion has no panel.
    await db.bankTransaction.update({ where: { id: theirs.id }, data: { method: "HEURISTIC" } });
    await expect(bankReasoning(db, { firmId: g.firm.id, clientId: other.client.id }, theirs.id)).rejects.toThrow(NOT_FOUND);
  });
});
