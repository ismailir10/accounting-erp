import { expect, test, type Page } from "@playwright/test";
import { openClientForm } from "./qa-helpers";

/**
 * Fixed-asset register, end to end (synthetic): a purchase journal on 1210 → Aset Tetap shows it as unregistered → Daftarkan
 * (Kelompok 2, 96 months) → the register and the fiscal estimate → next month's depreciation proposed and posted → the asset is
 * sold at a gain → derecognised, and the register still agrees with the ledger.
 */
async function pickOption(page: Page, label: string, option: string | RegExp) {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).click();
  // The list closes before the next picker opens: two open lists would both offer the same account.
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

test("fixed assets: register a purchase, depreciate, dispose at a gain", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Grup Uji Aset Tetap");
  await page.getByLabel("Nama lengkap").fill("PT Aset Uji");
  await page.getByLabel("Nama singkat").fill("ASET");
  await page.getByRole("button", { name: "Hapus rekening" }).click();
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  const base = page.url().replace(/\/import.*$/, "");

  // A purchase on credit, typed as a journal.
  await page.goto(`${base}/journals/new?period=2026-07`);
  await page.locator('input[type="date"]').first().fill("2026-07-15");
  await page.getByPlaceholder("mis. Penyusutan Agustus").fill("Beli mobil box");
  await pickOption(page, "Akun baris 1", /^1210 Aset Tetap/);
  await page.getByLabel("Debit baris 1").fill("96.000.000");
  await pickOption(page, "Akun baris 2", /^2110 Utang Usaha/);
  await page.getByLabel("Kredit baris 2").fill("96.000.000");
  await page.getByRole("button", { name: "Simpan jurnal" }).click();
  await expect(page.getByText("Jurnal penyesuaian tersimpan")).toBeVisible();

  // Aset Tetap: the purchase waits to be registered.
  await page.goto(`${base}/assets?period=2026-07`);
  await expect(page.getByTestId("next-step")).toContainText("Daftarkan 1 pembelian aset tetap");
  await page.getByTestId("asset-candidates").getByRole("button", { name: "Daftarkan" }).click();
  await page.getByLabel("Nama aset").fill("Mobil box");
  await pickOption(page, "Kelompok fiskal", "Kelompok 2 (8 tahun)");
  await expect(page.getByLabel("Masa manfaat buku (bulan)")).toHaveValue("96");
  await page.getByRole("button", { name: "Simpan aset" }).click();
  await expect(page.getByText("Mobil box terdaftar")).toBeVisible();

  // July: nothing booked yet; the fiscal estimate starts in July (12,5 % × 96 jt × 6/12 = 6 jt a year, 1 jt a month).
  const register = page.getByTestId("register-ASET");
  await expect(register.getByRole("row", { name: /Mobil box/ })).toContainText("96.000.000");
  await expect(register.getByRole("row", { name: /Mobil box/ })).toContainText("(1.000.000)");
  await expect(page.getByTestId("next-step")).toContainText("cocok dengan buku besar");

  // August: the first installment is due; post it from Jurnal Penyesuaian.
  await page.goto(`${base}/assets?period=2026-08`);
  await expect(page.getByTestId("next-step")).toContainText("Catat 1 penyusutan");
  await page.goto(`${base}/journals/new?period=2026-08`);
  await page.getByRole("button", { name: "Catat", exact: true }).click();
  await expect(page.getByText("Penyusutan Mobil box (1/96) dicatat")).toBeVisible();

  // The book value drills to the asset's entries: the purchase and the August installment, each on its ledger month.
  await page.goto(`${base}/assets?period=2026-08`);
  await register.getByRole("link", { name: "Nilai buku Mobil box" }).click();
  await expect(page.getByRole("heading", { name: "Mobil box" })).toBeVisible();
  await expect(page.getByTestId("movement-ACQUIRED")).toContainText("96.000.000");
  await expect(page.getByTestId("movement-DEPRECIATION")).toContainText("95.000.000");
  await expect(page.getByTestId("movement-DEPRECIATION").getByRole("link")).toHaveAttribute("href", /\/ledger\/1219\?entity=.*&period=2026-08/);

  // Sell it at the end of August for 97 jt: book value 95 jt → gain 2 jt.
  await page.goto(`${base}/assets?period=2026-08`);
  await expect(register.getByRole("row", { name: /Mobil box/ })).toContainText("95.000.000");
  await register.getByRole("button", { name: "Lepas" }).click();
  await page.getByLabel("Hasil penjualan").fill("97.000.000");
  await page.getByRole("button", { name: "Catat pelepasan" }).click();
  await expect(page.getByText("Pelepasan Mobil box dicatat")).toBeVisible();
  await expect(register.getByRole("row", { name: /Mobil box/ })).toContainText("Dilepas 31 Agu 2026, hasil Rp 97.000.000");
  await expect(page.getByTestId("register-ledger")).toBeVisible();
  await expect(register).toContainText("Cocok dengan buku besar");

  // The gain is in the ledger on 7300.
  await page.goto(`${base}/ledger/7300?period=2026-08`);
  await expect(page.getByText("Pelepasan aset: Mobil box (laba Rp 2.000.000)")).toBeVisible();
  if (process.env.E2E_SCREENSHOTS) {
    await page.goto(`${base}/assets?period=2026-08`);
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/assets-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/assets-390.png`, fullPage: true });
  }
});
