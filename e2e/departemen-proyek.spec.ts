import { expect, test, type Locator, type Page } from "@playwright/test";
import { addClient, uploadStatement } from "./qa-helpers";

/**
 * Departemen & Proyek (cycle 2026-10-21-departemen-proyek): two outlets and a project set up in Pengaturan klien; a sale and a rent
 * tagged in Review, a payroll accrual tagged on Jurnal Penyesuaian; the Laba Rugi per departemen adds up to the Laba Rugi; moving the
 * rent to the other outlet in Buku Besar posts a reclass that moves the column and not the total; an archived outlet leaves the pickers.
 */
const CSV = [
  "Tanggal;Keterangan;Debet;Kredit;Saldo",
  "01/08/2026;SALDO AWAL;;;100.000.000,00",
  "05/08/2026;PENJUALAN OUTLET KEMANG;0,00;20.000.000,00;120.000.000,00",
  "10/08/2026;SEWA RUKO OUTLET BINTARO;6.000.000,00;0,00;114.000.000,00",
  "",
].join("\n");

const toast = (page: Page, text: string) => expect(page.locator("[data-sonner-toast]").filter({ hasText: text })).toBeVisible();

async function choose(page: Page, scope: Locator | Page, label: string, option: RegExp) {
  await scope.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option }).first().click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

async function account(page: Page, item: Locator, code: string) {
  await item.getByRole("combobox", { name: "Akun", exact: true }).click();
  await page.getByRole("combobox", { name: "Cari akun", expanded: true }).fill(code);
  await page.keyboard.press("Enter");
}

async function addDimension(page: Page, kind: "departemen" | "proyek", code: string, name: string) {
  await page.getByRole("button", { name: `Tambah ${kind}` }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Kode").fill(code);
  await dialog.getByLabel("Nama").fill(name);
  await dialog.getByRole("button", { name: "Simpan" }).click();
  await toast(page, `${kind === "proyek" ? "Proyek" : "Departemen"} ${code} ditambahkan`);
}

test("departments and projects tag lines; the Laba Rugi per departemen adds up and follows a tag-only reclass", async ({ page }) => {
  const id = await addClient(page, { name: "Uji Outlet" });
  await page.goto(`/clients/${id}/settings`);
  await addDimension(page, "departemen", "OUTLET-A", "Outlet Kemang");
  await addDimension(page, "departemen", "OUTLET-B", "Outlet Bintaro");
  await addDimension(page, "proyek", "PRJ-01", "Renovasi Kemang");
  await expect(page.getByTestId("dimension-row")).toHaveCount(3);

  await uploadStatement(page, id, "agustus.csv", CSV);
  await expect(page.getByTestId("import-result")).toContainText("Nyambung");
  await page.goto(`/clients/${id}/review?period=2026-08`);
  const items = page.getByTestId("review-item");
  await expect(items).toHaveCount(2);
  const sale = items.filter({ hasText: "PENJUALAN OUTLET" });
  await account(page, sale, "4100");
  await choose(page, sale, "Departemen", /^OUTLET-A · /);
  await sale.getByTestId("accept").click();
  await toast(page, "4100");
  const rent = page.getByTestId("review-item").filter({ hasText: "SEWA RUKO" });
  await account(page, rent, "6120");
  await choose(page, rent, "Departemen", /^OUTLET-B · /);
  await choose(page, rent, "Proyek", /^PRJ-01 · /);
  await rent.getByTestId("accept").click();
  await toast(page, "6120");

  await page.goto(`/clients/${id}/journals/new?period=2026-08`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Keterangan").fill("Akrual gaji outlet");
  await choose(page, page, "Akun baris 1", /^6190 /);
  await page.getByLabel("Debit baris 1").fill("5.000.000");
  await choose(page, page, "Departemen baris 1", /^OUTLET-A · /);
  await choose(page, page, "Akun baris 2", /^2150 /);
  await page.getByLabel("Kredit baris 2").fill("5.000.000");
  await page.getByRole("button", { name: "Simpan jurnal" }).click();
  await toast(page, "Jurnal penyesuaian tersimpan");

  // Laba Rugi per departemen: Outlet A 15 jt, Outlet B (6 jt), Tanpa departemen –; Total 9 jt = the Laba Rugi.
  await page.goto(`/clients/${id}/reports?period=2026-08&tab=dept`);
  const report = page.getByTestId("pl-by-departemen");
  await expect(report.getByRole("columnheader")).toHaveText([/Akun/, /OUTLET-A\s*Outlet Kemang/, /OUTLET-B\s*Outlet Bintaro/, /Tanpa departemen/, /Total/]);
  const net = report.getByTestId("dimension-pl-subtotal").filter({ hasText: "Laba bersih" });
  await expect(net.getByRole("cell")).toHaveText(["Laba bersih", "15.000.000", "(6.000.000)", "–", "9.000.000"]);
  await page.getByRole("tab", { name: "Laba Rugi", exact: true }).click();
  await expect(page.getByText("9.000.000").first()).toBeVisible();

  // The rent was Outlet A's after all: changed in Buku Besar, a reclass moves it; the total stays.
  await page.goto(`/clients/${id}/reports?period=2026-08&tab=dept`);
  await report.getByTestId("dimension-pl-row").filter({ hasText: "6120" }).getByRole("link", { name: "6.000.000" }).first().click();
  await expect(page.getByRole("heading", { name: /^6120 / })).toBeVisible();
  await expect(page.getByText("Departemen OUTLET-B Outlet Bintaro")).toBeVisible();
  await page.getByTestId("ledger-row").first().click();
  const tags = page.getByTestId("bank-tags");
  await choose(page, tags, "Departemen", /^OUTLET-A · /);
  await tags.getByRole("button", { name: "Simpan departemen & proyek" }).click();
  await toast(page, "Departemen & proyek disimpan");

  await page.goto(`/clients/${id}/reports?period=2026-08&tab=dept`);
  await expect(net.getByRole("cell")).toHaveText(["Laba bersih", "9.000.000", "–", "–", "9.000.000"]);
  await page.goto(`/clients/${id}/reports?period=2026-08&tab=proj`);
  await expect(page.getByTestId("pl-by-proyek").getByTestId("dimension-pl-subtotal").filter({ hasText: "Laba bersih" }).getByRole("cell")).toHaveText(["Laba bersih", "(6.000.000)", "15.000.000", "9.000.000"]);

  // Archived: Outlet B leaves the journal form's picker; its history stays in the report.
  await page.goto(`/clients/${id}/settings`);
  await page.getByRole("button", { name: "Arsipkan OUTLET-B" }).click();
  await toast(page, "Departemen OUTLET-B diarsipkan");
  await page.goto(`/clients/${id}/journals/new?period=2026-08`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("combobox", { name: "Departemen baris 1", exact: true }).click();
  await expect(page.getByRole("option", { name: /^OUTLET-A · / })).toBeVisible();
  await expect(page.getByRole("option", { name: /^OUTLET-B · / })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto(`/clients/${id}/reports?period=2026-08&tab=dept`);
  await expect(page.getByTestId("pl-by-departemen").getByRole("columnheader").filter({ hasText: "OUTLET-B" })).toContainText("diarsipkan");

  await page.goto(`/clients/${id}/history`);
  await expect(page.getByText("SEWA RUKO OUTLET BINTARO · Rp 6.000.000: OUTLET-B · PRJ-01 → OUTLET-A · PRJ-01")).toBeVisible();
});
