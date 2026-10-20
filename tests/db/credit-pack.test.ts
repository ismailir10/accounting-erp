import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { postJournal } from "@/lib/ledger/post";
import { receiptsRatio, receiptsVsRevenue, sourceTrail } from "@/lib/reports/credit";
import { dateOnly } from "@/lib/format";

// Paket Kredit Bank (I4a): money in by how it was classified, against revenue; and where every journal line came from.
type G = Awaited<ReturnType<typeof makeGroup>>;
let g: G;
let n = 0;

beforeEach(async () => {
  await resetDb();
  g = await makeGroup();
});

async function line(month: number, amount: bigint, accountCode: string | null, status: "POSTED" | "NEEDS_REVIEW" | "REVIEWED" = "POSTED", splits: { accountCode: string; amount: bigint }[] = []) {
  const bank = g.pt.banks[0];
  const imp = await db.statementImport.upsert({
    where: { id: `imp-${month}` },
    create: { id: `imp-${month}`, firmId: g.firm.id, bankAccountId: bank.id, fileName: `bca-${month}.csv`, format: "BCA", periodStart: dateOnly(2026, month, 1), periodEnd: dateOnly(2026, month + 1, 0), openingBalance: 0n, closingBalance: 0n, rowCount: 1, continuityOk: true },
    update: {},
  });
  n++;
  return db.bankTransaction.create({
    data: {
      firmId: g.firm.id, importId: imp.id, bankAccountId: bank.id, entityId: g.pt.entity.id, date: dateOnly(2026, month, 10), description: `L${n}`, merchantKey: `L${n}`,
      direction: amount > 0n ? "IN" : "OUT", amount, rowNumber: n, rawRow: "x", hash: `h${n}`, status, method: "RULE", confidence: 1, reason: "uji", accountCode,
      splits: splits.length ? { create: splits.map((s, i) => ({ firmId: g.firm.id, position: i, accountCode: s.accountCode, amount: s.amount })) } : undefined,
    },
  });
}
const code = async (c: string) => (await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code: c } })).id;
const sale = async (month: number, amount: bigint) =>
  db.$transaction(async (tx) => postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, month, 10), kind: "ADJUSTMENT", memo: "penjualan", lines: [{ accountId: await code("1130"), debit: amount }, { accountId: await code("4100"), credit: amount }] }));

describe("receiptsVsRevenue", () => {
  it("sets transfers, loans & capital and unclassified lines apart; a split counts by its parts; payments out are ignored", async () => {
    await line(7, 1_110_000n, "1130"); // a customer pays (incl. PPN)
    await line(7, 500_000n, "1199"); // own-account transfer in
    await line(7, 2_000_000n, "2210"); // loan drawdown
    await line(7, 300_000n, "1999", "NEEDS_REVIEW");
    await line(7, 400_000n, "4100", "NEEDS_REVIEW"); // a suggestion still in Review is not classified yet
    await line(7, 600_000n, null, "POSTED", [{ accountCode: "4100", amount: 450_000n }, { accountCode: "3100", amount: 150_000n }]);
    await line(7, -250_000n, "6190"); // money out: not a receipt
    await sale(7, 1_000_000n);

    const [jul] = await receiptsVsRevenue(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 7 });
    expect(jul).toEqual({ year: 2026, month: 7, moneyIn: 4_910_000n, transfers: 500_000n, financing: 2_150_000n, disposals: 0n, unclassified: 700_000n, operating: 1_560_000n, revenue: 1_000_000n });
    expect(receiptsRatio(jul)).toBe(1560n);
  });

  it("covers twelve months back but not before the first bank line", async () => {
    await line(5, 100n, "1130");
    await line(8, 100n, "1130");
    const months = await receiptsVsRevenue(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 8 });
    expect(months.map((m) => m.month)).toEqual([5, 6, 7, 8]);
    expect(receiptsRatio(months[1])).toBeNull(); // no revenue in June
  });

  it("is empty for a company with no bank lines", async () => {
    expect(await receiptsVsRevenue(db, { clientId: g.client.id, entityId: g.owner.entity.id, year: 2026, month: 8 })).toEqual([]);
  });
});

describe("sourceTrail", () => {
  it("counts each account's journal lines by where they came from", async () => {
    await sale(7, 1_000n);
    await sale(7, 2_000n);
    const rows = await sourceTrail(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 7 });
    const sales = rows.find((r) => r.code === "4100")!;
    expect(sales).toMatchObject({ balance: -3_000n, bank: 0, ledger: 0, opening: 0, other: 2 });
    expect(rows.map((r) => r.code)).toEqual(["1130", "4100"]);
  });
});

describe("creditPackWorkbook", () => {
  it("opens on Ringkasan, carries the statement set and the pack's sheets with the figures from the books", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const { creditPackWorkbook } = await import("@/lib/reports/credit-pack");
    await line(7, 1_110_000n, "1130");
    await sale(7, 1_000_000n);
    const buf = await creditPackWorkbook(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 7, meta: { firm: "KJA Uji", title: "PT Uji Sejahtera", draft: "bulan belum ditutup." } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const names = wb.worksheets.map((w) => w.name);
    expect(names[0]).toBe("Ringkasan");
    expect(names).toEqual(expect.arrayContaining(["Mutasi vs Omzet", "Umur Piutang", "Umur Utang", "Aset Tetap", "Jejak Sumber"]));
    expect(names.length).toBeGreaterThan(6); // the statement set sits between Ringkasan and the pack's sheets
    const values = (name: string) => wb.getWorksheet(name)!.getSheetValues().flat().filter((v) => v !== null && v !== undefined);
    expect(values("Ringkasan")).toContain(1_000_000); // Pendapatan year to date
    const jul = wb.getWorksheet("Mutasi vs Omzet")!.getSheetValues().find((r) => Array.isArray(r) && r[1] === "Juli 2026") as unknown[];
    expect(jul.slice(1, 10)).toEqual(["Juli 2026", 1_110_000, 0, 0, 0, 0, 1_110_000, 1_000_000, 1.11]);
    expect(values("Umur Piutang").join(" ")).toContain("Tidak ada piutang terbuka");
    expect(values("Ringkasan").join(" ")).toContain("DRAF — bulan belum ditutup.");
  });
});
