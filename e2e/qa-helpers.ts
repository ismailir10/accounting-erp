import { readFileSync } from "node:fs";
import { expect, type Browser, type Page } from "@playwright/test";

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

/** The e2e accounts written by scripts/e2e-setup.ts. */
export const credentials = (file: string) => JSON.parse(readFileSync(`.playwright/${file}`, "utf8")) as { email: string; password: string };

/** A fresh browser context signed in through the real login form as the account in `.playwright/<file>`. */
export async function signIn(browser: Browser, baseURL: string | undefined, file: string): Promise<Page> {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  const { email, password } = credentials(file);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Kata sandi").fill(password);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Beranda", exact: true })).toBeVisible({ timeout: 30_000 });
  return page;
}

/**
 * Runs `check` as a Peninjau: the admin (`page`) makes the e2e AKUNTAN a Peninjau on Pengaturan → Tim, adding `client` to their clients
 * when it is one a spec created (e2e-setup assigns only the demo clients), and the AKUNTAN signs in. Restores role and clients after.
 */
export async function asPeninjau(page: Page, browser: Browser, baseURL: string | undefined, client: string | null, check: (viewer: Page) => Promise<void>) {
  const { email } = credentials("credentials-akuntan.json");
  const row = page.getByTestId("team-row").filter({ hasText: email });
  const setRole = async (label: string) => {
    await row.getByRole("combobox").click();
    await page.getByRole("option", { name: label }).click();
    await expect(page.getByText(`diubah menjadi ${label}`)).toBeVisible();
  };
  const toggleClient = async () => {
    await row.getByTestId("assign-clients").click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("div.flex").filter({ has: page.locator("label", { hasText: new RegExp(`^${client!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) }).getByRole("checkbox").click();
    await dialog.getByRole("button", { name: "Simpan" }).click();
    await expect(page.getByText(/Klien .* disimpan/)).toBeVisible();
  };
  await page.goto("/settings?tab=tim");
  if (client) await toggleClient();
  await setRole("Peninjau");
  const viewer = await signIn(browser, baseURL, "credentials-akuntan.json");
  try {
    await check(viewer);
  } finally {
    await viewer.context().close();
    await page.goto("/settings?tab=tim");
    await setRole("Akuntan");
    if (client) await toggleClient();
  }
}

/** The page does not scroll sideways at the current viewport (ui-rules: 390 px works). */
export const noSideScroll = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
