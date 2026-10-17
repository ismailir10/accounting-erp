import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { db, makeGroup, resetDb } from "../helpers";
import { approvalCounts, approvalQueue, BANK_CARD_LIMIT } from "@/lib/approvals/queue";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction } from "@/lib/review";
import { dismissProposal, saveProposal } from "@/lib/adjust/proposals";
import { createSchedule, postAllDue, postInstallment } from "@/lib/adjust/schedules";
import { postSuspenseCorrection } from "@/lib/adjust/suspense";
import { bookFaktur, fakturRecon, importFaktur } from "@/lib/tax/faktur";
import { acceptCheck, importSourceAccounts, postImport, stageImport } from "@/lib/ledger-import/post";
import { acceptMappings, suggestMappings } from "@/lib/ledger-import/mapping";
import { dateOnly } from "@/lib/format";

// Kotak persetujuan (Phase 2 item 1): one queue per client-month, computed from what each owning page reads.
type G = Awaited<ReturnType<typeof makeGroup>>;

const STATEMENT = [
  "Tanggal;Keterangan;Debet;Kredit;Saldo",
  "01/08/2026;SALDO AWAL;;;500000000",
  "05/08/2026;TRSF CR PT MITRA UNGGAS SENTOSA;0;111000000;611000000",
  "10/08/2026;TRSF DB CV ANDALAN SEJAHTERA;5000000;0;606000000",
  "14/08/2026;TRSF DB PT PAKAN JAYA;55500000;0;550500000",
  "20/08/2026;TRSF DB TOKO MESIN SENTOSA;50000000;0;500500000",
  "",
].join("\n");
const FAKTUR = [
  "Nomor Faktur Pajak;Tanggal Faktur Pajak;Masa Pajak;Tahun;NPWP Pembeli;Nama Pembeli;Status Faktur;Harga Jual/Penggantian/DPP;PPN",
  "04002600000000003;25/08/2026;8;2026;0999;CV Sumber Lain;APPROVED;20000000;2200000",
  "04002600000000004;26/08/2026;8;2026;0999;CV Sumber Lain;CANCELLED;50000000;5000000",
  "",
].join("\n");

/** A line in Review created directly (no journal): enough for the read model, which only reads it. */
async function reviewLine(g: G, entity: G["pt"], date: Date, hash: string) {
  const imported = await db.statementImport.create({ data: { firmId: g.firm.id, bankAccountId: entity.banks[0].id, fileName: `${hash}.csv`, format: "BCA", periodStart: date, periodEnd: date, openingBalance: 100n, closingBalance: 90n, rowCount: 1, continuityOk: true } });
  return db.bankTransaction.create({ data: { firmId: g.firm.id, entityId: entity.entity.id, bankAccountId: entity.banks[0].id, importId: imported.id, date, description: `Contoh ${hash}`, merchantKey: `CONTOH ${hash}`.toUpperCase(), direction: "OUT", amount: -10n, rowNumber: 1, rawRow: "synthetic", hash, status: "NEEDS_REVIEW", method: "AI", confidence: 0.5, reason: "AI: contoh", suggestedCode: "6190" } });
}

async function fixture() {
  const g = await makeGroup();
  await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca-agu.csv", data: Buffer.from(STATEMENT), provider: null });
  const line = (text: string) => db.bankTransaction.findFirstOrThrow({ where: { description: { contains: text } } });
  // An AI answer as the import would have stored it: a sure one, and a sure one the accountant hints hold back (a machine as an expense).
  const sure = await db.bankTransaction.update({ where: { id: (await line("MITRA")).id }, data: { method: "AI", confidence: 0.92, suggestedCode: "4100", taxTag: "PPN_KELUARAN", reason: "AI: penjualan ke pelanggan" } });
  const machine = await db.bankTransaction.update({ where: { id: (await line("MESIN")).id }, data: { method: "AI", confidence: 0.9, suggestedCode: "6190", reason: "AI: beban umum" } });
  const guess = await line("ANDALAN");
  const owner = await reviewLine(g, g.owner, dateOnly(2026, 8, 7), "owner");
  const later = await reviewLine(g, g.pt, dateOnly(2026, 9, 3), "later");
  const draft = (key: string, month: number) =>
    saveProposal(db, { firmId: g.firm.id, clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month, source: "AI_CONTROL", controlKey: `sanity:${g.pt.entity.id}`, key, memo: `Draf ${key}`, lines: [{ accountCode: "6190", debit: "10", credit: "0" }, { accountCode: "2120", debit: "0", credit: "10" }], reason: "contoh" });
  const ai = await draft("ai-agu", 8);
  await draft("ai-sep", 9);
  await dismissProposal(db, { clientId: g.client.id, proposalId: (await draft("ai-dismissed", 8)).id });
  const schedule = await createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "DEPRECIATION", memo: "Penyusutan mesin", debitCode: "6180", creditCode: "1219", amount: "12.000.000", months: 12, startYear: 2026, startMonth: 7 });
  return { g, sure, machine, guess, owner, later, ai, schedule };
}

const august = (g: G, entityIds?: string[]) => ({ clientId: g.client.id, year: 2026, month: 8, entityIds });

