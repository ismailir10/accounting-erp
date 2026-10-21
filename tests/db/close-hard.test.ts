import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";

import { postJournal } from "@/lib/ledger/post";
import { CLOSE_SIGNOFFS, lockPeriod, runControls, unlockPeriod } from "@/lib/controls";
import { dateOnly } from "@/lib/format";
import { saveApprovals } from "@/lib/settings/approvals";
import { approveJournal, rejectJournal, submitAdjustment, submitReversal, withdrawJournal, type Maker } from "@/lib/approvals/journals";
import { pendingJournalCount } from "@/lib/approvals/pending";
import { createSchedule, dueProposals, postInstallment, stopSchedule } from "@/lib/adjust/schedules";
import { approvalCounts } from "@/lib/approvals/queue";
import { closeHistoryMonth, historyPreview } from "@/lib/controls/history";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { getWorkspaceOverview } from "@/lib/workspace";
import { importStatement } from "@/lib/import/pipeline";

/**
 * The month-end close, tested hard (cycle 2026-10-21-uji-keras-pajak-impor-tutup; its failures were fixed in the same cycle): locks, order, Persetujuan kedua, schedules.
 * Periods are LOCKED through `lockPeriod` with every REVIEW control noted and the sign-offs ticked (`lock` below), never by hand.
 */
const auth = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({ authConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getClaims: async () => ({ data: auth.userId ? { claims: { sub: auth.userId } } : null }) } }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const { ackControlAction } = await import("@/app/actions");

type G = Awaited<ReturnType<typeof makeGroup>>;
const mk = (m: { id: string; role: Maker["role"] }): Maker => ({ id: m.id, role: m.role });
const acc = async (g: G, code: string) => (await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code } })).id;

/** One balanced entry (1120 / 4100) in the month. */
async function entry(g: G, month: number, amount = 1000n, day = 10, debitCode = "1120") {
  const [d, c] = [await acc(g, debitCode), await acc(g, "4100")];
  return db.$transaction((tx) =>
    postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, month, day), kind: "ADJUSTMENT", memo: `Uji ${month}`, lines: [{ accountId: d, debit: amount }, { accountId: c, credit: amount }] }),
  );
}
/** Sign-offs ticked and every Perlu dicek control noted with the detail it reads now, as the action writes it. */
async function ready(g: G, month: number) {
  const period = await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month } }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month }, update: {} });
  for (const s of CLOSE_SIGNOFFS) await db.closeSignoff.upsert({ where: { periodId_key: { periodId: period.id, key: s.key } }, create: { periodId: period.id, key: s.key }, update: {} });
  for (const c of await runControls(db, g.client.id, 2026, month)) {
    if (c.status === "REVIEW") await db.controlAck.upsert({ where: { periodId_controlKey: { periodId: period.id, controlKey: c.key } }, create: { periodId: period.id, controlKey: c.key, note: "Wajar untuk uji", detail: c.detail }, update: { note: "Wajar untuk uji", detail: c.detail } });
  }
  return period;
}
const lock = async (g: G, month: number) => {
  await ready(g, month);
  return lockPeriod(db, g.client.id, 2026, month, "uji");
};
const status = async (g: G, month: number) => (await db.period.findUnique({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month } } }))?.status ?? "NONE";
const manualAbove = (g: G, above: string) => saveApprovals(db, { firmId: g.firm.id, settings: { manual: true, manualAbove: above, aiDraft: false, aiDraftAbove: "", reopen: false } });
const adj = (g: G, maker: Maker, date: Date, amount: string, extra: { reverseNextMonth?: boolean } = {}) =>
  submitAdjustment(db, {
    clientId: g.client.id, entityId: g.pt.entity.id, date, memo: "Akrual uji", maker, ...extra,
    lines: [{ accountCode: "6120", debit: amount, credit: "" }, { accountCode: "2150", debit: "", credit: amount }],
  });

