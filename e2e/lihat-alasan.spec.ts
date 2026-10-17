import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { asPeninjau, noSideScroll } from "./qa-helpers";

/**
 * Lihat alasan (cycle 2026-10-17-lihat-alasan): the steps behind an AI card in Kotak persetujuan and Review, and *Unduh nilai (CSV)*.
 * Read-only on the demo: CV Sinar Retail's two August AI lines (the 83 % grosir sale, the 74 % rack) answer from the seed's cached
 * answers (`demo-seed`), so CI needs no AI key; nothing is accepted, the role a Peninjau check changes is restored. AI drafts need a
 * model to exist, so their panel is asserted in tests/db/close-explain.test.ts.
 */

/** CV Sinar Retail's Kotak for August through the firm board, and the client's base path. */
async function sinarKotak(page: Page) {
  await page.goto("/?period=2026-08");
  const link = page.getByTestId("board-row").filter({ hasText: "CV Sinar Retail" }).getByRole("link", { name: /usulan|Selesai/ });
  const href = (await link.getAttribute("href"))!;
  await page.goto(href);
  await expect(page.getByRole("heading", { name: "Kotak persetujuan" })).toBeVisible();
  return { href, base: new URL(page.url()).pathname.match(/\/clients\/[^/]+/)![0] };
}

const step = (panel: Locator, label: string) => panel.getByTestId("reasoning-step").filter({ has: panel.page().getByText(label, { exact: true }) });

/** Every card shows *Lihat alasan* exactly when it carries the AI badge. */
async function toggleOnlyOnAi(cards: Locator) {
  const n = await cards.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    const ai = (await card.getByText("AI", { exact: true }).count()) > 0;
    await expect(card.getByTestId("reasoning-toggle")).toHaveCount(ai ? 1 : 0);
  }
}

/** The grosir line's panel as Kotak and Review show it (flow 1). */
async function expectGrosirPanel(panel: Locator) {
  await expect(panel.getByTestId("reasoning-step")).toHaveCount(5);
  for (const label of ["Dicek dulu tanpa AI", "Dikirim ke AI", "Jawaban AI", "Diperiksa Buku", "Belum dicatat"]) await expect(step(panel, label)).toHaveCount(1);
  await expect(step(panel, "Dicek dulu tanpa AI")).toContainText("tidak ada pasangan transfer, aturan, memori klien, atau teks pinjaman, modal atau pajak yang cocok");
  const sent = step(panel, "Dikirim ke AI");
  await expect(sent).toContainText('Klien: "CV Sinar Retail (ritel minimarket)"');
  await expect(sent).toContainText("Arah: uang masuk");
  await expect(sent).toContainText("Pihak lawan: ");
  await expect(sent).toContainText(/Keterangan: ".*BELANJA GROSIR"/);
  await expect(sent).toContainText(/Daftar akun: \d+ akun, tanpa 1190 dan 1199/);
  await expect(sent).toContainText("Nominal, tanggal, saldo dan nomor rekening tidak dikirim.");
  await expect(sent).not.toContainText("14.300.000");
  await expect(sent).not.toContainText("3440556677");
  await expect(step(panel, "Jawaban AI")).toContainText('4100 Penjualan · keyakinan 83% · pajak – · "Penjualan grosir"');
  await expect(step(panel, "Jawaban AI")).toContainText("Jawaban demo, tanpa panggilan AI");
  await expect(step(panel, "Diperiksa Buku")).toContainText("Kode 4100 ada di bagan akun klien.");
  await expect(step(panel, "Diperiksa Buku")).toContainText("Boleh disetujui massal.");
  await expect(step(panel, "Belum dicatat")).toContainText("Baris ini tetap di 1999 sampai Anda menyetujuinya.");
}

/** The CSV the panel downloads: Excel id-ID, the panel's values, the amount only in the *tidak dikirim* row, no formula cell. */
async function expectGrosirCsv(page: Page, panel: Locator) {
  const [download] = await Promise.all([page.waitForEvent("download"), panel.getByTestId("reasoning-download").click()]);
  expect(download.suggestedFilename()).toMatch(/^alasan-mutasi-.+\.csv$/);
  const text = readFileSync((await download.path())!, "utf8");
  expect(text.startsWith("﻿Bagian;Butir;Nilai;Tanggal;Jumlah;Jumlah (satuan terkecil);Mata uang;Akun;Cara;Dikutip;Sumber\r\n")).toBe(true);
  const rows = text.replace(/^﻿/, "").trimEnd().split("\r\n");
  expect(rows).toContain("Dikirim ke AI;Klien;CV Sinar Retail (ritel minimarket);;;;;;;;Nama dan bidang usaha klien");
  expect(rows).toContain("Dikirim ke AI;Arah;IN;;;;;;;;Arah mutasi");
  expect(rows.filter((r) => r.startsWith("Dikirim ke AI;Akun ditawarkan;")).length).toBeGreaterThan(20);
  expect(rows.some((r) => r.startsWith("Dikirim ke AI;Akun ditawarkan;") && /;1199;|;1190;/.test(r))).toBe(false);
  expect(rows).toContain("Jawaban AI;Model;demo-seed;;;;;;;;Jawaban demo, tanpa panggilan AI");
  expect(rows).toContain("Diperiksa Buku;Lolos;Boleh disetujui massal.;;;;;;;;Pemeriksaan Buku");
  const amount = rows.filter((r) => r.includes("14300000") || r.includes("14.300.000"));
  expect(amount).toEqual(["Tidak dikirim;Nominal;tidak dikirim;2026-08-23;Rp 14.300.000;14300000;IDR;;;;Mutasi BCA Giro"]);
  for (const cell of rows.flatMap((r) => r.split(";"))) expect(/^[=+@\t]/.test(cell) || (/^-/.test(cell) && !/^-\d+$/.test(cell))).toBe(false);
}

