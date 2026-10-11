import { expect, test } from "@playwright/test";
import { openClientForm } from "./qa-helpers";

/** An admin removes a client entered by mistake: the typed name is the confirmation (staging E2E 2026-09-29, L11). */
test("Hapus klien: typed name, then the client and its books are gone", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Klien Salah Ketik");
  await page.getByLabel("Nama lengkap").fill("PT Salah Ketik");
  await page.getByRole("button", { name: "Hapus rekening" }).click();
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  const base = new URL(page.url()).pathname.match(/\/clients\/[^/]+/)![0];

  await page.goto(`${base}/settings`);
  const card = page.getByTestId("delete-client");
  const button = card.getByRole("button", { name: "Hapus klien" });
  await expect(button).toBeDisabled();
  await card.getByLabel("Ketik nama klien untuk konfirmasi").fill("Klien Salah");
  await expect(button).toBeDisabled();
  await card.getByLabel("Ketik nama klien untuk konfirmasi").fill("Klien Salah Ketik");
  await button.click();
  await expect(page.getByRole("heading", { name: "Beranda", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Klien Salah Ketik" })).toHaveCount(0);
  await page.goto(`${base}/settings`);
  await expect(page.getByRole("heading", { name: "Halaman tidak ditemukan" })).toBeVisible();
});
