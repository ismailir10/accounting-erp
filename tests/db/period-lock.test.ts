import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";

import { postJournal } from "@/lib/ledger/post";
import { CLOSE_SIGNOFFS, CloseError, lockPeriod, runControls, unlockPeriod } from "@/lib/controls";
import { deleteClient } from "@/lib/clients/delete";
import { dateOnly } from "@/lib/format";
import { saveApprovals } from "@/lib/settings/approvals";
import { approveJournal, rejectJournal, submitAdjustment, withdrawJournal } from "@/lib/approvals/journals";
import { closeHistoryMonth, historyPreview } from "@/lib/controls/history";

const auth = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({ authConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getClaims: async () => ({ data: auth.userId ? { claims: { sub: auth.userId } } : null }) } }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const { ackControlAction, unlockAction } = await import("@/app/actions");

type G = Awaited<ReturnType<typeof makeGroup>>;
const member = (g: G, role: "ADMIN" | "AKUNTAN", name: string) => db.firmMember.create({ data: { firmId: g.firm.id, userId: randomUUID(), email: `${name}@example.test`, name, role } });

/** One balanced entry in the month (so it "has data"). */
async function entry(g: G, month: number, kind: "ADJUSTMENT" | "OPENING" = "ADJUSTMENT", day = 10) {
  const id = async (code: string) => (await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code } })).id;
  return db.$transaction(async (tx) =>
    postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, month, day), kind, memo: `Uji ${month}`, lines: [{ accountId: await id("1120"), debit: 1000n }, { accountId: await id("4100"), credit: 1000n }] }),
  );
}
/** Sign-offs ticked and every Perlu dicek control noted: what the accountant does before Tutup buku. */
async function ready(g: G, month: number) {
  const period = await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month } }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month }, update: {} });
  for (const s of CLOSE_SIGNOFFS) await db.closeSignoff.upsert({ where: { periodId_key: { periodId: period.id, key: s.key } }, create: { periodId: period.id, key: s.key }, update: {} });
  for (const c of await runControls(db, g.client.id, 2026, month)) {
    if (c.status === "REVIEW") await db.controlAck.upsert({ where: { periodId_controlKey: { periodId: period.id, controlKey: c.key } }, create: { periodId: period.id, controlKey: c.key, note: "Wajar untuk uji" }, update: {} });
  }
}
const lock = async (g: G, month: number) => {
  await ready(g, month);
  return lockPeriod(db, g.client.id, 2026, month, "uji");
};
const status = async (g: G, month: number) => (await db.period.findUniqueOrThrow({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month } } })).status;

describe("period lock order", () => {
  beforeEach(resetDb);

  it("refuses to lock a month while an earlier month with data is open, and names it", async () => {
    const g = await makeGroup();
    await entry(g, 7);
    await entry(g, 8);
    await ready(g, 8);
    await expect(lockPeriod(db, g.client.id, 2026, 8, "uji")).rejects.toThrow(new CloseError("Tutup buku Juli 2026 dulu: bulan sebelumnya yang berisi transaksi harus ditutup lebih dulu."));
    expect(await status(g, 8)).toBe("OPEN");
    expect((await lock(g, 7)).status).toBe("LOCKED");
    expect((await lock(g, 8)).status).toBe("LOCKED");
  });

  it("names the earliest open month, and skips empty months and a month that only holds the Saldo Awal", async () => {
    const g = await makeGroup();
    await entry(g, 1, "OPENING", 1);
    await entry(g, 5);
    await entry(g, 8);
    await expect(lockPeriod(db, g.client.id, 2026, 8, "uji")).rejects.toThrow(/Tutup buku Mei 2026 dulu/);
    await lock(g, 5);
    // Jan (Saldo Awal only) and the empty months in between never block; Aug needs May only.
    expect((await lock(g, 8)).status).toBe("LOCKED");
  });

  it("refuses to reopen a month while a later month is locked", async () => {
    const g = await makeGroup();
    const admin = await member(g, "ADMIN", "admin");
    await entry(g, 7);
    await entry(g, 8);
    await lock(g, 7);
    await lock(g, 8);
    await expect(unlockPeriod(db, g.client.id, 2026, 7, admin, "Koreksi faktur")).rejects.toThrow(new CloseError("Buka kembali Agustus 2026 dulu: bulan setelahnya masih ditutup."));
    expect(await status(g, 7)).toBe("LOCKED");
    expect(await db.periodUnlockLog.count()).toBe(0);
    await unlockPeriod(db, g.client.id, 2026, 8, admin, "Koreksi faktur");
    await unlockPeriod(db, g.client.id, 2026, 7, admin, "Koreksi faktur");
    expect([await status(g, 7), await status(g, 8)]).toEqual(["OPEN", "OPEN"]);
  });
});

