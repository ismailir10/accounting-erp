import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { detectTables, readSheets, readTable, reportKind } from "@/lib/ledger-import/read";
import { htmlXls, workbook as legacyWorkbook } from "@/tests/xls-fixture";

async function workbook(sheets: Record<string, unknown[][]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const GL_HEADER = ["Entity", "GL Entry ID", "Entry Date", "Account Code", "Account Name", "Currency", "Debit", "Credit", "Reconstruction Logic / Description", "Notes"];

describe("ledger reader", () => {

  it("keeps an amount written beyond sen exactly, with the Neraca's sign (F1, 2026-10-12)", async () => {
    const buf = await workbook({ N: [["PT Uji"], ["Balance Sheet"], ["Date", null, "31/05/2026"], ["Assets"], ["1-1000", "Bank", 2000], ["Total Assets", null, 2000], ["Liability & Equity"], ["2-2000", "Accounts Payable", 1000.497123], ["3-3000", "Share Capital", 999.502877], ["Total Liability & Equity", null, 2000]] });
    const sheets = await readSheets("neraca.xlsx", buf);
    const res = readTable(sheets, detectTables(sheets)[0]);
    const by = Object.fromEntries((res.rows as { code: string; exact?: bigint }[]).map((r) => [r.code, r.exact]));
    expect(by).toEqual({ "1-1000": undefined, "2-2000": -1_000_497_123n, "3-3000": -999_502_877n });
  });
  it("finds a multi-entity, multi-currency ledger sheet among others and keeps row refs", async () => {
    const buf = await workbook({
      README: [["Topic", "Definition"], ["GL", "single source of truth"]],
      GL_MASTER: [
        ["OPCO GL MASTER"],
        ["banner text"],
        GL_HEADER,
        ["SKP", "SKP-1", new Date(Date.UTC(2023, 0, 31)), "10000", "Petty Cash", "IDR", 1000.5, 0, "opening", ""],
        ["SKP", "SKP-2", new Date(Date.UTC(2023, 0, 31)), "31001", "Modal", "IDR", 0, 1000.5, "opening", ""],
        ["HOLDCO", "HC-1", "03/01/2023", "10001", "Bank OCBC USD", "USD", 150000, 0, "Loan", "Ref: JAN23-02; Rate: 1.31"],
        ["HOLDCO", "HC-2", "03/01/2023", "20000", "Loan Payable", "SGD", "", "150,000.00", "Loan", ""],
        ["CSP", "CSP-1", "31/03/2023", "11141", "Other Receivable", "IDR", { error: "#VALUE!" }, 0, "broken", ""],
        [],
      ],
    });
    const sheets = await readSheets("chickin.xlsx", buf);
    const cands = detectTables(sheets);
    expect(cands.map((c) => [c.sheet, c.mode])).toEqual([["GL_MASTER", "LEDGER"]]);
    const res = readTable(sheets, cands[0]);
    if (res.mode !== "LEDGER") throw new Error("mode");
    expect(res.rows).toHaveLength(5);
    expect(res.rows[0]).toMatchObject({ ref: "GL_MASTER!4", entity: "SKP", code: "10000", debit: 100050n, credit: 0n, currency: "IDR" });
    expect(res.rows[0].date?.toISOString().slice(0, 10)).toBe("2023-01-31");
    expect(res.rows[2]).toMatchObject({ currency: "USD", rate: "1.31", debit: 15_000_000n });
    expect(res.rows[3]).toMatchObject({ credit: 15_000_000n, debit: 0n });
    expect(res.rows[4].errors).toEqual(["debit bukan angka: #VALUE!"]);
  });

  it("moves negative amounts to the other side and flags missing dates", async () => {
    const buf = await workbook({ GL: [["Tanggal", "Kode Akun", "Nama Akun", "Debet", "Kredit"], ["", "1110", "Kas", -500, 0]] });
    const sheets = await readSheets("gl.xlsx", buf);
    const res = readTable(sheets, detectTables(sheets)[0]);
    if (res.mode !== "LEDGER") throw new Error("mode");
    expect(res.rows[0]).toMatchObject({ debit: 0n, credit: 50_000n, errors: ["tanggal kosong"] });
  });

  it("reads CSV ledgers", async () => {
    const csv = "No. Bukti;Tanggal;Kode Akun;Nama Akun;Debit;Kredit;Keterangan\nJV-1;31/01/2026;1110;Kas;1.500.000,00;0;Setor\nJV-1;31/01/2026;3100;Modal;0;1.500.000,00;Setor\n";
    const sheets = await readSheets("gl.csv", Buffer.from(csv));
    const res = readTable(sheets, detectTables(sheets)[0]);
    if (res.mode !== "LEDGER") throw new Error("mode");
    expect(res.rows.map((r) => [r.voucher, r.code, r.debit, r.credit])).toEqual([
      ["JV-1", "1110", 150_000_000n, 0n],
      ["JV-1", "3100", 0n, 150_000_000n],
    ]);
  });

  it("reads a legacy .xls and an HTML table saved as .xls like an .xlsx", async () => {
    const aoa = [["Tanggal", "Kode Akun", "Nama Akun", "Debit", "Kredit"], ["31/08/2026", "1110", "Kas", "150.000.000,00", "0"], ["31/08/2026", "3100", "Modal", "0", "150.000.000,00"]];
    for (const data of [legacyWorkbook([{ name: "GL", rows: aoa }], "biff8"), htmlXls(aoa)]) {
      const sheets = await readSheets("gl-lama.xls", data);
      const res = readTable(sheets, detectTables(sheets)[0]);
      if (res.mode !== "LEDGER") throw new Error("mode");
      // Sen at this stage (the reader keeps cents until the entity currency is known).
      expect(res.rows.map((r) => [r.code, r.debit, r.credit])).toEqual([["1110", 15_000_000_000n, 0n], ["3100", 0n, 15_000_000_000n]]);
    }
  });

  it("explains a PDF and an unreadable .xls", async () => {
    await expect(readSheets("gl.pdf", Buffer.from("%PDF-1.7"))).rejects.toThrow(/PDF tidak bisa dibaca sebagai buku besar/);
    await expect(readSheets("old.xls", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]))).rejects.toThrow(/simpan sebagai \.xlsx/);
  });
});

