import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";
import { makePdf, table } from "../pdf-fixture";
import { listEvents } from "@/lib/audit";
import { dateOnly } from "@/lib/format";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { reverseEntry } from "@/lib/ledger/reverse";
import { trialBalance } from "@/lib/reports/ledger";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction } from "@/lib/review";
import { explainControl } from "@/lib/controls/explain";
import { MockProvider } from "@/lib/ai/provider";
import { dismissProposal, postProposal, proposalViews } from "@/lib/adjust/proposals";
import { saveApprovals, type ApprovalsInput } from "@/lib/settings/approvals";
import { approveJournal, rejectJournal, submitAdjustment, submitProposal, submitReversal, type Maker } from "@/lib/approvals/journals";
import { JOURNAL_FALLBACK, PENDING_DRAFT } from "@/lib/approvals/second";
import { pendingJournalCount } from "@/lib/approvals/pending";
import { journalRegister } from "@/lib/reports/journal-register";
import { removeStatementImport } from "@/lib/imports/remove";

const auth = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({ authConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getClaims: async () => ({ data: auth.userId ? { claims: { sub: auth.userId } } : null }) } }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const { adjustmentAction, approveJournalAction, rejectJournalAction, withdrawJournalAction, reverseEntryAction, postProposalAction, dismissProposalAction } = await import("@/app/actions");

/**
 * Persetujuan kedua (cycle 2026-10-18-persetujuan-kedua): a routed journal is a request, never an entry, until another eligible member
 * approves it; then the maker's own writer posts it through postJournal() in the same transaction as the decision.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;
const OFF: ApprovalsInput = { manual: false, manualAbove: "", aiDraft: false, aiDraftAbove: "", reopen: false };
const MANUAL_100M: ApprovalsInput = { ...OFF, manual: true, manualAbove: "100.000.000" };
const july = dateOnly(2026, 7, 31);

/** A firm with a Pemilik, an Admin and two Akuntan holding the client, an unassigned Akuntan and a Peninjau. */
async function team() {
  const g = await makeGroup();
  const m = {
    owner: await addMember(g.firm.id, "OWNER", { name: "Pak Pemilik" }),
    admin: await addMember(g.firm.id, "ADMIN", { name: "Bu Admin" }),
    akuntan: await addMember(g.firm.id, "AKUNTAN", { name: "Andi Akuntan", clients: [g.client.id] }),
    akuntan2: await addMember(g.firm.id, "AKUNTAN", { name: "Budi Akuntan", clients: [g.client.id] }),
    stranger: await addMember(g.firm.id, "AKUNTAN", { name: "Citra Lain" }),
    viewer: await addMember(g.firm.id, "VIEWER", { name: "Dewi Peninjau", clients: [g.client.id] }),
  };
  return { g, m };
}
const maker = (m: { id: string; role: Maker["role"] }): Maker => ({ id: m.id, role: m.role });
const accrual = (g: G, amount: string, extra: { reverseNextMonth?: boolean; memo?: string } = {}) => ({
  clientId: g.client.id,
  entityId: g.pt.entity.id,
  date: july,
  memo: extra.memo ?? "Akrual gaji Juli",
  reverseNextMonth: extra.reverseNextMonth,
  lines: [
    { accountCode: "6190", debit: amount, credit: "", memo: "Gaji staf" },
    { accountCode: "2150", debit: "", credit: amount, memo: "Utang gaji" },
  ],
});
const tb = (g: G) => trialBalance(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, dateOnly(2026, 12, 31));
const lines = async (entryId: string) =>
  (await db.journalLine.findMany({ where: { entryId }, include: { account: true }, orderBy: { debit: "desc" } })).map((l) => ({ code: l.account.code, debit: l.debit, credit: l.credit, memo: l.memo }));
const setCard = (g: G, s: ApprovalsInput) => saveApprovals(db, { firmId: g.firm.id, settings: s });

