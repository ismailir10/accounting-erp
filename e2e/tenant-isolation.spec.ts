import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Isolation inside one organisation (ADR 0017 §5, cycle 2026-10-09-trial-tenants-roles T13): an AKUNTAN narrowed to one client gets a
 * 404 on every page and download of another client of the same firm, exactly like a missing client. Another firm's client is covered
 * by e2e/qa-access.spec.ts. The assignment is changed through the real team page and restored at the end.
 */
const credentials = (file: string) => JSON.parse(readFileSync(`.playwright/${file}`, "utf8")) as { email: string; password: string };
const ROUTES = ["", "/import", "/review", "/opening", "/ledger", "/trial-balance", "/reports", "/tax", "/tax/masa", "/close", "/assets", "/inventory", "/leases", "/benefits", "/receivables", "/rates", "/settings", "/history", "/journals/new", "/documents"];

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

async function assign(page: Page, email: string, names: string[] | "all") {
  await page.goto("/settings?tab=tim");
  await page.getByTestId("team-row").filter({ hasText: email }).getByTestId("assign-clients").click();
  const dialog = page.getByRole("dialog");
  for (const name of await dialog.locator("label").allTextContents()) {
    const box = dialog.getByRole("checkbox", { name, exact: true });
    const want = names === "all" || names.includes(name);
    if (((await box.getAttribute("aria-checked")) === "true") !== want) await box.click();
  }
  await dialog.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByText(/Klien .* disimpan/)).toBeVisible();
}

test("an akuntan narrowed to one client reaches nothing of another client of the same firm", async ({ page, browser, baseURL }) => {
  const akuntan = credentials("credentials-akuntan.json").email;
  await page.goto("/");
  const href = await page.getByRole("link", { name: "PT Jasa Kreatif Digital", exact: true }).first().getAttribute("href");
  const other = href!.match(/clients\/([^/?]+)/)![1];
  await assign(page, akuntan, ["CV Sinar Retail"]);

  const them = await signIn(browser, baseURL, "credentials-akuntan.json");
  await expect(them.locator("[data-sidebar=sidebar]").first()).not.toContainText("PT Jasa Kreatif Digital");
  const leaks: string[] = [];
  for (const route of ROUTES) {
    const response = await them.goto(`/clients/${other}${route}`);
    if (response?.status() !== 404) leaks.push(`${route || "/"} → ${response?.status()}`);
  }
  for (const path of ["reports/export", "reports/export/pdf", "tax/export", "tax/masa/export", "review/export"]) {
    const response = await them.request.get(`/clients/${other}/${path}?period=2026-08`);
    if (response.status() !== 404) leaks.push(`${path} → ${response.status()}`);
  }
  expect(leaks, "an unassigned client must read as not found").toEqual([]);

  await assign(page, akuntan, "all");
});
