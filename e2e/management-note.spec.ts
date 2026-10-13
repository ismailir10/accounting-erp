import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";

/**
 * Catatan manajemen (I5b): the accountant writes the month's note, approves it, and the management workbook carries it; going back
 * to the computed sentences takes it out again. (CI has no AI key: the AI draft path is covered by DB tests with MockProvider.)
 */
test("an approved management note goes into the management workbook", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "CV Sinar Retail", exact: true }).first().click();
  await page.waitForURL(/\/clients\/[^/]+/);
  const base = page.url().match(/^.*\/clients\/[^/?]+/)![0];
  await page.goto(`${base}/reports?period=2026-08&tab=mgmt`);
  const card = page.getByTestId("management-note");
  await expect(card).toContainText("Kalimat otomatis");
  await expect(card).toContainText("Pendapatan Agustus 2026");
  await card.getByRole("button", { name: "Tulis sendiri" }).click();
  await card.getByLabel("Catatan untuk laporan manajemen").fill("Penjualan toko stabil bulan ini; kas cukup untuk belanja stok.");
  await card.getByRole("button", { name: "Pakai catatan ini" }).click();
  await expect(page.getByText("Catatan disimpan untuk laporan manajemen")).toBeVisible();
  await expect(page.getByTestId("management-note-approved")).toContainText("Disetujui");
  await expect(page.getByTestId("management-note-approved")).toContainText("Penjualan toko stabil bulan ini");

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("fs-download-management").click()]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile(await download.path())) as unknown as ArrayBuffer);
  const text = wb.getWorksheet("Ringkasan")!.getSheetValues().flat().map(String).join(" | ");
  expect(text).toContain("Catatan bulan ini (disetujui akuntan)");
  expect(text).toContain("Penjualan toko stabil bulan ini; kas cukup untuk belanja stok.");

  await card.getByRole("button", { name: "Kembali ke kalimat otomatis" }).click();
  await expect(page.getByText("Kembali ke kalimat otomatis").last()).toBeVisible();
  await expect(page.getByTestId("management-note-approved")).toHaveCount(0);
});

test("selecting July from August changes the report and discards the previous month's draft", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "CV Sinar Retail", exact: true }).first().click();
  await page.waitForURL(/\/clients\/[^/]+/);
  const base = page.url().match(/^.*\/clients\/[^/?]+/)![0];
  await page.goto(`${base}/reports?period=2026-08&tab=mgmt`);
  const card = page.getByTestId("management-note");
  const editor = card.getByLabel("Catatan untuk laporan manajemen");
  await expect(card).toContainText("Pendapatan Agustus 2026");
  await card.getByRole("button", { name: "Tulis sendiri", exact: true }).click();
  await editor.fill("Draf khusus Agustus, belum disetujui.");

  await page.getByRole("combobox", { name: "Periode", exact: true }).click();
  await page.getByRole("option", { name: /^Juli 2026/ }).click();
  await expect(page).toHaveURL(/(?:\?|&)period=2026-07(?:&|$)/);
  await expect(card).toContainText("Pendapatan Juli 2026");
  await expect(editor).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Pakai catatan ini", exact: true })).toHaveCount(0);
  await card.getByRole("button", { name: "Tulis sendiri", exact: true }).click();
  await expect(editor).toHaveValue(/Pendapatan Juli 2026/);
  await editor.fill("Draf khusus Juli, belum disetujui.");

  await page.getByRole("combobox", { name: "Periode", exact: true }).click();
  await page.getByRole("option", { name: /^Agustus 2026/ }).click();
  await expect(page).toHaveURL(/(?:\?|&)period=2026-08(?:&|$)/);
  await expect(card).toContainText("Pendapatan Agustus 2026");
  await expect(editor).toHaveCount(0);
  await card.getByRole("button", { name: "Tulis sendiri", exact: true }).click();
  await expect(editor).toHaveValue(/Pendapatan Agustus 2026/);
});
