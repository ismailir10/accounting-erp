import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction } from "@/lib/review";
import { postProposal, saveProposal } from "@/lib/adjust/proposals";
import { createSchedule, postInstallment } from "@/lib/adjust/schedules";
import { bookFaktur, importFaktur } from "@/lib/tax/faktur";
import { createInvoice } from "@/lib/receivables/invoices";
import { postJournal } from "@/lib/ledger/post";
import { journalRegister } from "@/lib/reports/journal-register";
import { generalLedger } from "@/lib/reports/general-ledger";
import { accountLedger } from "@/lib/reports/account-ledger";
import { entryOrigins } from "@/lib/reports/entry-origin";
import { periodBounds } from "@/lib/format";

// Every posted entry names the proposal it came from (Kotak persetujuan): read from what each writer keeps, never stored anew.
type G = Awaited<ReturnType<typeof makeGroup>>;
let g: G;
const august = periodBounds(2026, 8);
const register = async () => (await journalRegister(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, { ...august, kinds: null, search: null }, "all")).entries;

beforeEach(async () => {
  await resetDb();
  g = await makeGroup();
});

async function linesInReview() {
  const csv = ["Tanggal;Keterangan;Debet;Kredit;Saldo", "01/08/2026;SALDO AWAL;;;500000000", "05/08/2026;TRSF CR PT MITRA UNGGAS SENTOSA;0;111000000;611000000", "10/08/2026;TRSF DB CV ANDALAN SEJAHTERA;5000000;0;606000000", ""].join("\n");
  await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca-agu.csv", data: Buffer.from(csv), provider: null });
  const line = (text: string) => db.bankTransaction.findFirstOrThrow({ where: { description: { contains: text } } });
  const sale = await db.bankTransaction.update({ where: { id: (await line("MITRA")).id }, data: { method: "AI", confidence: 0.92, suggestedCode: "4100", taxTag: "PPN_KELUARAN" } });
  const service = await db.bankTransaction.update({ where: { id: (await line("ANDALAN")).id }, data: { method: "AI", confidence: 0.9, suggestedCode: "6190" } });
  return { sale, service };
}

