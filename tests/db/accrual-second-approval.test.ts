import { beforeEach, describe, expect, it } from "vitest";
import { db, resetDb } from "../helpers";
import { addMember } from "../members";
import { BERSIH, jt, NOW, qaBooks, statement, TELKOM, ANDALAS } from "../accrual-books";
import { ACCRUAL_PENDING, accrualProposals, dismissAccrual, postAccrual } from "@/lib/adjust/accruals";
import { approveJournal, rejectJournal, submitAccrual, type Maker } from "@/lib/approvals/journals";
import { approvalCounts, approvalQueue } from "@/lib/approvals/queue";
import { pendingJournalCount } from "@/lib/approvals/pending";
import { JOURNAL_FALLBACK } from "@/lib/approvals/second";
import { saveApprovals, type ApprovalsInput } from "@/lib/settings/approvals";
import { listEvents } from "@/lib/audit";
import { dateOnly } from "@/lib/format";

/**
 * Usulan akrual × Persetujuan kedua (cycle 2026-10-18-usulan-akrual, decisions while integrating): with *Jurnal manual* on, an accrual
 * card's *Setujui* follows the manual journal's route. Above the threshold it is a request (no entry) until another member approves it;
 * then the accrual and its reversal post through the accrual writer, the decision is stored and the request approved, in one
 * transaction. At or below the threshold, or with the card off, it posts at once exactly as built.
 */
type Books = Awaited<ReturnType<typeof qaBooks>>;
const OFF: ApprovalsInput = { manual: false, manualAbove: "", aiDraft: false, aiDraftAbove: "", reopen: false };
const above = (amount: string): ApprovalsInput => ({ ...OFF, manual: true, manualAbove: amount });
const maker = (m: { id: string; role: Maker["role"] }): Maker => ({ id: m.id, role: m.role });

async function setup(card: ApprovalsInput = OFF) {
  const books = await qaBooks();
  const { g } = books;
  const m = {
    owner: await addMember(g.firm.id, "OWNER", { name: "Pak Pemilik" }),
    admin: await addMember(g.firm.id, "ADMIN", { name: "Bu Admin" }),
    akuntan: await addMember(g.firm.id, "AKUNTAN", { name: "Andi Akuntan", clients: [g.client.id] }),
  };
  await saveApprovals(db, { firmId: g.firm.id, settings: card });
  const proposals = await accrualProposals(db, g.client.id, 2026, 8, { now: NOW });
  const key = (counterparty: string) => proposals.find((p) => p.counterparty === counterparty)!.key;
  return { ...books, m, key };
}
const submit = (b: Books, key: string, who: Maker, edit?: { amount?: string }) => submitAccrual(db, { firmId: b.g.firm.id, clientId: b.g.client.id, key, edit, maker: who, now: NOW });
const august = (b: Books) => ({ clientId: b.g.client.id, year: 2026, month: 8, now: NOW });
const adjustments = (b: Books) => db.journalEntry.findMany({ where: { entity: { clientId: b.g.client.id }, kind: "ADJUSTMENT" }, include: { lines: { include: { account: true }, orderBy: { debit: "desc" } } }, orderBy: { date: "asc" } });

