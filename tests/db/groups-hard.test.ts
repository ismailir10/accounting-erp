import { beforeEach, describe, expect, it } from "vitest";
import { db, resetDb } from "../helpers";
import { createClient, createFirm } from "@/lib/setup";
import { postJournal } from "@/lib/ledger/post";
import { postOpening } from "@/lib/opening";
import { balanceSheet, combinedWorksheet, incomeStatement, trialBalance } from "@/lib/reports/ledger";
import { cashFlow, equityChanges } from "@/lib/reports/statements";
import { statementSet } from "@/lib/reports/statement-set";
import { runControls } from "@/lib/controls";
import { dateOnly } from "@/lib/format";

/**
 * A group of companies, tested hard (cycle 2026-10-21-uji-keras-grup, area "groups"). Every expected figure is computed by hand in the
 * comments first, never re-derived the way the code does. J = Rp 1 juta. Intercompany per counterparty (one 1190 for several related
 * parties nets them) and eliminating intra-group income, expense and investment are logged in the cycle doc, not tested here.
 *
 * The group: PT Uji Sejahtera (PT), CV Maju Bersama (CV) and the owner Andi Wijaya (PERORANGAN), one client, one shared chart.
 */
const J = 1_000_000n;

async function makeGroup3() {
  return db.$transaction(async (tx) => {
    const firm = await createFirm(tx, "KJA Uji Grup");
    const { client, entities } = await createClient(tx, firm.id, {
      name: "Grup Maju",
      industry: "dagang",
      entities: [
        { name: "PT Uji Sejahtera", shortName: "PT Uji", kind: "PT", banks: [{ bank: "BCA", number: "1111111111", label: "BCA Giro" }] },
        { name: "CV Maju Bersama", shortName: "CV Maju", kind: "CV", banks: [{ bank: "BCA", number: "4444444444", label: "BCA Giro" }] },
        { name: "Andi Wijaya", shortName: "Andi", kind: "PERORANGAN", banks: [{ bank: "BRI", number: "3333333333", label: "BRI Tabungan" }] },
      ],
    });
    return { firm, client, pt: entities[0], cv: entities[1], owner: entities[2] };
  });
}
type G = Awaited<ReturnType<typeof makeGroup3>>;

const id = async (g: G, code: string) => (await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code } })).id;
/** One typed journal (kind ADJUSTMENT) through postJournal; positive = debit, negative = credit. */
const postFor = async (g: G, entityId: string, y: number, m: number, d: number, memo: string, lines: [string, bigint][]) =>
  db.$transaction(async (tx) =>
    postJournal(tx, {
      entityId,
      date: dateOnly(y, m, d),
      kind: "ADJUSTMENT",
      memo,
      lines: await Promise.all(lines.map(async ([code, v]) => (v > 0n ? { accountId: await id(g, code), debit: v } : { accountId: await id(g, code), credit: -v }))),
    }),
  );
const opening = (g: G, entityId: string, date: Date, lines: [string, bigint][]) =>
  postOpening(db, {
    clientId: g.client.id,
    entityId,
    date,
    lines: lines.map(([accountCode, v]) => ({ accountCode, debit: v > 0n ? String(v) : "0", credit: v < 0n ? String(-v) : "0" })),
  });

const scopeOf = (g: G, ...entities: { entity: { id: string } }[]) => ({ clientId: g.client.id, entityIds: entities.map((e) => e.entity.id) });
const all = (g: G) => scopeOf(g, g.pt, g.cv, g.owner);
const tbNet = (tb: Awaited<ReturnType<typeof trialBalance>>, code: string) => tb.find((r) => r.account.code === code)?.net ?? 0n;
const bsLine = (bs: Awaited<ReturnType<typeof balanceSheet>>, line: string) =>
  [...bs.currentAssets, ...bs.nonCurrentAssets, ...bs.liabilities, ...bs.equity].find((i) => i.fsLine === line)?.amount ?? 0n;
const items = (xs: { key: string; amount: bigint }[]) => Object.fromEntries(xs.map((i) => [i.key, i.amount]));

