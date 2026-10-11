import { expect, test } from "@playwright/test";
import { toBcaCsv, type StatementFile } from "../lib/demo/writers";
import { makePdf, table } from "../tests/pdf-fixture";

/**
 * New client from files (docs/cycles/2026-10-10-new-client-from-files.md): Tambah klien starts from the client's statements. Buku reads
 * them before the client exists, proposes the company and its rekening in one card, and *Buat klien & impor* creates the client and
 * books every file in Unggah. Months before August 2026, so the demo's story and the investor walk are untouched. Synthetic files only;
 * rules-only mode (no AI key).
 */
const NAME = "Klien Dari File Uji";
const BCA = "6044557711";
const MANDIRI = "1230007655544";
const PASSWORD = "DariFile2026";
const d = (day: number, month: number) => new Date(Date.UTC(2026, month - 1, day));
const bca = (month: number, opening: bigint, rows: StatementFile["rows"]): StatementFile => ({ bank: "BCA", accountNumber: BCA, holder: `PT ${NAME}`, year: 2026, month, opening, rows });
const juni = bca(6, 40_000_000n, [
  { date: d(4, 6), description: "TRSF E-BANKING CR 0406/FTSCY/WS95031 CV PELANGGAN FILE", amount: 8_000_000n },
  { date: d(30, 6), description: "BIAYA ADM", amount: -15_000n },
]);
const juli = bca(7, 47_985_000n, [
  { date: d(2, 7), description: "TRSF E-BANKING DB 0207/FTSCY/WS95031 SEWA GUDANG FILE", amount: -3_000_000n },
  { date: d(31, 7), description: "BUNGA", amount: 50_000n },
]);
const mandiri = makePdf(
  [
    [
      ...table(800, [[[40, "PT Bank Mandiri (Persero) Tbk"]], [[40, `Nomor Rekening : ${MANDIRI}`]], [[40, "Periode : 01/07/2026 - 31/07/2026"]]]),
      ...table(740, [
        [[40, "Tanggal"], [130, "Keterangan"], [360, "Debit"], [440, "Kredit"], [520, "Saldo"]],
        [[40, "01/07/2026"], [130, "SALDO AWAL"], [500, "10.000.000,00"]],
        [[40, "09/07/2026"], [130, "TRANSFER DARI CV PELANGGAN FILE"], [430, "2.500.000,00"], [510, "12.500.000,00"]],
        [[40, "31/07/2026"], [130, "SALDO AKHIR"], [510, "12.500.000,00"]],
      ]),
    ],
  ],
  { userPassword: PASSWORD },
);

test("Tambah klien from files: one password, one card, the client created and every file booked", async ({ page }) => {
  await page.goto("/clients/new");
  await page.getByLabel("Nama klien").fill(NAME);
  await page.getByTestId("client-file-input").setInputFiles([
    { name: "bca-7711-juli-2026.csv", mimeType: "text/csv", buffer: Buffer.from(toBcaCsv(juli)) },
    { name: "mandiri-5544-juli-2026.pdf", mimeType: "application/pdf", buffer: mandiri },
    { name: "bca-7711-juni-2026.csv", mimeType: "text/csv", buffer: Buffer.from(toBcaCsv(juni)) },
  ]);

  // The locked PDF asks once.
  const pw = page.getByTestId("client-files-password");
  await expect(pw).toContainText("1 file terkunci.");
  await pw.getByLabel("Kata sandi PDF").fill(PASSWORD);
  await pw.getByRole("button", { name: "Buka", exact: true }).click();
  await expect(pw).toBeHidden();

  // One card: the company (named after the client until readers print holders) with both rekening read from the files.
  const card = page.getByTestId("client-proposal");
  await expect(card.getByTestId("proposal-entity")).toHaveCount(1);
  await expect(card.getByLabel("Nama perusahaan")).toHaveValue(new RegExp(`${NAME}$`));
  const accounts = card.getByTestId("proposal-account");
  await expect(accounts).toHaveCount(2);
  await expect(accounts.filter({ hasText: "BCA ·7711" })).toContainText("Jun–Jul 2026");
  await expect(accounts.filter({ hasText: "·5544" })).toContainText("Jul 2026");
  await card.getByRole("button", { name: "Buat klien & impor" }).click();

  // Unggah books the files at once (nothing left to ask): no card, no flag left in the URL.
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  const list = page.getByTestId("inbox-list");
  await expect(list).toContainText("3 file selesai: 3 dibukukan.", { timeout: 60_000 });
  await expect(list.locator('[data-testid="inbox-line"][data-status="BOOKED"]')).toHaveCount(3);
  await expect(page.getByTestId("inbox-confirm")).toHaveCount(0);
  expect(page.url()).not.toMatch(/lanjut=/);

  // Pengaturan klien: the company and both rekening exist, and the password is kept for next month.
  const base = new URL(page.url()).pathname.match(/\/clients\/[^/]+/)![0];
  await page.goto(`${base}/settings`);
  const entities = page.getByTestId("entities-card");
  await expect(entities).toContainText(NAME);
  await expect(entities).toContainText(BCA);
  await expect(entities).toContainText(MANDIRI);
  await expect(page.getByTestId("pdf-keyring")).toContainText("1 kata sandi tersimpan");
});

test("Tambah klien from files: nothing readable offers the manual form with the name kept", async ({ page }) => {
  const name = "Klien Tanpa Rekening Uji";
  await page.goto("/clients/new");
  await page.getByLabel("Nama klien").fill(name);
  await page.getByTestId("client-file-input").setInputFiles([{ name: "catatan.txt", mimeType: "text/plain", buffer: Buffer.from("Bukan rekening koran.") }]);
  const unread = page.getByTestId("client-files-unread");
  await expect(unread).toContainText("Tidak ada yang bisa dibaca dari file ini");
  await expect(page.getByTestId("client-proposal")).toHaveCount(0);
  await unread.getByRole("button", { name: "Isi manual" }).click();
  await expect(page).toHaveURL(/\/clients\/new\?manual=1$/);
  await expect(page.getByLabel("Nama klien")).toHaveValue(name);
  await expect(page.getByLabel("Nama lengkap").first()).toHaveValue(name);
  await expect(page.getByRole("button", { name: "Simpan klien" })).toBeVisible();
});
