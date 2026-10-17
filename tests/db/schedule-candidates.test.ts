import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { scheduleCandidates } from "@/lib/adjust/candidates";
import { createSchedule } from "@/lib/adjust/schedules";
import { postJournal } from "@/lib/ledger/post";
import { dateOnly } from "@/lib/format";

const accountId = async (clientId: string, code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId, code } } })).id;
const post = async (entityId: string, clientId: string, date: Date, dr: string, cr: string, amount: bigint, memo = "uji", kind: "ADJUSTMENT" | "OPENING" = "ADJUSTMENT") =>
  db.$transaction(async (tx) => postJournal(tx, { entityId, date, kind, memo, lines: [{ accountId: await accountId(clientId, dr), debit: amount }, { accountId: await accountId(clientId, cr), credit: amount }] }));

/** May–Jul: revenue 100 jt, utilities 5 jt, rent 3 jt, depreciation 1 jt a month → materiality Rp 1.090.000. */
async function books() {
  const g = await makeGroup();
  const pt = g.pt.entity.id;
  const c = g.client.id;
  for (const m of [5, 6, 7]) {
    await post(pt, c, dateOnly(2026, m, 10), "1130", "4100", 100_000_000n);
    await post(pt, c, dateOnly(2026, m, 20), "6130", "1130", 5_000_000n);
    await post(pt, c, dateOnly(2026, m, 25), "6120", "1130", 3_000_000n);
    await post(pt, c, dateOnly(2026, m, 28), "6180", "1219", 1_000_000n);
  }
  await post(pt, c, dateOnly(2026, 8, 10), "1130", "4100", 100_000_000n);
  await post(pt, c, dateOnly(2026, 8, 20), "6130", "1130", 5_000_000n); // utilities arrived; rent and depreciation didn't
  return { g, pt, c };
}

/** A schedule made before the source line was stored: only its entry is recorded (new schedules must store both). */
const legacy = async (input: Parameters<typeof createSchedule>[1]) => {
  const { sourceEntryId, ...rest } = input;
  const s = await createSchedule(db, rest);
  return db.adjustmentSchedule.update({ where: { id: s.id }, data: { sourceEntryId } });
};
const summary = (xs: Awaited<ReturnType<typeof scheduleCandidates>>) => xs.map((x) => [x.kind, x.debitCode, x.creditCode, x.amount, x.months, `${x.startYear}-${x.startMonth}`]);

