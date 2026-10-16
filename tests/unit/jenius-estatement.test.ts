import { describe, expect, it } from "vitest";
import { parseStatementSections } from "@/lib/import/parsers";
import { checkContinuity } from "@/lib/import/normalize";
import { PdfPasswordError } from "@/lib/import/parsers/pdf";
import { jeniusEstatementPdf, makePdf, type JeniusRow } from "../pdf-fixture";

/**
 * Jenius e-Statement, 2025 layout (fixture: tests/pdf-fixture.ts `jeniusEstatementPdf`, fictional content). No running-balance
 * column: the printed Previous Balance and Ending Balance are the evidence, the signed amounts carry the direction.
 */
const ROWS: JeniusRow[] = [
  { date: "01 Aug 2026", details: ["Transfer dari NASABAH FIKTIF", "PT Bank Contoh Tbk dari NASABAH FIKTIF"], amount: 2_500_000 },
  { date: "03 Aug 2026", details: ["Pembayaran QRIS Toko Fiktif"], amount: -125_000, note: "Makan 4821" },
  { date: "03 Aug 2026", details: ["Biaya Admin"], amount: -2_500, type: "" },
  { date: "03 Aug 2026", details: ["Biaya Admin"], amount: -2_500, type: "" },
  { date: "12 Aug 2026", details: ["Kartu Debit Toko Daring", "**** **** **** 4321 Transaction in USD (9.99 USD x 16.250)"], amount: -162_338 },
  { date: "20 Aug 2026", details: ["Transfer ke REKENING FIKTIF", "REF - 88123456"], amount: -1_000_000 },
  { date: "31 Aug 2026", details: ["Bunga"], amount: 1_234 },
];
const OPENING = 10_000_000;
const CLOSING = ROWS.reduce((t, r) => t + r.amount, OPENING);

async function read(buf: Buffer, password?: string) {
  const sections = await parseStatementSections("jenius-2025.pdf", buf, { password });
  expect(sections).toHaveLength(1);
  return sections[0];
}

