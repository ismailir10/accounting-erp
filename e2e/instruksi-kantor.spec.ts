import { expect, test, type Page } from "@playwright/test";
import { addClient, asPeninjau, nextAccount, noSideScroll, signIn, uploadStatement } from "./qa-helpers";

/**
 * Instruksi kantor (cycle 2026-10-18-instruksi-kantor): Pengaturan kantor → Instruksi.
 * - Flow 1 on the demo firm: the preview is read-only; its approval (and the Akuntan's client instruction of flow 3) is turned off again
 *   in `finally`, so the demo's later imports stay as seeded. Specs run one at a time (workers: 1).
 * - Flows 2 and 5 in e2e-setup's second organisation ("KAP Uji Lain", its ADMIN), on a client of its own, so the demo firm's rules never
 *   change under other specs.
 * - Flow 3: the e2e Akuntan (assigned the demo clients) and a Peninjau (`asPeninjau`); a crafted *Semua klien* approval by an Akuntan is
 *   refused at the action (tests/db/instruction-actions.test.ts).
 * - Flow 4: refusals, and no *Susun dengan AI* without a model (the e2e stack has no AI key; the precondition is asserted).
 */
const FIRM_SENTENCE = "biaya admin bank selalu 6190";
const AKUNTAN_SENTENCE = '"QA INSTRUKSI AKUNTAN" selalu 6190';
const toast = (page: Page, text: string) => expect(page.locator("[data-sonner-toast]").filter({ hasText: text }).first()).toBeVisible();

/** Types the sentence (and picks the scope by its exact name), then *Susun*. */
async function compile(page: Page, sentence: string, scope?: string) {
  const editor = page.getByTestId("instruction-editor");
  if (scope) {
    await editor.getByRole("combobox", { name: "Berlaku untuk" }).click();
    await page.getByRole("option", { name: scope, exact: true }).click();
  }
  await editor.getByLabel("Instruksi", { exact: true }).fill(sentence);
  await editor.getByRole("button", { name: "Susun", exact: true }).click();
}

/** *Setujui* on the preview shown, waiting for the action to return (its toast) and the editor to reset. */
async function approveShown(page: Page) {
  await page.getByTestId("instruction-approve").click();
  await toast(page, "Instruksi disetujui");
  await expect(page.getByTestId("instruction-preview")).toHaveCount(0);
}

/** The active rows holding `text` (an active row is the only one with *Matikan*). */
const activeRows = (page: Page, text: string) => page.getByTestId("instruction-row").filter({ hasText: text }).filter({ has: page.getByRole("button", { name: "Matikan", exact: true }) });

