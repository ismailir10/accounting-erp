import { expect, test } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

for (const deck of ["kantor", "perusahaan"]) {
  test(`${deck}: deck shortcuts preserve links and hide inactive slides from focus`, async ({ page }) => {
    await page.goto(`/deck/${deck}`);
    await expect(page.locator(".slide.on")).toHaveCount(1);
    expect(await page.locator(".slide:not(.on)").evaluateAll((slides) => slides.every((slide) => (slide as HTMLElement).inert))).toBe(true);

    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(/#2$/);
    await expect(page.getByRole("status")).toContainText("Masalah");

    const previous = page.getByRole("button", { name: "Slide sebelumnya" });
    await previous.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#1$/);

    await page.locator("main").click({ position: { x: 5, y: 5 }, force: true });
    await page.keyboard.press("End");
    const access = page.getByRole("link", { name: "Minta akses uji coba", exact: true });
    await access.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/daftar$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Minta akses uji coba");
  });

  test(`${deck}: phone reader has section labels, PDF download and usable deep links`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/deck/${deck}#5`);
    await expect(page.locator("html")).toHaveClass("flow");
    const reader = page.getByRole("navigation", { name: "Tautan presentasi" });
    await expect(reader).toBeVisible();
    await expect(page.locator("#s5 .s-foot")).toBeVisible();
    await expect.poll(() => page.locator("#s5").evaluate((slide) => Math.abs(slide.getBoundingClientRect().top - 70) < 2)).toBe(true);
    expect(await page.locator(".slide").evaluateAll((slides) => slides.every((slide) => !(slide as HTMLElement).inert))).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => { location.hash = "#6"; });
    await expect.poll(() => page.locator("#s6").evaluate((slide) => Math.round(slide.getBoundingClientRect().top))).toBe(70);
    const pdf = reader.getByRole("link", { name: "Unduh PDF" });
    const download = page.waitForEvent("download");
    await pdf.click();
    expect((await download).suggestedFilename()).toBe(`buku-${deck === "kantor" ? "kantor-akuntan" : deck}.pdf`);
    await page.screenshot({ path: testInfo.outputPath(`${deck}-phone.png`) });
  });

  test(`${deck}: all content remains readable without JavaScript`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`${baseURL}/deck/${deck}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Minta akses uji coba", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Unduh PDF", exact: true })).toBeVisible();
    await expect(page.getByText("Semua ilustrasi memakai data demo sintetis.", { exact: true })).toBeVisible();
    expect(await page.locator(".slide").count()).toBeGreaterThan(10);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await context.close();
  });
}