describe("Usulan akrual follows Persetujuan kedua's Jurnal manual route", () => {
  beforeEach(resetDb);

  it("with the card off (the default), Setujui posts the accrual and its reversal at once and writes no request", async () => {
    const b = await setup();
    const o = await submit(b, b.key(BERSIH), maker(b.m.akuntan));
    expect(o).toMatchObject({ posted: true, fallback: false });
    const [entry, reversal] = await adjustments(b);
    expect([+entry.date, entry.postedById, +reversal.date, reversal.reversesId]).toEqual([+dateOnly(2026, 8, 31), b.m.akuntan.id, +dateOnly(2026, 9, 1), entry.id]);
    expect(await db.journalApproval.count()).toBe(0);
    expect(await db.proposedEntry.findUniqueOrThrow({ where: { key: b.key(BERSIH) } })).toMatchObject({ status: "POSTED", entryId: entry.id });
  });

  it("above the threshold the accountant's Setujui is a request with no entry: the card moves to Persetujuan kedua, the direct paths refuse, the month can't lock", async () => {
    const b = await setup(above("1.000.000"));
    const key = b.key(BERSIH);
    const o = await submit(b, key, maker(b.m.akuntan));
    expect(o.posted).toBe(false);
    // A request, never a ledger entry, and no decision stored yet.
    expect(await adjustments(b)).toEqual([]);
    expect(await db.proposedEntry.count()).toBe(0);
    const request = await db.journalApproval.findFirstOrThrow();
    expect(request).toMatchObject({ source: "MANUAL", status: "PENDING", accrualKey: key, reverseNextMonth: true, amount: 4_200_000n, threshold: 1_000_000n, makerId: b.m.akuntan.id, makerRole: "AKUNTAN" });
    expect(+request.date).toBe(+dateOnly(2026, 8, 31));
    expect(request.lines).toEqual([
      { accountCode: "6190", debit: "4200000", credit: "0", memo: BERSIH },
      { accountCode: "2150", debit: "0", credit: "4200000", memo: BERSIH },
    ]);

    // Kotak: under Persetujuan kedua (as *Usulan akrual*), never twice; counts = queue = the firm board's count.
    const q = await approvalQueue(db, august(b));
    expect(q.accruals.map((a) => a.counterparty)).toEqual([TELKOM, ANDALAS]);
    expect(q.second.map((s) => (s.type === "journal" ? [s.sourceLabel, s.memo, s.total, s.why] : s.type))).toEqual([["Usulan akrual", "Akrual PT BERSIH PRIMA JASA KEBERSIHAN Agu 2026", "4200000", "di atas Rp 1.000.000"]]);
    expect(q.counts).toMatchObject({ second: 1, accrual: 2 });
    expect(await approvalCounts(db, august(b))).toEqual(q.counts);
    expect((await approvalCounts(db, august(b), { reopen: false })).total).toBe(q.counts.total);

    // While it waits: no direct post, no Tolak, no second request.
    await expect(postAccrual(db, { firmId: b.g.firm.id, clientId: b.g.client.id, key, now: NOW })).rejects.toThrow(ACCRUAL_PENDING);
    await expect(dismissAccrual(db, { firmId: b.g.firm.id, clientId: b.g.client.id, key, now: NOW })).rejects.toThrow(ACCRUAL_PENDING);
    await expect(submit(b, key, maker(b.m.akuntan))).rejects.toThrow(ACCRUAL_PENDING);
    // August (the accrual) and September (its reversal) can't lock while it waits.
    expect(await pendingJournalCount(db, b.g.client.id, 2026, 8)).toBe(1);
    expect(await pendingJournalCount(db, b.g.client.id, 2026, 9)).toBe(1);
    expect(await db.journalApproval.count()).toBe(1);
  });

  it("approved by a second member, the accrual and its reversal post through the accrual writer, the decision is stored and the request approved", async () => {
    const b = await setup(above("1.000.000"));
    const key = b.key(BERSIH);
    const o = await submit(b, key, maker(b.m.akuntan));
    const approvalId = o.posted ? "" : o.approvalId;
    // Never the maker's own.
    await expect(approveJournal(db, { clientId: b.g.client.id, approvalId, approver: maker(b.m.akuntan), now: NOW })).rejects.toThrow("Anda yang mengajukan jurnal ini");
    expect(await adjustments(b)).toEqual([]);

    const entry = await approveJournal(db, { clientId: b.g.client.id, approvalId, approver: maker(b.m.admin), now: NOW });
    const [posted, reversal] = await adjustments(b);
    expect(posted.id).toBe(entry.id);
    expect([+posted.date, posted.memo, posted.postedById]).toEqual([+dateOnly(2026, 8, 31), "Akrual PT BERSIH PRIMA JASA KEBERSIHAN Agu 2026", b.m.admin.id]);
    expect(posted.lines.map((l) => [l.account.code, l.debit, l.credit, l.memo])).toEqual([
      ["6190", 4_200_000n, 0n, BERSIH],
      ["2150", 0n, 4_200_000n, BERSIH],
    ]);
    expect([+reversal.date, reversal.reversesId, reversal.postedById]).toEqual([+dateOnly(2026, 9, 1), entry.id, b.m.admin.id]);
    expect(reversal.lines.map((l) => [l.account.code, l.debit, l.credit])).toEqual([
      ["2150", 4_200_000n, 0n],
      ["6190", 0n, 4_200_000n],
    ]);
    expect(await db.proposedEntry.findUniqueOrThrow({ where: { key } })).toMatchObject({ source: "ACCRUAL", status: "POSTED", entryId: entry.id, decidedById: b.m.admin.id });
    expect(await db.journalApproval.findUniqueOrThrow({ where: { id: approvalId } })).toMatchObject({ status: "APPROVED", entryId: entry.id, decidedById: b.m.admin.id });
    expect((await listEvents(db, b.g.client.id, { kind: "APPROVAL" })).map((e) => e.summary)).toContain(
      `Jurnal manual "Akrual PT BERSIH PRIMA JASA KEBERSIHAN Agu 2026" 31 Agu 2026 · Rp 4.200.000 disetujui dan dicatat dengan jurnal pembalik 1 Sep 2026`,
    );
    // Decided once: gone from both kinds, and a second click changes nothing.
    const q = await approvalQueue(db, august(b));
    expect([q.second, q.accruals.map((a) => a.counterparty)]).toEqual([[], [TELKOM, ANDALAS]]);
    await expect(approveJournal(db, { clientId: b.g.client.id, approvalId, approver: maker(b.m.owner), now: NOW })).rejects.toThrow("Jurnal ini sudah disetujui dan dicatat.");
    expect(await adjustments(b)).toHaveLength(2);
  });

  it("at or below the threshold Setujui posts at once; Ubah's amount is what is routed", async () => {
    const b = await setup(above("7.500.000"));
    // Andalas 7.500.000 equals the threshold, Telkom 500.000 is below it: both post directly.
    expect(await submit(b, b.key(ANDALAS), maker(b.m.akuntan))).toMatchObject({ posted: true, fallback: false });
    expect(await submit(b, b.key(TELKOM), maker(b.m.akuntan))).toMatchObject({ posted: true, fallback: false });
    expect(await adjustments(b)).toHaveLength(4);
    expect(await db.journalApproval.count()).toBe(0);
    // Bersih changed to Rp 8.000.000 by Ubah: above, so it waits.
    const o = await submit(b, b.key(BERSIH), maker(b.m.akuntan), { amount: "8.000.000" });
    expect(o.posted).toBe(false);
    expect(await db.journalApproval.findFirstOrThrow()).toMatchObject({ amount: 8_000_000n, accrualKey: b.key(BERSIH) });
    expect(await adjustments(b)).toHaveLength(4);
  });

  it("a rejected request brings the card back with the reason; an approval after the payment arrived is refused and the request keeps waiting", async () => {
    const b = await setup(above("1.000.000"));
    const key = b.key(BERSIH);
    const first = await submit(b, key, maker(b.m.akuntan));
    await rejectJournal(db, { clientId: b.g.client.id, approvalId: first.posted ? "" : first.approvalId, approver: maker(b.m.admin), note: "Nominal belum pasti" });
    const back = (await approvalQueue(db, august(b))).accruals.find((a) => a.id === key)!;
    expect(back.rejected).toBe("Ditolak Bu Admin: Nominal belum pasti");
    expect(await adjustments(b)).toEqual([]);

    const again = await submit(b, key, maker(b.m.akuntan));
    const approvalId = again.posted ? "" : again.approvalId;
    // The payment arrives between the request and its approval.
    await statement(b.bca, 2026, 8, [[30, BERSIH, jt(4.2)]], 31, 30);
    await expect(approveJournal(db, { clientId: b.g.client.id, approvalId, approver: maker(b.m.admin), now: NOW })).rejects.toThrow(`Pembayaran ${BERSIH} 30 Agu 2026 sudah masuk; usulan ini tidak berlaku lagi.`);
    expect(await db.journalApproval.findUniqueOrThrow({ where: { id: approvalId } })).toMatchObject({ status: "PENDING", entryId: null });
    expect(await adjustments(b)).toEqual([]);
    expect(await db.proposedEntry.count()).toBe(0);
  });

  it("with no other member who may approve, the only admin's Setujui posts at once and Riwayat says so", async () => {
    const books = await qaBooks();
    const { g } = books;
    const owner = await addMember(g.firm.id, "OWNER", { name: "Satu Pemilik" });
    await saveApprovals(db, { firmId: g.firm.id, settings: above("1.000.000") });
    const key = (await accrualProposals(db, g.client.id, 2026, 8, { now: NOW })).find((p) => p.counterparty === BERSIH)!.key;
    const o = await submitAccrual(db, { firmId: g.firm.id, clientId: g.client.id, key, maker: maker(owner), now: NOW });
    expect(o).toMatchObject({ posted: true, fallback: true });
    expect(await db.journalApproval.count()).toBe(0);
    const entryId = o.posted ? o.entryId : "";
    expect(await db.proposedEntry.findUniqueOrThrow({ where: { key } })).toMatchObject({ status: "POSTED", entryId });
    expect((await listEvents(db, g.client.id, { kind: "APPROVAL", subject: `entry:${entryId}` }))[0]).toMatchObject({
      actor: "Satu Pemilik",
      summary: `Jurnal manual "Akrual PT BERSIH PRIMA JASA KEBERSIHAN Agu 2026" 31 Agu 2026 · Rp 4.200.000 · ${JOURNAL_FALLBACK}`,
    });
  });
});
