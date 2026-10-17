import { expect, test, type Page } from "@playwright/test";
import { credentials, noSideScroll, openClientForm, signIn } from "./qa-helpers";

/**
 * Persetujuan kedua (cycle 2026-10-18-persetujuan-kedua), flows 1–5 on e2e-setup's second organisation (*KAP Uji Lain*: its ADMIN
 * "Admin firma lain", a second ADMIN "Admin kedua lain" and an AKUNTAN "Akuntan firma lain"), on a QA client of its own that the spec
 * deletes at the end, so the demo firm's settings and books never change under other specs. The firm card is put back to all off in
 * `finally` (the firm outlives a run).
 * - A crafted approve of the Admin's own journal by the Akuntan, the 4 × 4 approver matrix, double clicks and an approval the writer
 *   refuses (a *Balik otomatis* month closed meanwhile: the lock itself refuses that while the journal waits, so the browser can't reach
 *   it) are asserted in tests/db/second-approval.test.ts and tests/db/period-lock.test.ts; here the browser shows who may act.
 */
const CLIENT = `QA Persetujuan Kedua ${Date.now()}`;
const ADMIN = "Admin firma lain";
const ADMIN2 = "Admin kedua lain";
const AKUNTAN = "Akuntan firma lain";
const SIGNOFFS = ["Bukti pendukung transaksi besar sudah diperiksa", "Jurnal penyesuaian (penyusutan, akrual) sudah dicatat", "Laporan keuangan sudah direview partner"];

type Card = { manual: boolean; manualAbove: string; aiDraft: boolean; aiDraftAbove: string; reopen: boolean };
const OFF: Card = { manual: false, manualAbove: "", aiDraft: false, aiDraftAbove: "", reopen: false };

/** Sets the Persetujuan kedua card and saves when anything differs; waits for the save before going on. */
async function setCard(page: Page, want: Card) {
  await page.goto("/settings");
  const card = page.getByTestId("approvals-card");
  for (const [key, label] of [["manual", "Jurnal manual"], ["aiDraft", "Draf AI"], ["reopen", "Buka kembali bulan"]] as const) {
    const box = card.getByRole("checkbox", { name: label, exact: true });
    if (((await box.getAttribute("aria-checked")) === "true") !== want[key]) await box.click();
  }
  for (const [key, id] of [["manualAbove", "approval-manualAbove"], ["aiDraftAbove", "approval-aiDraftAbove"]] as const) {
    const input = card.locator(`#${id}`);
    if (await input.isEnabled()) await input.fill(want[key]);
  }
  const save = card.getByTestId("approvals-save");
  if (await save.isEnabled()) {
    await save.click();
    await expect(page.getByText(/Persetujuan kedua disimpan|Tidak ada perubahan/).first()).toBeVisible();
    await expect(save).toBeDisabled();
  }
}

async function pickOption(page: Page, label: string, name: RegExp) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

/** Fills Jurnal Penyesuaian (6190 / 2150) for 31 July; does not save. */
async function fillAccrual(page: Page, base: string, memo: string, amount: string, reverse = false) {
  await page.goto(`${base}/journals/new?period=2026-07`);
  await page.getByLabel("Tanggal", { exact: true }).fill("2026-07-31");
  await page.getByLabel("Keterangan", { exact: true }).fill(memo);
  await pickOption(page, "Akun baris 1", /^6190 /);
  await page.getByLabel("Debit baris 1", { exact: true }).fill(amount);
  await pickOption(page, "Akun baris 2", /^2150 /);
  await page.getByLabel("Kredit baris 2", { exact: true }).fill(amount);
  if (reverse) await page.getByRole("checkbox", { name: /^Balik otomatis pada 1 Agustus 2026/ }).click();
}

const second = (page: Page, memo: string) => page.getByTestId("approval-second").filter({ hasText: memo });

