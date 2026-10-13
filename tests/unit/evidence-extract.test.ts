import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { extractEvidence } from "@/lib/evidence/extract";
import { readLines } from "@/lib/import/parsers/pdf";
import { makePdf } from "../pdf-fixture";
import { htmlXls } from "@/tests/xls-fixture";

async function workbook(sheets: Record<string, unknown[][]>) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    rows.forEach((row) => ws.addRow(row));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const report = ["Citra Ternak Holdings Pte. Ltd.", "Financial statements", "Year ended 31 January 2024", "Amounts in SGD thousands", "Revenue: 1234.56", "Loss: (50.25)"];

describe("evidence extraction", () => {
  it("preserves foreign entity, January fiscal year, source locations, and exact scale math", async () => {
    const { units: [unit] } = await extractEvidence("report.txt", Buffer.from(report.join("\n")));
    expect(unit).toMatchObject({ kind: "REPORT", role: "COMPARISON", entity: "Citra Ternak Holdings Pte. Ltd.", periodStart: "2023-02-01", periodEnd: "2024-01-31", currency: "SGD", scale: "1000" });
    expect(unit.figures).toMatchObject([{ label: "Revenue", raw: "1234.56", amount: "123456000", locator: "baris 5" }, { label: "Loss", amount: "-5025000" }]);
    expect(unit.facts).toContainEqual({ key: "fiscalYearEnd", value: "01-31", locator: "baris 3" });
  });

  it("a multi-entity ledger table counts its rows per entity and currency (cycle 2026-10-12-ledger-entity-currency)", async () => {
    const { postableTables } = await import("@/lib/evidence/extract");
    const rows = [
      ["Entitas", "Tanggal", "Kode Akun", "Nama Akun", "Mata Uang", "Debit", "Kredit"],
      ["HOLD", new Date(Date.UTC(2025, 0, 31)), "1-100", "Kas", "USD", 100, 0],
      ["HOLD", new Date(Date.UTC(2025, 0, 31)), "3-100", "Modal", "USD", 0, 100],
      ["HOLD", new Date(Date.UTC(2025, 1, 28)), "1-100", "Kas", "SGD", 50, 0],
      ["HOLD", new Date(Date.UTC(2025, 1, 28)), "3-100", "Modal", "SGD", 0, 50],
      ["OPA", new Date(Date.UTC(2025, 0, 31)), "1-100", "Kas", "IDR", 1000, 0],
      ["OPA", new Date(Date.UTC(2025, 0, 31)), "4-100", "Penjualan", "IDR", 0, 1000],
    ];
    const tables = await postableTables("gl.xlsx", await workbook({ GL: rows }));
    expect(tables.get("GL")).toMatchObject({ mode: "LEDGER", entities: ["HOLD", "OPA"], entityCurrencies: { HOLD: { USD: 2, SGD: 2 }, OPA: { IDR: 2 } } });
  });

  it("handles leap-day year ends without skipping a day", async () => {
    const { units: [unit] } = await extractEvidence("report.txt", Buffer.from("Financial statements\nYear ended 29 February 2024\nUSD\nRevenue: 100"));
    expect(unit.periodStart).toBe("2023-03-01");
  });

  it("reads a bank export saved as an HTML .xls like a workbook", async () => {
    const data = htmlXls([["PT Citra Ternak"], ["Rekening koran"], ["IDR"], ["Periode 2024-01-01 - 2024-01-31"], ["Tanggal", "Keterangan", "Debit", "Kredit", "Saldo"], ["2024-01-02", "Setoran", "", "100", "100"]]);
    const { units } = await extractEvidence("mutasi.xls", data);
    expect(units.map((u) => u.kind)).toEqual(["BANK"]);
  });

  it("classifies mixed workbook sheets independently and preserves cached formula coordinates", async () => {
    const data = await workbook({
      Profile: [["Company profile"], ["Company name", "Citra Ternak Holdings Pte. Ltd."], ["Business activity", "Poultry farming"]],
      Bank: [["PT Citra Ternak"], ["Rekening koran"], ["IDR"], ["Periode 2024-01-01 - 2024-01-31"], ["Tanggal", "Keterangan", "Debit", "Kredit", "Saldo"], ["2024-01-02", "Setoran", "", "100", "100"]],
      GL: [["General ledger"], ["Tanggal", "Kode akun", "Debit", "Kredit"], ["2024-01-02", "1101", "100", "0"], ["2024-01-02", "3100", "0", "100"]],
      FS: [["PT Citra Ternak"], ["Neraca"], ["IDR"], ["Per tanggal 2024-01-31"], ["Kas", { formula: "100+25", result: 125 }], ["Laba", { formula: "A1+2" }]],
    });
    const { units } = await extractEvidence("mixed.xlsx", data);
    expect(units.map((u) => u.kind)).toEqual(["CONTEXT", "BANK", "LEDGER", "REPORT"]);
    expect(units.map((u) => u.role)).toEqual(["CONTEXT", "SOURCE", "SOURCE", "COMPARISON"]);
    expect(units[2].table).toMatchObject({ mode: "LEDGER", rows: 2, periodStart: "2024-01-02", periodEnd: "2024-01-02" });
    expect(units[0].facts).toContainEqual({ key: "businessActivity", value: "Poultry farming", locator: "Profile!3" });
    expect(units[3].figures).toMatchObject([{ label: "Kas", amount: "125", locator: "FS!B5" }]);
    expect(units[3].issues).toContain("Rumus FS!B6 belum memiliki hasil tersimpan. Hitung ulang dan simpan di Excel.");
    expect(units[3].figures).toHaveLength(1);
  });

  it("keeps contradictory currency, scale, and ambiguous dates unresolved", async () => {
    const { units: [unit] } = await extractEvidence("report.md", Buffer.from("Neraca\nIDR USD\nAmounts in thousands and millions\nPer tanggal 01/02/2024\nKas: 1000"));
    expect(unit).toMatchObject({ currency: null, scale: "UNKNOWN", periodEnd: null, figures: [] });
    expect(unit.passages.some((p) => p.text === "Kas: 1000")).toBe(true);
    expect(unit.issues.join(" ")).toMatch(/Mata uang.*Periode.*Skala/);
  });

  it("flags invalid Excel dates and cached formula dates without losing usable cells", async () => {
    const data = await workbook({ FS: [
      ["PT Citra Ternak"], ["Neraca"], ["IDR"], ["Per tanggal 2024-01-31"],
      ["Kas", new Date(NaN)],
      ["Piutang", { formula: "B5", result: new Date(NaN) }],
      ["Pendapatan", 125],
      ["Tanggal transaksi", new Date("2024-01-15T00:00:00Z")],
    ] });
    const { units: [unit] } = await extractEvidence("invalid-dates.xlsx", data);
    expect(unit.issues).toContain("2 tanggal tidak valid (contoh: B5, B6). Periksa sel sumber, hitung ulang rumus jika ada, lalu simpan ulang di Excel.");
    expect(unit.passages).toContainEqual({ locator: "FS!5", text: "Kas | [tanggal tidak valid]" });
    expect(unit.passages).toContainEqual({ locator: "FS!6", text: "Piutang | [tanggal tidak valid]" });
    expect(unit.passages).toContainEqual({ locator: "FS!8", text: "Tanggal transaksi | 2024-01-15" });
    expect(unit.figures).toHaveLength(1);
    expect(unit.figures[0]).toMatchObject({ label: "Pendapatan", amount: "125", locator: "FS!B7" });
    expect(unit.periodEnd).toBe("2024-01-31");
  });

  it("does not silently choose one comparative report column", async () => {
    const data = await workbook({ FS: [["Neraca"], ["IDR"], ["Per tanggal 2024-01-31"], ["Akun", "2024", "2023"], ["Kas", 100, 200], ["Piutang", null, 300]] });
    const { units: [unit] } = await extractEvidence("compare.xlsx", data);
    expect(unit.figures).toEqual([]);
    expect(unit.passages.some((p) => p.text === "Kas | 100 | 200")).toBe(true);
  });

  it("does not turn ratios or employee counts into monetary report figures", async () => {
    const { units: [unit] } = await extractEvidence("report.txt", Buffer.from([...report, "Profit margin: 12", "Jumlah karyawan: 50", "Earnings per share: 3"].join("\n")));
    expect(unit.figures.map((f) => f.label)).toEqual(["Revenue", "Loss"]);
  });

  it("does not apply narrative magnitudes to monetary columns", async () => {
    const content = ["PT Citra Ternak", "Laporan laba rugi", "Year ended 31 January 2024", "IDR", "Jumlah pelanggan: 2 juta", "Pendapatan: 1000000", "Jumlah pelanggan: 10000", "Total shares: 10000", "Jumlah: 20", "Total: 30", "Total pendapatan: 1000000"];
    const { units: [unit] } = await extractEvidence("counts.txt", Buffer.from(content.join("\n")));
    expect(unit.scale).toBe("1");
    expect(unit.figures.map(f => [f.label, f.amount])).toEqual([["Pendapatan", "1000000"], ["Total pendapatan", "1000000"]]);
  });

  it("only uses declared report units even when narrative mentions another magnitude", async () => {
    const { units: [unit] } = await extractEvidence("report.txt", Buffer.from([...report, "Customers served: 2 million", "Revenue transactions: 200", "Share capital: 10"].join("\n")));
    expect(unit.scale).toBe("1000");
    expect(unit.figures.find(f => f.label === "Revenue")).toMatchObject({ amount: "123456000" });
    expect(unit.figures.find(f => f.label === "Share capital")).toMatchObject({ amount: "1000000" });
  });

  it("recognizes Indonesian unit declarations and keeps unsupported units unresolved", async () => {
    const header = "Neraca\nIDR\nPer tanggal 2024-01-31\n";
    expect((await extractEvidence("report.txt", Buffer.from(`${header}Disajikan dalam jutaan Rupiah\nKas: 2`))).units[0].figures[0].amount).toBe("2000000");
    expect((await extractEvidence("report.txt", Buffer.from(`${header}Amounts in IDR lakhs\nKas: 2`))).units[0]).toMatchObject({ scale: "UNKNOWN", figures: [] });
  });

  it("scales numeric Excel decimals before rounding and refuses ambiguous text separators", async () => {
    const data = await workbook({ FS: [["Neraca"], ["IDR millions"], ["Per tanggal 2024-01-31"], ["Kas", 1.234], ["Piutang", "1.234"]] });
    const { units: [unit] } = await extractEvidence("scaled.xlsx", data);
    expect(unit.figures).toHaveLength(1);
    expect(unit.figures[0]).toMatchObject({ label: "Kas", raw: "1.234", amount: "1234000" });
  });

  it("reads CSV report amounts without floating point conversion", async () => {
    const { units: [unit] } = await extractEvidence("report.csv", Buffer.from("PT Citra Ternak;\nNeraca;\nIDR;\nPer tanggal 2024-01-31;\nKas;9007199254740993123\n"));
    expect(unit.figures).toMatchObject([{ amount: "9007199254740993123", locator: "CSV!R5C2" }]);
  });

  it("keeps PDF page citations and handles password-protected evidence", async () => {
    const data = makePdf([report.slice(0, 4).map((text, i) => ({ x: 40, y: 800 - i * 20, text })), report.slice(4).map((text, i) => ({ x: 40, y: 800 - i * 20, text }))], { userPassword: "secret" });
    await expect(extractEvidence("report.pdf", data)).rejects.toMatchObject({ reason: "needed" });
    await expect(extractEvidence("report.pdf", data, { password: "wrong" })).rejects.toMatchObject({ reason: "wrong" });
    const { units: [unit] } = await extractEvidence("report.pdf", data, { password: "secret" });
    expect(unit.figures[0]).toMatchObject({ amount: "123456000", locator: "halaman 2, baris 5" });
  });

  it("rejects oversized PDF page counts before evidence text extraction", async () => {
    const data = makePdf(Array.from({ length: 301 }, () => []));
    await expect(extractEvidence("large.pdf", data)).rejects.toThrow(/melebihi batas 300 halaman.*Pecah PDF/);
    // Bank parser callers keep their existing unbounded default behavior.
    await expect(readLines(data)).resolves.toEqual([]);
  });

  it("caps streamed PDF text items while keeping normal positions and password errors", async () => {
    const pages = [[{ x: 40, y: 800, text: "First evidence line" }, { x: 40, y: 780, text: "Second evidence line" }], [{ x: 40, y: 800, text: "Third evidence line" }]];
    const data = makePdf(pages);
    const normal = await readLines(data);
    await expect(readLines(data, undefined, { maxPages: 2, maxItems: 100 })).resolves.toEqual(normal);
    await expect(readLines(data, undefined, { maxPages: 2, maxItems: 1 })).rejects.toThrow(/Teks PDF melebihi batas 1 bagian.*Pecah PDF/);
    const locked = makePdf(pages, { userPassword: "secret" });
    await expect(readLines(locked, undefined, { maxPages: 2, maxItems: 100 })).rejects.toMatchObject({ reason: "needed" });
    await expect(readLines(locked, "wrong", { maxPages: 2, maxItems: 100 })).rejects.toMatchObject({ reason: "wrong" });
    await expect(readLines(locked, "secret", { maxPages: 2, maxItems: 100 })).resolves.toEqual(normal);
  });

  it("rejects unsupported files and scanned PDFs with actionable messages", async () => {
    await expect(extractEvidence("scan.pdf", makePdf([[]]))).rejects.toThrow(/OCR belum didukung/);
    await expect(extractEvidence("old.xls", Buffer.from("x"))).rejects.toThrow(/Simpan sebagai .xlsx atau CSV/);
    await expect(extractEvidence("profile.docx", Buffer.from("x"))).rejects.toThrow(/Ekspor sebagai PDF/);
    await expect(extractEvidence("report.xlsx", Buffer.from("x"))).rejects.toThrow(/Excel tidak bisa dibuka/);
    await expect(extractEvidence("big.txt", Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toThrow(/10 MiB/);
  });

  it("rejects forged ZIP lengths before workbook parsing and bounds actual inflate", async () => {
    const name = Buffer.from("xl/worksheets/sheet1.xml");
    const compressed = deflateRawSync(Buffer.alloc(65 * 1024 * 1024, 65));
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(1, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(1, 24); central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length, 16);
    const zip = Buffer.concat([local, name, compressed, central, name, end]);
    await expect(extractEvidence("forged.xlsx", zip)).rejects.toThrow(/64 MiB/);
    const valid = await workbook({ FS: [["Neraca"], ["IDR"], ["Per tanggal 2024-01-31"], ["Kas", 10]] });
    const badOffset = Buffer.from(valid);
    const centralOffset = badOffset.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    badOffset.writeUInt32LE(valid.length, centralOffset + 42);
    await expect(extractEvidence("offset.xlsx", badOffset)).rejects.toThrow(/Struktur file Excel tidak valid/);
  });

  it("makes truncation explicit and excludes unusable numeric precision", async () => {
    const { units: [unit] } = await extractEvidence("long.txt", Buffer.from(Array.from({ length: 3000 }, (_, i) => `Line ${i}`).join("\n")));
    expect(unit.passages).toHaveLength(1000);
    expect(unit.issues.join(" ")).toMatch(/sebagian isi belum diperiksa/);
    const data = await workbook({ FS: [["Neraca"], ["IDR"], ["Per tanggal 2024-01-31"], ["Kas", Number.MAX_SAFE_INTEGER + 1]] });
    const { units: [unsafe] } = await extractEvidence("unsafe.xlsx", data);
    expect(unsafe.figures).toEqual([]);
    expect(unsafe.issues.join(" ")).toMatch(/melebihi presisi Excel/);
  });
});