/**
 * Saldo Awal 31 Dec 2025 — PT: 1120 500 | 3100 300, 3200 200. CV: 1120 100 | 3100 100. Owner: 1120 50 | 3100 50.
 * 2026 (both sides typed in each entity's own books, 1190 on both sides):
 *  10 Jan  PT lends CV 100            PT  Dr 1190 100 / Cr 1120 100      CV  Dr 1120 100 / Cr 1190 100
 *  15 Feb  owner lends PT 40          own Dr 1190 40  / Cr 1120 40       PT  Dr 1120 40  / Cr 1190 40
 *  31 Mar  PT management fee to CV 10 PT  Dr 1190 10  / Cr 4110 10       CV  Dr 6170 10  / Cr 1190 10
 *  20 Apr  CV repays PT 30            CV  Dr 1190 30  / Cr 1120 30       PT  Dr 1120 30  / Cr 1190 30
 *   5 Jun  PT cash sale 200 (third party)    PT Dr 1120 200 / Cr 4100 200
 *   6 Jun  CV pays rent 20 (third party)     CV Dr 6120 20  / Cr 1120 20
 */
async function groupYear(g: G) {
  const d = dateOnly(2025, 12, 31);
  await opening(g, g.pt.entity.id, d, [["1120", 500n * J], ["3100", -300n * J], ["3200", -200n * J]]);
  await opening(g, g.cv.entity.id, d, [["1120", 100n * J], ["3100", -100n * J]]);
  await opening(g, g.owner.entity.id, d, [["1120", 50n * J], ["3100", -50n * J]]);
  await postFor(g, g.pt.entity.id, 2026, 1, 10, "Pinjaman ke CV", [["1190", 100n * J], ["1120", -100n * J]]);
  await postFor(g, g.cv.entity.id, 2026, 1, 10, "Pinjaman dari PT", [["1120", 100n * J], ["1190", -100n * J]]);
  await postFor(g, g.owner.entity.id, 2026, 2, 15, "Pinjaman ke PT", [["1190", 40n * J], ["1120", -40n * J]]);
  await postFor(g, g.pt.entity.id, 2026, 2, 15, "Pinjaman dari pemilik", [["1120", 40n * J], ["1190", -40n * J]]);
  await postFor(g, g.pt.entity.id, 2026, 3, 31, "Management fee ke CV", [["1190", 10n * J], ["4110", -10n * J]]);
  await postFor(g, g.cv.entity.id, 2026, 3, 31, "Management fee dari PT", [["6170", 10n * J], ["1190", -10n * J]]);
  await postFor(g, g.cv.entity.id, 2026, 4, 20, "Cicil pinjaman PT", [["1190", 30n * J], ["1120", -30n * J]]);
  await postFor(g, g.pt.entity.id, 2026, 4, 20, "Terima cicilan CV", [["1120", 30n * J], ["1190", -30n * J]]);
  await postFor(g, g.pt.entity.id, 2026, 6, 5, "Penjualan tunai", [["1120", 200n * J], ["4100", -200n * J]]);
  await postFor(g, g.cv.entity.id, 2026, 6, 6, "Sewa", [["6120", 20n * J], ["1120", -20n * J]]);
}

