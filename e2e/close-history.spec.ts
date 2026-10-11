import { expect, test, type Page } from "@playwright/test";
import { openClientForm } from "./qa-helpers";

/**
 * Tutup bulan-bulan sebelumnya (lib/controls/history): a client with open months behind the one being closed checks them together and
 * closes them in order with one note and the sign-offs confirmed once; each month is locked by the same rule 23 and lands in Riwayat.
 */
async function pickOption(page: Page, label: string, name: RegExp) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}
async function accrual(page: Page, base: string, month: string, day: string) {
  await page.goto(`${base}/journals/new?period=2026-${month}`);
  await page.getByLabel("Tanggal").fill(`2026-${month}-${day}`);
  await page.getByLabel("Keterangan").fill(`Akrual listrik ${month}`);
  await pickOption(page, "Akun baris 1", /^6130 /);
  await page.getByLabel("Debit baris 1").fill("1.000.000");
  await pickOption(page, "Akun baris 2", /^2150 /);
  await page.getByLabel("Kredit baris 2").fill("1.000.000");
  await page.getByRole("button", { name: "Simpan jurnal" }).click();
  await expect(page.getByText("Jurnal penyesuaian tersimpan")).toBeVisible();
}

test("two open months before June are checked and closed together from June's Tutup Buku", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Klien Riwayat Uji");
  await page.getByLabel("Nama lengkap").fill("PT Riwayat Uji");
  await page.getByLabel("Nama singkat").fill("RIWAYAT");
  await page.getByRole("button", { name: "Hapus rekening" }).click();
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  const base = page.url().replace(/\/import.*$/, "");
  for (const [m, d] of [["04", "30"], ["05", "31"], ["06", "30"]]) await accrual(page, base, m, d);

  await page.goto(`${base}/close?period=2026-06`);
  await expect(page.getByTestId("next-step")).toContainText("2 bulan sebelumnya bisa ditutup sekaligus di bawah");
  const card = page.getByTestId("close-history");
  await expect(card).toContainText("2 bulan sebelum Juni 2026 masih terbuka (April 2026 – Mei 2026)");
  await card.getByTestId("history-check").click();
  await expect(card.getByTestId("history-months").getByRole("listitem")).toHaveCount(2);
  await expect(card.getByTestId("history-months")).toContainText("April 2026");
  await expect(card.getByTestId("history-months")).toContainText("Mei 2026");

  const close = card.getByTestId("history-close");
  await expect(close).toBeDisabled();
  await card.getByTestId("history-note").fill("Riwayat dari sistem lama, sudah ditutup di sana");
  await expect(close).toBeDisabled(); // sign-offs still to confirm
  for (const box of await card.getByRole("checkbox").all()) await box.click();
  await expect(close).toBeEnabled();
  await page.screenshot({ path: ".playwright/close-history.png", fullPage: true });
  // On a phone the card reflows: no sideways page scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".playwright/close-history-390.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await close.click();
  await page.getByTestId("history-confirm").click();
  await expect(page.getByText("2 bulan ditutup (April 2026 – Mei 2026)")).toBeVisible();
  await expect(page.getByTestId("close-history")).toHaveCount(0);
  await expect(page.getByTestId("next-step")).not.toContainText("dulu");

  await page.goto(`${base}/close?period=2026-04`);
  await expect(page.getByTestId("next-step")).toContainText("Buku April 2026 sudah ditutup");
  await page.goto(`${base}/history`);
  await expect(page.getByText("Mei 2026 ditutup bersama bulan-bulan sebelumnya").first()).toBeVisible();
});