describe("Jenius e-Statement (2025 layout)", () => {
  it.each([["summary page first", false], ["transactions on page 1", true]])("reads account, declared period, printed balances and every row (%s)", async (_label, inline) => {
    const st = await read(jeniusEstatementPdf({ rows: ROWS, opening: OPENING, inline }));
    expect(st.format).toBe("SMBC");
    expect(st.accountNumber).toBe("90012345678");
    expect([st.periodStart.toISOString().slice(0, 10), st.periodEnd.toISOString().slice(0, 10)]).toEqual(["2026-08-01", "2026-08-31"]);
    expect(st.provenance).toEqual({ period: "DECLARED", opening: "PRINTED", closing: "PRINTED" });
    expect(st.openingBalance).toBe(BigInt(OPENING));
    expect(st.closingBalance).toBe(BigInt(CLOSING));
    expect(st.rows.map((r) => [r.date.toISOString().slice(0, 10), r.amount])).toEqual(ROWS.map((r) => [`2026-08-${r.date.slice(0, 2)}`, BigInt(r.amount)]));
    expect(st.rows.every((r) => r.balance === null)).toBe(true);
    st.rows.forEach((r, i) => expect(r.description.startsWith(ROWS[i].details[0]), r.description).toBe(true));
    // The time under the date is no part of the description.
    expect(st.rows.some((r) => /\b09:15\b/.test(r.description))).toBe(false);
    expect(checkContinuity(st).ok).toBe(true);
    expect(st.notes ?? []).toEqual([]);
    // The cards table's "Name · Card Number" labels name no holder.
    expect(st.holder).toBeUndefined();
  });

  it("reads the account number and period when a separator is printed close beside them", async () => {
    const st = await read(makePdf([[
      { x: 50, y: 800, text: "Account Number" }, { x: 105, y: 800, text: "•" }, { x: 525, y: 800, text: "Period" },
      { x: 50, y: 788, text: "90011122233" }, { x: 99, y: 788, text: "•" }, { x: 500, y: 788, text: "– August 2026" },
      { x: 125, y: 760, text: "PT Bank SMBC Indonesia Tbk" },
      { x: 50, y: 740, text: "Date & Time" }, { x: 125, y: 740, text: "Details" }, { x: 300, y: 740, text: "Notes" }, { x: 525, y: 740, text: "Amount" },
      { x: 125, y: 728, text: "Previous Balance" }, { x: 525, y: 728, text: "1,000" },
      { x: 50, y: 716, text: "05 Aug 2026" }, { x: 125, y: 716, text: "Setoran fiktif" }, { x: 530, y: 716, text: "+500" },
      { x: 125, y: 700, text: "Ending Balance" }, { x: 525, y: 700, text: "1,500" },
    ]]));
    expect([st.accountNumber, st.periodStart.toISOString().slice(0, 10), st.provenance?.period]).toEqual(["90011122233", "2026-08-01", "DECLARED"]);
  });

  it("knows the bank by its own header only when nothing above the table names one", async () => {
    // Same English labels plus a balance column: another layout, not identified as Jenius.
    const other = makePdf([[
      { x: 40, y: 800, text: "Statement" }, { x: 40, y: 780, text: "Period : 01 Aug 2026 - 31 Aug 2026" }, { x: 40, y: 768, text: "Opening Balance 1,000" },
      { x: 40, y: 740, text: "Date & Time" }, { x: 120, y: 740, text: "Details" }, { x: 300, y: 740, text: "Notes" }, { x: 420, y: 740, text: "Amount" }, { x: 520, y: 740, text: "Balance" },
      { x: 40, y: 728, text: "01 Aug 2026" }, { x: 120, y: 728, text: "Setoran fiktif" }, { x: 420, y: 728, text: "+500" }, { x: 520, y: 728, text: "1,500" },
    ]]);
    expect((await read(other)).format).toBe("GENERIC");
  });

  it("keeps same-day identical fees as two rows", async () => {
    const st = await read(jeniusEstatementPdf({ rows: ROWS, opening: OPENING }));
    expect(st.rows.filter((r) => r.description.startsWith("Biaya Admin") && r.amount === -2_500n)).toHaveLength(2);
  });

  it("never takes a note's reference number or a card's foreign-currency figures for the amount", async () => {
    const st = await read(jeniusEstatementPdf({ rows: ROWS, opening: OPENING }));
    expect(st.rows[1].amount).toBe(-125_000n);
    expect(st.rows[1].description).toContain("Makan 4821");
    expect(st.rows[4].amount).toBe(-162_338n);
    expect(st.rows[4].description).toContain("Transaction in USD");
  });

  it("reads a month over several pages: the repeated header and sub-header are no rows", async () => {
    const many: JeniusRow[] = Array.from({ length: 45 }, (_, i) => ({ date: `${String(1 + (i % 28)).padStart(2, "0")} Aug 2026`, details: [`Pembayaran Fiktif ${i + 1}`], amount: i % 4 === 0 ? 300_000 : -(10_000 + i * 1_000) }));
    many.sort((a, b) => a.date.localeCompare(b.date));
    const st = await read(jeniusEstatementPdf({ rows: many, opening: OPENING, rowsPerPage: 12 }));
    expect(st.rows).toHaveLength(45);
    expect(st.rows.map((r) => r.amount)).toEqual(many.map((r) => BigInt(r.amount)));
    expect(st.rows.some((r) => /Date & Time|Transaction Name|Previous Balance|Ending Balance/.test(r.description))).toBe(false);
    expect(checkContinuity(st).ok).toBe(true);
  });

  it("reads a month without incoming money", async () => {
    const out = ROWS.filter((r) => r.amount < 0);
    const st = await read(jeniusEstatementPdf({ rows: out, opening: OPENING, inline: true }));
    expect(st.rows.map((r) => r.amount)).toEqual(out.map((r) => BigInt(r.amount)));
    expect(checkContinuity(st).ok).toBe(true);
  });

  it("shows a broken chain: the printed ending balance is kept, never overwritten by the rows", async () => {
    const st = await read(jeniusEstatementPdf({ rows: ROWS, opening: OPENING, closing: CLOSING + 1_000 }));
    expect(st.closingBalance).toBe(BigInt(CLOSING + 1_000));
    expect(checkContinuity(st).ok).toBe(false);
  });

  it("opens a password-protected statement only with its password", async () => {
    const buf = jeniusEstatementPdf({ rows: ROWS, opening: OPENING, userPassword: "fiktif-0101" });
    expect((await read(buf, "fiktif-0101")).rows).toHaveLength(ROWS.length);
    await expect(parseStatementSections("jenius-2025.pdf", buf, {})).rejects.toBeInstanceOf(PdfPasswordError);
  });

  it("still refuses a PDF that is no statement, with today's message", async () => {
    const junk = makePdf([[{ x: 40, y: 800, text: "Undangan rapat koperasi fiktif" }, { x: 40, y: 780, text: "Details of the agenda" }]]);
    await expect(parseStatementSections("junk.pdf", junk, {})).rejects.toThrow(/tidak dikenali/);
  });
});
