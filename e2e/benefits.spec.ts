import { expect, test } from "@playwright/test";
import { CENSUS_CSV, mortalityCsv } from "../tests/benefits-fixture";
import { openClientForm } from "./qa-helpers";

/**
 * Employee benefits (PSAK 219), end to end (synthetic table and census): upload the firm's mortality table → assumptions → import the census
 * → DBO at August 2026 → the journal (first year: prior periods to Saldo Laba, 8/12 of the year's cost to 6105). August, not December:
 * a December journal would move the firm's work period for the specs after this one; the December control is covered by the DB tests.
 */
test("employee benefits: table, assumptions, census, valuation, journal", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Grup Uji Imbalan");
  await page.getByLabel("Nama lengkap").fill("PT Imbalan Uji");
  await page.getByLabel("Nama singkat").fill("IMB");
  await page.getByLabel("Nomor rekening").fill("4433221100");
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await page.waitForURL(/\/clients\/[^/]+\/import/);
  const base = page.url().replace(/\/import.*$/, "");

  await page.goto(`${base}/benefits?period=2026-08`);
  await expect(page.getByRole("heading", { name: "Imbalan Kerja (PSAK 219)" })).toBeVisible();
  const card = page.getByTestId("benefits-IMB");

  // The firm's mortality table (a made-up one here, never a copy of TMI IV).
  await card.getByRole("button", { name: "Unggah tabel mortalita" }).click();
  await page.getByLabel("Nama tabel").fill("Tabel uji e2e");
  await page.getByLabel("File").setInputFiles({ name: "mortalita.csv", mimeType: "text/csv", buffer: mortalityCsv() });
  await page.getByRole("button", { name: "Unggah", exact: true }).click();
  await expect(page.getByText("Tabel Tabel uji e2e diunggah")).toBeVisible();

  await card.getByRole("combobox", { name: "Tabel mortalita" }).click();
  await page.getByRole("option", { name: "Tabel uji e2e" }).click();
  await card.getByLabel("Tingkat diskonto per tahun").fill("7");
  await card.getByLabel("Kenaikan gaji per tahun").fill("5");
  await card.getByRole("button", { name: "Simpan asumsi" }).click();
  await expect(page.getByText("Asumsi disimpan")).toBeVisible();

  await page.getByTestId("census-input").setInputFiles({ name: "sensus.csv", mimeType: "text/csv", buffer: Buffer.from(CENSUS_CSV) });
  await expect(page.getByText("Sensus diimpor: 4 ditambahkan, 0 diperbarui")).toBeVisible();
  await expect(card.getByTestId("employee-Budi Santoso")).toContainText("190.068.794");
  await expect(card.getByTestId("employee-Rina Lestari")).toContainText("keluar 30 Jun 2026");

  const valuation = page.getByTestId("valuation-IMB");
  await expect(valuation.getByTestId("eb-dbo")).toContainText("206.632.832");
  await expect(valuation).toContainText("Saldo Laba");
  await expect(valuation).toContainText("24.065.477"); // 6105 Jan–Aug
  await page.getByRole("button", { name: "Catat jurnal imbalan kerja per Agustus 2026" }).click();
  await expect(page.getByText("Jurnal imbalan kerja dicatat")).toBeVisible();
  await expect(page.getByTestId("valuation-IMB")).toContainText("Liabilitas di buku besar sudah sesuai valuasi");
  await page.goto(`${base}/ledger/2310?period=2026-08`);
  await expect(page.getByText(/Imbalan kerja PSAK 219 per 31 Agu 2026: liabilitas Rp\s?206\.632\.832/)).toBeVisible();

  if (process.env.E2E_SCREENSHOTS) {
    await page.goto(`${base}/benefits?period=2026-08`);
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/benefits-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/benefits-390.png`, fullPage: true });
  }
});
