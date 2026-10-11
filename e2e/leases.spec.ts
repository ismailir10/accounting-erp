import { expect, test } from "@playwright/test";
import { openManualImport, openClientForm } from "./qa-helpers";

/**
 * Lease register (PSAK 116), end to end (synthetic): an office lease of 24 × 10 jt paid monthly in arrears at 12 % a year, from June
 * 2026 → commencement (ROU 212 433 873) → June–August journals → the rent paid from the statement is classified to 2170 → the register
 * equals the ledger and the close control passes.
 */
const CSV = [
  "Tanggal;Keterangan;Debet;Kredit;Saldo",
  "30/06/2026;TRSF DB PT GRAHA PROPERTI SEWA JUN;10000000;0;90000000",
  "31/07/2026;TRSF DB PT GRAHA PROPERTI SEWA JUL;10000000;0;80000000",
  "31/08/2026;TRSF DB PT GRAHA PROPERTI SEWA AGU;10000000;0;70000000",
  "",
].join("\n");

test("leases: register, commencement, monthly journals, payments, control", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Grup Uji Sewa");
  await page.getByLabel("Nama lengkap").fill("PT Sewa Uji");
  await page.getByLabel("Nama singkat").fill("SWU");
  await page.getByLabel("Nomor rekening").fill("5544332211");
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await page.waitForURL(/\/clients\/[^/]+\/import/);
  const base = page.url().replace(/\/import.*$/, "");
  await page.goto(`${base}/import`);
  await openManualImport(page);
  await page.getByTestId("file-input").setInputFiles({ name: "bca.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
  await page.getByRole("button", { name: "Proses mutasi" }).click();
  await expect(page.getByTestId("import-result")).toContainText("Nyambung");

  // Register the lease from the sidebar.
  await page.goto(`${base}/leases?period=2026-08`);
  await expect(page.getByRole("heading", { name: "Sewa (PSAK 116)" })).toBeVisible();
  await page.getByRole("button", { name: "Sewa baru" }).click();
  await page.getByLabel("Nama sewa").fill("Kantor Sudirman");
  await page.getByLabel("Pihak yang menyewakan").fill("PT Graha Properti");
  await page.getByLabel("Bulan mulai").fill("2026-06");
  await page.getByLabel("Masa sewa (bulan)").fill("24");
  await page.getByLabel("Pembayaran per interval").fill("10.000.000");
  await page.getByRole("combobox", { name: "Waktu pembayaran" }).click();
  await page.getByRole("option", { name: /Di akhir interval/ }).click();
  await page.getByLabel("Suku bunga diskonto (% per tahun)").fill("12");
  await page.getByRole("button", { name: "Simpan sewa" }).click();
  await expect(page.getByText("Sewa Kantor Sudirman didaftarkan")).toBeVisible();

  const reg = page.getByTestId("leases-SWU");
  await expect(reg.getByTestId("lease-Kantor Sudirman")).toContainText("212.433.873");
  await expect(reg.getByTestId("lease-Kantor Sudirman")).toContainText("3 jurnal bulanan belum dicatat");
  await reg.getByRole("button", { name: "Kantor Sudirman" }).click();
  await expect(reg.getByTestId("lease-schedule-Kantor Sudirman")).toContainText("2.124.338");
  await reg.getByRole("button", { name: "Catat 3 jurnal sewa s.d. Agustus 2026" }).click();
  await expect(page.getByText("Jurnal sewa dicatat")).toBeVisible();
  await expect(reg).toContainText("Semua jurnal bulanan sewa s.d. Agustus 2026 sudah dicatat");
  // No payment classified yet: the ledger owes 30 jt more.
  await expect(reg).toContainText("Beda dengan buku besar");

  // Classify the three rent payments to 2170 in Review.
  await page.goto(`${base}/review`);
  const items = page.getByTestId("review-item");
  for (let n = 3; n > 0; n--) {
    const item = items.filter({ hasText: "GRAHA PROPERTI" }).first();
    await item.getByRole("combobox", { name: "Akun" }).click();
    await page.getByRole("option", { name: /^2170 Liabilitas Sewa Jangka Pendek/ }).click();
    await item.getByTestId("accept").click();
    await expect(items.filter({ hasText: "GRAHA PROPERTI" })).toHaveCount(n - 1);
  }
  // Accepts are optimistic: wait until the queue says every save is done before leaving.
  await expect(page.getByTestId("review-saving")).toHaveCount(0);

  await page.goto(`${base}/leases?period=2026-08`);
  await expect(reg).toContainText("Cocok dengan buku besar");
  await page.goto(`${base}/close?period=2026-08`);
  await expect(page.getByTestId("control-lease")).toContainText("liabilitas sewa");
  await expect(page.getByTestId("control-lease")).toContainText("Lolos");
  await page.goto(`${base}/ledger/1230?period=2026-06`);
  await expect(page.getByText("Pengakuan awal sewa Kantor Sudirman · PT Graha Properti (PSAK 116)")).toBeVisible();

  if (process.env.E2E_SCREENSHOTS) {
    await page.goto(`${base}/leases?period=2026-08`);
    await page.getByRole("button", { name: "Kantor Sudirman" }).click();
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/leases-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/leases-390.png`, fullPage: true });
  }
});
