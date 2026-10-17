import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";

/**
 * Jurnal Umum and the ledger as Excel on the demo group (Grup Ayam Nusantara, August 2026): the month's journals balance, a search by
 * text and by amount finds them, an account opens its Buku Besar, and the Neraca Saldo download balances.
 */
const load = async (path: string) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile(path)) as unknown as ArrayBuffer);
  return wb.worksheets[0];
};

test("Jurnal Umum: list, search, drill, and the ledger downloads", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Grup Ayam Nusantara", exact: true }).first().click();
  await page.waitForURL(/\/clients\/[^/]+/);
  const base = page.url().match(/^.*\/clients\/[^/?]+/)![0];

  await page.goto(`${base}/journals?period=2026-08&entity=combined`);
  await expect(page.getByRole("heading", { name: "Jurnal Umum" })).toBeVisible();
  await expect(page.getByTestId("journals-summary")).toContainText("seimbang");

  await page.getByLabel("Cari jurnal").fill("payroll");
  await page.getByRole("button", { name: "Cari" }).click();
  await expect(page).toHaveURL(/q=payroll/);
  await expect(page.getByTestId("journal-entry").first()).toContainText("PAYROLL");
  const amount = (await page.getByTestId("journal-entry").first().locator("td").nth(1).innerText()).trim();
  await page.getByLabel("Cari jurnal").fill(amount);
  await page.getByRole("button", { name: "Cari" }).click();
  await expect(page.getByTestId("journal-entry").first()).toContainText(amount);

  const download = page.waitForEvent("download");
  await page.getByTestId("journals-download").click();
  const journal = await load(await (await download).path());
  expect(journal.getRow(2).getCell(1).value).toBe("Jurnal Umum");

  await page.getByTestId("journal-entry").first().locator("a.drill").first().click();
  await expect(page).toHaveURL(/\/ledger\/\d{4}\?period=2026-08/);
  await expect(page.getByTestId("ledger-row").first()).toBeVisible();

  await page.goto(`${base}/trial-balance?period=2026-08&entity=combined`);
  const tbDownload = page.waitForEvent("download");
  await page.getByTestId("tb-download").click();
  const tb = await load(await (await tbDownload).path());
  const total = tb.getRow(tb.rowCount);
  const value = (i: number) => (total.getCell(i).value as { result?: number }).result ?? 0;
  expect(total.getCell(2).value).toBe("Jumlah");
  expect(value(7)).toBe(value(8));
  expect(value(5)).toBe(value(6));
});
