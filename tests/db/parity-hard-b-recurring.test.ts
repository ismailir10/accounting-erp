import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";
import { dateOnly } from "@/lib/format";
import { postJournal } from "@/lib/ledger/post";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { createRecurring, instalmentDate, recurringDue, stopRecurring } from "@/lib/adjust/recurring";
import { postRecurring } from "@/lib/adjust/recurring-post";
import { approveJournal, rejectJournal, submitAdjustment, withdrawJournal, type Maker } from "@/lib/approvals/journals";
import { approvalCounts } from "@/lib/approvals/queue";
import { saveApprovals } from "@/lib/settings/approvals";
import { CLOSE_SIGNOFFS, lockPeriod, runControls, unlockPeriod } from "@/lib/controls";
import { recordInventoryCount, inventoryBalance } from "@/lib/inventory";
import { archiveAccount, createAccount, removeAccount } from "@/lib/coa/manage";
import { removeEntity } from "@/lib/clients/entities";

/**
 * Round nine, probe B (cycle 2026-10-21-uji-keras-paritas): Jurnal berulang with Persetujuan kedua and the close, tested hard through
 * the real writers. Every expected figure is computed by hand in the comments first. Months are closed through `lockPeriod` with every
 * REVIEW control noted and the sign-offs ticked (`lock` below), never by writing a Period row. A test that fails names a defect.
 * J = Rp 1 juta.
 */
const J = 1_000_000n;
type G = Awaited<ReturnType<typeof makeGroup>>;
const mk = (m: { id: string; role: Maker["role"] }): Maker => ({ id: m.id, role: m.role });
const acc = async (g: G, code: string) => (await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code } })).id;
const manualAbove = (g: G, above: string) => saveApprovals(db, { firmId: g.firm.id, settings: { manual: true, manualAbove: above, aiDraft: false, aiDraftAbove: "", reopen: false } });

/** Sign-offs ticked and every Perlu dicek control noted with the detail it reads now, as the action writes it; then `lockPeriod`. */
async function lock(g: G, year: number, month: number) {
  const period = await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year, month } }, create: { firmId: g.firm.id, clientId: g.client.id, year, month }, update: {} });
  for (const s of CLOSE_SIGNOFFS) await db.closeSignoff.upsert({ where: { periodId_key: { periodId: period.id, key: s.key } }, create: { periodId: period.id, key: s.key }, update: {} });
  for (const c of await runControls(db, g.client.id, year, month)) {
    if (c.status === "REVIEW") await db.controlAck.upsert({ where: { periodId_controlKey: { periodId: period.id, controlKey: c.key } }, create: { periodId: period.id, controlKey: c.key, note: "Wajar untuk uji", detail: c.detail }, update: { note: "Wajar untuk uji", detail: c.detail } });
  }
  return lockPeriod(db, g.client.id, year, month, "uji");
}

/** Rent accrued: Dr 6120 / Cr 2150 `amount` on the date (a two-line Jurnal Penyesuaian). */
const rent = (g: G, date: Date, amount: string, opts: { reverse?: boolean; memo?: string; actorId?: string } = {}) =>
  postAdjustment(db, {
    clientId: g.client.id,
    entityId: g.pt.entity.id,
    date,
    memo: opts.memo ?? "Akrual sewa kantor",
    reverseNextMonth: opts.reverse,
    actorId: opts.actorId,
    lines: [
      { accountCode: "6120", debit: amount, credit: "" },
      { accountCode: "2150", debit: "", credit: amount },
    ],
  });
const months = async (g: G, year: number, month: number) => (await recurringDue(db, g.client.id, year, month)).map((d) => d.year * 100 + d.month);
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