describe("Persetujuan kedua — defaults change nothing", () => {
  beforeEach(resetDb);

  it("with the card off, Simpan jurnal (with Balik otomatis), Balik jurnal and a draft's Catat jurnal post exactly as their writers do, and no request is written", async () => {
    const { g, m } = await team();
    const a = await submitAdjustment(db, { ...accrual(g, "250.000.000", { reverseNextMonth: true }), maker: maker(m.akuntan) });
    expect(a).toMatchObject({ posted: true, fallback: false });
    const twin = await postAdjustment(db, { ...accrual(g, "250.000.000", { reverseNextMonth: true }), actorId: m.akuntan.id });
    const [mine, theirs] = await Promise.all([db.journalEntry.findUniqueOrThrow({ where: { id: a.posted ? a.entryId : "" }, include: { reversedBy: true } }), db.journalEntry.findUniqueOrThrow({ where: { id: twin.id }, include: { reversedBy: true } })]);
    expect([mine.kind, mine.memo, +mine.date, mine.postedById, +mine.reversedBy!.date]).toEqual([theirs.kind, theirs.memo, +theirs.date, theirs.postedById, +theirs.reversedBy!.date]);
    expect(await lines(mine.id)).toEqual(await lines(theirs.id));

    const plain = await postAdjustment(db, { ...accrual(g, "300.000.000"), actorId: m.akuntan.id });
    const r = await submitReversal(db, { clientId: g.client.id, entryId: plain.id, date: dateOnly(2026, 8, 5), maker: maker(m.akuntan) });
    expect(r).toMatchObject({ posted: true });
    const twinPlain = await postAdjustment(db, { ...accrual(g, "300.000.000"), actorId: m.akuntan.id });
    const twinRev = await reverseEntry(db, { clientId: g.client.id, entryId: twinPlain.id, date: dateOnly(2026, 8, 5), actorId: m.akuntan.id });
    expect(await lines(r.posted ? r.entryId : "")).toEqual(await lines(twinRev.id));

    expect([await db.journalApproval.count(), (await listEvents(db, g.client.id, { kind: "APPROVAL" })).length]).toEqual([0, 0]);
  });

  it("through the actions, the save returns the entry as before and writes no request", async () => {
    const { g, m } = await team();
    auth.userId = m.akuntan.userId;
    const r = await adjustmentAction({ ...accrual(g, "999.000.000"), date: "2026-07-31" });
    expect(r).toMatchObject({ ok: true, pending: false, fallback: false, entryId: expect.any(String) });
    expect(await db.journalApproval.count()).toBe(0);
  });
});

