import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { addClient } from "./qa-helpers";

/**
 * Lampiran jurnal and Arsip akun (cycle 2026-10-20-lampiran-arsip): a receipt kept with a petty-cash journal, downloaded, added to and
 * removed from Jurnal Umum; an account the client never uses archived out of the pickers and brought back.
 */
const PDF = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);

async function pick(page: Page, label: string, name: RegExp) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name }).first().click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

test("a journal keeps its receipt: attached on the form, downloaded, added to and removed from Jurnal Umum", async ({ page }) => {
  const id = await addClient(page, { name: "Uji Lampiran" });
  await page.goto(`/clients/${id}/journals/new?period=2026-07`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Kas kecil keluar" }).click();
  await page.getByLabel("Keterangan").fill("Beli materai dan ATK");
  await pick(page, "Akun baris 1", /^6160 /);
  await page.getByLabel("Debit baris 1").fill("350.000");
  await page.getByLabel("Kredit baris 2").fill("350.000");
  await page.locator("#journal-files").setInputFiles({ name: "nota-toko-abc.pdf", mimeType: "application/pdf", buffer: PDF("nota") });
  await expect(page.getByTestId("journal-files")).toHaveText("nota-toko-abc.pdf");
  await page.getByRole("button", { name: "Simpan jurnal" }).click();
  await expect(page.getByText("Jurnal penyesuaian tersimpan")).toBeVisible();

  await page.goto(`/clients/${id}/journals?period=2026-07`);
  const entry = page.getByTestId("journal-entry").filter({ hasText: "Beli materai dan ATK" });
  await expect(entry.getByTestId("entry-number")).toHaveText("JP-2607-0001");
  await expect(entry.getByTestId("attachment-link")).toHaveText("nota-toko-abc.pdf");
  const [download] = await Promise.all([page.waitForEvent("download"), entry.getByTestId("attachment-link").click()]);
  expect(download.suggestedFilename()).toBe("nota-toko-abc.pdf");
  expect((await readFile((await download.path())!)).toString()).toContain("% nota");

  // A second file from Jurnal Umum; a file that is not a PDF, JPG or PNG is refused with the reason.
  await entry.getByLabel("Lampiran untuk JP-2607-0001").setInputFiles({ name: "catatan.txt", mimeType: "text/plain", buffer: Buffer.from("bukan bukti") });
  await expect(page.locator("[data-sonner-toast][data-type=error]")).toContainText("catatan.txt bukan PDF, JPG atau PNG.");
  await entry.getByLabel("Lampiran untuk JP-2607-0001").setInputFiles({ name: "persetujuan.pdf", mimeType: "application/pdf", buffer: PDF("ok") });
  await expect(entry.getByTestId("attachment-link")).toHaveCount(2);
  await entry.getByRole("button", { name: "Hapus lampiran nota-toko-abc.pdf" }).click();
  await expect(entry.getByTestId("attachment-link")).toHaveText(["persetujuan.pdf"]);

  // The Buku Besar drawer lists it too, and Riwayat keeps both changes.
  await page.goto(`/clients/${id}/ledger/6160?period=2026-07`);
  await page.getByTestId("ledger-row").first().click();
  await expect(page.getByTestId("ledger-attachments")).toContainText("persetujuan.pdf");
  await page.goto(`/clients/${id}/history?kind=ATTACHMENT`);
  await expect(page.getByText("Lampiran ditambahkan ke JP-2607-0001 · Beli materai dan ATK: nota-toko-abc.pdf")).toBeVisible();
  await expect(page.getByText("Lampiran dihapus dari JP-2607-0001 · Beli materai dan ATK: nota-toko-abc.pdf")).toBeVisible();
});

test("an account the client never uses is archived out of the pickers and brought back", async ({ page }) => {
  const id = await addClient(page, { name: "Uji Arsip Akun" });
  await page.goto(`/clients/${id}/accounts`);
  await page.getByRole("button", { name: "Ubah 6150 Beban Pemasaran" }).click();
  await page.getByRole("button", { name: "Arsipkan" }).click();
  await expect(page.getByText("Akun 6150 Beban Pemasaran diarsipkan")).toBeVisible();
  await expect(page.getByTestId("coa-ARSIP")).toContainText("Beban Pemasaran");
  await expect(page.getByTestId("coa-LABA_RUGI")).not.toContainText("Beban Pemasaran");

  await page.goto(`/clients/${id}/journals/new?period=2026-07`);
  await page.getByRole("combobox", { name: "Akun baris 1", exact: true }).click();
  await expect(page.getByRole("option", { name: /^6140 / })).toBeVisible();
  await expect(page.getByRole("option", { name: /^6150 / })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto(`/clients/${id}/accounts`);
  await page.getByRole("button", { name: "Aktifkan lagi 6150 Beban Pemasaran" }).click();
  await expect(page.getByText("Akun 6150 Beban Pemasaran aktif lagi")).toBeVisible();
  await expect(page.getByTestId("coa-ARSIP")).toHaveCount(0);
  await page.goto(`/clients/${id}/history?kind=ACCOUNT`);
  await expect(page.getByText("Akun 6150 Beban Pemasaran diaktifkan lagi")).toBeVisible();
});
