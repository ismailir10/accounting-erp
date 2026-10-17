import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { extractText, getDocumentProxy } from "unpdf";
import { asPeninjau, noSideScroll, openManualImport, openClientForm } from "./qa-helpers";

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

test("receivables and payables: invoice, settle from the statement, aging equals the ledger", async ({ page, browser, baseURL }) => {
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

  // Batas kredit (cycle 2026-10-17-pengingat-piutang): an invoice due 30 days before the month end, left unpaid.
  await newInvoice(page, "Faktur baru", { party: "PT Toko Lambat", number: "INV-300", date: "2026-08-01", due: "2026-08-01", dpp: "5.000.000" });
  await page.getByRole("button", { name: "Simpan faktur" }).click();
  await expect(page.getByText("Faktur INV-300 dicatat")).toBeVisible();
  const late = page.getByTestId("aging-PIU").getByTestId("aging-row-PT Toko Lambat");
  const setLimit = async (value: string) => {
    await late.getByRole("button", { name: "Ubah batas kredit PT Toko Lambat" }).click();
    await page.getByLabel("Batas kredit (Rp)").fill(value);
    await page.getByTestId("credit-limit-save").click();
  };
  await setLimit("abc");
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText('Nominal "abc" tidak bisa dibaca');
  await page.getByLabel("Batas kredit (Rp)").fill("0");
  await page.getByTestId("credit-limit-save").click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Batas kredit harus lebih dari nol");
  await page.keyboard.press("Escape");
  await expect(late.getByTestId("over-limit")).toHaveCount(0);
  await setLimit("5.000.000"); // below the open 5.550.000
  await expect(page.getByText("Batas kredit PT Toko Lambat: Rp 5.000.000")).toBeVisible();
  await expect(late).toContainText("Batas Rp 5.000.000");
  await expect(late.getByTestId("over-limit")).toContainText("lewat batas kredit");
  await expect(page.getByTestId("next-step")).toContainText("1 pelanggan lewat batas kredit");
  await setLimit("10.000.000");
  await expect(late).toContainText("Batas Rp 10.000.000");
  await expect(late.getByTestId("over-limit")).toHaveCount(0);

  // Pengingat: the overdue invoice with its days late, signed by the company; edited, copied, sent through WhatsApp, and the statement.
  await late.getByRole("button", { name: "Pengingat PT Toko Lambat" }).click();
  const reminder = page.getByTestId("reminder-dialog");
  await expect(reminder).toContainText("Per 31 Agu 2026 · PT Piutang Uji");
  await expect(reminder).toContainText("Bulan ini belum ditutup");
  const message = reminder.getByLabel("Pesan pengingat tagihan");
  await expect(message).toHaveValue(/1\. INV-300 \(tgl\. 1 Agu 2026, jatuh tempo 1 Agu 2026\): Rp 5\.550\.000, terlambat 30 hari/);
  await expect(message).toHaveValue(/Jumlah: Rp 5\.550\.000/);
  await expect(message).toHaveValue(/Hormat kami,\nPT Piutang Uji$/);
  await message.fill((await message.inputValue()).replace("Mohon pembayarannya", "Mohon kiranya pembayarannya"));
  await reminder.getByRole("button", { name: "Salin pesan" }).click();
  await expect(page.getByText(/Pesan tersalin|Pesan sudah dipilih/)).toBeVisible();
  const wa = await reminder.getByRole("link", { name: "Kirim lewat WhatsApp" }).getAttribute("href");
  expect(wa!.startsWith("https://wa.me/?text=")).toBe(true);
  expect(decodeURIComponent(wa!.slice("https://wa.me/?text=".length))).toContain("Mohon kiranya pembayarannya");
  const [statement] = await Promise.all([page.waitForEvent("download"), reminder.getByRole("link", { name: "Unduh surat tagihan (PDF)" }).click()]);
  expect(statement.suggestedFilename()).toBe("surat-tagihan-PT_Toko_Lambat-2026-08-31.pdf");
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(await readFile((await statement.path())!))), { mergePages: true });
  for (const s of ["Surat Tagihan", "PT Piutang Uji", "Kepada Yth. PT Toko Lambat", "INV-300", "30 hari", "5.550.000", "Ringkasan umur tagihan", "1–30 hari"]) expect(text, s).toContain(s);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("aging-PIU").getByRole("button", { name: /^Pengingat / })).toHaveCount(1); // the paid customers have none

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
  // No limits or reminders for suppliers.
  await expect(aging.getByRole("button", { name: /^(Pengingat|Ubah batas kredit) / })).toHaveCount(0);

  // Riwayat lists both limit changes.
  await page.goto(`${base}/history?kind=CREDIT_LIMIT`);
  await expect(page.getByText("PT Toko Lambat: tanpa batas → Rp 5.000.000")).toBeVisible();
  await expect(page.getByText("PT Toko Lambat: Rp 5.000.000 → Rp 10.000.000")).toBeVisible();

  // The invoice journal is in the ledger as a Faktur.
  await page.goto(`${base}/ledger/1130?period=2026-08`);
  await expect(page.getByText("Faktur INV-100 · PT Mitra Unggas")).toBeVisible();
  const shots = process.env.E2E_SCREENSHOTS;
  if (shots) {
    await page.goto(`${base}/receivables?period=2026-08&tab=utang`);
    await page.screenshot({ path: `${shots}/receivables-1440.png`, fullPage: true });
    await page.goto(`${base}/receivables?period=2026-08`);
    await page.screenshot({ path: `${shots}/receivables-piutang-1440.png`, fullPage: true });
    await page.getByRole("button", { name: "Pengingat PT Toko Lambat" }).click();
    await page.screenshot({ path: `${shots}/receivables-reminder-1440.png` });
    await page.keyboard.press("Escape");
  }

  // 390 px: Piutang and Utang do not scroll sideways, and the reminder dialog fits the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/receivables?period=2026-08`);
  await expect(page.getByTestId("aging-PIU").getByTestId("aging-row-PT Toko Lambat")).toBeVisible();
  await noSideScroll(page);
  if (shots) await page.screenshot({ path: `${shots}/receivables-piutang-390.png`, fullPage: true });
  await page.getByRole("button", { name: "Pengingat PT Toko Lambat" }).click();
  const dialog = page.getByTestId("reminder-dialog");
  await expect(dialog).toBeVisible();
  await expect.poll(async () => {
    const box = (await dialog.boundingBox())!;
    return box.x >= 0 && box.x + box.width <= 390;
  }).toBe(true);
  await noSideScroll(page);
  if (shots) await page.screenshot({ path: `${shots}/receivables-reminder-390.png` });
  await page.keyboard.press("Escape");
  await page.goto(`${base}/receivables?period=2026-08&tab=utang`);
  await expect(page.getByTestId("invoice-SM-77")).toBeAttached();
  await noSideScroll(page);
  if (shots) await page.screenshot({ path: `${shots}/receivables-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  // A Peninjau sees the limit and can prepare the reminder, but has no pencil to change the limit.
  await asPeninjau(page, browser, baseURL, "Grup Uji Piutang", async (viewer) => {
    await viewer.goto(`${new URL(base).pathname}/receivables?period=2026-08`);
    const row = viewer.getByTestId("aging-PIU").getByTestId("aging-row-PT Toko Lambat");
    await expect(row).toContainText("Batas Rp 10.000.000");
    await expect(viewer.getByRole("button", { name: /^Ubah batas kredit / })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Pengingat PT Toko Lambat" })).toBeVisible();
  });
});
