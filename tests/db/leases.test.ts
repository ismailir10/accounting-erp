import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { cancelLease, createLease, leaseMonthsDue, leasesVsLedger, postLeaseMonths, type LeaseInput } from "@/lib/leases/register";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction } from "@/lib/review";
import { runControls } from "@/lib/controls";
import { taxPack } from "@/lib/tax/pack";
import { assetCandidates } from "@/lib/assets/register";
import { scheduleCandidates } from "@/lib/adjust/candidates";

type G = Awaited<ReturnType<typeof makeGroup>>;
const lines = async (entryId: string) => (await db.journalLine.findMany({ where: { entryId }, include: { account: true }, orderBy: { id: "asc" } })).map((l) => [l.account.code, l.debit, l.credit]);
const office = (g: G, over: Partial<LeaseInput> = {}) =>
  createLease(db, { clientId: g.client.id, entityId: g.pt.entity.id, name: "Kantor Sudirman", lessor: "PT Graha Properti", start: "2026-06", months: 24, payment: "10.000.000", intervalMonths: 1, timing: "ARREARS", rate: "12", ...over });

/** PT Uji's rent paid at each month-end, June–August 2026 (invented). */
const CSV = [
  "Tanggal;Keterangan;Debet;Kredit;Saldo",
  "30/06/2026;TRSF DB PT GRAHA PROPERTI SEWA JUN;10000000;0;90000000",
  "31/07/2026;TRSF DB PT GRAHA PROPERTI SEWA JUL;10000000;0;80000000",
  "31/08/2026;TRSF DB PT GRAHA PROPERTI SEWA AGU;10000000;0;70000000",
  "",
].join("\n");

