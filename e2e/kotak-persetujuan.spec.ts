import { expect, test, type Page } from "@playwright/test";
import { addClient, uploadStatement } from "./qa-helpers";

/**
 * Kotak persetujuan (cycle 2026-10-17): every proposal of the month in one queue per client, counted on the firm board. On the demo
 * this spec only reads (CV Sinar's two Review lines belong to review-safety, Grup Ayam's August to the investor walk); every approval
 * runs on a client of its own: bank lines, scheduled journals and a Coretax faktur approved from Kotak, and the origin each entry names.
 */
const CSV = [
  "Tanggal;Keterangan;Debet;Kredit;Saldo",
  "01/08/2026;SALDO AWAL;;;500.000.000,00",
  "05/08/2026;TRSF CR PT MITRA ALFA;0,00;111.000.000,00;611.000.000,00",
  "10/08/2026;TRSF DB TOKO SINAR TERANG;2.000.000,00;0,00;609.000.000,00",
  "14/08/2026;TRSF DB PT CAHAYA BARU;3.000.000,00;0,00;606.000.000,00",
  "",
].join("\n");
const FAKTUR = [
  "Nomor Faktur Pajak;Tanggal Faktur Pajak;Masa Pajak;Tahun;NPWP Pembeli;Nama Pembeli;Status Faktur;Harga Jual/Penggantian/DPP;PPN",
  "04002600000000077;20/08/2026;8;2026;0222;CV Gamma;APPROVED;20000000;2200000",
  "",
].join("\n");

/** The firm board's *Persetujuan* link of a client for August, and the count it shows. */
async function boardCell(page: Page, client: string) {
  await page.goto("/?period=2026-08");
  const link = page.getByTestId("board-row").filter({ hasText: client }).getByRole("link", { name: /usulan|Selesai/ });
  await expect(link).toBeVisible();
  return { link, text: (await link.textContent())!.trim() };
}

const noSideScroll = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

test("demo: the board's Persetujuan cell equals the client's Kotak; a sure AI line is offered in bulk; Ubah opens Review on the line", async ({ page }) => {
  const { link, text } = await boardCell(page, "CV Sinar Retail");
  const n = Number(text.match(/^(\d+) usulan$/)![1]);
  expect(n).toBeGreaterThanOrEqual(2);
  await link.click();
  await expect(page.getByRole("heading", { name: "Kotak persetujuan" })).toBeVisible();
  await expect(page.getByTestId("next-step")).toContainText(`Setujui, ubah atau tolak ${n} usulan di bawah`);
  const bank = page.getByTestId("approval-bank");
  await expect(bank).toHaveCount(2);
  // The 83 % grosir sale is sure and unhinted; the 74 % rack is not: only one goes in bulk (not clicked: the demo stays as it is).
  await expect(page.getByTestId("approve-confident")).toHaveText(/Setujui 1 usulan yakin/);
  await expect(bank.filter({ hasText: "RAK DISPLAY" })).toContainText("keyakinan 74%");

  await bank.filter({ hasText: "RAK DISPLAY" }).getByRole("link", { name: /Ubah di Review/ }).click();
  await expect(page.getByRole("heading", { name: "Review transaksi" })).toBeVisible();
  await expect(page).toHaveURL(/tx=/);
  await expect(page.getByTestId("review-item").filter({ hasText: "RAK DISPLAY" })).toHaveClass(/ring-2/);
});

test("demo: a closed month shows its queue read-only", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Grup Ayam Nusantara", exact: true }).first().click();
  await page.waitForURL(/\/clients\/[^/]+/);
  const base = new URL(page.url()).pathname.match(/\/clients\/[^/]+/)![0];
  await page.goto(`${base}/approvals?period=2026-07`);
  await expect(page.getByTestId("next-step")).toContainText("Buku Juli 2026 sudah ditutup");
  await expect(page.getByRole("button", { name: /Setujui/ })).toHaveCount(0);
});

