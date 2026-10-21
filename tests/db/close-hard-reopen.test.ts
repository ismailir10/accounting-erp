import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";

import { postJournal } from "@/lib/ledger/post";
import { CLOSE_SIGNOFFS, lockPeriod, runControls, unlockPeriod } from "@/lib/controls";
import { dateOnly } from "@/lib/format";
import { saveApprovals } from "@/lib/settings/approvals";
import { approveJournal, type Maker } from "@/lib/approvals/journals";
import { cancelReopen, confirmReopen, rejectReopen, requestReopen } from "@/lib/approvals/reopen";
import { approvalCounts } from "@/lib/approvals/queue";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { createRecurring, recurringDue, stopRecurring } from "@/lib/adjust/recurring";
import { postAllRecurring, postRecurring } from "@/lib/adjust/recurring-post";
import { archiveAccount } from "@/lib/coa/manage";

/**
 * The close, tested hard, part two: reopening with Persetujuan kedua, Jurnal berulang against locks and the chart. Periods are LOCKED through
 * `lockPeriod` with every REVIEW control noted (with its current detail) and the sign-offs ticked.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;
const mk = (m: { id: string; role: Maker["role"] }): Maker => ({ id: m.id, role: m.role });
const acc = async (g: G, code: string) => (await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code } })).id;

async function entry(g: G, month: number, amount = 1000n) {
  const [d, c] = [await acc(g, "1120"), await acc(g, "4100")];
  return db.$transaction((tx) => postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, month, 10), kind: "ADJUSTMENT", memo: `Uji ${month}`, lines: [{ accountId: d, debit: amount }, { accountId: c, credit: amount }] }));
}
async function ready(g: G, month: number) {
  const period = await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month } }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month }, update: {} });
  for (const s of CLOSE_SIGNOFFS) await db.closeSignoff.upsert({ where: { periodId_key: { periodId: period.id, key: s.key } }, create: { periodId: period.id, key: s.key }, update: {} });
  for (const c of await runControls(db, g.client.id, 2026, month)) {
    if (c.status === "REVIEW") await db.controlAck.upsert({ where: { periodId_controlKey: { periodId: period.id, controlKey: c.key } }, create: { periodId: period.id, controlKey: c.key, note: "Wajar untuk uji", detail: c.detail }, update: { note: "Wajar untuk uji", detail: c.detail } });
  }
}
const lock = async (g: G, month: number) => {
  await ready(g, month);
  return lockPeriod(db, g.client.id, 2026, month, "uji");
};
const status = async (g: G, month: number) => (await db.period.findUnique({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month } } }))?.status ?? "NONE";
const settings = (g: G, s: { manual?: boolean; manualAbove?: string; reopen?: boolean }) =>
  saveApprovals(db, { firmId: g.firm.id, settings: { manual: s.manual ?? false, manualAbove: s.manualAbove ?? "", aiDraft: false, aiDraftAbove: "", reopen: s.reopen ?? false } });

/** A July Jurnal Penyesuaian on `debitCode` / 2150, the source of a template. */
const julyJournal = (g: G, debitCode = "6120", amount = "3.000.000") =>
  postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 7, 31), memo: `Akrual ${debitCode}`, lines: [{ accountCode: debitCode, debit: amount, credit: "" }, { accountCode: "2150", debit: "", credit: amount }] });