describe("schedule candidates from the ledger", () => {
  beforeEach(resetDb);

  it("proposes depreciation for a purchase, amortisation for a prepayment and deferred revenue; never an accrual", async () => {
    const { pt, c } = await books();
    const machine = await post(pt, c, dateOnly(2026, 8, 19), "1210", "2110", 48_000_000n, "Mesin pakan otomatis");
    await post(pt, c, dateOnly(2026, 8, 19), "1210", "3100", 30_000_000n, "Saldo awal kendaraan", "OPENING"); // an opening balance is not a purchase
    await post(pt, c, dateOnly(2026, 8, 21), "1210", "2110", 500_000n, "Kursi"); // below materiality
    await post(pt, c, dateOnly(2026, 8, 22), "1170", "2110", 12_000_000n, "Sewa gudang setahun");
    await post(pt, c, dateOnly(2026, 8, 23), "1130", "2160", 6_000_000n, "Kontrak jasa dibayar di muka");

    const found = await scheduleCandidates(db, c, 2026, 8);
    expect(summary(found)).toEqual([
      ["DEPRECIATION", "6180", "1219", 48_000_000n, 48, "2026-9"],
      ["AMORTIZATION", null, "1170", 12_000_000n, 12, "2026-9"],
      ["AMORTIZATION", "2160", "4110", 6_000_000n, 12, "2026-9"],
      // Rent (3 jt a month, missing in August) is no candidate: accruals are proposed per counterparty in Kotak persetujuan
      // (lib/adjust/accruals.ts, cycle 2026-10-18-usulan-akrual).
    ]);
    expect(found[0]).toMatchObject({ sourceEntryId: machine.id, reason: "Pembelian 1210 Aset Tetap 19 Agu 2026: Mesin pakan otomatis", memo: "Penyusutan 1210 Aset Tetap 19 Agu 2026" });
  });

  it("drops a candidate once a schedule cites its entry", async () => {
    const { pt, c } = await books();
    const machine = await post(pt, c, dateOnly(2026, 8, 19), "1210", "2110", 48_000_000n, "Mesin pakan otomatis");
    await legacy({ clientId: c, entityId: pt, kind: "DEPRECIATION", memo: "Penyusutan mesin", debitCode: "6180", creditCode: "1219", amount: "48.000.000", months: 48, startYear: 2026, startMonth: 9, sourceEntryId: machine.id });
    expect(summary(await scheduleCandidates(db, c, 2026, 8))).toEqual([]);
  });

  it("a schedule made from a compound entry covers only its own line; the entry's other lines stay proposed", async () => {
    const { g, pt, c } = await books();
    const vehicles = await db.account.create({ data: { firmId: g.firm.id, clientId: c, code: "1211", name: "Kendaraan", type: "ASET", normalBalance: "DEBIT", fsLine: "ASET_TETAP" } });
    const acc = (code: string) => accountId(c, code);
    // One purchase of two fixed assets, and one invoice with a prepayment and a fixed asset.
    const buy = await db.$transaction(async (tx) => postJournal(tx, { entityId: pt, date: dateOnly(2026, 8, 19), kind: "ADJUSTMENT", memo: "Mesin dan mobil", lines: [{ accountId: await acc("1210"), debit: 48_000_000n }, { accountId: vehicles.id, debit: 30_000_000n }, { accountId: await acc("2110"), credit: 78_000_000n }] }));
    const mixed = await db.$transaction(async (tx) => postJournal(tx, { entityId: pt, date: dateOnly(2026, 8, 22), kind: "ADJUSTMENT", memo: "Sewa dan rak", lines: [{ accountId: await acc("1170"), debit: 12_000_000n }, { accountId: await acc("1210"), debit: 20_000_000n }, { accountId: await acc("2110"), credit: 32_000_000n }] }));
    // Two fixed assets of the same amount on one entry: one schedule covers one of them, never both.
    // The second asset's name is long: its memo is cut at 80 characters, but the account code at the front survives.
    const long = await db.account.create({ data: { firmId: g.firm.id, clientId: c, code: "1212", name: "Peralatan Kantor dan Perlengkapan Cetak Digital Kapasitas Besar untuk Gudang Pusat", type: "ASET", normalBalance: "DEBIT", fsLine: "ASET_TETAP" } });
    const twin = await db.$transaction(async (tx) => postJournal(tx, { entityId: pt, date: dateOnly(2026, 8, 24), kind: "ADJUSTMENT", memo: "Dua printer", lines: [{ accountId: await acc("1210"), debit: 15_000_000n }, { accountId: long.id, debit: 15_000_000n }, { accountId: await acc("2110"), credit: 30_000_000n }] }));
    const name = (id: string | null) => (id === buy.id ? "buy" : id === mixed.id ? "mixed" : "twin");
    const pending = async () => (await scheduleCandidates(db, c, 2026, 8)).filter((x) => name(x.sourceEntryId) !== "twin").map((x) => `${x.kind}:${name(x.sourceEntryId)}:${x.amount}`);
    const twins = async () => (await scheduleCandidates(db, c, 2026, 8)).filter((x) => x.sourceEntryId === twin.id);
    const [, second] = await twins();
    expect([(await twins()).length, second.memo.length, second.memo.startsWith("Penyusutan 1212 ")]).toEqual([2, 80, true]);
    // Scheduling the second candidate (its memo carries 1212) leaves the first one, never the other way round.
    await legacy({ clientId: c, entityId: pt, kind: "DEPRECIATION", memo: second.memo, debitCode: "6180", creditCode: "1219", amount: "15.000.000", months: 36, startYear: 2026, startMonth: 9, sourceEntryId: twin.id });
    expect((await twins()).map((x) => x.memo)).toEqual(["Penyusutan 1210 Aset Tetap 24 Agu 2026"]);
    expect(await pending()).toEqual(["DEPRECIATION:buy:48000000", "DEPRECIATION:buy:30000000", "AMORTIZATION:mixed:12000000", "DEPRECIATION:mixed:20000000"]);

    // A schedule with the prepaid account on the debit side grows the prepayment instead of releasing it: it covers nothing.
    await legacy({ clientId: c, entityId: pt, kind: "AMORTIZATION", memo: "Salah sisi", debitCode: "1170", creditCode: "2110", amount: "12.000.000", months: 12, startYear: 2026, startMonth: 9, sourceEntryId: mixed.id });
    expect(await pending()).toContain("AMORTIZATION:mixed:12000000");
    // Depreciating the machine leaves the car; amortising the rent leaves the rack.
    await legacy({ clientId: c, entityId: pt, kind: "DEPRECIATION", memo: "Penyusutan mesin", debitCode: "6180", creditCode: "1219", amount: "48.000.000", months: 48, startYear: 2026, startMonth: 9, sourceEntryId: buy.id });
    await legacy({ clientId: c, entityId: pt, kind: "AMORTIZATION", memo: "Sewa", debitCode: "6120", creditCode: "1170", amount: "12.000.000", months: 12, startYear: 2026, startMonth: 9, sourceEntryId: mixed.id });
    expect(await pending()).toEqual(["DEPRECIATION:buy:30000000", "DEPRECIATION:mixed:20000000"]);
    // A depreciation created with an edited amount (residual value) still counts when its memo carries the asset's code.
    await legacy({ clientId: c, entityId: pt, kind: "DEPRECIATION", memo: "Penyusutan 1211 mobil", debitCode: "6180", creditCode: "1219", amount: "25.000.000", months: 60, startYear: 2026, startMonth: 9, sourceEntryId: buy.id });
    expect(await pending()).toEqual(["DEPRECIATION:mixed:20000000"]);
    // A prepayment candidate turned into a depreciation (its memo and amount name no asset line) hides no asset line.
    await legacy({ clientId: c, entityId: pt, kind: "DEPRECIATION", memo: "Amortisasi Uang Muka & Biaya Dibayar di Muka 22 Agu 2026", debitCode: "6180", creditCode: "1219", amount: "12.000.000", months: 12, startYear: 2026, startMonth: 9, sourceEntryId: mixed.id });
    expect(await pending()).toEqual(["DEPRECIATION:mixed:20000000"]);
  });

  it("an older depreciation with a custom memo and an adjusted amount still covers its entry's only asset line", async () => {
    const { pt, c } = await books();
    const machine = await post(pt, c, dateOnly(2026, 8, 19), "1210", "2110", 48_000_000n, "Mesin pakan otomatis");
    await legacy({ clientId: c, entityId: pt, kind: "DEPRECIATION", memo: "Susut mesin pakan (nilai sisa 8 jt)", debitCode: "6180", creditCode: "1219", amount: "40.000.000", months: 48, startYear: 2026, startMonth: 9, sourceEntryId: machine.id });
    expect((await scheduleCandidates(db, c, 2026, 8)).filter((x) => x.sourceEntryId === machine.id)).toEqual([]);
  });

  it("a schedule covers one line: releasing a prepayment into deferred revenue leaves the deferred revenue proposed", async () => {
    const { pt, c } = await books();
    const acc = (code: string) => accountId(c, code);
    const both = await db.$transaction(async (tx) => postJournal(tx, { entityId: pt, date: dateOnly(2026, 8, 22), kind: "ADJUSTMENT", memo: "Sewa dibayar dan jasa diterima di muka", lines: [{ accountId: await acc("1170"), debit: 12_000_000n }, { accountId: await acc("2160"), credit: 6_000_000n }, { accountId: await acc("2110"), credit: 6_000_000n }] }));
    const mine = async () => (await scheduleCandidates(db, c, 2026, 8)).filter((x) => x.sourceEntryId === both.id);
    const prepaid = (await mine()).find((x) => x.creditCode === "1170")!;
    // The accountant picks 2160 as the account the prepayment is released into: the schedule credits 1170 and debits 2160.
    await legacy({ clientId: c, entityId: pt, kind: "AMORTIZATION", memo: prepaid.memo, debitCode: "2160", creditCode: "1170", amount: "12.000.000", months: 12, startYear: 2026, startMonth: 9, sourceEntryId: both.id });
    expect((await mine()).map((x) => [x.debitCode, x.creditCode, x.amount])).toEqual([["2160", "4110", 6_000_000n]]);
  });

  it("a depreciation whose amount points at the entry's prepayment hides no asset line of that amount", async () => {
    const { pt, c } = await books();
    const acc = (code: string) => accountId(c, code);
    const even = await db.$transaction(async (tx) => postJournal(tx, { entityId: pt, date: dateOnly(2026, 8, 22), kind: "ADJUSTMENT", memo: "Sewa dan rak", lines: [{ accountId: await acc("1170"), debit: 20_000_000n }, { accountId: await acc("1210"), debit: 20_000_000n }, { accountId: await acc("2110"), credit: 40_000_000n }] }));
    const mine = async () => (await scheduleCandidates(db, c, 2026, 8)).filter((x) => x.sourceEntryId === even.id).map((x) => `${x.kind}:${x.amount}`);
    const prepaid = (await scheduleCandidates(db, c, 2026, 8)).find((x) => x.sourceEntryId === even.id && x.kind === "AMORTIZATION")!;
    // An older schedule: the prepayment candidate turned into a depreciation, keeping its memo and amount.
    await legacy({ clientId: c, entityId: pt, kind: "DEPRECIATION", memo: prepaid.memo, debitCode: "6180", creditCode: "1219", amount: "20.000.000", months: 12, startYear: 2026, startMonth: 9, sourceEntryId: even.id });
    expect(await mine()).toEqual(["AMORTIZATION:20000000", "DEPRECIATION:20000000"]);
  });

  it("a prepayment already amortised no longer blocks the amount match of an older depreciation, whichever came first", async () => {
    const { pt, c } = await books();
    const acc = (code: string) => accountId(c, code);
    const entry = async (day: number) => db.$transaction(async (tx) => postJournal(tx, { entityId: pt, date: dateOnly(2026, 8, day), kind: "ADJUSTMENT", memo: "Sewa dan rak", lines: [{ accountId: await acc("1170"), debit: 20_000_000n }, { accountId: await acc("1210"), debit: 20_000_000n }, { accountId: await acc("2110"), credit: 40_000_000n }] }));
    const [first, second] = [await entry(22), await entry(23)];
    const depreciate = (id: string) => legacy({ clientId: c, entityId: pt, kind: "DEPRECIATION", memo: "Susut rak gudang", debitCode: "6180", creditCode: "1219", amount: "20.000.000", months: 48, startYear: 2026, startMonth: 9, sourceEntryId: id });
    const amortise = (id: string) => legacy({ clientId: c, entityId: pt, kind: "AMORTIZATION", memo: "Sewa gudang", debitCode: "6120", creditCode: "1170", amount: "20.000.000", months: 12, startYear: 2026, startMonth: 9, sourceEntryId: id });
    await amortise(first.id);
    await depreciate(first.id);
    await depreciate(second.id);
    await amortise(second.id);
    expect((await scheduleCandidates(db, c, 2026, 8)).filter((x) => x.sourceEntryId === first.id || x.sourceEntryId === second.id)).toEqual([]);
  });

  it("an older depreciation still covers the asset a prepayment was reclassed into", async () => {
    const { pt, c } = await books();
    const reclass = await post(pt, c, dateOnly(2026, 8, 22), "1210", "1170", 20_000_000n, "Uang muka rak jadi aset");
    await legacy({ clientId: c, entityId: pt, kind: "DEPRECIATION", memo: "Susut rak gudang", debitCode: "6180", creditCode: "1219", amount: "20.000.000", months: 48, startYear: 2026, startMonth: 9, sourceEntryId: reclass.id });
    expect((await scheduleCandidates(db, c, 2026, 8)).filter((x) => x.sourceEntryId === reclass.id)).toEqual([]);
  });

  it("a schedule that stores its source line covers exactly that line, whatever its memo and amount", async () => {
    const { g, pt, c } = await books();
    const acc = (code: string) => accountId(c, code);
    const printers = await db.account.create({ data: { firmId: g.firm.id, clientId: c, code: "1212", name: "Printer", type: "ASET", normalBalance: "DEBIT", fsLine: "ASET_TETAP" } });
    const twin = await db.$transaction(async (tx) => postJournal(tx, { entityId: pt, date: dateOnly(2026, 8, 24), kind: "ADJUSTMENT", memo: "Mesin dan printer", lines: [{ accountId: await acc("1210"), debit: 15_000_000n }, { accountId: printers.id, debit: 15_000_000n }, { accountId: await acc("1170"), debit: 15_000_000n }, { accountId: await acc("2110"), credit: 45_000_000n }] }));
    const mine = async () => (await scheduleCandidates(db, c, 2026, 8)).filter((x) => x.sourceEntryId === twin.id).map((x) => `${x.kind}:${x.creditCode === "1170" ? "1170" : x.key.split(":").at(-1)}`);
    expect(await mine()).toEqual(["DEPRECIATION:1210", "DEPRECIATION:1212", "AMORTIZATION:1170"]);
    // The second printer scheduled with an edited memo and an equal amount: it, not the first, is covered.
    const base = { clientId: c, entityId: pt, kind: "DEPRECIATION" as const, debitCode: "6180", creditCode: "1219", amount: "15.000.000", months: 36, startYear: 2026, startMonth: 9, sourceEntryId: twin.id };
    await createSchedule(db, { ...base, memo: "Susut peralatan", sourceAccountCode: "1212" });
    expect(await mine()).toEqual(["DEPRECIATION:1210", "AMORTIZATION:1170"]);
    // A stored line wins over a memo naming the prepayment: this depreciation covers 1210, the prepayment stays proposed.
    await createSchedule(db, { ...base, memo: "Amortisasi Uang Muka & Biaya Dibayar di Muka", sourceAccountCode: "1210" });
    expect(await mine()).toEqual(["AMORTIZATION:1170"]);
  });

  it("refuses a source line the entry doesn't have or the schedule doesn't release", async () => {
    const { pt, c } = await books();
    const acc = (code: string) => accountId(c, code);
    const mixed = await db.$transaction(async (tx) => postJournal(tx, { entityId: pt, date: dateOnly(2026, 8, 22), kind: "ADJUSTMENT", memo: "Sewa dan rak", lines: [{ accountId: await acc("1170"), debit: 12_000_000n }, { accountId: await acc("1210"), debit: 20_000_000n }, { accountId: await acc("2110"), credit: 32_000_000n }] }));
    const base = { clientId: c, entityId: pt, kind: "AMORTIZATION" as const, memo: "Sewa", debitCode: "6120", creditCode: "1170", amount: "12.000.000", months: 12, startYear: 2026, startMonth: 9, sourceEntryId: mixed.id };
    await expect(createSchedule(db, { ...base, sourceEntryId: null, sourceAccountCode: "1170" })).rejects.toThrow("Baris sumber perlu jurnal sumbernya.");
    await expect(createSchedule(db, base)).rejects.toThrow("Jurnal sumber perlu baris sumbernya."); // a new schedule stores its line
    await expect(createSchedule(db, { ...base, sourceAccountCode: "2160" })).rejects.toThrow("Jurnal sumber tidak punya baris akun 2160.");
    await expect(createSchedule(db, { ...base, debitCode: "1170", creditCode: "2110", sourceAccountCode: "1170" })).rejects.toThrow("Jadwal ini tidak melepas saldo 1170");
    await expect(createSchedule(db, { ...base, sourceAccountCode: "1210" })).rejects.toThrow("Jadwal ini tidak melepas saldo 1210");
    // A depreciation whose accounts depreciate nothing (rent to payables) can't claim the asset line either.
    await expect(createSchedule(db, { ...base, kind: "DEPRECIATION", debitCode: "6120", creditCode: "2110", sourceAccountCode: "1210" })).rejects.toThrow("Jadwal ini tidak melepas saldo 1210");
    // Nor one crediting another fixed asset: its installments would write that asset down, not 1210.
    const other = await db.account.create({ data: { firmId: (await db.client.findUniqueOrThrow({ where: { id: c } })).firmId, clientId: c, code: "1211", name: "Kendaraan", type: "ASET", normalBalance: "DEBIT", fsLine: "ASET_TETAP" } });
    await expect(createSchedule(db, { ...base, kind: "DEPRECIATION", debitCode: "6180", creditCode: other.code, sourceAccountCode: "1210" })).rejects.toThrow("Jadwal ini tidak melepas saldo 1210");
    expect((await createSchedule(db, { ...base, kind: "DEPRECIATION", memo: "Susut rak langsung", debitCode: "6180", creditCode: "1210", amount: "20.000.000", sourceAccountCode: "1210" })).sourceAccountId).toBe(await acc("1210"));
    // An accrual reverses next month, so it never releases a prepayment: only an amortisation does.
    await expect(createSchedule(db, { ...base, kind: "ACCRUAL", sourceAccountCode: "1170" })).rejects.toThrow("Jadwal ini tidak melepas saldo 1170");
    const ok = await createSchedule(db, { ...base, sourceAccountCode: "1170" });
    expect(ok.sourceAccountId).toBe(await acc("1170"));
    // The database keeps the pair together too.
    await expect(db.adjustmentSchedule.update({ where: { id: ok.id }, data: { sourceEntryId: null } })).rejects.toThrow(/AdjustmentSchedule_source_line_check/);
  });

  it("no candidate is an accrual, whatever the month misses (the recurring-cost candidate moved to Kotak persetujuan)", async () => {
    const { c } = await books();
    for (const month of [6, 7, 8, 9]) expect((await scheduleCandidates(db, c, 2026, month)).filter((x) => x.kind === "ACCRUAL")).toEqual([]);
  });
});

