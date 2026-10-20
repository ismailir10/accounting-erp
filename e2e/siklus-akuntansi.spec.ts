import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { expect, test, type Page } from "@playwright/test";
import { addClient, uploadStatement } from "./qa-helpers";

/**
 * A whole accounting cycle as an accountant does it, across a year end, every figure computed by hand first (cycle
 * 2026-10-20-paritas-inti). Saldo Awal on 31 Oct 2025 (bank 100.000.000, petty cash 5.000.000, a receivable 20.000.000 and a payable
 * 15.000.000 detailed as Saldo Awal items, equipment 60.000.000 less 12.000.000 depreciated, capital 100.000.000, Saldo Laba 58.000.000)
 * → November, December and January statements → Review, settlements, a petty-cash expense, an accrual reversed on the 1st, depreciation
 * 1.000.000 a month, a December invoice with PPN paid in January → November and December closed.
 *
 *  November: revenue 50.000.000; rent 10.000.000, salaries 12.000.000, electricity accrual 2.000.000, stationery 500.000, depreciation
 *            1.000.000, bank charges 15.000 → profit 24.485.000.
 *  December: revenue 30.000.000 + 10.000.000 (INV-2512) + interest 100.000; rent, salaries, depreciation, bank charges 15.000, final
 *            tax on interest 20.000; electricity paid 2.000.000 against the reversed accrual → 0 → profit 17.065.000; 2025: 41.550.000.
 *  31 Dec:   cash 143.550.000 (bank 138.050.000 + petty cash 5.500.000), receivable 11.100.000, equipment 60.000.000 less 14.000.000,
 *            total assets 200.650.000 = PPN 1.100.000 + capital 100.000.000 + Saldo Laba 58.000.000 + profit 41.550.000.
 *            Cash flow: 41.550.000 + 8.900.000 receivables + 2.000.000 depreciation − 15.000.000 payables + 1.100.000 PPN = 38.550.000.
 *  January:  Saldo Laba opens at 99.550.000 everywhere (Neraca Saldo, Neraca, Buku Besar); rent, salaries and depreciation → loss
 *            23.000.000.
 */
const csv = (rows: string[]) => ["Tanggal;Keterangan;Debet;Kredit;Saldo", ...rows, ""].join("\n");
const NOV = csv([
  "01/11/2025;SALDO AWAL;;;100.000.000,00",
  "03/11/2025;TRSF DARI PT PELANGGAN MAJU;0,00;20.000.000,00;120.000.000,00",
  "05/11/2025;BAYAR SEWA KANTOR NOV;10.000.000,00;0,00;110.000.000,00",
  "10/11/2025;TRSF MASUK JASA KONSULTASI PT ABC;0,00;50.000.000,00;160.000.000,00",
  "15/11/2025;BAYAR SUPPLIER CV BAHAN;15.000.000,00;0,00;145.000.000,00",
  "25/11/2025;GAJI KARYAWAN NOV;12.000.000,00;0,00;133.000.000,00",
  "30/11/2025;BIAYA ADM;15.000,00;0,00;132.985.000,00",
]);
const DEC = csv([
  "01/12/2025;SALDO AWAL;;;132.985.000,00",
  "05/12/2025;BAYAR SEWA KANTOR DES;10.000.000,00;0,00;122.985.000,00",
  "10/12/2025;BAYAR PLN LISTRIK NOV;2.000.000,00;0,00;120.985.000,00",
  "15/12/2025;TRSF MASUK JASA KONSULTASI PT XYZ;0,00;30.000.000,00;150.985.000,00",
  "20/12/2025;TARIK TUNAI ISI KAS KECIL;1.000.000,00;0,00;149.985.000,00",
  "24/12/2025;GAJI KARYAWAN DES;12.000.000,00;0,00;137.985.000,00",
  "31/12/2025;BUNGA;0,00;100.000,00;138.085.000,00",
  "31/12/2025;PAJAK BUNGA;20.000,00;0,00;138.065.000,00",
  "31/12/2025;BIAYA ADM;15.000,00;0,00;138.050.000,00",
]);
const JAN = csv([
  "01/01/2026;SALDO AWAL;;;138.050.000,00",
  "05/01/2026;BAYAR SEWA KANTOR JAN;10.000.000,00;0,00;128.050.000,00",
  "15/01/2026;TRSF DARI PT DELTA INV-2512;0,00;11.100.000,00;139.150.000,00",
  "25/01/2026;GAJI KARYAWAN JAN;12.000.000,00;0,00;127.150.000,00",
]);