describe("close, tested hard — reopen with Persetujuan kedua", () => {
  beforeEach(resetDb);

  it("R1 the month stays locked until another admin confirms; requester can't confirm; one request per month; confirm clears sign-offs and logs both", async () => {
    const g = await makeGroup();
    const a = await addMember(g.firm.id, "ADMIN", { name: "a" });
    const b = await addMember(g.firm.id, "OWNER", { name: "b" });
    await settings(g, { reopen: true });
    await entry(g, 8);
    await lock(g, 8);
    const o = await requestReopen(db, { clientId: g.client.id, year: 2026, month: 8, actor: mk(a), reason: "Faktur terlambat" });
    expect(o.opened).toBe(false);
    expect(await status(g, 8)).toBe("LOCKED");
    await expect(requestReopen(db, { clientId: g.client.id, year: 2026, month: 8, actor: mk(b), reason: "Faktur lain" })).rejects.toThrow(/sudah ada permintaan/i);
    const id = o.opened ? "" : o.requestId;
    await expect(confirmReopen(db, { clientId: g.client.id, requestId: id, actor: mk(a) })).rejects.toThrow(/admin lain/);
    // While waiting, nothing posts into August.
    await expect(entry(g, 8)).rejects.toThrow(/sudah ditutup/);
    await confirmReopen(db, { clientId: g.client.id, requestId: id, actor: mk(b) });
    expect(await status(g, 8)).toBe("OPEN");
    expect(await db.closeSignoff.count()).toBe(0);
    const [log] = await db.periodUnlockLog.findMany();
    expect([log.requestedById, log.unlockedById, log.reason]).toEqual([a.id, b.id, "Faktur terlambat"]);
  });

  it("R2 reject needs a note and leaves it locked; cancel is the requester's; an Akuntan never decides", async () => {
    const g = await makeGroup();
    const a = await addMember(g.firm.id, "ADMIN", { name: "a" });
    const b = await addMember(g.firm.id, "ADMIN", { name: "b" });
    const ak = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    await settings(g, { reopen: true });
    await entry(g, 8);
    await lock(g, 8);
    const o = await requestReopen(db, { clientId: g.client.id, year: 2026, month: 8, actor: mk(a), reason: "Faktur terlambat" });
    const id = o.opened ? "" : o.requestId;
    await expect(confirmReopen(db, { clientId: g.client.id, requestId: id, actor: mk(ak) })).rejects.toThrow(/Hanya admin/);
    await expect(rejectReopen(db, { clientId: g.client.id, requestId: id, actor: mk(b), note: "no" })).rejects.toThrow(/min. 5/);
    await expect(cancelReopen(db, { clientId: g.client.id, requestId: id, actor: mk(b) })).rejects.toThrow(/Hanya admin yang meminta/);
    await rejectReopen(db, { clientId: g.client.id, requestId: id, actor: mk(b), note: "Tidak perlu dibuka" });
    expect(await status(g, 8)).toBe("LOCKED");
    await expect(confirmReopen(db, { clientId: g.client.id, requestId: id, actor: mk(b) })).rejects.toThrow(/sudah ditolak/);
  });

  it("R3 reverse order: a request for July while August is locked is refused; a waiting August request can't open August after September closes", async () => {
    const g = await makeGroup();
    const a = await addMember(g.firm.id, "ADMIN", { name: "a" });
    const b = await addMember(g.firm.id, "ADMIN", { name: "b" });
    await settings(g, { reopen: true });
    await entry(g, 7);
    await entry(g, 8);
    await lock(g, 7);
    await lock(g, 8);
    await expect(requestReopen(db, { clientId: g.client.id, year: 2026, month: 7, actor: mk(a), reason: "Koreksi Juli" })).rejects.toThrow(/Buka kembali Agustus 2026 dulu/);
    const o = await requestReopen(db, { clientId: g.client.id, year: 2026, month: 8, actor: mk(a), reason: "Koreksi Agustus" });
    await entry(g, 9);
    await lock(g, 9);
    await expect(confirmReopen(db, { clientId: g.client.id, requestId: o.opened ? "" : o.requestId, actor: mk(b) })).rejects.toThrow(/Buka kembali September 2026 dulu/);
    expect(await status(g, 8)).toBe("LOCKED");
  });

  it("R4 with the second admin disabled the reopen happens at once and says so; a direct unlock closes a waiting request", async () => {
    const g = await makeGroup();
    const a = await addMember(g.firm.id, "ADMIN", { name: "a" });
    const b = await addMember(g.firm.id, "ADMIN", { name: "b" });
    await settings(g, { reopen: true });
    await entry(g, 8);
    await lock(g, 8);
    const o = await requestReopen(db, { clientId: g.client.id, year: 2026, month: 8, actor: mk(a), reason: "Koreksi Agustus" });
    expect(o.opened).toBe(false);
    await unlockPeriod(db, g.client.id, 2026, 8, mk(b), "Langsung dibuka");
    expect((await db.reopenRequest.findFirstOrThrow()).status).toBe("WITHDRAWN");
    await lock(g, 8);
    await db.firmMember.update({ where: { id: b.id }, data: { disabled: true } });
    const f = await requestReopen(db, { clientId: g.client.id, year: 2026, month: 8, actor: mk(a), reason: "Koreksi lagi" });
    expect(f).toEqual({ opened: true, fallback: true });
    expect((await db.periodUnlockLog.findMany({ orderBy: { createdAt: "desc" } }))[0].reason).toMatch(/hanya satu admin aktif/);
  });
});

