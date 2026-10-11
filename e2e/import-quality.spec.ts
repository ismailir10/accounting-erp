import ExcelJS from "exceljs";
import { expect, test } from "@playwright/test";

/**
 * Import quality (docs/cycles/2026-10-11-import-quality.md): what the production walk of #149 found, walked locally with synthetic
 * workbooks shaped like the real files. A Neraca names its company in its title; a multi-entity, multi-sheet workbook becomes one company
 * per entity and one draft per sheet; a client with only a Neraca opens its reports on the Neraca's month. Dates before August 2026, so
 * the investor walk's work period is untouched. Rules-only mode (no AI key).
 */
type Cell = string | number | Date | null;
async function workbook(sheets: Record<string, Cell[][]>) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const NERACA = (company: string): Cell[][] => [
  [company], ["Balance Sheet"], ["31/05/2026"], ["(in IDR)"], ["Date", null, "31/05/2026"],
  ["Assets"], ["Current Assets"], ["1-1000", "BANK", 900], ["Total Current Assets", null, 900], ["Other Assets"], ["1-1810", "Intangible Assets", 100], ["Total Assets", null, 1000],
  ["Liability & Equity"], ["Current Liability"], ["2-2000", "Accounts Payable", 200], ["2-2100", "Loan from Bank", 100], ["Total Current Liability", null, 300],
  ["Long-term Liability"], ["2-2744", "Others Payables-Related Parties", 400], ["2-2783", "Employee Benefits Liabilities", 50], ["Total Long-term Liability", null, 450],
  ["Equity"], ["3-3000", "Share Capital", 250], ["Total Liability & Equity", null, 1000],
];
const GL = (entities: string[]): Cell[][] => [
  ["Entity", "Entry Date", "Account Code", "Account Name", "Currency", "Debit", "Credit"],
  ...entities.flatMap((e, i): Cell[][] => [
    [e, new Date(Date.UTC(2024, 0, 10 + i)), "10000", "Kas", "IDR", 1000, 0],
    [e, new Date(Date.UTC(2024, 0, 10 + i)), "31001", "Modal Saham", "IDR", 0, 1000],
  ]),
];

test("a Neraca names its company; its reports open on the Neraca's month", async ({ page }) => {
  await page.goto("/clients/new");
  await page.getByLabel("Nama klien").fill("Klien Neraca Uji");
  await page.getByTestId("client-file-input").setInputFiles({ name: "balance_sheet_31-05-2026.xlsx", mimeType: XLSX, buffer: await workbook({ "31-05-2026": NERACA("SANRAYA UJI NATTAYA") }) });

  const card = page.getByTestId("client-proposal");
  await expect(card.getByLabel("Nama perusahaan")).toHaveValue("Sanraya Uji Nattaya");
  await card.getByRole("button", { name: "Buat klien & impor" }).click();

  // The Neraca is a draft to map: accept the rule suggestions, book it.
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  await expect(page.getByTestId("inbox-list")).toContainText("Draf buku besar siap dipetakan.", { timeout: 60_000 });
  await page.getByRole("link", { name: "Petakan akun" }).click();
  await page.getByRole("button", { name: /^Terima \d+ saran aturan/ }).click();
  await page.getByRole("button", { name: "Catat 1 jurnal" }).click();
  await expect(page.getByText("Tercatat", { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // Reports open on Mei 2026 (the Neraca's month), not today's empty month.
  const base = new URL(page.url()).pathname.match(/\/clients\/[^/]+/)![0];
  await page.goto(`${base}/reports`);
  await expect(page.getByRole("combobox", { name: "Periode" })).toContainText("Mei 2026");
  await expect(page.getByText("Oktober 2026")).toHaveCount(0);
});

test("a multi-entity workbook proposes a company per entity and stages a draft per sheet", async ({ page }) => {
  await page.goto("/clients/new");
  await page.getByLabel("Nama klien").fill("Klien Grup Uji");
  const data = await workbook({ "04_HC_NERACA": NERACA("GRUP UJI"), "10_HC_GL": GL(["HOLDX"]), "20_OPCO_GL": GL(["SKPX", "SPNX", "CSPX"]) });
  await page.getByTestId("client-file-input").setInputFiles({ name: "grup-uji.xlsx", mimeType: XLSX, buffer: data });

  const card = page.getByTestId("client-proposal");
  await expect(card.getByTestId("proposal-entity")).toHaveCount(4);
  await expect(card.getByLabel("Nama perusahaan").nth(0)).toHaveValue("HOLDX");
  await card.getByRole("button", { name: "Buat klien & impor" }).click();

  // No "Gagal": two ledger sheets staged as drafts; the Neraca waits until they are booked (its opening bridge is checked then).
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  const list = page.getByTestId("inbox-list");
  await expect(list).toContainText("2 draf buku besar siap dipetakan: 10_HC_GL, 20_OPCO_GL.", { timeout: 60_000 });
  await expect(list).toContainText("04_HC_NERACA: neraca dibukukan sesudah buku besarnya");
  await expect(list).not.toContainText("Gagal");

  // Both drafts are listed with their sheets; the first opens with every entity matched to its company.
  await page.getByRole("tab", { name: "Riwayat" }).click();
  await expect(page.getByText("10_HC_GL").first()).toBeVisible();
  await expect(page.getByText("20_OPCO_GL").first()).toBeVisible();
});

test("mapping says when a Neraca balance sits on the wrong side of the account it is mapped to", async ({ page }) => {
  await page.goto("/clients/new");
  await page.getByLabel("Nama klien").fill("Klien Saldo Uji");
  // A receivable carrying a credit (negative) balance in the Neraca of "SALDO UJI ABADI".
  const neraca = NERACA("SALDO UJI ABADI").map((r): Cell[] => (r[0] === "1-1000" ? ["1-1000", "BANK", 1500] : r[0] === "1-1810" ? ["1-1200", "Account Receivable", -500] : r));
  await page.getByTestId("client-file-input").setInputFiles({ name: "neraca-saldo.xlsx", mimeType: XLSX, buffer: await workbook({ "31-05-2026": neraca }) });
  await page.getByTestId("client-proposal").getByRole("button", { name: "Buat klien & impor" }).click();
  await expect(page.getByTestId("inbox-list")).toContainText("Draf buku besar siap dipetakan.", { timeout: 60_000 });
  await page.getByRole("link", { name: "Petakan akun" }).click();
  // The receivable (a debit-normal asset) carries a Rp 500 credit: said on its row; the bank row is quiet.
  const hint = page.getByTestId("balance-against-nature");
  await expect(hint).toHaveCount(1);
  await expect(hint).toContainText("Rp 500 di sisi kredit");
});