describe("groups, tested hard — intercompany both sides, worksheet, combined statements", () => {
  beforeEach(resetDb);

  it("mirrored 1190 across three entities: worksheet eliminates, combined Neraca has no 1190, every entity and the group balance", async () => {
    const g = await makeGroup3();
    await groupYear(g);
    const asOf = dateOnly(2026, 6, 30);
    // 1190 by hand — PT: +100 −40 +10 −30 = +40; CV: −100 −10 +30 = −80; owner: +40. Receivables 80 = payables 80.
    const ws = await combinedWorksheet(db, g.client.id, asOf);
    const col = (e: { entity: { id: string } }) => ws.entities.findIndex((x) => x.id === e.entity.id);
    const rowP = ws.rows.find((r) => r.key === "1190-P")!;
    const rowU = ws.rows.find((r) => r.key === "1190-U")!;
    expect([rowP.values[col(g.pt)], rowP.values[col(g.cv)], rowP.values[col(g.owner)]]).toEqual([40n * J, 0n, 40n * J]);
    expect([rowU.values[col(g.pt)], rowU.values[col(g.cv)], rowU.values[col(g.owner)]]).toEqual([0n, -80n * J, 0n]);
    expect([ws.matched, ws.residual, rowP.combined, rowU.combined]).toEqual([80n * J, 0n, 0n, 0n]);
    // Each column is a balanced TB: Σ net = 0 per entity.
    for (const e of [g.pt, g.cv, g.owner]) expect(ws.rows.reduce((s, r) => s + r.values[col(e)], 0n)).toBe(0n);
    // Combined cash 1120: PT 500 −100 +40 +30 +200 = 670; CV 100 +100 −30 −20 = 150; owner 50 −40 = 10 → 830.
    expect(ws.rows.find((r) => r.key === "1120")!.combined).toBe(830n * J);

    const bs = await balanceSheet(db, all(g), asOf);
    expect(bs.totals).toEqual({ assets: 830n * J, liabilities: 0n, equity: 830n * J, difference: 0n });
    expect(bsLine(bs, "UTANG_ANTAR_ENTITAS")).toBe(0n);
    expect(bsLine(bs, "PIUTANG_LAIN")).toBe(0n);
    // Per entity — PT: 670 + 40 = 710 = 500 + profit 210. CV: 150 = Utang antar entitas 80 + (100 − 30). Owner: 10 + 40 = 50.
    const pt = await balanceSheet(db, scopeOf(g, g.pt), asOf);
    expect([pt.totals.assets, pt.totals.equity, pt.totals.difference]).toEqual([710n * J, 710n * J, 0n]);
    const cv = await balanceSheet(db, scopeOf(g, g.cv), asOf);
    expect([cv.totals.assets, bsLine(cv, "UTANG_ANTAR_ENTITAS"), cv.totals.equity, cv.totals.difference]).toEqual([150n * J, 80n * J, 70n * J, 0n]);
    const own = await balanceSheet(db, scopeOf(g, g.owner), asOf);
    expect([own.totals.assets, own.totals.equity]).toEqual([50n * J, 50n * J]);

    const controls = await runControls(db, g.client.id, 2026, 6);
    const ic = controls.find((c) => c.key === "intercompany")!;
    expect(ic.status).toBe("PASS");
    expect(controls.filter((c) => c.key.startsWith("bs:") || c.key.startsWith("tb:")).every((c) => c.status === "PASS")).toBe(true);
  });

  it("combined cash flow: intra-group loans cancel; cash moves only by the third-party sale and rent", async () => {
    const g = await makeGroup3();
    await groupYear(g);
    const cf = await cashFlow(db, all(g), dateOnly(2026, 6, 30));
    // Profit 180, no balance-sheet movement outside cash (1190 nets to 0 in the group, the fee entries cross only inside the group)
    expect(cf.netProfit).toBe(180n * J);
    expect(cf.totals).toEqual({ OPERATING: 180n * J, INVESTING: 0n, FINANCING: 0n });
    expect([cf.openingCash, cf.net, cf.closingCash]).toEqual([650n * J, 180n * J, 830n * J]);
    const eq = await equityChanges(db, all(g), dateOnly(2026, 6, 30));
    expect(eq.totals).toMatchObject({ opening: 650n * J, profit: 180n * J, closing: 830n * J });
    expect(eq.balanceSheetEquity).toBe(830n * J);
  });

  it("CV's own cash flow: borrowed 100, repaid 30 → financing +70; the fee accrued on 1190 is non-cash", async () => {
    const g = await makeGroup3();
    await groupYear(g);
    const cf = await cashFlow(db, scopeOf(g, g.cv), dateOnly(2026, 6, 30));
    // Profit −30 (fee 10 + rent 20). Operating: −30 + fee not paid in cash 10 = −20. Financing: +100 −30 = +70. Cash 100 → 150.
    expect(cf.netProfit).toBe(-30n * J);
    expect(cf.totals).toEqual({ OPERATING: -20n * J, INVESTING: 0n, FINANCING: 70n * J });
    expect(cf.closingCash).toBe(150n * J);
  });

});

