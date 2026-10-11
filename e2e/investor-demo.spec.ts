import { expect, test, type Page } from "@playwright/test";
import { openManualImport } from "./qa-helpers";

/** The 5-minute investor walk (docs/demo/investor-demo.md), end to end. */

test("shared Dokumen workspace has the same protected controls in either environment", async ({ page }) => {
  await page.goto("/documents");
  await expect(page.getByRole("heading", { name: "Dokumen", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tambahkan dokumen", exact: true })).toBeVisible();
  await expect(page.getByText("Demo publik · perusahaan dan angka rekaan")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto("/documents/source/private-version");
  await expect(page.getByRole("heading", { name: "Halaman tidak ditemukan" })).toBeVisible();
});

async function pickOption(page: Page, trigger: ReturnType<Page["locator"]>, name: RegExp) {
  await trigger.click();
  await page.getByRole("option", { name }).click();
}

test("statement in → reviewed → traceable reports → combined → closed", async ({ page }) => {
  // 1. Beranda points at the client that needs work
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tanya Buku", exact: true })).toBeVisible();
  // Papan kantor (I5a): Grup Ayam's August still misses the owner's BRI statement.
  await expect(page.getByTestId("firm-board")).toContainText("1 kurang");
  // The full task list is on Beranda ("Semua pekerjaan"); the old /work address lands there too.
  await page.goto("/work");
  await expect(page).toHaveURL(/\/\?.*tugas=semua/);
  await page.getByRole("link", { name: /Lengkapi 1 rekening koran · Grup Ayam Nusantara/ }).click();

  // 2. Live upload of the held-back BRI statement
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  // Sumber first (I1a): the grid shows the missing August statement and drafts the request to the client.
  await expect(page.getByTestId("completeness")).toContainText("Bolong");
  await expect(page.getByTestId("data-request").getByRole("textbox")).toHaveValue(/Agustus 2026/);
  await openManualImport(page);
  await pickOption(page, page.getByRole("combobox", { name: "Rekening", exact: true }), /5509/);
  await page.getByTestId("file-input").setInputFiles("public/demo/BRI-5509-2026-08.csv");
  await page.getByRole("button", { name: "Proses mutasi", exact: true }).click();
  const result = page.getByTestId("import-result");
  await expect(result).toContainText("perlu review");
  await expect(result).toContainText("Nyambung");
  await expect(result).toContainText("0 panggilan");

  // 3. Review: fix the AI's wrong guess (machine = fixed asset), accept the rest with Enter
  await result.getByRole("link", { name: /Review \d+ transaksi/ }).click();
  const items = page.getByTestId("review-item");
  await expect(items).toHaveCount(5);
  const machine = items.filter({ hasText: "AGRO TEKNIK" });
  await pickOption(page, machine.getByRole("combobox", { name: "Akun" }), /^1210 Aset Tetap/);
  await machine.getByTestId("accept").click();
  await expect(items).toHaveCount(4);
  for (let n = 4; n > 0; n--) {
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Enter");
    await expect(items).toHaveCount(n - 1);
  }
  await expect(page.getByText("Antrean kosong")).toBeVisible();
  await expect(page.getByTestId("review-saving")).toHaveCount(0); // accepts are optimistic: every save done

  // 3b. Pajak Masa: with the DP and the machine decided, the Coretax faktur tie to the books (ekualisasi PPN, I5c).
  await page.getByRole("link", { name: "Pajak Masa" }).click();
  await expect(page.getByRole("heading", { name: "Pajak Masa" })).toBeVisible();
  await expect(page.getByTestId("faktur-KELUARAN")).toContainText("Lolos");
  await expect(page.getByTestId("faktur-MASUKAN")).toContainText("Lolos");

  // 4. Every number traces to its bank row: P&L → account → ledger line → statement row
  await page.getByRole("link", { name: "Laporan Keuangan" }).click();
  await expect(page.getByRole("heading", { name: "Laporan Keuangan" })).toBeVisible();
  await page.getByTestId("fs-account-link").filter({ hasText: "4100 Penjualan" }).first().click();
  await expect(page.getByRole("heading", { name: /4100 Penjualan/ })).toBeVisible();
  await page.getByTestId("ledger-row").first().click();
  await expect(page.getByTestId("source-row")).toContainText("baris");

  // 5. Combined view eliminates intercompany once both sides are in
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Laporan Keuangan" }).click();
  await page.getByRole("tab", { name: "Kertas Kerja Gabungan" }).click();
  await expect(page.getByText("Antar entitas cocok")).toBeVisible();

  // 6. Adjustments: the depreciation schedule proposes August's installment → Catat; the machine reviewed in step 3 is a
  // fixed-asset candidate → a 48-month schedule from September
  await page.getByRole("link", { name: "Jurnal Penyesuaian" }).click();
  await expect(page.getByRole("heading", { name: "Jurnal Penyesuaian" })).toBeVisible();
  const due = page.getByTestId("schedule-proposals");
  await expect(due).toContainText("Penyusutan aset tetap (garis lurus) (6/120)");
  await expect(due).toContainText("9.500.000");
  await due.getByRole("button", { name: "Catat", exact: true }).click();
  await expect(page.getByText("Penyusutan aset tetap (garis lurus) (6/120) dicatat")).toBeVisible();
  await expect(page.getByTestId("schedule-proposals")).toHaveCount(0);
  const candidates = page.getByTestId("schedule-candidates");
  await expect(candidates).toContainText("MESIN PAKAN OTOMATIS");
  await expect(candidates).toContainText("166.666.667");
  await candidates.getByRole("button", { name: "Buat jadwal" }).click();
  await expect(page.getByLabel("Jumlah bulan")).toHaveValue("48");
  await expect(page.getByLabel("Bulan mulai")).toHaveValue("2026-09");
  await page.getByRole("button", { name: "Simpan jadwal" }).click();
  await expect(page.getByText("Jadwal dibuat")).toBeVisible();
  await expect(page.getByTestId("schedules")).toContainText("Penyusutan 1210 Aset Tetap 19 Agu 2026");
  await expect(page.getByTestId("schedule-candidates")).toHaveCount(0);

  // 7. Close: arithmetic passes; the ledger scan flags the machine bought in August (Aset Tetap moves for the first time
  // since its opening balance), and PT Ayam holds stock with no August count → the accountant notes why → sign-offs → lock
  await page.getByRole("link", { name: "Tutup Buku" }).click();
  await expect(page.getByRole("heading", { name: "Tutup Buku" })).toBeVisible();
  await expect(page.getByText(/\d+ kontrol lolos/).first()).toBeVisible();
  await expect(page.getByText("Gagal")).toHaveCount(0);
  const flagged = page.locator('[data-testid^="control-"]').filter({ hasText: "Perlu dicek" });
  await expect(flagged).toHaveCount(6);
  // Mandiri's derived opening and BRI's transaction-only period remain explicit
  // source-review controls even when the journals balance.
  for (const type of ["bank", "cont"]) {
    const sourceReviews = page.getByTestId(`control-${type}`).filter({ hasText: "Perlu dicek" });
    await expect(sourceReviews).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      await sourceReviews.nth(i).getByRole("button", { name: "Beri catatan" }).click();
      await page.getByRole("dialog").getByRole("textbox").fill("Demo sintetis: saldo dan periode sumber turunan belum membuktikan kelengkapan; keterbatasan dicatat untuk penelaahan.");
      await page.getByRole("button", { name: "Simpan catatan" }).click();
    }
  }
  const stock = page.getByTestId("control-inv");
  await expect(stock).toContainText("Persediaan akhir Agustus 2026 belum dicatat");
  await stock.getByRole("button", { name: "Beri catatan" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Klien menghitung stok hanya di akhir tahun; nilai pakan di gudang stabil.");
  await page.getByRole("button", { name: "Simpan catatan" }).click();
  await expect(stock).toContainText("akhir tahun");
  const capex = page.getByTestId("control-dormant");
  await expect(capex).toContainText("1210 Aset Tetap");
  await capex.getByRole("button", { name: "Beri catatan" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Pembelian mesin pakan otomatis, faktur PT Agro Teknik Mandiri ada. Penyusutan mulai September.");
  await page.getByRole("button", { name: "Simpan catatan" }).click();
  await expect(capex).toContainText("Penyusutan mulai September");
  const boxes = page.getByRole("checkbox");
  for (let i = 0; i < (await boxes.count()); i++) {
    await expect(boxes.nth(i)).toBeEnabled();
    await boxes.nth(i).click();
    await expect(boxes.nth(i)).toBeChecked();
  }
  await expect(page.getByTestId("lock")).toBeEnabled();
  await page.getByTestId("lock").click();
  // Locking is confirmed first: the dialog names the month and what closing means.
  await expect(page.getByRole("dialog", { name: "Tutup buku Agustus 2026?" })).toBeVisible();
  await page.getByTestId("confirm-lock").click();
  await expect(page.getByText("Buku Agustus 2026 sudah ditutup")).toBeVisible();

  // Reopening is for admins, needs a reason and stays in the history; the month is closed again for what follows.
  await page.getByTestId("unlock").click();
  await expect(page.getByTestId("confirm-lock")).toBeDisabled();
  await page.getByTestId("unlock-reason").fill("Cek ulang sebelum laporan dikirim ke klien");
  await page.getByTestId("confirm-lock").click();
  await expect(page.getByTestId("unlock-history")).toContainText("Cek ulang sebelum laporan dikirim ke klien");
  // A reopened month is reviewed again: its sign-offs were cleared, the control notes stay.
  await expect(page.getByTestId("lock")).toBeDisabled();
  for (let i = 0; i < (await boxes.count()); i++) {
    await expect(boxes.nth(i)).not.toBeChecked();
    await boxes.nth(i).click();
    await expect(boxes.nth(i)).toBeChecked();
  }
  await page.getByTestId("lock").click();
  await page.getByTestId("confirm-lock").click();
  await expect(page.getByText("Buku Agustus 2026 sudah ditutup")).toBeVisible();
});
