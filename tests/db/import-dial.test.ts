import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { importStatement } from "@/lib/import/pipeline";
import { merchantKey } from "@/lib/import/normalize";
import { MockProvider } from "@/lib/ai/provider";
import { reviewTransaction } from "@/lib/review";
import { approvalQueue } from "@/lib/approvals/queue";
import { entryOrigins } from "@/lib/reports/entry-origin";
import { trialBalance } from "@/lib/reports/ledger";
import { saveAutomation, type AutomationInput } from "@/lib/settings/automation";
import { dateOnly } from "@/lib/format";

/**
 * Otomasi kantor in the import pipeline (cycle 2026-10-17-otomasi, accounting-rules 14): the firm's dial can only send more lines to
 * Review. A default firm imports exactly as before; AI never posts; a held pair never moves a half imported earlier.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;
const csv = (opening: string, ...rows: string[]) => Buffer.from(["Tanggal;Keterangan;Debet;Kredit;Saldo", `01/08/2026;SALDO AWAL;;;${opening}`, ...rows, ""].join("\n"));
const BCA = csv(
  "500.000.000,00",
  "03/08/2026;BIAYA ADM;15.000,00;0,00;499.985.000,00", // firm rule → 7100
  "04/08/2026;TRSF E-BANKING DB HJ MARYAM SEWA GUDANG;2.500.000,00;0,00;497.485.000,00", // remembered → 6120
  "05/08/2026;TRSF E-BANKING DB CV SUMBER VAKSIN;2.000.000,00;0,00;495.485.000,00", // AI, sure (0.99)
  "06/08/2026;PINDAH BUKU KE MANDIRI PT UJI SEJAHTERA;150.000.000,00;0,00;345.485.000,00", // own transfer, other half not yet imported
  "07/08/2026;TRSF E-BANKING CR PT MITRA UNGGAS;0,00;55.500.000,00;400.985.000,00", // unknown to the model: simple guess
  "10/08/2026;TRSF E-BANKING DB PT PAKAN JAYA;11.100.000,00;0,00;389.885.000,00", // client rule → 5100 with PPN masukan
);
const MANDIRI = csv("0,00", "06/08/2026;PINDAH BUKU DARI BCA PT UJI SEJAHTERA;0,00;150.000.000,00;150.000.000,00");
const MARYAM = "TRSF E-BANKING DB HJ MARYAM SEWA GUDANG";
const DEFAULTS: AutomationInput = { transfer: true, rules: true, memory: true, cap: "", fluxFloor: "", fluxPercent: "50" };

const ai = () => new MockProvider({ "CV SUMBER VAKSIN": { accountCode: "5100", confidence: 0.99, taxTag: null, reason: "obat ternak" } });
async function remember(g: G) {
  await db.memory.create({ data: { clientId: g.client.id, merchantKey: merchantKey(MARYAM), direction: "OUT", accountCode: "6120", hits: 3 } });
}
const importBca = (g: G) => importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca.csv", data: BCA, provider: ai() });
const importMandiri = (g: G) => importStatement(db, { bankAccountId: g.pt.banks[1].id, fileName: "mandiri.csv", data: MANDIRI, provider: null });
const dial = (g: G, settings: Partial<AutomationInput>) => saveAutomation(db, { firmId: g.firm.id, settings: { ...DEFAULTS, ...settings } });

async function lines(bankAccountId: string) {
  const rows = await db.bankTransaction.findMany({ where: { bankAccountId }, orderBy: { rowNumber: "asc" } });
  return rows.map((t) => ({ d: t.description, status: t.status, account: t.accountCode, suggested: t.suggestedCode, method: t.method, confidence: t.confidence, tax: t.taxTag, reason: t.reason, paired: t.matchedTxId !== null }));
}
const line = (text: string) => db.bankTransaction.findFirstOrThrow({ where: { description: { contains: text } } });
/** Everything a report reads: every bank line as stored, and every journal entry with its lines. */
async function books() {
  return {
    bank: await db.bankTransaction.findMany({ orderBy: { id: "asc" } }),
    entries: await db.journalEntry.findMany({ orderBy: { id: "asc" }, include: { lines: { orderBy: { id: "asc" } } } }),
  };
}