describe("groups, tested hard — a balance that does not mirror, and the intercompany control", () => {
  beforeEach(resetDb);

  it("CV books 90 of PT's 100 loan: residual 10, control REVIEW, combined Neraca shows the unmatched 10 as a receivable", async () => {
    const g = await makeGroup3();
    const d = dateOnly(2025, 12, 31);
    await opening(g, g.pt.entity.id, d, [["1120", 500n * J], ["3100", -500n * J]]);
    await opening(g, g.cv.entity.id, d, [["1120", 100n * J], ["3100", -100n * J]]);
    await postFor(g, g.pt.entity.id, 2026, 1, 10, "Pinjaman ke CV", [["1190", 100n * J], ["1120", -100n * J]]);
    // CV's bookkeeper typed 90 (a typo): CV's cash is then 10 short of what the bank says — the books themselves still balance.
    await postFor(g, g.cv.entity.id, 2026, 1, 10, "Pinjaman dari PT", [["1120", 90n * J], ["1190", -90n * J]]);
    const asOf = dateOnly(2026, 1, 31);
    const ws = await combinedWorksheet(db, g.client.id, asOf);
    // P = 100, N = 90 → matched 90, residual +10; the worksheet's combined 1190-P = 10, 1190-U = 0.
    expect([ws.matched, ws.residual]).toEqual([90n * J, 10n * J]);
    expect([ws.rows.find((r) => r.key === "1190-P")!.combined, ws.rows.find((r) => r.key === "1190-U")!.combined]).toEqual([10n * J, 0n]);
    const bs = await balanceSheet(db, all(g), asOf);
    // Combined: cash 400 + 190 = 590, 1190 +10 → assets 600 = equity 600.
    expect([bsLine(bs, "KAS_SETARA_KAS"), bsLine(bs, "PIUTANG_LAIN"), bs.totals.assets, bs.totals.difference]).toEqual([590n * J, 10n * J, 600n * J, 0n]);
    const ic = (await runControls(db, g.client.id, 2026, 1)).find((c) => c.key === "intercompany")!;
    expect(ic.status).toBe("REVIEW");
    expect(ic.detail).toContain("10.000.000");
  });

  it("CV books 110 of PT's 100 loan: the group shows Utang antar entitas 10, worksheet and Neraca agree", async () => {
    const g = await makeGroup3();
    const d = dateOnly(2025, 12, 31);
    await opening(g, g.pt.entity.id, d, [["1120", 500n * J], ["3100", -500n * J]]);
    await opening(g, g.cv.entity.id, d, [["1120", 100n * J], ["3100", -100n * J]]);
    await postFor(g, g.pt.entity.id, 2026, 1, 10, "Pinjaman ke CV", [["1190", 100n * J], ["1120", -100n * J]]);
    await postFor(g, g.cv.entity.id, 2026, 1, 10, "Pinjaman dari PT", [["1120", 110n * J], ["1190", -110n * J]]);
    const asOf = dateOnly(2026, 1, 31);
    const ws = await combinedWorksheet(db, g.client.id, asOf);
    expect([ws.matched, ws.residual]).toEqual([100n * J, -10n * J]);
    expect(ws.rows.find((r) => r.key === "1190-U")!.combined).toBe(-10n * J);
    const bs = await balanceSheet(db, all(g), asOf);
    // Cash 400 + 210 = 610 = Utang antar entitas 10 + equity 600.
    expect([bsLine(bs, "KAS_SETARA_KAS"), bsLine(bs, "UTANG_ANTAR_ENTITAS"), bs.totals.liabilities, bs.totals.equity, bs.totals.difference]).toEqual([610n * J, 10n * J, 10n * J, 600n * J, 0n]);
    expect((await runControls(db, g.client.id, 2026, 1)).find((c) => c.key === "intercompany")!.status).toBe("REVIEW");
  });

});