describe("close, tested hard — a waiting journal and the lock", () => {
  beforeEach(resetDb);

  it("C1 refuses to lock a month while a journal request dated in an earlier, still empty open month waits (it could never post afterwards)", async () => {
    const g = await makeGroup();
    const maker = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const boss = await addMember(g.firm.id, "ADMIN", { name: "boss" });
    await manualAbove(g, "1.000.000");
    await entry(g, 8); // August has activity; July stays empty and open
    const o = await adj(g, mk(maker), dateOnly(2026, 7, 31), "5.000.000");
    expect(o.posted).toBe(false);
    // The July request would post into July, which a closed August freezes (rule 4): an auditor expects the close of August to wait.
    // Kotak persetujuan (and the firm board's Persetujuan cell) count it in August already.
    expect((await approvalCounts(db, { clientId: g.client.id, year: 2026, month: 8 })).second).toBe(1);
    await ready(g, 8);
    const locked = await lockPeriod(db, g.client.id, 2026, 8, "uji").then((p) => p.status, (e: Error) => e.message);
    // What happens to the request once August is closed: it can never be approved (rule 4 freezes July).
    const approval = locked === "LOCKED" ? await approveJournal(db, { clientId: g.client.id, approvalId: o.posted ? "" : o.approvalId, approver: mk(boss) }).then(() => "posted", (e: Error) => e.message) : null;
    expect({ locked, approval }).toEqual({ locked: expect.stringMatching(/menunggu persetujuan kedua/), approval: null });
  });

  it("C2 a request dated in the month blocks the lock; an approval after a direct lock attempt still posts; the threshold is strict (equal posts)", async () => {
    const g = await makeGroup();
    const maker = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const boss = await addMember(g.firm.id, "ADMIN", { name: "boss" });
    await manualAbove(g, "5.000.000");
    await entry(g, 8);
    // Exactly at the threshold: posted at once.
    const equal = await adj(g, mk(maker), dateOnly(2026, 8, 31), "5.000.000");
    expect(equal.posted).toBe(true);
    // One Rupiah above: waits.
    const above = await adj(g, mk(maker), dateOnly(2026, 8, 31), "5.000.001");
    expect(above.posted).toBe(false);
    await ready(g, 8);
    await expect(lockPeriod(db, g.client.id, 2026, 8, "uji")).rejects.toThrow("Belum bisa tutup buku: 1 jurnal menunggu persetujuan kedua.");
    // The maker never approves their own, an Akuntan's journal is approved by another member.
    await expect(approveJournal(db, { clientId: g.client.id, approvalId: above.posted ? "" : above.approvalId, approver: mk(maker) })).rejects.toThrow(/anggota lain/);
    const e = await approveJournal(db, { clientId: g.client.id, approvalId: above.posted ? "" : above.approvalId, approver: mk(boss) });
    expect(e.postedById).toBe(boss.id);
    await ready(g, 8);
    expect((await lockPeriod(db, g.client.id, 2026, 8, "uji")).status).toBe("LOCKED");
  });

  it("C3 a Balik otomatis request of July blocks August's lock; rejected then resubmitted, withdrawn by the maker only", async () => {
    const g = await makeGroup();
    const maker = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const other = await addMember(g.firm.id, "AKUNTAN", { name: "other", clients: [g.client.id] });
    await manualAbove(g, "1.000.000");
    await entry(g, 7);
    await lock(g, 7).catch(() => undefined);
    // July is locked: a July request is refused at submission.
    expect(await status(g, 7)).toBe("LOCKED");
    await expect(adj(g, mk(maker), dateOnly(2026, 7, 31), "2.000.000")).rejects.toThrow(/sudah ditutup/);
    await entry(g, 8);
    const first = await adj(g, mk(maker), dateOnly(2026, 8, 31), "2.000.000", { reverseNextMonth: true });
    expect(first.posted).toBe(false);
    const id1 = first.posted ? "" : first.approvalId;
    // September has nothing; its lock counts August's Balik otomatis request (the reversal lands on 1 September).
    expect(await pendingJournalCount(db, g.client.id, 2026, 9)).toBe(1);
    await expect(rejectJournal(db, { clientId: g.client.id, approvalId: id1, approver: mk(other), note: "ok" })).rejects.toThrow(/min. 5/);
    await rejectJournal(db, { clientId: g.client.id, approvalId: id1, approver: mk(other), note: "Nominal salah" });
    await expect(approveJournal(db, { clientId: g.client.id, approvalId: id1, approver: mk(other) })).rejects.toThrow("Jurnal ini sudah ditolak.");
    const second = await adj(g, mk(maker), dateOnly(2026, 8, 31), "2.500.000", { reverseNextMonth: true });
    const id2 = second.posted ? "" : second.approvalId;
    await expect(withdrawJournal(db, { clientId: g.client.id, approvalId: id2, maker: mk(other) })).rejects.toThrow(/Hanya pembuatnya/);
    await withdrawJournal(db, { clientId: g.client.id, approvalId: id2, maker: mk(maker) });
    expect(await pendingJournalCount(db, g.client.id, 2026, 8)).toBe(0);
    expect(await db.journalEntry.count({ where: { kind: "ADJUSTMENT", memo: "Akrual uji" } })).toBe(0);
  });

  it("C4 an Akuntan never decides an Admin's journal; a Peninjau never; with one admin alone the admin's journal posts at once", async () => {
    const g = await makeGroup();
    const admin = await addMember(g.firm.id, "ADMIN", { name: "admin" });
    await manualAbove(g, "1.000.000");
    await entry(g, 8);
    // Alone (no other member at all): fallback posts.
    const alone = await adj(g, mk(admin), dateOnly(2026, 8, 31), "3.000.000");
    expect(alone).toMatchObject({ posted: true, fallback: true });
    const akuntan = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const viewer = await addMember(g.firm.id, "VIEWER", { clients: [g.client.id] });
    // An Akuntan exists but can't approve an Admin's journal: still nobody eligible, still the fallback.
    const still = await adj(g, mk(admin), dateOnly(2026, 8, 31), "3.000.000");
    expect(still).toMatchObject({ posted: true, fallback: true });
    const admin2 = await addMember(g.firm.id, "OWNER", { name: "owner" });
    const waits = await adj(g, mk(admin), dateOnly(2026, 8, 31), "3.000.000");
    expect(waits.posted).toBe(false);
    const id = waits.posted ? "" : waits.approvalId;
    await expect(approveJournal(db, { clientId: g.client.id, approvalId: id, approver: mk(akuntan) })).rejects.toThrow(/Admin atau Pemilik lain/);
    await expect(approveJournal(db, { clientId: g.client.id, approvalId: id, approver: mk(viewer) })).rejects.toThrow(/hanya dapat melihat/);
    await approveJournal(db, { clientId: g.client.id, approvalId: id, approver: mk(admin2) });
  });

  it("C5 a waiting Balik jurnal blocks the lock of its month and a second reversal of the same entry", async () => {
    const g = await makeGroup();
    const maker = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const boss = await addMember(g.firm.id, "ADMIN", { name: "boss" });
    await entry(g, 8);
    const orig = await postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 8, 5), memo: "Salah catat", lines: [{ accountCode: "6120", debit: "4.000.000", credit: "" }, { accountCode: "2150", debit: "", credit: "4.000.000" }] });
    await manualAbove(g, "1.000.000");
    const r = await submitReversal(db, { clientId: g.client.id, entryId: orig.id, date: dateOnly(2026, 8, 20), maker: mk(maker) });
    expect(r.posted).toBe(false);
    await expect(submitReversal(db, { clientId: g.client.id, entryId: orig.id, date: dateOnly(2026, 8, 21), maker: mk(maker) })).rejects.toThrow(/sudah menunggu persetujuan untuk dibalik/);
    await ready(g, 8);
    await expect(lockPeriod(db, g.client.id, 2026, 8, "uji")).rejects.toThrow(/1 jurnal menunggu/);
    await approveJournal(db, { clientId: g.client.id, approvalId: r.posted ? "" : r.approvalId, approver: mk(boss) });
    expect(await db.journalEntry.count({ where: { reversesId: orig.id } })).toBe(1);
  });
});

