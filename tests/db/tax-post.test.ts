import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { postJournal } from "@/lib/ledger/post";
import { createAsset } from "@/lib/assets/register";
import { postInstallment } from "@/lib/adjust/schedules";
import { taxPack } from "@/lib/tax/pack";
import { postTax } from "@/lib/tax/post";
import { addCorrection, addCredit, setRegime } from "@/lib/tax/records";
import { disposeAsset } from "@/lib/assets/dispose";
import { runControls } from "@/lib/controls";
import { dateOnly } from "@/lib/format";

type G = Awaited<ReturnType<typeof makeGroup>>;
const acc = async (g: G, code: string) => (await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code } })).id;
const journal = async (g: G, date: Date, dr: string, cr: string, amount: bigint) =>
  db.$transaction(async (tx) => postJournal(tx, { entityId: g.pt.entity.id, date, kind: "ADJUSTMENT", memo: "uji", lines: [{ accountId: await acc(g, dr), debit: amount }, { accountId: await acc(g, cr), credit: amount }] }));
const entryLines = async (entryId: string) =>
  (await db.journalLine.findMany({ where: { entryId }, include: { account: true }, orderBy: { id: "asc" } })).map((l) => [l.account.code, l.debit, l.credit]);
const pack = (g: G, month: number) => taxPack(db, g.client.id, g.pt.entity.id, 2026, month).then((p) => p!);

/** Revenue 1 M, costs 400 jt, PPh 25 of 30 jt sitting on 1180. PBT 600 jt → PKP 600 jt → 66 jt at 11 %. */
async function books(g: G) {
  await journal(g, dateOnly(2026, 3, 31), "1130", "4100", 1_000_000_000n);
  await journal(g, dateOnly(2026, 4, 30), "6100", "1110", 400_000_000n);
  await journal(g, dateOnly(2026, 6, 15), "1180", "1110", 30_000_000n);
  await addCredit(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, type: "PPH_23", reference: "BP-1", date: "2026-05-05", amount: "30000000", accountCode: "1180" });
}
const post = (g: G, month: number, kind: "CURRENT" | "DEFERRED") => postTax(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month, kind });

