import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * A company keeping its own books (ADR 0017 §1, cycle 2026-10-09-trial-tenants-roles T12): it lands on its books, the sidebar shows
 * its entities' work and no client list, nothing in the sidebar says "klien", and asking for a new client leads back to the books.
 * The account comes from scripts/e2e-setup.ts; the server-side refusal of a second client is in tests/db/company-org.test.ts.
 */
test("a company lands on its own books, with no client layer in sight", async ({ browser, baseURL }) => {
  const { email, password } = JSON.parse(readFileSync(".playwright/credentials-company.json", "utf8")) as { email: string; password: string };
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Kata sandi").fill(password);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await page.waitForURL(/\/clients\/[^/?]+/, { timeout: 30_000 });
  const books = new URL(page.url()).pathname.match(/^\/clients\/[^/]+/)![0];

  const sidebar = page.locator("[data-sidebar=sidebar]").first();
  await expect(sidebar).toContainText("PT Uji Perusahaan");
  await expect(sidebar).toContainText("Ringkasan");
  await expect(sidebar).toContainText("Unggah");
  await expect(sidebar).not.toContainText(/klien/i);

  await page.goto("/");
  await page.waitForURL((url) => url.pathname.startsWith(books));
  await page.goto("/clients/new");
  await page.waitForURL((url) => url.pathname.startsWith(books));
});
