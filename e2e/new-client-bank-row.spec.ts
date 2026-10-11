import { expect, test } from "@playwright/test";
import { openClientForm } from "./qa-helpers";

/** Tambah klien starts with one empty bank row: saving without touching it must not look like nothing happened. */
test("Tambah klien: an untouched bank row is ignored, a half-filled one says what is missing", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Klien Baris Kosong");
  await page.getByLabel("Nama lengkap").fill("PT Baris Kosong");

  // A name without an account number is a mistake: the field says so, in Bahasa, and nothing is saved.
  await page.getByLabel("Nama rekening").fill("Giro utama");
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByText("Isi nomor rekening.").first()).toBeVisible();
  await expect(page).toHaveURL(/\/clients\/new\?manual=1$/);

  // Clearing the name leaves an empty row: it is ignored and the client is saved without a bank account.
  await page.getByLabel("Nama rekening").fill("");
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  const base = new URL(page.url()).pathname.match(/\/clients\/[^/]+/)![0];

  await page.goto(`${base}/settings`);
  const card = page.getByTestId("delete-client");
  await card.getByLabel("Ketik nama klien untuk konfirmasi").fill("Klien Baris Kosong");
  await card.getByRole("button", { name: "Hapus klien" }).click();
  await expect(page.getByRole("heading", { name: "Beranda", exact: true })).toBeVisible();
});
