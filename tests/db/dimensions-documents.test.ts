import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { createDimension, removeDimension, setDimensionArchived } from "@/lib/dimensions";
import { createInvoice, voidInvoice } from "@/lib/receivables/invoices";
import { createSchedule, postInstallment, setScheduleTags } from "@/lib/adjust/schedules";
import { createAsset } from "@/lib/assets/register";
import { disposeAsset } from "@/lib/assets/dispose";
import { postJournal } from "@/lib/ledger/post";
import { incomeByDimension } from "@/lib/reports/by-dimension";
import { listEvents } from "@/lib/audit";
import { dateOnly } from "@/lib/format";

/**
 * Departemen & Proyek on documents (cycle 2026-10-21-departemen-proyek-2): an invoice tags its revenue / expense line, a schedule each
 * instalment's income or expense side, a fixed asset its depreciation and its disposal gain or loss. Balance-sheet legs carry none.
 */
describe("departemen & proyek on invoices, schedules and fixed assets", () => {
  beforeEach(resetDb);

  type G = Awaited<ReturnType<typeof makeGroup>>;
  const setup = async () => {
    const g = await makeGroup();
    const A = await createDimension(db, { clientId: g.client.id, kind: "DEPARTEMEN", code: "OUTLET-A", name: "Outlet A" });
    const B = await createDimension(db, { clientId: g.client.id, kind: "DEPARTEMEN", code: "OUTLET-B", name: "Outlet B" });
    const P = await createDimension(db, { clientId: g.client.id, kind: "PROYEK", code: "PRJ-01", name: "Gedung Bekasi" });
    return { g, A, B, P };
  };
  /** Each line of an entry as [account code, debit, credit, department code, project code]. */
  const tagged = async (entryId: string) =>
    (await db.journalLine.findMany({ where: { entryId }, include: { account: true, department: true, project: true }, orderBy: { id: "asc" } })).map((l) => [l.account.code, l.debit, l.credit, l.department?.code ?? null, l.project?.code ?? null]);
  const scope = (g: G) => ({ clientId: g.client.id, entityIds: [g.pt.entity.id] });

  it("a sales and a purchase invoice for a project: revenue and cost are the project's; receivable, payable and PPN carry none; void mirrors", async () => {
    const { g, P } = await setup();
    const sale = await createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "SALES", contactName: "PT Bangun", number: "INV-01", issueDate: "2026-08-10", dpp: "100.000.000", ppn: "11.000.000", counterCode: "4100", projectId: P.id });
    const bill = await createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "PURCHASE", contactName: "CV Semen", number: "B-01", issueDate: "2026-08-12", dpp: "60.000.000", ppn: "6.600.000", counterCode: "5100", projectId: P.id });
    expect([sale.projectId, bill.projectId]).toEqual([P.id, P.id]);
    expect(await tagged(sale.entryId!)).toEqual([
      ["1130", 111_000_000n, 0n, null, null],
      ["4100", 0n, 100_000_000n, null, "PRJ-01"],
      ["2130", 0n, 11_000_000n, null, null],
    ]);
    expect((await tagged(bill.entryId!)).filter((l) => l[3] || l[4]).map((l) => l[0])).toEqual(["5100"]);

    // Laba Rugi per proyek: PRJ-01 earns 100 jt and costs 60 jt; Tanpa proyek nothing.
    const pl = await incomeByDimension(db, scope(g), dateOnly(2026, 8, 1), dateOnly(2026, 8, 31), "PROYEK");
    const net = pl.rows.find((r) => r.type === "subtotal" && r.label === "Laba bersih") as { amounts: bigint[]; total: bigint };
    expect(net.amounts).toEqual([40_000_000n, 0n]);
    expect(net.total).toBe(40_000_000n);

    // Voided: its mirror carries the same tag, so the project's column drops it.
    await setDimensionArchived(db, { clientId: g.client.id, id: P.id, archived: true }); // a void mirrors even an archived tag
    await voidInvoice(db, { clientId: g.client.id, invoiceId: bill.id, reason: "dokumen pemasok tercatat dua kali" });
    const after = await incomeByDimension(db, scope(g), dateOnly(2026, 8, 1), dateOnly(2026, 8, 31), "PROYEK");
    expect((after.rows.find((r) => r.type === "subtotal" && r.label === "Laba bersih") as { amounts: bigint[] }).amounts).toEqual([100_000_000n, 0n]);
    // A new invoice can't take the archived project; one in use can't be removed.
    await expect(createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "SALES", contactName: "PT Bangun", number: "INV-02", issueDate: "2026-08-20", dpp: "1.000.000", counterCode: "4100", projectId: P.id })).rejects.toThrow("sudah diarsipkan");
    await expect(removeDimension(db, { clientId: g.client.id, id: P.id })).rejects.toThrow("sudah dipakai");
  });

  it("refuses another client's or the wrong kind on an invoice; a Saldo Awal invoice keeps its tags without a journal", async () => {
    const { g, A, P } = await setup();
    const other = await makeGroup();
    const theirs = await createDimension(db, { clientId: other.client.id, kind: "PROYEK", code: "X", name: "Lain" });
    const base = { clientId: g.client.id, entityId: g.pt.entity.id, direction: "SALES" as const, contactName: "PT Bangun", issueDate: "2026-08-10", dpp: "1.000.000", counterCode: "4100" };
    await expect(createInvoice(db, { ...base, number: "X-1", projectId: theirs.id })).rejects.toThrow("Proyek tidak termasuk klien ini.");
    await expect(createInvoice(db, { ...base, number: "X-2", departmentId: P.id })).rejects.toThrow("Departemen tidak termasuk klien ini.");
    expect(await db.invoice.count({ where: { clientId: g.client.id } })).toBe(0);
    const ok = await createInvoice(db, { ...base, number: "X-3", departmentId: A.id });
    expect(ok.departmentId).toBe(A.id);
  });

  it("a prepaid rent schedule for Outlet A tags each expense; changed to Outlet B, only later instalments follow", async () => {
    const { g, A, B } = await setup();
    const s = await createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "AMORTIZATION", memo: "Sewa outlet dibayar di muka", debitCode: "6120", creditCode: "1170", amount: "12.000.000", months: 12, startYear: 2026, startMonth: 8, departmentId: A.id });
    const aug = await postInstallment(db, { clientId: g.client.id, scheduleId: s.id, k: 1 });
    expect(await tagged(aug.id)).toEqual([["6120", 1_000_000n, 0n, "OUTLET-A", null], ["1170", 0n, 1_000_000n, null, null]]);
    await setScheduleTags(db, { clientId: g.client.id, scheduleId: s.id, departmentId: B.id });
    const sep = await postInstallment(db, { clientId: g.client.id, scheduleId: s.id, k: 2 });
    expect((await tagged(sep.id))[0]).toEqual(["6120", 1_000_000n, 0n, "OUTLET-B", null]);
    expect((await tagged(aug.id))[0][3]).toBe("OUTLET-A"); // posted ones stay
    expect((await listEvents(db, g.client.id, { kind: "DIMENSION" })).some((e) => e.summary === "Jadwal Sewa outlet dibayar di muka: OUTLET-A → OUTLET-B untuk angsuran berikutnya")).toBe(true);

    // Archived while running: the schedule keeps posting it; choosing an archived one anew is refused.
    await setDimensionArchived(db, { clientId: g.client.id, id: B.id, archived: true });
    const oct = await postInstallment(db, { clientId: g.client.id, scheduleId: s.id, k: 3 });
    expect((await tagged(oct.id))[0][3]).toBe("OUTLET-B");
    await setScheduleTags(db, { clientId: g.client.id, scheduleId: s.id, departmentId: A.id });
    await expect(setScheduleTags(db, { clientId: g.client.id, scheduleId: s.id, departmentId: B.id })).rejects.toThrow("sudah diarsipkan");
  });

  it("an accrual schedule tags both its instalment and its reversal's expense; a balance-sheet-only schedule takes no tag", async () => {
    const { g, A } = await setup();
    const s = await createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "ACCRUAL", memo: "Akrual listrik outlet", debitCode: "6130", creditCode: "2150", amount: "4.500.000", months: 1, startYear: 2026, startMonth: 8, departmentId: A.id });
    const e = await postInstallment(db, { clientId: g.client.id, scheduleId: s.id, k: 1 });
    const r = await postInstallment(db, { clientId: g.client.id, scheduleId: s.id, k: 2 });
    expect((await tagged(e.id)).find((l) => l[0] === "6130")![3]).toBe("OUTLET-A");
    expect((await tagged(r.id)).find((l) => l[0] === "6130")).toEqual(["6130", 0n, 4_500_000n, "OUTLET-A", null]);
    await expect(createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "AMORTIZATION", memo: "Reklas", debitCode: "1170", creditCode: "1130", amount: "1.200.000", months: 12, startYear: 2026, startMonth: 8, departmentId: A.id })).rejects.toThrow("hanya untuk jadwal dengan akun pendapatan atau beban");
  });

  it("a fixed asset for Outlet B: its depreciation and its disposal loss are Outlet B's", async () => {
    const { g, B } = await setup();
    const id = async (code: string) => (await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code } })).id;
    const buy = await db.$transaction(async (tx) =>
      postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, 8, 10), kind: "ADJUSTMENT", memo: "Beli oven", lines: [{ accountId: await id("1210"), debit: 12_000_000n }, { accountId: await id("2110"), credit: 12_000_000n }] }),
    );
    const a = await createAsset(db, { clientId: g.client.id, entityId: g.pt.entity.id, name: "Oven", taxGroup: "KELOMPOK_1", fiscalMethod: "GARIS_LURUS", acquiredOn: "2026-08-10", cost: "12000000", usefulLifeMonths: 12, assetAccountCode: "1210", sourceEntryId: buy.id, departmentId: B.id });
    const dep = await postInstallment(db, { clientId: g.client.id, scheduleId: a.scheduleId!, k: 1 });
    expect((await tagged(dep.id)).map((l) => [l[0], l[3]])).toEqual([["6180", "OUTLET-B"], ["1219", null]]);
    const r = await disposeAsset(db, { clientId: g.client.id, assetId: a.id, date: "2026-09-30", proceeds: "0", proceedsCode: "1140" });
    expect((await tagged(r.entryId)).map((l) => [l[0], l[3]])).toEqual([["1219", null], ["1210", null], ["7300", "OUTLET-B"]]);
    // Outlet B: depreciation 1 jt + loss 11 jt.
    const pl = await incomeByDimension(db, scope(g), dateOnly(2026, 9, 1), dateOnly(2026, 9, 30), "DEPARTEMEN");
    const col = pl.columns.findIndex((c) => c.code === "OUTLET-B");
    expect((pl.rows.find((x) => x.type === "subtotal" && x.label === "Laba bersih") as { amounts: bigint[] }).amounts[col]).toBe(-12_000_000n);
  });
});
