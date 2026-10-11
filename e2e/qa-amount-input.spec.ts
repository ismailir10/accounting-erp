import { expect, test } from "@playwright/test";
import { addClient, nextAccount, openClientForm } from "./qa-helpers";

/**
 * Typed input found by the end-to-end QA run (docs/qa/bugs): BUG-003 English thousands separators · 010 impossible amounts ·
 * 005 rate look-alikes · 011 NPWP digits. Nothing here is saved except one client and one rate.
 */
test("BUG-003 / BUG-010: the journal form refuses '250,000' and a 20-digit amount instead of reading them wrong", async ({ page }) => {
  const id = await addClient(page, { name: "QA Jurnal Angka" });
  await page.goto(`/clients/${id}/journals/new`);
  const save = page.getByRole("button", { name: "Simpan jurnal" });
  const debit = page.getByLabel("Debit baris 1");
  const credit = page.getByLabel("Kredit baris 2");

  await debit.fill("250,000");
  await credit.fill("250,000");
  await credit.blur();
  await expect(page.getByText(/Nominal "250,000" bisa dibaca ribuan atau desimal/)).toBeVisible();
  await expect(save).toBeDisabled();

  // Indonesian notation is fine (the button stays off only because no accounts are picked, so the pill is what proves it).
  await debit.fill("250.000");
  await credit.fill("250.000");
  await credit.blur();
  await expect(page.getByText(/bisa dibaca ribuan atau desimal/)).toHaveCount(0);
  await expect(page.getByText("Seimbang", { exact: true })).toBeVisible();

  await debit.fill("99.999.999.999.999.999.999");
  await credit.fill("99.999.999.999.999.999.999");
  await credit.blur();
  await expect(page.getByText(/Nominal terlalu besar \(maks\. 15 angka\)/)).toBeVisible();
  await expect(save).toBeDisabled();
});

test("the journal form refuses Rupiah decimals and negative amounts, and shows the imbalance", async ({ page }) => {
  const id = await addClient(page, { name: "QA Jurnal Validasi" });
  await page.goto(`/clients/${id}/journals/new`);
  const debit = page.getByLabel("Debit baris 1");
  const credit = page.getByLabel("Kredit baris 2");
  await debit.fill("1.000.000");
  await credit.fill("900.000");
  await credit.blur();
  await expect(page.getByText("Selisih Rp 100.000")).toBeVisible();
  await expect(page.getByRole("button", { name: "Simpan jurnal" })).toBeDisabled();

  await debit.fill("1000,5");
  await credit.fill("1000,5");
  await credit.blur();
  await expect(page.getByText(/Rupiah tidak memakai angka desimal/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Simpan jurnal" })).toBeDisabled();

  await debit.fill("-500.000");
  await credit.fill("-500.000");
  await credit.blur();
  await expect(page.getByRole("button", { name: "Simpan jurnal" })).toBeDisabled();
});

test("BUG-011: an NPWP of 19 digits is refused; 15 digits without separators are accepted and shown in the standard form", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("QA NPWP Panjang");
  await page.getByLabel("Nama lengkap").fill("PT QA NPWP Panjang");
  await page.getByLabel(/^NPWP/).fill("1234567890123456789");
  await page.getByLabel("Nomor rekening").fill(nextAccount());
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.locator("#workspace-main").getByText("NPWP berisi 15 atau 16 angka")).toBeVisible();
  await expect(page).toHaveURL(/\/clients\/new/);

  const id = await addClient(page, { name: "QA NPWP Normal", npwp: "012345678015000" });
  await page.goto(`/clients/${id}/reports?tab=notes`);
  await expect(page.getByText("NPWP 01.234.567.8-015.000")).toBeVisible();
});

test("BUG-005: rates are read by currency pair (0.745, 1.085, 105.234, 16.250) and a cross-rate is stored as typed", async ({ page }) => {
  // A client with a USD foreign entity, so the Kurs page has a form.
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("QA Kurs");
  await page.getByLabel("Nama lengkap").fill("PT QA Kurs");
  await page.getByLabel("Nomor rekening").fill(nextAccount());
  await page.getByRole("button", { name: "Tambah perusahaan atau pemilik" }).click();
  await page.getByLabel("Nama lengkap").nth(1).fill("QA Kurs Pte Ltd");
  await page.getByRole("combobox", { name: "Jenis entitas" }).nth(1).click();
  await page.getByRole("option", { name: /asing/i }).first().click();
  await page.getByRole("combobox", { name: "Mata uang pembukuan" }).nth(1).click();
  await page.getByRole("option", { name: /^USD/ }).first().click();
  await page.getByLabel("Nomor rekening").nth(1).fill(nextAccount());
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  const id = page.url().match(/clients\/([^/]+)\//)![1];

  await page.goto(`/clients/${id}/rates`);
  const pair = async (from: string, to: string) => {
    await page.getByRole("combobox", { name: "Mata uang asal" }).click();
    await page.getByRole("option", { name: new RegExp(`^${from}`) }).click();
    await page.getByRole("combobox", { name: "Mata uang tujuan" }).click();
    await page.getByRole("option", { name: new RegExp(`^${to}`) }).click();
  };
  const preview = page.locator("p[aria-live=polite]");
  const read = async (from: string, to: string, typed: string, shown: string) => {
    await pair(from, to);
    await page.locator("#rate-value").fill(typed);
    await expect(preview).toHaveText(`Dibaca sebagai: 1 ${from} = ${shown} ${to}`);
  };
  await read("SGD", "USD", "0.745", "0,745");
  await read("EUR", "USD", "1.085", "1,085");
  await read("USD", "IDR", "16.250", "16.250");
  await read("JPY", "IDR", "105.234", "105,234");
  await read("USD", "IDR", "16.250,50", "16.250,5");

  await pair("SGD", "USD");
  await page.locator("#rate-date").fill("2026-08-31");
  await page.locator("#rate-value").fill("0.745");
  await page.getByRole("button", { name: "Simpan kurs" }).click();
  await expect(page.getByText("Kurs SGD→USD disimpan")).toBeVisible();
  await expect(page.locator("main")).toContainText("0,745");
});
