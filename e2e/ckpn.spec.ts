import { expect, test, type Page } from "@playwright/test";
import { openManualImport, openClientForm } from "./qa-helpers";

/**
 * CKPN piutang (PSAK 109), end to end (synthetic): four sales invoices May–Aug 2026, a partial receipt in June and a full one in July →
 * the roll-rate matrix at August's end (current 20 %, 31–60 and > 90 hari 100 %) → CKPN 13 jt → the journal → the close control passes.
 */
const CSV = [
  "Tanggal;Keterangan;Debet;Kredit;Saldo",
  "10/06/2026;TRSF CR PT MITRA UNGGAS INV-1;0;6000000;106000000",
  "15/07/2026;TRSF CR TOKO JAYA INV-2;0;20000000;126000000",
  "",
].join("\n");

async function sale(page: Page, v: { party: string; number: string; date: string; due: string; dpp: string }) {
  await page.getByRole("button", { name: "Faktur baru" }).click();
  await page.getByLabel("Pelanggan").fill(v.party);
  await page.getByLabel("Nomor faktur").fill(v.number);
  await page.getByLabel("Tanggal faktur").fill(v.date);
  await page.getByLabel("Jatuh tempo").fill(v.due);
  await page.getByLabel("DPP").fill(v.dpp);
  await page.getByRole("button", { name: "Simpan faktur" }).click();
  await expect(page.getByText(`Faktur ${v.number} dicatat`)).toBeVisible();
}

async function settle(page: Page, number: string, receipt: string) {
  await page.getByTestId(`invoice-${number}`).getByRole("button", { name: "Cocokkan" }).click();
  await page.getByTestId("settle-candidates").locator("> div").filter({ hasText: receipt }).getByRole("button", { name: "Cocokkan" }).click();
  await expect(page.getByText(new RegExp(`${number} dicocokkan`))).toBeVisible();
}

test("CKPN: roll-rate matrix from the aging, allowance journal, close control", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Grup Uji CKPN");
  await page.getByLabel("Nama lengkap").fill("PT CKPN Uji");
  await page.getByLabel("Nama singkat").fill("CKP");
  await page.getByLabel("Nomor rekening").fill("7788990011");
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await page.waitForURL(/\/clients\/[^/]+\/import/);
  const base = page.url().replace(/\/import.*$/, "");
  await page.goto(`${base}/import`);
  await openManualImport(page);
  await page.getByTestId("file-input").setInputFiles({ name: "bca.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
  await page.getByRole("button", { name: "Proses mutasi" }).click();
  await expect(page.getByTestId("import-result")).toContainText("Nyambung");

  await page.goto(`${base}/receivables?period=2026-08`);
  await sale(page, { party: "PT Mitra Unggas", number: "INV-1", date: "2026-05-05", due: "2026-05-20", dpp: "10.000.000" });
  await sale(page, { party: "Toko Jaya", number: "INV-2", date: "2026-06-01", due: "2026-06-30", dpp: "20.000.000" });
  await sale(page, { party: "Toko Jaya", number: "INV-3", date: "2026-07-01", due: "2026-07-31", dpp: "8.000.000" });
  await sale(page, { party: "PT Mitra Unggas", number: "INV-4", date: "2026-08-10", due: "2026-09-09", dpp: "5.000.000" });
  await settle(page, "INV-1", "MITRA UNGGAS");
  await settle(page, "INV-2", "TOKO JAYA");

  // Three months of history, saved → the matrix.
  const card = page.getByTestId(/^ckpn-/).first();
  await expect(card).toContainText("CKPN piutang usaha (PSAK 109) · CKP");
  await card.getByLabel("Riwayat (bulan)").fill("3");
  await card.getByRole("button", { name: "Simpan pengaturan" }).click();
  await expect(page.getByText("Pengaturan CKPN disimpan")).toBeVisible();
  await expect(card.getByTestId("ckpn-row-CURRENT")).toContainText("50,00%");
  await expect(card.getByTestId("ckpn-row-CURRENT")).toContainText("20,00%");
  await expect(card.getByTestId("ckpn-row-CURRENT")).toContainText("1.000.000");
  await expect(card.getByTestId("ckpn-row-D31_60")).toContainText("8.000.000");
  await expect(card.getByTestId("ckpn-row-OVER_90")).toContainText("4.000.000");
  await expect(card.getByTestId("ckpn-total")).toContainText("13.000.000");
  await expect(card).toContainText("4 akhir bulan");

  // The close control asks for it, then the journal clears it.
  await page.goto(`${base}/close?period=2026-08`);
  await expect(page.getByTestId("control-ckpn")).toContainText(/tambah Rp\s?13\.000\.000/);
  await page.goto(`${base}/receivables?period=2026-08`);
  await page.getByRole("button", { name: "Catat jurnal CKPN per Agustus 2026" }).click();
  await expect(page.getByText("Jurnal CKPN dicatat")).toBeVisible();
  await expect(page.getByTestId(/^ckpn-/).first()).toContainText("Cadangan di buku besar sudah sesuai matriks");
  await page.goto(`${base}/close?period=2026-08`);
  await expect(page.getByTestId("control-ckpn")).toContainText("sesuai matriks");
  await page.goto(`${base}/ledger/1135?period=2026-08`);
  await expect(page.getByText("CKPN piutang usaha per 31 Agu 2026 (PSAK 109): penambahan cadangan")).toBeVisible();

  if (process.env.E2E_SCREENSHOTS) {
    await page.goto(`${base}/receivables?period=2026-08`);
    await page.getByTestId(/^ckpn-/).first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/ckpn-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/ckpn-390.png`, fullPage: true });
  }
});