describe("entry origin", () => {
  it("a review decision keeps the suggestion and the RECLASS on its event, and the entry says accepted or changed", async () => {
    const { sale, service } = await linesInReview();
    await reviewTransaction(db, { bankTxId: sale.id, accountCode: "4100", taxTag: "PPN_KELUARAN" });
    await reviewTransaction(db, { bankTxId: service.id, accountCode: "6120", taxTag: null });
    const reclass = await db.journalEntry.findFirstOrThrow({ where: { bankTransactionId: sale.id, kind: "RECLASS" } });
    const event = await db.auditEvent.findFirstOrThrow({ where: { kind: "CLASSIFY", subject: `bankTx:${sale.id}` } });
    expect(event.after).toMatchObject({ accountCode: "4100", suggestion: { accountCode: "4100", taxTag: "PPN_KELUARAN", method: "AI", confidence: 0.92 }, entryId: reclass.id });

    const entries = await register();
    const origin = (bankTxId: string, kind: string) => entries.find((e) => e.kind === kind && e.memo.includes(bankTxId === sale.id ? "MITRA" : "ANDALAN"))!.origin;
    expect(origin(sale.id, "RECLASS")).toBe("Usulan AI 4100 PPN Keluaran (92 %) disetujui");
    expect(origin(service.id, "RECLASS")).toBe("Usulan AI 6190 (90 %) diubah ke 6120");
    // The import's own posting on 1999 came from no proposal.
    expect(origin(sale.id, "BANK")).toBeNull();

    // A later *Ubah akun* from the ledger decides on no proposal: its RECLASS names none, the earlier one keeps its origin.
    await reviewTransaction(db, { bankTxId: service.id, accountCode: "6130", taxTag: null });
    const after = (await register()).filter((e) => e.kind === "RECLASS" && e.memo.includes("ANDALAN"));
    expect(after.map((e) => e.origin)).toEqual(["Usulan AI 6190 (90 %) diubah ke 6120", null]);

    // Buku Besar: the drawer row and the Excel source column say the same.
    const revenue = await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code: "4100" } } });
    const { rows } = await accountLedger(db, { accountId: revenue.id, entityIds: [g.pt.entity.id], ...august, normalBalance: "CREDIT" });
    expect(rows.map((r) => r.origin)).toEqual(["Usulan AI 4100 PPN Keluaran (92 %) disetujui"]);
    const [gl] = await generalLedger(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, august.start, august.end, { accountCode: "4100" });
    expect(gl.lines.map((l) => l.source)).toEqual(["BCA Giro · bca-agu.csv, baris 3 · Usulan AI 4100 PPN Keluaran (92 %) disetujui"]);
  });

  it("names a posted draft: a Jelaskan draft by its control, a 1999 correction as such", async () => {
    const lines = [{ accountCode: "6190", debit: "100", credit: "0" }, { accountCode: "2120", debit: "0", credit: "100" }];
    const base = { firmId: g.firm.id, clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 8, memo: "Koreksi", lines, reason: "uji" };
    const correction = await saveProposal(db, { ...base, source: "SUSPENSE", key: "s-1" });
    const posted = await postProposal(db, { clientId: g.client.id, proposalId: correction.id });
    // A Jelaskan draft as postProposal records it (its posting re-checks are tested in close-explain): POSTED with its entry.
    const expense = await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code: "6190" } } });
    const payable = await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code: "2120" } } });
    const aiEntry = await db.$transaction((tx) => postJournal(tx, { entityId: g.pt.entity.id, date: august.end, kind: "ADJUSTMENT", memo: "Draf AI", lines: [{ accountId: expense.id, debit: 50n }, { accountId: payable.id, credit: 50n }] }));
    const ai = await saveProposal(db, { ...base, source: "AI_CONTROL", controlKey: `tb:${g.pt.entity.id}`, key: "ai-1", memo: "Draf AI" });
    await db.proposedEntry.update({ where: { id: ai.id }, data: { status: "POSTED", entryId: aiEntry.id } });
    const origins = await entryOrigins(db, [posted.id, aiEntry.id]);
    expect(origins.get(posted.id)).toBe("Koreksi selisih 1999");
    expect(origins.get(aiEntry.id)).toBe("Usulan AI (Jelaskan · Neraca saldo seimbang)");
    // A control the month no longer raises (a scan finding the draft fixed) leaves the title out rather than guess it.
    await db.proposedEntry.update({ where: { id: ai.id }, data: { controlKey: `flux-gone:${g.pt.entity.id}` } });
    expect((await entryOrigins(db, [aiEntry.id])).get(aiEntry.id)).toBe("Usulan AI (Jelaskan)");
  });

  it("names the Coretax file and row of a booked faktur, not a hand-made invoice; an instalment keeps its schedule source", async () => {
    const faktur = ["Nomor Faktur Pajak;Tanggal Faktur Pajak;Masa Pajak;Tahun;NPWP Pembeli;Nama Pembeli;Status Faktur;Harga Jual/Penggantian/DPP;PPN", "04002600000000003;25/08/2026;8;2026;0999;CV Sumber Lain;APPROVED;20000000;2200000", ""].join("\n");
    await importFaktur(db, { clientId: g.client.id, entityId: g.pt.entity.id, fileName: "faktur-agu.csv", data: Buffer.from(faktur) });
    const f = await db.coretaxFaktur.findFirstOrThrow();
    await bookFaktur(db, { clientId: g.client.id, fakturId: f.id, counterCode: "4100" });
    await createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "SALES", contactName: "PT Lain", number: "INV-001", issueDate: "2026-08-20", dueDate: "2026-09-19", dpp: "1.000.000", ppn: "110.000", counterCode: "4100" });
    const s = await createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "DEPRECIATION", memo: "Penyusutan mesin", debitCode: "6180", creditCode: "1219", amount: "1.200.000", months: 12, startYear: 2026, startMonth: 8 });
    await postInstallment(db, { clientId: g.client.id, scheduleId: s.id, k: 1 });

    const entries = await register();
    const of = (memoPart: string) => entries.find((e) => e.memo.includes(memoPart) || (e.source ?? "").includes(memoPart))!;
    expect(of("04002600000000003")).toMatchObject({ source: "Dokumen 04002600000000003", origin: `Faktur Coretax faktur-agu.csv ${f.sourceRef}` });
    expect(of("INV-001")).toMatchObject({ source: "Dokumen INV-001", origin: null });
    expect(of("Penyusutan mesin")).toMatchObject({ source: "Jadwal “Penyusutan mesin”, cicilan 1", origin: null });
  });
});
