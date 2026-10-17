import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { addClient, asPeninjau, noSideScroll, signIn, uploadStatement } from "./qa-helpers";

/**
 * Bukti potong untuk Coretax (cycle docs/cycles/2026-10-17-bppu-files.md), flows 1–3 on a client of its own (shared demo state untouched):
 *  - a bill from CV Konsultan A (DPP 10.000.000, PPh 23 2 %) settled by a payment of 9.800.000: the slip is prefilled from the bill;
 *  - rent paid net of PPh 4(2) 10 %, typed in Review with no contact: a new recipient with a NIK, KOP 28-403-02, a contract;
 *  - a consultant paid with PPN split and PPh 23 (qa-tax-split's figures): no DPP is computed, one off by Rp 5 is blocked with both amounts.
 * Every row turns Siap in place, the XML holds the Siap rows in DJP's order, a Coretax *dibuat* slip moves its line to *Sudah ada di
 * Coretax*, Riwayat has the slip and the download, a Peninjau downloads but can't edit, and an unassigned member gets 404.
 */
const CSV = [
  "Tanggal;Keterangan;Debet;Kredit;Saldo",
  "01/08/2026;SALDO AWAL;;;500.000.000,00",
  "10/08/2026;TRSF DB CV KONSULTAN A B-77;9.800.000,00;0,00;490.200.000,00",
  "15/08/2026;SEWA RUKO HJ ROSMIATI;9.000.000,00;0,00;481.200.000,00",
  "21/08/2026;JASA KONSULTAN ABC;15.000.000,00;0,00;466.200.000,00",
  "",
].join("\n");
const CLIENT = "QA BPPU";

async function classify(page: Page, item: Locator, v: { account: string; tax?: RegExp; withholding: RegExp }) {
  await item.getByRole("combobox", { name: "Akun", exact: true }).click();
  await page.getByRole("combobox", { name: "Cari akun", expanded: true }).fill(v.account);
  await page.keyboard.press("Enter");
  if (v.tax) {
    await item.getByRole("combobox", { name: "Pajak", exact: true }).click();
    await page.getByRole("option", { name: v.tax }).first().click();
  }
  await item.getByRole("combobox", { name: "Pemotongan PPh", exact: true }).click();
  await page.getByRole("option", { name: v.withholding }).first().click();
  await item.getByTestId("accept").click();
}

async function choose(page: Page, label: string, option: string | RegExp) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option }).first().click();
}

const row = (page: Page, description: string) => page.locator(`[data-testid="bppu-row"][data-description="${description}"]`);
const notes = (page: Page, description: string) => row(page, description).locator("xpath=following-sibling::tr[1]");