describe("Persetujuan kedua — Jurnal manual above Rp 100.000.000", () => {
  beforeEach(resetDb);

  it("a Rp 150.000.000 journal waits with no entry and an unchanged trial balance; Rp 100.000.000 posts at once", async () => {
    const { g, m } = await team();
    await setCard(g, MANUAL_100M);
    const before = await tb(g);
    const entries = await db.journalEntry.count();
    const o = await submitAdjustment(db, { ...accrual(g, "150.000.000", { reverseNextMonth: true }), maker: maker(m.akuntan) });
    expect(o.posted).toBe(false);
    expect([await db.journalEntry.count(), await db.journalLine.count()]).toEqual([entries, 0]);
    expect(await tb(g)).toEqual(before);
    const a = await db.journalApproval.findUniqueOrThrow({ where: { id: o.posted ? "" : o.approvalId } });
    expect(a).toMatchObject({ status: "PENDING", source: "MANUAL", amount: 150_000_000n, threshold: 100_000_000n, makerId: m.akuntan.id, makerRole: "AKUNTAN", reverseNextMonth: true, entryId: null, memo: "Akrual gaji Juli" });
    expect(a.lines).toEqual([
      { accountCode: "6190", debit: "150000000", credit: "0", memo: "Gaji staf" },
      { accountCode: "2150", debit: "0", credit: "150000000", memo: "Utang gaji" },
    ]);
    expect((await listEvents(db, g.client.id, { kind: "APPROVAL" }))[0]).toMatchObject({ actor: "Andi Akuntan", summary: 'Jurnal manual "Akrual gaji Juli" 31 Jul 2026 · Rp 150.000.000 diajukan untuk persetujuan kedua (di atas Rp 100.000.000)' });

    const equal = await submitAdjustment(db, { ...accrual(g, "100.000.000"), maker: maker(m.akuntan) });
    expect(equal).toMatchObject({ posted: true, fallback: false });
    expect(await db.journalApproval.count()).toBe(1);
  });

  it("a request is refused at once when it could never post: unbalanced, or its month closed", async () => {
    const { g, m } = await team();
    await setCard(g, MANUAL_100M);
    const bad = accrual(g, "150.000.000");
    bad.lines[1].credit = "140.000.000";
    await expect(submitAdjustment(db, { ...bad, maker: maker(m.akuntan) })).rejects.toThrow(/Jurnal tidak seimbang/);
    await db.period.create({ data: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 8, status: "LOCKED" } });
    await expect(submitAdjustment(db, { ...accrual(g, "150.000.000", { reverseNextMonth: true }), maker: maker(m.akuntan) })).rejects.toThrow("Agustus 2026 sudah ditutup, dan jurnal bertanggal sebelumnya mengubah saldo bulan itu. Buka kembali Agustus 2026 dulu di Tutup Buku.");
    expect(await db.journalApproval.count()).toBe(0);
  });

  it("approval by another eligible member posts exactly the stored lines and notes with the reversal; postedById is the approver", async () => {
    const { g, m } = await team();
    await setCard(g, MANUAL_100M);
    const o = await submitAdjustment(db, { ...accrual(g, "150.000.000", { reverseNextMonth: true }), maker: maker(m.akuntan) });
    const id = o.posted ? "" : o.approvalId;
    const entry = await approveJournal(db, { clientId: g.client.id, approvalId: id, approver: maker(m.akuntan2) });
    expect(await lines(entry.id)).toEqual([
      { code: "6190", debit: 150_000_000n, credit: 0n, memo: "Gaji staf" },
      { code: "2150", debit: 0n, credit: 150_000_000n, memo: "Utang gaji" },
    ]);
    const posted = await db.journalEntry.findUniqueOrThrow({ where: { id: entry.id }, include: { reversedBy: true } });
    expect([posted.kind, posted.memo, posted.postedById, +posted.date]).toEqual(["ADJUSTMENT", "Akrual gaji Juli", m.akuntan2.id, +july]);
    expect([+posted.reversedBy!.date, posted.reversedBy!.postedById]).toEqual([+dateOnly(2026, 8, 1), m.akuntan2.id]);
    expect(await db.journalApproval.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "APPROVED", entryId: entry.id, decidedById: m.akuntan2.id, makerId: m.akuntan.id });
    const events = await listEvents(db, g.client.id, { kind: "APPROVAL", subject: `approval:${id}` });
    expect(events.map((e) => [e.actor, e.summary])).toEqual([
      ["Budi Akuntan", 'Jurnal manual "Akrual gaji Juli" 31 Jul 2026 · Rp 150.000.000 disetujui dan dicatat dengan jurnal pembalik 1 Agu 2026'],
      ["Andi Akuntan", 'Jurnal manual "Akrual gaji Juli" 31 Jul 2026 · Rp 150.000.000 diajukan untuk persetujuan kedua (di atas Rp 100.000.000)'],
    ]);
    // Jurnal Umum and the Buku Besar drawer name both people, on the journal and on its reversal.
    const reg = await journalRegister(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, { start: dateOnly(2026, 7, 1), end: dateOnly(2026, 8, 31), kinds: null, search: null }, "all");
    expect(reg.entries.map((e) => [e.memo.slice(0, 9), e.approval, e.postedBy])).toEqual([
      ["Akrual ga", "Diajukan Andi Akuntan · Disetujui Budi Akuntan", "Budi Akuntan"],
      ["Pembalik:", "Diajukan Andi Akuntan · Disetujui Budi Akuntan", "Budi Akuntan"],
    ]);
    // Decided once: a second click finds it approved and writes nothing.
    await expect(approveJournal(db, { clientId: g.client.id, approvalId: id, approver: maker(m.admin) })).rejects.toThrow("Jurnal ini sudah disetujui dan dicatat.");
    expect(await db.journalEntry.count({ where: { memo: "Akrual gaji Juli" } })).toBe(1);
  });

  it("refusals through the actions: self-approval (an admin too), Akuntan on an Admin's or Pemilik's journal, Peninjau, unassigned; Admin approves a Pemilik's", async () => {
    const { g, m } = await team();
    await setCard(g, MANUAL_100M);
    const ask = async (who: typeof m.akuntan, memo: string) => {
      auth.userId = who.userId;
      const r = await adjustmentAction({ ...accrual(g, "150.000.000", { memo }), date: "2026-07-31" });
      expect(r).toMatchObject({ ok: true, pending: true, entryId: null });
      return (await db.journalApproval.findFirstOrThrow({ where: { memo } })).id;
    };
    const fromAkuntan = await ask(m.akuntan, "Dari akuntan");
    const fromAdmin = await ask(m.admin, "Dari admin");
    const fromOwner = await ask(m.owner, "Dari pemilik");
    const tryAs = async (who: typeof m.akuntan, id: string) => {
      auth.userId = who.userId;
      return approveJournalAction(g.client.id, id);
    };
    expect(await tryAs(m.akuntan, fromAkuntan)).toEqual({ ok: false, error: "Anda yang mengajukan jurnal ini, jadi persetujuannya oleh anggota lain. Tarik kembali bila ingin mengubahnya." });
    expect(await tryAs(m.admin, fromAdmin)).toMatchObject({ ok: false, error: expect.stringMatching(/^Anda yang mengajukan jurnal ini/) });
    expect(await tryAs(m.akuntan, fromAdmin)).toEqual({ ok: false, error: "Jurnal ini diajukan Admin, jadi hanya Admin atau Pemilik lain yang dapat memutuskannya." });
    expect(await tryAs(m.akuntan2, fromOwner)).toEqual({ ok: false, error: "Jurnal ini diajukan Pemilik, jadi hanya Admin atau Pemilik lain yang dapat memutuskannya." });
    expect(await tryAs(m.viewer, fromAkuntan)).toEqual({ ok: false, error: "Peran Peninjau hanya dapat melihat dan mengunduh laporan." });
    expect(await tryAs(m.stranger, fromAkuntan)).toEqual({ ok: false, error: "Klien tidak ditemukan" });
    auth.userId = m.akuntan.userId;
    expect(await rejectJournalAction(g.client.id, fromAdmin, "Tidak setuju akrual ini")).toEqual({ ok: false, error: "Jurnal ini diajukan Admin, jadi hanya Admin atau Pemilik lain yang dapat memutuskannya." });
    expect([await db.journalEntry.count(), await db.journalApproval.count({ where: { status: "PENDING" } })]).toEqual([0, 3]);

    expect(await tryAs(m.admin, fromOwner)).toEqual({ ok: true });
    expect(await tryAs(m.owner, fromAdmin)).toEqual({ ok: true });
    expect(await tryAs(m.akuntan2, fromAkuntan)).toEqual({ ok: true });
    expect(await db.journalApproval.count({ where: { status: "APPROVED" } })).toBe(3);
  });

  it("Tolak needs a note of 5 characters and leaves no entry; Tarik kembali is the maker's only; decisions are once", async () => {
    const { g, m } = await team();
    await setCard(g, MANUAL_100M);
    const id = async (memo: string) => {
      const o = await submitAdjustment(db, { ...accrual(g, "150.000.000", { memo }), maker: maker(m.akuntan) });
      return o.posted ? "" : o.approvalId;
    };
    const a = await id("Akrual A");
    auth.userId = m.admin.userId;
    expect(await rejectJournalAction(g.client.id, a, "  ok ")).toEqual({ ok: false, error: "Tulis alasan menolak (min. 5 karakter)." });
    expect((await db.journalApproval.findUniqueOrThrow({ where: { id: a } })).status).toBe("PENDING");
    expect(await rejectJournalAction(g.client.id, a, "Nominal belum didukung bukti")).toEqual({ ok: true });
    expect(await db.journalApproval.findUniqueOrThrow({ where: { id: a } })).toMatchObject({ status: "REJECTED", note: "Nominal belum didukung bukti", decidedById: m.admin.id, entryId: null });
    expect((await listEvents(db, g.client.id, { subject: `approval:${a}` }))[0].summary).toBe('Jurnal manual "Akrual A" 31 Jul 2026 · Rp 150.000.000 ditolak: Nominal belum didukung bukti');
    expect(await approveJournalAction(g.client.id, a)).toEqual({ ok: false, error: "Jurnal ini sudah ditolak." });

    const b = await id("Akrual B");
    expect(await withdrawJournalAction(g.client.id, b)).toEqual({ ok: false, error: "Hanya pembuatnya yang dapat menarik kembali jurnal ini." });
    auth.userId = m.akuntan.userId;
    expect(await withdrawJournalAction(g.client.id, b)).toEqual({ ok: true });
    expect(await db.journalApproval.findUniqueOrThrow({ where: { id: b } })).toMatchObject({ status: "WITHDRAWN", decidedById: m.akuntan.id });
    expect((await listEvents(db, g.client.id, { subject: `approval:${b}` }))[0].summary).toMatch(/ditarik kembali$/);
    expect(await db.journalEntry.count()).toBe(0);
  });

  it("a double approve, or an approve racing a reject, decides once", async () => {
    const { g, m } = await team();
    await setCard(g, MANUAL_100M);
    const ask = async () => {
      const o = await submitAdjustment(db, { ...accrual(g, "150.000.000"), maker: maker(m.akuntan) });
      return o.posted ? "" : o.approvalId;
    };
    const a = await ask();
    const twice = await Promise.allSettled([approveJournal(db, { clientId: g.client.id, approvalId: a, approver: maker(m.admin) }), approveJournal(db, { clientId: g.client.id, approvalId: a, approver: maker(m.owner) })]);
    expect(twice.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.journalEntry.count()).toBe(1);

    const b = await ask();
    const race = await Promise.allSettled([approveJournal(db, { clientId: g.client.id, approvalId: b, approver: maker(m.admin) }), rejectJournal(db, { clientId: g.client.id, approvalId: b, approver: maker(m.owner), note: "Tidak perlu akrual" })]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const row = await db.journalApproval.findUniqueOrThrow({ where: { id: b } });
    expect(await db.journalEntry.count()).toBe(row.status === "APPROVED" ? 2 : 1);
    expect(["APPROVED", "REJECTED"]).toContain(row.status);
  });

  it("an approval the writer refuses (the next month closed meanwhile) stays pending with the reason, until rejected", async () => {
    const { g, m } = await team();
    await setCard(g, MANUAL_100M);
    const o = await submitAdjustment(db, { ...accrual(g, "150.000.000", { reverseNextMonth: true }), maker: maker(m.akuntan) });
    const id = o.posted ? "" : o.approvalId;
    await db.period.create({ data: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 8, status: "LOCKED" } });
    auth.userId = m.admin.userId;
    expect(await approveJournalAction(g.client.id, id)).toEqual({ ok: false, error: "Agustus 2026 sudah ditutup, dan jurnal bertanggal sebelumnya mengubah saldo bulan itu. Buka kembali Agustus 2026 dulu di Tutup Buku." });
    expect(await db.journalApproval.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "PENDING", entryId: null, decidedById: null });
    expect([await db.journalEntry.count(), (await listEvents(db, g.client.id, { subject: `approval:${id}` })).length]).toEqual([0, 1]);
    expect(await rejectJournalAction(g.client.id, id, "Agustus sudah ditutup")).toEqual({ ok: true });
  });

  it("Balik jurnal above the threshold waits; a second request for the same entry is refused while one waits; approval posts the mirror", async () => {
    const { g, m } = await team();
    const original = await postAdjustment(db, { ...accrual(g, "150.000.000"), actorId: m.akuntan.id });
    await setCard(g, MANUAL_100M);
    auth.userId = m.akuntan.userId;
    const r = await reverseEntryAction({ entryId: original.id, date: "2026-08-03" });
    expect(r).toMatchObject({ ok: true, pending: true });
    expect(await db.journalEntry.count()).toBe(1);
    const a = await db.journalApproval.findFirstOrThrow({ where: { reversesId: original.id } });
    expect(a).toMatchObject({ source: "REVERSAL", status: "PENDING", amount: 150_000_000n, memo: "Akrual gaji Juli" });
    expect(a.lines).toEqual([
      { accountCode: "6190", debit: "0", credit: "150000000", memo: "Gaji staf" },
      { accountCode: "2150", debit: "150000000", credit: "0", memo: "Utang gaji" },
    ]);
    expect(await reverseEntryAction({ entryId: original.id, date: "2026-08-04" })).toEqual({ ok: false, error: "Jurnal ini sudah menunggu persetujuan untuk dibalik. Putuskan di Kotak persetujuan." });
    // Even with the card turned off meanwhile, a direct reversal waits for the request's decision.
    await setCard(g, OFF);
    expect(await reverseEntryAction({ entryId: original.id, date: "2026-08-04" })).toMatchObject({ ok: false, error: expect.stringMatching(/^Jurnal ini sudah menunggu persetujuan/) });

    const entry = await approveJournal(db, { clientId: g.client.id, approvalId: a.id, approver: maker(m.admin) });
    const posted = await db.journalEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect([posted.reversesId, posted.postedById, +posted.date, posted.memo]).toEqual([original.id, m.admin.id, +dateOnly(2026, 8, 3), "Pembalik: Akrual gaji Juli (31 Jul 2026)"]);
  });

  it("turning the card off never posts what waits: the request is still decided in Kotak", async () => {
    const { g, m } = await team();
    await setCard(g, MANUAL_100M);
    await submitAdjustment(db, { ...accrual(g, "150.000.000"), maker: maker(m.akuntan) });
    await setCard(g, OFF);
    expect([await db.journalEntry.count(), await db.journalApproval.count({ where: { status: "PENDING" } })]).toEqual([0, 1]);
  });

  it("a company kept in another currency routes every journal of the source", async () => {
    const { g, m } = await team();
    await db.entity.update({ where: { id: g.pt.entity.id }, data: { functionalCurrency: "USD" } });
    await setCard(g, MANUAL_100M);
    const o = await submitAdjustment(db, { ...accrual(g, "10"), maker: maker(m.akuntan) });
    expect(o.posted).toBe(false);
    expect(await db.journalApproval.findFirstOrThrow()).toMatchObject({ amount: 1000n, threshold: 100_000_000n });
  });
});

