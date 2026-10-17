import { expect, test, type Page } from "@playwright/test";
import { asPeninjau, nextAccount, noSideScroll, openClientForm, openManualImport, signIn } from "./qa-helpers";

/**
 * Otomasi kantor (cycle 2026-10-17-otomasi): the firm's automation dial and flux thresholds on Pengaturan kantor.
 * - Flows 1, 2 and 5 run in an organisation of their own (e2e-setup's "KAP Uji Lain", its ADMIN), so the demo firm's dial never
 *   changes under other specs; that firm outlives a run, so its dial is put back to the defaults at the end.
 * - Flow 3 changes the demo firm's flux thresholds (specs run one at a time) and restores the defaults in `finally`.
 * - Flow 4: Akuntan and Peninjau read the dial with no control (a crafted call is refused: tests/db/settings-actions.test.ts).
 */
const ENTITY = "PT Otomasi Uji Sentosa";
const csv = (opening: string, ...rows: string[]) => ["Tanggal;Keterangan;Debet;Kredit;Saldo", `01/08/2026;SALDO AWAL;;;${opening}`, ...rows, ""].join("\n");
const FIRST = csv(
  "500.000.000,00",
  "03/08/2026;BIAYA ADM;15.000,00;0,00;499.985.000,00",
  "04/08/2026;BIAYA TXN;6.500,00;0,00;499.978.500,00",
  `06/08/2026;PINDAH BUKU KE MANDIRI ${ENTITY.toUpperCase()};150.000.000,00;0,00;349.978.500,00`,
  "07/08/2026;TRSF E-BANKING DB TOKO SINAR TERANG;2.000.000,00;0,00;347.978.500,00",
);
const SECOND = csv("0,00", `06/08/2026;PINDAH BUKU DARI BCA ${ENTITY.toUpperCase()};0,00;150.000.000,00;150.000.000,00`);

type Dial = { transfer?: boolean; rules?: boolean; memory?: boolean; cap?: string; fluxFloor?: string; fluxPercent?: string };
const DEFAULTS: Required<Dial> = { transfer: true, rules: true, memory: true, cap: "", fluxFloor: "", fluxPercent: "50" };

/** Sets the Otomasi card to `dial` (unnamed fields at their defaults) and saves when anything differs. */
async function setDial(page: Page, dial: Dial) {
  const want = { ...DEFAULTS, ...dial };
  await page.goto("/settings");
  const card = page.getByTestId("automation-card");
  for (const [key, label] of [["transfer", "Transfer antar rekening"], ["rules", "Aturan"], ["memory", "Pilihan yang diingat"]] as const) {
    const box = card.getByRole("checkbox", { name: label, exact: true });
    if (((await box.getAttribute("aria-checked")) === "true") !== want[key]) await box.click();
  }
  await card.getByLabel("Batas nominal").fill(want.cap);
  await card.getByLabel("Selisih minimal (Rp)").fill(want.fluxFloor);
  await card.getByLabel("Perubahan minimal (%)").fill(want.fluxPercent);
  const save = card.getByTestId("automation-save");
  if (await save.isEnabled()) {
    await save.click();
    await expect(page.getByText(/Otomasi kantor disimpan|Tidak ada perubahan/).first()).toBeVisible();
    await expect(save).toBeDisabled();
  }
}

/** Tambah klien (*Isi manual*) with one PT and two bank accounts; returns the client id. */
async function addClientWithTwoAccounts(page: Page, name: string, accounts: [string, string]) {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill(name);
  await page.getByLabel("Nama lengkap").fill(ENTITY);
  await page.getByLabel("Nomor rekening").fill(accounts[0]);
  await page.getByRole("button", { name: "Tambah rekening" }).click();
  await page.getByLabel("Nomor rekening").nth(1).fill(accounts[1]);
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  return page.url().match(/clients\/([^/]+)\//)![1];
}

/** *Cara lain* → the statement form, on the chosen rekening. */
async function importTo(page: Page, clientId: string, account: string, name: string, data: string) {
  await page.goto(`/clients/${clientId}/import`);
  await openManualImport(page);
  await page.getByRole("combobox", { name: "Rekening", exact: true }).click();
  await page.getByRole("option", { name: new RegExp(account) }).click();
  await page.getByTestId("file-input").setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(data) });
  await page.getByRole("button", { name: "Proses mutasi" }).click();
  await expect(page.getByTestId("import-result")).toContainText("Nyambung");
}