test("Persetujuan kedua: the firm card, a large accrual approved by another member, the lock held, a reopen confirmed by a second admin", async ({ browser, baseURL }) => {
  test.setTimeout(360_000);
  const admin = await signIn(browser, baseURL, "credentials-other-firm.json");
  let base = "";
  try {
    // A QA client of its own (no bank account: nothing to upload), held by the firm's Akuntan.
    await openClientForm(admin);
    await admin.getByLabel("Nama klien").fill(CLIENT);
    await admin.getByLabel("Nama lengkap").fill("PT QA Persetujuan");
    await admin.getByLabel("Nama singkat").fill("QAPK");
    await admin.getByRole("button", { name: "Hapus rekening" }).click();
    await admin.getByRole("button", { name: "Simpan klien" }).click();
    await expect(admin.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
    base = new URL(admin.url()).pathname.replace(/\/import.*$/, "");
    await admin.goto("/settings?tab=tim");
    await admin.getByTestId("team-row").filter({ hasText: credentials("credentials-other-akuntan.json").email }).getByTestId("assign-clients").click();
    const dialog = admin.getByRole("dialog");
    await dialog.locator("div.flex").filter({ has: admin.locator("label", { hasText: new RegExp(`^${CLIENT}$`) }) }).getByRole("checkbox").click();
    await dialog.getByRole("button", { name: "Simpan" }).click();
    await expect(admin.getByText(/Klien .* disimpan/)).toBeVisible();

    // Flow 5 (card): "abc" or 0 as a threshold is refused with the field message and nothing is saved.
    await admin.goto("/settings");
    const card = admin.getByTestId("approvals-card");
    await expect(card).toContainText("Jurnal besar dan pembukaan kembali bulan perlu disetujui anggota lain sebelum mengubah buku.");
    await card.getByRole("checkbox", { name: "Jurnal manual", exact: true }).click();
    await card.locator("#approval-manualAbove").fill("abc");
    await card.getByTestId("approvals-save").click();
    await expect(card).toContainText("Isi nominal Rupiah lebih dari 0, atau kosongkan.");
    await card.locator("#approval-manualAbove").fill("0");
    await card.getByTestId("approvals-save").click();
    await expect(card).toContainText("Isi nominal Rupiah lebih dari 0, atau kosongkan.");
    await admin.reload();
    await expect(admin.getByTestId("approvals-card").getByRole("checkbox", { name: "Jurnal manual", exact: true })).toHaveAttribute("aria-checked", "false");

    // Flow 1: Jurnal manual above Rp 100.000.000, Draf AI above Rp 50.000.000, Buka kembali bulan; the toast, the last change, Riwayat.
    await setCard(admin, { manual: true, manualAbove: "100.000.000", aiDraft: true, aiDraftAbove: "50.000.000", reopen: true });
    await expect(admin.getByTestId("approvals-last")).toContainText(`oleh ${ADMIN}`);
    await expect(admin.getByTestId("approvals-single-admin")).toHaveCount(0); // two active admins
    await admin.setViewportSize({ width: 390, height: 844 });
    await noSideScroll(admin);
    await admin.setViewportSize({ width: 1440, height: 900 });
    await admin.goto(`${base}/history?kind=APPROVAL`);
    await expect(admin.getByTestId("history-row").filter({ hasText: "Jurnal manual: tanpa persetujuan → di atas Rp 100.000.000" })).toHaveCount(1);
    await admin.goto(`${base}/journals?period=2026-07`);
    await expect(admin.getByText("Belum ada jurnal di Juli 2026.")).toBeVisible();

    // Flow 2: the Akuntan's Rp 150.000.000 accrual with Balik otomatis waits; nothing reaches Jurnal Umum.
    const akuntan = await signIn(browser, baseURL, "credentials-other-akuntan.json");
    try {
      await fillAccrual(akuntan, base, "Akrual bonus Juli", "150.000.000", true);
      await expect(akuntan.getByTestId("journal-second-notice")).toHaveText("Di atas Rp 100.000.000: jurnal ini menunggu persetujuan anggota lain sebelum dicatat.");
      await akuntan.getByRole("button", { name: "Ajukan persetujuan", exact: true }).click();
      await expect(akuntan.getByText("Jurnal menunggu persetujuan", { exact: true })).toBeVisible();
      await expect(akuntan.getByTestId("journal-waiting").filter({ hasText: "Akrual bonus Juli" })).toContainText("Menunggu persetujuan");
      await akuntan.goto(`${base}/journals?period=2026-07`);
      await expect(akuntan.getByText("Belum ada jurnal di Juli 2026.")).toBeVisible();
      // Kotak: the maker may only withdraw.
      await akuntan.goto(`${base}/approvals?period=2026-07&jenis=kedua`);
      const mine = second(akuntan, "Akrual bonus Juli");
      await expect(mine).toContainText(`Diajukan ${AKUNTAN}`);
      await expect(mine).toContainText("di atas Rp 100.000.000");
      await expect(mine.getByRole("button", { name: "Tarik kembali", exact: true })).toBeVisible();
      await expect(mine.getByRole("button", { name: "Setujui & catat", exact: true })).toHaveCount(0);
      await expect(mine.getByTestId("second-waiting")).toHaveText("Menunggu Akuntan lain, Admin atau Pemilik");
      await akuntan.setViewportSize({ width: 390, height: 844 });
      await noSideScroll(akuntan);
      await akuntan.setViewportSize({ width: 1440, height: 900 });

      // The Admin approves: the entry and its 1 August reversal, both "Diajukan … · Disetujui …", and both steps in Riwayat.
      await admin.goto(`${base}/approvals?period=2026-07&jenis=kedua`);
      await second(admin, "Akrual bonus Juli").getByRole("button", { name: "Setujui & catat", exact: true }).click();
      await expect(admin.getByText("Jurnal disetujui dan dicatat", { exact: true })).toBeVisible();
      await expect(second(admin, "Akrual bonus Juli")).toHaveCount(0);
      await admin.goto(`${base}/journals?period=2026-07`);
      const july = admin.getByTestId("journal-entry").filter({ hasText: "Akrual bonus Juli" });
      await expect(july.getByTestId("entry-posted-by")).toContainText(`Diajukan ${AKUNTAN} · Disetujui ${ADMIN}`);
      await admin.goto(`${base}/journals?period=2026-08`);
      await expect(admin.getByTestId("journal-entry").filter({ hasText: "Pembalik: Akrual bonus Juli" }).getByTestId("entry-posted-by")).toContainText(`Diajukan ${AKUNTAN} · Disetujui ${ADMIN}`);
      await admin.goto(`${base}/history?kind=APPROVAL`);
      await expect(admin.getByTestId("history-row").filter({ hasText: /Akrual bonus Juli.* diajukan untuk persetujuan kedua/ })).toHaveCount(1);
      await expect(admin.getByTestId("history-row").filter({ hasText: /Akrual bonus Juli.* disetujui dan dicatat dengan jurnal pembalik 1 Agu 2026/ })).toHaveCount(1);

      // Rp 100.000.000 is not above the threshold: it posts at once.
      await fillAccrual(akuntan, base, "Akrual sewa Juli", "100.000.000");
      await expect(akuntan.getByTestId("journal-second-notice")).toHaveCount(0);
      await akuntan.getByRole("button", { name: "Simpan jurnal", exact: true }).click();
      await expect(akuntan.getByText("Jurnal penyesuaian tersimpan", { exact: true })).toBeVisible();

      // Flow 4: the Admin's own journal waits for another admin; the Akuntan sees who it waits for and no buttons.
      await fillAccrual(admin, base, "Akrual admin Juli", "200.000.000");
      await admin.getByRole("button", { name: "Ajukan persetujuan", exact: true }).click();
      await expect(admin.getByText("Jurnal menunggu persetujuan", { exact: true })).toBeVisible();
      await akuntan.goto(`${base}/approvals?period=2026-07&jenis=kedua`);
      const theirs = second(akuntan, "Akrual admin Juli");
      await expect(theirs.getByTestId("second-waiting")).toHaveText("Menunggu Admin atau Pemilik lain");
      await expect(theirs.getByRole("button")).toHaveCount(0);

      // The lock is held while it waits, with the count and the way to Kotak.
      await admin.goto(`${base}/close?period=2026-07`);
      await expect(admin.getByText("1 jurnal menunggu persetujuan kedua")).toBeVisible();
      await expect(admin.getByTestId("lock-second")).toHaveAttribute("href", new RegExp(`${base}/approvals\\?.*jenis=kedua`));
      await expect(admin.getByTestId("lock")).toBeDisabled();

      // Turning Jurnal manual off doesn't post what waits.
      await setCard(admin, { manual: false, manualAbove: "", aiDraft: true, aiDraftAbove: "50.000.000", reopen: true });
      await admin.goto(`${base}/approvals?period=2026-07&jenis=kedua`);
      await expect(second(admin, "Akrual admin Juli")).toBeVisible();

      // Flow 5: Tolak with an empty note says what is missing and changes nothing; with a reason it leaves no entry.
      const admin2 = await signIn(browser, baseURL, "credentials-other-admin2.json");
      try {
        await admin2.goto(`${base}/approvals?period=2026-07&jenis=kedua`);
        await second(admin2, "Akrual admin Juli").getByRole("button", { name: "Tolak", exact: true }).click();
        const reject = admin2.getByRole("dialog");
        await reject.getByRole("button", { name: "Tolak", exact: true }).click();
        await expect(reject).toContainText("Tulis alasan menolak (min. 5 karakter).");
        await reject.getByLabel("Alasan menolak", { exact: true }).fill("Bonus belum disetujui direksi");
        await reject.getByRole("button", { name: "Tolak", exact: true }).click();
        await expect(admin2.getByText("Jurnal ditolak", { exact: true })).toBeVisible();
        await expect(second(admin2, "Akrual admin Juli")).toHaveCount(0);
        await admin2.goto(`${base}/journals?period=2026-07`);
        await expect(admin2.getByTestId("journal-entry").filter({ hasText: "Akrual admin Juli" })).toHaveCount(0);

        // Flow 3: June closed (sign-offs and notes, then the lock); Admin A asks to reopen, the month stays closed; Admin B confirms.
        await admin.goto(`${base}/close?period=2026-06`);
        for (const label of SIGNOFFS) {
          const box = admin.getByTestId("signoff").filter({ hasText: label }).getByRole("checkbox");
          await box.click();
          await expect(box).toBeChecked();
        }
        for (let note = admin.getByRole("button", { name: "Beri catatan" }).first(); await note.count(); note = admin.getByRole("button", { name: "Beri catatan" }).first()) {
          await note.click();
          await admin.getByLabel("Catatan kontrol").fill("Klien uji persetujuan, wajar");
          await admin.getByRole("button", { name: "Simpan catatan" }).click();
          await expect(admin.getByRole("dialog")).toHaveCount(0);
        }
        await admin.getByTestId("lock").click();
        await admin.getByTestId("confirm-lock").click();
        await expect(admin.getByTestId("next-step")).toContainText("Buku Juni 2026 sudah ditutup");

        await expect(admin.getByTestId("unlock")).toHaveText("Minta buka kembali");
        await admin.getByTestId("unlock").click();
        await admin.getByTestId("unlock-reason").fill("Faktur pajak Juni terlambat masuk");
        await admin.getByTestId("confirm-lock").click();
        await expect(admin.getByText("Permintaan buka kembali dikirim", { exact: true })).toBeVisible();
        const panel = admin.getByTestId("reopen-request");
        await expect(panel).toContainText(`${ADMIN} meminta membuka kembali Juni 2026: “Faktur pajak Juni terlambat masuk”`);
        await expect(panel.getByRole("button", { name: "Batalkan permintaan", exact: true })).toBeVisible();
        await expect(panel.getByRole("button", { name: "Konfirmasi buka kembali", exact: true })).toHaveCount(0);
        await admin.setViewportSize({ width: 390, height: 844 });
        await noSideScroll(admin);
        await admin.setViewportSize({ width: 1440, height: 900 });

        // B sees it in Kotak too (from July: an earlier month's request), and confirms on Tutup Buku.
        await admin2.goto(`${base}/approvals?period=2026-07&jenis=kedua`);
        await expect(admin2.getByTestId("approval-reopen").filter({ hasText: "Juni 2026" })).toContainText(`${ADMIN} meminta membuka kembali Juni 2026`);
        await admin2.goto(`${base}/close?period=2026-06`);
        await admin2.getByTestId("reopen-request").getByRole("button", { name: "Konfirmasi buka kembali", exact: true }).click();
        await expect(admin2.getByText("Juni 2026 dibuka kembali", { exact: true })).toBeVisible();
        await expect(admin2.getByTestId("reopen-request")).toHaveCount(0);
        await expect(admin2.getByTestId("lock")).toBeVisible();
        await expect(admin2.getByTestId("unlock-history")).toContainText(`Diminta ${ADMIN} · dikonfirmasi ${ADMIN2}`);
        await expect(admin2.getByTestId("unlock-history")).toContainText("Faktur pajak Juni terlambat masuk");
        await admin2.setViewportSize({ width: 390, height: 844 });
        await noSideScroll(admin2);
      } finally {
        await admin2.context().close();
      }
    } finally {
      await akuntan.context().close();
    }
  } finally {
    // The firm outlives the run: the card back to all off, and the QA client (with its requests) removed.
    await setCard(admin, OFF);
    if (base) {
      await admin.goto(`${base}/settings`);
      const del = admin.getByTestId("delete-client");
      await del.getByLabel("Ketik nama klien untuk konfirmasi").fill(CLIENT);
      await del.getByRole("button", { name: "Hapus klien", exact: true }).click();
      await expect(admin.getByRole("heading", { name: "Beranda", exact: true })).toBeVisible();
    }
    await admin.context().close();
  }
});