test("approve bank lines, scheduled journals and a Coretax faktur from Kotak; each entry names its origin", async ({ page }) => {
  const id = await addClient(page, { name: "QA Kotak Persetujuan" });
  await uploadStatement(page, id, "kotak.csv", CSV);
  await expect(page.getByTestId("import-result")).toContainText("Nyambung");

  // A depreciation schedule from June: June and July are overdue in August, August is due.
  await page.goto(`/clients/${id}/journals/new?period=2026-08`);
  await page.getByTestId("schedules").getByRole("button", { name: "Buat jadwal" }).click();
  await page.getByLabel("Keterangan jadwal").fill("Penyusutan mesin uji");
  await page.getByLabel("Total jadwal").fill("12.000.000");
  await page.getByLabel("Jumlah bulan").fill("12");
  await page.getByLabel("Bulan mulai").fill("2026-06");
  await page.getByRole("button", { name: "Simpan jadwal" }).click();
  await expect(page.getByText("Jadwal dibuat")).toBeVisible();

  // A faktur keluaran that is not in the books.
  await page.goto(`/clients/${id}/tax/masa?period=2026-08`);
  await page.getByLabel("File faktur Coretax").setInputFiles({ name: "faktur-kotak.csv", mimeType: "text/csv", buffer: Buffer.from(FAKTUR) });
  await page.getByTestId("faktur-upload").click();
  await expect(page.getByText("Faktur keluaran: 1 baru, 0 berubah")).toBeVisible();

  // Flow 1: the board counts 3 bank lines + 3 instalments + 1 faktur, and opens Kotak with the same total.
  const { link, text } = await boardCell(page, "QA Kotak Persetujuan");
  expect(text).toBe("7 usulan");
  await link.click();
  await expect(page.getByRole("heading", { name: "Kotak persetujuan" })).toBeVisible();
  const next = page.getByTestId("next-step");
  await expect(next).toContainText("Setujui, ubah atau tolak 7 usulan di bawah. Tidak ada yang dicatat tanpa klik Anda.");
  const tabs = page.getByRole("navigation", { name: "Jenis usulan" });
  for (const t of ["Semua 7", "Klasifikasi bank 3", "Jurnal terjadwal 3", "Faktur Coretax 1"]) await expect(tabs).toContainText(t);
  await expect(tabs).not.toContainText("Draf jurnal");
  // Simple guesses are never approved in bulk.
  await expect(page.getByTestId("approve-confident")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  const bank = page.getByTestId("approval-bank");
  await bank.filter({ hasText: "MITRA ALFA" }).getByRole("button", { name: "Setujui" }).click();
  await expect(bank.filter({ hasText: "MITRA ALFA" })).toHaveCount(0);
  await expect(next).toContainText("6 usulan");

  // Ubah: Review opens on that line, where the account is changed.
  await bank.filter({ hasText: "TOKO SINAR" }).getByRole("link", { name: /Ubah di Review/ }).click();
  await expect(page.getByRole("heading", { name: "Review transaksi" })).toBeVisible();
  const item = page.getByTestId("review-item").filter({ hasText: "TOKO SINAR" });
  await expect(item).toHaveClass(/ring-2/);
  await item.getByRole("combobox", { name: "Akun", exact: true }).click();
  await page.getByRole("combobox", { name: "Cari akun", expanded: true }).fill("6130");
  await page.keyboard.press("Enter");
  await item.getByTestId("accept").click();
  await expect(item).toHaveCount(0);
  await expect(page.getByTestId("review-saving")).toHaveCount(0);

  // Flow 2: the overdue instalment leads; one Setujui, then Catat semua for the rest.
  await page.goto(`/clients/${id}/approvals?period=2026-08`);
  const scheduled = page.getByTestId("approval-scheduled");
  await expect(scheduled).toHaveCount(3);
  await expect(scheduled.first()).toContainText("terlambat");
  await scheduled.first().getByRole("button", { name: "Setujui" }).click();
  await expect(scheduled).toHaveCount(2);
  await page.getByTestId("approvals-scheduled").getByRole("button", { name: "Catat semua 2" }).click();
  await expect(page.getByTestId("approvals-scheduled")).toHaveCount(0);

  // Flow 4: the faktur is booked as a receivable against the prefilled revenue account.
  const faktur = page.getByTestId("approval-faktur");
  await expect(faktur).toContainText("04002600000000077 · CV Gamma");
  await expect(faktur.getByRole("combobox", { name: "Akun pendapatan" })).toContainText("4100 Penjualan");
  await faktur.getByRole("button", { name: "Setujui" }).click();
  await expect(page.getByText("Faktur 04002600000000077 dicatat sebagai piutang")).toBeVisible();
  await expect(faktur).toHaveCount(0);
  await expect(next).toContainText("1 usulan");
  await expect(page.getByTestId("approval-bank")).toContainText("CAHAYA BARU");

  // Every entry names the proposal it was approved from.
  await page.goto(`/clients/${id}/journals?period=2026-08`);
  const origins = page.getByTestId("entry-origin");
  await expect(origins.filter({ hasText: "Tebakan 4100 disetujui" })).toHaveCount(1);
  await expect(origins.filter({ hasText: "Tebakan 6190 diubah ke 6130" })).toHaveCount(1);
  await expect(origins.filter({ hasText: "Faktur Coretax faktur-kotak.csv" })).toHaveCount(1);
  await expect(page.getByTestId("journal-entry").filter({ hasText: "Jadwal “Penyusutan mesin uji”, cicilan 3" })).toHaveCount(1);

  const after = await boardCell(page, "QA Kotak Persetujuan");
  expect(after.text).toBe("1 usulan");
});
