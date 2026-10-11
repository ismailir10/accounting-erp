import { expect, test } from "@playwright/test";
import { unknownCsv, unknownPdf } from "../tests/unknown-layout";
import { openManualImport, openClientForm } from "./qa-helpers";

/**
 * Atur kolom: a statement in a layout no reader knows is refused with a way forward; the accountant points at the columns once, proves the
 * rows on Periksa baris and imports; next month's file of that layout then imports straight away, and the layout can be forgotten. July
 * and August 2026 only (the firm's work period must not move past August for the specs after this one). Files are synthetic.
 */
test("map an unknown CSV once, prove and import it; next month's file reads straight away", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Kolom Uji");
  await page.getByLabel("Nama lengkap").fill("PT Kolom Uji");
  await page.getByLabel("Nama singkat").fill("PT KU");
  await page.getByLabel("Nomor rekening").fill("700100200300");
  await page.getByLabel("Nama rekening").fill("Kas Bank Daerah");
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  await openManualImport(page);

  // July's file: no reader knows "Value Dt · Particulars · Withdrawn · Lodged · Position".
  await page.getByTestId("file-input").setInputFiles({ name: "kas-juli.csv", mimeType: "text/csv", buffer: unknownCsv(7) });
  await page.getByRole("button", { name: "Proses mutasi" }).click();
  const notice = page.getByTestId("mappable-notice");
  await expect(notice).toContainText("Kolom tanggal & keterangan tidak ditemukan");
  await notice.getByRole("button", { name: "Atur kolom" }).click();

  // Buku's first guess: header row 4, transactions from row 5, Debet/Kredit/Saldo; the preview reads five rows from the whole file.
  const mapper = page.getByTestId("column-mapper");
  await expect(mapper.getByLabel("Baris transaksi pertama")).toHaveValue("5");
  await expect(mapper.getByRole("combobox", { name: "Kolom A" })).toContainText("Tanggal");
  await expect(mapper.getByRole("combobox", { name: "Kolom D" })).toContainText("Debet");
  await expect(mapper.getByRole("combobox", { name: "Kolom E" })).toContainText("Kredit");
  await expect(mapper.getByRole("combobox", { name: "Kolom F" })).toContainText("Saldo");
  const preview = page.getByTestId("mapping-preview");
  await expect(preview).toContainText("5 transaksi terbaca");
  await expect(preview).toContainText("TRSF E-BANKING CR 0108/FTSCY/WS95031 PT MITRA UNGGAS FIKTIF");
  // The Ref column isn't description: the accountant says so.
  await mapper.getByRole("combobox", { name: "Kolom B" }).click();
  await page.getByRole("option", { name: "Tidak dipakai" }).click();
  await expect(preview).toContainText("5 transaksi terbaca");
  await expect(preview.getByRole("cell", { name: /^R1 / })).toHaveCount(0);
  await page.screenshot({ path: "test-results/column-mapping-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/column-mapping-390.png", fullPage: true });
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1440, height: 900 });

  await mapper.getByRole("button", { name: "Baca semua baris" }).click();
  await expect(page.getByRole("heading", { name: "Periksa baris rekening koran" })).toBeVisible();
  await expect(page.getByText("dibaca dengan pemetaan kolom")).toBeVisible();
  await expect(page.getByTestId("ocr-review")).toContainText("Semua terbukti");
  await page.getByRole("button", { name: "Impor 5 transaksi" }).click();
  await expect(page.getByText("5 transaksi diimpor dari file")).toBeVisible();
  await expect(page.getByText("File ini sudah diimpor")).toBeVisible();

  // August's file of the same layout imports straight away.
  await page.getByTestId("client-bar").getByRole("link", { name: "Unggah", exact: true }).click();
  await openManualImport(page);
  await page.getByTestId("file-input").setInputFiles({ name: "kas-agustus.csv", mimeType: "text/csv", buffer: unknownCsv(8) });
  await page.getByRole("button", { name: "Proses mutasi" }).click();
  const result = page.getByTestId("import-result");
  await expect(result).toContainText("Nyambung");
  const used = page.getByTestId("layout-used");
  await expect(used).toContainText("Dibaca dengan pemetaan kolom tersimpan (dari kas-juli.csv).");
  await page.screenshot({ path: "test-results/column-mapping-remembered.png", fullPage: true });

  // Forgetting it: the same layout is refused again (August is already imported, so the check reuses July's file on another name).
  await used.getByRole("button", { name: "Lupakan pemetaan ini" }).click();
  await expect(page.getByText("Pemetaan kolom dilupakan")).toBeVisible();
  await expect(used).toBeHidden();
  await page.getByTestId("file-input").setInputFiles({ name: "kas-juli-lagi.csv", mimeType: "text/csv", buffer: unknownCsv(7) });
  await page.getByRole("button", { name: "Proses mutasi" }).click();
  await expect(page.getByTestId("mappable-notice")).toBeVisible();
});

test("map an unknown text PDF: columns cut at its header, Debet and Kredit apart", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Kolom PDF Uji");
  await page.getByLabel("Nama lengkap").fill("PT Kolom PDF Uji");
  await page.getByLabel("Nama singkat").fill("PT KPU");
  await page.getByLabel("Nomor rekening").fill("700100200301");
  await page.getByLabel("Nama rekening").fill("Giro Daerah");
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  await openManualImport(page);

  await page.getByTestId("file-input").setInputFiles({ name: "giro-agustus.pdf", mimeType: "application/pdf", buffer: unknownPdf(8) });
  await page.getByRole("button", { name: "Proses mutasi" }).click();
  await page.getByTestId("mappable-notice").getByRole("button", { name: "Atur kolom" }).click();
  const mapper = page.getByTestId("column-mapper");
  await expect(mapper.getByRole("combobox", { name: "Kolom C" })).toContainText("Debet");
  await expect(mapper.getByRole("combobox", { name: "Kolom D" })).toContainText("Kredit");
  await expect(page.getByTestId("mapping-preview")).toContainText("5 transaksi terbaca");
  await mapper.getByRole("button", { name: "Baca semua baris" }).click();
  await expect(page.getByTestId("ocr-review")).toContainText("Semua terbukti");
  await page.getByRole("button", { name: "Impor 5 transaksi" }).click();
  await expect(page.getByText("5 transaksi diimpor dari file")).toBeVisible();
});