test("bukti potong for Coretax: prefilled from the bill, block reasons fixed in place, XML of the Siap rows only", async ({ page, browser, baseURL }) => {
  const id = await addClient(page, { name: CLIENT, npwp: "01.234.567.8-015.000" });
  await uploadStatement(page, id, "bppu.csv", CSV);
  await expect(page.getByTestId("import-result")).toContainText("Nyambung");

  // Utang: CV Konsultan A's bill with PPh 23 at 2 %, settled by the 9.800.000 payment (200.000 withheld).
  await page.goto(`/clients/${id}/receivables?period=2026-08&tab=utang`);
  await page.getByRole("button", { name: "Tagihan baru" }).click();
  await page.getByLabel("Pemasok", { exact: true }).fill("CV Konsultan A");
  await page.getByLabel("Nomor tagihan", { exact: true }).fill("B-77");
  await page.getByLabel("Tanggal tagihan", { exact: true }).fill("2026-08-01");
  await page.getByLabel("DPP", { exact: true }).fill("10.000.000");
  await page.getByRole("combobox", { name: "Pajak yang dipotong" }).click();
  await page.getByRole("option", { name: "PPh 23" }).click();
  await page.getByLabel("Tarif atau nominal").fill("2");
  await page.getByRole("button", { name: "Simpan tagihan" }).click();
  await expect(page.getByText("Tagihan B-77 dicatat")).toBeVisible();
  await page.getByTestId("invoice-B-77").getByRole("button", { name: "Cocokkan" }).click();
  const candidate = page.getByTestId("settle-candidates").locator("> div").first();
  await expect(candidate).toContainText("CV KONSULTAN A B-77");
  await expect(candidate.getByLabel(/^Dipotong /)).toHaveValue("200.000");
  await candidate.getByRole("button", { name: "Cocokkan" }).click();
  await expect(page.getByText("B-77 dicocokkan dengan pembayaran 10 Agu 2026")).toBeVisible();

  // Review: rent net of PPh 4(2) 10 % (no contact), and the PPN-split consultant with PPh 23.
  await page.goto(`/clients/${id}/review?period=2026-08`);
  const items = page.getByTestId("review-item");
  await expect(items).toHaveCount(2);
  await classify(page, items.filter({ hasText: "ROSMIATI" }), { account: "6120", withholding: /PPh 4\(2\)/ });
  await expect(items).toHaveCount(1);
  await classify(page, items.filter({ hasText: "KONSULTAN ABC" }), { account: "6170", tax: /PPN Masukan/, withholding: /PPh 23/ });
  await expect(page.getByText("Antrean kosong")).toBeVisible();

  await page.goto(`/clients/${id}/tax/masa?period=2026-08`);
  const card = page.getByTestId("coretax-bppu");
  await expect(card.getByTestId("bppu-count-blocked")).toHaveText("3");
  await expect(card.getByTestId("bppu-count-ready")).toHaveText("0");
  await expect(card.getByTestId("bppu-count-in")).toHaveText("0");
  await expect(card.getByTestId("bppu-download")).toBeDisabled();
  await expect(card.getByTestId("bppu-download")).toHaveText(/Unduh XML BPPU \(0 bukti potong\)/);
  await expect(card.getByTestId("bppu-footnote")).toContainText("Format impor DJP bppu.xml (converter v.3), belum diuji dengan unggahan nyata");
  await expect(card.getByTestId("bppu-footnote")).toContainText("SPT Masa PPh Unifikasi paling lambat 20 Sep 2026");
  // The bill's DPP and number are prefilled; the supplier's NPWP and the KOP are missing.
  await expect(row(page, "TRSF DB CV KONSULTAN A B-77")).toContainText("10.000.000");
  await expect(notes(page, "TRSF DB CV KONSULTAN A B-77")).toContainText("Kode objek pajak belum dipilih.");
  await expect(notes(page, "TRSF DB CV KONSULTAN A B-77")).not.toContainText("DPP belum diisi.");
  for (const reason of ["Penerima belum dipilih.", "Kode objek pajak belum dipilih.", "DPP belum diisi.", "Dokumen referensi belum diisi."]) {
    await expect(notes(page, "SEWA RUKO HJ ROSMIATI")).toContainText(reason);
  }

  // Flow 1, first row: the supplier's NPWP (15 digits), then KOP 24-104-03 — its rate is DJP's, the DPP and document come from the bill.
  await notes(page, "TRSF DB CV KONSULTAN A B-77").getByRole("button", { name: "Lengkapi identitas" }).click();
  await expect(page.getByTestId("coretax-buyer-form")).toContainText("Penerima penghasilan: CV Konsultan A");
  await page.getByLabel("NPWP", { exact: true }).fill("09.876.543.2-101.200");
  await page.getByTestId("coretax-buyer-save").click();
  await expect(page.getByText("Identitas pajak CV Konsultan A disimpan")).toBeVisible();
  await notes(page, "TRSF DB CV KONSULTAN A B-77").getByRole("button", { name: "Atur bukti potong" }).click();
  const form = page.getByTestId("bppu-slip-form");
  await choose(page, "Kode objek pajak", "24-104-03 Jasa konsultan (2%)");
  await expect(form.getByTestId("slip-rate")).toHaveText("Tarif 2% sesuai referensi DJP.");
  await expect(form.getByLabel("Tarif (%)")).toHaveCount(0);
  await expect(form.getByLabel("DPP", { exact: true })).toHaveValue("10.000.000");
  await expect(form.getByTestId("slip-formula")).toHaveText("2% × DPP = Rp 200.000, buku Rp 200.000");
  await expect(form.getByLabel("Nomor dokumen")).toHaveValue("B-77");
  await expect(form.getByLabel("Tanggal dokumen")).toHaveValue("2026-08-01");
  await page.getByTestId("bppu-slip-save").click();
  await expect(page.getByText("Bukti potong TRSF DB CV KONSULTAN A B-77 disimpan")).toBeVisible();
  await expect(row(page, "TRSF DB CV KONSULTAN A B-77")).toHaveAttribute("data-status", "READY");

  // Flow 1, second row: a new recipient by name, KOP 28-403-02 (10 %: the DPP is the exact 1.000.000 ÷ 10 %), a contract; then the NIK.
  await notes(page, "SEWA RUKO HJ ROSMIATI").getByRole("button", { name: "Atur bukti potong" }).click();
  await choose(page, "Penerima penghasilan", "Penerima baru…");
  await form.getByLabel("Nama penerima baru").fill("Hj Rosmiati");
  await choose(page, "Kode objek pajak", /^28-403-02 /);
  await expect(form.getByTestId("slip-rate")).toHaveText("Tarif 10% sesuai referensi DJP.");
  await expect(form.getByLabel("DPP", { exact: true })).toHaveValue("10.000.000");
  await choose(page, "Dokumen referensi", "Kontrak");
  await form.getByLabel("Nomor dokumen").fill("SPK/08/2026");
  await form.getByLabel("Tanggal dokumen").fill("2026-08-01");
  await page.getByTestId("bppu-slip-save").click();
  await expect(page.getByText("Bukti potong SEWA RUKO HJ ROSMIATI disimpan")).toBeVisible();
  await expect(notes(page, "SEWA RUKO HJ ROSMIATI")).toContainText("NPWP atau NIK Hj Rosmiati belum diisi.");
  await notes(page, "SEWA RUKO HJ ROSMIATI").getByRole("button", { name: "Lengkapi identitas" }).click();
  await page.getByLabel("NIK (penerima tanpa NPWP)").fill("3174061502560010");
  await page.getByTestId("coretax-buyer-save").click();
  await expect(page.getByText("Identitas pajak Hj Rosmiati disimpan")).toBeVisible();
  await expect(row(page, "SEWA RUKO HJ ROSMIATI")).toHaveAttribute("data-status", "READY");

  // Flow 3: the PPN-split payment gets no computed DPP; Rp 5 off the formula blocks with both amounts; the right DPP clears it.
  await notes(page, "JASA KONSULTAN ABC").getByRole("button", { name: "Atur bukti potong" }).click();
  await choose(page, "Penerima penghasilan", "Penerima baru…");
  await form.getByLabel("Nama penerima baru").fill("PT ABC Konsultan");
  await choose(page, "Kode objek pajak", /^24-104-03 /);
  await expect(form.getByLabel("DPP", { exact: true })).toHaveValue("");
  await expect(form).toContainText("PPN mutasi ini dipisah dengan tarif efektif: isi DPP dari dokumennya.");
  await form.getByLabel("DPP", { exact: true }).fill("13.761.718");
  await expect(form.getByTestId("slip-formula")).toHaveText("2% × DPP = Rp 275.234, buku Rp 275.229");
  await form.getByLabel("Nomor dokumen").fill("ABC/08/01");
  await form.getByLabel("Tanggal dokumen").fill("2026-08-21");
  await page.getByTestId("bppu-slip-save").click();
  await expect(page.getByText("Bukti potong JASA KONSULTAN ABC disimpan")).toBeVisible();
  await expect(notes(page, "JASA KONSULTAN ABC")).toContainText("2% × DPP Rp 13.761.718 = Rp 275.234, buku mencatat PPh Rp 275.229.");
  await notes(page, "JASA KONSULTAN ABC").getByRole("button", { name: "Atur bukti potong" }).click();
  await form.getByLabel("DPP", { exact: true }).fill("13.761.468");
  await page.getByTestId("bppu-slip-save").click();
  await expect(notes(page, "JASA KONSULTAN ABC")).not.toContainText("buku mencatat PPh");
  await notes(page, "JASA KONSULTAN ABC").getByRole("button", { name: "Lengkapi identitas" }).click();
  await page.getByLabel("NPWP", { exact: true }).fill("01.111.222.3-444.000");
  await page.getByTestId("coretax-buyer-save").click();
  await expect(row(page, "JASA KONSULTAN ABC")).toHaveAttribute("data-status", "READY");
  await expect(card.getByTestId("bppu-count-ready")).toHaveText("3");
  await expect(card.getByTestId("bppu-count-blocked")).toHaveText("0");

  // 390 px: Pajak Masa with the slip list does not scroll sideways, nor with the slip sheet open.
  const shots = process.env.E2E_SCREENSHOTS;
  if (shots) await page.locator("#bukti-potong").screenshot({ path: `${shots}/bppu-1440.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card.getByTestId("bppu-count-ready")).toHaveText("3");
  await noSideScroll(page);
  if (shots) await page.locator("#bukti-potong").screenshot({ path: `${shots}/bppu-390.png` });
  // Nothing is blocked, so the Siap rows are unfolded.
  await notes(page, "SEWA RUKO HJ ROSMIATI").getByRole("button", { name: "Ubah bukti potong" }).click();
  await expect(form).toBeVisible();
  await noSideScroll(page);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });

  // The download: three slips in DJP's order, the NIK recipient with NIK + 000000.
  const [download] = await Promise.all([page.waitForEvent("download"), card.getByRole("link", { name: "Unduh XML BPPU (3 bukti potong)" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^bppu-.*-2026-08\.xml$/);
  const xml = readFileSync((await download.path())!, "utf8");
  expect(xml.match(/<Bpu>/g)).toHaveLength(3);
  expect(xml).toContain("<TIN>0012345678015000</TIN>");
  expect(xml).toContain("<CounterpartTin>0098765432101200</CounterpartTin>\n\t\t\t<IDPlaceOfBusinessActivityOfIncomeRecipient>0098765432101200000000</IDPlaceOfBusinessActivityOfIncomeRecipient>");
  expect(xml).toContain("<CounterpartTin>3174061502560010</CounterpartTin>\n\t\t\t<IDPlaceOfBusinessActivityOfIncomeRecipient>3174061502560010000000</IDPlaceOfBusinessActivityOfIncomeRecipient>");
  expect(xml).toContain("<TaxObjectCode>24-104-03</TaxObjectCode>\n\t\t\t<TaxBase>10000000</TaxBase>\n\t\t\t<Rate>2</Rate>\n\t\t\t<Document>CommercialInvoice</Document>\n\t\t\t<DocumentNumber>B-77</DocumentNumber>");
  expect(xml).toContain("<TaxObjectCode>28-403-02</TaxObjectCode>\n\t\t\t<TaxBase>10000000</TaxBase>\n\t\t\t<Rate>10</Rate>\n\t\t\t<Document>Contract</Document>");
  expect(xml).toContain("<TaxBase>13761468</TaxBase>");
  expect(xml).toContain('<GovTreasurerOpt>N/A</GovTreasurerOpt>\n\t\t\t<SP2DNumber xsi:nil="true"/>\n\t\t\t<WithholdingDate>2026-08-15</WithholdingDate>');
  expect(xml).toContain("<TaxPeriodMonth>8</TaxPeriodMonth>");

  // Flow 2: Coretax's dibuat list holds the first slip → it reads Sudah ada di Coretax and the next file holds the other two.
  const slips = [
    "Nomor Bukti Potong;Tanggal Pemotongan;Masa Pajak;Tahun Pajak;NPWP/NIK Penerima Penghasilan;Nama Penerima Penghasilan;Kode Objek Pajak;Dasar Pengenaan Pajak (Rp);PPh Dipotong (Rp);Status",
    "2600000123;10/08/2026;8;2026;0098765432101200;CV Konsultan A;24-104-03;10000000;200000;NORMAL",
    "",
  ].join("\n");
  await page.getByLabel("File bukti potong Coretax").setInputFiles({ name: "bppu-dibuat.csv", mimeType: "text/csv", buffer: Buffer.from(slips) });
  await page.getByTestId("bupot-upload").click();
  await expect(page.getByText("Bukti potong dibuat: 1 baru, 0 berubah")).toBeVisible();
  await expect(card.getByTestId("bppu-count-in")).toHaveText("1");
  await expect(row(page, "TRSF DB CV KONSULTAN A B-77")).toHaveAttribute("data-status", "IN_CORETAX");
  await expect(notes(page, "TRSF DB CV KONSULTAN A B-77")).toContainText("Sudah ada di Coretax: bukti potong 2600000123.");
  await expect(card.getByTestId("bppu-left-out")).toContainText("1 sudah ada di Coretax tidak ikut");
  const [second] = await Promise.all([page.waitForEvent("download"), card.getByRole("link", { name: "Unduh XML BPPU (2 bukti potong)" }).click()]);
  const again = readFileSync((await second.path())!, "utf8");
  expect(again.match(/<Bpu>/g)).toHaveLength(2);
  expect(again).not.toContain("<DocumentNumber>B-77</DocumentNumber>");

  // Riwayat: the slip saved (no NIK) and the download, as bukti potong — not a report sent.
  await page.goto(`/clients/${id}/history?kind=BUKTI_POTONG`);
  await expect(page.getByText("Bukti potong SEWA RUKO HJ ROSMIATI 15 Agu 2026: penerima Hj Rosmiati, kode 28-403-02 (10%), DPP Rp 10.000.000, kontrak SPK/08/2026 (1 Agu 2026)")).toBeVisible();
  await expect(page.getByText(/XML bukti potong .* masa Agustus 2026 diunduh: 3 bukti potong/)).toBeVisible();
  await expect(page.locator("main")).not.toContainText("3174061502560010");

  // A member not assigned to this client (the e2e Akuntan holds only the demo clients) gets 404 on the download.
  await page.goto(`/clients/${id}/tax/masa?period=2026-08`);
  const href = (await page.getByTestId("coretax-bppu").getByRole("link", { name: /Unduh XML BPPU/ }).getAttribute("href"))!;
  const outsider = await signIn(browser, baseURL, "credentials-akuntan.json");
  try {
    expect((await outsider.request.get(href)).status()).toBe(404);
  } finally {
    await outsider.context().close();
  }

  // A Peninjau sees the list and downloads, but has nothing to edit.
  await asPeninjau(page, browser, baseURL, CLIENT, async (viewer) => {
    await viewer.goto(`/clients/${id}/tax/masa?period=2026-08`);
    const list = viewer.getByTestId("coretax-bppu");
    await expect(list.getByTestId("bppu-count-ready")).toHaveText("2");
    await expect(list.getByTestId("bppu-row")).toHaveCount(3);
    await expect(list.getByRole("button", { name: /bukti potong$|identitas$/, includeHidden: true })).toHaveCount(0);
    expect((await viewer.request.get(href)).status()).toBe(200);
    await viewer.setViewportSize({ width: 390, height: 844 });
    await expect(list.getByTestId("bppu-count-ready")).toHaveText("2");
    await noSideScroll(viewer);
  });
});

test("a masa with no company withholding says there is nothing to prepare", async ({ page }) => {
  const id = await addClient(page, { name: "QA BPPU Kosong", npwp: "01.234.567.8-015.000" });
  await page.goto(`/clients/${id}/tax/masa?period=2026-08`);
  const card = page.getByTestId("coretax-bppu");
  await expect(card).toContainText("Tidak ada pemotongan oleh perusahaan masa ini.");
  await expect(card.getByTestId("bppu-download")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
});
