import { expect, test, type Locator, type Page } from "@playwright/test";
import { addClient } from "./qa-helpers";

/**
 * Departemen & Proyek on documents (cycle 2026-10-21-departemen-proyek-2): a contractor bills a project by sales invoice and buys its
 * materials by purchase bill, both tagged PRJ-01; a prepaid site rent amortised for the project. The Laba Rugi per proyek shows the
 * project's margin; the schedule's project is changed and only later instalments follow.
 */
const toast = (page: Page, text: string) => expect(page.locator("[data-sonner-toast]").filter({ hasText: text })).toBeVisible();

async function choose(page: Page, scope: Locator | Page, label: string, option: RegExp) {
  await scope.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option }).first().click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

async function invoice(page: Page, button: string, v: { party: string; number: string; date: string; dpp: string; counter?: RegExp }) {
  await page.getByRole("button", { name: button }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^(Pelanggan|Pemasok)$/).fill(v.party);
  await dialog.getByLabel(/^Nomor (faktur|tagihan)$/).fill(v.number);
  await dialog.getByLabel(/^Tanggal (faktur|tagihan)$/).fill(v.date);
  await dialog.getByLabel("DPP").fill(v.dpp);
  if (v.counter) await choose(page, dialog, "Akun beban / aset", v.counter);
  await choose(page, dialog, "Proyek", /^PRJ-01 · /);
}

test("a project's invoices and its amortised site rent make its Laba Rugi per proyek; a schedule's project changes going forward", async ({ page }) => {
  const id = await addClient(page, { name: "Uji Kontraktor" });
  await page.goto(`/clients/${id}/settings`);
  for (const [kind, code, name] of [["proyek", "PRJ-01", "Gedung Bekasi"], ["proyek", "PRJ-02", "Ruko Cikarang"]] as const) {
    await page.getByRole("button", { name: `Tambah ${kind}` }).click();
    await page.getByRole("dialog").getByLabel("Kode").fill(code);
    await page.getByRole("dialog").getByLabel("Nama").fill(name);
    await page.getByRole("dialog").getByRole("button", { name: "Simpan" }).click();
    await toast(page, `Proyek ${code} ditambahkan`);
  }

  await page.goto(`/clients/${id}/receivables?period=2026-08`);
  await invoice(page, "Faktur baru", { party: "PT Bangun Jaya", number: "INV-01", date: "2026-08-10", dpp: "100.000.000" });
  await page.getByRole("button", { name: "Simpan faktur" }).click();
  await expect(page.getByText("Faktur INV-01 dicatat")).toBeVisible();
  await page.goto(`/clients/${id}/receivables?period=2026-08&tab=utang`);
  await invoice(page, "Tagihan baru", { party: "CV Semen Kita", number: "B-01", date: "2026-08-12", dpp: "60.000.000", counter: /^5100 / });
  await page.getByRole("button", { name: "Simpan tagihan" }).click();
  await expect(page.getByText("Tagihan B-01 dicatat")).toBeVisible();

  // Site rent paid ahead, amortised over 12 months from August for PRJ-01.
  await page.goto(`/clients/${id}/journals/new?period=2026-08`);
  await page.waitForLoadState("networkidle");
  await page.getByTestId("schedules").getByRole("button", { name: "Buat jadwal" }).click();
  const dialog = page.getByRole("dialog");
  await choose(page, dialog, "Jenis", /^Amortisasi$/);
  await dialog.getByLabel("Keterangan jadwal").fill("Sewa lahan proyek");
  await choose(page, dialog, "Akun debit", /^6120 /);
  await dialog.getByLabel("Total jadwal").fill("12.000.000");
  await dialog.getByLabel("Jumlah bulan").fill("12");
  await dialog.getByLabel("Bulan mulai").fill("2026-08");
  await choose(page, dialog, "Proyek", /^PRJ-01 · /);
  await dialog.getByRole("button", { name: "Simpan jadwal" }).click();
  await toast(page, "Jadwal dibuat");
  await expect(page.getByTestId("schedule-tags")).toHaveText(" · PRJ-01");
  await page.getByRole("button", { name: "Catat", exact: true }).first().click();
  await expect(page.getByTestId("schedules")).toContainText("1/12");

  // Laba Rugi per proyek, August: PRJ-01 100 jt − 60 jt − 1 jt = 39 jt.
  await page.goto(`/clients/${id}/reports?period=2026-08&tab=proj`);
  const net = page.getByTestId("pl-by-proyek").getByTestId("dimension-pl-subtotal").filter({ hasText: "Laba bersih" });
  await expect(net.getByRole("cell")).toHaveText(["Laba bersih", "39.000.000", "–", "39.000.000"]);

  // From September the rent is PRJ-02's: August stays PRJ-01's.
  await page.goto(`/clients/${id}/journals/new?period=2026-09`);
  await page.getByRole("button", { name: "Departemen & proyek Sewa lahan proyek" }).click();
  await choose(page, page.getByRole("dialog"), "Proyek jadwal", /^PRJ-02 · /);
  await page.getByRole("dialog").getByRole("button", { name: "Simpan" }).click();
  await toast(page, "Departemen & proyek jadwal disimpan");
  await expect(page.getByTestId("schedule-tags")).toHaveText(" · PRJ-02");
  await page.getByRole("button", { name: "Catat", exact: true }).first().click();
  await expect(page.getByTestId("schedules")).toContainText("2/12");
  await page.goto(`/clients/${id}/reports?period=2026-09&tab=proj&rentang=ytd`);
  const ytd = page.getByTestId("pl-by-proyek");
  await expect(ytd.getByRole("columnheader")).toHaveText([/Akun/, /PRJ-01\s*Gedung Bekasi/, /PRJ-02\s*Ruko Cikarang/, /Tanpa proyek/, /Total/]);
  await expect(ytd.getByTestId("dimension-pl-subtotal").filter({ hasText: "Laba bersih" }).getByRole("cell")).toHaveText(["Laba bersih", "39.000.000", "(1.000.000)", "–", "38.000.000"]);
});
