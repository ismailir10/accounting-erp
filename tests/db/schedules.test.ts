import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { closeLock, createSchedule, dueProposals, installments, listSchedules, postAllDue, postInstallment, stopSchedule } from "@/lib/adjust/schedules";
import { dateOnly } from "@/lib/format";
import { CLOSE_SIGNOFFS, lockPeriod, runControls } from "@/lib/controls";

describe("adjustment schedules", () => {
  beforeEach(resetDb);

  it("splits the total exactly, the last installment taking the remainder, across a year end", () => {
    const i = installments({ amount: 100n, months: 3, startYear: 2026, startMonth: 11, reverse: false, debitAccountId: "d", creditAccountId: "c" });
    expect(i.map((x) => [x.k, x.year, x.month, x.date.toISOString().slice(0, 10), x.amount])).toEqual([
      [1, 2026, 11, "2026-11-30", 33n],
      [2, 2026, 12, "2026-12-31", 33n],
      [3, 2027, 1, "2027-01-31", 34n],
    ]);
    expect(i.reduce((s, x) => s + x.amount, 0n)).toBe(100n);
  });

  it("an accrual is one month and reverses on the 1st of the next, sides swapped", async () => {
    const g = await makeGroup();
    const s = await createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "ACCRUAL", memo: "Akrual listrik Agustus", debitCode: "6130", creditCode: "2150", amount: "4.500.000", months: 12, startYear: 2026, startMonth: 8 });
    expect([s.months, s.reverse, s.amount]).toEqual([1, true, 4_500_000n]);
    const i = installments(s);
    expect(i.map((x) => [x.k, x.date.toISOString().slice(0, 10), x.reversal, x.debitAccountId === s.debitAccountId])).toEqual([
      [1, "2026-08-31", false, true],
      [2, "2026-09-01", true, false],
    ]);
    // The reversal waits for the accrual: September shows only the overdue August accrual, never its reversal first.
    expect((await dueProposals(db, g.client.id, 2026, 9)).map((p) => p.memo)).toEqual(["Akrual listrik Agustus (1/1)"]);
    await expect(postInstallment(db, { clientId: g.client.id, scheduleId: s.id, k: 2 })).rejects.toThrow("Catat dulu Akrual listrik Agustus (1/1) sebelum pembaliknya");
    await postInstallment(db, { clientId: g.client.id, scheduleId: s.id, k: 1 });
    const [sep] = await dueProposals(db, g.client.id, 2026, 9);
    expect(sep.memo).toBe("Pembalikan: Akrual listrik Agustus");
  });

  it("a stopped accrual still reverses what it posted, and posts nothing else", async () => {
    const g = await makeGroup();
    const s = await createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "ACCRUAL", memo: "Akrual listrik Agustus", debitCode: "6130", creditCode: "2150", amount: "4.500.000", months: 1, startYear: 2026, startMonth: 8 });
    await postInstallment(db, { clientId: g.client.id, scheduleId: s.id, k: 1 });
    await stopSchedule(db, { clientId: g.client.id, scheduleId: s.id });
    // The accrual stays on the books until reversed: September still proposes the reversal and it posts.
    expect((await dueProposals(db, g.client.id, 2026, 9)).map((p) => p.memo)).toEqual(["Pembalikan: Akrual listrik Agustus"]);
    await postInstallment(db, { clientId: g.client.id, scheduleId: s.id, k: 2 });
    const net = await db.journalLine.aggregate({ where: { entry: { scheduleId: s.id }, account: { code: "2150" } }, _sum: { debit: true, credit: true } });
    expect((net._sum.credit ?? 0n) - (net._sum.debit ?? 0n)).toBe(0n);

    // A depreciation stopped before it started proposes and posts nothing.
    const d = await createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "DEPRECIATION", memo: "Penyusutan", debitCode: "6180", creditCode: "1219", amount: "1.200.000", months: 12, startYear: 2026, startMonth: 8 });
    await stopSchedule(db, { clientId: g.client.id, scheduleId: d.id, at: new Date("2026-07-15T00:00:00Z") });
    expect((await dueProposals(db, g.client.id, 2026, 8)).map((p) => p.schedule.id)).not.toContain(d.id);
    await expect(postInstallment(db, { clientId: g.client.id, scheduleId: d.id, k: 1 })).rejects.toThrow("sudah dihentikan");
  });

  it("a stop keeps what was already due: installments through the stop month stay proposed until posted, later ones are dropped", async () => {
    const g = await makeGroup();
    const d = await createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "DEPRECIATION", memo: "Penyusutan", debitCode: "6180", creditCode: "1219", amount: "1.200.000", months: 12, startYear: 2026, startMonth: 8 });
    // Stopped in September with August still unposted: August and September stay owed, October onwards is gone.
    await stopSchedule(db, { clientId: g.client.id, scheduleId: d.id, at: new Date("2026-09-10T00:00:00Z") });
    expect((await dueProposals(db, g.client.id, 2026, 12)).map((p) => p.memo)).toEqual(["Penyusutan (1/12)", "Penyusutan (2/12)"]);
    expect((await runControls(db, g.client.id, 2026, 10)).find((c) => c.key === `sched:${g.pt.entity.id}`)?.status).toBe("REVIEW");
    await postInstallment(db, { clientId: g.client.id, scheduleId: d.id, k: 1 });
    await expect(postInstallment(db, { clientId: g.client.id, scheduleId: d.id, k: 3 })).rejects.toThrow("sudah dihentikan");
    await postAllDue(db, { clientId: g.client.id, year: 2026, month: 12 });
    expect(await dueProposals(db, g.client.id, 2026, 12)).toEqual([]);
    expect(await db.journalEntry.count({ where: { scheduleId: d.id } })).toBe(2);
  });

  it("a posting click that races a stop waits for it and then refuses", async () => {
    const g = await makeGroup();
    const d = await createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "DEPRECIATION", memo: "Penyusutan", debitCode: "6180", creditCode: "1219", amount: "1.200.000", months: 12, startYear: 2026, startMonth: 8 });
    let post: Promise<unknown> = Promise.resolve();
    // The stop is written but not yet committed when the click arrives; the click must not post past it.
    await db.$transaction(async (tx) => {
      await tx.adjustmentSchedule.update({ where: { id: d.id }, data: { stoppedAt: new Date("2026-07-15T00:00:00Z") } }); // before August
      post = postInstallment(db, { clientId: g.client.id, scheduleId: d.id, k: 1 });
      post.catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    });
    await expect(post).rejects.toThrow("sudah dihentikan");
    expect(await db.journalEntry.count({ where: { scheduleId: d.id } })).toBe(0);
  });

  it("refuses the same account twice, bank or suspense accounts, a zero amount and zero months", async () => {
    const g = await makeGroup();
    const base = { clientId: g.client.id, entityId: g.pt.entity.id, kind: "DEPRECIATION" as const, memo: "Penyusutan", debitCode: "6180", creditCode: "1219", amount: "1.200.000", months: 12, startYear: 2026, startMonth: 9 };
    await expect(createSchedule(db, { ...base, creditCode: "6180" })).rejects.toThrow("harus berbeda");
    await expect(createSchedule(db, { ...base, creditCode: "1999" })).rejects.toThrow("tidak memakai akun bank");
    const bank = await db.account.findFirstOrThrow({ where: { clientId: g.client.id, isBank: true } });
    await expect(createSchedule(db, { ...base, creditCode: bank.code })).rejects.toThrow("tidak memakai akun bank");
    await expect(createSchedule(db, { ...base, amount: "0" })).rejects.toThrow("lebih dari nol");
    await expect(createSchedule(db, { ...base, months: 0 })).rejects.toThrow("Jumlah bulan");
    await expect(createSchedule(db, { ...base, amount: "5", months: 12 })).rejects.toThrow("terlalu kecil untuk dibagi 12 bulan"); // Rp 0 installments could never post
    await expect(createSchedule(db, { ...base, entityId: "bukan" })).rejects.toThrow("Pilih entitas");
  });

  it("refuses a schedule with an installment or reversal in a locked month", async () => {
    const g = await makeGroup();
    const lock = (month: number) => db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month } }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month, status: "LOCKED" }, update: { status: "LOCKED" } });
    await lock(8);
    const base = { clientId: g.client.id, entityId: g.pt.entity.id, kind: "DEPRECIATION" as const, memo: "Penyusutan", debitCode: "6180", creditCode: "1219", amount: "1.200.000", months: 2, startYear: 2026, startMonth: 8 };
    // A two-month schedule starting in locked August would expose only September, leaving August unrecognised forever.
    await expect(createSchedule(db, base)).rejects.toThrow("Agustus 2026 sudah dikunci");
    // An accrual in open October whose reversal (1 November) lands in a locked month is refused too.
    await lock(11);
    await expect(createSchedule(db, { ...base, kind: "ACCRUAL", months: 1, startMonth: 10 })).rejects.toThrow("November 2026 sudah dikunci");
    expect(await db.adjustmentSchedule.count()).toBe(0);
    // Between the locked months is frozen too: November's lock froze September (a journal before a closed month changes its Neraca).
    await expect(createSchedule(db, { ...base, startMonth: 9 })).rejects.toThrow("November 2026 sudah dikunci, jadi cicilan September 2026 tidak bisa dicatat lagi");
    // After the latest closed month is fine.
    await createSchedule(db, { ...base, startMonth: 12 });
    expect(await db.adjustmentSchedule.count()).toBe(1);
  });

  it("a schedule racing a close: creation waits for a lock in progress and is refused; a close sees a schedule created meanwhile and is refused", async () => {
    const g = await makeGroup();
    const base = { clientId: g.client.id, entityId: g.pt.entity.id, kind: "DEPRECIATION" as const, memo: "Penyusutan", debitCode: "6180", creditCode: "1219", amount: "1.200.000", months: 2, startYear: 2026, startMonth: 8 };
    const period = await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 8 } }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 8 }, update: {} });

    // The close's final step holds the lock and has written LOCKED, not yet committed, when the schedule arrives.
    let created: Promise<unknown> = Promise.resolve();
    await db.$transaction(async (tx) => {
      await closeLock(tx, g.client.id);
      await tx.period.update({ where: { id: period.id }, data: { status: "LOCKED" } });
      created = createSchedule(db, base);
      created.catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    });
    await expect(created).rejects.toThrow("Agustus 2026 sudah dikunci");
    expect(await db.adjustmentSchedule.count()).toBe(0);

    // Reopen August and make it closable (sign-offs done, every REVIEW control noted).
    await db.period.update({ where: { id: period.id }, data: { status: "OPEN" } });
    for (const s of CLOSE_SIGNOFFS) await db.closeSignoff.create({ data: { periodId: period.id, key: s.key } });
    const controls = await runControls(db, g.client.id, 2026, 8);
    expect(controls.filter((c) => c.status === "FAIL")).toEqual([]);
    for (const c of controls) if (c.status === "REVIEW") await db.controlAck.create({ data: { periodId: period.id, controlKey: c.key, note: "Wajar untuk uji" } });

    // A schedule is being created (lock held, row written, not committed) while the close runs its controls: they never saw it.
    let closed: Promise<unknown> = Promise.resolve();
    await db.$transaction(async (tx) => {
      await closeLock(tx, g.client.id);
      await tx.adjustmentSchedule.create({ data: { firmId: g.firm.id, clientId: g.client.id, entityId: g.pt.entity.id, kind: "DEPRECIATION", memo: "Penyusutan", debitAccountId: (await tx.account.findFirstOrThrow({ where: { clientId: g.client.id, code: "6180" } })).id, creditAccountId: (await tx.account.findFirstOrThrow({ where: { clientId: g.client.id, code: "1219" } })).id, amount: 1_200_000n, months: 2, startYear: 2026, startMonth: 8 } });
      closed = lockPeriod(db, g.client.id, 2026, 8, "uji");
      closed.catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    });
    await expect(closed).rejects.toThrow("Jadwal penyesuaian baru yang jatuh tempo sampai bulan ini");
    expect((await db.period.findUniqueOrThrow({ where: { id: period.id } })).status).toBe("OPEN");

    // Closing September while a one-month schedule for open July is written: its installment is overdue in September's controls.
    const sept = await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 9 } }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 9 }, update: {} });
    for (const s of CLOSE_SIGNOFFS) await db.closeSignoff.create({ data: { periodId: sept.id, key: s.key } });
    const septControls = await runControls(db, g.client.id, 2026, 9);
    for (const c of septControls) if (c.status === "REVIEW") await db.controlAck.create({ data: { periodId: sept.id, controlKey: c.key, note: "Wajar untuk uji" } });
    expect(septControls.filter((c) => c.status === "FAIL")).toEqual([]);
    await db.$transaction(async (tx) => {
      await closeLock(tx, g.client.id);
      await tx.adjustmentSchedule.create({ data: { firmId: g.firm.id, clientId: g.client.id, entityId: g.pt.entity.id, kind: "DEPRECIATION", memo: "Penyusutan Juli", debitAccountId: (await tx.account.findFirstOrThrow({ where: { clientId: g.client.id, code: "6180" } })).id, creditAccountId: (await tx.account.findFirstOrThrow({ where: { clientId: g.client.id, code: "1219" } })).id, amount: 600_000n, months: 1, startYear: 2026, startMonth: 7 } });
      closed = lockPeriod(db, g.client.id, 2026, 9, "uji");
      closed.catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    });
    await expect(closed).rejects.toThrow("Jadwal penyesuaian baru yang jatuh tempo sampai bulan ini");
    expect((await db.period.findUniqueOrThrow({ where: { id: sept.id } })).status).toBe("OPEN");
  });

  it("proposes the month's installment, posts it once even when clicked twice, and tracks progress", async () => {
    const g = await makeGroup();
    const s = await createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "DEPRECIATION", memo: "Penyusutan mesin pakan", debitCode: "6180", creditCode: "1219", amount: "166.666.667", months: 48, startYear: 2026, startMonth: 9 });
    expect(await dueProposals(db, g.client.id, 2026, 8)).toEqual([]);
    const [p] = await dueProposals(db, g.client.id, 2026, 9);
    expect([p.memo, p.installment.amount, p.schedule.debitAccount.code]).toEqual(["Penyusutan mesin pakan (1/48)", 3_472_222n, "6180"]);

    const results = await Promise.allSettled([1, 2].map(() => postInstallment(db, { clientId: g.client.id, scheduleId: s.id, k: 1 })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const entries = await db.journalEntry.findMany({ where: { scheduleId: s.id }, include: { lines: true } });
    expect(entries.map((e) => [e.kind, e.installment, e.date.toISOString().slice(0, 10), e.lines.map((l) => l.debit + l.credit)])).toEqual([["ADJUSTMENT", 1, "2026-09-30", [3_472_222n, 3_472_222n]]]);
    await expect(postInstallment(db, { clientId: g.client.id, scheduleId: s.id, k: 1 })).rejects.toThrow("sudah dicatat");
    expect(await dueProposals(db, g.client.id, 2026, 9)).toEqual([]);

    const [row] = await listSchedules(db, g.client.id);
    expect([row.postedCount, row.postedAmount, row.remaining, row.ends]).toEqual([1, 3_472_222n, 166_666_667n - 3_472_222n, { year: 2030, month: 8 }]);
    expect(installments(s).at(-1)!.amount).toBe(166_666_667n - 3_472_222n * 47n);
  });

  it("posts every due installment of a month, refuses a locked month, and stops proposing after a stop", async () => {
    const g = await makeGroup();
    const input = { clientId: g.client.id, entityId: g.pt.entity.id, debitCode: "6120", creditCode: "1170", months: 12, startYear: 2026, startMonth: 8 };
    const rent = await createSchedule(db, { ...input, kind: "AMORTIZATION", memo: "Sewa gudang dibayar di muka", amount: "24.000.000" });
    await createSchedule(db, { ...input, kind: "DEPRECIATION", memo: "Penyusutan kendaraan", debitCode: "6180", creditCode: "1219", amount: "60.000.000", months: 60 });
    expect(await postAllDue(db, { clientId: g.client.id, year: 2026, month: 8 })).toBe(2);
    await expect(postAllDue(db, { clientId: g.client.id, year: 2026, month: 8 })).rejects.toThrow("Tidak ada jurnal terjadwal");

    await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 9 } }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 9, status: "LOCKED" }, update: { status: "LOCKED" } });
    await expect(postInstallment(db, { clientId: g.client.id, scheduleId: rent.id, k: 2 })).rejects.toThrow("sudah ditutup");

    await stopSchedule(db, { clientId: g.client.id, scheduleId: rent.id, at: new Date("2026-09-15T00:00:00Z") });
    expect((await dueProposals(db, g.client.id, 2026, 10)).map((p) => p.schedule.memo)).toEqual(["Penyusutan kendaraan"]);
    await expect(postInstallment(db, { clientId: g.client.id, scheduleId: rent.id, k: 3 })).rejects.toThrow("sudah dihentikan");
    expect(await db.journalEntry.count({ where: { scheduleId: rent.id } })).toBe(1); // what was posted stays
  });

  it("keeps the source entry it came from and never reaches another client's schedule", async () => {
    const g = await makeGroup();
    const other = await makeGroup();
    const buy = await db.$transaction(async (tx) => {
      const acc = async (code: string) => (await tx.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code } } })).id;
      const { postJournal } = await import("@/lib/ledger/post");
      return postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, 8, 19), kind: "ADJUSTMENT", memo: "Beli mesin", lines: [{ accountId: await acc("1210"), debit: 48_000_000n }, { accountId: await acc("2110"), credit: 48_000_000n }] });
    });
    const s = await createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "DEPRECIATION", memo: "Penyusutan mesin", debitCode: "6180", creditCode: "1219", amount: "48.000.000", months: 48, startYear: 2026, startMonth: 9, sourceEntryId: buy.id, sourceAccountCode: "1210" });
    expect(s.sourceEntryId).toBe(buy.id);
    await expect(createSchedule(db, { clientId: g.client.id, entityId: g.owner.entity.id, kind: "DEPRECIATION", memo: "x", debitCode: "6180", creditCode: "1219", amount: "1", months: 1, startYear: 2026, startMonth: 9, sourceEntryId: buy.id, sourceAccountCode: "1210" })).rejects.toThrow("Jurnal sumber tidak termasuk entitas ini.");
    await expect(postInstallment(db, { clientId: other.client.id, scheduleId: s.id, k: 1 })).rejects.toThrow("Jadwal tidak ditemukan");
    await expect(stopSchedule(db, { clientId: other.client.id, scheduleId: s.id })).rejects.toThrow("Jadwal tidak ditemukan");
  });

  it("flags a due, unposted installment on the close until it is posted", async () => {
    const g = await makeGroup();
    const pt = g.pt.entity.id;
    const s = await createSchedule(db, { clientId: g.client.id, entityId: pt, kind: "DEPRECIATION", memo: "Penyusutan aset tetap", debitCode: "6180", creditCode: "1219", amount: "1.140.000.000", months: 120, startYear: 2026, startMonth: 3 });
    const sched = async () => (await runControls(db, g.client.id, 2026, 8)).find((c) => c.key === `sched:${pt}`);
    // March–August are all due and unposted: an earlier month's installment stays visible until posted.
    expect(await sched()).toMatchObject({ status: "REVIEW", title: "Jurnal terjadwal belum dicatat", detail: "6 angsuran: Penyusutan aset tetap (1/120) Rp 9.500.000; Penyusutan aset tetap (2/120) Rp 9.500.000; Penyusutan aset tetap (3/120) Rp 9.500.000; +3 lainnya", href: `/clients/${g.client.id}/journals/new?period=2026-08` });
    await postInstallment(db, { clientId: g.client.id, scheduleId: s.id, k: 6 });
    expect((await sched())?.detail).toMatch(/^5 angsuran/); // posting August alone doesn't clear March–July
    // A locked month's installment can't post any more and is left out.
    await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 3 } }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 3, status: "LOCKED" }, update: { status: "LOCKED" } });
    expect((await sched())?.detail).toMatch(/^4 angsuran: Penyusutan aset tetap \(2\/120\)/);
    await postAllDue(db, { clientId: g.client.id, year: 2026, month: 8 });
    expect(await sched()).toBeUndefined();
    await stopSchedule(db, { clientId: g.client.id, scheduleId: s.id, at: new Date("2026-08-31T00:00:00Z") });
    expect((await runControls(db, g.client.id, 2026, 9)).some((c) => c.key.startsWith("sched:"))).toBe(false);
  });
});

