import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { importStatement } from "@/lib/import/pipeline";
import { createInvoice, voidInvoice } from "@/lib/receivables/invoices";
import { invoicesAt, subledgerVsLedger } from "@/lib/receivables/aging";
import { settle, settleWithReclass, unsettle } from "@/lib/receivables/settle";
import { postOpening } from "@/lib/opening";
import { dateOnly } from "@/lib/format";
import { assetCandidates, createAsset } from "@/lib/assets/register";

type G = Awaited<ReturnType<typeof makeGroup>>;

const CSV = ["Tanggal;Keterangan;Debet;Kredit;Saldo", "20/08/2026;TRSF E-BANKING CR TOKO SEJAHTERA;0;1000000;101000000", ""].join("\n");
const sale = (g: G, number: string, dpp: string, more: Record<string, unknown> = {}) =>
  createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "SALES", contactName: "Toko Sejahtera", number, issueDate: "2026-08-05", dueDate: "2026-09-04", dpp, counterCode: "4100", ...more });
const gl = async (g: G, code: string) => {
  const a = await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code } });
  const s = await db.journalLine.aggregate({ where: { accountId: a.id }, _sum: { debit: true, credit: true } });
  return (s._sum.debit ?? 0n) - (s._sum.credit ?? 0n);
};
const lock = (g: G, year: number, month: number) =>
  db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year, month } }, update: { status: "LOCKED" }, create: { firmId: g.firm.id, clientId: g.client.id, year, month, status: "LOCKED" } });

