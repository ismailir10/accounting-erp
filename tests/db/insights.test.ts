import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { db, makeGroup, resetDb } from "../helpers";
import { postJournal } from "@/lib/ledger/post";
import { dateOnly } from "@/lib/format";
import { runControls } from "@/lib/controls";
import { monthlyBalance, monthlyIncome, ratios } from "@/lib/reports/analysis";
import { figuresOf, margins, topMovers, trend } from "@/lib/reports/insights";
import { managementWorkbook } from "@/lib/reports/management-pack";

// Wawasan (cycle 2026-10-17-wawasan-keuangan): every finding equals a cell of the analysis tables, the movers follow the pack's
// Perubahan Akun, *Melewati ambang* marks the flux control's accounts, and each mover's lines carry their source.
const J = 1_000_000n;
type G = Awaited<ReturnType<typeof makeGroup>>;
let g: G;
const id = async (code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code } } })).id;
const post = async (month: number, day: number, dr: string, cr: string, amount: bigint, x: { kind?: "IMPORTED"; ledgerImportId?: string; sourceRef?: string } = {}) =>
  db.$transaction(async (tx) =>
    postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, month, day), kind: x.kind ?? "ADJUSTMENT", memo: `uji ${dr}`, ledgerImportId: x.ledgerImportId, lines: [{ accountId: await id(dr), debit: amount, sourceRef: x.sourceRef }, { accountId: await id(cr), credit: amount }] }),
  );

/** May–Jul usual months; August: sales +3,2 %, cost of sales +18 %, professional fees from 10 jt to 26 jt (one line from a ledger file). */
beforeEach(async () => {
  await resetDb();
  g = await makeGroup();
  for (const m of [5, 6, 7]) {
    await post(m, 5, "1130", "4100", 100n * J);
    await post(m, 6, "5100", "1130", 60n * J);
    await post(m, 7, "6130", "1130", 5n * J);
    await post(m, 8, "6170", "1130", 10n * J);
    await post(m, 9, "6160", "1130", 100_000n);
  }
  const gl = await db.ledgerImport.create({ data: { firmId: g.firm.id, clientId: g.client.id, fileName: "gl.xlsx", fileHash: "h", sheetName: "GL", mode: "LEDGER", status: "POSTED", periodStart: dateOnly(2026, 8, 1), periodEnd: dateOnly(2026, 8, 31), rowCount: 1, data: {} } });
  await post(8, 5, "1130", "4100", 103_200_000n);
  await post(8, 6, "5100", "1130", 70_800_000n);
  await post(8, 7, "6130", "1130", 5_500_000n);
  await post(8, 10, "6170", "2110", 12n * J, { kind: "IMPORTED", ledgerImportId: gl.id, sourceRef: "GL!12" });
  await post(8, 11, "6170", "1130", 8n * J);
  await post(8, 12, "6170", "1130", 5n * J);
  await post(8, 13, "6170", "1130", 1n * J);
  await post(8, 9, "6160", "1130", 100_000n);
});

const scope = () => ({ clientId: g.client.id, entityIds: [g.pt.entity.id] });
const k = () => ({ clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 8 });

describe("Wawasan: trend and margin", () => {
  it("every trend figure is a cell of Laba Rugi per bulan and every margin a cell of Rasio keuangan", async () => {
    const pl = await monthlyIncome(db, scope(), 2026, 8);
    const figures = pl.statements.map(figuresOf);
    const t = trend(pl.months, figures, "IDR");
    const net = t.metrics.find((x) => x.key === "netProfit")!;
    const netRow = pl.rows.find((r) => r.key === "net")!;
    expect(pl.months.map((m) => m.key)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08"]);
    expect([net.current, net.previous]).toEqual([netRow.values[3], netRow.values[2]]);
    expect(net.high.value).toBe(netRow.values.reduce((a, b) => (b > a ? b : a)));
    expect(t.metrics.find((x) => x.key === "revenue")!.current).toBe(pl.rows.find((r) => r.code === "4100")!.values[3]);

    const m = margins(figures, figuresOf(pl.ytd), pl.months);
    const r = ratios(pl, await monthlyBalance(db, scope(), 2026, 8));
    for (const key of ["gpm", "opm", "npm"] as const) {
      const row = r.find((x) => x.key === key)!;
      const mine = m.rows.find((x) => x.key === key)!;
      expect([mine.previous, mine.current]).toEqual(row.values.slice(2));
    }
    expect(m.sentence).toBe("Margin laba kotor turun 8,6 poin: beban pokok naik 18,0 %, pendapatan naik 3,2 %.");
    // The year to date is the total column's statement.
    expect(figuresOf(pl.ytd).netProfit).toBe(netRow.total);
  });
});

describe("Wawasan: Penggerak bulan ini", () => {
  it("follows Perubahan Akun, marks the flux control's accounts and lists each mover's largest lines with their source", async () => {
    const { movers, baseline } = await topMovers(db, k());
    expect(baseline).toEqual(["2026-05", "2026-06", "2026-07"]);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await managementWorkbook(db, { ...k(), meta: { firm: "KJA Uji", title: "PT Uji" } })) as unknown as ArrayBuffer);
    const pack: string[] = [];
    wb.getWorksheet("Perubahan Akun")!.eachRow((row) => {
      const code = String(row.getCell(1).value ?? "");
      if (/^\d{4}$/.test(code) && Number(row.getCell(5).value) !== 0) pack.push(code);
    });
    expect(pack).toEqual(["6170", "5100", "4100", "6130"]);
    expect(movers.map((x) => x.code)).toEqual(pack.slice(0, 5));
    expect(movers.some((x) => x.code === "6160")).toBe(false); // no difference, no mover

    const flux = (await runControls(db, g.client.id, 2026, 8)).find((c) => c.key === `flux:${g.pt.entity.id}`)!;
    const flagged = flux.detail.split("; ").map((p) => p.split(" ")[0]);
    expect(movers.filter((x) => x.flagged).map((x) => x.code)).toEqual(flagged);
    expect(flagged).toEqual(["6170"]);

    const fees = movers[0];
    expect(fees).toMatchObject({ current: 26n * J, average: 10n * J, delta: 16n * J, percent: "160,0 %", series: [10n * J, 10n * J, 10n * J, 26n * J] });
    expect(fees.lines.map((l) => [l.amount, l.source])).toEqual([[12n * J, "gl.xlsx · GL!12"], [8n * J, null], [5n * J, null]]);
  });

  it("a month with no P&L movement in it or its baseline has no movers", async () => {
    expect((await topMovers(db, { ...k(), month: 2 })).movers).toEqual([]);
  });
});
