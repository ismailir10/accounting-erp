import { expect, test, type Page } from "@playwright/test";
import { openManualImport, openClientForm } from "./qa-helpers";

/**
 * Receivables and payables, end to end (synthetic): a fresh client imports August's statement → a sales invoice with PPN → its
 * receipt (still in review) is suggested first and settled in one click → paid, the subledger equals 1130 → a purchase bill paid in
 * part → the rest ages in 1–30 hari and equals 2110. A second invoice whose customer withholds PPh 23 (2 %) is paid net: the settlement
 * books the tax and the invoice closes at gross.
 */
const CSV = [
  "Tanggal;Keterangan;Debet;Kredit;Saldo",
  "20/08/2026;TRSF E-BANKING CR PT MITRA UNGGAS INV-100;0;11100000;111100000",
  "25/08/2026;TRSF E-BANKING DB CV SUMBER MESIN;10000000;0;101100000",
  "27/08/2026;TRSF E-BANKING CR PT JASA BINTANG INV-200;0;10900000;112000000",
  "",
].join("\n");

async function newInvoice(page: Page, button: string, v: { party: string; number: string; date: string; due?: string; dpp: string }) {
  await page.getByRole("button", { name: button }).click();
  await page.getByLabel(/^(Pelanggan|Pemasok)$/).fill(v.party);
  await page.getByLabel(/^Nomor (faktur|tagihan)$/).fill(v.number);
  await page.getByLabel(/^Tanggal (faktur|tagihan)$/).fill(v.date);
  if (v.due) await page.getByLabel("Jatuh tempo").fill(v.due);
  await page.getByLabel("DPP").fill(v.dpp);
  await page.getByRole("button", { name: "Hitung 11%" }).click();
}

test("receivables and payables: invoice, settle from the statement, aging equals the ledger", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Grup Uji Piutang");
  await page.getByLabel("Nama lengkap").fill("PT Piutang Uji");
  await page.getByLabel("Nama singkat").fill("PIU");
  await page.getByLabel("Nomor rekening").fill("6655443322");
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await page.waitForURL(/\/clients\/[^/]+\/import/);
  const base = page.url().replace(/\/import.*$/, "");
  await page.goto(`${base}/import`);
  await openManualImport(page);
  await page.getByTestId("file-input").setInputFiles({ name: "bca-agustus.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
  await page.getByRole("button", { name: "Proses mutasi" }).click();
  await expect(page.getByTestId("import-result")).toContainText("Nyambung");

  // Piutang: a sales invoice with PPN.
  await page.goto(`${base}/receivables?period=2026-08`);
  await newInvoice(page, "Faktur baru", { party: "PT Mitra Unggas", number: "INV-100", date: "2026-08-05", due: "2026-09-04", dpp: "10.000.000" });
  await expect(page.getByLabel("PPN (opsional)")).toHaveValue("1.100.000");
  await page.getByRole("button", { name: "Simpan faktur" }).click();
  await expect(page.getByText("Faktur INV-100 dicatat")).toBeVisible();
  await expect(page.getByTestId("invoice-INV-100")).toContainText("11.100.000");

  // The receipt naming it is suggested first, still in review → classified to 1130 and settled in one click.
  await page.getByTestId("invoice-INV-100").getByRole("button", { name: "Cocokkan" }).click();
  const first = page.getByTestId("settle-candidates").locator("> div").first();
  await expect(first).toContainText("PT MITRA UNGGAS INV-100");
  await expect(first).toContainText("nominal sama · nama/nomor cocok · akan diklasifikasikan ke 1130");
  await first.getByRole("button", { name: "Cocokkan" }).click();
  await expect(page.getByText("INV-100 dicocokkan dengan penerimaan 20 Agu 2026")).toBeVisible();
  await expect(page.getByTestId("invoices-paid")).toContainText("INV-100");
  await expect(page.getByTestId("next-step")).toContainText("Daftar piutang per Agustus 2026 cocok dengan buku besar");

  // Piutang with PPh 23: 10.000.000 + PPN 1.100.000, the customer pays 10.900.000 net of 200.000.
  await newInvoice(page, "Faktur baru", { party: "PT Jasa Bintang", number: "INV-200", date: "2026-08-06", due: "2026-09-05", dpp: "10.000.000" });
  await page.getByRole("combobox", { name: "Pajak yang dipotong" }).click();
  await page.getByRole("option", { name: "PPh 23" }).click();
  await page.getByLabel("Tarif atau nominal").fill("2");
  await expect(page.getByText("= Rp 200.000 dari DPP")).toBeVisible();
  await page.getByRole("button", { name: "Simpan faktur" }).click();
  await expect(page.getByText("Faktur INV-200 dicatat")).toBeVisible();
  await page.getByTestId("invoice-INV-200").getByRole("button", { name: "Cocokkan" }).click();
  const net = page.getByTestId("settle-candidates").locator("> div").first();
  await expect(net).toContainText("PT JASA BINTANG INV-200");
  await expect(net.getByLabel(/^Dipotong /)).toHaveValue("200.000");
  await net.getByRole("button", { name: "Cocokkan" }).click();
  await expect(page.getByText("INV-200 dicocokkan dengan penerimaan 27 Agu 2026")).toBeVisible();
  await expect(page.getByTestId("invoices-paid")).toContainText("INV-200");
  await page.getByRole("button", { name: "Pelunasan INV-200" }).click();
  await expect(page.getByText("termasuk pajak dipotong")).toContainText("200.000");
  await expect(page.getByTestId("next-step")).toContainText("Daftar piutang per Agustus 2026 cocok dengan buku besar");

  // Utang: a purchase bill paid in part.
  await page.getByRole("tab", { name: "Utang", exact: true }).click();
  await expect(page).toHaveURL(/tab=utang/);
  await newInvoice(page, "Tagihan baru", { party: "CV Sumber Mesin", number: "SM-77", date: "2026-08-10", dpp: "20.000.000" });
  await page.getByRole("button", { name: "Simpan tagihan" }).click();
  await expect(page.getByText("Tagihan SM-77 dicatat")).toBeVisible();
  await page.getByTestId("invoice-SM-77").getByRole("button", { name: "Cocokkan" }).click();
  await page.getByTestId("settle-candidates").getByRole("button", { name: "Cocokkan" }).first().click();
  await expect(page.getByText("SM-77 dicocokkan dengan pembayaran 25 Agu 2026")).toBeVisible();
  const aging = page.getByTestId("aging-PIU");
  await expect(aging.getByRole("row", { name: /CV Sumber Mesin/ })).toContainText("12.200.000");
  await expect(aging).toContainText("Cocok dengan buku besar");
  await expect(page.getByTestId("next-step")).toContainText("Daftar utang per Agustus 2026 cocok dengan buku besar");

  // The invoice journal is in the ledger as a Faktur.
  await page.goto(`${base}/ledger/1130?period=2026-08`);
  await expect(page.getByText("Faktur INV-100 · PT Mitra Unggas")).toBeVisible();
  if (process.env.E2E_SCREENSHOTS) {
    await page.goto(`${base}/receivables?period=2026-08&tab=utang`);
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/receivables-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/receivables-390.png`, fullPage: true });
  }
});
