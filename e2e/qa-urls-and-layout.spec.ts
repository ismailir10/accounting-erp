import { expect, test } from "@playwright/test";
import { addClient } from "./qa-helpers";

/**
 * URL parameters, layout and wording found by the end-to-end QA run (docs/qa/bugs): BUG-007 impossible month · 012 mobile overflow ·
 * 013 page titles · 014 long text and a repeated word in a toast.
 */
const PAGES = ["", "/import", "/review", "/opening", "/ledger", "/trial-balance", "/reports", "/tax", "/close", "/assets", "/receivables", "/leases", "/journals/new"];

test("BUG-007: a month outside 1–12 never renders 'undefined', on pages or in an export file name", async ({ page }) => {
  const id = await addClient(page, { name: "QA Periode" });
  for (const bad of ["2026-13", "2026-00"]) {
    for (const p of PAGES.slice(0, 9)) {
      await page.goto(`/clients/${id}${p}?period=${bad}`);
      await expect(page.locator("body")).not.toContainText("undefined");
    }
    await page.goto(`/?period=${bad}`);
    await expect(page.locator("body")).not.toContainText("undefined");
  }
  const xlsx = await page.request.get(`/clients/${id}/reports/export?period=2026-13`);
  expect(xlsx.status()).toBe(200);
  expect(xlsx.headers()["content-disposition"]).not.toContain("undefined");
});

test("BUG-013: every page has its own title", async ({ page }) => {
  const id = await addClient(page, { name: "QA Judul" });
  const titles = new Map<string, string>();
  for (const url of ["/", "/reports", "/documents", "/settings", "/clients/new", ...PAGES.map((p) => `/clients/${id}${p}`)]) {
    await page.goto(url);
    titles.set(url.replace(id, ":id"), await page.title());
  }
  expect([...titles.values()].every((t) => t.endsWith(" · Buku") || t.startsWith("Buku"))).toBe(true);
  expect(titles.get("/")).toBe("Beranda · Buku");
  expect(titles.get(`/clients/:id/trial-balance`)).toBe("Neraca Saldo · Buku");
  expect(new Set(titles.values()).size).toBeGreaterThanOrEqual(15);
});

test.describe("BUG-012: the import page fits a 390 px phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("no horizontal page scroll", async ({ page }) => {
    const id = await addClient(page, { name: "QA Ponsel" });
    await page.goto(`/clients/${id}/import`);
    await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
    const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(scroll).toBeLessThanOrEqual(client + 1);
  });
});

test("BUG-014: a long unbroken question stays inside its answer card; a lease named 'Sewa …' is not announced as 'Sewa Sewa …'", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Apa yang ingin Anda periksa?").fill("x".repeat(2000));
  await page.getByRole("button", { name: "Tanya Buku" }).click();
  const answer = page.locator("article").first();
  await expect(answer).toBeVisible();
  const overflow = await answer.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  const id = await addClient(page, { name: "QA Sewa" });
  await page.goto(`/clients/${id}/leases?period=2026-08`);
  await page.getByRole("button", { name: "Sewa baru" }).click();
  await page.getByLabel("Nama sewa").fill("Sewa Gudang QA");
  await page.getByLabel("Pihak yang menyewakan").fill("PT Pemilik Gedung");
  await page.getByLabel("Bulan mulai").fill("2026-08");
  await page.getByLabel("Masa sewa (bulan)").fill("24");
  await page.getByLabel("Pembayaran per interval").fill("5.000.000");
  await page.getByLabel(/^Suku bunga diskonto/).fill("12");
  await page.getByRole("button", { name: /^(Simpan|Daftarkan)/ }).last().click();
  await expect(page.locator("[data-sonner-toast]")).toContainText("Sewa Gudang QA didaftarkan");
  await expect(page.locator("[data-sonner-toast]")).not.toContainText("Sewa Sewa");
});