describe("close, tested hard — lock order, re-lock, reopen", () => {
  beforeEach(resetDb);

  it("C6 locking an already locked month is refused and keeps who closed it, when and why", async () => {
    const g = await makeGroup();
    const a = await addMember(g.firm.id, "ADMIN", { name: "a" });
    const b = await addMember(g.firm.id, "ADMIN", { name: "b" });
    await entry(g, 8);
    await ready(g, 8);
    const first = await lockPeriod(db, g.client.id, 2026, 8, "Ditutup pertama", a.id);
    await new Promise((r) => setTimeout(r, 5));
    await expect(lockPeriod(db, g.client.id, 2026, 8, "Ditutup ulang", b.id)).rejects.toThrow(/sudah ditutup/);
    const p = await db.period.findUniqueOrThrow({ where: { id: first.id } });
    expect([p.lockNote, p.lockedById, +p.lockedAt!]).toEqual(["Ditutup pertama", a.id, +first.lockedAt!]);
  });

  it("C7 a direct reopen clears the sign-offs; the month can't be closed again until they are given again", async () => {
    const g = await makeGroup();
    const admin = await addMember(g.firm.id, "ADMIN", { name: "a" });
    await entry(g, 8);
    await lock(g, 8);
    await unlockPeriod(db, g.client.id, 2026, 8, admin, "Koreksi akrual");
    expect(await db.closeSignoff.count()).toBe(0);
    await expect(lockPeriod(db, g.client.id, 2026, 8, "uji")).rejects.toThrow(/3 checklist belum dicentang/);
  });
});

