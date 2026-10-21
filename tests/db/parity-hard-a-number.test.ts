import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { postJournal } from "@/lib/ledger/post";
import { reverseEntry } from "@/lib/ledger/reverse";
import { postOpening } from "@/lib/opening";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction } from "@/lib/review";
import { createInvoice, voidInvoice } from "@/lib/receivables/invoices";
import { createAccount } from "@/lib/coa/manage";
import { setFiscalYearEnd } from "@/lib/entity-settings";
import { journalRegister, parseSearch } from "@/lib/reports/journal-register";
import { dateOnly } from "@/lib/format";

/**
 * Round nine, probe A — Nomor bukti (cycle 2026-10-20-paritas-inti): PREFIX-YYMM-NNNN per company, prefix and month; SA, BM/BK, RK, JP
 * (adjustments, reversals, instalments), JI, FJ/FB; taken in the posting transaction so a rollback or a refusal leaves no gap and two
 * posts at once get two numbers. Every expected number is written out by hand from the posting order.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;

const lock = (g: G, year: number, month: number) =>
  db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year, month } }, create: { firmId: g.firm.id, clientId: g.client.id, year, month, status: "LOCKED" }, update: { status: "LOCKED" } });

const jp = (g: G, entityId: string, date: Date, memo: string, amount = "100.000", extra: { reverseNextMonth?: boolean } = {}) =>
  postAdjustment(db, { clientId: g.client.id, entityId, date, memo, ...extra, lines: [{ accountCode: "6160", debit: amount, credit: "" }, { accountCode: "1110", debit: "", credit: amount }] });

const numberOf = async (id: string) => (await db.journalEntry.findUniqueOrThrow({ where: { id }, select: { number: true } })).number;

describe("nomor bukti: which prefix each source gets", () => {
  beforeEach(resetDb);

  it("Saldo Awal SA, bank in BM / out BK, reclassification RK, adjustment + auto-reversal + Balik jurnal JP, sales FJ, purchase FB; each company its own series", async () => {
    const g = await makeGroup();
    const base = { clientId: g.client.id, entityId: g.pt.entity.id };
    // 31 Jul 2026 Saldo Awal → SA-2607-0001.
    const opening = await postOpening(db, { ...base, date: dateOnly(2026, 7, 31), lines: [{ accountCode: "1101", debit: "10.000.000", credit: "" }, { accountCode: "3100", debit: "", credit: "10.000.000" }] });
    expect(await numberOf(opening.entry.id)).toBe("SA-2607-0001");

    // August statement: one row out (BK-2608-0001), one row in (BM-2608-0001).
    const csv = [
      "Tanggal;Keterangan;Debet;Kredit;Saldo",
      "01/08/2026;SALDO AWAL;;;10.000.000,00",
      "03/08/2026;BIAYA ADM;15.000,00;0,00;9.985.000,00",
      "05/08/2026;SETORAN TUNAI TOKO;0,00;2.000.000,00;11.985.000,00",
      "",
    ].join("\n");
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "agustus.csv", data: Buffer.from(csv), provider: null });
    const bankEntry = (desc: string) => db.journalEntry.findFirstOrThrow({ where: { kind: "BANK", bankTransaction: { description: { contains: desc } } } });
    expect((await bankEntry("BIAYA ADM")).number).toBe("BK-2608-0001");
    expect((await bankEntry("SETORAN")).number).toBe("BM-2608-0001");

    // Reclassifying the fee: a RECLASS → RK-2608-0001.
    const fee = await db.bankTransaction.findFirstOrThrow({ where: { description: { contains: "BIAYA ADM" } } });
    await reviewTransaction(db, { bankTxId: fee.id, accountCode: fee.accountCode === "6170" ? "6160" : "6170", taxTag: null });
    expect((await db.journalEntry.findFirstOrThrow({ where: { kind: "RECLASS" } })).number).toBe("RK-2608-0001");

    // A Jurnal Penyesuaian with Balik otomatis → JP-2608-0001 and its reversal on 1 Sep → JP-2609-0001.
    const accrual = await postAdjustment(db, { ...base, date: dateOnly(2026, 8, 31), memo: "Akrual listrik", reverseNextMonth: true, lines: [{ accountCode: "6130", debit: "300.000", credit: "" }, { accountCode: "2150", debit: "", credit: "300.000" }] });
    expect(await numberOf(accrual.id)).toBe("JP-2608-0001");
    const auto = await db.journalEntry.findFirstOrThrow({ where: { reversesId: accrual.id } });
    expect(auto.number).toBe("JP-2609-0001");

    // A second adjustment (JP-2608-0002) reversed by hand on 31 Aug (JP-2608-0003).
    const atk = await jp(g, g.pt.entity.id, dateOnly(2026, 8, 20), "Beli ATK");
    expect(await numberOf(atk.id)).toBe("JP-2608-0002");
    const rev = await reverseEntry(db, { clientId: g.client.id, entryId: atk.id, date: dateOnly(2026, 8, 31) });
    expect(rev.number).toBe("JP-2608-0003");

    // Invoices: a sale FJ-2608-0001, a purchase FB-2608-0001; voiding the sale is FJ-2608-0002 (an INVOICE entry by its receivable line).
    const sale = await createInvoice(db, { ...base, direction: "SALES", contactName: "PT Pelanggan", number: "INV-1", issueDate: "2026-08-10", dpp: "1.000.000", ppn: "110.000", counterCode: "4100" });
    const bill = await createInvoice(db, { ...base, direction: "PURCHASE", contactName: "PT Pemasok", number: "B-1", issueDate: "2026-08-11", dpp: "500.000", counterCode: "6190" });
    expect(await numberOf(sale.entryId!)).toBe("FJ-2608-0001");
    expect(await numberOf(bill.entryId!)).toBe("FB-2608-0001");
    const voided = await voidInvoice(db, { clientId: g.client.id, invoiceId: sale.id, reason: "salah pelanggan, dicatat ulang" });
    expect(await numberOf(voided.voidEntryId!)).toBe("FJ-2608-0002");

    // The owner's books have their own series: its first August adjustment is JP-2608-0001 too.
    const andi = await jp(g, g.owner.entity.id, dateOnly(2026, 8, 15), "Kas kecil Andi");
    expect(await numberOf(andi.id)).toBe("JP-2608-0001");
  });

  it("DEFECT: a purchase bill whose cost is recharged to a receivable account is numbered FJ (faktur penjualan) instead of FB", async () => {
    // Tagihan pembelian B-7: Dr 113x Piutang Usaha - Biaya Ditagihkan Ulang 2.000.000 / Cr 2110 Utang Usaha 2.000.000. createInvoice accepts
    // any asset account as a purchase's counter account; numberPrefix() says FJ as soon as any line sits on a PIUTANG_USAHA account. The
    // document is a purchase (direction PURCHASE, payable line on 2110), so its voucher belongs to the FB series: FB-2608-0001. The FB
    // series an auditor asks for would otherwise miss it and the FJ series would hold a bill.
    const g = await makeGroup();
    const recharge = await createAccount(db, { clientId: g.client.id, fsLine: "PIUTANG_USAHA", name: "Piutang Usaha - Biaya Ditagihkan Ulang" });
    const bill = await createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "PURCHASE", contactName: "PT Ekspedisi", number: "B-7", issueDate: "2026-08-12", dpp: "2.000.000", counterCode: recharge.code });
    expect(await numberOf(bill.entryId!)).toBe("FB-2608-0001");
  });
});

describe("nomor bukti: no gap, no duplicate", () => {
  beforeEach(resetDb);

  it("six posts of the same series at once get 0001…0006, each once; the counter says 6", async () => {
    const g = await makeGroup();
    const posted = await Promise.all(Array.from({ length: 6 }, (_, i) => jp(g, g.pt.entity.id, dateOnly(2026, 8, 10 + i), `Paralel ${i}`)));
    const numbers = (await Promise.all(posted.map((p) => numberOf(p.id)))).sort();
    expect(numbers).toEqual(["JP-2608-0001", "JP-2608-0002", "JP-2608-0003", "JP-2608-0004", "JP-2608-0005", "JP-2608-0006"]);
    const seq = await db.journalSequence.findUniqueOrThrow({ where: { entityId_prefix_year_month: { entityId: g.pt.entity.id, prefix: "JP", year: 2026, month: 8 } } });
    expect(seq.last).toBe(6);
  });

  it("a rolled-back post gives its number back", async () => {
    const g = await makeGroup();
    const a = await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code: "6160" } });
    const k = await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code: "1110" } });
    await expect(
      db.$transaction(async (tx) => {
        await postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, 8, 3), kind: "ADJUSTMENT", memo: "batal", lines: [{ accountId: a.id, debit: 1000n }, { accountId: k.id, credit: 1000n }] });
        throw new Error("caller fails after posting");
      }),
    ).rejects.toThrow("caller fails after posting");
    const kept = await jp(g, g.pt.entity.id, dateOnly(2026, 8, 4), "Jadi");
    expect(await numberOf(kept.id)).toBe("JP-2608-0001");
  });

  it("a journal refused for a closed month (its own, or a later one) takes no number", async () => {
    // JP-2608-0001 posts; September is closed. A journal dated 20 Aug (before a closed month) and one dated 10 Sep (in it) are refused;
    // August's counter stays at 1 and September never gets a counter row.
    const g = await makeGroup();
    const first = await jp(g, g.pt.entity.id, dateOnly(2026, 8, 5), "Sebelum tutup");
    expect(await numberOf(first.id)).toBe("JP-2608-0001");
    await lock(g, 2026, 9);
    await expect(jp(g, g.pt.entity.id, dateOnly(2026, 8, 20), "Terlambat")).rejects.toThrow("September 2026 sudah ditutup");
    await expect(jp(g, g.pt.entity.id, dateOnly(2026, 9, 10), "Di bulan tutup")).rejects.toThrow("sudah ditutup");
    const seqs = await db.journalSequence.findMany({ where: { entityId: g.pt.entity.id }, orderBy: [{ year: "asc" }, { month: "asc" }] });
    expect(seqs.map((s) => [s.prefix, s.month, s.last])).toEqual([["JP", 8, 1]]);
    // October (after the closed month) starts its own series at 0001.
    const oct = await jp(g, g.pt.entity.id, dateOnly(2026, 10, 1), "Oktober");
    expect(await numberOf(oct.id)).toBe("JP-2610-0001");
  });

  it("the database refuses changing or clearing a number", async () => {
    const g = await makeGroup();
    const e = await jp(g, g.pt.entity.id, dateOnly(2026, 8, 5), "Tetap");
    await expect(db.journalEntry.update({ where: { id: e.id }, data: { number: "JP-2608-0099" } })).rejects.toThrow(/tidak bisa diubah/);
    await expect(db.journalEntry.update({ where: { id: e.id }, data: { number: null } })).rejects.toThrow(/tidak bisa diubah/);
    expect(await numberOf(e.id)).toBe("JP-2608-0001");
  });

  it("a financial year ending in March: the number carries the entry's calendar month, a new series each month across the year end", async () => {
    const g = await makeGroup();
    await setFiscalYearEnd(db, { clientId: g.client.id, endMonth: 3 });
    const mar = await jp(g, g.pt.entity.id, dateOnly(2026, 3, 31), "Akhir tahun buku");
    const mar2 = await jp(g, g.pt.entity.id, dateOnly(2026, 3, 31), "Akhir tahun buku 2");
    const apr = await jp(g, g.pt.entity.id, dateOnly(2026, 4, 1), "Awal tahun buku");
    expect([await numberOf(mar.id), await numberOf(mar2.id), await numberOf(apr.id)]).toEqual(["JP-2603-0001", "JP-2603-0002", "JP-2604-0001"]);
  });
});

describe("nomor bukti: Jurnal Umum finds a journal by its number", () => {
  beforeEach(resetDb);

  it("short and long forms find the one journal; a group scope finds each company's journal of that number", async () => {
    const g = await makeGroup();
    await jp(g, g.pt.entity.id, dateOnly(2026, 8, 5), "Satu");
    await jp(g, g.pt.entity.id, dateOnly(2026, 8, 6), "Dua");
    await jp(g, g.pt.entity.id, dateOnly(2026, 8, 7), "Tiga");
    await jp(g, g.owner.entity.id, dateOnly(2026, 8, 8), "Andi satu");
    const range = { start: dateOnly(2026, 8, 1), end: dateOnly(2026, 8, 31), kinds: null };
    const find = async (q: string, entityIds: string[]) =>
      (await journalRegister(db, { clientId: g.client.id, entityIds }, { ...range, search: parseSearch(q, "IDR") }, "all")).entries.map((e) => `${e.entity} ${e.number} ${e.memo}`);
    const pt = [g.pt.entity.id];
    expect(await find("jp-2608-2", pt)).toEqual(["PT Uji JP-2608-0002 Dua"]);
    expect(await find("JP/2608/0003", pt)).toEqual(["PT Uji JP-2608-0003 Tiga"]);
    expect(await find("jp 2608 1", pt)).toEqual(["PT Uji JP-2608-0001 Satu"]);
    expect(await find("JP-2608-0001", [g.pt.entity.id, g.owner.entity.id])).toEqual(["PT Uji JP-2608-0001 Satu", "Andi JP-2608-0001 Andi satu"]);
    // Part of a number finds every journal containing it.
    expect((await find("2608-000", pt)).length).toBe(3);
  });
});
