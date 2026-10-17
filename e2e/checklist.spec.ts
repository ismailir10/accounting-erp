import { expect, test, type Page } from "@playwright/test";
import { asPeninjau, credentials, noSideScroll, openClientForm, signIn } from "./qa-helpers";

/**
 * Checklist tutup buku (cycle 2026-10-17-checklist-tutup-buku), flows 1, 2, 4 and 5 and the firm board's late count (flow 3), all on a
 * client of its own so the demo books stay as they are (the investor walk reads only the board's *Sumber* cell). The e2e AKUNTAN is
 * assigned to the QA client for the walk and unassigned at the end; asPeninjau restores their role itself.
 */
const CLIENT = "QA Checklist Tutup Buku";
const AKUNTAN = "Akuntan uji · Akuntan";
const ADMIN = "Akuntan uji · Admin"; // the e2e admin (scripts/e2e-setup.ts) carries the same display name; the role tells them apart
const DOCS = "Bukti pendukung transaksi besar sudah diperiksa";
const MANUAL = "Kirim draf laporan ke klien";
const AFTER_LOCK = "Unggah SPT Masa ke Coretax";

async function pickOption(page: Page, label: string, name: string | RegExp) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

/** One accrual in August, so the month has books (no bank account: nothing to upload). */
async function accrual(page: Page, base: string) {
  await page.goto(`${base}/journals/new?period=2026-08`);
  await page.getByLabel("Tanggal").fill("2026-08-31");
  await page.getByLabel("Keterangan").fill("Akrual listrik Agustus");
  await pickOption(page, "Akun baris 1", /^6130 /);
  await page.getByLabel("Debit baris 1").fill("1.000.000");
  await pickOption(page, "Akun baris 2", /^2150 /);
  await page.getByLabel("Kredit baris 2").fill("1.000.000");
  await page.getByRole("button", { name: "Simpan jurnal" }).click();
  await expect(page.getByText("Jurnal penyesuaian tersimpan")).toBeVisible();
}

/** Pengaturan → Tim: the e2e AKUNTAN holds the QA client (`on`) or not; idempotent. */
async function assignAkuntan(page: Page, on: boolean) {
  const { email } = credentials("credentials-akuntan.json");
  await page.goto("/settings?tab=tim");
  await page.getByTestId("team-row").filter({ hasText: email }).getByTestId("assign-clients").click();
  const dialog = page.getByRole("dialog");
  const box = dialog.locator("div.flex").filter({ has: page.locator("label", { hasText: new RegExp(`^${CLIENT}$`) }) }).getByRole("checkbox");
  if (((await box.getAttribute("aria-checked")) === "true") !== on) await box.click();
  await dialog.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByText(/Klien .* disimpan/)).toBeVisible();
}

const row = (page: Page, title: string) => page.getByTestId("checklist-row").filter({ hasText: title });
/** Finished tasks fold into "N tugas selesai" (still in the DOM): open it to read them. */
async function openFinished(page: Page) {
  const fold = page.getByTestId("checklist-finished");
  if ((await fold.count()) && !(await fold.evaluate((d) => (d as HTMLDetailsElement).open))) await fold.locator("summary").click();
}

