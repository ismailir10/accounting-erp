import { expect, test, type Page } from "@playwright/test";
import { openClientForm } from "./qa-helpers";

/**
 * Balik jurnal (accounting-rules 3a), synthetic: an accrual typed in Jurnal Penyesuaian is reversed from the ledger drawer on the 1st of
 * the next month; the original stays, the reversal mirrors it, and it can't be reversed twice.
 */
async function pickOption(page: Page, label: string, name: RegExp) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name }).click();
  // The list closes before the next picker opens: two open lists would both offer the same account.
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

test("a manual accrual is reversed from its ledger line on the next month's first day", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Grup Uji Pembalik");
  await page.getByLabel("Nama lengkap").fill("PT Pembalik Uji");
  await page.getByLabel("Nama singkat").fill("BALIK");
  await page.getByRole("button", { name: "Hapus rekening" }).click();
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  const base = page.url().replace(/\/import.*$/, "");

  await page.goto(`${base}/journals/new?period=2026-07`);
  await page.getByLabel("Tanggal").fill("2026-07-31");
  await page.getByLabel("Keterangan").fill("Akrual listrik Juli");
  await pickOption(page, "Akun baris 1", /^6130 /);
  await page.getByLabel("Debit baris 1").fill("2.500.000");
  await pickOption(page, "Akun baris 2", /^2150 /);
  await page.getByLabel("Kredit baris 2").fill("2.500.000");
  await page.getByRole("button", { name: "Simpan jurnal" }).click();
  await expect(page.getByText("Jurnal penyesuaian tersimpan")).toBeVisible();

  await page.goto(`${base}/ledger/2150?period=2026-07`);
  await page.getByText("Akrual listrik Juli").first().click();
  const drawer = page.getByTestId("reverse-entry");
  await expect(drawer.getByLabel("Tanggal jurnal pembalik")).toHaveValue("2026-08-01");
  await drawer.getByRole("button", { name: "Balik jurnal" }).click();
  await expect(page.getByText("Jurnal pembalik dicatat")).toBeVisible();

  await page.goto(`${base}/ledger/2150?period=2026-08`);
  await page.getByText("Pembalik: Akrual listrik Juli (31 Jul 2026)").first().click();
  await expect(page.getByTestId("reverse-entry")).toContainText("Ini jurnal pembalik");
});