describe("Persetujuan kedua — the fallback when no second person exists", () => {
  beforeEach(resetDb);

  it("the only admin's own journal posts at once and Riwayat says it went without a second approver", async () => {
    const g = await makeGroup();
    const owner = await addMember(g.firm.id, "OWNER", { name: "Satu Pemilik" });
    const akuntan = await addMember(g.firm.id, "AKUNTAN", { name: "Eka Akuntan", clients: [g.client.id] });
    await setCard(g, MANUAL_100M);
    const o = await submitAdjustment(db, { ...accrual(g, "150.000.000"), maker: maker(owner) });
    expect(o).toMatchObject({ posted: true, fallback: true });
    const entry = await db.journalEntry.findFirstOrThrow();
    expect(entry.postedById).toBe(owner.id);
    expect(await db.journalApproval.count()).toBe(0);
    expect((await listEvents(db, g.client.id, { kind: "APPROVAL", subject: `entry:${entry.id}` }))[0]).toMatchObject({
      actor: "Satu Pemilik",
      summary: `Jurnal manual "Akrual gaji Juli" 31 Jul 2026 · Rp 150.000.000 · ${JOURNAL_FALLBACK}`,
    });
    expect(JOURNAL_FALLBACK).toBe("Dicatat tanpa persetujuan kedua: tidak ada anggota lain yang berhak menyetujui");
    // An Akuntan always has an approver: the Pemilik.
    expect((await submitAdjustment(db, { ...accrual(g, "150.000.000"), maker: maker(akuntan) })).posted).toBe(false);
  });

  it("a disabled second admin doesn't count", async () => {
    const g = await makeGroup();
    const owner = await addMember(g.firm.id, "OWNER");
    const admin = await addMember(g.firm.id, "ADMIN");
    await setCard(g, MANUAL_100M);
    expect((await submitAdjustment(db, { ...accrual(g, "150.000.000", { memo: "A" }), maker: maker(owner) })).posted).toBe(false);
    await db.firmMember.update({ where: { id: admin.id }, data: { disabled: true } });
    expect(await submitAdjustment(db, { ...accrual(g, "150.000.000", { memo: "B" }), maker: maker(owner) })).toMatchObject({ posted: true, fallback: true });
  });
});