test("checklist tutup buku: Buku's list accepted, ticked by the Pelaksana, reviewed by the admin, warned at the lock, frozen and reopened", async ({ page, browser, baseURL }) => {
  test.setTimeout(300_000);
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill(CLIENT);
  await page.getByLabel("Nama lengkap").fill("PT QA Checklist");
  await page.getByLabel("Nama singkat").fill("QACHK");
  await page.getByRole("button", { name: "Hapus rekening" }).click();
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  const base = new URL(page.url()).pathname.replace(/\/import.*$/, "");
  const checklist = `${base}/checklist?period=2026-08`;
  await accrual(page, base);

  // Flow 1: without a checklist the page shows Buku's list, each line with its kind and reason; no Piutang & Utang without the module.
  await page.goto(checklist);
  await expect(page.getByRole("heading", { name: "Checklist tutup buku" })).toBeVisible();
  await expect(page.getByTestId("next-step")).toContainText("Buku menyusun daftar dari yang dipakai klien ini. Periksa, lalu pakai.");
  const lines = page.getByTestId("proposal-line");
  await expect(lines.filter({ hasText: "Minta rekening koran dan data" })).toContainText("Otomatis");
  await expect(lines.filter({ hasText: "Minta rekening koran dan data" })).toContainText("Tenggat tanggal 5");
  await expect(lines.filter({ hasText: "Saldo awal dicatat" })).toContainText("Belum ada saldo awal yang dicatat.");
  await expect(lines.filter({ hasText: DOCS })).toContainText("Pemeriksaan akhir");
  await expect(lines.filter({ hasText: "Laporan keuangan sudah direview partner" })).toContainText("Tenggat tanggal 12");
  await expect(lines.filter({ hasText: "Rekonsiliasi piutang & utang" })).toHaveCount(0);
  await expect(lines.filter({ hasText: "Pajak Masa diperiksa" })).toHaveCount(0);
  await expect(page.getByTestId("checklist-accept")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // A viewer sees the list without the button (asPeninjau assigns the QA client for the check and takes it back).
  await asPeninjau(page, browser, baseURL, CLIENT, async (viewer) => {
    await viewer.goto(checklist);
    await expect(viewer.getByTestId("proposal-line").first()).toBeVisible();
    await expect(viewer.getByTestId("checklist-accept")).toHaveCount(0);
    await expect(viewer.locator("main").getByRole("button", { name: /Pakai daftar ini|Tambah tugas|Atur checklist/ })).toHaveCount(0);
  });

  await assignAkuntan(page, true);
  try {
    // ... and so does an AKUNTAN (flow 5: setting up is admin work).
    const akuntan = await signIn(browser, baseURL, "credentials-akuntan.json");
    await akuntan.goto(checklist);
    await expect(akuntan.getByTestId("proposal-line").first()).toBeVisible();
    await expect(akuntan.getByTestId("checklist-accept")).toHaveCount(0);

    // The admin accepts: Pelaksana the AKUNTAN, Pereviu the admin.
    await page.goto(checklist);
    await page.getByTestId("checklist-accept").click();
    await pickOption(page, "Pelaksana", AKUNTAN);
    await pickOption(page, "Pereviu", ADMIN);
    await page.getByTestId("checklist-accept-confirm").click();
    await expect(page.getByText("Checklist dipakai")).toBeVisible();
    await expect(page.getByTestId("checklist-summary")).toContainText(/\d+ \/ \d+ selesai/);
    await expect(row(page, "Minta rekening koran dan data")).toContainText("Belum ada rekening koran atau file buku untuk bulan ini");
    await expect(row(page, "Minta rekening koran dan data").getByRole("link", { name: "Unggah" })).toBeVisible();
    await expect(row(page, "Kontrol tutup buku dicek")).toContainText(/kontrol perlu catatan/);
    await expect(row(page, DOCS)).toContainText("Pelaksana Akuntan uji · Pereviu Akuntan uji");
    // A month before the template's first month has no checklist.
    await page.goto(`${base}/checklist?period=2026-07`);
    await expect(page.getByTestId("next-step")).toContainText("Checklist klien ini dimulai Agustus 2026");
    await expect(page.getByTestId("checklist-row")).toHaveCount(0);
    // The next month has the same tasks, fresh.
    await page.goto(`${base}/checklist?period=2026-09`);
    await expect(row(page, DOCS)).toHaveAttribute("data-status", "BELUM");

    // Flow 2: the AKUNTAN adds a Manual task of her own and ticks it and Bukti pendukung; Tutup Buku shows the same tick.
    await akuntan.goto(checklist);
    await expect(akuntan.getByTestId("checklist-manage")).toHaveCount(0); // *Atur checklist* is not offered (flow 5)
    await akuntan.getByTestId("checklist-add").click();
    await akuntan.getByLabel("Nama tugas").fill(MANUAL);
    await pickOption(akuntan, "Pereviu", ADMIN);
    await akuntan.getByLabel("Tanggal tenggat").fill("12");
    await akuntan.getByTestId("checklist-save").click();
    await expect(akuntan.getByText("Tugas ditambahkan")).toBeVisible();
    await row(akuntan, MANUAL).getByRole("checkbox").click();
    await expect(row(akuntan, MANUAL)).toHaveAttribute("data-status", "SELESAI");
    await expect(row(akuntan, MANUAL).getByTestId("checklist-done-line")).toContainText(/^Selesai Akuntan uji · \d+ \w+ \d{2}\.\d{2}$/);
    await row(akuntan, DOCS).getByRole("checkbox").click();
    await expect(row(akuntan, DOCS)).toHaveAttribute("data-status", "SELESAI");
    // The one who ticked is never offered the review.
    await expect(row(akuntan, MANUAL).getByRole("button", { name: "Tandai direviu" })).toHaveCount(0);
    await akuntan.setViewportSize({ width: 390, height: 844 });
    await noSideScroll(akuntan);
    await akuntan.goto(`${base}/close?period=2026-08`);
    await expect(akuntan.locator("#signoff-docs")).toBeChecked();
    await expect(akuntan.getByTestId("signoff").filter({ hasText: DOCS })).toContainText("Pelaksana Akuntan uji");
    await akuntan.context().close();

    // The admin reviews both: Direviu with name and time.
    await page.goto(checklist);
    await row(page, MANUAL).getByRole("button", { name: "Tandai direviu" }).click();
    await expect(page.getByText("Ditandai direviu")).toBeVisible();
    await row(page, DOCS).getByRole("button", { name: "Tandai direviu" }).click();
    await openFinished(page);
    await expect(row(page, MANUAL)).toHaveAttribute("data-status", "DIREVIU");
    await expect(row(page, MANUAL).getByTestId("checklist-done-line")).toContainText(/Selesai Akuntan uji · .* · Direviu Akuntan uji · /);
    await expect(row(page, DOCS)).toHaveAttribute("data-status", "DIREVIU");
    await page.goto(`${base}/history?kind=CHECKLIST`);
    const history = page.getByTestId("history-row");
    await expect(history.filter({ hasText: `${MANUAL} · Agustus 2026: Belum → Selesai` })).toHaveCount(1);
    await expect(history.filter({ hasText: `${DOCS} · Agustus 2026: Belum → Selesai` })).toHaveCount(1);
    await expect(history.filter({ hasText: `${MANUAL} · Agustus 2026: Selesai → Direviu` })).toHaveCount(1);
    await expect(history.filter({ hasText: "Checklist dipakai mulai Agustus 2026" })).toHaveCount(1);

    // Flow 3: August's tasks are past their due dates (September): the board's Checklist cell and Beranda's task count them.
    await page.goto("/?period=2026-08");
    const cell = page.getByTestId("board-row").filter({ hasText: CLIENT }).getByRole("link", { name: /lewat tenggat/ });
    await expect(cell).toBeVisible();
    await expect(cell).toHaveAttribute("href", new RegExp(`${base}/checklist\\?.*period=2026-08`));
    await page.goto("/?period=2026-08&tugas=semua");
    await expect(page.getByText(/Selesaikan \d+ tugas checklist lewat tenggat/).first()).toBeVisible();

    // Flow 4: a task for after the lock; then the lock with tasks unfinished warns and still succeeds.
    await page.goto(checklist);
    await page.getByTestId("checklist-add").click();
    await page.getByLabel("Nama tugas").fill(AFTER_LOCK);
    await page.getByLabel("Tanggal tenggat").fill("20");
    await page.getByTestId("checklist-save").click();
    await expect(page.getByText("Tugas ditambahkan")).toBeVisible();
    await page.goto(`${base}/close?period=2026-08`);
    for (const key of ["adjust", "review"]) {
      await page.locator(`#signoff-${key}`).click(); // an admin covers for the Pelaksana
      await expect(page.locator(`#signoff-${key}`)).toBeChecked();
    }
    for (let note = page.getByRole("button", { name: "Beri catatan" }).first(); await note.count(); note = page.getByRole("button", { name: "Beri catatan" }).first()) {
      await note.click();
      await page.getByLabel("Catatan kontrol").fill("Klien uji checklist, wajar");
      await page.getByRole("button", { name: "Simpan catatan" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    await expect(page.getByTestId("checklist-warning")).toContainText(/Checklist: \d+ tugas belum selesai/);
    await page.getByTestId("lock").click();
    await expect(page.getByRole("dialog")).toContainText(/\d+ tugas checklist belum selesai; buku tetap bisa ditutup/);
    await page.getByTestId("confirm-lock").click();
    await expect(page.getByTestId("next-step")).toContainText("Buku Agustus 2026 sudah ditutup");

    // After the lock: a Manual task still ticks, a sign-off doesn't, the template is closed for edits.
    await page.goto(checklist);
    await expect(page.getByTestId("next-step")).toContainText(/Buku Agustus 2026 sudah ditutup\. \d+ tugas masih terbuka/);
    await row(page, AFTER_LOCK).getByRole("checkbox").click();
    await openFinished(page);
    await expect(row(page, AFTER_LOCK)).toHaveAttribute("data-status", "SELESAI");
    await expect(row(page, "Jurnal penyesuaian (penyusutan, akrual) sudah dicatat").getByRole("checkbox")).toBeDisabled();
    await expect(page.getByTestId("checklist-add")).toHaveCount(0);
    await expect(page.getByTestId("checklist-manage")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await noSideScroll(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // Reopening returns the sign-offs to Belum; their earlier review no longer counts.
    await page.goto(`${base}/close?period=2026-08`);
    await page.getByTestId("unlock").click();
    await page.getByTestId("unlock-reason").fill("Uji checklist dibuka kembali");
    await page.getByTestId("confirm-lock").click();
    await expect(page.getByText("Periode dibuka kembali")).toBeVisible();
    await page.goto(checklist);
    await expect(row(page, DOCS)).toHaveAttribute("data-status", "BELUM");
    await expect(row(page, "Laporan keuangan sudah direview partner")).toHaveAttribute("data-status", "BELUM");
  } finally {
    await assignAkuntan(page, false);
  }
});