describe("Neraca reader (Jurnal-style export)", () => {
  it("reads codes, sections, uncoded equity rows and totals", async () => {
    const buf = await workbook({
      "31-05-2026": [
        ["PT CONTOH"],
        ["Balance Sheet"],
        ["(in IDR)"],
        ["Date", "", "31/05/2026", ""],
        ["Assets"],
        ["Current Assets"],
        ["1-1000", "BANK", 1000.6039, ""],
        ["1-1200", "Account Receivable", 500, ""],
        ["Total Current Assets", null, 1500.6039, ""],
        ["1-1801", "Accumulated Depreciation", -100, ""],
        ["Total Assets", null, 1400.6039, ""],
        ["Liability & Equity"],
        ["Current Liability"],
        ["2-2000", "Accounts Payable", 400, ""],
        ["Long-term Liability"],
        ["2-2744", "Others Payables-Related Parties", 300, ""],
        ["Equity"],
        ["3-3000", "Share Capital", 1000, ""],
        [null, "Current Period Earnings", -299.4, ""],
        [null, "Earnings up to Last Period", 0, ""],
        ["Total Liability & Equity", null, 1400.6039, ""],
      ],
    });
    const sheets = await readSheets("balance_sheet.xlsx", buf);
    const cands = detectTables(sheets);
    expect(cands).toHaveLength(1);
    const res = readTable(sheets, cands[0]);
    if (res.mode !== "NERACA") throw new Error("mode");
    expect(res.date?.toISOString().slice(0, 10)).toBe("2026-05-31");
    expect(res.rows.map((r) => [r.code, r.amount, r.typeHint])).toEqual([
      ["1-1000", 100_060n, "ASET"],
      ["1-1200", 50_000n, "ASET"],
      ["1-1801", -10_000n, "ASET"],
      ["2-2000", -40_000n, "LIABILITAS"],
      ["2-2744", -30_000n, "LIABILITAS"],
      ["3-3000", -100_000n, "EKUITAS"],
      ["NC:Current Period Earnings", 29_940n, "EKUITAS"],
    ]);
    expect(res.totals.filter((t) => t.kind !== "OTHER").map((t) => [t.kind, t.amount])).toEqual([
      ["ASSETS", 140_060n],
      ["LIAB_EQUITY", 140_060n],
    ]);
  });

  it("types rows under asset sub-headings as ASET when the Neraca starts without an Assets row", async () => {
    const buf = await workbook({
      "31-05-2026": [
        ["PT CONTOH"],
        ["Balance Sheet"],
        ["Date", "", "31/05/2026", ""],
        ["Current Assets"],
        ["1-1000", "BANK", 1000, ""],
        ["Fixed Assets"],
        ["2-1500", "Kendaraan", 800, ""],
        ["Intangible Assets"],
        ["9-0001", "Software", 200, ""],
        ["Total Assets", null, 2000, ""],
        ["Liability & Equity"],
        ["2-2000", "Accounts Payable", 1000, ""],
        ["Equity"],
        ["3-3000", "Share Capital", 1000, ""],
        ["Total Liability & Equity", null, 2000, ""],
      ],
    });
    const sheets = await readSheets("balance_sheet.xlsx", buf);
    const res = readTable(sheets, detectTables(sheets)[0]);
    if (res.mode !== "NERACA") throw new Error("mode");
    // A 2-prefixed code under Fixed Assets is still an asset, never a liability guessed from its numbering.
    expect(res.rows.map((r) => [r.code, r.amount, r.typeHint, r.termHint])).toEqual([
      ["1-1000", 100_000n, "ASET", "CURRENT"],
      ["2-1500", 80_000n, "ASET", "NON_CURRENT"],
      ["9-0001", 20_000n, "ASET", "NON_CURRENT"],
      ["2-2000", -100_000n, "LIABILITAS", null],
      ["3-3000", -100_000n, "EKUITAS", null],
    ]);

    // Opening with a long-term asset sub-heading, then moving to the current ones: each row takes its own heading's term.
    const opens = await workbook({
      "31-05-2026": [
        ["Date", "", "31/05/2026", ""],
        ["Tangible Assets"], ["2-1500", "Kendaraan", 800, ""],
        ["Current Assets"], ["1-1000", "BANK", 700, ""],
        ["Intangible Assets"], ["1-1900", "Lisensi", 500, ""],
        ["Current Asset"], ["1-1100", "Kas Kecil", 100, ""],
        ["Other Asset"], ["1-1810", "Deposit", 100, ""],
        ["Total Assets", null, 2200, ""],
        ["Liability & Equity"], ["2-2000", "Accounts Payable", 2200, ""],
        ["Total Liability & Equity", null, 2200, ""],
      ],
    });
    const s2 = await readSheets("balance_sheet.xlsx", opens);
    const res2 = readTable(s2, detectTables(s2)[0]);
    if (res2.mode !== "NERACA") throw new Error("mode");
    expect(res2.rows.map((r) => [r.code, r.typeHint, r.termHint])).toEqual([
      ["2-1500", "ASET", "NON_CURRENT"],
      ["1-1000", "ASET", "CURRENT"],
      ["1-1900", "ASET", "NON_CURRENT"],
      ["1-1100", "ASET", "CURRENT"],
      ["1-1810", "ASET", "NON_CURRENT"], // singular "Other Asset" after a current heading
      ["2-2000", "LIABILITAS", null],
    ]);
  });
});