describe("Jurnal berulang, tested hard — what a template may be made from", () => {
  beforeEach(resetDb);

  it("Ulangi tiap bulan refuses a stock-count (Persediaan) journal, as Balik jurnal does: it is changed on the count page", async () => {
    const g = await makeGroup();
    // July count Rp 5 juta against a book of 0: recordInventoryCount posts Dr 1160 5 J / Cr 5190 5 J, owned by the InventoryCount row.
    const count = await recordInventoryCount(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 7, amount: 5n * J });
    expect(await inventoryBalance(db, g.client.id, [g.pt.entity.id], { to: dateOnly(2026, 7, 31) })).toBe(5n * J);
    // Repeated monthly it would post Dr 1160 5 J every month with no count behind it: August's books would show 10 J of stock against a
    // count of 5 J, and the count page's "recount books only the difference" rule would be bypassed. The writer must refuse it, as
    // Balik jurnal does ("Jurnal persediaan: catat ulang hitungan di halaman Persediaan."), and as the cycle doc limits it to a typed
    // Jurnal Penyesuaian. *Terakhir dicatat* lists every ADJUSTMENT, so the button is offered on it today.
    const made = await outcome(createRecurring(db, { clientId: g.client.id, entryId: count.entryId! }));
    expect(made).toMatch(/persediaan/i);
  });

  it("refuses a foreign-currency journal, a reversal, an instalment and another client's journal; a second Ulangi at once makes one template", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    // USD 100.00 × 16.000 = Rp 1.600.000 on an FX line: its rate is typed each month.
    const fx = await db.$transaction(async (tx) =>
      postJournal(tx, {
        entityId: g.pt.entity.id, date: dateOnly(2026, 7, 15), kind: "ADJUSTMENT", memo: "Jasa konsultan USD",
        lines: [{ accountId: await acc(g, "6170"), debit: 1_600_000n, fx: { currency: "USD", amount: 10_000n, rate: "16000" } }, { accountId: await acc(g, "2150"), credit: 1_600_000n }],
      }),
    );
    await expect(createRecurring(db, { clientId: g.client.id, entryId: fx.id })).rejects.toThrow("Jurnal valas tidak bisa diulang");
    const july = await rent(g, dateOnly(2026, 7, 31), "15.000.000", { reverse: true, actorId: me.id });
    const reversal = await db.journalEntry.findFirstOrThrow({ where: { reversesId: july.id } });
    await expect(createRecurring(db, { clientId: g.client.id, entryId: reversal.id })).rejects.toThrow("Jurnal pembalik tidak bisa diulang");
    // Two clicks at once on the same journal: the close lock serialises them, one template.
    const both = await Promise.allSettled([1, 2].map(() => createRecurring(db, { clientId: g.client.id, entryId: july.id })));
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await db.recurringJournal.count({ where: { sourceEntryId: july.id } })).toBe(1);
    const t = await db.recurringJournal.findFirstOrThrow({ where: { sourceEntryId: july.id } });
    const aug = await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: mk(me) });
    await expect(createRecurring(db, { clientId: g.client.id, entryId: aug.posted ? aug.entryId : "" })).rejects.toThrow("sudah angsuran jurnal berulang");
    // The August instalment's own Balik otomatis reversal (1 Sep) is a reversal too.
    const augReversal = await db.journalEntry.findFirstOrThrow({ where: { reversesId: aug.posted ? aug.entryId : "" } });
    await expect(createRecurring(db, { clientId: g.client.id, entryId: augReversal.id })).rejects.toThrow("Jurnal pembalik tidak bisa diulang");
    // An end month before the start (start = August) is refused; the start month itself is the earliest end.
    await expect(createRecurring(db, { clientId: g.client.id, entryId: (await rent(g, dateOnly(2026, 7, 20), "1.000.000")).id, end: { year: 2026, month: 7 } })).rejects.toThrow("Bulan terakhir paling awal Agustus 2026.");
  });

  it("Ulangi again on the same journal after Hentikan starts after the months the first template already posted", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const july = await rent(g, dateOnly(2026, 7, 31), "15.000.000", { actorId: me.id });
    const first = await createRecurring(db, { clientId: g.client.id, entryId: july.id });
    for (const month of [8, 9]) await postRecurring(db, { clientId: g.client.id, recurringId: first.id, year: 2026, month, maker: mk(me) });
    await stopRecurring(db, { clientId: g.client.id, recurringId: first.id, actorId: me.id });
    // The UI offers *Ulangi* on the July journal again once the first template is stopped; the new template starts in August again.
    const second = await createRecurring(db, { clientId: g.client.id, entryId: july.id });
    // By hand: August and September rent (15 J each) are already in the books from this very journal; only October is owed.
    // Today the new template proposes all three — Tutup Buku's `sched:` asks for 45 J and *Catat semua* would book Aug–Sep rent twice.
    const owed = (await recurringDue(db, g.client.id, 2026, 10)).filter((d) => d.template.id === second.id).map((d) => d.year * 100 + d.month);
    expect(owed).toEqual([202610]);
  });

  it("a template is refused when made from a journal whose account was archived since (its instalments could never post)", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    // June rent (Dr 6120 / Cr 2150); June closed; 6120 archived (no open-month line, an expense, nothing running on it).
    const june = await rent(g, dateOnly(2026, 6, 30), "2.000.000");
    await lock(g, 2026, 6);
    await archiveAccount(db, { clientId: g.client.id, accountId: await acc(g, "6120") });
    // *Ulangi tiap bulan* on June stores a template on 6120 anyway; July is proposed (and listed by Tutup Buku) but can never post.
    // Right behaviour: refused at creation with the archive's reason, as a waiting request is checked against everything the post checks.
    const made = await outcome(createRecurring(db, { clientId: g.client.id, entryId: june.id }));
    const t = await db.recurringJournal.findFirst({ where: { sourceEntryId: june.id } });
    const posted = t ? await outcome(postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 7, maker: mk(me) })) : null;
    expect({ made, posted }).toEqual({ made: expect.stringMatching(/diarsipkan/), posted: null });
  });

  it("the template's company can't be removed (its source journal is in the books), and the instalment keeps the template's memo verbatim", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    // A memo already carrying a month: the instalment repeats it as typed (the cycle's decision); the lists add the instalment's month.
    const t = await createRecurring(db, { clientId: g.client.id, entryId: (await rent(g, dateOnly(2026, 8, 31), "2.000.000", { memo: "Sewa (Agustus 2026)", actorId: me.id })).id });
    const o = await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 9, maker: mk(me) });
    const e = await db.journalEntry.findUniqueOrThrow({ where: { id: o.posted ? o.entryId : "" } });
    expect([e.memo, +e.date]).toEqual(["Sewa (Agustus 2026)", +dateOnly(2026, 9, 30)]);
    const control = (await runControls(db, g.client.id, 2026, 10)).find((c) => c.key === `sched:${g.pt.entity.id}`);
    expect(control?.detail).toBe("1 angsuran: Sewa (Agustus 2026) (Oktober 2026) Rp 2.000.000");
    await expect(removeEntity(db, { firmId: g.firm.id, clientId: g.client.id, entityId: g.pt.entity.id })).rejects.toThrow(/Sudah ada/);
  });
});

