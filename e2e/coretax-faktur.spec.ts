import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { addClient, noSideScroll } from "./qa-helpers";

/**
 * Faktur keluaran untuk Coretax (cycle docs/cycles/2026-10-17-coretax-files.md), flows 1 and 3: three sales invoices with PPN in August,
 * one buyer with an NPWP, one without, one invoice whose PPN was typed at 12 % of the DPP. Pajak Masa names every block reason; completing
 * the buyers and the item in place turns the rows Siap, and the XML holds only those. A month without sales points to Piutang & Utang.
 */
async function newSale(page: Page, v: { party: string; number: string; date: string; dpp: string; ppn?: string }) {
  await page.getByRole("button", { name: "Faktur baru" }).click();
  await page.getByLabel("Pelanggan", { exact: true }).fill(v.party);
  await page.getByLabel("Nomor faktur", { exact: true }).fill(v.number);
  await page.getByLabel("Tanggal faktur", { exact: true }).fill(v.date);
  await page.getByLabel("DPP", { exact: true }).fill(v.dpp);
  await page.getByRole("button", { name: "Hitung 11%" }).click();
  if (v.ppn) await page.getByLabel("PPN (opsional)").fill(v.ppn);
  await page.getByRole("button", { name: "Simpan faktur" }).click();
  await expect(page.getByText(`Faktur ${v.number} dicatat`)).toBeVisible();
}

const row = (page: Page, number: string) => page.locator(`[data-testid="coretax-row"][data-number="${number}"]`);

async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("faktur keluaran for Coretax: block reasons, fixed in place, XML of the Siap rows only", async ({ page }) => {
  const id = await addClient(page, { name: "QA Coretax", npwp: "01.234.567.8-015.000" });
  await page.goto(`/clients/${id}/receivables?period=2026-08`);
  await newSale(page, { party: "PT Mitra Alfa", number: "INV-701", date: "2026-08-05", dpp: "10.000.000" });
  await newSale(page, { party: "Budi Santoso", number: "INV-702", date: "2026-08-12", dpp: "2.000.000" });
  await newSale(page, { party: "PT Mitra Alfa", number: "INV-703", date: "2026-08-20", dpp: "5.000.000", ppn: "600.000" });

  await page.goto(`/clients/${id}/tax/masa?period=2026-08`);
  const card = page.getByTestId("coretax-faktur");
  await expect(card.getByTestId("coretax-count-blocked")).toHaveText("3");
  await expect(card.getByTestId("coretax-count-ready")).toHaveText("0");
  await expect(card.getByTestId("coretax-download")).toBeDisabled();
  await expect(row(page, "INV-702").locator("xpath=following-sibling::tr[1]")).toContainText("NPWP atau NIK pembeli belum diisi.");
  await expect(card.getByTestId("coretax-footnote")).toContainText("Format impor DJP v1.4 (template 1.6.1), belum diuji dengan unggahan nyata");

  // One item for every invoice: Jasa / 000000 / Kegiatan.
  await card.getByTestId("coretax-item-all").click();
  const itemForm = page.getByTestId("coretax-item-form");
  await choose(page, "Barang atau jasa", "Jasa");
  await choose(page, "Satuan", "Kegiatan");
  await itemForm.getByRole("button", { name: "Terapkan ke semua (3 faktur)" }).click();
  await expect(page.getByText("Barang/jasa diatur untuk 3 faktur")).toBeVisible();

  // Buyer A: a 15-digit NPWP, NITKU left at the head office.
  await row(page, "INV-701").locator("xpath=following-sibling::tr[1]").getByRole("button", { name: "Lengkapi pembeli" }).click();
  await page.getByLabel("NPWP", { exact: true }).fill("09.876.543.2-101.200");
  await page.getByTestId("coretax-buyer-save").click();
  await expect(page.getByText("Identitas pajak PT Mitra Alfa disimpan")).toBeVisible();
  await expect(row(page, "INV-701")).toHaveAttribute("data-status", "READY");
  // Flow 3: the PPN typed at 12 % of the DPP stays blocked; Coretax takes only 12 % × 11/12 for kode 04.
  await expect(row(page, "INV-703")).toHaveAttribute("data-status", "BLOCKED");
  await expect(row(page, "INV-703").locator("xpath=following-sibling::tr[1]")).toContainText("tidak sama dengan 12% × 11/12 × DPP (Rp 550.000)");

  // Buyer B: no NPWP, so NIK — and, as the row then says, an address.
  const notes = row(page, "INV-702").locator("xpath=following-sibling::tr[1]");
  await notes.getByRole("button", { name: "Lengkapi pembeli" }).click();
  await page.getByLabel("NIK (pembeli tanpa NPWP)").fill("3174061502560010");
  await page.getByTestId("coretax-buyer-save").click();
  await expect(page.getByText("Identitas pajak Budi Santoso disimpan")).toBeVisible();
  await expect(notes).toContainText("Pembeli dengan NIK perlu alamat.");
  await notes.getByRole("button", { name: "Lengkapi pembeli" }).click();
  await page.getByLabel("Alamat", { exact: true }).fill("Jl. Kenanga No. 2, Jakarta");
  await page.getByTestId("coretax-buyer-save").click();
  await expect(row(page, "INV-702")).toHaveAttribute("data-status", "READY");
  await expect(card.getByTestId("coretax-count-ready")).toHaveText("2");
  await expect(card.getByTestId("coretax-count-blocked")).toHaveText("1");

  // 390 px: Pajak Masa with the faktur card does not scroll sideways.
  const shots = process.env.E2E_SCREENSHOTS;
  if (shots) await page.locator("#faktur-coretax").screenshot({ path: `${shots}/coretax-1440.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card.getByTestId("coretax-count-ready")).toHaveText("2");
  await noSideScroll(page);
  if (shots) await page.locator("#faktur-coretax").screenshot({ path: `${shots}/coretax-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });

  const [download] = await Promise.all([page.waitForEvent("download"), card.getByRole("link", { name: "Unduh XML (2 faktur)" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^faktur-keluaran-.*-2026-08\.xml$/);
  const xml = readFileSync((await download.path())!, "utf8");
  expect(xml.match(/<TaxInvoice>/g)).toHaveLength(2);
  expect(xml).toContain("<TIN>0012345678015000</TIN>");
  expect(xml).toContain("<RefDesc>INV-701</RefDesc>");
  expect(xml).toContain("<BuyerTin>0098765432101200</BuyerTin>");
  expect(xml).toContain("<BuyerDocument>National ID</BuyerDocument>");
  expect(xml).toContain("<BuyerDocumentNumber>3174061502560010</BuyerDocumentNumber>");
  expect(xml).not.toContain("INV-703");
  expect(xml).toContain("<OtherTaxBase>9166666.67</OtherTaxBase>");
  expect(xml).toContain("<VAT>1100000</VAT>");

  // A month without sales invoices says so and points to Piutang & Utang.
  await page.goto(`/clients/${id}/tax/masa?period=2026-07`);
  await expect(page.getByTestId("coretax-faktur")).toContainText("Belum ada faktur penjualan ber-PPN di masa ini.");
  await expect(page.getByTestId("coretax-faktur").getByRole("link", { name: "Buka Piutang & Utang" })).toBeVisible();
});