test.use({ actionTimeout: 20_000 });

/** Waits for the action's own toast: its success text, or the error it raised (named in the failure). */
async function saved(page: Page, text: string | RegExp) {
  const ok = page.locator("[data-sonner-toast]").filter({ hasText: text }).first();
  const bad = page.locator("[data-sonner-toast][data-type=error]").first();
  await expect(ok.or(bad)).toBeVisible();
  if (await bad.isVisible()) throw new Error(`Toast error: ${await bad.innerText()}`);
}

async function pick(page: Page, label: string, name: RegExp) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name }).first().click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

async function classify(page: Page, text: string, account: string) {
  const item = page.getByTestId("review-item").filter({ hasText: text });
  await item.getByRole("combobox", { name: "Akun", exact: true }).click();
  await page.getByRole("combobox", { name: "Cari akun", expanded: true }).fill(account);
  await page.keyboard.press("Enter");
  await item.getByTestId("accept").click();
  await expect(page.getByTestId("review-item").filter({ hasText: text })).toHaveCount(0);
}

/** Opens Jurnal Penyesuaian for `period` and types the date once the form is interactive (a date typed before hydration is reset). */
async function journalForm(page: Page, id: string, period: string, date: string) {
  await page.goto(`/clients/${id}/journals/new?period=${period}`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Tanggal").fill(date);
  await expect(page.getByLabel("Tanggal")).toHaveValue(date);
}

async function depreciate(page: Page, id: string, period: string, k: number) {
  await page.goto(`/clients/${id}/journals/new?period=${period}`);
  await page.getByRole("button", { name: "Catat", exact: true }).first().click();
  await saved(page, `Penyusutan Peralatan kantor (${k}/48) dicatat`);
}

async function closeMonth(page: Page, id: string, period: string) {
  await page.goto(`/clients/${id}/close?period=${period}`);
  // The generic CSV prints no period, so the accountant confirms coverage in writing (the running balance chains).
  for (let n = await page.getByRole("button", { name: "Beri catatan" }).count(); n > 0; n--) {
    await page.getByRole("button", { name: "Beri catatan" }).first().click();
    await page.getByLabel("Catatan kontrol").fill("Rekening koran sebulan penuh dicek: saldo awal dan akhir sesuai cetakan bank.");
    await page.getByRole("button", { name: "Simpan catatan" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Beri catatan" })).toHaveCount(n - 1);
  }
  const boxes = page.getByTestId("signoff").getByRole("checkbox");
  for (let i = 0; i < (await boxes.count()); i++) {
    if (!(await boxes.nth(i).isChecked())) {
      await boxes.nth(i).click();
      await expect(boxes.nth(i)).toBeChecked();
    }
  }
  await page.getByTestId("lock").click();
  await page.getByTestId("confirm-lock").click();
  await saved(page, /Buku .* ditutup/);
}

const row = (page: Page, name: RegExp) => page.locator("main").getByRole("row", { name }).first();

test("a whole accounting cycle across a year end: Saldo Awal → three months → closed → reports tie out by hand", async ({ page }) => {
  test.setTimeout(600_000);
  const id = await addClient(page, { name: "Uji Siklus Penuh", account: "5551234567" });
  await uploadStatement(page, id, "nov.csv", NOV);
  await expect(page.getByTestId("import-result")).toContainText("Nyambung", { timeout: 60_000 });

  // Saldo Awal per 31 Oct 2025, balanced: no difference, no Temuan.
  await page.goto(`/clients/${id}/opening`);
  await page.getByLabel("Per tanggal").fill("2025-10-31");
  const others: [RegExp, "Debit" | "Kredit", string][] = [
    [/^1110 /, "Debit", "5.000.000"], [/^1130 /, "Debit", "20.000.000"], [/^1210 /, "Debit", "60.000.000"],
    [/^1219 /, "Kredit", "12.000.000"], [/^2110 /, "Kredit", "15.000.000"], [/^3100 /, "Kredit", "100.000.000"],
  ];
  for (const [i, [account, side, amount]] of others.entries()) {
    await page.getByRole("button", { name: "Tambah akun lain" }).click();
    await pick(page, `Akun baris ${i + 1}`, account);
    await page.getByLabel(side, { exact: true }).nth(i).fill(amount);
  }
  await page.getByLabel("Saldo Laba kredit").fill("58.000.000");
  await expect(page.getByTestId("opening-difference")).toHaveCount(0);
  await page.getByRole("button", { name: "Simpan saldo awal" }).click();
  await saved(page, "Saldo awal tersimpan");

  // The receivable and the payable detailed as Saldo Awal items; the equipment registered from Saldo Awal.
  await page.goto(`/clients/${id}/receivables?period=2025-11`);
  await page.getByRole("button", { name: "Faktur baru" }).click();
  await page.getByLabel("Pelanggan").fill("PT Pelanggan Maju");
  await page.getByLabel("Nomor faktur").fill("INV-2510");
  await page.getByLabel("Tanggal faktur").fill("2025-10-20");
  await page.locator("label[for=inv-opening]").click();
  await page.getByLabel("DPP").fill("20.000.000");
  await page.getByRole("button", { name: "Simpan faktur" }).click();
  await saved(page, "Faktur INV-2510 dicatat");
  await page.getByRole("tab", { name: "Utang", exact: true }).click();
  await page.getByRole("button", { name: "Tagihan baru" }).click();
  await page.getByLabel("Pemasok").fill("CV Bahan");
  await page.getByLabel("Nomor tagihan").fill("CVB-099");
  await page.getByLabel("Tanggal tagihan").fill("2025-10-25");
  await page.locator("label[for=inv-opening]").click();
  await page.getByLabel("DPP").fill("15.000.000");
  await page.getByRole("button", { name: "Simpan tagihan" }).click();
  await saved(page, "Tagihan CVB-099 dicatat");

  await page.goto(`/clients/${id}/assets?period=2025-11`);
  await page.getByRole("button", { name: "Tambah aset" }).click();
  await page.getByLabel("Nama aset").fill("Peralatan kantor");
  await page.getByLabel("Tanggal perolehan").fill("2024-11-01");
  await page.getByLabel("Harga perolehan").fill("60.000.000");
  await pick(page, "Akun aset", /^1210 /);
  await page.getByLabel("Masa manfaat buku (bulan)").fill("60");
  await page.locator("label[for=asset-opening]").click();
  await page.getByLabel("Akumulasi penyusutan di Saldo Awal").fill("12.000.000");
  await page.getByLabel("Sisa masa manfaat (bulan)").fill("48");
  await page.getByLabel("Mulai disusutkan").fill("2025-11");
  await page.getByRole("button", { name: "Simpan aset" }).click();
  await saved(page, "Peralatan kantor terdaftar");
  await expect(page.getByText("Cocok dengan buku besar")).toBeVisible();

  // November: the opening receivable and payable settled from the statement, two lines classified, the rest by built-in rules.
  await page.goto(`/clients/${id}/receivables?period=2025-11`);
  await page.getByTestId("invoice-INV-2510").getByRole("button", { name: "Cocokkan" }).click();
  await page.getByTestId("settle-candidates").locator("> div").first().getByRole("button", { name: "Cocokkan" }).click();
  await saved(page, /INV-2510 dicocokkan/);
  await page.getByRole("tab", { name: "Utang", exact: true }).click();
  await page.getByTestId("invoice-CVB-099").getByRole("button", { name: "Cocokkan" }).click();
  await page.getByTestId("settle-candidates").locator("> div").first().getByRole("button", { name: "Cocokkan" }).click();
  await saved(page, /CVB-099 dicocokkan/);
  await page.goto(`/clients/${id}/review?period=2025-11`);
  await classify(page, "SEWA KANTOR NOV", "6120");
  await classify(page, "JASA KONSULTASI PT ABC", "4110");

  // Nothing typed by hand may land inside Saldo Awal.
  await journalForm(page, id, "2025-11", "2025-10-15");
  await page.getByRole("button", { name: "Kas kecil keluar" }).click();
  await page.getByLabel("Debit baris 1").fill("500.000");
  await page.getByLabel("Kredit baris 2").fill("500.000");
  await page.getByRole("button", { name: "Simpan jurnal" }).click();
  await expect(page.locator("[data-sonner-toast][data-type=error]")).toContainText("sampai 31 Okt 2025 sudah tercatat di Saldo Awal");

  // The petty-cash template, then an accrual reversed on 1 December.
  await journalForm(page, id, "2025-11", "2025-11-20");
  await page.getByRole("button", { name: "Kas kecil keluar" }).click();
  await expect(page.getByLabel("Keterangan")).toHaveValue("Pengeluaran kas kecil");
  await page.getByLabel("Keterangan").fill("Beli ATK tunai dari kas kecil");
  await pick(page, "Akun baris 1", /^6160 /);
  await page.getByLabel("Debit baris 1").fill("500.000");
  await page.getByLabel("Kredit baris 2").fill("500.000");
  await page.getByRole("button", { name: "Simpan jurnal" }).click();
  await saved(page, /Jurnal penyesuaian tersimpan/);
  await journalForm(page, id, "2025-11", "2025-11-30");
  await page.getByLabel("Keterangan").fill("Akrual listrik November");
  await pick(page, "Akun baris 1", /^6130 /);
  await page.getByLabel("Debit baris 1").fill("2.000.000");
  await pick(page, "Akun baris 2", /^2150 /);
  await page.getByLabel("Kredit baris 2").fill("2.000.000");
  await page.getByText("Balik otomatis pada 1 Desember 2025").click();
  await page.getByRole("button", { name: "Simpan jurnal" }).click();
  await saved(page, /Jurnal penyesuaian tersimpan, dibalik pada 1 Desember 2025/);
  await depreciate(page, id, "2025-11", 1);

  await page.goto(`/clients/${id}/trial-balance?period=2025-11`);
  await expect(row(page, /Total/)).toContainText("Seimbang");
  await expect(row(page, /Total/)).toContainText("223.000.000");
  await page.goto(`/clients/${id}/reports?period=2025-11`);
  await expect(row(page, /^Laba bersih/)).toContainText("24.485.000");
  await closeMonth(page, id, "2025-11");

  // A closed month refuses a journal.
  await journalForm(page, id, "2025-11", "2025-11-29");
  await expect(page.getByText("Buku November 2025 sudah ditutup").first()).toBeVisible();

  // December.
  await uploadStatement(page, id, "dec.csv", DEC);
  await expect(page.getByTestId("import-result")).toContainText("Nyambung", { timeout: 60_000 });
  await page.goto(`/clients/${id}/review?period=2025-12`);
  await classify(page, "SEWA KANTOR DES", "6120");
  await classify(page, "JASA KONSULTASI PT XYZ", "4110");
  await classify(page, "ISI KAS KECIL", "1110");
  await expect(page.getByTestId("review-item")).toHaveCount(0);
  await page.goto(`/clients/${id}/receivables?period=2025-12`);
  await page.getByRole("button", { name: "Faktur baru" }).click();
  await page.getByLabel("Pelanggan").fill("PT Delta");
  await page.getByLabel("Nomor faktur").fill("INV-2512");
  await page.getByLabel("Tanggal faktur").fill("2025-12-28");
  await page.getByLabel("Jatuh tempo").fill("2026-01-27");
  await page.getByLabel("DPP").fill("10.000.000");
  await page.getByRole("button", { name: "Hitung 11%" }).click();
  await page.getByRole("button", { name: "Simpan faktur" }).click();
  await saved(page, "Faktur INV-2512 dicatat");
  await depreciate(page, id, "2025-12", 2);

  await page.goto(`/clients/${id}/reports?period=2025-12`);
  const profit = row(page, /^Laba bersih/);
  await expect(profit).toContainText("17.065.000");
  await expect(profit).toContainText("24.485.000");
  await expect(profit).toContainText("41.550.000");
  await page.goto(`/clients/${id}/reports?period=2025-12&tab=bs`);
  await expect(page.getByText("Seimbang").first()).toBeVisible();
  await expect(row(page, /^Jumlah aset\s*[\d(]/)).toContainText("200.650.000");
  await expect(row(page, /^Jumlah liabilitas dan ekuitas/)).toContainText("200.650.000");
  await expect(row(page, /^Kas dan setara kas/)).toContainText("143.550.000");
  await page.goto(`/clients/${id}/reports?period=2025-12&tab=eq`);
  await expect(row(page, /^Saldo 31 Des 2025/)).toContainText("199.550.000");
  await page.goto(`/clients/${id}/reports?period=2025-12&tab=cf`);
  await expect(row(page, /^Kas bersih dari aktivitas operasi/)).toContainText("38.550.000");
  await expect(row(page, /^Kas dan setara kas 31 Des 2025/)).toContainText("143.550.000");

  // Neraca Lajur for 2025: adjustments 6.500.000 each side, profit 41.550.000 balancing Laba Rugi and Neraca.
  await page.goto(`/clients/${id}/trial-balance?period=2025-12`);
  await page.getByRole("link", { name: "Neraca Lajur" }).click();
  await page.getByRole("link", { name: "Tahun buku s.d. bulan ini" }).click();
  const lajur = page.getByTestId("neraca-lajur");
  await expect(lajur.getByRole("row", { name: /^Jumlah Seimbang/ })).toContainText("6.500.000");
  await expect(lajur.getByRole("row", { name: /^Jumlah Seimbang/ })).toContainText("263.200.000");
  await expect(page.getByTestId("neraca-lajur-profit")).toContainText("41.550.000");
  const [sheet] = await Promise.all([page.waitForEvent("download"), page.getByTestId("neraca-lajur-download-ytd").click()]);
  expect(sheet.suggestedFilename()).toBe("neraca-lajur-PT_Uji_Siklus_Penuh-sd-Desember-2025.xlsx");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile((await sheet.path())!)) as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  let profitRow: ExcelJS.Row | undefined;
  ws.eachRow((r) => { if (r.getCell(2).value === "Laba bersih") profitRow = r; });
  expect((profitRow!.getCell(9).value as { result: number }).result).toBe(41_550_000);

  // Nomor bukti: the December depreciation is JP-2512-0002 (the accrual's reversal took 0001), found by its number.
  await page.goto(`/clients/${id}/journals?period=2025-12&q=jp-2512-2`);
  await expect(page.getByTestId("journal-entry")).toHaveCount(1);
  await expect(page.getByTestId("entry-number")).toHaveText("JP-2512-0002");
  await expect(page.getByTestId("journal-entry")).toContainText("Penyusutan Peralatan kantor (2/48)");
  await closeMonth(page, id, "2025-12");

  // January 2026: the new year opens Saldo Laba with 2025's result, the same number on every page.
  await uploadStatement(page, id, "jan.csv", JAN);
  await expect(page.getByTestId("import-result")).toContainText("Nyambung", { timeout: 60_000 });
  await page.goto(`/clients/${id}/receivables?period=2026-01`);
  await page.getByTestId("invoice-INV-2512").getByRole("button", { name: "Cocokkan" }).click();
  await page.getByTestId("settle-candidates").locator("> div").first().getByRole("button", { name: "Cocokkan" }).click();
  await saved(page, /INV-2512 dicocokkan/);
  await page.goto(`/clients/${id}/review?period=2026-01`);
  await classify(page, "SEWA KANTOR JAN", "6120");
  await depreciate(page, id, "2026-01", 3);

  await page.goto(`/clients/${id}/trial-balance?period=2026-01`);
  await expect(row(page, /Saldo Laba/)).toContainText("99.550.000");
  await page.goto(`/clients/${id}/ledger/3200?period=2026-01`);
  await expect(page.getByTestId("ledger-prior-year")).toContainText("41.550.000");
  await expect(row(page, /^Saldo awal periode/)).toContainText("99.550.000");
  await page.goto(`/clients/${id}/reports?period=2026-01&tab=bs`);
  await expect(row(page, /^3200 Saldo Laba/)).toContainText("99.550.000");
  await expect(row(page, /^Laba \(rugi\) tahun berjalan/)).toContainText("(23.000.000)");
  await expect(row(page, /^Jumlah aset\s*[\d(]/)).toContainText("177.650.000");
  await page.goto(`/clients/${id}/reports?period=2026-01`);
  await expect(row(page, /^Laba bersih/)).toContainText("(23.000.000)");
});
