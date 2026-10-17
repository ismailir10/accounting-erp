import { expect, test, type Page } from "@playwright/test";
import { addClient } from "./qa-helpers";

/**
 * Bagan akun on a fresh client: add an account with its proposed code, find it in the journal form's picker, rename and move an account,
 * remove the new one, and see system accounts locked and the changes in Riwayat.
 */
async function pick(page: Page, label: string, name: RegExp) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

test("Bagan akun: add, use, rename, move, remove; system accounts locked", async ({ page }) => {
  const id = await addClient(page, { name: "Klinik Uji Akun" });
  await page.goto(`/clients/${id}/accounts`);
  await expect(page.getByRole("heading", { name: "Bagan akun" })).toBeVisible();
  await expect(page.getByTestId("coa-ASET_LANCAR")).toContainText("Belum Terklasifikasi");
  await expect(page.getByRole("button", { name: /^Ubah 1999 / })).toHaveCount(0);

  await page.getByRole("button", { name: "Tambah akun" }).click();
  await page.getByRole("textbox", { name: "Nama akun" }).fill("Beban Sewa Kendaraan");
  await pick(page, "Pos laporan", /^Beban umum & administrasi/);
  await expect(page.getByRole("textbox", { name: "Kode akun" })).toHaveValue("6191");
  await page.getByRole("button", { name: "Simpan akun" }).click();
  await expect(page.getByText("Akun 6191 Beban Sewa Kendaraan ditambahkan")).toBeVisible();
  await expect(page.getByTestId("coa-LABA_RUGI")).toContainText("Beban Sewa Kendaraan");

  // The new account is offered where accounts are picked.
  await page.goto(`/clients/${id}/journals/new`);
  await page.getByRole("combobox", { name: "Akun baris 1", exact: true }).click();
  await expect(page.getByRole("option", { name: /^6191 Beban Sewa Kendaraan/ })).toBeVisible();
  await page.keyboard.press("Escape");

  // Rename and move a revenue account; remove the new expense account.
  await page.goto(`/clients/${id}/accounts`);
  await page.getByRole("button", { name: "Ubah 4110 Pendapatan Jasa" }).click();
  await page.getByRole("textbox", { name: "Nama akun" }).fill("Pendapatan Jasa Medis");
  await pick(page, "Pos laporan", /^Pendapatan lain-lain/);
  await expect(page.getByText("Total aset, liabilitas, ekuitas dan laba bersih tidak berubah")).toBeVisible();
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.getByText("Akun 4110 disimpan")).toBeVisible();
  await expect(page.getByTestId("coa-LABA_RUGI")).toContainText("Pendapatan Jasa Medis");

  await page.getByRole("button", { name: "Ubah 6191 Beban Sewa Kendaraan" }).click();
  await page.getByRole("button", { name: "Hapus akun" }).click();
  await expect(page.getByText("Akun 6191 Beban Sewa Kendaraan dihapus")).toBeVisible();
  await expect(page.getByTestId("coa-LABA_RUGI")).not.toContainText("Beban Sewa Kendaraan");

  await page.goto(`/clients/${id}/history?kind=ACCOUNT`);
  await expect(page.getByText("Akun 4110: nama “Pendapatan Jasa” → “Pendapatan Jasa Medis”, pos Pendapatan usaha → Pendapatan lain-lain")).toBeVisible();
});