describe("groups, tested hard — across a year end, and the combined statement set", () => {
  beforeEach(resetDb);

  it("year end: each entity's result rolls into its own Saldo Laba, the group's is their sum; Jan 2027 opens at the Dec Neraca", async () => {
    const g = await makeGroup3();
    await groupYear(g);
    // 2027: PT cash sale 50 (15 Jan), CV rent 5 (16 Jan).
    await postFor(g, g.pt.entity.id, 2027, 1, 15, "Penjualan Januari", [["1120", 50n * J], ["4100", -50n * J]]);
    await postFor(g, g.cv.entity.id, 2027, 1, 16, "Sewa Januari", [["6120", 5n * J], ["1120", -5n * J]]);
    const jan = dateOnly(2027, 1, 31);
    // 2026 results: PT 210, CV −30, owner 0. 3200: PT 200 + 210 = 410 credit; CV 30 debit; owner 0; group 380 credit.
    const ws = await combinedWorksheet(db, g.client.id, jan);
    const col = (e: { entity: { id: string } }) => ws.entities.findIndex((x) => x.id === e.entity.id);
    const re = ws.rows.find((r) => r.key === "3200")!;
    expect([re.values[col(g.pt)], re.values[col(g.cv)], re.values[col(g.owner)], re.combined]).toEqual([-410n * J, 30n * J, 0n, -380n * J]);
    expect(ws.rows.find((r) => r.key === "4100")!.combined).toBe(-50n * J); // 2026 sales folded away
    const tb = await trialBalance(db, all(g), jan);
    expect([tbNet(tb, "3200"), tbNet(tb, "4110"), tbNet(tb, "6120")]).toEqual([-380n * J, 0n, 5n * J]);
    expect(tb.reduce((s, r) => s + r.net, 0n)).toBe(0n);
    const eq = await equityChanges(db, all(g), jan);
    // Opening = group equity 31 Dec 2026 = 830; profit 45; closing 875 = Neraca.
    expect(eq.totals).toMatchObject({ opening: 830n * J, profit: 45n * J, closing: 875n * J });
    expect(eq.balanceSheetEquity).toBe(875n * J);
    expect((await balanceSheet(db, all(g), dateOnly(2026, 12, 31))).totals.equity).toBe(830n * J);
    const cf = await cashFlow(db, all(g), jan);
    expect([cf.openingCash, cf.net, cf.closingCash]).toEqual([830n * J, 45n * J, 875n * J]);
  });

  it("combined statement set (Excel/PDF source) carries the same figures as the on-screen statements", async () => {
    const g = await makeGroup3();
    await groupYear(g);
    const set = await statementSet(db, all(g), 2026, 6);
    const row = (name: string, key: string) => set.statements.find((s) => s.name === name)!.rows.find((r) => r.key === key)!.values[0];
    const label = (name: string, l: string) => set.statements.find((s) => s.name === name)!.rows.find((r) => r.label.startsWith(l))!.values[0];
    const bs = await balanceSheet(db, all(g), dateOnly(2026, 6, 30));
    const is = await incomeStatement(db, all(g), dateOnly(2026, 1, 1), dateOnly(2026, 6, 30));
    expect([row("Neraca", "total_aset"), row("Neraca", "total_liabilitas_ekuitas")]).toEqual([bs.totals.assets, bs.totals.liabilities + bs.totals.equity]);
    expect(row("Laba Rugi", "laba_bersih")).toBe(is.totals.netProfit);
    expect(label("Arus Kas", "Kas dan setara kas 30")).toBe(830n * J);
    expect(label("Arus Kas", "Kenaikan")).toBe(180n * J);
  });
});

