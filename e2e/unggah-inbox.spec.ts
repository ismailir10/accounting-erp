import { expect, test } from "@playwright/test";
import { toBcaCsv, type StatementFile } from "../lib/demo/writers";
import { makePdf, table } from "../tests/pdf-fixture";
import { openClientForm } from "./qa-helpers";

/**
 * Unggah, verify flow 1 (docs/cycles/2026-10-10-unggah-inbox.md): a client with no rekening yet gets its files in one drop — two months of a
 * BCA giro and a locked Mandiri PDF. Buku asks the password once, lists the new rekening in one card, books every file oldest first, and the
 * lines stay after a reload. A fresh client and months before August 2026, so the demo's story and the investor walk are untouched.
 * Synthetic files only; rules-only mode (no AI key), so no AI line is expected.
 */
const BCA = "6044551270";
const MANDIRI = "1230007654321";
const PASSWORD = "Unggah2026";
const d = (day: number, month: number) => new Date(Date.UTC(2026, month - 1, day));
const bca = (month: number, opening: bigint, rows: StatementFile["rows"]): StatementFile => ({ bank: "BCA", accountNumber: BCA, holder: "PT Unggah Uji Sentosa", year: 2026, month, opening, rows });
const juni = bca(6, 50_000_000n, [
  { date: d(5, 6), description: "TRSF E-BANKING CR 0506/FTSCY/WS95031 CV PELANGGAN UJI", amount: 12_500_000n },
  { date: d(20, 6), description: "BIAYA ADM", amount: -15_000n },
]);
const juli = bca(7, 62_485_000n, [
  { date: d(3, 7), description: "TRSF E-BANKING DB 0307/FTSCY/WS95031 SEWA KANTOR UJI", amount: -5_000_000n },
  { date: d(31, 7), description: "BUNGA", amount: 100_000n },
]);
const mandiri = makePdf(
  [
    [
      ...table(800, [[[40, "PT Bank Mandiri (Persero) Tbk"]], [[40, `Nomor Rekening : ${MANDIRI}`]], [[40, "Periode : 01/07/2026 - 31/07/2026"]]]),
      ...table(740, [
        [[40, "Tanggal"], [130, "Keterangan"], [360, "Debit"], [440, "Kredit"], [520, "Saldo"]],
        [[40, "01/07/2026"], [130, "SALDO AWAL"], [500, "20.000.000,00"]],
        [[40, "07/07/2026"], [130, "TRANSFER DARI CV PELANGGAN UJI"], [430, "7.500.000,00"], [510, "27.500.000,00"]],
        [[40, "31/07/2026"], [130, "SALDO AKHIR"], [510, "27.500.000,00"]],
      ]),
    ],
  ],
  { userPassword: PASSWORD },
);

test("Unggah: a whole drop for a client without rekening — one password, one card, every file booked and kept", async ({ page }) => {
  // A client saved without a bank account (the empty bank row is ignored) lands on Unggah.
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Klien Unggah Uji");
  await page.getByLabel("Nama lengkap").fill("PT Unggah Uji Sentosa");
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  const base = new URL(page.url()).pathname.match(/\/clients\/[^/]+/)![0];

  // Drop the three files at once (newest first on purpose: Buku books the oldest period first).
  await page.getByTestId("inbox-file-input").setInputFiles([
    { name: "mandiri-4321-juli-2026.pdf", mimeType: "application/pdf", buffer: mandiri },
    { name: "bca-1270-juli-2026.csv", mimeType: "text/csv", buffer: Buffer.from(toBcaCsv(juli)) },
    { name: "bca-1270-juni-2026.csv", mimeType: "text/csv", buffer: Buffer.from(toBcaCsv(juni)) },
  ]);

  // The locked PDF asks its password once, in one field for the whole drop.
  const passwordCard = page.getByTestId("inbox-password");
  await expect(passwordCard).toContainText("1 file terkunci.");
  await passwordCard.getByLabel("Kata sandi PDF").fill(PASSWORD);
  await passwordCard.getByRole("button", { name: "Buka", exact: true }).click();

  // One card lists every new rekening read from the files, owned by the client's only company.
  const card = page.getByTestId("inbox-confirm");
  await expect(card.getByText("Rekening baru dari file")).toBeVisible();
  await expect(passwordCard).toBeHidden();
  const accounts = card.getByTestId("inbox-new-account");
  await expect(accounts).toHaveCount(2);
  await expect(accounts.filter({ hasText: "BCA ·1270" })).toContainText("Milik PT Unggah Uji Sentosa");
  await expect(accounts.filter({ hasText: "·4321" })).toContainText("Milik PT Unggah Uji Sentosa");
  await card.getByRole("button", { name: "Tambah & impor" }).click();

  // Every file's line ends booked, with what Buku did.
  const list = page.getByTestId("inbox-list");
  const lines = list.getByTestId("inbox-line");
  await expect(card).toBeHidden();
  await expect(list).toContainText("3 file selesai: 3 dibukukan.", { timeout: 60_000 });
  await expect(lines).toHaveCount(3);
  await expect(list.locator('[data-testid="inbox-line"][data-status="BOOKED"]')).toHaveCount(3);
  await expect(lines.filter({ hasText: "bca-1270-juni-2026.csv" })).toContainText("Dibukukan ke BCA ·1270 · Juni 2026 · 2 baris");
  await expect(lines.filter({ hasText: "bca-1270-juli-2026.csv" })).toContainText("Dibukukan ke BCA ·1270 · Juli 2026 · 2 baris");
  await expect(lines.filter({ hasText: "mandiri-4321-juli-2026.pdf" })).toContainText(/Dibukukan ke .*·4321 · Juli 2026/);
  await expect(list).not.toContainText("ada celah saldo");

  // The lines stay after a reload.
  await page.reload();
  await expect(list.getByText("Unggahan terakhir")).toBeVisible();
  await expect(list).toContainText("3 file selesai: 3 dibukukan.");
  await expect(list.locator('[data-testid="inbox-line"][data-status="BOOKED"]')).toHaveCount(3);
  await expect(page.getByTestId("inbox-password")).toHaveCount(0);
  await expect(page.getByTestId("inbox-confirm")).toHaveCount(0);

  // Pengaturan klien: both rekening were added from the files, and (as admin) the password is kept for the next drop.
  await page.goto(`${base}/settings`);
  const entities = page.getByTestId("entities-card");
  await expect(entities).toContainText(BCA);
  await expect(entities).toContainText(MANDIRI);
  await expect(page.getByTestId("pdf-keyring")).toContainText("1 kata sandi tersimpan");
});