const loanStatement = makePdf([
  [
    ...table(800, [[[40, "PT Bank Mandiri (Persero) Tbk"]], [[40, "Nomor Rekening : 2222222222"]], [[40, "Periode : 01/08/2026 - 31/08/2026"]]]),
    ...table(740, [
      [[40, "Tanggal"], [130, "Keterangan"], [360, "Debit"], [440, "Kredit"], [520, "Saldo"]],
      [[40, "01/08/2026"], [130, "SALDO AWAL"], [500, "0,00"]],
      [[40, "04/08/2026"], [130, "PENCAIRAN PINJAMAN KMK"], [430, "100.000.000,00"], [510, "100.000.000,00"]],
    ]),
  ],
]);

/** A loan drawdown booked to revenue; *Jelaskan* (MockProvider, no real call) drafts its Rp 100.000.000 reclass. */
async function aiDraft() {
  const t = await team();
  const { g } = t;
  await importStatement(db, { bankAccountId: g.pt.banks[1].id, fileName: "mandiri.pdf", data: loanStatement, provider: null });
  const tx = await db.bankTransaction.findFirstOrThrow({ where: { entityId: g.pt.entity.id } });
  await reviewTransaction(db, { bankTxId: tx.id, accountCode: "4100", taxTag: null });
  const r = await explainControl(db, g.firm.id, g.client.id, 2026, 8, `pl-financing:${g.pt.entity.id}`, new MockProvider());
  await setCard(g, { ...OFF, aiDraft: true, aiDraftAbove: "50.000.000" });
  return { ...t, tx, proposalId: r.proposal!.id };
}