describe("groups, tested hard — a company added in the middle of the year", () => {
  beforeEach(resetDb);

  /**
   * PT and the owner from 31 Dec 2025; CV joins the client in June with Saldo Awal 31 May 2026.
   * PT: Saldo Awal 1120 500 | 3100 500; 15 Mar cash sale 60; 10 Jun cash sale 20. CV: Saldo Awal 31 May 1120 80 | 3100 50, 3200 30;
   * 12 Jun cash sale 10. Owner: nothing.
   * Group at 31 May 2026: PT 560 + CV 80 = 640. At 30 Jun 2026: PT 580 + CV 90 = 670.
   */
  async function midYear() {
    const g = await makeGroup3();
    await opening(g, g.pt.entity.id, dateOnly(2025, 12, 31), [["1120", 500n * J], ["3100", -500n * J]]);
    await postFor(g, g.pt.entity.id, 2026, 3, 15, "Penjualan Maret", [["1120", 60n * J], ["4100", -60n * J]]);
    await opening(g, g.cv.entity.id, dateOnly(2026, 5, 31), [["1120", 80n * J], ["3100", -50n * J], ["3200", -30n * J]]);
    await postFor(g, g.pt.entity.id, 2026, 6, 10, "Penjualan Juni", [["1120", 20n * J], ["4100", -20n * J]]);
    await postFor(g, g.cv.entity.id, 2026, 6, 12, "Penjualan Juni CV", [["1120", 10n * J], ["4100", -10n * J]]);
    return g;
  }

  it("combined Perubahan Ekuitas: the opening row's figure is the group's equity at the date it is labelled with", async () => {
    const g = await midYear();
    const eq = await equityChanges(db, all(g), dateOnly(2026, 6, 30));
    expect(eq.balanceSheetEquity).toBe(670n * J);
    expect(eq.totals.closing).toBe(670n * J);
    // The row reads "Saldo <openedAt>": that figure must be the combined Neraca equity on that date.
    const atLabel = await balanceSheet(db, all(g), eq.openedAt);
    expect({ openedAt: eq.openedAt.toISOString().slice(0, 10), opening: eq.totals.opening }).toEqual({ openedAt: eq.openedAt.toISOString().slice(0, 10), opening: atLabel.totals.equity });
  });

  it("combined Arus Kas: the opening cash is the group's cash at the date it is labelled with", async () => {
    const g = await midYear();
    const cf = await cashFlow(db, all(g), dateOnly(2026, 6, 30));
    expect(cf.closingCash).toBe(670n * J);
    const atLabel = await balanceSheet(db, all(g), cf.openedAt);
    expect({ openedAt: cf.openedAt.toISOString().slice(0, 10), opening: cf.openingCash }).toEqual({ openedAt: cf.openedAt.toISOString().slice(0, 10), opening: bsLine(atLabel, "KAS_SETARA_KAS") });
  });

  it("CV's own statements open at its Saldo Awal (31 May 2026)", async () => {
    const g = await midYear();
    const eq = await equityChanges(db, scopeOf(g, g.cv), dateOnly(2026, 6, 30));
    expect([eq.openedAt.toISOString().slice(0, 10), eq.totals.opening, eq.totals.profit, eq.totals.closing]).toEqual(["2026-05-31", 80n * J, 10n * J, 90n * J]);
    const cf = await cashFlow(db, scopeOf(g, g.cv), dateOnly(2026, 6, 30));
    expect([cf.openingCash, cf.net, cf.closingCash]).toEqual([80n * J, 10n * J, 90n * J]);
  });
});

const bcaFile = (number: string, lines: string[], opening: string, closing: string) => `Informasi Rekening - Mutasi Rekening
No. rekening : ${number}
Periode : 01/01/2026 - 31/01/2026

Tanggal Transaksi,Keterangan,Cabang,Jumlah,,Saldo
${lines.join("\n")}
"Saldo Awal : ${opening}"
"Saldo Akhir : ${closing}"
`;

