import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";

/**
 * Analisis keuangan on the demo group through August 2026: the monthly Laba Rugi's total is the year to date shown on Laporan Keuangan,
 * the Neraca balances every month, the ratios render, and the workbook carries the three sheets with the total as a formula.
 */
test("Analisis keuangan: Laba Rugi and Neraca per month, ratios, Excel", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Grup Ayam Nusantara", exact: true }).first().click();
  await page.waitForURL(/\/clients\/[^/]+/);
  const base = page.url().match(/^.*\/clients\/[^/?]+/)![0];

  await page.goto(`${base}/reports?period=2026-08&entity=combined`);
  const ytd = (await page.locator("main").innerText()).match(/Laba bersih\s+[\d.()]+\s+[\d.()]+\s+([\d.()]+)/)![1];

  await page.goto(`${base}/analysis?period=2026-08&entity=combined`);
  await expect(page.getByRole("heading", { name: "Analisis keuangan" })).toBeVisible();
  await expect(page.getByTestId("trend-net")).toContainText(ytd);

  await page.getByRole("link", { name: "Neraca per bulan" }).click();
  await expect(page).toHaveURL(/tab=bs/);
  const cells = async (key: string) => (await page.getByTestId(`trend-${key}`).locator("td").allInnerTexts()).slice(1);
  expect(await cells("assets")).toEqual(await cells("le"));

  await page.getByRole("link", { name: "Rasio keuangan" }).click();
  await expect(page.getByTestId("ratio-current")).toContainText("x");
  await expect(page.getByTestId("ratio-npm")).toContainText("%");

  const download = page.waitForEvent("download");
  await page.getByTestId("analysis-download").click();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile(await (await download).path())) as unknown as ArrayBuffer);
  expect(wb.worksheets.map((w) => w.name)).toEqual(["Laba Rugi per bulan", "Neraca per bulan", "Rasio keuangan"]);
});