describe("keluarkan dokumen (UC-B5)", () => {
  beforeEach(resetDb);

  it("reverses a posted note on its own date: it leaves the aging, the proof and the GL, and stays listed with its reason", async () => {
    const g = await makeGroup();
    const keep = await sale(g, "N-1", "2000000");
    const wrong = await sale(g, "N-2", "5000000", { ppn: "550000" });
    expect(await gl(g, "1130")).toBe(7_550_000n);
    await expect(voidInvoice(db, { clientId: g.client.id, invoiceId: wrong.id, reason: "salah" })).rejects.toThrow(/min. 10 karakter/);
    const v = await voidInvoice(db, { clientId: g.client.id, invoiceId: wrong.id, reason: "Dokumen pemasok, bukan nota penjualan" });
    expect([v.voidReason, v.voidedAt !== null]).toEqual(["Dokumen pemasok, bukan nota penjualan", true]);
    const mirror = await db.journalEntry.findUniqueOrThrow({ where: { id: v.voidEntryId! }, include: { lines: true } });
    expect([mirror.date.toISOString().slice(0, 10), mirror.kind, mirror.reversesId, mirror.memo]).toEqual(["2026-08-05", "INVOICE", wrong.entryId, "Batal Faktur N-2 · Toko Sejahtera: Dokumen pemasok, bukan nota penjualan"]);
    expect([await gl(g, "1130"), await gl(g, "4100"), await gl(g, "2130")]).toEqual([2_000_000n, -2_000_000n, 0n]);
    expect((await invoicesAt(db, g.client.id, "SALES", dateOnly(2026, 8, 31))).map((i) => i.number)).toEqual([keep.number]);
    expect((await subledgerVsLedger(db, g.client.id, "SALES", dateOnly(2026, 8, 31)))[0]).toMatchObject({ open: 2_000_000n, ledger: 2_000_000n, equal: true });
    // Once only; never settled afterwards; the history says who and why.
    await expect(voidInvoice(db, { clientId: g.client.id, invoiceId: wrong.id, reason: "Dokumen pemasok, bukan nota penjualan" })).rejects.toThrow("Faktur N-2 sudah dikeluarkan.");
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca.csv", data: Buffer.from(CSV), provider: null });
    const receipt = await db.bankTransaction.findFirstOrThrow({ where: { description: { contains: "TOKO" } } });
    await expect(settleWithReclass(db, { clientId: g.client.id, invoiceId: wrong.id, bankTransactionId: receipt.id })).rejects.toThrow("Faktur N-2 sudah dikeluarkan.");
    const event = await db.auditEvent.findFirstOrThrow({ where: { kind: "DOCUMENT_VOID" } });
    expect([event.subject, event.summary]).toEqual([`invoice:${wrong.id}`, "Faktur N-2 · Toko Sejahtera · Rp 5.550.000 dikeluarkan: Dokumen pemasok, bukan nota penjualan"]);
    // Its number stays taken, and saying so helps.
    await expect(sale(g, "N-2", "1000000")).rejects.toThrow("Nomor N-2 dipakai faktur yang sudah dikeluarkan. Beri nomor lain, mis. N-2-R.");
  });

  it("refuses a settled document and a locked month, and only marks a Saldo Awal item", async () => {
    const g = await makeGroup();
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca.csv", data: Buffer.from(CSV), provider: null });
    const receipt = await db.bankTransaction.findFirstOrThrow({ where: { description: { contains: "TOKO" } } });
    const a = await sale(g, "N-1", "1000000");
    const s = await settleWithReclass(db, { clientId: g.client.id, invoiceId: a.id, bankTransactionId: receipt.id });
    await expect(voidInvoice(db, { clientId: g.client.id, invoiceId: a.id, reason: "Nota dobel dengan N-0" })).rejects.toThrow("Faktur N-1 sudah dicocokkan ke 1 mutasi bank. Hapus pencocokannya dulu, lalu keluarkan.");
    await unsettle(db, { clientId: g.client.id, settlementId: s.id });
    await lock(g, 2026, 8);
    await expect(voidInvoice(db, { clientId: g.client.id, invoiceId: a.id, reason: "Nota dobel dengan N-0" })).rejects.toThrow("Agustus 2026 sudah dikunci, dan faktur N-1 dibalik pada tanggal aslinya (5 Agu 2026). Buka kunci bulan itu dulu.");

    // A locked August also freezes the months before it (accounting-rules 4): reopen it before Saldo Awal goes in.
    await db.period.update({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 8 } }, data: { status: "OPEN" } });
    await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 6, 30), lines: [{ accountCode: "1130", debit: "3000000", credit: "0" }] });
    const o = await sale(g, "SA-1", "3000000", { opening: true, issueDate: "2026-06-20" });
    const entries = await db.journalEntry.count();
    const v = await voidInvoice(db, { clientId: g.client.id, invoiceId: o.id, reason: "Rincian saldo awal salah pelanggan" });
    expect([v.voidEntryId, await db.journalEntry.count()]).toEqual([null, entries]);
    expect((await invoicesAt(db, g.client.id, "SALES", dateOnly(2026, 8, 31))).map((i) => i.number)).toEqual(["N-1"]);
    await expect(settle(db, { clientId: g.client.id, invoiceId: o.id, bankTransactionId: receipt.id })).rejects.toThrow("sudah dikeluarkan");
  });

  it("refuses a bill whose journal the asset register uses, and a voided bill is no asset purchase", async () => {
    const g = await makeGroup();
    const bill = (number: string) =>
      createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "PURCHASE", contactName: "PT Komputer", number, issueDate: "2026-08-10", dpp: "48000000", counterCode: "1210" });
    const laptop = await bill("B-1");
    await createAsset(db, { clientId: g.client.id, entityId: g.pt.entity.id, taxGroup: "KELOMPOK_1", fiscalMethod: "GARIS_LURUS", assetAccountCode: "1210", name: "Laptop kantor", acquiredOn: "2026-08-10", cost: "48000000", sourceEntryId: laptop.entryId! });
    await expect(voidInvoice(db, { clientId: g.client.id, invoiceId: laptop.id, reason: "Dobel dengan tagihan lain" })).rejects.toThrow("Tagihan B-1 tercatat sebagai aset tetap (Laptop kantor).");
    const dup = await bill("B-2");
    expect((await assetCandidates(db, g.client.id)).map((c) => c.entryId)).toEqual([dup.entryId]);
    await voidInvoice(db, { clientId: g.client.id, invoiceId: dup.id, reason: "Dobel dengan tagihan B-1" });
    expect(await assetCandidates(db, g.client.id)).toEqual([]);
  });
});
