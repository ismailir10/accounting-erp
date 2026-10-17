import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { db, makeGroup, resetDb } from "../helpers";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction, unpairTransfer } from "@/lib/review";
import { saveControlNote } from "@/lib/controls/ack";
import { postOpening } from "@/lib/opening";
import { resolveOpeningFinding } from "@/lib/findings";
import { importSourceAccounts, stageImport } from "@/lib/ledger-import/post";
import { acceptMappings } from "@/lib/ledger-import/mapping";
import { listEvents } from "@/lib/audit";
import { dateOnly } from "@/lib/format";

/** ADR 0013: every change a person makes lands in the change log with before → after, in the same transaction. */
const file = (opening: string, ...rows: string[]) => Buffer.from(["Tanggal;Keterangan;Debet;Kredit;Saldo", `01/08/2026;SALDO AWAL;;;${opening}`, ...rows, ""].join("\n"));

describe("change log writers", () => {
  beforeEach(resetDb);

  it("records a reviewer's account change once (nothing when nothing changes), and both halves of an unpaired transfer", async () => {
    const g = await makeGroup();
    const [bca, mdr] = g.pt.banks;
    await importStatement(db, { bankAccountId: bca.id, fileName: "bca.csv", data: file("10.000.000,00", "04/08/2026;TRSF E-BANKING DB HJ MARYAM SEWA GUDANG;2.500.000,00;0,00;7.500.000,00", "06/08/2026;PINDAH BUKU KE MANDIRI PT UJI SEJAHTERA;1.000.000,00;0,00;6.500.000,00"), provider: null });
    await importStatement(db, { bankAccountId: mdr.id, fileName: "mdr.csv", data: file("0,00", "06/08/2026;PINDAH BUKU DARI BCA PT UJI SEJAHTERA;0,00;1.000.000,00;1.000.000,00"), provider: null });
    const rent = await db.bankTransaction.findFirstOrThrow({ where: { description: { contains: "MARYAM" } } });
    await reviewTransaction(db, { bankTxId: rent.id, accountCode: "6120", taxTag: null });
    await reviewTransaction(db, { bankTxId: rent.id, accountCode: "6120", taxTag: null });
    const own = await listEvents(db, g.client.id, { subject: `bankTx:${rent.id}` });
    // The decision also keeps the suggestion it was taken on and the RECLASS it posted (entry origin, Kotak persetujuan).
    const reclass = await db.journalEntry.findFirstOrThrow({ where: { bankTransactionId: rent.id, kind: "RECLASS" } });
    expect(own.map((e) => [e.kind, e.before, e.after])).toEqual([["CLASSIFY", { accountCode: "1999", taxTag: null, whtKind: null, whtAmount: "0" }, { accountCode: "6120", taxTag: null, whtKind: null, whtAmount: "0", suggestion: { accountCode: rent.suggestedCode, taxTag: null, method: rent.method, confidence: rent.confidence }, entryId: reclass.id }]]);
    expect(own[0].summary).toBe("TRSF E-BANKING DB HJ MARYAM SEWA GUDANG · Rp 2.500.000: 1999 → 6120");

    const out = await db.bankTransaction.findFirstOrThrow({ where: { bankAccountId: bca.id, description: { contains: "PINDAH" } } });
    await unpairTransfer(db, { clientId: g.client.id, bankTxId: out.id });
    expect((await listEvents(db, g.client.id, { kind: "UNPAIR" })).map((e) => e.subject).sort()).toEqual([`bankTx:${out.id}`, `bankTx:${out.matchedTxId}`].sort());
  });

  it("keeps the replaced control note, a source-account remap and a Temuan's resolution", async () => {
    const g = await makeGroup();
    const period = await db.period.create({ data: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 8 } });
    const base = { clientId: g.client.id, periodId: period.id, year: 2026, month: 8, controlKey: "suspense", title: "Semua mutasi terklasifikasi", detail: "2 transaksi menunggu review" };
    await saveControlNote(db, { ...base, note: "Menunggu jawaban klien" });
    await saveControlNote(db, { ...base, note: "Dicek, wajar" });
    const notes = await listEvents(db, g.client.id, { kind: "CONTROL_NOTE" });
    expect(notes.map((n) => n.summary)).toEqual(["Catatan diganti untuk Semua mutasi terklasifikasi (Agustus 2026): Dicek, wajar", "Catatan ditulis untuk Semua mutasi terklasifikasi (Agustus 2026): Menunggu jawaban klien"]);
    expect(notes[0].before).toMatchObject({ note: "Menunggu jawaban klien" });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("GL");
    ws.addRow(["Entity", "Entry Date", "Account Code", "Account Name", "Currency", "Debit", "Credit", "Notes"]);
    ws.addRow(["PT Uji", new Date(Date.UTC(2026, 6, 31)), "60001", "Beban Kantor", "IDR", 100, 0, ""]);
    ws.addRow(["PT Uji", new Date(Date.UTC(2026, 6, 31)), "21001", "Utang Lain", "IDR", 0, 100, ""]);
    const staged = await stageImport(db, { firmId: g.firm.id, clientId: g.client.id, fileName: "gl.xlsx", data: Buffer.from(await wb.xlsx.writeBuffer()) });
    if (staged.status !== "STAGED") throw new Error("not staged");
    const src = await importSourceAccounts(db, staged.importId);
    const office = src.find((s) => s.code === "60001")!;
    await acceptMappings(db, g.client.id, [{ sourceAccountId: office.id, accountCode: "6190", method: "MANUAL" }]);
    expect(await listEvents(db, g.client.id, { kind: "MAPPING" })).toHaveLength(0); // a first mapping belongs to its import
    await acceptMappings(db, g.client.id, [{ sourceAccountId: office.id, accountCode: "6160", method: "MANUAL" }]);
    const [remap] = await listEvents(db, g.client.id, { kind: "MAPPING" });
    expect(remap.summary).toMatch(/^Akun sumber 60001 Beban Kantor: 6190 .+ → 6160 .+ \(jurnal yang sudah dicatat tidak ikut pindah\)$/);

    const { finding } = await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 3, 31), lines: [{ accountCode: "1101", debit: "1.000.000", credit: "" }] });
    await resolveOpeningFinding(db, { clientId: g.client.id, findingId: finding!.id, accountCode: "3100", decision: "Setoran modal awal pemilik" });
    expect((await listEvents(db, g.client.id, { kind: "FINDING_RESOLVED" }))[0].summary).toBe("T-001 diselesaikan ke 3100 Modal Disetor: Setoran modal awal pemilik");
  });
});
