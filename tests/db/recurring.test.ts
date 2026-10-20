import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";
import { dateOnly } from "@/lib/format";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { listEvents } from "@/lib/audit";
import { createRecurring, instalmentDate, recurringDue, recurringViews, stopRecurring } from "@/lib/adjust/recurring";
import { postAllRecurring, postRecurring } from "@/lib/adjust/recurring-post";
import { proposalViews } from "@/lib/adjust/view";
import { approveJournal, rejectJournal, type Maker } from "@/lib/approvals/journals";
import { saveApprovals } from "@/lib/settings/approvals";
import { runControls } from "@/lib/controls";
import { deleteClient } from "@/lib/clients/delete";

/** Jurnal berulang (cycle 2026-10-21-jurnal-berulang): a posted Jurnal Penyesuaian repeated monthly, each month posted by a click, once. */
type G = Awaited<ReturnType<typeof makeGroup>>;
const maker = (m: { id: string; role: Maker["role"] }): Maker => ({ id: m.id, role: m.role });
const lock = (g: G, year: number, month: number) =>
  db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year, month } }, create: { firmId: g.firm.id, clientId: g.client.id, year, month, status: "LOCKED" }, update: { status: "LOCKED" } });

/** A three-line July journal: rent and service charge accrued to one payable, each line with its note. */
async function julyRent(g: G, actorId: string, opts: { reverse?: boolean; day?: number } = {}) {
  return postAdjustment(db, {
    clientId: g.client.id,
    entityId: g.pt.entity.id,
    date: dateOnly(2026, 7, opts.day ?? 31),
    memo: "Akrual sewa kantor",
    reverseNextMonth: opts.reverse,
    actorId,
    lines: [
      { accountCode: "6120", debit: "15.000.000", credit: "", memo: "Sewa ruko" },
      { accountCode: "6190", debit: "2.500.000", credit: "", memo: "Service charge" },
      { accountCode: "2150", debit: "", credit: "17.500.000", memo: "Utang sewa" },
    ],
  });
}

const entryLines = async (entryId: string) =>
  (await db.journalLine.findMany({ where: { entryId }, include: { account: true }, orderBy: [{ debit: "desc" }, { credit: "desc" }] })).map((l) => [l.account.code, l.debit, l.credit, l.memo]);

