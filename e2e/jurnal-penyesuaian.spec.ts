import { expect, test, type Page } from "@playwright/test";
import { addClient } from "./qa-helpers";

/**
 * Jurnal Penyesuaian like the incumbents' manual journal: a line note, an accrual reversed automatically on the first of the next month,
 * and *Salin* to start the next month's journal from this one.
 */
async function pick(page: Page, label: string, name: RegExp) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

test("an accrual with a line note reverses on the 1st of next month, and Salin copies it", async ({ page }) => {
  const id = await addClient(page, { name: "Uji Akrual Otomatis" });
  await page.goto(`/clients/${id}/journals/new?period=2026-07`);
  await page.getByLabel("Tanggal").fill("2026-07-31");
  await page.getByLabel("Keterangan").fill("Akrual jasa konsultan Juli");
  await pick(page, "Akun baris 1", /^6170 /);
  await page.getByLabel("Catatan baris 1").fill("Invoice konsultan menyusul");
  await page.getByLabel("Debit baris 1").fill("4.000.000");
  await pick(page, "Akun baris 2", /^2150 /);
  await page.getByLabel("Kredit baris 2").fill("4.000.000");
  await page.getByText("Balik otomatis pada 1 Agustus 2026").click();
  await page.getByRole("button", { name: "Simpan jurnal" }).click();
  await expect(page.getByText("Jurnal penyesuaian tersimpan, dibalik pada 1 Agustus 2026")).toBeVisible();
  await expect(page.getByText("dibalik 1 Agu 2026")).toBeVisible();

  // The reversal sits in August's ledger of 2150, mirrored.
  await page.goto(`/clients/${id}/ledger/2150?period=2026-08`);
  await expect(page.getByTestId("ledger-row")).toContainText("Pembalik: Akrual jasa konsultan Juli (31 Jul 2026)");
  await page.getByTestId("ledger-row").first().click();
  await expect(page.getByText("Invoice konsultan menyusul")).toBeVisible();

  // Salin: next month's journal starts from this one.
  await page.goto(`/clients/${id}/journals/new?period=2026-08`);
  await page.getByRole("link", { name: "Salin jurnal Akrual jasa konsultan Juli" }).click();
  await expect(page.getByTestId("journal-copy")).toContainText("Disalin dari “Akrual jasa konsultan Juli”");
  await expect(page.getByLabel("Keterangan")).toHaveValue("Akrual jasa konsultan Juli");
  await expect(page.getByLabel("Debit baris 1")).toHaveValue("4.000.000");
  await expect(page.getByLabel("Catatan baris 1")).toHaveValue("Invoice konsultan menyusul");
  await expect(page.getByLabel("Tanggal")).toHaveValue("2026-08-31");
  await expect(page.getByRole("checkbox", { name: /Balik otomatis pada 1 September 2026/ })).toBeChecked();
});