describe("close, tested hard — Jurnal berulang against locks and the chart", () => {
  beforeEach(resetDb);

  it("J1 an end before the start is refused", async () => {
    const g = await makeGroup();
    const july = await julyJournal(g);
    await expect(createRecurring(db, { clientId: g.client.id, entryId: july.id, end: { year: 2026, month: 7 } })).rejects.toThrow("Bulan terakhir paling awal Agustus 2026.");
    await expect(createRecurring(db, { clientId: g.client.id, entryId: july.id, end: { year: 2026, month: 13 } })).rejects.toThrow("Bulan terakhir tidak valid.");
  });

  it("J2 a month locked between the proposal and the click is refused and no longer proposed", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const t = await createRecurring(db, { clientId: g.client.id, entryId: (await julyJournal(g)).id });
    expect((await recurringDue(db, g.client.id, 2026, 8)).map((d) => d.month)).toEqual([8]);
    await lock(g, 7);
    await entry(g, 8);
    await lock(g, 8); // the sched: control is noted ("1 angsuran …") and August closes without it
    await expect(postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: mk(me) })).rejects.toThrow(/tidak jatuh tempo/);
    expect((await recurringDue(db, g.client.id, 2026, 9)).map((d) => d.month)).toEqual([9]);
  });

  it("J3 a waiting instalment blocks the lock; approved after its template was stopped it still posts once", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const boss = await addMember(g.firm.id, "ADMIN", { name: "boss" });
    const t = await createRecurring(db, { clientId: g.client.id, entryId: (await julyJournal(g)).id });
    await settings(g, { manual: true, manualAbove: "1.000.000" });
    const o = await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: mk(me) });
    expect(o.posted).toBe(false);
    await lock(g, 7);
    await ready(g, 8);
    await expect(lockPeriod(db, g.client.id, 2026, 8, "uji")).rejects.toThrow(/1 jurnal menunggu/);
    await stopRecurring(db, { clientId: g.client.id, recurringId: t.id });
    await approveJournal(db, { clientId: g.client.id, approvalId: o.posted ? "" : o.approvalId, approver: mk(boss) });
    expect(await db.journalEntry.count({ where: { recurringId: t.id, recurringMonth: 202608 } })).toBe(1);
    // The firm board's Persetujuan cell no longer counts it.
    expect((await approvalCounts(db, { clientId: g.client.id, year: 2026, month: 8 })).second).toBe(0);
  });

  it("J4 archiving an account a running template posts to is refused (as for a running schedule)", async () => {
    const g = await makeGroup();
    const t = await createRecurring(db, { clientId: g.client.id, entryId: (await julyJournal(g, "6160")).id });
    await lock(g, 7); // 6160's only line is in a closed month; it's an expense (no balance check)
    const id = await acc(g, "6160");
    // The template still proposes August on 6160: archiving it would leave an instalment that can never post.
    await expect(archiveAccount(db, { clientId: g.client.id, accountId: id })).rejects.toThrow(/jurnal berulang|masih dipakai/);
    expect((await recurringDue(db, g.client.id, 2026, 8)).map((d) => d.template.id)).toEqual([t.id]);
  });

  it("J5 Catat semua stops at the first refusal and keeps what posted before it", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const a = await createRecurring(db, { clientId: g.client.id, entryId: (await julyJournal(g, "6120")).id });
    const b = await createRecurring(db, { clientId: g.client.id, entryId: (await julyJournal(g, "6190")).id });
    // Template b's August instalment is refused: its account was archived directly (the archive guard is probed in J4).
    await db.account.update({ where: { id: await acc(g, "6190") }, data: { archivedAt: new Date() } });
    await expect(postAllRecurring(db, { clientId: g.client.id, year: 2026, month: 8, maker: mk(me) })).rejects.toThrow(/diarsipkan/);
    expect(await db.journalEntry.count({ where: { recurringId: a.id } })).toBe(1);
    expect(await db.journalEntry.count({ where: { recurringId: b.id } })).toBe(0);
  });

  it("J6 a stop racing a click: either the instalment posts before the stop or it is refused, never after it", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const t = await createRecurring(db, { clientId: g.client.id, entryId: (await julyJournal(g)).id });
    const [post] = await Promise.allSettled([
      postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: mk(me) }),
      stopRecurring(db, { clientId: g.client.id, recurringId: t.id }),
    ]);
    const stopped = await db.recurringJournal.findUniqueOrThrow({ where: { id: t.id } });
    const e = await db.journalEntry.findFirst({ where: { recurringId: t.id } });
    expect(stopped.stoppedAt).not.toBeNull();
    if (post.status === "fulfilled") expect(+e!.createdAt).toBeLessThanOrEqual(+stopped.stoppedAt! + 1000);
    else expect(e).toBeNull();
  });
});
