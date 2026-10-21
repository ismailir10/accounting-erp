import { expect, test, type Page } from "@playwright/test";
import { addClient } from "./qa-helpers";

/**
 * Jurnal berulang (cycle 2026-10-21-jurnal-berulang): a three-line rent accrual typed in July is repeated every month — proposed in
 * August's Jurnal terjadwal and posted by a click, September's approved from Kotak persetujuan, October's listed by Tutup Buku, then stopped.
 */
async function pick(page: Page, label: string, name: RegExp) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name }).first().click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}
const toast = (page: Page, text: string) => expect(page.locator("[data-sonner-toast]").filter({ hasText: text })).toBeVisible();

test("a monthly journal is repeated from a posted one: proposed, posted once a month, listed at the close, stopped", async ({ page }) => {
  const id = await addClient(page, { name: "Uji Berulang" });
  await page.goto(`/clients/${id}/journals/new?period=2026-07`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Keterangan").fill("Akrual sewa kantor");
  await page.getByRole("button", { name: "Tambah baris" }).click();
  await pick(page, "Akun baris 1", /^6120 /);
  await page.getByLabel("Debit baris 1").fill("15.000.000");
  await page.getByLabel("Catatan baris 1").fill("Sewa ruko");
  await pick(page, "Akun baris 2", /^6190 /);
  await page.getByLabel("Debit baris 2").fill("2.500.000");
  await pick(page, "Akun baris 3", /^2150 /);
  await page.getByLabel("Kredit baris 3").fill("17.500.000");
  await page.getByRole("button", { name: "Simpan jurnal" }).click();
  await toast(page, "Jurnal penyesuaian tersimpan");

  // Ulangi tiap bulan from Terakhir dicatat: from August, on the month's last day, until December.
  await page.getByRole("button", { name: "Ulangi tiap bulan Akrual sewa kantor" }).click();
  await expect(page.getByRole("dialog")).toContainText("Mulai Agu 26, jurnal yang sama");
  await expect(page.getByRole("dialog")).toContainText("bertanggal akhir bulan");
  await page.getByLabel("Sampai bulan (opsional)").fill("2026-12");
  await page.getByRole("dialog").getByRole("button", { name: "Ulangi tiap bulan" }).click();
  await toast(page, "Akrual sewa kantor diulang tiap bulan mulai Agu 26");
  await expect(page.getByTestId("recurring-row")).toContainText("3 baris · akhir bulan · Agu 26 – Des 26 · Berjalan");
  // July itself proposes nothing, and the journal can't be repeated twice.
  await expect(page.getByTestId("recurring-due")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ulangi tiap bulan Akrual sewa kantor" })).toHaveCount(0);

  // August: proposed with the schedules, posted by the click, once.
  await page.goto(`/clients/${id}/journals/new?period=2026-08`);
  const aug = page.getByTestId("recurring-due");
  await expect(aug).toContainText("Akrual sewa kantor (Agustus 2026)");
  await expect(aug).toContainText("2026-08-31 · 6120 +1 / 2150");
  await aug.getByRole("button", { name: "Catat", exact: true }).click();
  await toast(page, "Akrual sewa kantor (Agustus 2026) dicatat");
  await expect(page.getByTestId("recurring-due")).toHaveCount(0);
  await page.goto(`/clients/${id}/journals?period=2026-08`);
  const entry = page.getByTestId("journal-entry").filter({ hasText: "Akrual sewa kantor" });
  await expect(entry.getByTestId("entry-number")).toHaveText("JP-2608-0001");
  await expect(entry).toContainText("Sewa ruko");

  // September: from Kotak persetujuan, with the other scheduled journals.
  await page.goto(`/clients/${id}/approvals?period=2026-09&jenis=terjadwal`);
  const sep = page.getByTestId("approval-scheduled").filter({ hasText: "Akrual sewa kantor (September 2026)" });
  await expect(sep).toContainText("Berulang");
  await sep.getByRole("button", { name: "Setujui" }).click();
  await toast(page, "Akrual sewa kantor (September 2026) dicatat");

  // October: Tutup Buku names the instalment still to post.
  await page.goto(`/clients/${id}/close?period=2026-10`);
  await expect(page.getByText("Akrual sewa kantor (Oktober 2026)", { exact: false }).first()).toBeVisible();

  // Hentikan: nothing more is proposed; what was posted stays.
  await page.goto(`/clients/${id}/journals/new?period=2026-10`);
  await expect(page.getByTestId("recurring-due")).toHaveCount(1);
  await page.getByRole("button", { name: "Hentikan Akrual sewa kantor" }).click();
  await page.getByRole("button", { name: "Hentikan jurnal berulang" }).click();
  await toast(page, "Akrual sewa kantor dihentikan");
  await expect(page.getByTestId("recurring-row")).toContainText("Dihentikan · 2 kali dicatat, terakhir Sep 26");
  await expect(page.getByTestId("recurring-due")).toHaveCount(0);

  await page.goto(`/clients/${id}/history?kind=RECURRING`);
  await expect(page.getByText("Jurnal berulang dibuat dari JP-2607-0001 · Akrual sewa kantor: akhir bulan, mulai Agustus 2026 sampai Desember 2026")).toBeVisible();
  await expect(page.getByText("Akrual sewa kantor Agustus 2026 dicatat sebagai JP-2608-0001 (31 Agu 2026)")).toBeVisible();
  await expect(page.getByText("Jurnal berulang Akrual sewa kantor dihentikan")).toBeVisible();
});