describe("unlock: admin only, reasoned, logged", () => {
  beforeEach(resetDb);

  it("refuses an akuntan and leaves the month closed with no log", async () => {
    const g = await makeGroup();
    const akuntan = await member(g, "AKUNTAN", "sari");
    await entry(g, 8);
    await lock(g, 8);
    await expect(unlockPeriod(db, g.client.id, 2026, 8, akuntan, "Koreksi faktur")).rejects.toThrow(new CloseError("Hanya admin kantor yang dapat membuka kembali periode."));
    expect(await status(g, 8)).toBe("LOCKED");
    expect(await db.periodUnlockLog.count()).toBe(0);
  });

  it("needs a real reason", async () => {
    const g = await makeGroup();
    const admin = await member(g, "ADMIN", "admin");
    await entry(g, 8);
    await lock(g, 8);
    for (const reason of ["", "   ", "ok"]) {
      await expect(unlockPeriod(db, g.client.id, 2026, 8, admin, reason)).rejects.toThrow(new CloseError("Tulis alasan membuka kembali periode (min. 5 karakter)."));
    }
    expect(await status(g, 8)).toBe("LOCKED");
    expect(await db.periodUnlockLog.count()).toBe(0);
  });

  it("reopens for an admin and writes the audit row in the same step", async () => {
    const g = await makeGroup();
    const admin = await member(g, "ADMIN", "admin");
    await entry(g, 8);
    await lock(g, 8);
    await unlockPeriod(db, g.client.id, 2026, 8, admin, "  Faktur pajak terlambat masuk  ");
    const p = await db.period.findUniqueOrThrow({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 8 } } });
    expect([p.status, p.lockedAt, p.lockedById]).toEqual(["OPEN", null, null]);
    const logs = await db.periodUnlockLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 8, unlockedById: admin.id, reason: "Faktur pajak terlambat masuk" });
    // Reopened months can be closed again; the log stays.
    await lock(g, 8);
    await unlockPeriod(db, g.client.id, 2026, 8, admin, "Salah tutup");
    expect(await db.periodUnlockLog.count()).toBe(2);
  });

  it("refuses a month that is not closed", async () => {
    const g = await makeGroup();
    const admin = await member(g, "ADMIN", "admin");
    await entry(g, 8);
    await expect(unlockPeriod(db, g.client.id, 2026, 8, admin, "Koreksi faktur")).rejects.toThrow(new CloseError("Periode Agustus 2026 belum ditutup."));
    expect(await db.periodUnlockLog.count()).toBe(0);
  });

  it("goes through the server action with the session's role", async () => {
    const g = await makeGroup();
    const admin = await member(g, "ADMIN", "admin");
    const akuntan = await member(g, "AKUNTAN", "sari");
    await entry(g, 8);
    await lock(g, 8);
    await db.clientAccess.create({ data: { memberId: akuntan.id, clientId: g.client.id } });
    auth.userId = akuntan.userId;
    expect(await unlockAction(g.client.id, 2026, 8, "Koreksi faktur")).toEqual({ ok: false, error: "Hanya admin kantor yang dapat membuka kembali periode." });
    auth.userId = admin.userId;
    expect(await unlockAction(g.client.id, 2026, 8, "")).toEqual({ ok: false, error: "Tulis alasan membuka kembali periode (min. 5 karakter)." });
    expect(await unlockAction(g.client.id, 2026, 8, "Koreksi faktur")).toEqual({ ok: true });
    expect(await status(g, 8)).toBe("OPEN");
    expect((await db.periodUnlockLog.findMany()).map((l) => [l.unlockedById, l.reason])).toEqual([[admin.id, "Koreksi faktur"]]);
  });

  it("deleting a client removes its unlock log", async () => {
    const g = await makeGroup();
    const admin = await member(g, "ADMIN", "admin");
    await entry(g, 8);
    await lock(g, 8);
    await unlockPeriod(db, g.client.id, 2026, 8, admin, "Koreksi faktur");
    await deleteClient(db, { firmId: g.firm.id, clientId: g.client.id, confirmName: "Grup Uji" });
    expect(await db.periodUnlockLog.count()).toBe(0);
    expect(await db.firmMember.count()).toBe(1);
  });
});