test("Otomasi: an admin holds rule lines and large amounts; held lines wait in Review and Kotak; every change is in Riwayat", async ({ browser, baseURL }) => {
  const admin = await signIn(browser, baseURL, "credentials-other-firm.json");
  try {
    const accounts: [string, string] = [nextAccount(), nextAccount()];
    const id = await addClientWithTwoAccounts(admin, `QA Otomasi ${Date.now()}`, accounts);

    // Flow 1: Aturan off and a cap of Rp 100.000.000, saved with a toast, the last change on the card and the diff in Riwayat.
    await admin.goto("/settings");
    const card = admin.getByTestId("automation-card");
    await expect(card).toContainText("Usulan AI dan tebakan selalu menunggu persetujuan Anda.");
    await expect(card.getByRole("checkbox", { name: "Usulan AI", exact: true })).toBeDisabled();
    await expect(card).toContainText("selalu menunggu persetujuan");
    await expect(card).toContainText("Berlaku untuk impor berikutnya. Mutasi yang sudah dicatat atau menunggu di Review tidak diubah.");
    const save = card.getByTestId("automation-save");
    await expect(save).toBeDisabled();
    await card.getByRole("checkbox", { name: "Aturan", exact: true }).click();
    await card.getByLabel("Batas nominal").fill("100.000.000");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(admin.getByText("Otomasi kantor disimpan")).toBeVisible();
    await expect(card.getByTestId("automation-last")).toContainText(/Terakhir diubah .* oleh Admin firma lain/);
    await expect(card.getByLabel("Batas nominal")).toHaveValue("100.000.000");
    await admin.setViewportSize({ width: 390, height: 844 });
    await noSideScroll(admin);
    await admin.setViewportSize({ width: 1440, height: 900 });

    await admin.goto(`/clients/${id}/history?kind=AUTOMATION`);
    const rows = admin.getByTestId("history-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Aturan: langsung dicatat → ke Review; Batas nominal: tanpa batas → Rp 100.000.000");
    await expect(rows.first()).toContainText("Otomasi kantor");

    // Flow 5: invalid input says which field and saves nothing (no second Riwayat event).
    await admin.goto("/settings");
    for (const bad of ["abc", "0", "1234567890123456"]) {
      await card.getByLabel("Batas nominal").fill(bad);
      await save.click();
      await expect(card.getByText("Isi nominal Rupiah lebih dari 0, atau kosongkan.")).toBeVisible();
    }
    await card.getByLabel("Batas nominal").fill("100.000.000");
    await card.getByLabel("Perubahan minimal (%)").fill("0");
    await save.click();
    await expect(card.getByText("Isi persentase bulat dari 1 sampai 1000.")).toBeVisible();
    await admin.reload();
    await expect(card.getByLabel("Batas nominal")).toHaveValue("100.000.000");
    await expect(card.getByLabel("Perubahan minimal (%)")).toHaveValue("50");
    await admin.goto(`/clients/${id}/history?kind=AUTOMATION`);
    await expect(rows).toHaveCount(1);

    // Flow 2: the rule lines and the Rp 150 jt own transfer wait; the simple guess waits as always and is not the dial's.
    await importTo(admin, id, accounts[0], "otomasi-bca.csv", FIRST);
    const result = admin.getByTestId("import-result");
    await expect(admin.getByTestId("import-held")).toContainText("3 ditahan Otomasi kantor (batas nominal, aturan dimatikan)");
    await expect(result).toContainText("langsung dijurnal");
    await importTo(admin, id, accounts[1], "otomasi-mandiri.csv", SECOND);
    await expect(admin.getByTestId("import-held")).toContainText("1 ditahan Otomasi kantor (batas nominal)");

    await admin.goto(`/clients/${id}/review?period=2026-08`);
    const items = admin.getByTestId("review-item");
    await expect(items).toHaveCount(5);
    await expect(items.filter({ hasText: "BIAYA ADM" })).toContainText("Otomasi aturan dimatikan di Pengaturan kantor.");
    await expect(items.filter({ hasText: "PINDAH BUKU" })).toHaveCount(2);
    for (const half of await items.filter({ hasText: "PINDAH BUKU" }).all()) await expect(half).toContainText("Di atas batas otomasi (Rp 100.000.000)");
    await expect(items.filter({ hasText: "PINDAH BUKU DARI" })).toContainText("pasangan ditemukan");

    // Kotak: all five are there, none in the AI-only bulk accept; Setujui on a held rule line posts its RECLASS.
    await admin.goto(`/clients/${id}/approvals?period=2026-08`);
    const bank = admin.getByTestId("approval-bank");
    await expect(bank).toHaveCount(5);
    await expect(admin.getByTestId("approve-confident")).toHaveCount(0);
    await expect(bank.filter({ hasText: "BIAYA ADM" })).toContainText("Otomasi aturan dimatikan");
    await admin.setViewportSize({ width: 390, height: 844 });
    await noSideScroll(admin);
    await admin.setViewportSize({ width: 1440, height: 900 });
    await bank.filter({ hasText: "BIAYA ADM" }).getByRole("button", { name: "Setujui" }).click();
    await expect(bank.filter({ hasText: "BIAYA ADM" })).toHaveCount(0);
    await admin.goto(`/clients/${id}/journals?period=2026-08`);
    await expect(admin.getByTestId("entry-origin").filter({ hasText: "Aturan 7100 disetujui" })).toHaveCount(1);

    // Flow 4 (edge): Aturan back on posts nothing already waiting.
    await setDial(admin, { cap: "100.000.000" });
    await admin.goto(`/clients/${id}/review?period=2026-08`);
    await expect(items.filter({ hasText: "BIAYA TXN" })).toContainText("Otomasi aturan dimatikan");
    await expect(items).toHaveCount(4);
  } finally {
    await setDial(admin, {});
    await admin.context().close();
  }
});

