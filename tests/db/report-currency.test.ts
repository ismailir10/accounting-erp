import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { extractText, getDocumentProxy } from "unpdf";
import { db, makeGroup, resetDb } from "../helpers";
import { postJournal } from "@/lib/ledger/post";
import { standardFormat, toUnit } from "@/lib/reports/format";
import { financialStatementsPdf } from "@/lib/reports/pdf";
import { excelAmount, financialStatementsWorkbook } from "@/lib/reports/workbook";
import { managementWorkbook } from "@/lib/reports/management-pack";
import { dateOnly } from "@/lib/format";

/**
 * A company whose books are kept in Singapore dollars (ADR 0006): its statements, PDF and management pack print dollars and cents under
 * "Dinyatakan dalam Dolar Singapura", never its sen as Rupiah.
 */
async function sgdBooks() {
  const g = await makeGroup();
  await db.entity.update({ where: { id: g.pt.entity.id }, data: { functionalCurrency: "SGD" } });
  const acc = async (code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code } } })).id;
  await db.$transaction(async (tx) => {
    const post = async (lines: [string, bigint, bigint][]) =>
      postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, 3, 15), kind: "ADJUSTMENT", memo: "uji", lines: await Promise.all(lines.map(async ([c, d, k]) => ({ accountId: await acc(c), debit: d, credit: k }))) });
    await post([["1110", 1_234_567n, 0n], ["3100", 0n, 1_234_567n]]); // S$ 12.345,67
    await post([["1130", 50_050n, 0n], ["4100", 0n, 50_050n]]); // S$ 500,50
  });
  return { g, scope: { clientId: g.client.id, entityIds: [g.pt.entity.id] } };
}
const cells = (ws: ExcelJS.Worksheet) => {
  const out: unknown[] = [];
  ws.eachRow((r) => (r.values as unknown[]).forEach((v) => out.push(v && typeof v === "object" && "result" in (v as object) ? (v as { result: unknown }).result : v)));
  return out;
};

describe("reports in the company's own currency", () => {
  beforeEach(resetDb);

  it("the Excel set writes dollars with cents and names the currency", async () => {
    const { scope } = await sgdBooks();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await financialStatementsWorkbook(db, scope, 2026, 3, { firm: "KJA Uji", title: "PT Uji" })) as unknown as ArrayBuffer);
    const neraca = wb.getWorksheet("Neraca")!;
    expect(neraca.getRow(4).getCell(1).value).toBe("Dinyatakan dalam Dolar Singapura");
    expect(cells(neraca)).toContain(12345.67);
    expect(cells(neraca)).not.toContain(1234567);
    expect(cells(wb.getWorksheet("Laba Rugi")!)).toContain(500.5);
    expect(wb.getWorksheet("CALK")!.getRow(4).getCell(1).value).toBe("Dinyatakan dalam Dolar Singapura");
  });

  it("the PDF prints S$ amounts with cents, and thousands of dollars in the ribuan format", async () => {
    const { g, scope } = await sgdBooks();
    const read = async () => (await extractText(await getDocumentProxy(new Uint8Array(await financialStatementsPdf(db, scope, 2026, 3, { firm: "KJA Uji", title: "PT Uji" }))), { mergePages: true })).text;
    const full = await read();
    expect(full).toContain("Dinyatakan dalam Dolar Singapura");
    expect(full).toContain("12.345,67");
    expect(full).not.toContain("Dinyatakan dalam Rupiah");
    const mine = standardFormat();
    mine.unit = "RIBUAN";
    await db.reportFormat.create({ data: { firmId: g.firm.id, clientId: g.client.id, format: mine } });
    const thousands = await read();
    expect(thousands).toContain("Dinyatakan dalam ribuan Dolar Singapura");
    expect(thousands).toContain("12,00"); // S$ 12.345,67 in thousands
  });

  it("the management pack names the currency and writes dollars", async () => {
    const { g } = await sgdBooks();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await managementWorkbook(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 3, meta: { firm: "KJA Uji", title: "PT Uji" } })) as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    expect(ws.getRow(4).getCell(1).value).toBe("Dinyatakan dalam Dolar Singapura");
    expect(cells(ws)).toContain(500.5);
  });

  it("converts exactly, signed, and keeps Rupiah as it was", () => {
    expect([excelAmount(123_456n, "SGD"), excelAmount(-5n, "SGD"), excelAmount(1_234n, "IDR"), excelAmount(-1_234n), excelAmount(1_000n, "JPY")]).toEqual([1234.56, -0.05, 1234, -1234, 1000]);
    // 90.071.992.547.409,93: the whole part fits a double but the cents don't, so it stays exact text.
    expect([excelAmount(9_007_199_254_740_993n, "SGD"), excelAmount(9_007_199_254_740_991n, "SGD")]).toEqual(["90071992547409.93", 90071992547409.91]);
    expect([toUnit(1_234_567n, "RIBUAN"), toUnit(1_234_567n, "RIBUAN", 2), toUnit(-150_000n, "RIBUAN", 2), toUnit(77n, "RUPIAH", 2)]).toEqual([1_235n, 1_200n, -200n, 77n]);
  });
});