describe("Persetujuan kedua: a month can't be locked while a journal in it waits", () => {
  beforeEach(resetDb);
  const accrual = (g: G, memo: string, reverseNextMonth = false) => ({
    clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 7, 31), memo, reverseNextMonth,
    lines: [{ accountCode: "6190", debit: "150.000.000", credit: "" }, { accountCode: "2150", debit: "", credit: "150.000.000" }],
  });
  async function waiting(g: G, n: number, reverseNextMonth = false) {
    const a = await member(g, "ADMIN", "admin-a");
    const b = await member(g, "ADMIN", "admin-b");
    await saveApprovals(db, { firmId: g.firm.id, settings: { manual: true, manualAbove: "100.000.000", aiDraft: false, aiDraftAbove: "", reopen: false } });
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const o = await submitAdjustment(db, { ...accrual(g, `Akrual ${i}`, reverseNextMonth), maker: { id: a.id, role: "ADMIN" } });
      if (!o.posted) ids.push(o.approvalId);
    }
    return { a, b, ids };
  }

  it("refuses with the count while a journal dated in the month waits; after approval or rejection it locks", async () => {
    const g = await makeGroup();
    await entry(g, 7);
    const { b, ids } = await waiting(g, 2);
    await ready(g, 7);
    await expect(lockPeriod(db, g.client.id, 2026, 7, "uji")).rejects.toThrow(new CloseError("Belum bisa tutup buku: 2 jurnal menunggu persetujuan kedua."));
    expect(await status(g, 7)).toBe("OPEN");
    await approveJournal(db, { clientId: g.client.id, approvalId: ids[0], approver: { id: b.id, role: "ADMIN" } });
    await expect(lockPeriod(db, g.client.id, 2026, 7, "uji")).rejects.toThrow(new CloseError("Belum bisa tutup buku: 1 jurnal menunggu persetujuan kedua."));
    await rejectJournal(db, { clientId: g.client.id, approvalId: ids[1], approver: { id: b.id, role: "ADMIN" }, note: "Sudah dicatat lewat jadwal" });
    await ready(g, 7); // the approved accrual changed the month's controls
    expect((await lockPeriod(db, g.client.id, 2026, 7, "uji")).status).toBe("LOCKED");
  });

  it("refuses the next month too while a Balik otomatis journal of the month before waits (its reversal lands there)", async () => {
    const g = await makeGroup();
    const { a, ids } = await waiting(g, 1, true);
    await entry(g, 8);
    await ready(g, 8);
    await expect(lockPeriod(db, g.client.id, 2026, 8, "uji")).rejects.toThrow(new CloseError("Belum bisa tutup buku: 1 jurnal menunggu persetujuan kedua."));
    await withdrawJournal(db, { clientId: g.client.id, approvalId: ids[0], maker: { id: a.id, role: "ADMIN" } });
    expect((await lockPeriod(db, g.client.id, 2026, 8, "uji")).status).toBe("LOCKED");
  });

  it("Tutup bulan-bulan sebelumnya goes through the same lock, so it stops at the month with a waiting journal", async () => {
    const g = await makeGroup();
    await entry(g, 7);
    await waiting(g, 1);
    await ready(g, 7);
    const admin = await member(g, "ADMIN", "batch");
    const preview = await historyPreview(db, g.client.id, { year: 2026, month: 8 });
    await expect(closeHistoryMonth(db, { clientId: g.client.id, until: { year: 2026, month: 8 }, month: { year: 2026, month: 7 }, note: "Wajar untuk uji", fingerprint: preview.months.find((x) => x.month === 7)!.fingerprint, actor: admin })).rejects.toThrow("Belum bisa tutup buku: 1 jurnal menunggu persetujuan kedua.");
    expect(await status(g, 7)).toBe("OPEN");
  });
});

describe("close notes answer the control as it read", () => {
  beforeEach(resetDb);
  const periodOf = (g: G, month: number) => db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month } }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month }, update: {} });

  it("a note clears the control only while its detail is unchanged; older notes without a detail keep working", async () => {
    const g = await makeGroup();
    await entry(g, 8);
    const review = (await runControls(db, g.client.id, 2026, 8)).filter((c) => c.status === "REVIEW");
    expect(review.length).toBeGreaterThanOrEqual(3);
    const [same, changed, legacy] = review;
    const period = await periodOf(g, 8);
    await db.controlAck.createMany({ data: [
      { periodId: period.id, controlKey: same.key, note: "Sudah dicek", detail: same.detail },
      { periodId: period.id, controlKey: changed.key, note: "Dua transaksi, wajar", detail: "2 transaksi menunggu review" },
      { periodId: period.id, controlKey: legacy.key, note: "Catatan lama" },
    ] });
    const now = new Map((await runControls(db, g.client.id, 2026, 8)).map((c) => [c.key, c]));
    expect([now.get(same.key)!.ack, now.get(same.key)!.staleAck]).toEqual(["Sudah dicek", undefined]);
    expect([now.get(changed.key)!.ack, now.get(changed.key)!.staleAck]).toEqual([undefined, "Dua transaksi, wajar"]);
    expect(now.get(legacy.key)!.ack).toBe("Catatan lama");
  });

  it("the note action stores the detail it answered", async () => {
    const g = await makeGroup();
    const admin = await member(g, "ADMIN", "admin");
    await entry(g, 8);
    auth.userId = admin.userId;
    const c = (await runControls(db, g.client.id, 2026, 8)).find((x) => x.status === "REVIEW")!;
    expect(await ackControlAction(g.client.id, 2026, 8, c.key, "Wajar, dicek")).toEqual({ ok: true });
    expect(await db.controlAck.findFirstOrThrow({ where: { controlKey: c.key } })).toMatchObject({ note: "Wajar, dicek", detail: c.detail, ackedById: admin.id });
  });

  it("reopening a month removes its sign-offs, so closing again needs them given again", async () => {
    const g = await makeGroup();
    const admin = await member(g, "ADMIN", "admin");
    await entry(g, 8);
    await lock(g, 8);
    await unlockPeriod(db, g.client.id, 2026, 8, admin, "Faktur susulan");
    expect(await db.closeSignoff.count({ where: { period: { clientId: g.client.id, month: 8 } } })).toBe(0);
    await expect(lockPeriod(db, g.client.id, 2026, 8, "uji")).rejects.toThrow(/3 checklist belum dicentang/);
  });
});