describe("lease register (PSAK 116)", () => {
  beforeEach(resetDb);

  it("recognises the lease, journals its months, and ties to the ledger once payments are classified", async () => {
    const g = await makeGroup();
    const lease = await office(g);
    // PV of 24 × 10 jt at 1 % a month = 212 433 873; 112 550 775 is still owed after 12 months (non-current).
    const entry = await db.journalEntry.findUniqueOrThrow({ where: { id: lease.entryId! } });
    expect([entry.date.toISOString().slice(0, 10), entry.memo]).toEqual(["2026-06-01", "Pengakuan awal sewa Kantor Sudirman · PT Graha Properti (PSAK 116)"]);
    expect(await lines(entry.id)).toEqual([["1230", 212_433_873n, 0n], ["2170", 0n, 99_883_098n], ["2400", 0n, 112_550_775n]]);
    // The ROU asset belongs to the lease register, not the fixed-asset register.
    expect(await assetCandidates(db, g.client.id)).toEqual([]);
    expect(await scheduleCandidates(db, g.client.id, 2026, 6)).toEqual([]);

    expect((await leaseMonthsDue(db, g.client.id, g.pt.entity.id, 2026, 8)).map((d) => d.k)).toEqual([1, 2, 3]);
    // Before the months are journalled the books carry no depreciation or interest, so only the fiscal rent is corrected (−30 jt).
    expect((await taxPack(db, g.client.id, g.pt.entity.id, 2026, 8))!.corrections.find((c) => c.key === "auto:leases")).toMatchObject({ direction: "NEGATIVE", amount: 30_000_000n });
    expect(await postLeaseMonths(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 8 })).toBe(3);
    const june = await db.leasePosting.findFirstOrThrow({ where: { leaseId: lease.id, month: 1 }, include: { entry: true } });
    expect(june.entry).toMatchObject({ memo: "Sewa Kantor Sudirman (1/24): penyusutan hak guna, bunga, reklasifikasi" });
    expect(june.entry.date.toISOString().slice(0, 10)).toBe("2026-06-30");
    expect(await lines(june.entryId)).toEqual([["6181", 8_851_411n, 0n], ["1239", 0n, 8_851_411n], ["7195", 2_124_338n, 0n], ["2170", 0n, 2_124_338n], ["2400", 8_874_493n, 0n], ["2170", 0n, 8_874_493n]]);
    await expect(postLeaseMonths(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 8 })).rejects.toThrow(/Tidak ada jurnal sewa/);

    // No payment classified yet: the ledger owes 30 jt more than the register.
    const control = async () => (await runControls(db, g.client.id, 2026, 8)).find((c) => c.key === `lease:${g.pt.entity.id}`);
    const before = await leasesVsLedger(db, g.client.id, g.pt.entity.id, 2026, 8);
    expect(before!.ledger.liability - before!.register.liability).toBe(30_000_000n);
    expect(await control()).toMatchObject({ status: "REVIEW", detail: expect.stringContaining("diklasifikasikan ke 2170") });
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca.csv", data: Buffer.from(CSV), provider: null });
    for (const t of await db.bankTransaction.findMany({ where: { description: { contains: "GRAHA" } } })) await reviewTransaction(db, { bankTxId: t.id, accountCode: "2170", taxTag: null });
    const after = await leasesVsLedger(db, g.client.id, g.pt.entity.id, 2026, 8);
    expect(after).toMatchObject({ equal: true, due: 0 });
    expect(after!.register).toMatchObject({ rou: 212_433_873n, accumulated: 8_851_411n * 3n });
    expect(await control()).toMatchObject({ status: "PASS" });

    // Tax: depreciation 3 × 8 851 411 + interest 2 124 338 + 2 045 582 + 1 966 038 − rent 3 × 10 jt = 2 690 191, a timing difference.
    const pack = (await taxPack(db, g.client.id, g.pt.entity.id, 2026, 8))!;
    expect(pack.corrections.find((c) => c.key === "auto:leases")).toMatchObject({ direction: "POSITIVE", kind: "TEMPORARY", amount: 2_690_191n, source: { type: "LEASES" } });
    expect(pack.deferred).toEqual({ assets: 0n, allowance: 0n, leases: 2_690_191n, employeeBenefits: 0n, temporaryDifference: 2_690_191n, amount: 591_842n, oci: 0n });
    // September is due next; July's control is unaffected by it.
    expect((await runControls(db, g.client.id, 2026, 9)).find((c) => c.key === `lease:${g.pt.entity.id}`)).toMatchObject({ status: "REVIEW", detail: expect.stringContaining("1 jurnal bulanan sewa belum dicatat") });
  });

  it("refuses short-term leases and bad terms, stops at a locked month, cancels only unjournalled leases", async () => {
    const g = await makeGroup();
    await expect(office(g, { months: 12 })).rejects.toThrow(/jangka pendek/);
    await expect(office(g, { months: 25, intervalMonths: 3 })).rejects.toThrow(/kelipatan 3 bulan/);
    await expect(office(g, { rate: "abc" })).rejects.toThrow(/Suku bunga/);
    await expect(office(g, { payment: "0" })).rejects.toThrow(/lebih dari nol/);

    const lease = await office(g);
    await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 7 } }, update: { status: "LOCKED" }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 7, status: "LOCKED" } });
    await expect(postLeaseMonths(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 8 })).rejects.toThrow(/Juli 2026 sudah (dikunci|ditutup)/);
    expect(await db.leasePosting.count()).toBe(0); // all or nothing
    // A locked July also freezes the months before it (accounting-rules 4): reopen it for the rest.
    await db.period.update({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 7 } }, data: { status: "OPEN" } });

    const mistake = await office(g, { name: "Gudang salah input" });
    const cancelled = await cancelLease(db, { clientId: g.client.id, leaseId: mistake.id });
    expect(await lines(cancelled.cancelEntryId!)).toEqual([["1230", 0n, 212_433_873n], ["2170", 99_883_098n, 0n], ["2400", 112_550_775n, 0n]]);
    await expect(cancelLease(db, { clientId: g.client.id, leaseId: mistake.id })).rejects.toThrow(/sudah dibatalkan/);
    // A cancelled lease no longer counts in the register or the due months.
    expect((await leaseMonthsDue(db, g.client.id, g.pt.entity.id, 2026, 6)).map((d) => d.lease.id)).toEqual([lease.id]);

    await postLeaseMonths(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 6 });
    await expect(cancelLease(db, { clientId: g.client.id, leaseId: lease.id })).rejects.toThrow(/tidak bisa dibatalkan/);
  });
});
