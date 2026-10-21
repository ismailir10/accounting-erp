import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";
import { createDimension, DimensionError, removeDimension, renameDimension, setDimensionArchived } from "@/lib/dimensions";
import { postJournal } from "@/lib/ledger/post";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { reverseEntry } from "@/lib/ledger/reverse";
import { approveJournal, submitAdjustment } from "@/lib/approvals/journals";
import { saveApprovals } from "@/lib/settings/approvals";
import { createRecurring, recurringDue } from "@/lib/adjust/recurring";
import { postRecurring } from "@/lib/adjust/recurring-post";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction, setBankTagsTx, splitTransaction } from "@/lib/review";
import { deleteClient } from "@/lib/clients/delete";
import { incomeByDimension } from "@/lib/reports/by-dimension";
import { accountLedger } from "@/lib/reports/account-ledger";
import { dateOnly } from "@/lib/format";

/**
 * Round nine, probe C (cycle 2026-10-21-uji-keras-paritas): Departemen & Proyek on journals (Balik otomatis, approvals, Jurnal berulang,
 * Balik jurnal), another client's tag through every write path, renaming, removal racing a write, and deleting a client.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;

async function setup() {
  const g = await makeGroup();
  const A = await createDimension(db, { clientId: g.client.id, kind: "DEPARTEMEN", code: "OUTLET-A", name: "Outlet A" });
  const P = await createDimension(db, { clientId: g.client.id, kind: "PROYEK", code: "PRJ-01", name: "Proyek satu" });
  return { g, A, P };
}
const input = (g: G, tags: { departmentId?: string; projectId?: string }, date = dateOnly(2026, 8, 31)) => ({
  clientId: g.client.id,
  entityId: g.pt.entity.id,
  date,
  memo: "Akrual sewa outlet",
  lines: [{ accountCode: "6120", debit: "15.000.000", credit: "", ...tags }, { accountCode: "2150", debit: "", credit: "15.000.000" }],
});
const approvalsOn = (g: G) => saveApprovals(db, { firmId: g.firm.id, settings: { manual: true, manualAbove: "", aiDraft: false, aiDraftAbove: "", reopen: false } });
const lock = (g: G, month: number) =>
  db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month } }, update: { status: "LOCKED" }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month, status: "LOCKED" } });
const rentCsv = Buffer.from(["Tanggal;Keterangan;Debet;Kredit;Saldo", "01/08/2026;SALDO AWAL;;;50.000.000,00", "03/08/2026;BAYAR SEWA OUTLET KEMANG;10.000.000,00;0,00;40.000.000,00", ""].join("\n"));

/** Waits until a statement matching `like` is waiting on a lock (another connection holds the row). */
async function blockedOn(like: string, atLeast = 1) {
  for (let i = 0; i < 400; i++) {
    const [r] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE ${`%${like}%`}`;
    if (r.n >= BigInt(atLeast)) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`nothing blocked on ${like}`);
}
const settled = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

describe("probe C: tags on journals and their lifecycle", () => {
  beforeEach(resetDb);

  it("Balik otomatis whose reversal month is closed: refused before anything is written, direct or as a request", async () => {
    const { g, A } = await setup();
    await lock(g, 9);
    // 31 Aug + reversal 1 Sep: September is closed (and August lies before it), so neither entry may post.
    await expect(postAdjustment(db, { ...input(g, { departmentId: A.id }), reverseNextMonth: true })).rejects.toThrow(/ditutup/);
    const maker = await addMember(g.firm.id, "AKUNTAN", { name: "Andi", clients: [g.client.id] });
    await addMember(g.firm.id, "AKUNTAN", { name: "Budi", clients: [g.client.id] });
    await approvalsOn(g);
    await expect(submitAdjustment(db, { ...input(g, { departmentId: A.id }), reverseNextMonth: true, maker: { id: maker.id, role: "AKUNTAN" } })).rejects.toThrow(/ditutup/);
    expect([await db.journalEntry.count(), await db.journalApproval.count()]).toEqual([0, 0]);
  });

  it("a request whose tag is archived before approval still posts with it (stored while active; archiving only stops new choices)", async () => {
    const { g, A } = await setup();
    const maker = await addMember(g.firm.id, "AKUNTAN", { name: "Andi", clients: [g.client.id] });
    const checker = await addMember(g.firm.id, "AKUNTAN", { name: "Budi", clients: [g.client.id] });
    await approvalsOn(g);
    const o = await submitAdjustment(db, { ...input(g, { departmentId: A.id }), maker: { id: maker.id, role: "AKUNTAN" } });
    if (o.posted) throw new Error("expected a request");
    await setDimensionArchived(db, { clientId: g.client.id, id: A.id, archived: true });
    // A new journal can't take it; the waiting request, stored while it was active, posts with it (a month can't close while it waits).
    await expect(postAdjustment(db, input(g, { departmentId: A.id }))).rejects.toThrow("Departemen OUTLET-A Outlet A sudah diarsipkan.");
    const e = await approveJournal(db, { clientId: g.client.id, approvalId: o.approvalId, approver: { id: checker.id, role: "AKUNTAN" } });
    expect((await db.journalLine.findFirstOrThrow({ where: { entryId: e.id, debit: { gt: 0n } } })).departmentId).toBe(A.id);
  });

  it("Jurnal berulang whose tag was archived keeps posting it, as a schedule does", async () => {
    const { g, P } = await setup();
    const me = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const july = await postAdjustment(db, { ...input(g, { projectId: P.id }, dateOnly(2026, 7, 31)), actorId: me.id });
    const t = await createRecurring(db, { clientId: g.client.id, entryId: july.id, actorId: me.id });
    await setDimensionArchived(db, { clientId: g.client.id, id: P.id, archived: true });
    const o = await postRecurring(db, { clientId: g.client.id, recurringId: t.id, year: 2026, month: 8, maker: { id: me.id, role: "AKUNTAN" } });
    expect(o.posted).toBe(true);
    expect((await db.journalLine.findFirstOrThrow({ where: { entry: { recurringId: t.id }, debit: { gt: 0n } } })).projectId).toBe(P.id);
    expect(await recurringDue(db, g.client.id, 2026, 8)).toEqual([]);
  });

  it("a tagged reversal is never reversed again; the original's reversal mirrors its tags so the column nets to zero", async () => {
    const { g, A, P } = await setup();
    const e = await postAdjustment(db, input(g, { departmentId: A.id, projectId: P.id }));
    const r = await reverseEntry(db, { clientId: g.client.id, entryId: e.id, date: dateOnly(2026, 8, 31) });
    await expect(reverseEntry(db, { clientId: g.client.id, entryId: r.id, date: dateOnly(2026, 8, 31) })).rejects.toThrow("Ini jurnal pembalik");
    const pl = await incomeByDimension(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, dateOnly(2026, 8, 1), dateOnly(2026, 8, 31), "DEPARTEMEN");
    const net = pl.rows.find((x) => x.type === "subtotal" && x.label === "Laba bersih") as { amounts: bigint[]; total: bigint };
    expect([net.amounts, net.total]).toEqual([[0n, 0n], 0n]);
  });

  it("another client's department or project is refused on every write path, and nothing is written", async () => {
    const { g, A } = await setup();
    const other = await makeGroup();
    const theirD = await createDimension(db, { clientId: other.client.id, kind: "DEPARTEMEN", code: "HQ", name: "Kantor pusat" });
    const theirP = await createDimension(db, { clientId: other.client.id, kind: "PROYEK", code: "X1", name: "Proyek lain" });
    // Jurnal Penyesuaian (prepareAdjustment → postJournal).
    await expect(postAdjustment(db, input(g, { departmentId: theirD.id }))).rejects.toThrow("Departemen tidak termasuk klien ini.");
    await expect(postAdjustment(db, input(g, { projectId: theirP.id }))).rejects.toThrow("Proyek tidak termasuk klien ini.");
    // A request (Persetujuan kedua): refused at submit, nothing stored.
    const maker = await addMember(g.firm.id, "AKUNTAN", { name: "Andi", clients: [g.client.id] });
    await addMember(g.firm.id, "AKUNTAN", { name: "Budi", clients: [g.client.id] });
    await approvalsOn(g);
    await expect(submitAdjustment(db, { ...input(g, { departmentId: theirD.id }), maker: { id: maker.id, role: "AKUNTAN" } })).rejects.toThrow("Departemen tidak termasuk klien ini.");
    expect(await db.journalApproval.count()).toBe(0);
    // Bank line: Buku Besar's drawer and Review's decision; the row keeps its own tag.
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "a.csv", data: rentCsv, provider: null });
    const t = await db.bankTransaction.findFirstOrThrow({ where: { description: { contains: "SEWA OUTLET" } } });
    await reviewTransaction(db, { bankTxId: t.id, accountCode: "6120", taxTag: null, tags: { departmentId: A.id, projectId: null } });
    const lines = await db.journalLine.count();
    await expect(db.$transaction((tx) => setBankTagsTx(tx, { bankTxId: t.id, departmentId: theirD.id, projectId: null }))).rejects.toThrow("Departemen tidak termasuk klien ini.");
    await expect(reviewTransaction(db, { bankTxId: t.id, accountCode: "6190", taxTag: null, tags: { departmentId: A.id, projectId: theirP.id } })).rejects.toThrow("Proyek tidak termasuk klien ini.");
    // Wrong kind of one's own: a project as the department.
    const P2 = await createDimension(db, { clientId: g.client.id, kind: "PROYEK", code: "P2", name: "Proyek dua" });
    await expect(reviewTransaction(db, { bankTxId: t.id, accountCode: "6120", taxTag: null, tags: { departmentId: P2.id, projectId: null } })).rejects.toThrow("Departemen tidak termasuk klien ini.");
    const row = await db.bankTransaction.findUniqueOrThrow({ where: { id: t.id } });
    expect([row.accountCode, row.departmentId, row.projectId, await db.journalLine.count()]).toEqual(["6120", A.id, null, lines]);
  });

  it("renaming keeps the code on lines and ledger; the report's column takes the new name", async () => {
    const { g, A } = await setup();
    await postAdjustment(db, input(g, { departmentId: A.id }));
    await renameDimension(db, { clientId: g.client.id, id: A.id, name: "Outlet Kemang" });
    const pl = await incomeByDimension(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, dateOnly(2026, 8, 1), dateOnly(2026, 8, 31), "DEPARTEMEN");
    expect(pl.columns.map((c) => [c.code, c.label])).toEqual([["OUTLET-A", "Outlet Kemang"], ["", "Tanpa departemen"]]);
    const a6120 = (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code: "6120" } } })).id;
    const led = await accountLedger(db, { accountId: a6120, entityIds: [g.pt.entity.id], start: dateOnly(2026, 8, 1), end: dateOnly(2026, 8, 31), normalBalance: "DEBIT", dimensionId: A.id });
    expect(led.rows.map((r) => [r.tags, r.balance])).toEqual([["OUTLET-A", "15000000"]]);
  });

  it("removing a department while a request naming it is being stored: never a stored request naming a department that no longer exists", async () => {
    const { g, A } = await setup();
    const maker = await addMember(g.firm.id, "AKUNTAN", { name: "Andi", clients: [g.client.id] });
    const checker = await addMember(g.firm.id, "AKUNTAN", { name: "Budi", clients: [g.client.id] });
    await approvalsOn(g);
    // Both race for the department's row (held elsewhere first): the removal locks it FOR UPDATE and re-checks; storing the request
    // share-locks it (lockTags). Whichever goes first, the other sees it.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Dimension" WHERE id = ${A.id} FOR UPDATE`;
      held();
      await gate;
    }, { timeout: 30_000 });
    await holding;
    const removing = settled(removeDimension(db, { clientId: g.client.id, id: A.id }));
    await blockedOn(`"Dimension" WHERE id = $1 AND "clientId"`);
    const storing = settled(submitAdjustment(db, { ...input(g, { departmentId: A.id }), maker: { id: maker.id, role: "AKUNTAN" } }));
    await blockedOn(`"Dimension" WHERE id = ANY`);
    release();
    await holder;
    const [r, o] = await Promise.all([removing, storing]);
    const exists = (await db.dimension.count({ where: { id: A.id } })) === 1;
    // Exactly one wins; the loser says why.
    expect([r.ok, o.ok].filter(Boolean).length).toBe(1);
    if (exists) {
      expect(r.ok ? "" : (r.e as Error).message).toMatch("sudah dipakai");
      const req = o.ok ? o.v : null;
      if (!req || req.posted) throw new Error("expected a request");
      const e = await approveJournal(db, { clientId: g.client.id, approvalId: req.approvalId, approver: { id: checker.id, role: "AKUNTAN" } });
      expect((await db.journalLine.findFirstOrThrow({ where: { entryId: e.id, debit: { gt: 0n } } })).departmentId).toBe(A.id);
    } else {
      expect(o.ok ? null : o.e).toBeInstanceOf(DimensionError);
      expect(await db.journalApproval.count({ where: { clientId: g.client.id } })).toBe(0);
    }
  });

  it("removing a department while a journal carrying it commits: refused with 'sudah dipakai', not a raw foreign-key error", async () => {
    const { g, A } = await setup();
    const [exp, acc] = await Promise.all(["6120", "2150"].map((code) => db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code } } })));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const poster = db.$transaction(async (tx) => {
      await postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, 8, 5), kind: "ADJUSTMENT", memo: "Sewa", lines: [{ accountId: exp.id, debit: 1_000_000n, departmentId: A.id }, { accountId: acc.id, credit: 1_000_000n }] });
      held();
      await gate;
    }, { timeout: 30_000 });
    await holding;
    const removing = settled(removeDimension(db, { clientId: g.client.id, id: A.id }));
    await blockedOn(`"Dimension" WHERE id = $1 AND "clientId"`);
    release();
    await poster;
    const r = await removing;
    expect(await db.dimension.count({ where: { id: A.id } })).toBe(1);
    expect(r.ok).toBe(false);
    // Today: PrismaClientKnownRequestError P2003 from tx.dimension.delete() (the action shows "Terjadi kesalahan tak terduga").
    expect(r.ok ? null : r.e).toBeInstanceOf(DimensionError);
    expect(r.ok ? "" : (r.e as Error).message).toBe("Departemen OUTLET-A Outlet A sudah dipakai, jadi tidak bisa dihapus. Arsipkan saja agar tidak muncul di pilihan.");
  });

  it("two members adding the same code at once: the second is told the code is taken, not a raw unique-key error", async () => {
    const { g } = await setup();
    // Both pass the "code taken?" read, then insert: forced by holding the client row so both inserts wait on their foreign key.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${g.client.id} FOR UPDATE`;
      held();
      await gate;
    }, { timeout: 30_000 });
    await holding;
    const both = [1, 2].map(() => settled(createDimension(db, { clientId: g.client.id, kind: "DEPARTEMEN", code: "GUDANG", name: "Gudang" })));
    await blockedOn(`INSERT INTO "public"."Dimension"`, 2);
    release();
    await holder;
    const [x, y] = await Promise.all(both);
    const failed = [x, y].filter((r) => !r.ok);
    expect(failed.length).toBe(1);
    // Today: PrismaClientKnownRequestError P2002 (Dimension_clientId_kind_code_key); the action shows "Terjadi kesalahan tak terduga".
    expect(failed[0].ok ? null : failed[0].e).toBeInstanceOf(DimensionError);
    expect(failed[0].ok ? "" : (failed[0].e as Error).message).toBe("Kode GUDANG sudah dipakai departemen lain.");
  });

  it("deleting a client with tagged bank lines, a tagged split, a waiting tagged request, a template and a closed month removes everything; another client's tags stay", async () => {
    const { g, A, P } = await setup();
    const other = await makeGroup();
    const keep = await createDimension(db, { clientId: other.client.id, kind: "DEPARTEMEN", code: "HQ", name: "Kantor pusat" });
    const me = await addMember(g.firm.id, "AKUNTAN", { name: "Andi", clients: [g.client.id] });
    await addMember(g.firm.id, "AKUNTAN", { name: "Budi", clients: [g.client.id] });
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "a.csv", data: rentCsv, provider: null });
    const t = await db.bankTransaction.findFirstOrThrow({ where: { description: { contains: "SEWA OUTLET" } } });
    await reviewTransaction(db, { bankTxId: t.id, accountCode: "6120", taxTag: null, tags: { departmentId: A.id, projectId: P.id } });
    await splitTransaction(db, { bankTxId: t.id, parts: [{ accountCode: "6120", amount: "6.000.000" }, { accountCode: "6190", amount: "4.000.000" }] });
    const july = await postAdjustment(db, { ...input(g, { departmentId: A.id }, dateOnly(2026, 7, 31)), actorId: me.id });
    await createRecurring(db, { clientId: g.client.id, entryId: july.id, actorId: me.id });
    await approvalsOn(g);
    const o = await submitAdjustment(db, { ...input(g, { projectId: P.id }), maker: { id: me.id, role: "AKUNTAN" } });
    expect(o.posted).toBe(false);
    await lock(g, 7);
    await deleteClient(db, { firmId: g.firm.id, clientId: g.client.id, confirmName: "Grup Uji" });
    expect(await db.dimension.findMany({ select: { id: true } })).toEqual([{ id: keep.id }]);
    expect([await db.bankTxSplit.count(), await db.journalApproval.count(), await db.recurringJournal.count()]).toEqual([0, 0, 0]);
  });
});
