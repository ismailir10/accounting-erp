import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { db, makeGroup, resetDb } from "../helpers";
import { createDimension, setDimensionArchived } from "@/lib/dimensions";
import { postJournal, type PostLine } from "@/lib/ledger/post";
import { upsertRate } from "@/lib/fx/rates";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction, setBankTagsTx } from "@/lib/review";
import { dimensionWorkbook, incomeByDimension, type DimensionPl } from "@/lib/reports/by-dimension";
import { incomeStatement, trialBalance, type Scope } from "@/lib/reports/ledger";
import { accountLedger } from "@/lib/reports/account-ledger";
import { dateOnly } from "@/lib/format";

/**
 * Round nine, probe C (cycle 2026-10-21-uji-keras-paritas): the Laba Rugi per departemen / proyek and the tag-filtered Buku Besar, in
 * group scopes, a mixed-currency group, a financial year ending in March, archived and single-entity tags. Expected figures by hand.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;
type Tag = { departmentId?: string | null; projectId?: string | null };
type L = [code: string, debit: bigint, credit: bigint, tags?: Tag];

const accId = async (g: G, code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code } } })).id;
async function post(g: G, entityId: string, date: Date, memo: string, lines: L[]) {
  const built: PostLine[] = [];
  for (const [code, debit, credit, tags] of lines) built.push({ accountId: await accId(g, code), debit, credit, ...(tags ?? {}) });
  return db.$transaction((tx) => postJournal(tx, { entityId, date, kind: "ADJUSTMENT", memo, lines: built }));
}

/** The invariant of the report: every row's columns add up to its total, and the total is the Laba Rugi. */
async function checked(scope: Scope, from: Date, to: Date, kind: "DEPARTEMEN" | "PROYEK" = "DEPARTEMEN") {
  const pl = await incomeByDimension(db, scope, from, to, kind);
  for (const r of pl.rows) if (r.type !== "heading") expect({ row: r.type === "account" ? r.code : r.label, sum: r.amounts.reduce((x, y) => x + y, 0n) }).toEqual({ row: r.type === "account" ? r.code : r.label, sum: r.total });
  expect(pl.total.totals).toEqual((await incomeStatement(db, scope, from, to)).totals);
  return pl;
}
const accountRow = (pl: DimensionPl, code: string) => pl.rows.find((r) => r.type === "account" && r.code === code) as { amounts: bigint[]; total: bigint };
const subtotal = (pl: DimensionPl, label: string) => pl.rows.find((r) => r.type === "subtotal" && r.label === label) as { amounts: bigint[]; total: bigint };

/** The Excel rows after the header ("Akun …"), as [label, ...numbers]. */
async function excelRows(pl: DimensionPl, from: Date, to: Date, currency = "IDR") {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await dimensionWorkbook(pl, { firm: "KJA Uji", title: "Grup Uji", currency }, from, to)) as never);
  const ws = wb.worksheets[0];
  const all = ws.getRows(1, ws.rowCount)!.map((r) => (r.values as unknown[]).slice(1));
  const head = all.findIndex((r) => r[0] === "Akun");
  return { head: all[head], rows: all.slice(head + 1).filter((r) => r.length) };
}