describe("Jurnal berulang, tested hard — the calendar", () => {
  beforeEach(resetDb);

  it("leap years, 30-day months and month ends land on the right day", async () => {
    const g = await makeGroup();
    const make = async (d: Date) => createRecurring(db, { clientId: g.client.id, entryId: (await rent(g, d, "1.000")).id });
    // 30 Jan 2028 (not the month's last): day 30 → 29 Feb 2028 (leap year, shorter month takes its last day), 30 Mar, 30 Apr.
    const jan30 = await make(dateOnly(2028, 1, 30));
    expect([jan30.day, jan30.startYear, jan30.startMonth]).toEqual([30, 2028, 2]);
    expect([2, 3, 4].map((m) => instalmentDate(jan30, 2028, m).toISOString().slice(0, 10))).toEqual(["2028-02-29", "2028-03-30", "2028-04-30"]);
    // 2027 is not a leap year: 28 Feb.
    expect(instalmentDate(jan30, 2027, 2).toISOString().slice(0, 10)).toBe("2027-02-28");
    // 29 Feb 2028 is February's last day: "akhir bulan" (day 0) → 31 Mar, 30 Apr.
    const feb29 = await make(dateOnly(2028, 2, 29));
    expect([feb29.day, [3, 4].map((m) => instalmentDate(feb29, 2028, m).toISOString().slice(0, 10))]).toEqual([0, ["2028-03-31", "2028-04-30"]]);
    // 28 Feb 2028 is not the last day of a leap February: day 28 everywhere.
    const feb28 = await make(dateOnly(2028, 2, 28));
    expect([feb28.day, instalmentDate(feb28, 2028, 3).toISOString().slice(0, 10)]).toEqual([28, "2028-03-28"]);
    // 30 Mar 2026 (31-day month, not its last) → day 30: 30 Apr, 30 May.
    const mar30 = await make(dateOnly(2026, 3, 30));
    expect([mar30.day, [4, 5].map((m) => instalmentDate(mar30, 2026, m).toISOString().slice(0, 10))]).toEqual([30, ["2026-04-30", "2026-05-30"]]);
    // A December journal starts the next January.
    const dec = await make(dateOnly(2026, 12, 15));
    expect([dec.startYear, dec.startMonth, dec.day]).toEqual([2027, 1, 15]);
  });

  it("the due list: nothing before the start, overdue months through the end only, nothing after a stop", async () => {
    const g = await makeGroup();
    const t = await createRecurring(db, { clientId: g.client.id, entryId: (await rent(g, dateOnly(2026, 7, 31), "1.000.000")).id, end: { year: 2026, month: 10 } });
    expect(await months(g, 2026, 7)).toEqual([]);
    expect(await months(g, 2026, 6)).toEqual([]);
    expect(await months(g, 2026, 8)).toEqual([202608]);
    // Viewed in March 2027: Aug–Oct 2026 still owed, nothing after the end.
    expect(await months(g, 2027, 3)).toEqual([202608, 202609, 202610]);
    await expect(postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 11, maker: { id: (await addMember(g.firm.id, "AKUNTAN")).id, role: "AKUNTAN" } })).rejects.toThrow("tidak jatuh tempo");
    await stopRecurring(db, { clientId: g.client.id, recurringId: t.id });
    expect(await months(g, 2027, 3)).toEqual([]);
  });
});