/** *Matikan* every active row holding `text`, through the confirm dialog. */
async function turnOffAll(page: Page, text: string) {
  await page.goto("/settings?tab=instruksi");
  await expect(page.getByTestId("instruction-list")).toBeVisible();
  while ((await activeRows(page, text).count()) > 0) {
    const before = await activeRows(page, text).count();
    await activeRows(page, text).first().getByRole("button", { name: "Matikan", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Matikan instruksi" }).click();
    await toast(page, "Instruksi dimatikan");
    await expect(activeRows(page, text)).toHaveCount(before - 1);
  }
}

test("Instruksi kantor on the demo: the preview offers the bank's abbreviation, Setujui is in Riwayat, the Akuntan and the Peninjau see what they may", async ({ page, browser, baseURL }) => {
  await turnOffAll(page, FIRM_SENTENCE); // a run that stopped half-way left nothing behind
  try {
    // Flow 1: the typed words match nothing; the hint BIAYA ADM does, in Grup Ayam and CV Sinar, all on 7100 today.
    await page.goto("/settings?tab=instruksi");
    await expect(page.getByRole("link", { name: "Instruksi", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("next-step")).toContainText("Tulis kebiasaan kantor dalam satu kalimat.");
    await compile(page, FIRM_SENTENCE);
    const preview = page.getByTestId("instruction-preview");
    await expect(preview).toContainText("Aturan akun · Disusun Buku");
    await expect(preview.getByTestId("instruction-notes")).toContainText('Belum ada mutasi yang memuat "BIAYA ADMIN BANK"');
    await preview.getByTestId("instruction-hints").getByRole("button", { name: "BIAYA ADM", exact: true }).click();
    await expect(preview.getByTestId("instruction-compiled")).toContainText('Mutasi keluar yang keterangannya memuat "BIAYA ADM" → 6190 Beban Umum Lain-lain');
    await expect(preview.getByTestId("instruction-notes")).toContainText("sekarang di akun lain (7100");
    await expect(preview.getByTestId("instruction-notes")).not.toContainText("Belum ada mutasi");
    const counts = preview.getByTestId("instruction-client-count");
    await expect(counts.filter({ hasText: "Grup Ayam Nusantara" })).toHaveCount(1);
    await expect(counts.filter({ hasText: "CV Sinar Retail" })).toHaveCount(1);
    await expect(preview.getByTestId("instruction-matched").getByRole("row").filter({ hasText: "BIAYA ADM" }).first()).toBeVisible();
    await expect(preview).toContainText("Menyetujui tidak mengubah mutasi yang sudah dicatat.");
    await page.setViewportSize({ width: 390, height: 844 });
    await noSideScroll(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // Setujui: Aktif, Disunting (the keyword was changed), with who and when; every client's Riwayat has the event.
    await approveShown(page);
    const row = activeRows(page, FIRM_SENTENCE);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Aturan akun · Semua klien");
    await expect(row).toContainText(/Disetujui .* oleh .* · Disunting/);
    await page.setViewportSize({ width: 390, height: 844 });
    await noSideScroll(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("link", { name: "Grup Ayam Nusantara", exact: true }).first().click();
    await page.waitForURL(/\/clients\/[^/]+/);
    const base = new URL(page.url()).pathname.match(/\/clients\/[^/]+/)![0];
    await page.goto(`${base}/history?kind=INSTRUCTION`);
    await expect(page.getByTestId("history-row").filter({ hasText: `Disetujui: "${FIRM_SENTENCE}" → Aturan akun: keluar, memuat "BIAYA ADM" → 6190` })).not.toHaveCount(0);
    await expect(page.getByTestId("history-row").first()).toContainText("Instruksi kantor");

    // Flow 3: the Akuntan sees the tab, writes for an assigned client, sees the Semua klien instruction without Matikan.
    const akuntan = await signIn(browser, baseURL, "credentials-akuntan.json");
    try {
      await akuntan.goto("/settings?tab=instruksi");
      await expect(akuntan.getByRole("link", { name: "Instruksi", exact: true })).toBeVisible();
      await expect(akuntan.getByRole("link", { name: "Tim", exact: true })).toHaveCount(0);
      const firmRow = akuntan.getByTestId("instruction-row").filter({ hasText: FIRM_SENTENCE }).filter({ hasText: "Semua klien" }).filter({ hasNotText: "Dimatikan" });
      await expect(firmRow).toBeVisible();
      await expect(firmRow.getByRole("button", { name: "Matikan", exact: true })).toHaveCount(0);
      await akuntan.getByTestId("instruction-editor").getByRole("combobox", { name: "Berlaku untuk" }).click();
      await expect(akuntan.getByRole("option", { name: "Semua klien", exact: true })).toHaveCount(0);
      await akuntan.keyboard.press("Escape");
      await compile(akuntan, AKUNTAN_SENTENCE, "PT Jasa Kreatif Digital");
      await expect(akuntan.getByTestId("instruction-compiled")).toContainText('"QA INSTRUKSI AKUNTAN" → 6190');
      await approveShown(akuntan);
      const own = activeRows(akuntan, AKUNTAN_SENTENCE);
      await expect(own).toHaveCount(1);
      await expect(own).toContainText("Aturan akun · PT Jasa Kreatif Digital");
      await turnOffAll(akuntan, AKUNTAN_SENTENCE);
    } finally {
      await akuntan.context().close();
    }

    // Flow 3: a Peninjau reads the list only — no editor, no Matikan.
    await asPeninjau(page, browser, baseURL, null, async (viewer) => {
      await viewer.goto("/settings?tab=instruksi");
      await expect(viewer.getByTestId("instruction-list")).toBeVisible();
      await expect(viewer.getByTestId("instruction-row").filter({ hasText: FIRM_SENTENCE }).filter({ hasNotText: "Dimatikan" })).toBeVisible();
      await expect(viewer.getByTestId("instruction-editor")).toHaveCount(0);
      await expect(viewer.getByRole("button", { name: "Matikan", exact: true })).toHaveCount(0);
      await viewer.setViewportSize({ width: 390, height: 844 });
      await noSideScroll(viewer);
    });
  } finally {
    // Matikan again: the demo's later imports stay as seeded.
    await turnOffAll(page, FIRM_SENTENCE);
    await turnOffAll(page, AKUNTAN_SENTENCE);
  }
});

test("Instruksi kantor: refusals in Bahasa, and no Susun dengan AI without a model", async ({ page }) => {
  // Precondition: this stack has no AI key (Pengaturan kantor says rules only).
  await page.goto("/settings");
  await expect(page.getByTestId("next-step")).toContainText("Usulan AI belum aktif");
  await page.goto("/settings?tab=instruksi");
  const editor = page.getByTestId("instruction-editor");
  const cases: [string, string][] = [
    ["akrualkan sewa Rp 5 jt setiap bulan", "Instruksi tidak membuat jurnal. Untuk jurnal berulang, pakai Jadwal di Jurnal Penyesuaian."],
    ["TRANSFER selalu 6190", 'Kata kunci "TRANSFER" tidak menyebut pengirim atau penerima, jadi tidak bisa dijadikan aturan.'],
    ["BIAYA ADM selalu 1999", "Akun 1999 tidak bisa menjadi tujuan aturan."],
    ["kalau ada yang aneh kabari saya", "Buku belum memahami kalimat ini."],
  ];
  for (const [sentence, error] of cases) {
    await compile(page, sentence);
    await expect(editor.getByTestId("instruction-error")).toHaveText(error);
    await expect(editor.getByTestId("instruction-patterns")).toContainText("Aturan akun: <kata kunci> selalu <akun> · Tandai: tandai pengeluaran > Rp10 jt · Tahan: <kata kunci> selalu ke Review");
    await expect(editor.getByRole("button", { name: "Susun dengan AI" })).toHaveCount(0);
    await expect(page.getByTestId("instruction-preview")).toHaveCount(0);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
});

test("Instruksi kantor in its own organisation: a rule, a Tandai and a Tahan act on the next import, Tutup Buku and Review; a duplicate is blocked", async ({ browser, baseURL }) => {
  const admin = await signIn(browser, baseURL, "credentials-other-firm.json");
  try {
    const name = `QA Instruksi ${Date.now()}`;
    const id = await addClient(admin, { name, account: nextAccount() });

    // Flow 2: four client instructions. (The PT MAJU JAYA rule comes from an Aturan akun here; DB tests cover a Review-made rule.)
    await admin.goto("/settings?tab=instruksi");
    for (const sentence of ['"BIAYA ADM" selalu 6190', "tandai pengeluaran > Rp10 jt", '"PT MAJU JAYA" selalu 6120', "PT MAJU JAYA selalu ke Review"]) {
      await compile(admin, sentence, name);
      await expect(admin.getByTestId("instruction-preview")).toBeVisible();
      await approveShown(admin);
    }
    await expect(admin.getByTestId("instruction-row").filter({ hasText: name })).toHaveCount(4);

    // Flow 5: the same Aturan akun again is blocked before Setujui; an edit makes the preview stale and a bad keyword says which field.
    await compile(admin, '"BIAYA ADM" selalu 6190', name);
    await expect(admin.getByTestId("instruction-blocked")).toContainText('Sudah ada instruksi aktif untuk kata kunci ini: ""BIAYA ADM" selalu 6190"');
    await expect(admin.getByTestId("instruction-approve")).toBeDisabled();
    await admin.getByTestId("instruction-preview").getByLabel("Kata kunci").fill("AB");
    await expect(admin.getByTestId("instruction-approve")).toBeDisabled();
    await admin.getByTestId("instruction-refresh").click();
    await expect(admin.getByTestId("instruction-preview")).toContainText("Kata kunci harus 3–60 karakter.");
    await expect(admin.getByTestId("instruction-approve")).toBeDisabled();
    await admin.getByRole("button", { name: "Batal", exact: true }).click();
    await expect(admin.getByTestId("instruction-row").filter({ hasText: name })).toHaveCount(4);

    // The next import: BIAYA ADM to 6190 with the instruction's reason, PT MAJU JAYA held, the Rp 25 jt line listed on Tutup Buku.
    const csv = [
      "Tanggal;Keterangan;Debet;Kredit;Saldo",
      "01/08/2026;SALDO AWAL;;;500.000.000,00",
      "03/08/2026;BIAYA ADM;15.000,00;0,00;499.985.000,00",
      "05/08/2026;TRSF E-BANKING DB PT ANGKASA RAYA;25.000.000,00;0,00;474.985.000,00",
      "06/08/2026;TRSF E-BANKING DB PT BUMI SENTOSA;10.000.000,00;0,00;464.985.000,00",
      "07/08/2026;TRSF E-BANKING DB PT MAJU JAYA;7.500.000,00;0,00;457.485.000,00",
      "",
    ].join("\n");
    await uploadStatement(admin, id, "instruksi.csv", csv);
    await expect(admin.getByTestId("import-result")).toContainText("Nyambung");
    await expect(admin.getByTestId("import-held")).toContainText("1 ditahan Otomasi kantor (instruksi kantor)");

    await admin.goto(`/clients/${id}/ledger/6190?period=2026-08`);
    await admin.getByTestId("ledger-row").filter({ hasText: "BIAYA ADM" }).click();
    await expect(admin.getByTestId("source-row")).toContainText('Instruksi kantor: keterangan memuat "BIAYA ADM"');

    await admin.goto(`/clients/${id}/review?period=2026-08`);
    await expect(admin.getByTestId("review-item").filter({ hasText: "PT MAJU JAYA" })).toContainText("Ditahan instruksi kantor");
    await admin.goto(`/clients/${id}/approvals?period=2026-08`);
    await expect(admin.getByTestId("approval-bank").filter({ hasText: "PT MAJU JAYA" })).toContainText("Ditahan instruksi kantor");
    await expect(admin.getByTestId("approve-confident")).toHaveCount(0);
    await admin.setViewportSize({ width: 390, height: 844 });
    await noSideScroll(admin);
    await admin.setViewportSize({ width: 1440, height: 900 });

    await admin.goto(`/clients/${id}/close?period=2026-08`);
    const flag = admin.getByTestId("control-instr");
    await expect(flag).toHaveCount(1);
    await expect(flag).toContainText("Pengeluaran di atas Rp 10.000.000");
    await expect(flag).toContainText("PT ANGKASA RAYA");
    await expect(flag).toContainText("Rp 25.000.000");
    await expect(flag).not.toContainText("PT BUMI SENTOSA");
    await flag.getByRole("button", { name: "Beri catatan" }).click();
    await admin.getByRole("dialog").getByRole("textbox").fill("Pembayaran kontrak gudang, bukti di folder klien.");
    await admin.getByRole("button", { name: "Simpan catatan" }).click();
    await expect(flag).toContainText("Pembayaran kontrak gudang");
    await expect(flag.getByRole("button", { name: "Ubah catatan" })).toBeVisible();

    // Pengaturan klien marks the instruction's rule, linked to it; Riwayat has one event per approval.
    await admin.goto(`/clients/${id}/settings?tab=klasifikasi`);
    const ruleLink = admin.getByTestId("rule-instruction").first();
    await expect(ruleLink).toHaveText("Instruksi kantor");
    await expect(ruleLink).toHaveAttribute("href", /\/settings\?tab=instruksi#instruksi-/);
    await admin.goto(`/clients/${id}/history?kind=INSTRUCTION`);
    await expect(admin.getByTestId("history-row")).toHaveCount(4);
  } finally {
    await admin.context().close();
  }
});