describe("probe C: Laba Rugi per departemen", () => {
  beforeEach(resetDb);

  it("a mixed-currency group: every row's columns add up to the Total (translation rounding must not break the columns)", async () => {
    const g = await makeGroup();
    const usdCo = g.owner.entity.id;
    await db.entity.update({ where: { id: usdCo }, data: { functionalCurrency: "USD" } });
    const A = await createDimension(db, { clientId: g.client.id, kind: "DEPARTEMEN", code: "A", name: "Outlet A" });
    const B = await createDimension(db, { clientId: g.client.id, kind: "DEPARTEMEN", code: "B", name: "Outlet B" });
    // PT (IDR): sales 1.000.000 for A. USD company: sales USD 100,01 for A and USD 100,01 for B (cents 10.001 each).
    await post(g, g.pt.entity.id, dateOnly(2026, 8, 10), "Penjualan PT", [["1130", 1_000_000n, 0n], ["4100", 0n, 1_000_000n, { departmentId: A.id }]]);
    await post(g, usdCo, dateOnly(2026, 8, 10), "Sales USD", [["1130", 20_002n, 0n], ["4100", 0n, 10_001n, { departmentId: A.id }], ["4100", 0n, 10_001n, { departmentId: B.id }]]);
    await upsertRate(db, g.firm.id, { currency: "USD", quote: "IDR", date: dateOnly(2026, 8, 31), kind: "SPOT", rate: "15500" });
    await upsertRate(db, g.firm.id, { currency: "USD", quote: "IDR", date: dateOnly(2026, 8, 31), kind: "AVERAGE", rate: "15450" });
    const scope = { clientId: g.client.id, entityIds: [g.pt.entity.id, usdCo] };
    const [from, to] = [dateOnly(2026, 8, 1), dateOnly(2026, 8, 31)];
    // Laba Rugi (P&L at the average 15.450): 4100 = 1.000.000 + 20.002 c × 154,50 = 1.000.000 + 3.090.309 (309.030,9 → half up) = 4.090.309.
    expect((await incomeStatement(db, scope, from, to)).totals.revenue).toBe(4_090_309n);
    // Column by column, each USD 100,01 is 1.545.154,5 → 1.545.155: A = 2.545.155, B = 1.545.155, Tanpa = 0 → 4.090.310, one Rupiah
    // above the Total. The right report keeps columns + Tanpa = Total = Laba Rugi (the residue of the rounding has to land in a column).
    const pl = await checked(scope, from, to);
    const row = accountRow(pl, "4100");
    expect(row.total).toBe(4_090_309n);
    expect(row.amounts.reduce((x, y) => x + y, 0n)).toBe(4_090_309n);
  });

  it("financial year ending in March, year so far (Apr–Aug): March is last year; the tag-filtered ledger opens on April, Saldo Laba folds last year's tagged result", async () => {
    const g = await makeGroup();
    await db.client.update({ where: { id: g.client.id }, data: { fiscalYearEndMonth: 3 } });
    const A = await createDimension(db, { clientId: g.client.id, kind: "DEPARTEMEN", code: "A", name: "Outlet A" });
    const e = g.pt.entity.id;
    // FY 2025/26 (Apr 2025 – Mar 2026): sales 10.000.000 for A, a general expense 3.000.000 untagged, rent 1.000.000 for A in March.
    await post(g, e, dateOnly(2025, 6, 10), "Penjualan", [["1130", 10_000_000n, 0n], ["4100", 0n, 10_000_000n, { departmentId: A.id }]]);
    await post(g, e, dateOnly(2025, 7, 10), "Beban umum", [["6190", 3_000_000n, 0n], ["2150", 0n, 3_000_000n]]);
    await post(g, e, dateOnly(2026, 3, 15), "Sewa Maret", [["6120", 1_000_000n, 0n, { departmentId: A.id }], ["2150", 0n, 1_000_000n]]);
    // FY 2026/27: rent for A 2.000.000 (April) and 3.000.000 (August); 500.000 untagged (August).
    await post(g, e, dateOnly(2026, 4, 10), "Sewa April", [["6120", 2_000_000n, 0n, { departmentId: A.id }], ["2150", 0n, 2_000_000n]]);
    await post(g, e, dateOnly(2026, 8, 5), "Sewa Agustus", [["6120", 3_000_000n, 0n, { departmentId: A.id }], ["2150", 0n, 3_000_000n]]);
    await post(g, e, dateOnly(2026, 8, 6), "Sewa lain", [["6120", 500_000n, 0n], ["2150", 0n, 500_000n]]);
    const scope = { clientId: g.client.id, entityIds: [e] };

    // Year so far = 1 Apr – 31 Aug 2026 (the export route's financialYear(3, 2026, 8).start): 6120 A 5.000.000, Tanpa 500.000.
    const pl = await checked(scope, dateOnly(2026, 4, 1), dateOnly(2026, 8, 31));
    expect(accountRow(pl, "6120").amounts).toEqual([5_000_000n, 500_000n]);
    expect(accountRow(pl, "4100")).toBeUndefined();

    // Buku Besar 6120 for August filtered by A: opening = April only (March is last year's) = 2.000.000; closing 5.000.000.
    const a6120 = await accId(g, "6120");
    const led = await accountLedger(db, { accountId: a6120, entityIds: [e], start: dateOnly(2026, 8, 1), end: dateOnly(2026, 8, 31), normalBalance: "DEBIT", dimensionId: A.id });
    expect([led.opening, led.rows.map((r) => r.balance)]).toEqual([2_000_000n, ["5000000"]]);
    const all = await accountLedger(db, { accountId: a6120, entityIds: [e], start: dateOnly(2026, 8, 1), end: dateOnly(2026, 8, 31), normalBalance: "DEBIT" });
    expect([all.opening, all.rows.at(-1)!.balance]).toEqual([2_000_000n, "5500000"]);

    // Saldo Laba (3200) for April 2026: last year = 10.000.000 − 3.000.000 − 1.000.000 = 6.000.000 (credit); for A alone 10.000.000 − 1.000.000 = 9.000.000.
    const re = await accId(g, "3200");
    const reAll = await accountLedger(db, { accountId: re, entityIds: [e], start: dateOnly(2026, 4, 1), end: dateOnly(2026, 4, 30), normalBalance: "CREDIT" });
    const reA = await accountLedger(db, { accountId: re, entityIds: [e], start: dateOnly(2026, 4, 1), end: dateOnly(2026, 4, 30), normalBalance: "CREDIT", dimensionId: A.id });
    expect([reAll.opening, reA.opening, reA.priorYearProfit]).toEqual([6_000_000n, 9_000_000n, 9_000_000n]);
    expect((await trialBalance(db, scope, dateOnly(2026, 4, 30))).find((r) => r.account.code === "3200")!.net).toBe(-6_000_000n);
  });

  it("group scope: a tag one company uses, an archived tag, a column a RECLASS nets to zero, and the Excel reads the same rows", async () => {
    const g = await makeGroup();
    const A = await createDimension(db, { clientId: g.client.id, kind: "DEPARTEMEN", code: "A", name: "Outlet A" });
    const B = await createDimension(db, { clientId: g.client.id, kind: "DEPARTEMEN", code: "B", name: "Outlet B" });
    const C = await createDimension(db, { clientId: g.client.id, kind: "DEPARTEMEN", code: "C", name: "Toko pemilik" });
    const Z = await createDimension(db, { clientId: g.client.id, kind: "DEPARTEMEN", code: "Z", name: "Salah pilih" });
    const pt = g.pt.entity.id;
    const own = g.owner.entity.id;
    // PT: sales 30.000.000 (A 18.000.000, B 12.000.000), salaries 8.000.000 (A 5.000.000, untagged 3.000.000).
    await post(g, pt, dateOnly(2026, 8, 20), "Penjualan", [["1130", 30_000_000n, 0n], ["4100", 0n, 18_000_000n, { departmentId: A.id }], ["4100", 0n, 12_000_000n, { departmentId: B.id }]]);
    await post(g, pt, dateOnly(2026, 8, 21), "Gaji", [["6190", 5_000_000n, 0n, { departmentId: A.id }], ["6190", 3_000_000n, 0n], ["2150", 0n, 8_000_000n]]);
    // Owner: sales 2.000.000 for C, the only C line in the group.
    await post(g, own, dateOnly(2026, 8, 22), "Penjualan toko", [["1130", 2_000_000n, 0n], ["4100", 0n, 2_000_000n, { departmentId: C.id }]]);
    // PT bank line: rent 4.000.000 first tagged Z, then moved to B (Z nets to zero within August).
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "a.csv", data: Buffer.from(["Tanggal;Keterangan;Debet;Kredit;Saldo", "01/08/2026;SALDO AWAL;;;50.000.000,00", "03/08/2026;BAYAR SEWA OUTLET B;4.000.000,00;0,00;46.000.000,00", ""].join("\n")), provider: null });
    const t = await db.bankTransaction.findFirstOrThrow({ where: { description: { contains: "SEWA OUTLET" } } });
    await reviewTransaction(db, { bankTxId: t.id, accountCode: "6120", taxTag: null, tags: { departmentId: Z.id, projectId: null } });
    await db.$transaction((tx) => setBankTagsTx(tx, { bankTxId: t.id, departmentId: B.id, projectId: null }));
    await setDimensionArchived(db, { clientId: g.client.id, id: B.id, archived: true });

    const [from, to] = [dateOnly(2026, 8, 1), dateOnly(2026, 8, 31)];
    const group = await checked({ clientId: g.client.id, entityIds: [pt, own] }, from, to);
    // Columns by code: A, B (archived), C, Z, Tanpa. Z has lines in August (posted and moved) so it is "in use", all zero.
    expect(group.columns.map((c) => [c.code, c.archived])).toEqual([["A", false], ["B", true], ["C", false], ["Z", false], ["", false]]);
    expect(accountRow(group, "4100").amounts).toEqual([18_000_000n, 12_000_000n, 2_000_000n, 0n, 0n]);
    expect(accountRow(group, "6120").amounts).toEqual([0n, 4_000_000n, 0n, 0n, 0n]);
    expect(accountRow(group, "6190").amounts).toEqual([5_000_000n, 0n, 0n, 0n, 3_000_000n]);
    // Laba bersih: A 18 − 5 = 13.000.000; B 12 − 4 = 8.000.000; C 2.000.000; Z 0; Tanpa −3.000.000; Total 20.000.000.
    expect(subtotal(group, "Laba bersih")).toEqual({ type: "subtotal", label: "Laba bersih", amounts: [13_000_000n, 8_000_000n, 2_000_000n, 0n, -3_000_000n], total: 20_000_000n, strong: true });

    // PT alone: no C column.
    const ptOnly = await checked({ clientId: g.client.id, entityIds: [pt] }, from, to);
    expect(ptOnly.columns.map((c) => c.code)).toEqual(["A", "B", "Z", ""]);

    // The Excel: header = Akun, one column per department ("A Outlet A" …), Tanpa, Total; every page row with the same numbers.
    const x = await excelRows(group, from, to);
    expect(x.head).toEqual(["Akun", "A Outlet A", "B Outlet B (diarsipkan)", "C Toko pemilik", "Z Salah pilih", "Tanpa departemen", "Total"]);
    expect(x.rows.length).toBe(group.rows.length);
    group.rows.forEach((r, i) => {
      if (r.type === "heading") expect(x.rows[i]).toEqual([r.label]);
      else expect(x.rows[i].slice(1)).toEqual([...r.amounts, r.total].map(Number));
    });
  });
});
