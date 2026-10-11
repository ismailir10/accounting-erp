import { expect, test } from "@playwright/test";
import { smbcGiroDepositPdf } from "../tests/pdf-fixture";
import { openManualImport } from "./qa-helpers";

/**
 * An owner's SMBC giro statement lists a time deposit (production E2E 2026-09-30, Belifi): Saldo Awal proposes it on 1260 with its
 * source. Synthetic statement, real SMBC layout.
 */
test("Saldo Awal proposes the deposit a statement lists, with its source", async ({ page }, testInfo) => {
  await page.goto("/");
  const clientList = page.getByRole("button", { name: /^Daftar klien \(\d+\)$/ });
  if ((await clientList.getAttribute("aria-expanded")) !== "true") await clientList.click();
  await page.getByRole("link", { name: "Tambah klien" }).click();
  // Tambah klien starts from files; this walk fills the manual form.
  await page.getByRole("link", { name: "Isi manual" }).click();
  await page.getByLabel("Nama klien").fill("Deposito Uji");
  await page.getByLabel("Bidang usaha").fill("perdagangan");
  await page.getByLabel("Nama lengkap").fill("PT Deposito Uji");
  await page.getByLabel("Nama singkat").fill("PT Depo");
  await page.getByRole("combobox", { name: "Bank" }).click();
  await page.getByRole("option", { name: "SMBC / Jenius" }).click();
  await page.getByLabel("Nomor rekening").fill("05243002331");
  await page.getByLabel("Nama rekening").fill("SMBC Giro");
  await page.getByRole("button", { name: "Simpan klien" }).click();

  // A new client lands on the upload: Saldo Awal is prefilled from the statement afterwards.
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  await openManualImport(page);
  await page.getByTestId("file-input").setInputFiles({ name: "smbc-mei-2026.pdf", mimeType: "application/pdf", buffer: smbcGiroDepositPdf() });
  await page.getByRole("button", { name: "Proses mutasi" }).click();
  await expect(page.getByTestId("import-result")).toContainText("Nyambung");

  await page.getByRole("link", { name: "Isi saldo awal" }).first().click();
  await expect(page.getByText(/Rekening koran mencantumkan Deposito Berjangka 0524DEP004097 di smbc-mei-2026\.pdf \(jatuh tempo 26 Agu 2026, bunga 5%\)/)).toBeVisible();
  await expect(page.getByLabel("Debit").first()).toHaveValue("3.600.000.000");
  await page.screenshot({ path: testInfo.outputPath("opening-deposit-1440.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("opening-deposit-390.png"), fullPage: true });
});
