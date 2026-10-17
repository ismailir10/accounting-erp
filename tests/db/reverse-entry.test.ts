import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { reversalBlocker, reverseEntry } from "@/lib/ledger/reverse";
import { dateOnly } from "@/lib/format";
import { recordInventoryCount } from "@/lib/inventory";
import { postJournal } from "@/lib/ledger/post";
import { deleteClient } from "@/lib/clients/delete";

type G = Awaited<ReturnType<typeof makeGroup>>;
const accrual = (g: G) =>
  postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 8, 31), memo: "Akrual listrik Agustus", lines: [{ accountCode: "6130", debit: "2.500.000", credit: "" }, { accountCode: "2150", debit: "", credit: "2.500.000" }] });
const lines = async (entryId: string) => (await db.journalLine.findMany({ where: { entryId }, include: { account: true } })).map((l) => [l.account.code, l.debit, l.credit]).sort();

describe("Balik jurnal", () => {
  beforeEach(resetDb);

  it("mirrors a manual adjustment on the chosen date, once, never before the original", async () => {
    const g = await makeGroup();
    const original = await accrual(g);
    await expect(reverseEntry(db, { clientId: g.client.id, entryId: original.id, date: dateOnly(2026, 8, 30) })).rejects.toThrow("Tanggal pembalik tidak boleh sebelum jurnal aslinya (31 Agu 2026).");
    const back = await reverseEntry(db, { clientId: g.client.id, entryId: original.id, date: dateOnly(2026, 9, 1) });
    expect(back).toMatchObject({ kind: "ADJUSTMENT", memo: "Pembalik: Akrual listrik Agustus (31 Agu 2026)", reversesId: original.id });
    expect(await lines(back.id)).toEqual([["2150", 2_500_000n, 0n], ["6130", 0n, 2_500_000n]]);
    expect(await lines(original.id)).toEqual([["2150", 0n, 2_500_000n], ["6130", 2_500_000n, 0n]]); // untouched
    await expect(reverseEntry(db, { clientId: g.client.id, entryId: original.id, date: dateOnly(2026, 9, 1) })).rejects.toThrow("Jurnal ini sudah dibalik per 1 Sep 2026.");
    await expect(reverseEntry(db, { clientId: g.client.id, entryId: back.id, date: dateOnly(2026, 9, 2) })).rejects.toThrow("Ini jurnal pembalik");
    // Deleting the client removes both despite the self-reference.
    await deleteClient(db, { firmId: g.firm.id, clientId: g.client.id, confirmName: "Grup Uji" });
    expect(await db.journalEntry.count()).toBe(0);
  });

  it("refuses another client's entry, a locked month and an entry a register owns", async () => {
    const g = await makeGroup();
    const other = await makeGroup();
    const original = await accrual(g);
    await expect(reverseEntry(db, { clientId: other.client.id, entryId: original.id, date: dateOnly(2026, 9, 1) })).rejects.toThrow("Jurnal tidak ditemukan.");
    await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 9 } }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 9, status: "LOCKED" }, update: { status: "LOCKED" } });
    await expect(reverseEntry(db, { clientId: g.client.id, entryId: original.id, date: dateOnly(2026, 9, 1) })).rejects.toThrow("Periode September 2026 sudah ditutup");

    const acc = async (code: string) => (await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code } })).id;
    await db.$transaction(async (tx) => postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, 7, 31), kind: "OPENING", memo: "Saldo awal", lines: [{ accountId: await acc("1160"), debit: 10n }, { accountId: await acc("3100"), credit: 10n }] }));
    const count = await recordInventoryCount(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 8, amount: 15n });
    await expect(reverseEntry(db, { clientId: g.client.id, entryId: count.entryId!, date: dateOnly(2026, 8, 31) })).rejects.toThrow("Jurnal persediaan: catat ulang hitungan di halaman Persediaan.");
    // A recount keeps only the newest journal on the count row; the earlier one is still the count's.
    const recount = await recordInventoryCount(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 8, amount: 12n });
    expect(recount.entryId).not.toBe(count.entryId);
    await expect(reverseEntry(db, { clientId: g.client.id, entryId: count.entryId!, date: dateOnly(2026, 8, 31) })).rejects.toThrow("Jurnal persediaan");
  });

  it("an adjustment posted from a close proposal is changed there, not reversed", () => {
    const owned = { kind: "ADJUSTMENT", scheduleId: null, reversesId: null, reversedBy: null, taxPosting: null, leasePosting: null, leaseCommenced: null, leaseCancelled: null, benefitPosting: null, inventoryCounts: [], assetDisposal: null, assetsFrom: [], schedulesFrom: [], lines: [{ currency: null, account: { code: "6190" } }] };
    expect(reversalBlocker({ ...owned, proposal: null })).toBeNull();
    expect(reversalBlocker({ ...owned, proposal: { id: "p" } })).toMatch(/usulan koreksi Tutup Buku/);
  });
});

describe("Jurnal Penyesuaian: line notes and the automatic reversal", () => {
  beforeEach(resetDb);
  const input = (g: G, extra: object = {}) => ({
    clientId: g.client.id,
    entityId: g.pt.entity.id,
    date: dateOnly(2026, 12, 31),
    memo: "Akrual jasa audit",
    lines: [{ accountCode: "6170", debit: "15.000.000", credit: "", memo: "  Fee audit  2026 " }, { accountCode: "2150", debit: "", credit: "15.000.000" }],
    ...extra,
  });

  it("keeps each line's note and reverses on the first of the next month in the same transaction, across the year end", async () => {
    const g = await makeGroup();
    const entry = await postAdjustment(db, input(g, { reverseNextMonth: true }));
    const back = await db.journalEntry.findUniqueOrThrow({ where: { reversesId: entry.id }, include: { lines: { include: { account: true } } } });
    expect([back.date.toISOString().slice(0, 10), back.memo, back.kind]).toEqual(["2027-01-01", "Pembalik: Akrual jasa audit (31 Des 2026)", "ADJUSTMENT"]);
    expect(back.lines.map((l) => [l.account.code, l.debit, l.credit, l.memo]).sort()).toEqual([["2150", 15_000_000n, 0n, null], ["6170", 0n, 15_000_000n, "Fee audit 2026"]]);
    expect((await db.journalLine.findFirstOrThrow({ where: { entryId: entry.id, debit: { gt: 0n } } })).memo).toBe("Fee audit 2026");
    // The reversal is the entry's one reversal: Balik jurnal now refuses it.
    await expect(reverseEntry(db, { clientId: g.client.id, entryId: entry.id, date: dateOnly(2027, 1, 2) })).rejects.toThrow("sudah dibalik per 1 Jan 2027");
  });

  it("a closed next month refuses both, and nothing is posted", async () => {
    const g = await makeGroup();
    await db.period.create({ data: { firmId: g.firm.id, clientId: g.client.id, year: 2027, month: 1, status: "LOCKED" } });
    await expect(postAdjustment(db, input(g, { reverseNextMonth: true }))).rejects.toThrow("Jurnal pembalik 1 Jan 2027 tidak bisa dicatat: Periode Januari 2027 sudah ditutup. Jurnalnya tidak disimpan.");
    expect(await db.journalEntry.count()).toBe(0);
    // Without the reversal the accrual itself posts.
    await postAdjustment(db, input(g));
    expect(await db.journalEntry.count()).toBe(1);
  });
});
