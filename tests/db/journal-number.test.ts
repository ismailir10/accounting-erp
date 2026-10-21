import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { postOpening } from "@/lib/opening";
import { createInvoice } from "@/lib/receivables/invoices";
import { importStatement } from "@/lib/import/pipeline";
import { dateOnly } from "@/lib/format";
import { parseNumberQuery } from "@/lib/ledger/number";

/** Nomor bukti (cycle 2026-10-20-paritas-inti): PREFIX-YYMM-NNNN per company, prefix and month, set once by postJournal(). */
describe("nomor bukti", () => {
  beforeEach(resetDb);

  const adjust = (g: Awaited<ReturnType<typeof makeGroup>>, date: Date, memo = "Penyusutan") =>
    postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date, memo, lines: [{ accountCode: "6180", debit: "1.000.000", credit: "" }, { accountCode: "1219", debit: "", credit: "1.000.000" }] });

  it("numbers each series per month, from 0001, and Balik otomatis takes the next month's number", async () => {
    const g = await makeGroup();
    const a = await adjust(g, dateOnly(2025, 12, 31));
    const b = await adjust(g, dateOnly(2025, 12, 31));
    const c = await postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2025, 12, 31), memo: "Akrual", reverseNextMonth: true, lines: [{ accountCode: "6130", debit: "2.000.000", credit: "" }, { accountCode: "2150", debit: "", credit: "2.000.000" }] });
    const reversal = await db.journalEntry.findUniqueOrThrow({ where: { reversesId: c.id } });
    expect([a.number, b.number, c.number, reversal.number]).toEqual(["JP-2512-0001", "JP-2512-0002", "JP-2512-0003", "JP-2601-0001"]);
    // Another company of the client has its own series.
    const owner = await postAdjustment(db, { clientId: g.client.id, entityId: g.owner.entity.id, date: dateOnly(2025, 12, 31), memo: "Uji", lines: [{ accountCode: "6190", debit: "1", credit: "" }, { accountCode: "3100", debit: "", credit: "1" }] });
    expect(owner.number).toBe("JP-2512-0001");
  });

  it("gives SA, BM/BK, RK-free bank lines, FJ and FB their prefixes", async () => {
    const g = await makeGroup();
    const sa = await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 7, 31), lines: [{ accountCode: "1101", debit: "10.000.000", credit: "" }, { accountCode: "3100", debit: "", credit: "10.000.000" }] });
    expect(sa.entry.number).toBe("SA-2607-0001");
    const bca = await db.bankAccount.findFirstOrThrow({ where: { entityId: g.pt.entity.id, bank: "BCA" } });
    const csv = ["Tanggal;Keterangan;Debet;Kredit;Saldo", "01/08/2026;SALDO AWAL;;;10.000.000,00", "03/08/2026;SETORAN;0,00;500.000,00;10.500.000,00", "04/08/2026;BIAYA ADM;15.000,00;0,00;10.485.000,00", ""].join("\n");
    await importStatement(db, { bankAccountId: bca.id, fileName: "agustus.csv", data: Buffer.from(csv), provider: null });
    const bank = await db.journalEntry.findMany({ where: { kind: "BANK" }, orderBy: { date: "asc" }, select: { number: true, memo: true } });
    expect(bank.map((e) => e.number)).toEqual(["BM-2608-0001", "BK-2608-0001"]);
    const sale = await createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "SALES", contactName: "PT A", number: "INV-1", issueDate: "2026-08-05", dpp: "1.000.000", counterCode: "4100" });
    const bill = await createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "PURCHASE", contactName: "CV B", number: "B-1", issueDate: "2026-08-06", dpp: "1.000.000", counterCode: "6190" });
    const numberOf = async (id: string) => (await db.invoice.findUniqueOrThrow({ where: { id }, include: { entry: true } })).entry!.number;
    expect([await numberOf(sale.id), await numberOf(bill.id)]).toEqual(["FJ-2608-0001", "FB-2608-0001"]);
  });

  it("a refused post gives its number back; two posts at once get two numbers", async () => {
    const g = await makeGroup();
    await expect(postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 8, 31), memo: "Tidak seimbang", lines: [{ accountCode: "6180", debit: "2", credit: "" }, { accountCode: "1219", debit: "", credit: "1" }] })).rejects.toThrow("tidak seimbang");
    const both = await Promise.all([adjust(g, dateOnly(2026, 8, 31), "satu"), adjust(g, dateOnly(2026, 8, 31), "dua")]);
    expect(both.map((e) => e.number).sort()).toEqual(["JP-2608-0001", "JP-2608-0002"]);
  });

  it("the database keeps a number once given", async () => {
    const g = await makeGroup();
    const e = await adjust(g, dateOnly(2026, 8, 31));
    await expect(db.journalEntry.update({ where: { id: e.id }, data: { number: "JP-2608-0099" } })).rejects.toThrow(/tidak bisa diubah/);
    await expect(db.journalEntry.update({ where: { id: e.id }, data: { number: null } })).rejects.toThrow(/tidak bisa diubah/);
  });

  it("reads a typed number in any common spelling", () => {
    expect(["jp-2512-3", "JP/2512/0003", "JP 2512 3", "JP25120003"].map(parseNumberQuery)).toEqual(Array(4).fill("JP-2512-0003"));
    expect([parseNumberQuery("XX-2512-1"), parseNumberQuery("1.250.000"), parseNumberQuery("sewa")]).toEqual([null, null, null]);
  });
});
