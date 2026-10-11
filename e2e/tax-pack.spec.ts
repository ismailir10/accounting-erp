import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { openClientForm } from "./qa-helpers";

/**
 * Tax pack, end to end (synthetic): a company's year to September — revenue from an invoice, salaries by journal — then a fiscal
 * correction and a bukti potong on the Pajak Badan page → PKP, Pasal 31E tax, PPh 29, next year's PPh 25 → the current-tax journal
 * posted by click and visible in the ledger.
 */
async function pickOption(page: Page, label: string, option: string | RegExp) {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).click();
  // The list closes before the next picker opens: two open lists would both offer the same account.
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

test("tax pack: corrections, PPh badan with 31E, credits, current-tax journal", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Grup Uji Pajak");
  await page.getByLabel("Nama lengkap").fill("PT Pajak Uji");
  await page.getByLabel("Nama singkat").fill("PJK");
  await page.getByRole("button", { name: "Hapus rekening" }).click();
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  const base = page.url().replace(/\/import.*$/, "");

  // Revenue 1 M from an invoice; salaries 400 jt by journal.
  await page.goto(`${base}/receivables?period=2026-03`);
  await page.getByRole("button", { name: "Faktur baru" }).click();
  await page.getByLabel("Pelanggan").fill("PT Pembeli Besar");
  await page.getByLabel("Nomor faktur").fill("INV-1");
  await page.getByLabel("Tanggal faktur").fill("2026-03-15");
  await page.getByLabel("DPP").fill("1.000.000.000");
  await page.getByRole("button", { name: "Simpan faktur" }).click();
  await expect(page.getByText("Faktur INV-1 dicatat")).toBeVisible();
  await page.goto(`${base}/journals/new?period=2026-04`);
  await page.locator('input[type="date"]').first().fill("2026-04-30");
  await page.getByPlaceholder("mis. Penyusutan Agustus").fill("Gaji Januari–April");
  await pickOption(page, "Akun baris 1", /^6100 /);
  await page.getByLabel("Debit baris 1").fill("400.000.000");
  await pickOption(page, "Akun baris 2", /^2110 /);
  await page.getByLabel("Kredit baris 2").fill("400.000.000");
  await page.getByRole("button", { name: "Simpan jurnal" }).click();
  await expect(page.getByText("Jurnal penyesuaian tersimpan")).toBeVisible();

  // Pajak Badan through September.
  await page.goto(`${base}/tax?period=2026-09`);
  await expect(page.getByTestId("tax-pbt")).toContainText("600.000.000");
  await page.getByRole("button", { name: "Koreksi fiskal" }).click();
  await page.getByLabel("Keterangan").fill("Jamuan tanpa daftar nominatif");
  await page.getByLabel("Nominal").fill("10.000.000");
  await page.getByRole("button", { name: "Simpan koreksi" }).click();
  await expect(page.getByText("Koreksi ditambahkan")).toBeVisible();
  await page.getByRole("button", { name: "Kredit pajak" }).click();
  await page.getByLabel("Nomor bukti potong").fill("BP-2026-0001");
  await page.getByLabel("Tanggal").fill("2026-05-05");
  await page.getByLabel("Nominal").fill("20.000.000");
  await page.getByRole("button", { name: "Simpan kredit" }).click();
  await expect(page.getByText("Kredit pajak ditambahkan")).toBeVisible();

  // PKP 610 jt, turnover ≤ 4,8 M → all at 11 % = 67,1 jt; credits 20 jt → PPh 29 47,1 jt; PPh 25 next year projects the nine months to a year: (67,1 − 20) ÷ 9.
  await expect(page.getByTestId("tax-pkp")).toContainText("610.000.000");
  await expect(page.getByTestId("tax-due")).toContainText("67.100.000");
  await expect(page.getByTestId("tax-balance")).toContainText("PPh Pasal 29 kurang bayar");
  await expect(page.getByTestId("tax-balance")).toContainText("47.100.000");
  await expect(page.getByTestId("tax-next")).toContainText("5.233.333");

  // A 2025 loss of 50 jt from last year's SPT: PKP 560 jt → 61,6 jt; PPh 29 41,6 jt.
  await page.getByRole("button", { name: "Rugi fiskal" }).click();
  await page.getByLabel("Sisa rugi", { exact: true }).fill("50.000.000");
  await page.getByRole("button", { name: "Simpan rugi" }).click();
  await expect(page.getByText("Rugi fiskal dicatat")).toBeVisible();
  await expect(page.getByTestId("loss-2025")).toContainText("(50.000.000)");
  await expect(page.getByTestId("tax-pkp")).toContainText("560.000.000");
  await expect(page.getByTestId("tax-due")).toContainText("61.600.000");
  await expect(page.getByTestId("tax-balance")).toContainText("41.600.000");

  // The kertas kerja carries the same figures.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("tax-download").click()]);
  expect(download.suggestedFilename()).toBe("kertas-kerja-pph-badan-PJK-2026-09.xlsx");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await (await download.createReadStream()).toArray()).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0)) as unknown as ArrayBuffer);
  const figures = new Map<string, unknown>();
  wb.getWorksheet("Rekonsiliasi Fiskal")!.eachRow((r) => figures.set(String(r.getCell(1).value ?? "").trim(), r.getCell(2).value));
  expect(figures.get("Kompensasi kerugian")).toBe(-50_000_000);
  expect(figures.get("PPh badan terutang")).toBe(61_600_000);

  const current = page.getByTestId("proposal-CURRENT");
  await expect(current).toContainText("8100 Beban Pajak Penghasilan");
  await expect(current).toContainText("Debit 61.600.000");
  await expect(current).toContainText("2146 Utang PPh Pasal 29");
  await current.getByRole("button", { name: "Catat jurnal per September 2026" }).click();
  await expect(page.getByText("Jurnal PPh badan dicatat")).toBeVisible();
  await expect(current).toContainText("Sudah sesuai estimasi");
  await expect(page.getByTestId("next-step")).toContainText("sudah dijurnal sesuai estimasi");

  await page.goto(`${base}/ledger/8100?period=2026-09`);
  await expect(page.getByText("PPh badan 2026 (estimasi s.d. September 2026)")).toBeVisible();

  // December is the year: next year's PPh 25 = (61,6 jt − 20 jt PPh 23) ÷ 12, and one click puts it on Pajak Masa from April 2027.
  await page.goto(`${base}/tax?period=2026-12`);
  await expect(page.getByTestId("tax-next")).toContainText("3.466.666");
  await page.getByTestId("tax-next-adopt").getByRole("button", { name: "Jadikan angsuran mulai masa April 2027" }).click();
  await expect(page.getByText("Angsuran PPh 25 mulai masa April 2027 disimpan")).toBeVisible();
  await page.goto(`${base}/tax/masa?period=2027-04`);
  await expect(page.getByTestId("pph25-instalment")).toContainText("Angsuran Rp 3.466.666 per bulan mulai masa April 2027");
  if (process.env.E2E_SCREENSHOTS) {
    await page.goto(`${base}/tax?period=2026-09`);
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/tax-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/tax-390.png`, fullPage: true });
  }
});