test("demo Kotak: the grosir line's Lihat alasan shows the five steps and exactly what was sent; the CSV holds the same values", async ({ page }) => {
  await sinarKotak(page);
  await toggleOnlyOnAi(page.locator('li[data-testid^="approval-"]'));
  const card = page.getByTestId("approval-bank").filter({ hasText: "BELANJA GROSIR" });
  await card.getByTestId("reasoning-toggle").click();
  await expect(card.getByTestId("reasoning-toggle")).toHaveText(/Tutup alasan/);
  const panel = card.getByTestId("reasoning-panel");
  await expectGrosirPanel(panel);
  await expectGrosirCsv(page, panel);
  // The page's one primary button is unchanged and nothing was approved.
  await expect(page.getByTestId("approve-confident")).toHaveText(/Setujui 1 usulan yakin/);
  await card.getByTestId("reasoning-toggle").click();
  await expect(card.getByTestId("reasoning-panel")).toHaveCount(0);
});

test("demo Review: Enter on Lihat alasan opens the rack line's panel and accepts nothing; it says why the line is not offered in bulk", async ({ page }) => {
  const { base } = await sinarKotak(page);
  await page.goto(`${base}/review?period=2026-08`);
  await expect(page.getByRole("heading", { name: "Review transaksi" })).toBeVisible();
  await toggleOnlyOnAi(page.getByTestId("review-item"));
  const count = (await page.getByTestId("review-count").textContent())!;
  const item = page.getByTestId("review-item").filter({ hasText: "RAK DISPLAY" });
  const toggle = item.getByTestId("reasoning-toggle");
  await toggle.focus();
  await page.keyboard.press("Enter");
  const panel = item.getByTestId("reasoning-panel");
  await expect(step(panel, "Jawaban AI")).toContainText('6160 Beban Perlengkapan Kantor · keyakinan 74% · pajak – · "Perlengkapan toko"');
  await expect(step(panel, "Diperiksa Buku")).toContainText("Tidak ikut setujui massal: keyakinan di bawah 80%.");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter"); // the same key closes it again
  await expect(panel).toHaveCount(0);
  // Nothing was accepted: the line and the count are as seeded, nothing is saving.
  await expect(item).toHaveCount(1);
  await expect(page.getByTestId("review-count")).toHaveText(count);
  await expect(page.getByTestId("review-saving")).toHaveCount(0);
});

test("a Peninjau opens Lihat alasan and downloads its CSV; another client's item is 404", async ({ page, browser, baseURL }) => {
  const { href, base } = await sinarKotak(page);
  await page.getByTestId("approval-bank").filter({ hasText: "BELANJA GROSIR" }).getByTestId("reasoning-toggle").click();
  const csvHref = (await page.getByTestId("reasoning-download").getAttribute("href"))!;
  expect(csvHref).toMatch(new RegExp(`^${base}/approvals/alasan\\?item=`));
  const ok = await page.request.get(csvHref);
  expect([ok.status(), ok.headers()["content-type"]]).toEqual([200, "text/csv; charset=utf-8"]);

  // The same item under another client of the firm, and an unknown item: not found.
  await page.goto("/");
  await page.getByRole("link", { name: "Grup Ayam Nusantara", exact: true }).first().click();
  await page.waitForURL(/\/clients\/[^/]+/);
  const ayam = new URL(page.url()).pathname.match(/\/clients\/[^/]+/)![0];
  expect((await page.request.get(csvHref.replace(base, ayam))).status()).toBe(404);
  expect((await page.request.get(`${base}/approvals/alasan?item=tidak-ada`)).status()).toBe(404);
  // Grup Ayam's August queue holds deterministic cards too (the due depreciation, Coretax faktur not in the books): no toggle on those.
  await page.goto(`${ayam}/approvals?period=2026-08`);
  await expect(page.getByRole("heading", { name: "Kotak persetujuan" })).toBeVisible();
  await toggleOnlyOnAi(page.locator('li[data-testid^="approval-"]'));

  await asPeninjau(page, browser, baseURL, null, async (viewer) => {
    await viewer.goto(href);
    await expect(viewer.getByRole("heading", { name: "Kotak persetujuan" })).toBeVisible();
    await expect(viewer.locator("main").getByRole("button", { name: /Setujui|Tolak/ })).toHaveCount(0);
    const card = viewer.getByTestId("approval-bank").filter({ hasText: "BELANJA GROSIR" });
    await card.getByTestId("reasoning-toggle").click();
    const panel = card.getByTestId("reasoning-panel");
    await expectGrosirPanel(panel);
    await expectGrosirCsv(viewer, panel);
  });
});

test("Lihat alasan works at 390 px without sideways scroll, in Kotak and in Review", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { base } = await sinarKotak(page);
  for (const text of ["BELANJA GROSIR", "RAK DISPLAY"]) await page.getByTestId("approval-bank").filter({ hasText: text }).getByTestId("reasoning-toggle").click();
  await expect(page.getByTestId("reasoning-panel")).toHaveCount(2);
  await expect(page.getByTestId("reasoning-step")).toHaveCount(10);
  await noSideScroll(page);
  await page.goto(`${base}/review?period=2026-08`);
  const item = page.getByTestId("review-item").filter({ hasText: "RAK DISPLAY" });
  await item.getByTestId("reasoning-toggle").click();
  await expect(item.getByTestId("reasoning-step")).toHaveCount(5);
  await noSideScroll(page);
});