test("Otomasi: Akuntan and Peninjau read the dial with no input and no Simpan", async ({ page, browser, baseURL }) => {
  const readOnly = async (p: Page) => {
    await p.goto("/settings");
    const card = p.getByTestId("automation-card");
    await expect(card.getByTestId("automation-readonly")).toBeVisible();
    await expect(card).toContainText("Diatur oleh admin kantor.");
    await expect(card).toContainText("Aturan");
    await expect(card).toContainText("langsung dicatat");
    await expect(card).toContainText("Batas nominal");
    await expect(card).toContainText("Perubahan minimal");
    await expect(card.getByRole("textbox")).toHaveCount(0);
    await expect(card.getByRole("checkbox")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Simpan" })).toHaveCount(0);
    await p.setViewportSize({ width: 390, height: 844 });
    await noSideScroll(p);
    await p.setViewportSize({ width: 1440, height: 900 });
  };
  const akuntan = await signIn(browser, baseURL, "credentials-akuntan.json");
  try {
    await readOnly(akuntan);
  } finally {
    await akuntan.context().close();
  }
  await asPeninjau(page, browser, baseURL, null, readOnly);
});

test("Ambang fluktuasi: PT Jasa Kreatif Digital's July 6170 leaves Wawasan and the flux control together, and returns at the defaults", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "PT Jasa Kreatif Digital", exact: true }).first().click();
  await page.waitForURL(/\/clients\/[^/]+/);
  const base = new URL(page.url()).pathname.match(/\/clients\/[^/]+/)![0];
  const hint = page.getByTestId("flux-thresholds");
  /** Whether Wawasan marks July's 6170 *Melewati ambang* (it may drop out of the movers once unflagged). */
  const marked = async () => {
    await page.goto(`${base}/analysis?period=2026-07&tab=wawasan`);
    await expect(hint).toBeVisible();
    return page.getByTestId("mover-6170").filter({ hasText: "Melewati ambang" });
  };
  /** The Tutup Buku flux control of July naming 6170 (no row at all when nothing is flagged). */
  const listed = async () => {
    await page.goto(`${base}/close?period=2026-07`);
    await expect(page.getByRole("heading", { name: "Tutup Buku", exact: true })).toBeVisible();
    return page.locator("main").getByTestId("control-flux").filter({ hasText: "6170" });
  };
  try {
    // At the defaults: 6170 (+52 %, Δ Rp 5.983.334) is over both thresholds, on Wawasan and on Tutup Buku.
    await expect(await marked()).toHaveCount(1);
    await expect(hint).toContainText("≥ 50 % dari rata-rata akunnya");
    await expect(hint).not.toContainText("minimal Rp");
    await expect(hint.getByRole("link", { name: "Pengaturan kantor" })).toHaveAttribute("href", "/settings");
    await expect(await listed()).toHaveCount(1);

    await setDial(page, { fluxPercent: "60" });
    await expect(await marked()).toHaveCount(0);
    await expect(hint).toContainText("≥ 60 % dari rata-rata akunnya");
    await expect(await listed()).toHaveCount(0);

    await setDial(page, { fluxFloor: "6.000.000" });
    await expect(await marked()).toHaveCount(0);
    await expect(hint).toContainText("minimal Rp 6.000.000");
    await page.setViewportSize({ width: 390, height: 844 });
    await noSideScroll(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(await listed()).toHaveCount(0);

    await setDial(page, {});
    await expect(await marked()).toHaveCount(1);
    await expect(await listed()).toHaveCount(1);
  } finally {
    await setDial(page, {});
  }
});