describe("Jurnal berulang, tested hard — Persetujuan kedua and the close", () => {
  beforeEach(resetDb);

  it("an instalment at the threshold posts, one Rupiah above waits; two clicks above it make one request", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    await addMember(g.firm.id, "ADMIN", { name: "boss" });
    await manualAbove(g, "1.000.000");
    const at = await createRecurring(db, { clientId: g.client.id, entryId: (await rent(g, dateOnly(2026, 7, 10), "1.000.000")).id });
    const above = await createRecurring(db, { clientId: g.client.id, entryId: (await rent(g, dateOnly(2026, 7, 11), "1.000.001")).id });
    // Strictly above the threshold waits: Rp 1.000.000 posts, Rp 1.000.001 is a request.
    expect((await postRecurring(db, { clientId: g.client.id, recurringId: at.id, year: 2026, month: 8, maker: mk(me) })).posted).toBe(true);
    const clicks = await Promise.allSettled([1, 2].map(() => postRecurring(db, { clientId: g.client.id, recurringId: above.id, year: 2026, month: 8, maker: mk(me) })));
    expect(clicks.map((c) => c.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await db.journalApproval.count({ where: { recurringId: above.id, status: "PENDING" } })).toBe(1);
    expect(await db.journalEntry.count({ where: { recurringId: above.id } })).toBe(0);
  });

  it("a waiting instalment holds the close; rejected it is due again and the Kotak count equals the control's list; closed it is dropped, reopened it is back", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const boss = await addMember(g.firm.id, "ADMIN", { name: "boss" });
    const t = await createRecurring(db, { clientId: g.client.id, entryId: (await rent(g, dateOnly(2026, 7, 31), "15.000.000", { reverse: true, actorId: me.id })).id });
    expect(t.reverseNextMonth).toBe(true);
    await lock(g, 2026, 7);
    await manualAbove(g, "10.000.000");
    const asked = await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: mk(me) });
    expect(asked.posted).toBe(false);
    const requestId = asked.posted ? "" : asked.approvalId;
    // Waiting: Kotak shows it under Persetujuan kedua (1), not under Jurnal terjadwal (0); the control doesn't list it; the lock refuses.
    expect(await approvalCounts(db, { clientId: g.client.id, year: 2026, month: 8 })).toMatchObject({ second: 1, scheduled: 0 });
    expect((await runControls(db, g.client.id, 2026, 8)).find((c) => c.key === `sched:${g.pt.entity.id}`)).toBeUndefined();
    expect(await outcome(lock(g, 2026, 8))).toBe("Belum bisa tutup buku: 1 jurnal menunggu persetujuan kedua.");
    // September's lock is refused too (August, holding July's reversal of 1 Aug, must close first; the request could never post after it).
    expect(await outcome(lock(g, 2026, 9))).not.toBe("ok");

    await rejectJournal(db, { clientId: g.client.id, approvalId: requestId, approver: mk(boss), note: "Nominal belum final" });
    // Due again: Kotak's Jurnal terjadwal count = the close control's list = 1.
    const counts = await approvalCounts(db, { clientId: g.client.id, year: 2026, month: 8 });
    const control = (await runControls(db, g.client.id, 2026, 8)).find((c) => c.key === `sched:${g.pt.entity.id}`)!;
    expect([counts.second, counts.scheduled, control.detail]).toEqual([0, 1, "1 angsuran: Akrual sewa kantor (Agustus 2026) Rp 15.000.000"]);

    // Closed with a note: August's instalment is never proposed again (it could not post) — September's still is.
    await lock(g, 2026, 8);
    expect(await months(g, 2026, 9)).toEqual([202609]);
    await expect(postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: mk(me) })).rejects.toThrow("tidak jatuh tempo");
    // Reopened (admin, a reason): August is owed again and posts once, with its reversal on 1 Sep.
    await unlockPeriod(db, g.client.id, 2026, 8, { id: boss.id, role: "ADMIN" }, "Sewa Agustus belum dicatat");
    expect(await months(g, 2026, 9)).toEqual([202608, 202609]);
    const again = await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: mk(me) });
    const entry = await approveJournal(db, { clientId: g.client.id, approvalId: again.posted ? "" : again.approvalId, approver: mk(boss) });
    const reversal = await db.journalEntry.findFirstOrThrow({ where: { reversesId: entry.id } });
    expect([+entry.date, entry.recurringMonth, +reversal.date, reversal.recurringId]).toEqual([+dateOnly(2026, 8, 31), 202608, +dateOnly(2026, 9, 1), null]);
  });

  it("stopped while an instalment waits: the request is still decided and posts; nothing more is proposed", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const boss = await addMember(g.firm.id, "ADMIN", { name: "boss" });
    await manualAbove(g, "1.000.000");
    const t = await createRecurring(db, { clientId: g.client.id, entryId: (await rent(g, dateOnly(2026, 7, 31), "5.000.000")).id });
    const asked = await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: mk(me) });
    await stopRecurring(db, { clientId: g.client.id, recurringId: t.id, actorId: me.id });
    expect(await months(g, 2026, 12)).toEqual([]);
    // The stop doesn't hide the waiting request from the close: the lock of August still waits for it.
    expect(await approvalCounts(db, { clientId: g.client.id, year: 2026, month: 8 })).toMatchObject({ second: 1, scheduled: 0 });
    const entry = await approveJournal(db, { clientId: g.client.id, approvalId: asked.posted ? "" : asked.approvalId, approver: mk(boss) });
    expect([entry.recurringId, entry.recurringMonth]).toEqual([t.id, 202608]);
    await expect(postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 9, maker: mk(me) })).rejects.toThrow(/sudah dihentikan/);
  });

  it("a company kept in US dollars: its template's every instalment waits for a second member, whatever the Rupiah threshold", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    await addMember(g.firm.id, "ADMIN", { name: "boss" });
    await db.entity.update({ where: { id: g.owner.entity.id }, data: { functionalCurrency: "USD" } });
    // USD 100 a month (10.000 cents), no foreign-currency line: the company's own currency, so it may be repeated.
    const july = await postAdjustment(db, {
      clientId: g.client.id, entityId: g.owner.entity.id, date: dateOnly(2026, 7, 31), memo: "Langganan software",
      lines: [{ accountCode: "6190", debit: "100", credit: "" }, { accountCode: "2150", debit: "", credit: "100" }],
    });
    expect((await db.journalLine.findMany({ where: { entryId: july.id } })).map((l) => l.debit + l.credit)).toEqual([10_000n, 10_000n]);
    const t = await createRecurring(db, { clientId: g.client.id, entryId: july.id });
    await manualAbove(g, "1.000.000.000");
    const o = await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: mk(me) });
    expect(o.posted).toBe(false);
    const request = await db.journalApproval.findUniqueOrThrow({ where: { id: o.posted ? "" : o.approvalId } });
    expect([request.amount, request.recurringMonth]).toEqual([10_000n, 202608]);
  });

  it("withdrawn by its maker, the month is due again and a new click asks again", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    await addMember(g.firm.id, "ADMIN", { name: "boss" });
    await manualAbove(g, "1.000.000");
    const t = await createRecurring(db, { clientId: g.client.id, entryId: (await rent(g, dateOnly(2026, 7, 31), "5.000.000")).id });
    const first = await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: mk(me) });
    await withdrawJournal(db, { clientId: g.client.id, approvalId: first.posted ? "" : first.approvalId, maker: mk(me) });
    expect((await recurringDue(db, g.client.id, 2026, 8)).map((d) => [d.month, d.waitingId])).toEqual([[8, null]]);
    expect((await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: mk(me) })).posted).toBe(false);
  });

  it("a Balik otomatis template whose instalment's month sits before a closed month is not proposed and never posts there", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const t = await createRecurring(db, { clientId: g.client.id, entryId: (await rent(g, dateOnly(2026, 7, 31), "3.000.000", { reverse: true })).id });
    await lock(g, 2026, 7);
    // August holds July's reversal (1 Aug); its own instalment is left unposted and August is closed with a note: dropped.
    await lock(g, 2026, 8);
    // September stays empty and open (no August instalment, so no reversal on 1 Sep); October is closed (allowed: no earlier month with
    // entries is open). September's instalment and its reversal on 1 Oct could not post: a journal before a closed month changes its Neraca.
    await lock(g, 2026, 10);
    expect(await months(g, 2026, 11)).toEqual([202611]);
    await expect(postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 9, maker: mk(me) })).rejects.toThrow("tidak jatuh tempo");
    // November posts with its reversal on 1 Dec.
    const nov = await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 11, maker: mk(me) });
    const rev = await db.journalEntry.findFirstOrThrow({ where: { reversesId: nov.posted ? nov.entryId : "" } });
    expect(+rev.date).toBe(+dateOnly(2026, 12, 1));
  });

  it("Kotak persetujuan's Jurnal terjadwal count equals the close control's lists across two companies, overdue months included", async () => {
    const g = await makeGroup();
    // PT: rent template from July (Aug, Sep due by September). Owner: a template from August (Sep due).
    await createRecurring(db, { clientId: g.client.id, entryId: (await rent(g, dateOnly(2026, 7, 31), "1.000.000")).id });
    const own = await postAdjustment(db, {
      clientId: g.client.id, entityId: g.owner.entity.id, date: dateOnly(2026, 8, 5), memo: "Iuran BPJS pribadi",
      lines: [{ accountCode: "3300", debit: "400.000", credit: "" }, { accountCode: "2150", debit: "", credit: "400.000" }],
    });
    await createRecurring(db, { clientId: g.client.id, entryId: own.id });
    // By hand: PT 2 (Aug overdue + Sep), owner 1 (Sep) = 3.
    const counts = await approvalCounts(db, { clientId: g.client.id, year: 2026, month: 9 });
    const controls = (await runControls(db, g.client.id, 2026, 9)).filter((c) => c.key.startsWith("sched:"));
    const listed = controls.reduce((n, c) => n + Number(/^(\d+) angsuran/.exec(c.detail)![1]), 0);
    expect([counts.scheduled, listed, controls.length]).toEqual([3, 3, 2]);
  });
});

