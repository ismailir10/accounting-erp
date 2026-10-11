import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { openClientForm } from "./qa-helpers";

/**
 * Who can see and do what, from the end-to-end QA run (docs/qa, cases A12–A14, U1): a second firm's ADMIN reaches nothing of the demo
 * firm's by any URL, and an AKUNTAN cannot do what only an admin may. The two extra accounts are created by scripts/e2e-setup.ts
 * through the Supabase admin API; both sign in through the real form (no bypass). Uses the demo firm's CV Sinar Retail and PT Jasa Kreatif Digital.
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

async function clientId(page: Page, name: string): Promise<string> {
  await page.goto("/");
  const href = await page.getByRole("link", { name, exact: true }).first().getAttribute("href");
  return href!.match(/clients\/([^/?]+)/)![1];
}

const ROUTES = ["", "/import", "/review", "/opening", "/ledger", "/trial-balance", "/reports", "/tax", "/tax/masa", "/close", "/assets", "/inventory", "/leases", "/benefits", "/receivables", "/rates", "/settings", "/journals/new"];

test("another firm's ADMIN reaches nothing of this firm: not by route, export, or forged scope", async ({ page, browser, baseURL }) => {
  const id = await clientId(page, "CV Sinar Retail");
  const entity = (await page.goto(`/clients/${id}/tax`).then(() => page.url()).then((u) => new URL(u).searchParams.get("entity"))) ?? "";
  const other = await signIn(browser, baseURL, "credentials-other-firm.json");

  await expect(other.locator("body")).not.toContainText("CV Sinar Retail");
  await expect(other.locator("body")).not.toContainText("Grup Ayam Nusantara");

  const leaks: string[] = [];
  for (const route of ROUTES) {
    const response = await other.goto(`/clients/${id}${route}`);
    if (response?.status() !== 404) leaks.push(`${route || "/"} → ${response?.status()}`);
  }
  expect(leaks, "client routes of another firm must be 404").toEqual([]);

  for (const path of ["reports", "tax", "tax/masa"]) {
    const response = await other.request.get(`/clients/${id}/${path}/export?entity=${entity}&period=2026-08`);
    expect(response.status(), `${path} export`).toBe(404);
  }

  await other.goto(`/?scope=client:${id}&period=2026-08`);
  await expect(other.getByText("Cakupan tidak tersedia")).toBeVisible();
  await expect(other.locator("body")).not.toContainText("Sinar Retail");
  await other.context().close();
});

test("an AKUNTAN cannot delete a client, change AI settings, or reopen a closed month; an ADMIN can see those controls", async ({ page, browser, baseURL }) => {
  const sinar = await clientId(page, "CV Sinar Retail");
  const jasa = await clientId(page, "PT Jasa Kreatif Digital");

  await page.goto(`/clients/${sinar}/settings`);
  await expect(page.getByText("Hapus klien").first()).toBeVisible();
  await page.goto(`/clients/${jasa}/close?period=2026-08`);
  await expect(page.getByTestId("unlock")).toBeVisible();
  // The AI key is Buku's (ADR 0017 §6): not even an organisation admin can change it.
  await page.goto(`/settings`);
  await expect(page.getByTestId("ai-status")).toBeVisible();
  await expect(page.getByLabel("Kunci API baru")).toHaveCount(0);

  const akuntan = await signIn(browser, baseURL, "credentials-akuntan.json");
  await akuntan.goto(`/settings`);
  await expect(akuntan.getByTestId("ai-status")).toBeVisible();
  await expect(akuntan.getByLabel("Kunci API baru")).toHaveCount(0);
  await expect(akuntan.getByRole("link", { name: "Tim" })).toHaveCount(0);
  await akuntan.goto(`/clients/${sinar}/settings`);
  await expect(akuntan.getByRole("heading", { name: "Pengaturan klien" })).toBeVisible();
  await expect(akuntan.getByText("Hapus klien")).toHaveCount(0);
  await akuntan.goto(`/clients/${jasa}/close?period=2026-08`);
  await expect(akuntan.getByRole("heading", { name: "Tutup Buku" })).toBeVisible();
  await expect(akuntan.getByTestId("unlock")).toHaveCount(0);
  await akuntan.context().close();
});

test.describe("sign-in does not reveal who has an account, and typed HTML stays inert", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("wrong password and unknown e-mail give the same message; the reset notice is identical for members and strangers", async ({ page }) => {
    const { email } = credentials("credentials.json");
    const attempt = async (address: string, password: string) => {
      await page.goto("/login");
      await page.getByLabel("Email").fill(address);
      await page.getByLabel("Kata sandi").fill(password);
      await page.getByRole("button", { name: "Masuk", exact: true }).click();
      // #login-error only: Next's empty route announcer is also role=alert and can match first while the action is still running.
      await expect(page.locator("#login-error")).toBeVisible();
      return (await page.locator("#login-error").innerText()).trim();
    };
    const wrongPassword = await attempt(email, "salah-total-1");
    const unknown = await attempt("tidak-ada@example.test", "salah-total-1");
    expect(wrongPassword).toContain("Email atau kata sandi tidak cocok");
    expect(unknown).toBe(wrongPassword);

    const reset = async (address: string) => {
      await page.goto("/login/lupa");
      await page.getByLabel("Email").fill(address);
      await page.getByRole("button", { name: /Kirim/i }).click();
      // The notice itself, not just "tautan": the intro already says it, so the page could be read while the button still says "Mengirim…".
      await expect(page.getByText("Jika alamat ini terdaftar")).toBeVisible();
      await expect(page.getByRole("button", { name: "Kirim tautan" })).toBeVisible();
      return (await page.locator("body").innerText()).replace(/\s+/g, " ");
    };
    expect(await reset("bukan-anggota@example.test")).toBe(await reset(email));
  });
});

test("HTML typed into a client name is shown as text, never run", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("QA XSS <img src=x onerror=alert(1)>");
  await page.getByLabel("Nama lengkap").fill("PT XSS <script>alert(2)</script>");
  await page.getByLabel("Nomor rekening").fill("7000300001");
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  await page.goto("/");
  await expect(page.getByText("QA XSS <img src=x onerror=alert(1)>").first()).toBeVisible();
  await expect(page.locator("img[src=x]")).toHaveCount(0);
  expect(dialogs).toEqual([]);
});
