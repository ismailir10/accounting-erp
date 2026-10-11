import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { previewFile } from "@/lib/inbox/check";
import { proposeClient } from "@/lib/inbox/propose";

/** The production walk of #149 (2026-10-11): what *Tambah klien* reads out of real ledger and Neraca workbooks, through the real preview. */
beforeEach(resetDb);

async function book(sheets: Record<string, (string | number | Date | null)[][]>) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const NERACA = (company: string) => [
  [company], ["Balance Sheet"], ["31/05/2026"], ["(in IDR)"],
  ["Date", null, "31/05/2026"],
  ["Assets"],
  ["Current Assets"],
  ["1-1000", "Bank", 900],
  ["Total Current Assets", null, 900],
  ["Other Assets"],
  ["1-1810", "Deposit", 100],
  ["Total Assets", null, 1000],
  ["Liability & Equity"],
  ["Current Liability"],
  ["2-2000", "Accounts Payable", 200],
  ["2-2100", "Loan from Bank", 100],
  ["Total Current Liability", null, 300],
  ["Long-term Liability"],
  ["2-2744", "Others Payables-Related Parties", 400],
  ["2-2783", "Employee Benefits Liabilities", 50],
  ["Total Long-term Liability", null, 450],
  ["Equity"],
  ["3-3000", "Share Capital", 250],
  ["Total Liability & Equity", null, 1000],
];
const GL = (entities: string[]) => [
  ["Entity", "Entry Date", "Account Code", "Account Name", "Currency", "Debit", "Credit"],
  ...entities.flatMap((e, i): (string | number | Date)[][] => [
    [e, new Date(Date.UTC(2024, 0, 31 + i)), "10000", "Kas", "IDR", 1000, 0],
    [e, new Date(Date.UTC(2024, 0, 31 + i)), "31001", "Modal", "IDR", 0, 1000],
  ]),
];

describe("Tambah klien reads companies out of ledger files", () => {
  it("a Jurnal.id Neraca names its company in the first title row (Goers)", async () => {
    const g = await makeGroup();
    const p = await previewFile(db, { firmId: g.firm.id, name: "balance_sheet.xlsx", data: await book({ "31-05-2026": NERACA("SANRAYA ADI NATTAYA") }) });
    expect(p).toMatchObject({ kind: "LEDGER", companyName: "SANRAYA ADI NATTAYA" });
    expect(proposeClient([p]).entities.map((e) => e.name)).toEqual(["Sanraya Adi Nattaya"]);
  });

  it("a multi-sheet, multi-entity workbook proposes every entity of its ledger sheets (Chickin)", async () => {
    const g = await makeGroup();
    const data = await book({ "04_HC_2022_FOUNDATION": NERACA("CHICKIN"), "10_HC_GL_MASTER": GL(["HOLDCO"]), "20_OPCO_GL_MASTER": GL(["SKP", "SPN", "CSP", "CAH"]) });
    const p = await previewFile(db, { firmId: g.firm.id, name: "chickin.xlsx", data });
    expect(p.kind).toBe("LEDGER");
    expect(p.companyName).toBeUndefined(); // entity labels name the companies; no second guess from a title
    const proposal = proposeClient([p]);
    expect(proposal.entities.map((e) => e.shortName)).toEqual(["HOLDCO", "SKP", "SPN", "CSP", "CAH"]);
    expect(proposal.entities.some((e) => e.fromClientName)).toBe(false);
  });

  it("a ledger with a single unlabeled entity and no title keeps the client's own name (unchanged)", async () => {
    const g = await makeGroup();
    const rows = [
      ["Entry Date", "Account Code", "Account Name", "Debit", "Credit"],
      [new Date(Date.UTC(2024, 0, 31)), "10000", "Kas", 1000, 0],
      [new Date(Date.UTC(2024, 0, 31)), "31001", "Modal", 0, 1000],
    ];
    const p = await previewFile(db, { firmId: g.firm.id, name: "gl.xlsx", data: await book({ GL: rows }) });
    expect(p.companyName).toBeUndefined();
    expect(proposeClient([p]).entities).toMatchObject([{ fromClientName: true, name: "" }]);
  });
});