describe("Jurnal berulang, tested hard — the template's accounts later", () => {
  beforeEach(resetDb);

  it("DEFECT: an account is archived while an ended template still owes overdue months on it; the instalments then can never post", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    // July 2025 rent Rp 15 juta (Dr 6120 / Cr 2150), repeated Aug–Sep 2025. July is closed; August and September stay open and unposted.
    const t = await createRecurring(db, { clientId: g.client.id, entryId: (await rent(g, dateOnly(2025, 7, 31), "15.000.000")).id, end: { year: 2025, month: 9 } });
    await lock(g, 2025, 7);
    // Both months are still proposed (an overdue instalment stays proposed until posted, through the end month), and Tutup Buku of
    // September 2025 lists them under `sched:`.
    expect(await months(g, 2025, 9)).toEqual([202508, 202509]);
    // 6120's only line is in closed July, and an expense needs no zero balance — but the template still has to post 15 J to 6120 twice.
    // The archive check counts a template only while its end month is not before today (October 2026), so this one is ignored.
    // Right behaviour (accounting-rules 23: "An account a running Jurnal berulang ... uses can't be archived"; a template with months
    // still proposed is running): the archive is refused naming the template.
    const archived = await outcome(archiveAccount(db, { clientId: g.client.id, accountId: await acc(g, "6120") }));
    const posted = await outcome(postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2025, month: 8, maker: mk(me) }));
    expect({ archived, posted }).toEqual({ archived: expect.stringMatching(/jurnal berulang/), posted: "ok" });
  });

  it("DEFECT: an account a waiting journal names is removed (archive refuses it); a new account on the freed code then receives the approval", async () => {
    const g = await makeGroup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const boss = await addMember(g.firm.id, "ADMIN", { name: "boss" });
    await manualAbove(g, "1.000.000");
    const seminar = await createAccount(db, { clientId: g.client.id, fsLine: "BEBAN_UMUM_ADM", name: "Beban Seminar", code: "6195" });
    // Rp 5 juta seminar accrued, above the threshold: a request (no line on 6195 yet).
    const asked = await submitAdjustment(db, {
      clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 8, 20), memo: "Akrual seminar", maker: mk(me),
      lines: [{ accountCode: "6195", debit: "5.000.000", credit: "" }, { accountCode: "2150", debit: "", credit: "5.000.000" }],
    });
    expect(asked.posted).toBe(false);
    // Archiving it is refused ("1 jurnal menunggu persetujuan"); removing it, the stronger act, is not.
    await expect(archiveAccount(db, { clientId: g.client.id, accountId: seminar.id })).rejects.toThrow(/menunggu persetujuan/);
    const removal = await removeAccount(db, { clientId: g.client.id, accountId: seminar.id }).then(() => "removed", () => "refused");
    let landedOn: string | null = null;
    if (removal === "removed") {
      await createAccount(db, { clientId: g.client.id, fsLine: "BEBAN_UMUM_ADM", name: "Beban Hiburan", code: "6195" });
      const entry = await approveJournal(db, { clientId: g.client.id, approvalId: asked.posted ? "" : asked.approvalId, approver: mk(boss) });
      landedOn = (await db.journalLine.findFirstOrThrow({ where: { entryId: entry.id, debit: { gt: 0n } }, include: { account: true } })).account.name;
    }
    // Right behaviour: removal refused while a waiting journal (or a running Jurnal berulang) names the account; a seminar accrual
    // approved by the second member must never land on "Beban Hiburan".
    expect({ removal, landedOn }).toEqual({ removal: "refused", landedOn: null });
  });

  it("an account a running template uses can't be archived; a stopped template's account can", async () => {
    const g = await makeGroup();
    const t = await createRecurring(db, { clientId: g.client.id, entryId: (await rent(g, dateOnly(2026, 7, 31), "1.000.000")).id });
    await lock(g, 2026, 7);
    await expect(archiveAccount(db, { clientId: g.client.id, accountId: await acc(g, "6120") })).rejects.toThrow(/1 jurnal berulang/);
    await stopRecurring(db, { clientId: g.client.id, recurringId: t.id });
    await archiveAccount(db, { clientId: g.client.id, accountId: await acc(g, "6120") });
    expect((await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code: "6120" } })).archivedAt).not.toBeNull();
  });
});
