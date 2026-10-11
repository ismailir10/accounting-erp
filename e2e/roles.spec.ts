import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { openManualImport } from "./qa-helpers";

/**
 * Pengaturan → Tim (ADR 0017 §5, cycle 2026-10-09-trial-tenants-roles T11): an admin narrows an AKUNTAN to one client, who then sees
 * only that client; as Peninjau the same person reads reports but cannot import. The e2e accounts come from scripts/e2e-setup.ts
 * (invitations themselves are covered by tests/db/team.test.ts: the local stack sends no mail). Restores every client at the end.
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

function row(page: Page, email: string) {
  return page.getByTestId("team-row").filter({ hasText: email });
}

async function setClients(page: Page, email: string, names: string[] | "all") {
  await row(page, email).getByTestId("assign-clients").click();
  const dialog = page.getByRole("dialog");
  for (const name of await dialog.locator("label").allTextContents()) {
    const box = dialog.locator("div.flex").filter({ has: page.locator("label", { hasText: name }) }).getByRole("checkbox");
    const want = names === "all" || names.includes(name);
    if (((await box.getAttribute("aria-checked")) === "true") !== want) await box.click();
  }
  await dialog.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByText(/Klien .* disimpan/)).toBeVisible();
}

test("an admin narrows an akuntan to one client, then makes them a reviewer who reads but cannot import", async ({ page, browser, baseURL }) => {
  const akuntan = credentials("credentials-akuntan.json").email;
  await page.goto("/settings?tab=tim");
  await expect(page.getByRole("link", { name: "Tim" })).toHaveAttribute("aria-current", "page");
  await expect(row(page, akuntan)).toContainText("Akuntan");
  await setClients(page, akuntan, ["CV Sinar Retail"]);

  const them = await signIn(browser, baseURL, "credentials-akuntan.json");
  await expect(them.locator("body")).toContainText("CV Sinar Retail");
  await expect(them.locator("body")).not.toContainText("PT Jasa Kreatif Digital");
  await expect(them.getByRole("link", { name: "Tim" })).toHaveCount(0);

  await row(page, akuntan).getByRole("combobox").click();
  await page.getByRole("option", { name: "Peninjau" }).click();
  await expect(page.getByText("diubah menjadi Peninjau")).toBeVisible();

  await them.reload();
  const href = await them.getByRole("link", { name: "CV Sinar Retail", exact: true }).first().getAttribute("href");
  const id = href!.match(/clients\/([^/?]+)/)![1];
  expect((await them.goto(`/clients/${id}/reports`))?.status()).toBe(200);
  await them.goto(`/clients/${id}/import`);
  await openManualImport(them);
  await expect(them.getByRole("button", { name: /Proses mutasi/ })).toBeDisabled();
  await expect(them.getByTestId("write-blocked").first()).toContainText("Peran Peninjau hanya dapat melihat dan mengunduh laporan.");

  // Restore: back to Akuntan on every client, as e2e-setup made them.
  await row(page, akuntan).getByRole("combobox").click();
  await page.getByRole("option", { name: "Akuntan" }).click();
  await expect(page.getByText("diubah menjadi Akuntan")).toBeVisible();
  await setClients(page, akuntan, "all");
});