describe("approval queue", () => {
  beforeEach(resetDb);

  it("lists every kind for the month and scope, problems first, and counts equal the queue", async () => {
    const { g, sure, machine, guess, owner, ai, schedule } = await fixture();
    const q = await approvalQueue(db, august(g));
    // Bank: Review's set (in review through the month end; the rule-posted PAKAN line and September's are not), low confidence first.
    expect(q.bank.map((c) => c.id)).toEqual([owner.id, guess.id, sure.id, machine.id]);
    expect(q.bank.find((c) => c.id === guess.id)).toMatchObject({ method: "HEURISTIC", guess: true, confident: false });
    expect(q.bank.find((c) => c.id === machine.id)!.hints[0]).toMatch(/aset tetap/);
    // Only the sure, unhinted AI line is offered in bulk.
    expect(q.confident).toEqual([{ id: sure.id, accountCode: "4100", taxTag: "PPN_KELUARAN" }]);
    // Drafts: the month's open one only (not September's, not the dismissed one).
    expect(q.drafts.map((d) => [d.id, d.memo, d.entity, d.date])).toEqual([[ai.id, "Draf ai-agu", "PT Uji", "2026-08-31"]]);
    // Instalments: July's is overdue and leads.
    expect(q.scheduled.map((s) => [s.scheduleId, s.k, s.overdue])).toEqual([[schedule.id, 1, true], [schedule.id, 2, false]]);
    // No faktur were imported for the masa: the kind isn't there.
    expect(q.faktur).toEqual([]);
    expect(q.fakturAccounts).toBeNull();
    expect(q.counts).toEqual({ bank: 4, draft: 1, scheduled: 2, faktur: 0, total: 7 });
    expect(q.locked).toBe(false);
    expect(await approvalCounts(db, august(g))).toEqual(q.counts);

    // One company: the owner's line and nothing else of the owner.
    const pt = await approvalQueue(db, august(g, [g.pt.entity.id]));
    expect(pt.counts).toEqual({ bank: 3, draft: 1, scheduled: 2, faktur: 0, total: 6 });
    expect(await approvalCounts(db, august(g, [g.pt.entity.id]))).toEqual(pt.counts);
    const own = await approvalQueue(db, august(g, [g.owner.entity.id]));
    expect(own.counts).toEqual({ bank: 1, draft: 0, scheduled: 0, faktur: 0, total: 1 });

    // September holds every line through its end, its own draft and instalment 3 (1 and 2 still owed).
    expect((await approvalCounts(db, { clientId: g.client.id, year: 2026, month: 9 }))).toEqual({ bank: 5, draft: 1, scheduled: 3, faktur: 0, total: 9 });
  });

  it("shows the faktur kind only once faktur were imported, for a Rupiah company", async () => {
    const { g } = await fixture();
    await importFaktur(db, { clientId: g.client.id, entityId: g.pt.entity.id, fileName: "faktur.csv", data: Buffer.from(FAKTUR) });
    const q = await approvalQueue(db, august(g));
    // The cancelled faktur is not counted; the MITRA receipt's PPN is still on 1999 in Review, so nothing in the books matches F3.
    expect(q.faktur.map((f) => [f.number, f.direction, f.ppn, f.entity, f.preferred])).toEqual([["04002600000000003", "KELUARAN", "2200000", "PT Uji", "4100"]]);
    expect(q.fakturAccounts!.KELUARAN.map((a) => a.code)).toContain("4100");
    expect(q.fakturAccounts!.MASUKAN.map((a) => a.code)).not.toContain("1130");
    expect(q.counts.faktur).toBe(1);
    expect((await approvalCounts(db, august(g))).total).toBe(q.counts.total);
    expect((await approvalQueue(db, august(g, [g.owner.entity.id]))).faktur).toEqual([]);
  });

  it("each approval through its own writer leaves the queue", async () => {
    const { g, sure, ai, schedule } = await fixture();
    await importFaktur(db, { clientId: g.client.id, entityId: g.pt.entity.id, fileName: "faktur.csv", data: Buffer.from(FAKTUR) });
    const before = (await approvalQueue(db, august(g))).counts;
    expect(before).toEqual({ bank: 4, draft: 1, scheduled: 2, faktur: 1, total: 8 });

    await reviewTransaction(db, { bankTxId: sure.id, accountCode: "4100", taxTag: "PPN_KELUARAN" });
    await dismissProposal(db, { clientId: g.client.id, proposalId: ai.id });
    await postInstallment(db, { clientId: g.client.id, scheduleId: schedule.id, k: 1 });
    const [faktur] = (await approvalQueue(db, august(g))).faktur;
    await bookFaktur(db, { clientId: g.client.id, fakturId: faktur.id, counterCode: "4100" });
    expect((await approvalQueue(db, august(g))).counts).toEqual({ bank: 3, draft: 0, scheduled: 1, faktur: 0, total: 4 });

    expect(await postAllDue(db, { clientId: g.client.id, year: 2026, month: 8 })).toBe(1);
    expect((await approvalCounts(db, august(g))).scheduled).toBe(0);
  });

  it("a faktur masukan approved from the queue becomes a payable on the chosen account and leaves the missing-faktur list", async () => {
    const { g } = await fixture();
    const MASUKAN = ["NPWP Penjual;Nama Penjual;Nomor Faktur Pajak;Tanggal Faktur Pajak;Masa Pajak;Tahun;Status Faktur;Harga Jual/Penggantian/DPP;PPN", "0777;CV Kemasan Prima;07002600000000019;18/08/2026;8;2026;CREDITED;30000000;3300000", ""].join("\n");
    await importFaktur(db, { clientId: g.client.id, entityId: g.pt.entity.id, fileName: "masukan.csv", data: Buffer.from(MASUKAN) });
    const masukan = () => fakturRecon(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 8 }).then((r) => r.directions.find((d) => d.direction === "MASUKAN")!);
    // Nothing in the books carries this faktur's PPN: the reconciliation lists it as missing and Kotak offers it.
    expect((await masukan()).unmatchedFaktur.map((f) => f.number)).toEqual(["07002600000000019"]);
    const q = await approvalQueue(db, august(g));
    const [faktur] = q.faktur;
    expect([faktur.number, faktur.direction]).toEqual(["07002600000000019", "MASUKAN"]);
    const account = q.fakturAccounts!.MASUKAN.find((a) => a.code !== faktur.preferred) ?? q.fakturAccounts!.MASUKAN[0];

    const inv = await bookFaktur(db, { clientId: g.client.id, fakturId: faktur.id, counterCode: account.code });
    expect(inv.direction).toBe("PURCHASE");
    const lines = await db.journalLine.findMany({ where: { entryId: inv.entryId! }, include: { account: { select: { code: true } } } });
    expect(lines.find((l) => l.account.code === account.code)?.debit).toBe(30_000_000n);
    expect((await approvalQueue(db, august(g))).faktur).toEqual([]);
    expect((await masukan()).unmatchedFaktur).toEqual([]);
  });

  it("leaves out instalments of a locked month and marks a locked month read-only", async () => {
    const { g } = await fixture();
    const lock = (month: number) => db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month } }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month, status: "LOCKED" }, update: { status: "LOCKED" } });
    await lock(7);
    const q = await approvalQueue(db, august(g));
    expect(q.scheduled.map((s) => s.k)).toEqual([2]);
    expect(q.locked).toBe(false);
    await lock(8);
    const locked = await approvalQueue(db, august(g));
    expect(locked.locked).toBe(true);
    expect(locked.scheduled).toEqual([]);
    expect(locked.counts).toEqual(await approvalCounts(db, august(g)));
  });

  it(`caps the bank cards at ${BANK_CARD_LIMIT} and counts them all`, async () => {
    const g = await makeGroup();
    for (let i = 0; i < BANK_CARD_LIMIT + 3; i++) await reviewLine(g, g.pt, dateOnly(2026, 8, 1 + (i % 28)), `l${i}`);
    const q = await approvalQueue(db, august(g));
    expect(q.bank).toHaveLength(BANK_CARD_LIMIT);
    expect(q.counts.bank).toBe(BANK_CARD_LIMIT + 3);
  });

  it("lists the month's 1999 correction of an accepted ledger-file difference, and posting it clears the card", async () => {
    const g = await makeGroup();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("GL");
    ws.addRow(["Entity", "Entry Date", "Account Code", "Account Name", "Debit", "Credit"]);
    for (const [code, name, dr, cr] of [["10000", "Kas", 100, 0], ["21001", "Income Tax Payable - Art 21", 0, 100], ["21002", "Smartfarm Payable", 0, 5]] as const) ws.addRow(["PT Uji", new Date(Date.UTC(2026, 0, 31)), code, name, dr, cr]);
    const st = await stageImport(db, { firmId: g.firm.id, clientId: g.client.id, fileName: "gl.xlsx", data: Buffer.from(await wb.xlsx.writeBuffer()) });
    if (st.status !== "STAGED") throw new Error("not staged");
    for (const c of await db.importCheck.findMany({ where: { ledgerImportId: st.importId, code: "UNBALANCED" } })) await acceptCheck(db, g.client.id, c.id);
    await suggestMappings(db, { firmId: g.firm.id, clientId: g.client.id, provider: null, useAi: false });
    const src = await importSourceAccounts(db, st.importId);
    await acceptMappings(db, g.client.id, src.map((s) => ({ sourceAccountId: s.id, accountCode: s.suggestedCode!, method: s.suggestedBy! })));
    await postImport(db, g.client.id, st.importId);

    const january = { clientId: g.client.id, year: 2026, month: 1 };
    const [d] = (await approvalQueue(db, january)).drafts;
    expect([d.source, d.fixed, d.entity]).toEqual(["SUSPENSE", 0, "PT Uji"]);
    expect((await approvalCounts(db, january)).draft).toBe(1);
    await postSuspenseCorrection(db, { firmId: g.firm.id, clientId: g.client.id, lineId: d.id.replace(/^suspense:/, ""), accounts: d.lines.map((l) => l.accountCode) });
    expect((await approvalQueue(db, january)).drafts).toEqual([]);
  });
});
