import { expect, test } from "@playwright/test";
import * as XLSX from "xlsx";
import { addClient, briCsv, nextAccount, openManualImport, uploadStatement } from "./qa-helpers";

/**
 * Statement import edge cases found by the end-to-end QA run (docs/qa/bugs). Each test is a fresh client with its own synthetic file.
 * BUG-001 identical same-day lines · 002 XLSX ISO date cells · 004 newest-first export · 008 oversize upload · 009 zero-amount line ·
 * 010 impossible amount.
 */
const toast = (page: import("@playwright/test").Page) => page.locator("[data-sonner-toast]");

test("BUG-001: two identical same-day lines without a running balance both import, and a re-upload adds nothing", async ({ page }) => {
  const id = await addClient(page, { name: "QA Kembar" });
  const csv = ["Tanggal;Keterangan;Debet;Kredit;Saldo", "01/08/2026;SALDO AWAL;;;100.000.000,00", "02/08/2026;BIAYA ADM;15.000,00;0,00;", "02/08/2026;BIAYA ADM;15.000,00;0,00;", "03/08/2026;TRSF MASUK PT X;0,00;1.000.000,00;", ""].join("\n");
  await uploadStatement(page, id, "kembar.csv", csv);
  await expect(toast(page)).toContainText("3 transaksi diproses");
  await page.goto(`/clients/${id}/import`);
  await expect(page.getByRole("row", { name: /kembar\.csv/ })).toContainText("3");

  await uploadStatement(page, id, "kembar.csv", csv);
  await expect(toast(page)).toContainText("0 transaksi diproses");
});

test("BUG-002: an .xlsx with ISO date cells (SheetJS cellDates) keeps its real dates, not 1905", async ({ page }) => {
  const id = await addClient(page, { name: "QA Excel ISO" });
  const wb = XLSX.utils.book_new();
  const rows = [["Tanggal", "Keterangan", "Debet", "Kredit", "Saldo"], [new Date(Date.UTC(2026, 9, 2)), "SETORAN", 0, 2_500_000, 102_500_000], [new Date(Date.UTC(2026, 9, 5)), "BAYAR SUPPLIER", 750_000, 0, 101_750_000]];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows, { cellDates: true }), "Sheet1");
  const buffer = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellDates: true }));
  await uploadStatement(page, id, "iso.xlsx", buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await expect(toast(page)).toContainText("2 transaksi diproses");
  await page.goto(`/clients/${id}/import`);
  const row = page.getByRole("row", { name: /iso\.xlsx/ });
  await expect(row).toContainText("Okt 2026");
  await expect(row).not.toContainText("1905");
});

test("BUG-004: a newest-first export is read from its oldest row (opening 100.000.000, continuity ok)", async ({ page }) => {
  const id = await addClient(page, { name: "QA Terbaru Dulu" });
  const csv = ["Tanggal;Keterangan;Debet;Kredit;Saldo", "20/09/2026;TRSF C;0,00;3.000.000,00;103.500.000,00", "10/09/2026;TRSF B;500.000,00;0,00;100.500.000,00", "05/09/2026;TRSF A;0,00;1.000.000,00;101.000.000,00", ""].join("\n");
  await uploadStatement(page, id, "terbaru.csv", csv);
  await expect(page.getByTestId("import-result")).toContainText("Nyambung");
  await expect(page.getByTestId("import-result")).toContainText("dari yang terbaru");
  await page.goto(`/clients/${id}/opening`);
  await expect(page.getByLabel(/^Saldo /).first()).toHaveValue("100.000.000");
});

test("BUG-009: a zero-amount line is skipped with a note; the rest imports", async ({ page }) => {
  const id = await addClient(page, { name: "QA Nol", account: "7000200001" });
  await uploadStatement(page, id, "nol.csv", briCsv("7000200001", ["2026-04-02;BIAYA NOL;0.00;0.00;122220000.00", "2026-04-03;TRSF NORMAL;1000.00;0.00;122219000.00"]));
  await expect(toast(page)).toContainText("1 transaksi diproses");
  await expect(page.getByTestId("import-result")).toContainText("1 baris bernilai nol dilewati");
});

test("BUG-010: an impossible 20-digit amount is refused with its row, not 'kesalahan tak terduga'", async ({ page }) => {
  const id = await addClient(page, { name: "QA Raksasa", account: "7000200002" });
  await uploadStatement(page, id, "raksasa.csv", briCsv("7000200002", ["2026-05-02;SETORAN RAKSASA;0.00;99999999999999999999.00;99999999999999999999.00"]));
  await expect(toast(page)).toContainText("Nominal terlalu besar di baris 4");
  await expect(toast(page)).not.toContainText("tak terduga");
});

test("BUG-008: a file above 6 MB gets the friendly size message and the page stays usable", async ({ page }) => {
  const id = await addClient(page, { name: "QA Besar", account: nextAccount() });
  await page.goto(`/clients/${id}/import`);
  await openManualImport(page);
  await page.getByTestId("file-input").setInputFiles({ name: "besar.csv", mimeType: "text/csv", buffer: Buffer.alloc(6.5 * 1024 * 1024, "x") });
  await expect(toast(page)).toContainText("File terlalu besar (maks. 5 MB)");
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Proses mutasi" })).toBeDisabled();
  await expect(page.getByText("This page couldn")).toHaveCount(0);
});