describe("tax postings", () => {
  beforeEach(resetDb);

  it("posts the current tax, then only the change after a correction", async () => {
    const g = await makeGroup();
    await books(g);
    // Due 66 jt, credits 30 jt (bukti potong on 1180) → PPh 29 36 jt.
    const first = await post(g, 9, "CURRENT");
    expect(await entryLines(first.id)).toEqual([["1180", 0n, 30_000_000n], ["2146", 0n, 36_000_000n], ["8100", 66_000_000n, 0n]]);
    expect(first.memo).toBe("PPh badan 2026 (estimasi s.d. September 2026)");
    expect((await pack(g, 9)).proposals.CURRENT).toEqual([]);
    await expect(post(g, 9, "CURRENT")).rejects.toThrow(/Tidak ada selisih/);

    await addCorrection(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, description: "Jamuan", direction: "POSITIVE", kind: "PERMANENT", amount: "10000000" });
    // PKP 610 jt → 67,1 jt: 1,1 jt more expense and payable, nothing else.
    const second = await post(g, 9, "CURRENT");
    expect(await entryLines(second.id)).toEqual([["2146", 0n, 1_100_000n], ["8100", 1_100_000n, 0n]]);
    const payable = await db.journalLine.aggregate({ where: { account: { clientId: g.client.id, code: "2146" } }, _sum: { credit: true, debit: true } });
    expect((payable._sum.credit ?? 0n) - (payable._sum.debit ?? 0n)).toBe(37_100_000n);
  });

  it("turns a payable into an overpayment on 1181 when credits exceed the tax", async () => {
    const g = await makeGroup();
    await books(g);
    await post(g, 9, "CURRENT");
    await addCredit(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, type: "PPH_22", reference: "BP-2", date: "2026-09-01", amount: "50000000", accountCode: "1180" });
    // Credits 80 jt vs due 66 jt: the 36 jt payable goes, 14 jt lebih bayar appears, 50 jt more leaves 1180.
    const e = await post(g, 9, "CURRENT");
    expect(await entryLines(e.id)).toEqual([["1180", 0n, 50_000_000n], ["1181", 14_000_000n, 0n], ["2146", 36_000_000n, 0n]]);
  });

  it("books deferred tax to the computed balance and refuses a locked month", async () => {
    const g = await makeGroup();
    const buy = await journal(g, dateOnly(2026, 8, 10), "1210", "2110", 48_000_000n);
    const a = await createAsset(db, { clientId: g.client.id, entityId: g.pt.entity.id, name: "Laptop", taxGroup: "KELOMPOK_1", fiscalMethod: "GARIS_LURUS", acquiredOn: "2026-08-10", cost: "48000000", assetAccountCode: "1210", sourceEntryId: buy.id });
    await postInstallment(db, { clientId: g.client.id, scheduleId: a.scheduleId!, k: 1 });
    expect(await entryLines((await post(g, 9, "DEFERRED")).id)).toEqual([["2320", 0n, 220_000n], ["8110", 220_000n, 0n]]);
    // October: the gap stays 1 jt (both sides 1 jt a month) → nothing more to post.
    await postInstallment(db, { clientId: g.client.id, scheduleId: a.scheduleId!, k: 2 });
    expect((await pack(g, 10)).proposals.DEFERRED).toEqual([]);
    await journal(g, dateOnly(2026, 10, 5), "1130", "4100", 100_000_000n);
    await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 11 } }, update: { status: "LOCKED" }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 11, status: "LOCKED" } });
    await expect(post(g, 11, "CURRENT")).rejects.toThrow(/ditutup|dikunci/i);
  });

  it("refuses to post into a code the client uses for something else", async () => {
    const g = await makeGroup();
    await books(g);
    await db.account.updateMany({ where: { clientId: g.client.id, code: "2146" }, data: { name: "Utang Dividen", fsLine: "UTANG_LAIN" } });
    await expect(post(g, 9, "CURRENT")).rejects.toThrow(/2146 dipakai untuk "Utang Dividen"/);
  });

  it("asks for the year's tax at the December close until it is booked", async () => {
    const g = await makeGroup();
    await books(g);
    const control = async () => (await runControls(db, g.client.id, 2026, 12)).find((c) => c.key === `tax:${g.pt.entity.id}`);
    expect((await runControls(db, g.client.id, 2026, 9)).some((c) => c.key.startsWith("tax:"))).toBe(false);
    expect(await control()).toMatchObject({ status: "REVIEW", title: "PPh badan 2026 belum dijurnal" });
    // Buku's own journal is in the detail: credits out of 1180, only the remainder to 2146 (the AI review quotes it, never invents one).
    const lines = (await pack(g, 12)).proposals.CURRENT;
    expect((await control())!.detail).toContain("Usulan Buku: ");
    for (const l of lines) expect((await control())!.detail).toContain(`${l.amount >= 0n ? "D" : "K"} ${l.code} Rp`);
    await post(g, 12, "CURRENT");
    expect(await control()).toBeUndefined();
  });

  it("reverses an earlier current-tax journal when the year switches to the final regime", async () => {
    const g = await makeGroup();
    await books(g);
    await post(g, 9, "CURRENT");
    await setRegime(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, regime: "FINAL_UMKM" });
    // The normal journal is reversed and the final tax (0,5 % × 1 M turnover) booked in the same entry.
    expect((await pack(g, 9)).proposals.CURRENT.map((l) => [l.code, l.amount])).toEqual([["1180", 30_000_000n], ["2145", -5_000_000n], ["2146", 36_000_000n], ["8100", -66_000_000n], ["8200", 5_000_000n]]);
    const back = await post(g, 9, "CURRENT");
    expect(back.memo).toBe("PPh final PP 55/2022 2026 (0,5% × peredaran bruto s.d. September 2026); membalik jurnal PPh badan skema normal");
    for (const code of ["8100", "2146"]) {
      const s = await db.journalLine.aggregate({ where: { account: { clientId: g.client.id, code }, entry: { taxPosting: { isNot: null } } }, _sum: { debit: true, credit: true } });
      expect((s._sum.debit ?? 0n) - (s._sum.credit ?? 0n), code).toBe(0n);
    }
    expect((await pack(g, 9)).proposals.CURRENT).toEqual([]);
  });

  it("books the PP 55/2022 final tax as an expense against 2145, month by month as the difference; payments clear 2145", async () => {
    const g = await makeGroup();
    await setRegime(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, regime: "FINAL_UMKM" });
    await journal(g, dateOnly(2026, 1, 20), "1130", "4100", 200_000_000n);
    const jan = await post(g, 1, "CURRENT");
    expect(jan.memo).toBe("PPh final PP 55/2022 2026 (0,5% × peredaran bruto s.d. Januari 2026)");
    expect(await entryLines(jan.id)).toEqual([["2145", 0n, 1_000_000n], ["8200", 1_000_000n, 0n]]);
    // February: 100 jt more turnover → 500.000 more; January's payment (filed to 2145 by the tax rules) clears January's part.
    await journal(g, dateOnly(2026, 2, 10), "1130", "4100", 100_000_000n);
    await journal(g, dateOnly(2026, 2, 15), "2145", "1110", 1_000_000n);
    expect(await entryLines((await post(g, 2, "CURRENT")).id)).toEqual([["2145", 0n, 500_000n], ["8200", 500_000n, 0n]]);
    const payable = await db.journalLine.aggregate({ where: { account: { clientId: g.client.id, code: "2145" } }, _sum: { credit: true, debit: true } });
    expect((payable._sum.credit ?? 0n) - (payable._sum.debit ?? 0n)).toBe(500_000n);
    expect((await pack(g, 2)).proposals.CURRENT).toEqual([]);
  });

  it("counts only postings up to the chosen month and refuses to post before a later one", async () => {
    const g = await makeGroup();
    await books(g);
    await post(g, 12, "CURRENT");
    const sep = await pack(g, 9);
    expect(sep.laterPosting.CURRENT?.toISOString().slice(0, 10)).toBe("2026-12-31");
    expect(sep.proposals.CURRENT).toEqual([]);
    await expect(post(g, 9, "CURRENT")).rejects.toThrow(/sudah dicatat per 31 Des 2026/);
    expect((await pack(g, 12)).proposals.CURRENT).toEqual([]);
  });

  it("brings a deferred balance back to zero once the register is empty", async () => {
    const g = await makeGroup();
    const buy = await journal(g, dateOnly(2026, 8, 10), "1210", "2110", 48_000_000n);
    const a = await createAsset(db, { clientId: g.client.id, entityId: g.pt.entity.id, name: "Laptop", taxGroup: "KELOMPOK_1", fiscalMethod: "GARIS_LURUS", acquiredOn: "2026-08-10", cost: "48000000", assetAccountCode: "1210", sourceEntryId: buy.id });
    await postInstallment(db, { clientId: g.client.id, scheduleId: a.scheduleId!, k: 1 });
    await post(g, 9, "DEFERRED");
    await postInstallment(db, { clientId: g.client.id, scheduleId: a.scheduleId!, k: 2 });
    await disposeAsset(db, { clientId: g.client.id, assetId: a.id, date: "2026-10-20", proceeds: "0", proceedsCode: "1140" });
    // 2027: the register is empty, the 220 rb liability booked in 2026 goes.
    const next = (await taxPack(db, g.client.id, g.pt.entity.id, 2027, 1))!;
    expect(next.deferred).toEqual({ assets: 0n, allowance: 0n, leases: 0n, employeeBenefits: 0n, temporaryDifference: 0n, amount: 0n, oci: 0n });
    expect(next.proposals.DEFERRED.map((l) => [l.code, l.amount])).toEqual([["2320", 220_000n], ["8110", -220_000n]]);
  });
});
