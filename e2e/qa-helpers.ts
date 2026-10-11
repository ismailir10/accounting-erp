import { expect, type Page } from "@playwright/test";

/** Shared by the qa-*.spec.ts regression specs (end-to-end QA of 2026-10-02, docs/qa). Synthetic data only. */
let account = 7_000_100_000;
/** A bank account number no other spec uses. */
export const nextAccount = () => String(++account);

/** Tambah klien's manual form (*Isi manual*): the page starts from the client's files (cycle 2026-10-10-new-client-from-files). */
export async function openClientForm(page: Page) {
  await page.goto("/clients/new?manual=1");
}

/** Tambah klien with one PT and one bank account; returns the client id (it lands on the import page). */
export async function addClient(page: Page, v: { name: string; entity?: string; account?: string; npwp?: string }): Promise<string> {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill(v.name);
  await page.getByLabel("Nama lengkap").fill(v.entity ?? `PT ${v.name}`);
  if (v.npwp) await page.getByLabel(/^NPWP/).fill(v.npwp);
  await page.getByLabel("Nomor rekening").fill(v.account ?? nextAccount());
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  return page.url().match(/clients\/([^/]+)\//)![1];
}

/**
 * Opens the single-file forms on the Unggah page (statement import with its rekening select, *Atur kolom*, scans; ledger import). They
 * live under the *Cara lain* tab, which is not the default and only mounts when chosen. Call it on the Unggah page.
 */
export async function openManualImport(page: Page) {
  await page.getByRole("tab", { name: "Cara lain", exact: true }).click();
  await expect(page.getByTestId("ledger-file-input")).toBeAttached();
}

/** Choose a statement file on the client's import page (*Cara lain*) and process it. Does not assert the outcome. */
export async function uploadStatement(page: Page, clientId: string, name: string, data: string | Buffer, mimeType = "text/csv") {
  await page.goto(`/clients/${clientId}/import`);
  await openManualImport(page);
  await page.getByTestId("file-input").setInputFiles({ name, mimeType, buffer: Buffer.from(data) });
  await page.getByRole("button", { name: "Proses mutasi" }).click();
}

/** A BRI internet-banking CSV (`NOREK;…`), which keeps zero-amount lines. */
export const briCsv = (number: string, rows: string[]) => ["NOREK;" + number, "NAMA;PT UJI", "TGL_TRAN;DESK_TRAN;MUTASI_DEBET;MUTASI_KREDIT;SALDO_AKHIR_MUTASI", ...rows, ""].join("\n");
