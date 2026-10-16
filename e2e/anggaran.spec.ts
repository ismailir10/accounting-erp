import { expect, test } from "@playwright/test";

/**
 * Anggaran on the demo group's PT for August 2026: a yearly amount spread over the months, a month typed, saved, and read against the
 * ledger; the combined group asks for a company before editing.
 */
test("Anggaran: plan per month and compare with the books", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Grup Ayam Nusantara", exact: true }).first().click();
  await page.waitForURL(/\/clients\/[^/]+/);
  const base = page.url().match(/^.*\/clients\/[^/?]+/)![0];

  await page.goto(`${base}/budget?period=2026-08&entity=combined&tab=atur`);
  await expect(page.getByText("Anggaran diisi per perusahaan. Pilih perusahaannya.")).toBeVisible();
  await page.getByRole("link", { name: /PT Ayam/ }).click();
  await expect(page.getByTestId("budget-editor")).toBeVisible();

  await page.getByLabel("Setahun 6120").fill("600.000.000");
  await page.getByLabel("Setahun 6120").press("Enter");
  await expect(page.getByLabel("6120 Agu 26")).toHaveValue("50.000.000");
  await page.getByLabel("4100 Agu 26").fill("1.450.000.000");
  await page.getByRole("button", { name: "Simpan anggaran" }).click();
  await expect(page.getByText("Anggaran disimpan: 13 sel diisi")).toBeVisible();

  await page.getByRole("link", { name: "Anggaran vs realisasi" }).click();
  await expect(page.getByTestId("vs-4100")).toContainText("1.450.000.000");
  await expect(page.getByTestId("vs-6120")).toContainText("50.000.000");
  await expect(page.getByTestId("budget-download")).toBeVisible();
  await page.getByRole("link", { name: "Realisasi 4100 di Buku Besar" }).click();
  await expect(page).toHaveURL(/\/ledger\/4100\?/);
});