describe("close, tested hard — schedules against a frozen month", () => {
  beforeEach(resetDb);

  it("C8 refuses a schedule whose only instalment falls in an empty open month before a locked month (it could never post)", async () => {
    const g = await makeGroup();
    await entry(g, 8);
    await lock(g, 8);
    // July is empty and open, but frozen by the closed August (rule 4): a July instalment can never post.
    await expect(
      createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "AMORTIZATION", memo: "Asuransi Juli", debitCode: "6120", creditCode: "1170", amount: "1.200.000", months: 1, startYear: 2026, startMonth: 7 }),
    ).rejects.toThrow(/dikunci|ditutup/);
  });

  it("C9 an instalment frozen by a later close is no longer proposed (as Jurnal berulang's), so September's sched control isn't stuck on an unpostable line", async () => {
    const g = await makeGroup();
    await entry(g, 8);
    // Made while August was open: a one-month amortisation for July (empty month).
    const s = await createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "AMORTIZATION", memo: "Asuransi Juli", debitCode: "6120", creditCode: "1170", amount: "1.200.000", months: 1, startYear: 2026, startMonth: 7 });
    await lock(g, 8); // the July instalment shows in August's sched: control; the accountant notes it and closes
    await expect(postInstallment(db, { clientId: g.client.id, scheduleId: s.id, k: 1 })).rejects.toThrow(/sudah ditutup/);
    // It can never post now: an auditor expects it gone from September's proposals (as recurringDue drops a frozen month).
    // And a stop doesn't clear it either (an instalment due through the stop month stays owed), so it is stuck for good.
    await stopSchedule(db, { clientId: g.client.id, scheduleId: s.id, at: new Date("2026-09-15T00:00:00Z") });
    expect((await dueProposals(db, g.client.id, 2026, 9)).map((p) => p.memo)).toEqual([]);
  });
});

describe("close, tested hard — control notes", () => {
  beforeEach(resetDb);

  it("C10 a note written for a control that isn't shown yet does not clear it when it appears", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    auth.userId = me.userId;
    await entry(g, 8);
    const key = `sched:${g.pt.entity.id}`;
    expect((await runControls(db, g.client.id, 2026, 8)).find((c) => c.key === key)).toBeUndefined();
    // A note on a key the page doesn't show is refused: only a control asking for one takes a note.
    expect(await ackControlAction(g.client.id, 2026, 8, key, "Sudah dicek, wajar")).toEqual({ ok: false, error: "Kontrol ini tidak sedang meminta catatan. Muat ulang halaman Tutup Buku." });
    await createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "AMORTIZATION", memo: "Sewa dibayar dimuka", debitCode: "6120", creditCode: "1170", amount: "12.000.000", months: 12, startYear: 2026, startMonth: 8 });
    const c = (await runControls(db, g.client.id, 2026, 8)).find((x) => x.key === key)!;
    expect(c.status).toBe("REVIEW");
    // The note predates the instalment: it must not clear "1 angsuran: Sewa dibayar dimuka (1/12) Rp 1.000.000".
    expect(c.ack ?? null).toBeNull();
  });
});

describe("close, tested hard — lock races", () => {
  beforeEach(resetDb);

  it("C11 a journal posting while the lock runs never ends up in the locked month unchecked", async () => {
    const g = await makeGroup();
    await entry(g, 8);
    await ready(g, 8);
    const [s, r] = [await acc(g, "1999"), await acc(g, "4100")];
    let posted!: () => void;
    const isPosted = new Promise<void>((res) => (posted = res));
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    // Another accountant's post (an unclassified line on 1999, a FAIL control) is written but not yet committed when the lock starts.
    const other = db.$transaction(
      async (tx) => {
        await postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, 8, 20), kind: "ADJUSTMENT", memo: "Belum terklasifikasi", lines: [{ accountId: s, debit: 777n }, { accountId: r, credit: 777n }] });
        posted();
        await gate;
      },
      { timeout: 20_000 },
    );
    await isPosted;
    const locking = lockPeriod(db, g.client.id, 2026, 8, "uji").then(
      (p) => p.status,
      (e: Error) => e.message,
    );
    // Let the lock run as far as it can while the post is open, then let the post commit.
    await new Promise((res) => setTimeout(res, 1500));
    release();
    const [lockResult, postResult] = await Promise.all([locking, other.then(() => "posted", (e: Error) => e.message)]);
    const inMonth = await db.journalLine.count({ where: { accountId: s, date: dateOnly(2026, 8, 20) } });
    const closed = (await status(g, 8)) === "LOCKED";
    // Never both: a locked August holding a 1999 line its controls never saw (FAIL: 1999 must be empty).
    expect({ lockResult, postResult, closedWithUncheckedLine: closed && inMonth > 0 }).toMatchObject({ closedWithUncheckedLine: false });
  });
});

