import { expect, test } from "@playwright/test";
import { openClientForm } from "./qa-helpers";

/** Saldo Awal reads a typed amount back formatted when the field is left, like Jurnal Penyesuaian (production run 2026-10-09). */
test("Saldo Awal: a typed amount reads back formatted, unreadable text stays for its message", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Saldo Rapi Uji");
  await page.getByLabel("Nama lengkap").fill("PT Saldo Rapi Uji");
  await page.getByLabel("Nomor rekening").fill("5550001112");
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  const base = new URL(page.url()).pathname.match(/\/clients\/[^/]+/)![0];
  await page.goto(`${base}/opening`);
  const bank = page.getByLabel(/^Saldo BCA/);
  await bank.fill("150000000");
  await bank.press("Tab");
  await expect(bank).toHaveValue("150.000.000");
  const retained = page.getByLabel("Saldo Laba kredit");
  await retained.fill("12500000");
  await retained.press("Tab");
  await expect(retained).toHaveValue("12.500.000");
  await bank.fill("1,000");
  await bank.press("Tab");
  await expect(bank).toHaveValue("1,000");
});
