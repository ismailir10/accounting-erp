import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { openManualImport } from "./qa-helpers";

/**
 * Trial access (ADR 0017, cycle 2026-10-09-trial-tenants-roles T10): an organisation whose trial ended reads and exports but every
 * write explains why it is closed; one whose trial ends within a week is told how many days are left. Accounts come from
 * scripts/e2e-setup.ts and sign in through the real form.
 */
const credentials = (file: string) => JSON.parse(readFileSync(`.playwright/${file}`, "utf8")) as { email: string; password: string };

async function signIn(browser: Browser, baseURL: string | undefined, file: string): Promise<Page> {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  const { email, password } = credentials(file);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Kata sandi").fill(password);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Beranda", exact: true })).toBeVisible({ timeout: 30_000 });
  return page;
}

test("an ended trial reads and exports, and the import explains why it is closed", async ({ browser, baseURL }) => {
  const page = await signIn(browser, baseURL, "credentials-trial-ended.json");
  await expect(page.getByTestId("access-banner")).toContainText("Masa uji coba berakhir pada");
  await expect(page.getByTestId("access-banner")).toContainText("Data tetap tersimpan dan laporan bisa diunduh.");

  const href = await page.getByRole("link", { name: "Klien Uji Berakhir", exact: true }).first().getAttribute("href");
  const id = href!.match(/clients\/([^/?]+)/)![1];
  await page.goto(`/clients/${id}/import`);
  await openManualImport(page);
  await expect(page.getByRole("button", { name: /Proses mutasi/ })).toBeDisabled();
  await expect(page.getByTestId("write-blocked").first()).toContainText("Masa uji coba berakhir");

  const report = await page.goto(`/clients/${id}/reports`);
  expect(report?.status()).toBe(200);
  const download = await page.request.get(`/clients/${id}/reports/export`);
  expect(download.status(), "Excel export stays available").toBe(200);
});

test("a trial ending within a week says how many days are left", async ({ browser, baseURL }) => {
  const page = await signIn(browser, baseURL, "credentials-trial-ending.json");
  await expect(page.getByTestId("access-banner")).toContainText("Uji coba berakhir dalam 3 hari");
  await expect(page.getByTestId("access-banner")).toContainText("Setelah itu ruang kerja hanya bisa dibaca");
});

test("the demo firm, with open-ended access, shows no banner", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Beranda", exact: true })).toBeVisible();
  await expect(page.getByTestId("access-banner")).toHaveCount(0);
});
