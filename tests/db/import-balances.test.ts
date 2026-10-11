import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { importBalances, stageImport } from "@/lib/ledger-import/post";
import { dateOnly } from "@/lib/format";

beforeEach(resetDb);

describe("importBalances", () => {
  it("sums each source account's staged lines, debit-positive, per entity and code", async () => {
    const g = await makeGroup();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("31-05-2026");
    for (const r of [
      ["PT UJI"], ["Balance Sheet"], ["31/05/2026"], ["(in IDR)"], ["Date", null, "31/05/2026"], ["Assets"], ["Current Assets"], ["1-1000", "Bank", 900],
      ["Total Current Assets", null, 900], ["Other Assets"], ["1-1810", "Deposit", 100], ["Total Assets", null, 1000], ["Liability & Equity"], ["Current Liability"],
      ["2-2000", "Accounts Payable", 200], ["2-2100", "Loan from Bank", 100], ["Total Current Liability", null, 300], ["Long-term Liability"],
      ["2-2744", "Others Payables-Related Parties", 400], ["2-2783", "Employee Benefits Liabilities", 50], ["Total Long-term Liability", null, 450], ["Equity"],
      ["3-3000", "Share Capital", 250], ["Total Liability & Equity", null, 1000],
    ])
      ws.addRow(r);
    const st = await stageImport(db, { firmId: g.firm.id, clientId: g.client.id, fileName: "n.xlsx", data: Buffer.from(await wb.xlsx.writeBuffer()), entityId: g.pt.entity.id, date: dateOnly(2026, 5, 31) });
    if (st.status !== "STAGED") throw new Error("not staged");
    const b = await importBalances(db, st.importId);
    const of = (code: string) => b.get(`${g.pt.entity.id}|${code}`);
    expect(of("1-1000")).toBe(900n);
    expect(of("2-2000")).toBe(-200n); // a liability: credit, so negative
    expect(of("3-3000")).toBe(-250n);
  });
});