describe("groups, tested hard — a transfer between two companies' bank accounts, through the import", () => {
  beforeEach(resetDb);

  it("PT's BCA out and CV's BCA in pair as one intercompany transfer: 1190 in each book, eliminated, group cash unchanged", async () => {
    const g = await makeGroup3();
    const { importStatement } = await import("@/lib/import/pipeline");
    const code = async (bankAccountId: string) => (await db.bankAccount.findUniqueOrThrow({ where: { id: bankAccountId }, include: { account: true } })).account.code;
    await opening(g, g.pt.entity.id, dateOnly(2025, 12, 31), [[await code(g.pt.banks[0].id), 100n * J], ["3100", -100n * J]]);
    await opening(g, g.cv.entity.id, dateOnly(2025, 12, 31), [[await code(g.cv.banks[0].id), 10n * J], ["3100", -10n * J]]);
    const ptFile = bcaFile("1111111111", [`'05/01,"TRSF E-BANKING DB 0501/FTSCY/WS1 CV MAJU BERSAMA",'0000,"25,000,000.00",DB,"75,000,000.00"`], "100,000,000.00", "75,000,000.00");
    const cvFile = bcaFile("4444444444", [`'05/01,"TRSF E-BANKING CR 0501/FTSCY/WS1 PT UJI SEJAHTERA",'0000,"25,000,000.00",CR,"35,000,000.00"`], "10,000,000.00", "35,000,000.00");
    const a = await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "pt.csv", data: Buffer.from(ptFile), provider: null });
    expect(a.byMethod.TRANSFER).toBe(1);
    // Only PT's half so far: it names CV, so it goes to 1190 and the group shows an unmatched 25 (REVIEW).
    expect((await combinedWorksheet(db, g.client.id, dateOnly(2026, 1, 31))).residual).toBe(25n * J);
    const b = await importStatement(db, { bankAccountId: g.cv.banks[0].id, fileName: "cv.csv", data: Buffer.from(cvFile), provider: null });
    expect(b.byMethod.TRANSFER).toBe(1);
    const asOf = dateOnly(2026, 1, 31);
    const ws = await combinedWorksheet(db, g.client.id, asOf);
    expect([ws.matched, ws.residual]).toEqual([25n * J, 0n]);
    expect(await db.bankTransaction.count({ where: { status: "NEEDS_REVIEW" } })).toBe(0);
    expect(tbNet(await trialBalance(db, scopeOf(g, g.pt), asOf), "1190")).toBe(25n * J);
    expect(tbNet(await trialBalance(db, scopeOf(g, g.cv), asOf), "1190")).toBe(-25n * J);
    const cf = await cashFlow(db, all(g), asOf);
    expect([cf.openingCash, cf.net, cf.closingCash, cf.totals.INVESTING, cf.totals.FINANCING]).toEqual([110n * J, 0n, 110n * J, 0n, 0n]);
    const ptCf = await cashFlow(db, scopeOf(g, g.pt), asOf);
    expect(items(ptCf.investing)).toEqual({ INTERCOMPANY_LENT: -25n * J });
    const cvCf = await cashFlow(db, scopeOf(g, g.cv), asOf);
    expect(items(cvCf.financing)).toEqual({ INTERCOMPANY: 25n * J });
    expect((await runControls(db, g.client.id, 2026, 1)).find((c) => c.key === "intercompany")!.status).toBe("PASS");
  });
});

describe("groups, tested hard — a company that joins at a year end", () => {
  beforeEach(resetDb);

  it("the group's comparative 31 Dec column is the PT's year-end close, not a Saldo Awal, when only the joining CV opens there", async () => {
    const g = await makeGroup3();
    const { reportPeriods } = await import("@/lib/reports/periods");
    await opening(g, g.pt.entity.id, dateOnly(2025, 10, 31), [["1120", 500n * J], ["3100", -500n * J]]);
    await postFor(g, g.pt.entity.id, 2025, 11, 20, "Penjualan November", [["1120", 10n * J], ["4100", -10n * J]]);
    await postFor(g, g.pt.entity.id, 2026, 3, 15, "Penjualan Maret", [["1120", 60n * J], ["4100", -60n * J]]);
    await opening(g, g.cv.entity.id, dateOnly(2026, 12, 31), [["1120", 80n * J], ["3100", -80n * J]]);
    await postFor(g, g.pt.entity.id, 2027, 1, 10, "Penjualan Januari", [["1120", 5n * J], ["4100", -5n * J]]);
    // PT has kept books since Nov 2025: at 31 Dec 2026 the group holds a full year of PT's books plus CV's opening position.
    const per = await reportPeriods(db, all(g), 2027, 1);
    expect(per.balanceComparative).toMatchObject({ opening: false, label: "31 Desember 2026" });
    // PT alone: the same column, no Saldo Awal wording either.
    expect((await reportPeriods(db, scopeOf(g, g.pt), 2027, 1)).balanceComparative).toMatchObject({ opening: false, label: "31 Desember 2026" });
  });
});
