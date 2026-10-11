import { expect, test } from "@playwright/test";
import { makePdf, table } from "../tests/pdf-fixture";
import { openManualImport } from "./qa-helpers";

/**
 * First real client, end to end: Tambah klien → password-protected PDF e-statement → Saldo Awal (prefilled) → bank reconciles.
 * Runs after the investor walk (files run alphabetically, one worker). The PDF is synthetic.
 */
const pdf = makePdf(
  [
    [
      ...table(800, [[[40, "PT Bank Mandiri (Persero) Tbk"]], [[40, "Nomor Rekening : 1400012345678"]], [[40, "Periode : 01/08/2026 - 31/08/2026"]]]),
      ...table(740, [
        [[40, "Tanggal"], [130, "Keterangan"], [360, "Debit"], [440, "Kredit"], [520, "Saldo"]],
        [[40, "01/08/2026"], [130, "SALDO AWAL"], [500, "80.000.000,00"]],
        [[40, "05/08/2026"], [130, "TRANSFER DARI CV SUMBER REJEKI"], [430, "12.500.000,00"], [510, "92.500.000,00"]],
        [[40, "20/08/2026"], [130, "BIAYA ADMINISTRASI"], [362, "15.000,00"], [510, "92.485.000,00"]],
        [[40, "31/08/2026"], [130, "SALDO AKHIR"], [510, "92.485.000,00"]],
      ]),
    ],
  ],
  { userPassword: "17081945" },
);

test("add a client, set opening balance, import a locked PDF, bank reconciles", async ({ page }) => {
  await page.goto("/");
  const clientList = page.getByRole("button", { name: /^Daftar klien \(\d+\)$/ });
  if ((await clientList.getAttribute("aria-expanded")) !== "true") await clientList.click();
  await page.getByRole("link", { name: "Tambah klien" }).click();
  // Tambah klien starts from files; this walk fills the manual form.
  await page.getByRole("link", { name: "Isi manual" }).click();
  await page.getByLabel("Nama klien").fill("Toko Uji Coba");
  await page.getByLabel("Nama lengkap").fill("PT Toko Uji Coba");
  await page.getByLabel("Nama singkat").fill("PT Toko");
  await page.getByRole("combobox", { name: "Bank" }).click();
  await page.getByRole("option", { name: "Mandiri" }).click();
  await page.getByLabel("Nomor rekening").fill("1400012345678");
  await page.getByLabel("Nama rekening").fill("Mandiri Giro");
  await page.getByRole("button", { name: "Simpan klien" }).click();

  // A new client lands on the upload: Saldo Awal is prefilled from the statement afterwards.
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  await openManualImport(page);
  await expect(page.getByTestId("setup-steps")).toContainText("Langkah 1 dari 4");
  await expect(page.getByTestId("next-step")).toContainText("Unggah rekening koran pertama");
  await page.getByTestId("file-input").setInputFiles({ name: "mandiri-agustus.pdf", mimeType: "application/pdf", buffer: pdf });
  await page.getByRole("button", { name: "Proses mutasi" }).click();
  await expect(page.getByLabel("Kata sandi PDF")).toBeVisible();
  await page.getByLabel("Kata sandi PDF").fill("17081945");
  await page.getByRole("button", { name: "Proses mutasi" }).click();
  const result = page.getByTestId("import-result");
  await expect(result).toContainText("Nyambung");

  // The result and the banner both lead to the next step: Saldo Awal, then the form is prefilled.
  await page.getByRole("link", { name: "Isi saldo awal" }).first().click();
  await expect(page.getByTestId("setup-steps")).toContainText("Langkah 2 dari 4");
  await expect(page.getByLabel(/^Saldo Mandiri Giro/)).toHaveValue("80.000.000");
  await page.getByRole("button", { name: "Simpan saldo awal" }).click();
  await expect(page.getByText("Saldo awal semua entitas sudah dicatat.")).toBeVisible();

  // The banner now points on (review or close); the reconciliation is checked on the close page.
  await expect(page.getByTestId("next-step")).toContainText("Saldo awal semua entitas sudah dicatat.");
  await page.getByRole("link", { name: "Tutup Buku" }).first().click();
  const recon = page.getByTestId("control-bank").filter({ hasText: "Rekonsiliasi Mandiri Giro" });
  await expect(recon).toContainText("Lolos");
});