describe("import under the firm's Otomasi kantor dial", () => {
  beforeEach(resetDb);

  it("default settings post and hold exactly the lines they did before the dial, and AI never posts", async () => {
    const g = await makeGroup();
    await remember(g);
    const s = await importBca(g);
    expect(s).toMatchObject({ rows: 6, posted: 4, needsReview: 2, held: 0, heldBy: {}, byMethod: { RULE: 2, MEMORY: 1, TRANSFER: 1, AI: 1, HEURISTIC: 1 } });
    expect(await lines(g.pt.banks[0].id)).toEqual([
      { d: "BIAYA ADM", status: "POSTED", account: "7100", suggested: "7100", method: "RULE", confidence: 0.97, tax: null, reason: expect.not.stringMatching(/Otomasi|batas/), paired: false },
      { d: MARYAM, status: "POSTED", account: "6120", suggested: "6120", method: "MEMORY", confidence: 0.95, tax: null, reason: 'Pernah dikonfirmasi 3× untuk "HJ MARYAM SEWA GUDANG"', paired: false },
      // A sure AI answer (99 %) still waits for a person (invariant 4).
      { d: "TRSF E-BANKING DB CV SUMBER VAKSIN", status: "NEEDS_REVIEW", account: "1999", suggested: "5100", method: "AI", confidence: 0.99, tax: null, reason: expect.any(String), paired: false },
      { d: "PINDAH BUKU KE MANDIRI PT UJI SEJAHTERA", status: "POSTED", account: "1199", suggested: "1199", method: "TRANSFER", confidence: 0.92, tax: null, reason: "Transfer antar rekening sendiri (pasangan belum diimpor)", paired: false },
      { d: "TRSF E-BANKING CR PT MITRA UNGGAS", status: "NEEDS_REVIEW", account: "1999", suggested: "4100", method: "HEURISTIC", confidence: expect.any(Number), tax: null, reason: "Tebakan sederhana: uang masuk dianggap penjualan", paired: false },
      { d: "TRSF E-BANKING DB PT PAKAN JAYA", status: "POSTED", account: "5100", suggested: "5100", method: "RULE", confidence: 0.97, tax: "PPN_MASUKAN", reason: expect.not.stringMatching(/Otomasi|batas/), paired: false },
    ]);
    // The other half arrives: paired and posted, as before.
    expect(await importMandiri(g)).toMatchObject({ posted: 1, needsReview: 0, held: 0, byMethod: { TRANSFER: 1 } });
    expect((await lines(g.pt.banks[1].id))[0]).toMatchObject({ status: "POSTED", account: "1199", confidence: 0.99, paired: true });
    expect((await line("PINDAH BUKU KE")).matchedTxId).not.toBeNull();
    const tb = await trialBalance(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, dateOnly(2026, 8, 31));
    const net = (code: string) => tb.find((r) => r.account.code === code)?.net ?? 0n;
    expect([net("1199"), net("7100"), net("6120"), net("1999")]).toEqual([0n, 15_000n, 2_500_000n, 2_000_000n - 55_500_000n]);
  });

  it("every switch on and no cap, written by a save, imports identically to a firm that never saved", async () => {
    const run = async (save: boolean) => {
      await resetDb();
      const g = await makeGroup();
      await remember(g);
      if (save) {
        await dial(g, { rules: false, cap: "1" });
        await dial(g, {});
      }
      const s = await importBca(g);
      const m = await importMandiri(g);
      return { s: { ...s, importId: "", pendingReview: s.pendingReview }, m: { ...m, importId: "" }, bca: await lines(g.pt.banks[0].id), mandiri: await lines(g.pt.banks[1].id) };
    };
    expect(await run(true)).toEqual(await run(false));
  });

  it("with Aturan, Pilihan yang diingat and Transfer off, those lines wait in Review with their suggestion, method and tax tag", async () => {
    const g = await makeGroup();
    await remember(g);
    await dial(g, { transfer: false, rules: false, memory: false });
    const s = await importBca(g);
    expect(s).toMatchObject({ posted: 0, needsReview: 6, held: 4, heldBy: { rules: 2, memory: 1, transfer: 1 } });
    const bca = await lines(g.pt.banks[0].id);
    expect(bca[0]).toMatchObject({ status: "NEEDS_REVIEW", account: "1999", suggested: "7100", method: "RULE", confidence: 0.97, reason: expect.stringMatching(/^Otomasi aturan dimatikan di Pengaturan kantor\. /) });
    expect(bca[5]).toMatchObject({ status: "NEEDS_REVIEW", account: "1999", suggested: "5100", tax: "PPN_MASUKAN", method: "RULE", reason: expect.stringMatching(/^Otomasi aturan dimatikan/) });
    expect(bca[1]).toMatchObject({ status: "NEEDS_REVIEW", account: "1999", suggested: "6120", method: "MEMORY", confidence: 0.95, reason: 'Otomasi pilihan yang diingat dimatikan di Pengaturan kantor. Pernah dikonfirmasi 3× untuk "HJ MARYAM SEWA GUDANG"' });
    expect(bca[3]).toMatchObject({ status: "NEEDS_REVIEW", account: "1999", suggested: "1199", method: "TRANSFER", confidence: 0.92, reason: "Otomasi transfer dimatikan di Pengaturan kantor. Transfer antar rekening sendiri (pasangan belum diimpor)" });
    // Nothing the dial held is on its account in the books: every line sits on 1999 against the bank.
    const tb = await trialBalance(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, dateOnly(2026, 8, 31));
    const net = (code: string) => tb.find((r) => r.account.code === code)?.net ?? 0n;
    expect([net("7100"), net("6120"), net("1199"), net("5100"), net("1150")]).toEqual([0n, 0n, 0n, 0n, 0n]);
    expect(net("1999")).toBe(15_000n + 2_500_000n + 2_000_000n + 150_000_000n - 55_500_000n + 11_100_000n);

    // The other half: the pair is a fact, so both halves are linked, and both wait with 1199 suggested. The earlier half is not posted.
    const before = await db.journalEntry.count({ where: { bankTransactionId: (await line("PINDAH BUKU KE")).id } });
    expect(await importMandiri(g)).toMatchObject({ posted: 0, needsReview: 1, held: 1, heldBy: { transfer: 1 } });
    const [incoming] = await lines(g.pt.banks[1].id);
    expect(incoming).toMatchObject({ status: "NEEDS_REVIEW", account: "1999", suggested: "1199", method: "TRANSFER", confidence: 0.99, paired: true, reason: "Otomasi transfer dimatikan di Pengaturan kantor. Transfer antar rekening sendiri (pasangan ditemukan)" });
    const earlier = await line("PINDAH BUKU KE");
    expect(earlier).toMatchObject({ status: "NEEDS_REVIEW", accountCode: "1999", suggestedCode: "1199", method: "TRANSFER", confidence: 0.99, reason: "Otomasi transfer dimatikan di Pengaturan kantor. Transfer antar rekening sendiri (pasangan ditemukan)" });
    expect(earlier.matchedTxId).toBe((await line("PINDAH BUKU DARI")).id);
    expect(await db.journalEntry.count({ where: { bankTransactionId: earlier.id } })).toBe(before);

    // Review's accept on 1199 keeps the pair, as for any linked line.
    await reviewTransaction(db, { bankTxId: earlier.id, accountCode: "1199", taxTag: null });
    expect((await line("PINDAH BUKU KE")).matchedTxId).not.toBeNull();
  });

  it("with a Batas nominal, a line above it waits and a line equal to it posts", async () => {
    const g = await makeGroup();
    await remember(g);
    await dial(g, { cap: "11.100.000" });
    const s = await importBca(g);
    expect(s).toMatchObject({ posted: 3, needsReview: 3, held: 1, heldBy: { cap: 1 } });
    const bca = await lines(g.pt.banks[0].id);
    expect(bca[5]).toMatchObject({ status: "POSTED", account: "5100", tax: "PPN_MASUKAN" }); // Rp 11.100.000 = the cap
    expect(bca[3]).toMatchObject({ status: "NEEDS_REVIEW", account: "1999", suggested: "1199", method: "TRANSFER", reason: "Di atas batas otomasi (Rp 11.100.000). Transfer antar rekening sendiri (pasangan belum diimpor)" });
    // The simple guess (Rp 55.500.000) was never the dial's to hold.
    expect(bca[4]).toMatchObject({ status: "NEEDS_REVIEW", method: "HEURISTIC", reason: expect.not.stringMatching(/batas otomasi/) });

    // Money in above the cap: the other half waits too, still paired with the first.
    expect(await importMandiri(g)).toMatchObject({ posted: 0, needsReview: 1, heldBy: { cap: 1 } });
    expect((await lines(g.pt.banks[1].id))[0]).toMatchObject({ status: "NEEDS_REVIEW", suggested: "1199", paired: true, reason: "Di atas batas otomasi (Rp 11.100.000). Transfer antar rekening sendiri (pasangan ditemukan)" });
    expect(await line("PINDAH BUKU KE")).toMatchObject({ status: "NEEDS_REVIEW", accountCode: "1999", suggestedCode: "1199", reason: "Di atas batas otomasi (Rp 11.100.000). Transfer antar rekening sendiri (pasangan ditemukan)" });
  });

  it("a held pair links an earlier half already on the transfer account, and never re-posts it", async () => {
    const g = await makeGroup();
    await importBca(g); // default dial: the unpaired own transfer posts to 1199
    const earlier = await line("PINDAH BUKU KE");
    expect(earlier).toMatchObject({ status: "POSTED", accountCode: "1199" });
    const entries = await db.journalEntry.findMany({ where: { bankTransactionId: earlier.id }, include: { lines: true } });
    await dial(g, { cap: "100.000.000" });
    expect(await importMandiri(g)).toMatchObject({ posted: 0, needsReview: 1, heldBy: { cap: 1 } });
    const after = await line("PINDAH BUKU KE");
    const incoming = await line("PINDAH BUKU DARI");
    expect(after).toEqual({ ...earlier, matchedTxId: incoming.id });
    expect(incoming).toMatchObject({ status: "NEEDS_REVIEW", accountCode: "1999", suggestedCode: "1199", matchedTxId: earlier.id });
    expect(await db.journalEntry.findMany({ where: { bankTransactionId: earlier.id }, include: { lines: true } })).toEqual(entries);
  });

  it("a held pair leaves an earlier half posted to another account unlinked and untouched, and names it", async () => {
    const g = await makeGroup();
    await dial(g, { transfer: false });
    await importBca(g);
    await reviewTransaction(db, { bankTxId: (await line("PINDAH BUKU KE")).id, accountCode: "6190", taxTag: null });
    const earlier = await line("PINDAH BUKU KE");
    expect(earlier).toMatchObject({ status: "REVIEWED", accountCode: "6190", matchedTxId: null });
    const entries = await db.journalEntry.findMany({ where: { bankTransactionId: earlier.id }, include: { lines: true } });

    await dial(g, { cap: "100.000.000" });
    expect(await importMandiri(g)).toMatchObject({ posted: 0, needsReview: 1, heldBy: { cap: 1 } });
    expect(await line("PINDAH BUKU KE")).toEqual(earlier);
    expect(await db.journalEntry.findMany({ where: { bankTransactionId: earlier.id }, include: { lines: true } })).toEqual(entries);
    const incoming = await line("PINDAH BUKU DARI");
    expect(incoming).toMatchObject({ status: "NEEDS_REVIEW", accountCode: "1999", suggestedCode: "1199", method: "TRANSFER", matchedTxId: null });
    expect(incoming.reason).toBe(
      'Di atas batas otomasi (Rp 100.000.000). Transfer antar rekening sendiri (pasangan ditemukan). Pasangannya dari impor sebelumnya (6 Agu 2026, Rp 150.000.000, "PINDAH BUKU KE MANDIRI PT UJI SEJAHTERA") sudah dicatat ke akun 6190: tidak dipasangkan dan tidak diubah',
    );
  });

  it("changing the dial changes no existing line: the books read the same, and a switch turned on posts nothing waiting", async () => {
    const g = await makeGroup();
    await remember(g);
    await dial(g, { rules: false });
    await importBca(g);
    const before = await books();
    await dial(g, { transfer: false, rules: false, memory: false, cap: "1", fluxFloor: "6.000.000", fluxPercent: "60" });
    expect(await books()).toEqual(before);
    await dial(g, {}); // Aturan back on: the rule lines held earlier still wait in Review
    expect(await books()).toEqual(before);
    expect(await line("BIAYA ADM")).toMatchObject({ status: "NEEDS_REVIEW", accountCode: "1999" });
  });

  it("held lines are in Kotak persetujuan, never in Setujui N usulan yakin, and accept like any Review line", async () => {
    const g = await makeGroup();
    await dial(g, { rules: false });
    await importBca(g);
    const adm = await line("BIAYA ADM");
    const q = await approvalQueue(db, { clientId: g.client.id, year: 2026, month: 8 });
    const card = q.bank.find((c) => c.id === adm.id);
    expect(card).toMatchObject({ method: "RULE", confidence: 0.97, suggestedCode: "7100", confident: false, reason: expect.stringMatching(/^Otomasi aturan dimatikan/) });
    // The bulk accept stays AI-only: the sure AI line is offered, no held line is.
    const vaksin = await line("SUMBER VAKSIN");
    expect(q.confident.map((c) => c.id)).toEqual([vaksin.id]);
    expect(q.confident.some((c) => c.id === adm.id)).toBe(false);

    await reviewTransaction(db, { bankTxId: adm.id, accountCode: "7100", taxTag: null });
    expect(await line("BIAYA ADM")).toMatchObject({ status: "REVIEWED", accountCode: "7100" });
    const reclass = await db.journalEntry.findFirstOrThrow({ where: { bankTransactionId: adm.id, kind: "RECLASS" } });
    expect((await entryOrigins(db, [reclass.id])).get(reclass.id)).toBe("Aturan 7100 disetujui");
  });
});
