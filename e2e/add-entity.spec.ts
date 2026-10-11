import { expect, test } from "@playwright/test";
import { openManualImport, openClientForm } from "./qa-helpers";

/** A forgotten bank account or owner is added after "Simpan klien", from the client's settings page; nothing has to be deleted and redone. */
test("add a bank account and an owner to an existing client", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Klien Tambah Rekening");
  await page.getByLabel("Nama lengkap").fill("PT Tambah Rekening");
  await page.getByLabel("Nomor rekening").fill("5550009999");
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  const base = new URL(page.url()).pathname.match(/\/clients\/[^/]+/)![0];

  // Impor says how it differs from Dokumen, and where a missing account is added.
  await expect(page.getByText("Yang diimpor di sini langsung menjadi jurnal.")).toBeVisible();
  await openManualImport(page);
  await page.getByRole("link", { name: "Tambahkan di Pengaturan klien" }).click();
  const card = page.getByTestId("entities-card");
  await expect(card).toContainText("PT Tambah Rekening");
  await expect(card).toContainText("5550009999 · 1101");

  // A second account for the PT, then a wrong number says what to fix.
  await card.getByRole("button", { name: "Tambah rekening" }).click();
  const addBank = card.getByTestId(/^add-bank-/);
  await addBank.getByLabel("Nomor rekening").fill("12");
  await addBank.getByRole("button", { name: "Simpan rekening" }).click();
  await expect(addBank).toContainText("Nomor rekening berisi 6–20 angka.");
  await addBank.getByLabel("Nomor rekening").fill("5550008888");
  await addBank.getByLabel("Nama rekening").fill("Mandiri Tambahan");
  await addBank.getByRole("button", { name: "Simpan rekening" }).click();
  await expect(card).toContainText("Mandiri Tambahan");
  await expect(card).toContainText("5550008888 · 1102");

  // The owner, with no bank account yet.
  await card.getByRole("button", { name: "Tambah perusahaan atau pemilik" }).click();
  const addEntity = card.getByTestId("add-entity");
  await addEntity.getByRole("button", { name: "Simpan" }).click();
  await expect(addEntity).toContainText("Isi nama pemilik.");
  await addEntity.getByLabel("Nama lengkap").fill("Budi Tambah");
  await addEntity.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(card).toContainText("Budi Tambah");
  await expect(card).toContainText("Perorangan (pemilik)");

  // The new account is offered on the upload page.
  await page.goto(`${base}/import`);
  await openManualImport(page);
  await page.getByRole("combobox", { name: "Rekening", exact: true }).click();
  await expect(page.getByRole("option", { name: /Mandiri Tambahan/ })).toBeVisible();
});
