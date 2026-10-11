import { expect, test } from "@playwright/test";
import { workbook, type FixtureCell } from "../tests/xls-fixture";
import { openManualImport, openClientForm } from "./qa-helpers";

/**
 * An accountant's working copy of a statement as a legacy .xls (synthetic): one sheet per month, dd/MM dates without a year,
 * SALDO AWAL rows and debet = money in. Upload → the year question (prefilled from the file name) → three months in one
 * import, with the way the file was read stated on the result and in the history.
 */
const HEADER: FixtureCell[] = ["TANGGAL", null, "KETERANGAN", "DEBET", "KREDIT", "SISA SALDO"];
const xls = workbook(
  [
    { name: "MAY", rows: [HEADER, ["01/05", "SALDO AWAL", null, null, null, 10_000_000], ["02/05", "TRSF E-BANKING CR", "TOKO SATU", 3_000_000, null, 13_000_000], ["31/05", "BIAYA ADM", null, null, 30_000, 12_970_000]] },
    { name: "JUN", rows: [HEADER, ["01/06", "SALDO AWAL", null, null, null, 12_970_000], ["03/06", "TRSF E-BANKING CR", "TOKO DUA", 5_000_000, null, 17_970_000]] },
    { name: "JUL", rows: [HEADER, ["01/07", "SALDO AWAL", null, null, null, 17_970_000], ["09/07", "BIAYA ADM", null, null, 30_000, 17_940_000]] },
  ],
  "biff8",
);

test("statement .xls: year question, three months in one import, how the file was read", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Grup Uji Excel Lama");
  await page.getByLabel("Nama lengkap").fill("PT Excel Lama Uji");
  await page.getByLabel("Nama singkat").fill("XLS");
  await page.getByLabel("Nomor rekening").fill("7766554433");
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await page.waitForURL(/\/clients\/[^/]+\/import/);
  await openManualImport(page);

  await page.getByTestId("file-input").setInputFiles({ name: "BCA_GIRO_MAY_26-JUL_26.xls", mimeType: "application/vnd.ms-excel", buffer: xls });
  await page.getByRole("button", { name: "Proses mutasi" }).click();
  const year = page.getByLabel("Tahun bulan pertama di file");
  await expect(year).toHaveValue("2026");
  await expect(page.getByText("Tahun diisi dari nama file; pastikan benar sebelum memproses.", { exact: false })).toBeVisible();
  await expect(page.getByTestId("import-result")).toContainText("Hasil klasifikasi muncul di sini.");

  await page.getByRole("button", { name: "Proses mutasi" }).click();
  const result = page.getByTestId("import-result");
  await expect(result).toContainText("Mei 2026 – Juli 2026 (3 bulan)");
  await expect(result).toContainText("Nyambung");
  await expect(page.getByTestId("import-notes")).toContainText("3 lembar dibaca sebagai satu rekening koran: MAY, JUN, JUL.");
  await expect(page.getByTestId("import-notes")).toContainText("Kolom Debet dibaca sebagai uang masuk");
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/import-xls.png`, fullPage: true });
  // The history (Riwayat tab) keeps how the file was read.
  await page.getByRole("tab", { name: "Riwayat", exact: true }).click();
  await expect(page.getByRole("row", { name: /BCA_GIRO_MAY_26-JUL_26\.xls/ })).toContainText("Kolom Debet dibaca sebagai uang masuk");
});