describe("Persetujuan kedua — Draf AI above Rp 50.000.000 (MockProvider only)", () => {
  beforeEach(resetDb);

  it("Catat jurnal waits: the draft leaves Draf jurnal, refuses a direct post or dismiss, and approval posts it through postProposal", async () => {
    const { g, m, tx, proposalId } = await aiDraft();
    auth.userId = m.akuntan.userId;
    expect(await postProposalAction(g.client.id, proposalId, ["4100", "2210"])).toEqual({ ok: true, pending: true });
    const a = await db.journalApproval.findFirstOrThrow({ where: { proposalId } });
    expect(a).toMatchObject({ source: "AI_DRAFT", status: "PENDING", amount: 100_000_000n, threshold: 50_000_000n, accounts: ["4100", "2210"], date: dateOnly(2026, 8, 31) });
    expect((await db.proposedEntry.findUniqueOrThrow({ where: { id: proposalId } })).status).toBe("PROPOSED");
    expect(await proposalViews(db, g.client.id, 2026, 8)).toEqual([]);
    expect(await postProposalAction(g.client.id, proposalId, ["4100", "2210"])).toEqual({ ok: false, error: PENDING_DRAFT });
    expect(await dismissProposalAction(g.client.id, proposalId)).toEqual({ ok: false, error: PENDING_DRAFT });
    await expect(dismissProposal(db, { clientId: g.client.id, proposalId })).rejects.toThrow(PENDING_DRAFT);
    expect((await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } })).accountCode).toBe("4100");

    const entry = await approveJournal(db, { clientId: g.client.id, approvalId: a.id, approver: maker(m.akuntan2) });
    expect(entry.kind).toBe("RECLASS");
    expect(await db.proposedEntry.findUniqueOrThrow({ where: { id: proposalId } })).toMatchObject({ status: "POSTED", entryId: entry.id, decidedById: m.akuntan2.id });
    expect(await db.journalApproval.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "APPROVED", entryId: entry.id, decidedById: m.akuntan2.id });
    expect((await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } })).accountCode).toBe("2210");
    expect((await listEvents(db, g.client.id, { subject: `approval:${a.id}` })).map((e) => e.summary)[0]).toBe('Draf AI "Reklasifikasi PENCAIRAN PINJAMAN KMK" 31 Agu 2026 · Rp 100.000.000 disetujui dan dicatat');
  });

  it("a rejection returns the draft to Draf jurnal with the note; the accountant may submit again or dismiss it", async () => {
    const { g, m, proposalId } = await aiDraft();
    const o = await submitProposal(db, { clientId: g.client.id, proposalId, maker: maker(m.akuntan) });
    await rejectJournal(db, { clientId: g.client.id, approvalId: o.posted ? "" : o.approvalId, approver: maker(m.admin), note: "Cek dulu perjanjian kreditnya" });
    const [view] = await proposalViews(db, g.client.id, 2026, 8);
    expect(view).toMatchObject({ id: proposalId, rejected: "Ditolak Bu Admin: Cek dulu perjanjian kreditnya" });
    await dismissProposal(db, { clientId: g.client.id, proposalId, actorId: m.akuntan.id });
    expect((await db.proposedEntry.findUniqueOrThrow({ where: { id: proposalId } })).status).toBe("DISMISSED");
  });

  it("a stale draft's approval is refused with the reason and stays pending", async () => {
    const { g, m, tx, proposalId } = await aiDraft();
    const o = await submitProposal(db, { clientId: g.client.id, proposalId, maker: maker(m.akuntan) });
    await reviewTransaction(db, { bankTxId: tx.id, accountCode: "4910", taxTag: null }); // the books move under the draft
    const id = o.posted ? "" : o.approvalId;
    await expect(approveJournal(db, { clientId: g.client.id, approvalId: id, approver: maker(m.admin) })).rejects.toThrow(/Buku berubah sejak draf ini dibuat|tidak lagi cocok/);
    expect(await db.journalApproval.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "PENDING", entryId: null });
    expect((await db.proposedEntry.findUniqueOrThrow({ where: { id: proposalId } })).status).toBe("PROPOSED");
  });

  it("removing the import a draft cites drops the draft and its requests, waiting or approved, instead of being blocked by them", async () => {
    const { g, m, proposalId } = await aiDraft();
    const o = await submitProposal(db, { clientId: g.client.id, proposalId, maker: maker(m.akuntan) });
    await approveJournal(db, { clientId: g.client.id, approvalId: o.posted ? "" : o.approvalId, approver: maker(m.admin) });
    const imp = await db.statementImport.findFirstOrThrow();
    await removeStatementImport(db, { clientId: g.client.id, importId: imp.id, reason: "File salah rekening", actor: maker(m.admin) });
    expect([await db.journalApproval.count(), await db.proposedEntry.count(), await db.journalEntry.count()]).toEqual([0, 0, 0]);
  });

  it("below the threshold, or with Draf AI off, Catat jurnal posts at once as before", async () => {
    const { g, m, proposalId } = await aiDraft();
    await setCard(g, { ...OFF, aiDraft: true, aiDraftAbove: "100.000.000" });
    expect(await submitProposal(db, { clientId: g.client.id, proposalId, maker: maker(m.akuntan) })).toMatchObject({ posted: true, fallback: false });
    await expect(postProposal(db, { clientId: g.client.id, proposalId })).rejects.toThrow("sudah dicatat");
    expect(await db.journalApproval.count()).toBe(0);
  });
});

describe("Persetujuan kedua — what a waiting journal counts in", () => {
  beforeEach(resetDb);

  it("a pending request is in no report; it counts against its own month and every later one (a lock freezes the months before it)", async () => {
    const { g, m } = await team();
    await setCard(g, MANUAL_100M);
    await submitAdjustment(db, { ...accrual(g, "150.000.000"), maker: maker(m.akuntan) });
    expect((await tb(g)).every((r) => r.net === 0n)).toBe(true);
    expect([await pendingJournalCount(db, g.client.id, 2026, 7), await pendingJournalCount(db, g.client.id, 2026, 8)]).toEqual([1, 1]);
    await submitAdjustment(db, { ...accrual(g, "150.000.000", { reverseNextMonth: true, memo: "Dibalik" }), maker: maker(m.akuntan) });
    expect([await pendingJournalCount(db, g.client.id, 2026, 7), await pendingJournalCount(db, g.client.id, 2026, 8), await pendingJournalCount(db, g.client.id, 2026, 9)]).toEqual([2, 2, 2]);
  });
});
