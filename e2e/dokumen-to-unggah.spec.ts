import { expect, test } from "@playwright/test";
import { toBcaCsv, type StatementFile } from "../lib/demo/writers";
import { openClientForm } from "./qa-helpers";

/**
 * Dokumen → Unggah (docs/cycles/2026-10-11-dokumen-to-unggah.md): a BCA statement uploaded to a client's Dokumen collection offers one
 * button, *Bukukan lewat Unggah*, instead of the six-field role form. Unggah reads the rekening and period from the stored file (no
 * second copy), asks once for the new rekening and books it; Dokumen then shows the file as booked. A fresh client and a month before
 * August 2026, so the demo's story and the investor walk are untouched. Synthetic file only; rules-only mode (no AI key).
 */
test.skip(process.env.EVIDENCE_ENABLED === "false", "Documents disabled by the explicit environment switch.");

const BCA = "6044558833";
const d = (day: number) => new Date(Date.UTC(2026, 4, day));
const mei: StatementFile = {
  bank: "BCA",
  accountNumber: BCA,
  holder: "PT Dokumen Uji Sentosa",
  year: 2026,
  month: 5,
  opening: 30_000_000n,
  rows: [
    { date: d(6), description: "TRSF E-BANKING CR 0605/FTSCY/WS95031 CV PELANGGAN DOKUMEN", amount: 8_000_000n },
    { date: d(28), description: "BIAYA ADM", amount: -15_000n },
  ],
};
const FILE = "bca-8833-mei-2026.csv";

test("Dokumen: a client's rekening koran books through Unggah with one click and one card", async ({ page }) => {
  // A client without rekening yet.
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Klien Dokumen Uji");
  await page.getByLabel("Nama lengkap").fill("PT Dokumen Uji Sentosa");
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  const clientId = new URL(page.url()).pathname.match(/\/clients\/([^/]+)/)![1];

  // The statement lands in the client's own Dokumen collection.
  await page.goto(`/documents?scope=client:${clientId}`);
  await page.getByRole("button", { name: "Tambahkan dokumen" }).click();
  await expect(page).toHaveURL(/\/documents\/[^/?]+(?:\?.*)?$/);
  const collection = page.url();
  await page.getByLabel("File dokumen").setInputFiles({ name: FILE, mimeType: "text/csv", buffer: Buffer.from(toBcaCsv(mei)) });
  await expect(page.getByRole("status").filter({ hasText: "Pemeriksaan selesai" })).toBeVisible({ timeout: 30_000 });

  // One button instead of the role form; the form waits behind *Isi manual*.
  await page.locator("summary").filter({ hasText: FILE }).click();
  const handoff = page.getByRole("button", { name: "Bukukan lewat Unggah" });
  await expect(handoff).toBeVisible();
  await expect(page.getByText("Buku membaca rekening dan periodenya dari file.")).toBeVisible();
  await expect(page.getByText("Isi manual", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: /^Peran / })).toBeHidden();
  // What the form would ask (entity, period) is not asked here: Unggah reads it from the file.
  await expect(page.getByText("Entitas belum dikenali; konfirmasi perusahaan.")).toBeHidden();
  await handoff.click();

  // Unggah: the new rekening read from the file, in the one card.
  await expect(page).toHaveURL(new RegExp(`/clients/${clientId}/import`));
  const card = page.getByTestId("inbox-confirm");
  await expect(card.getByText("Rekening baru dari file")).toBeVisible();
  const accounts = card.getByTestId("inbox-new-account");
  await expect(accounts).toHaveCount(1);
  await expect(accounts.filter({ hasText: "BCA ·8833" })).toContainText("Milik PT Dokumen Uji Sentosa");
  await card.getByRole("button", { name: "Tambah & impor" }).click();

  const list = page.getByTestId("inbox-list");
  await expect(card).toBeHidden();
  await expect(list).toContainText("1 file selesai: 1 dibukukan.", { timeout: 60_000 });
  await expect(list.getByTestId("inbox-line").filter({ hasText: FILE })).toContainText("Dibukukan ke BCA ·8833 · Mei 2026 · 2 baris");
  // The hand-over flag left the URL: a reload doesn't start anything again.
  expect(new URL(page.url()).searchParams.has("lanjut")).toBe(false);

  // Back in Dokumen the same file reads as booked, without the button.
  await page.goto(collection);
  await expect(page.getByTestId("evidence-booked")).toContainText("Dibukukan → BCA ·8833 · Mei 2026");
  await expect(page.getByRole("button", { name: "Bukukan lewat Unggah" })).toHaveCount(0);
});
