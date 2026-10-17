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

/**
 * Wawasan (cycle 2026-10-17-wawasan-keuangan), flow 1: on the group through August 2026 the trend's laba bersih is the August cell of
 * Laba Rugi per bulan, the gross margin is Rasio keuangan's, the margin sentence reads as the fall it is, and Penggerak asks for one
 * company. A trend figure opens its table.
 */
test("Wawasan: trend and margin equal their tables; a group asks for one company", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Grup Ayam Nusantara", exact: true }).first().click();
  await page.waitForURL(/\/clients\/[^/]+/);
  const base = page.url().match(/^.*\/clients\/[^/?]+/)![0];

  await page.goto(`${base}/analysis?period=2026-08&entity=combined`);
  const august = (await page.getByTestId("trend-net").locator("td").allInnerTexts()).at(-2)!; // the last month, before the total
  await page.goto(`${base}/analysis?period=2026-08&entity=combined&tab=rasio`);
  const gpm = (await page.getByTestId("ratio-gpm").locator("td").allInnerTexts()).at(-1)!;

  await page.getByRole("link", { name: "Wawasan" }).click();
  await expect(page).toHaveURL(/tab=wawasan/);
  await expect(page.getByTestId("insight-trend-netProfit").getByTestId("current")).toHaveText(august);
  await expect(page.getByTestId("insight-margin-gpm").getByTestId("current")).toHaveText(gpm);
  await expect(page.getByTestId("insight-margin-sentence")).toContainText("Margin laba kotor turun");
  await expect(page.getByTestId("movers-pick-company")).toBeVisible();

  await page.getByTestId("insight-trend-netProfit").getByTestId("current").getByRole("link").click();
  await expect(page).not.toHaveURL(/tab=/);
  await expect(page.getByTestId("trend-net")).toBeVisible();
});

/**
 * Wawasan, flow 2: PT Jasa Kreatif Digital, July 2026 — 6170 Beban Jasa Profesional is over the threshold with its three largest lines and
 * their source, opens its Buku Besar, and a typed explanation, once approved, is in the management pack's Perubahan Akun. It is removed
 * at the end so the demo stays as seeded. (CI has no AI key: *Susun dengan AI* is covered by DB tests with MockProvider.)
 */
test("Wawasan: explain a flagged mover; the management pack carries it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "PT Jasa Kreatif Digital", exact: true }).first().click();
  await page.waitForURL(/\/clients\/[^/]+/);
  const base = page.url().match(/^.*\/clients\/[^/?]+/)![0];

  await page.goto(`${base}/analysis?period=2026-07&tab=wawasan`);
  const mover = page.getByTestId("mover-6170");
  await expect(mover).toContainText("Melewati ambang");
  await expect(mover).toContainText("17.450.000");
  await expect(mover).toContainText("11.466.666");
  // The month holds one line on 6170 (the freelance fee transfer), so its largest lines are that one.
  await expect(mover.getByTestId("mover-lines").locator(":scope > li")).toHaveCount(1);
  await expect(mover.getByTestId("mover-lines")).toContainText("HONOR FREELANCE");
  await expect(page.getByTestId("next-step")).toContainText("Jelaskan 1 akun yang melewati ambang");

  await mover.getByTestId("mover-account").click();
  await expect(page).toHaveURL(/\/ledger\/6170\?.*period=2026-07/);
  await page.goBack();

  const editor = page.getByTestId("mover-6170").getByTestId("flux-explanation");
  await editor.getByRole("button", { name: "Tulis penjelasan" }).click();
  const text = "Tagihan konsultan pajak dan audit interim jatuh di bulan yang sama.";
  await editor.getByLabel("Penjelasan akun 6170").fill(text);
  await editor.getByRole("button", { name: "Setujui" }).click();
  await expect(editor.getByTestId("flux-explanation-approved")).toContainText("Disetujui");
  await expect(editor.getByTestId("flux-explanation-approved")).toContainText(text);
  await expect(page.getByTestId("next-step")).toContainText("sudah dijelaskan");

  await page.goto(`${base}/reports?period=2026-07`);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("fs-download-management").click()]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile(await download.path())) as unknown as ArrayBuffer);
  const rows: unknown[][] = [];
  wb.getWorksheet("Perubahan Akun")!.eachRow((r) => rows.push([r.getCell(1).value, r.getCell(7).value]));
  expect(rows).toContainEqual(["6170", text]);

  await page.goto(`${base}/analysis?period=2026-07&tab=wawasan`);
  await page.getByTestId("mover-6170").getByRole("button", { name: "Hapus penjelasan" }).click();
  await expect(page.getByTestId("mover-6170").getByTestId("flux-explanation-approved")).toHaveCount(0);
});
