import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { openManualImport } from "./qa-helpers";

/**
 * Support sessions (ADR 0017 §2, cycle 2026-10-09-trial-tenants-roles T18): a Buku admin enables two-step login, opens a firm's
 * workspace as its AKUNTAN, walks every client page and a download, and leaves. Every tenant table is exactly as before; only Buku's
 * own support log grew. Accounts come from scripts/e2e-setup.ts.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from a base32 secret, as an authenticator app computes it. */
function totp(secret: string, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret.replace(/=+$/, "").toUpperCase()].map((c) => alphabet.indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** Every tenant table's row count (Buku's own support log excluded), read through tsx because Prisma is ESM. */
const tenantCounts = () => JSON.parse(execFileSync("npx", ["tsx", "scripts/e2e-table-counts.ts"], { env: process.env, encoding: "utf8" })) as Record<string, number>;

const ROUTES = ["", "/import", "/review", "/opening", "/ledger", "/trial-balance", "/reports", "/tax", "/tax/masa", "/close", "/assets", "/inventory", "/leases", "/benefits", "/receivables", "/rates", "/settings", "/history"];

async function signInOps(page: Page) {
  const { email, password } = JSON.parse(readFileSync(".playwright/credentials-ops.json", "utf8")) as { email: string; password: string };
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Kata sandi").fill(password);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await page.waitForURL(/\/backoffice$/, { timeout: 30_000 });
}

test("a Buku admin with two-step login looks into a firm as its akuntan, read-only, and leaves no trace in the firm", async ({ page }) => {
  await signInOps(page);
  await page.goto("/backoffice/keamanan");
  const secret = (await page.getByTestId("totp-secret").textContent())!.trim();
  await page.getByLabel("Kode 6 angka").fill(totp(secret));
  await page.getByRole("button", { name: "Verifikasi" }).click();
  await expect(page.getByTestId("mfa-done")).toBeVisible();

  const before = tenantCounts();
  await page.goto("/backoffice");
  await page.getByRole("link", { name: "KJA Demo & Rekan" }).click();
  const form = page.getByTestId("support-form");
  await form.getByRole("combobox", { name: "Lihat sebagai" }).click();
  await page.getByRole("option", { name: "Akuntan uji · Akuntan" }).click();
  await form.getByLabel("Alasan").fill("Neraca Agustus tidak seimbang, tiket 42");
  await form.getByRole("button", { name: "Buka ruang kerja" }).click();
  // A refusal shows as a toast; a session that does not resolve lands back in the backoffice. Either way, say which.
  const opened = page.getByTestId("support-bar").or(page.locator("[data-sonner-toast]")).first();
  await opened.waitFor({ timeout: 30_000 }).catch(() => {});
  const refusal = await page.locator("[data-sonner-toast]").allTextContents();
  expect(refusal, `support session refused at ${page.url()}`).toEqual([]);
  await expect(page.getByTestId("support-bar"), `no support bar at ${page.url()}`).toContainText("sebagai Akuntan uji");
  await expect(page.getByTestId("support-bar")).toContainText("hanya baca");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Beranda", exact: true })).toBeVisible();
  await expect(page.getByTestId("support-bar")).toContainText("hanya baca");

  const href = await page.getByRole("link", { name: "CV Sinar Retail", exact: true }).first().getAttribute("href");
  const id = href!.match(/clients\/([^/?]+)/)![1];
  for (const route of ROUTES) {
    const response = await page.goto(`/clients/${id}${route}`);
    expect(response?.status(), route || "/").toBeLessThan(400);
    await expect(page.getByTestId("support-bar")).toBeVisible();
  }
  expect((await page.request.get(`/clients/${id}/reports/export`)).status()).toBe(200);
  await page.goto(`/clients/${id}/import`);
  await openManualImport(page);
  await expect(page.getByRole("button", { name: /Proses mutasi/ })).toBeDisabled();
  await expect(page.getByTestId("write-blocked").first()).toContainText("Mode dukungan hanya baca");

  await page.getByTestId("support-bar").getByRole("button", { name: "Keluar" }).click();
  await page.waitForURL(/\/backoffice\/orgs\//);
  await expect(page.getByTestId("support-sessions")).toContainText("Neraca Agustus tidak seimbang");
  await expect(page.getByTestId("support-sessions")).toContainText("selesai");

  expect(tenantCounts(), "no tenant table changed during the support session").toEqual(before);
});

test("without two-step login the workspace cannot be opened", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await signInOps(page);
  await page.goto("/backoffice");
  await page.getByRole("link", { name: "KJA Demo & Rekan" }).click();
  await expect(page.getByTestId("support-form")).toHaveCount(0);
  await expect(page.getByText("Aktifkan verifikasi dua langkah")).toBeVisible();
});