describe("report exports that aren't a ledger or a Neraca", () => {
  it("never reads a Jurnal-style Profit & Loss or cash flow as a Neraca, and names what it is", async () => {
    const buf = await workbook({
      "01-05-2026_31-05-2026": [
        ["PT CONTOH"],
        ["Profit & Loss"],
        ["01/05/2026 - 31/05/2026"],
        ["(in IDR)"],
        ["Date", "", "31/05/2026", ""],
        ["4-4000", "Revenue", 1000, ""],
        ["5-5000", "Cost of Revenue", 400, ""],
        ["6-6000", "Salaries", 300, ""],
      ],
      Kas: [["PT CONTOH"], ["Arus Kas"], ["01/01/2026 - 31/05/2026"], ["Account & Categories", null, "01/01/2026 - 31/05/2026"], ["1-1000", "Bank", 5, ""], ["1-1001", "Kas", 5, ""], ["1-1002", "Giro", 5, ""]],
    });
    const sheets = await readSheets("profit_loss.xlsx", buf);
    expect(sheets.map(reportKind)).toEqual(["LABA_RUGI", "ARUS_KAS"]);
    expect(detectTables(sheets)).toEqual([]);
  });
  /** An ERP "Balance Sheet Report": Aset on the left, Kewajiban + Ekuitas on the right, spaced 4-level codes, group rows at 0.00. */
  const PANEL_HEADER = ["Account", "Level", "Description", "Value", null, "Account", "Level", "Description", "Value"];
  const left: unknown[][] = [
    ["1 0 00 00", 1, "Aset", "0.00"],
    ["1 1 00 00", 2, "Aset Lancar", "0.00"],
    ["1 1 01 00", 3, "Kas", "0.00"],
    ["1 1 01 01", 4, "Kas Kecil", "1,000,000.00"],
    ["1 1 01 02", 4, "BCA 1234", "9,000,000.00"],
    [null, null, "Total Kas", "10,000,000.00"],
    ["1 2 00 00", 2, "Aset Tidak Lancar", "0.00"],
    ["1 2 01 00", 3, "Aset Tetap", "0.00"],
    ["1 2 01 01", 4, "Inventaris", "5,000,000.00"],
    ["1 2 02 01", 4, "Akumulasi Penyusutan - Inventaris", "-2,000,000.00"],
    [null, null, "Total Aset", "13,000,000.00"],
  ];
  const right: unknown[][] = [
    ["2 0 00 00", 1, "Kewajiban", "0.00"],
    ["2 1 00 00", 2, "Kewajiban Lancar", "0.00"],
    ["2 1 03 00", 3, "Hutang Pajak", "0.00"],
    ["2 1 03 03", 4, "Pph 21", "-200,000.00"],
    ["2 1 03 04", 4, "Ppn Keluaran", "500,000.00"],
    [null, null, "Total Hutang Pajak", "300,000.00"],
    ["3 0 00 00", 1, "Ekuitas", "0.00"],
    ["3 1 01 00", 3, "Modal Disetor", "0.00"],
    ["3 1 01 01", 4, "Modal Disetor", "8,000,000.00"],
    ["3 1 05 01", 4, "Laba Ditahan", "4,700,000.00"],
    [null, null, "Total Pasiva", "13,000,000.00"],
  ];
  const panelRows = [...left.map((l, i) => [...l, null, ...(right[i] ?? [])].slice(0, 9)), ...right.slice(left.length).map((r) => [null, null, null, null, null, ...r])];
  const panelBook = () =>
    workbook({
      BS: [["BS Balance Sheet Report"], ["PT Uji Kopi"], ["Generated", "14-04-2025 09:45:24"], ["Period", "31-12-2024"], ["Level COA", "All"], [], PANEL_HEADER, ...panelRows],
      PnL: [["PnL Profit Loss Report", null, null, "PT Uji Kopi"], ["Account", "Description", "December"], ["4 1 01 01", "Penjualan", "1,000.00"]],
    });

  it("reads an ERP Neraca printed as two panels: one table, codes with spaces, groups as headings, refs carry the panel column", async () => {
    const sheets = await readSheets("bs.xlsx", await panelBook());
    const cands = detectTables(sheets);
    expect(cands.map((c) => [c.sheet, c.mode, c.panels?.length])).toEqual([["BS", "NERACA", 2]]);
    const res = readTable(sheets, cands[0]);
    if (res.mode !== "NERACA") throw new Error("mode");
    expect(res.date?.toISOString().slice(0, 10)).toBe("2024-12-31"); // the Period row, not "Generated 14-04-2025 …"
    expect(res.rows.map((r) => [r.ref, r.code, r.name, r.amount, r.typeHint, r.termHint])).toEqual([
      ["BS!A11", "1 1 01 01", "Kas Kecil", 100_000_000n, "ASET", "CURRENT"],
      ["BS!A12", "1 1 01 02", "BCA 1234", 900_000_000n, "ASET", "CURRENT"],
      ["BS!A16", "1 2 01 01", "Inventaris", 500_000_000n, "ASET", "NON_CURRENT"],
      ["BS!A17", "1 2 02 01", "Akumulasi Penyusutan - Inventaris", -200_000_000n, "ASET", "NON_CURRENT"],
      ["BS!F11", "2 1 03 03", "Pph 21", 20_000_000n, "LIABILITAS", "CURRENT"],
      ["BS!F12", "2 1 03 04", "Ppn Keluaran", -50_000_000n, "LIABILITAS", "CURRENT"],
      ["BS!F16", "3 1 01 01", "Modal Disetor", -800_000_000n, "EKUITAS", null],
      ["BS!F17", "3 1 05 01", "Laba Ditahan", -470_000_000n, "EKUITAS", null],
    ]);
    expect(res.rows.reduce((s, r) => s + r.amount, 0n)).toBe(0n);
    expect(res.totals.map((t) => [t.label, t.kind, t.amount])).toEqual([
      ["Total Kas", "OTHER", 1_000_000_000n],
      ["Total Aset", "ASSETS", 1_300_000_000n],
      ["Total Hutang Pajak", "OTHER", 30_000_000n],
      ["Total Pasiva", "LIAB_EQUITY", 1_300_000_000n],
    ]);
  });

  it("does not split a header that only repeats a word, and skips report sheets titled with a prefix", async () => {
    const buf = await workbook({
      GL: [["Tanggal", "Tanggal Transaksi", "Kode Akun", "Nama Akun", "Debit", "Kredit"], ["31/01/2026", "31/01/2026", "1110", "Kas", 10, 0], ["31/01/2026", "31/01/2026", "3100", "Modal", 0, 10]],
      Report: [["All Branch Profit Loss Report"], ["Account", "Description", "Desember"], ["4 1", "Penjualan", 10]],
      Arus: [["Cash Flow Report", null, null], ["Account", "Value"], ["Operating", 5]],
    });
    const sheets = await readSheets("mixed.xlsx", buf);
    expect(detectTables(sheets).map((c) => [c.sheet, c.mode, c.panels])).toEqual([["GL", "LEDGER", undefined]]);
    expect(sheets.map(reportKind)).toEqual([null, "LABA_RUGI", "ARUS_KAS"]);
  });
  it("does not take a ledger or Neraca for a P&L / cash-flow report because its title or a row says so", async () => {
    const buf = await workbook({
      "GL PL": [["General Ledger - Profit & Loss Accounts"], ["Tanggal", "Kode Akun", "Nama Akun", "Debit", "Kredit"], ["31/01/2026", "4100", "Penjualan", 0, 10], ["31/01/2026", "1110", "Kas", 10, 0]],
      "Buku Besar": [["Buku Besar Akun Laba Rugi"], ["Tanggal", "Kode Akun", "Nama Akun", "Debit", "Kredit"], ["31/01/2026", "4100", "Penjualan", 0, 10], ["31/01/2026", "1110", "Kas", 10, 0]],
      "Uncoded": [["Kas", 100], ["Laba Rugi Tahun Berjalan", 60], ["Modal", 40]].length ? [["Kode Akun", "Nama Akun", "Saldo"], ["1110", "Kas", 100], ["3200", "Laba Rugi Tahun Berjalan", -60], ["3100", "Modal", -40]] : [],
      Sejahtera: [["PT Arus Kas Sejahtera"], ["Kode Akun", "Nama Akun", "Saldo"], ["1110", "Kas", 10], ["3100", "Modal", -10]],
    });
    const sheets = await readSheets("x.xlsx", buf);
    expect(sheets.map(reportKind)).toEqual([null, null, null, null]);
    expect(detectTables(sheets).map((c) => c.sheet)).toEqual(["GL PL", "Buku Besar", "Uncoded", "Sejahtera"]);
  });

  it("dates a two-panel Neraca by its Period row, not a print date; a blank Level is not a heading; Value alone is not a Neraca", async () => {
    const buf = await workbook({
      BS: [
        ["Neraca", null, "31/12/2024"], ["Tanggal Cetak", "05/01/2025"], ["Level COA", "All"],
        ["Account", "Level", "Description", "Value", null, "Account", "Level", "Description", "Value"],
        ["1101", null, "Kas Transit", "0.00", null, "2101", 2, "Utang Usaha", "100.00"],
        ["1102", 2, "Kas", "100.00", null, "2102", 2, "Utang Pajak", "20.00"],
        ["1103", 2, "Bank", "50.00", null, "3101", 2, "Modal", "30.00"],
      ],
      Pivot: [["Account", "Value"], ["Kas", 10], ["Bank", 20]],
    });
    const sheets = await readSheets("bs.xlsx", buf);
    const cands = detectTables(sheets);
    expect(cands.map((c) => c.sheet)).toEqual(["BS"]); // "Account | Value" without a Level column is no Neraca
    const res = readTable(sheets, cands[0]);
    if (res.mode !== "NERACA") throw new Error("mode");
    expect(res.date?.toISOString().slice(0, 10)).toBe("2024-12-31");
    // The blank Level of 1101 is no level 0: it stays an account and does not turn 1102 into a liability.
    expect(res.rows.map((r) => [r.code, r.amount])).toEqual([["1101", 0n], ["1102", 10_000n], ["1103", 5_000n], ["2101", 10_000n], ["2102", 2_000n], ["3101", 3_000n]]);
  });
});
