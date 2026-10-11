import { expect, test } from "@playwright/test";
import { openManualImport, openClientForm } from "./qa-helpers";

/**
 * Persediaan (periodic method, accounting-rules 5i), end to end (synthetic): a trading client's June stock count is journaled to
 * 5190 Perubahan Persediaan, the Laba Rugi carries it inside Beban pokok, and the close control reads the count.
 */
const CSV = [
  "Tanggal;Keterangan;Debet;Kredit;Saldo",
  "05/06/2026;TRSF DB TOKO SUMBER BAHAN PEMBELIAN SEMEN;15000000;0;85000000",
  "20/06/2026;TRSF CR PELANGGAN PROYEK RUKO;0;30000000;115000000",
  "",
].join("\n");

test("Persediaan: stock count journaled to 5190, shown in Laba Rugi and the close", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Toko Uji Persediaan");
  await page.getByLabel("Bidang usaha").fill("toko bahan bangunan");
  await page.getByLabel("Nama lengkap").fill("CV Uji Persediaan");
  await page.getByLabel("Nama singkat").fill("CV Stok");
  await page.getByLabel("Nomor rekening").fill("6677889900");
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await page.waitForURL(/\/clients\/[^/]+\/import/);
  const base = page.url().replace(/\/import.*$/, "");
  await openManualImport(page);
  await page.getByTestId("file-input").setInputFiles({ name: "bca-juni.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
  await page.getByRole("button", { name: "Proses mutasi" }).click();
  await expect(page.getByTestId("import-result")).toContainText("Nyambung");

  await page.goto(`${base}/inventory?period=2026-06`);
  await expect(page.getByRole("heading", { name: "Persediaan", exact: true })).toBeVisible();
  const card = page.getByTestId("inventory-entity");
  await card.getByLabel(/Nilai persediaan hasil stock opname/).fill("12.500.000");
  await expect(card.getByTestId("inventory-diff")).toContainText("kenaikan: Dr 1160 / Cr 5190");
  await card.getByRole("button", { name: "Catat persediaan akhir" }).click();
  await expect(card.getByText("Sesuai hitungan")).toBeVisible();

  await page.goto(`${base}/reports?period=2026-06&tab=pl`);
  await expect(page.getByRole("row", { name: /5190 Perubahan Persediaan/ }).first()).toContainText("(12.500.000)");
  await page.goto(`${base}/close?period=2026-06`);
  await expect(page.getByTestId("control-inv")).toContainText("Saldo buku = hasil hitung");
});