describe("close, tested hard — Tutup bulan-bulan sebelumnya", () => {
  beforeEach(resetDb);

  it("C12 a run month refused by the lock leaves no sign-offs or notes signed for a close that didn't happen", async () => {
    const g = await makeGroup();
    const admin = await addMember(g.firm.id, "ADMIN", { name: "a" });
    const maker = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    await entry(g, 6);
    await entry(g, 7);
    await manualAbove(g, "1.000.000");
    const o = await adj(g, mk(maker), dateOnly(2026, 6, 30), "2.000.000");
    expect(o.posted).toBe(false);
    const preview = await historyPreview(db, g.client.id, { year: 2026, month: 8 });
    const june = preview.months.find((m) => m.month === 6)!;
    await expect(closeHistoryMonth(db, { clientId: g.client.id, until: { year: 2026, month: 8 }, month: { year: 2026, month: 6 }, note: "Tutup sejarah migrasi", fingerprint: june.fingerprint, actor: mk(admin) })).rejects.toThrow(/menunggu persetujuan/);
    const p = await db.period.findUniqueOrThrow({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 6 } } });
    expect(await db.closeSignoff.count({ where: { periodId: p.id } })).toBe(0);
  });
});

describe("close, tested hard — the firm board agrees with the lock", () => {
  beforeEach(resetDb);

  it("C13 the board never says Siap tutup buku for a month the lock refuses (a journal waiting in it)", async () => {
    const g = await makeGroup();
    const maker = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    await addMember(g.firm.id, "ADMIN", { name: "boss" });
    await entry(g, 8);
    await manualAbove(g, "1.000.000");
    const o = await adj(g, mk(maker), dateOnly(2026, 8, 31), "2.000.000");
    expect(o.posted).toBe(false);
    await ready(g, 8);
    await expect(lockPeriod(db, g.client.id, 2026, 8, "uji")).rejects.toThrow(/menunggu persetujuan kedua/);
    const board = (await getWorkspaceOverview(db, { firmId: g.firm.id, clientIds: "ALL" }, { period: "2026-08" })).clients[0];
    expect(board.state).not.toBe("READY");
  });

  it("C14 the board never says Siap tutup buku for a month whose earlier month with entries is still open", async () => {
    const g = await makeGroup();
    await entry(g, 7);
    await entry(g, 8);
    await ready(g, 8);
    await expect(lockPeriod(db, g.client.id, 2026, 8, "uji")).rejects.toThrow(/Tutup buku Juli 2026 dulu/);
    const board = (await getWorkspaceOverview(db, { firmId: g.firm.id, clientIds: "ALL" }, { period: "2026-08" })).clients[0];
    expect(board.state).not.toBe("READY");
  });
});

describe("close, tested hard — a bank statement into a month frozen by a later close", () => {
  beforeEach(resetDb);

  it("C15 a July statement after August closed is refused whole, naming August, with nothing written", async () => {
    const g = await makeGroup();
    await entry(g, 8);
    await lock(g, 8);
    const bca = g.pt.banks[0].id;
    const csv = ["Periode : 01/07/2026 - 31/07/2026", "Tanggal;Keterangan;Debet;Kredit;Saldo", "01/07/2026;SALDO AWAL;;;10000000", "15/07/2026;PLN POSTPAID;250000;0;9750000", ""].join("\n");
    const r = await importStatement(db, { bankAccountId: bca, fileName: "mutasi-juli.csv", data: Buffer.from(csv), provider: null }).then(
      () => "imported",
      (e: Error) => e.message,
    );
    expect(r).toMatch(/Agustus 2026/);
    expect([await db.bankTransaction.count(), await db.statementImport.count(), await db.journalEntry.count({ where: { kind: "BANK" } })]).toEqual([0, 0, 0]);
  });
});
