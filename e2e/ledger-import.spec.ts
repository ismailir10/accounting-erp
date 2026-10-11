import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { openManualImport, openClientForm } from "./qa-helpers";

/**
 * Ledger client, end to end (synthetic data): Tambah klien with an IDR company and an SGD holding (no bank accounts)
 * → upload a multi-entity, multi-currency ledger → checks → accept a source difference → map accounts (rules + one
 * new account) → post → Kurs → Gabungan in IDR with the translation line → Neraca Saldo and a ledger in the entity's own accounts.
 */
async function ledgerXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("GL");
  ws.addRow(["Entity", "Entry Date", "Account Code", "Account Name", "Currency", "Debit", "Credit", "Notes"]);
  const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
  const rows: unknown[][] = [
    ["SATU", d(2025, 1, 1), "10000", "Petty Cash", "IDR", 12_500_000.5, 0, ""],
    ["SATU", d(2025, 1, 1), "31001", "Modal Saham", "IDR", 0, 12_500_000.5, ""],
    ["SATU", d(2025, 3, 31), "41000", "Sales - Produk", "IDR", 0, 20_000_000, ""],
    ["SATU", d(2025, 3, 31), "10000", "Petty Cash", "IDR", 15_000_000, 0, ""],
    ["SATU", d(2025, 12, 31), "63005", "Platform Fee - Gofood", "IDR", 2_000_000, 0, ""],
    ["SATU", d(2025, 12, 31), "10000", "Petty Cash", "IDR", 0, 2_000_000, ""],
    ["DUA", d(2025, 1, 15), "10001", "Bank OCBC - SGD", "USD", 50_000, 0, "Rate: 1.31"],
    ["DUA", d(2025, 1, 15), "30000", "Ordinary Shares", "SGD", 0, 50_000, ""],
    ["DUA", d(2025, 12, 31), "41000", "Expense Bank Administration", "SGD", 120, 0, ""],
    ["DUA", d(2025, 12, 31), "10001", "Bank OCBC - SGD", "USD", 0, 120, "Rate: 1.32"],
  ];
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("ledger import: checks, mapping, post, Kurs, Gabungan in IDR, client accounts", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Grup Uji Buku Besar");
  await page.getByLabel("Nama lengkap").click();
  await page.getByLabel("Nama lengkap").pressSequentially("PT Satu Uji");
  await expect(page.getByLabel("Nama lengkap")).toHaveValue("PT Satu Uji");
  await page.getByLabel("Nama klien").focus();
  await page.getByLabel("Nama lengkap").click();
  await page.getByLabel("Nama lengkap").press("End");
  await page.getByLabel("Nama lengkap").pressSequentially(" Baru");
  await expect(page.getByLabel("Nama lengkap")).toHaveValue("PT Satu Uji Baru");
  await page.getByLabel("Nama singkat").fill("SATU");
  await page.getByRole("button", { name: "Hapus rekening" }).click();
  await expect(page.getByText("Tanpa rekening bank.")).toBeVisible();

  await page.getByRole("button", { name: "Tambah perusahaan atau pemilik" }).click();
  await page.getByRole("combobox", { name: "Jenis entitas" }).nth(1).click();
  await page.getByRole("option", { name: "PT", exact: true }).click();
  await page.getByLabel("Nama lengkap").nth(1).fill("Dua Holdings Pte Ltd");
  await page.getByLabel("Nama singkat").nth(1).fill("DUA");
  await page.getByRole("combobox", { name: "Mata uang pembukuan" }).nth(1).click();
  await page.getByRole("option", { name: /^SGD/ }).click();
  await page.getByRole("button", { name: "Hapus rekening" }).click();
  await page.getByRole("button", { name: "Simpan klien" }).click();

  // Ledger-only client lands on the ledger import.
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  await openManualImport(page);
  await page.getByTestId("ledger-file-input").setInputFiles({ name: "buku-besar-uji.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: await ledgerXlsx() });
  await page.getByRole("button", { name: "Periksa file" }).click();

  await expect(page.getByRole("heading", { name: "Impor buku besar: GL" })).toBeVisible();
  await expect(page.getByTestId("next-step")).toContainText("tidak seimbang");
  await expect(page.getByText(/Jurnal SATU 31 Mar 2025 tidak seimbang: selisih -Rp 5\.000\.000/)).toBeVisible();
  await page.getByRole("button", { name: "Terima & catat selisih ke 1999" }).click();
  await expect(page.getByText("Diterima ke 1999", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /^Terima \d+ saran aturan$/ }).click();
  await expect(page.getByText("1 dari 7 akun belum dipetakan")).toBeVisible();
  await page.getByRole("combobox", { name: "Akun Buku untuk 63005", exact: true }).click();
  const accountSearch = page.getByRole("combobox", { name: "Cari akun Buku untuk 63005" });
  await accountSearch.fill("6150");
  await expect(page.getByRole("option", { name: /^6150 / })).toBeVisible();
  await expect(page.getByRole("option", { name: /^1210 / })).toHaveCount(0);
  await expect(page.getByRole("option").first()).toHaveText("+ Buat akun baru");
  await accountSearch.fill("pemasaran");
  await expect(page.getByRole("option", { name: /^6150 / })).toBeVisible();
  await accountSearch.press("ArrowDown");
  await accountSearch.press("End");
  await accountSearch.press("Enter");
  await expect(page.getByRole("combobox", { name: "Akun Buku untuk 63005", exact: true })).toContainText("6150");
  await page.getByRole("combobox", { name: "Akun Buku untuk 63005", exact: true }).click();
  await accountSearch.fill("akun belum tersedia");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.getByRole("option", { name: "+ Buat akun baru" }).click();
  await expect(page.getByRole("combobox", { name: "Pos laporan" })).toContainText("Beban umum & administrasi");
  await page.getByRole("button", { name: "Terima", exact: true }).click();
  await expect(page.getByText("Semua 7 akun sudah dipetakan")).toBeVisible();

  await page.getByRole("button", { name: /^Catat \d+ jurnal$/ }).click();
  await expect(page.getByTestId("next-step")).toContainText("jurnal dicatat");

  // Gabungan needs SGD→IDR rates; fill each missing one from the Kurs page.
  const settings = page.getByRole("button", { name: "Pengaturan klien" });
  if ((await settings.getAttribute("aria-expanded")) !== "true") await settings.click();
  await page.getByRole("link", { name: "Kurs" }).click();
  await expect(page.getByRole("heading", { name: "Kurs" })).toBeVisible();
  const fileRates = page.getByRole("button", { name: /USD → SGD · 2 kurs dari buku-besar-uji.xlsx/ });
  await expect(fileRates).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: /^Hapus kurs USD→SGD/ })).toHaveCount(0);
  await fileRates.click();
  await expect(page.getByRole("button", { name: /^Hapus kurs USD→SGD/ })).toHaveCount(2);
  await fileRates.click();
  const rates = ["12000", "12500", "12300"];
  for (const rate of rates) {
    const missingRate = page.getByText("Isi yang belum ada:").locator("..").getByRole("button").first();
    const missingLabel = await missingRate.innerText();
    await missingRate.click();
    await page.getByLabel(/^Kurs \(1 SGD/).fill(rate);
    await page.getByRole("button", { name: "Simpan kurs" }).click();
    await expect(page.getByLabel(/^Kurs \(1 SGD/)).toHaveValue("");
    await expect(page.getByRole("button", { name: missingLabel, exact: true })).toHaveCount(0);
  }
  await expect(page.getByTestId("next-step")).toContainText("sudah lengkap");

  await page.getByRole("link", { name: "Laporan Keuangan" }).click();
  await page.getByRole("tab", { name: "Kertas Kerja Gabungan" }).click();
  const ws = page.getByTestId("worksheet");
  await expect(ws).toContainText("Selisih Penjabaran Mata Uang Asing");
  await page.getByRole("tab", { name: "Neraca" }).click();
  await expect(page.getByText("Seimbang").first()).toBeVisible();
  // The tab is kept in the URL: a reload (or a shared link) opens the same view.
  await expect(page).toHaveURL(/tab=bs/);
  await page.reload();
  await expect(page.getByRole("tab", { name: "Neraca" })).toHaveAttribute("aria-selected", "true");

  // Client COA first: one entity with its own accounts opens in those accounts, each with its own ledger.
  // Clicks right after a navigation can land before hydration: retry each step until its effect shows.
  await expect(async () => {
    await page.getByRole("link", { name: "Neraca Saldo" }).click();
    await expect(page).toHaveURL(/\/trial-balance/, { timeout: 2_000 });
  }).toPass();
  await expect(page.getByRole("tab", { name: "Akun klien" })).toHaveCount(0); // a group has no single client chart
  const dua = page.getByRole("option", { name: "Dua Holdings Pte Ltd" });
  await expect(async () => {
    await page.getByRole("combobox").first().click();
    await dua.click({ timeout: 2_000 });
    await expect(page.getByRole("tab", { name: "Akun klien" })).toBeVisible({ timeout: 5_000 });
  }).toPass();
  await expect(page.getByRole("cell", { name: "10001" })).toBeVisible();
  await expect(page.getByText("dalam SGD")).toBeVisible();
  await page.getByTestId("tb-account-link").first().click();
  await expect(page).toHaveURL(/\/ledger\/akun\//);
  await expect(page.getByText(/akun klien ·/)).toBeVisible();
  await expect(page.getByText("Saldo awal periode")).toBeVisible();
});