describe("Jurnal berulang", () => {
  beforeEach(resetDb);

  it("repeats a three-line July journal from August on the same day with the same lines and notes, posted once per month", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const july = await julyRent(g, me.id);
    const t = await createRecurring(db, { clientId: g.client.id, entryId: july.id, actorId: me.id });
    expect([t.day, t.startYear, t.startMonth, t.endYear, t.reverseNextMonth]).toEqual([0, 2026, 8, null, false]);
    // Nothing for July (the original's month) and nothing posts by itself.
    expect(await recurringDue(db, g.client.id, 2026, 7)).toEqual([]);
    const [aug] = await recurringDue(db, g.client.id, 2026, 8);
    expect([+aug.date, aug.amount, aug.waitingId]).toEqual([+dateOnly(2026, 8, 31), 17_500_000n, null]);
    expect(await db.journalEntry.count({ where: { recurringId: t.id } })).toBe(0);

    // Shown with the schedules in Jurnal terjadwal (and Kotak persetujuan, which reads the same list).
    const [view] = await proposalViews(db, g.client.id, 2026, 8);
    expect(view).toMatchObject({ recurring: true, scheduleId: t.id, k: 202608, memo: "Akrual sewa kantor (Agustus 2026)", debit: "6120 +1", credit: "2150", amount: "17500000", date: "2026-08-31" });

    const o = await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: maker(me) });
    expect(o.posted).toBe(true);
    const entry = await db.journalEntry.findUniqueOrThrow({ where: { id: o.posted ? o.entryId : "" } });
    expect([entry.kind, entry.memo, +entry.date, entry.recurringMonth, entry.number]).toEqual(["ADJUSTMENT", "Akrual sewa kantor", +dateOnly(2026, 8, 31), 202608, "JP-2608-0001"]);
    expect(await entryLines(entry.id)).toEqual(await entryLines(july.id));
    // A second click, or two tabs at once, post once.
    await expect(postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: maker(me) })).rejects.toThrow("Akrual sewa kantor Agustus 2026 sudah dicatat.");
    const both = await Promise.allSettled([9, 9].map(() => postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 9, maker: maker(me) })));
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.journalEntry.count({ where: { recurringId: t.id } })).toBe(2);
    // September's day: the template keeps "the month's last day" (30 September, not 31).
    expect(+instalmentDate(t, 2026, 9)).toBe(+dateOnly(2026, 9, 30));

    const events = await listEvents(db, g.client.id, { kind: "RECURRING" });
    expect(events.map((e) => e.summary)).toEqual([
      "Akrual sewa kantor September 2026 dicatat sebagai JP-2609-0001 (30 Sep 2026)",
      "Akrual sewa kantor Agustus 2026 dicatat sebagai JP-2608-0001 (31 Agu 2026)",
      "Jurnal berulang dibuat dari JP-2607-0001 · Akrual sewa kantor: akhir bulan, mulai Agustus 2026",
    ]);
  });

  it("a day before the month's end stays that day, and a shorter month takes its last day", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const t = await createRecurring(db, { clientId: g.client.id, entryId: (await julyRent(g, me.id, { day: 30 })).id });
    expect(t.day).toBe(30);
    expect([+instalmentDate(t, 2026, 8), +instalmentDate(t, 2027, 2)]).toEqual([+dateOnly(2026, 8, 30), +dateOnly(2027, 2, 28)]);
  });

  it("with Balik otomatis each instalment posts with its reversal on the 1st of the next month", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const t = await createRecurring(db, { clientId: g.client.id, entryId: (await julyRent(g, me.id, { reverse: true })).id });
    expect(t.reverseNextMonth).toBe(true);
    const o = await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: maker(me) });
    const entry = await db.journalEntry.findUniqueOrThrow({ where: { id: o.posted ? o.entryId : "" }, include: { reversedBy: true } });
    expect(+entry.reversedBy!.date).toBe(+dateOnly(2026, 9, 1));
    // The reversal is not an instalment: September is still due.
    expect(entry.reversedBy!.recurringId).toBeNull();
    expect((await recurringDue(db, g.client.id, 2026, 9)).map((d) => d.month)).toEqual([9]);
  });

  it("above the Jurnal manual threshold Catat waits for a second member; approval posts it, a rejection makes the month due again", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const boss = await addMember(g.firm.id, "ADMIN");
    const t = await createRecurring(db, { clientId: g.client.id, entryId: (await julyRent(g, me.id)).id });
    await saveApprovals(db, { firmId: g.firm.id, settings: { manual: true, manualAbove: "10.000.000", aiDraft: false, aiDraftAbove: "", reopen: false } });

    const asked = await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: maker(me) });
    expect(asked.posted).toBe(false);
    const request = await db.journalApproval.findUniqueOrThrow({ where: { id: asked.posted ? "" : asked.approvalId } });
    expect([request.recurringId, request.recurringMonth, +request.date, request.memo]).toEqual([t.id, 202608, +dateOnly(2026, 8, 31), "Akrual sewa kantor"]);
    // Waiting, not due: out of Jurnal terjadwal and the close control; a second click is refused.
    const [due] = await recurringDue(db, g.client.id, 2026, 8);
    expect(due.waitingId).toBe(request.id);
    expect(await proposalViews(db, g.client.id, 2026, 8)).toEqual([]);
    await expect(postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: maker(me) })).rejects.toThrow("sudah menunggu persetujuan");

    await rejectJournal(db, { clientId: g.client.id, approvalId: request.id, approver: maker(boss), note: "Nominal sewa naik" });
    expect((await proposalViews(db, g.client.id, 2026, 8)).map((p) => p.k)).toEqual([202608]);

    const again = await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: maker(me) });
    const entry = await approveJournal(db, { clientId: g.client.id, approvalId: again.posted ? "" : again.approvalId, approver: maker(boss) });
    expect([entry.recurringId, entry.recurringMonth, entry.postedById]).toEqual([t.id, 202608, boss.id]);
    expect(await recurringDue(db, g.client.id, 2026, 8)).toEqual([]);
  });

  it("a closed month is not proposed, an end month stops the proposals after it, and Hentikan stops them all", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const july = await julyRent(g, me.id);
    await expect(createRecurring(db, { clientId: g.client.id, entryId: july.id, end: { year: 2026, month: 7 } })).rejects.toThrow("Bulan terakhir paling awal Agustus 2026.");
    const t = await createRecurring(db, { clientId: g.client.id, entryId: july.id, end: { year: 2026, month: 11 } });
    // Overdue months stay proposed until posted; the end month is the last.
    expect((await recurringDue(db, g.client.id, 2026, 12)).map((d) => d.month)).toEqual([8, 9, 10, 11]);
    await lock(g, 2026, 7);
    await lock(g, 2026, 8);
    expect((await recurringDue(db, g.client.id, 2026, 12)).map((d) => d.month)).toEqual([9, 10, 11]);
    await expect(postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: maker(me) })).rejects.toThrow("tidak jatuh tempo");
    await expect(postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 12, maker: maker(me) })).rejects.toThrow("tidak jatuh tempo");

    await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 9, maker: maker(me) });
    await stopRecurring(db, { clientId: g.client.id, recurringId: t.id, actorId: me.id });
    expect(await recurringDue(db, g.client.id, 2026, 12)).toEqual([]);
    await expect(postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 10, maker: maker(me) })).rejects.toThrow("sudah dihentikan");
    // What was posted stays; the list says so; a stopped journal may be repeated again.
    expect(await db.journalEntry.count({ where: { recurringId: t.id } })).toBe(1);
    const [view] = await recurringViews(db, g.client.id);
    expect(view).toMatchObject({ status: "DIHENTIKAN", postedCount: 1, lastPosted: "Sep 26", lines: 3, day: "akhir bulan", span: "Agu 26 – Nov 26" });
    await expect(createRecurring(db, { clientId: g.client.id, entryId: july.id })).resolves.toBeTruthy();
    await expect(createRecurring(db, { clientId: g.client.id, entryId: july.id })).rejects.toThrow("sudah diulang tiap bulan");
  });

  it("refuses a reversal, a schedule's or a template's instalment and a foreign-currency journal", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const july = await julyRent(g, me.id, { reverse: true });
    const reversal = await db.journalEntry.findFirstOrThrow({ where: { reversesId: july.id } });
    await expect(createRecurring(db, { clientId: g.client.id, entryId: reversal.id })).rejects.toThrow("Jurnal pembalik tidak bisa diulang");
    const t = await createRecurring(db, { clientId: g.client.id, entryId: july.id });
    const o = await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: maker(me) });
    await expect(createRecurring(db, { clientId: g.client.id, entryId: o.posted ? o.entryId : "" })).rejects.toThrow("sudah angsuran jurnal berulang");
    // Another client's journal is not found.
    const other = await makeGroup();
    await expect(createRecurring(db, { clientId: other.client.id, entryId: july.id })).rejects.toThrow("Jurnal tidak ditemukan.");
  });

  it("Tutup Buku lists a due recurring instalment under the scheduled-instalments control, and Catat semua posts it", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    await createRecurring(db, { clientId: g.client.id, entryId: (await julyRent(g, me.id)).id });
    const control = (await runControls(db, g.client.id, 2026, 8)).find((c) => c.key === `sched:${g.pt.entity.id}`);
    expect(control).toMatchObject({ status: "REVIEW", detail: "1 angsuran: Akrual sewa kantor (Agustus 2026) Rp 17.500.000" });
    expect(await postAllRecurring(db, { clientId: g.client.id, year: 2026, month: 9, maker: maker(me) })).toEqual({ posted: 2, asked: 0 });
    expect((await runControls(db, g.client.id, 2026, 8)).find((c) => c.key === `sched:${g.pt.entity.id}`)).toBeUndefined();
  });

  it("a client with Jurnal berulang can still be deleted", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "OWNER");
    const t = await createRecurring(db, { clientId: g.client.id, entryId: (await julyRent(g, me.id)).id });
    await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: maker(me) });
    await deleteClient(db, { firmId: g.firm.id, clientId: g.client.id, confirmName: g.client.name });
    expect(await db.recurringJournal.count()).toBe(0);
  });
});
