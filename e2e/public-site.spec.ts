import { expect, test } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

const pages = [
  { path: "/", title: "Dari rekening koran ke laporan keuangan", name: "landing" },
  { path: "/syarat", title: "Syarat penggunaan", name: "terms" },
  { path: "/kebijakan-privasi", title: "Kebijakan privasi", name: "privacy" },
  { path: "/login", title: "Masuk ke ruang kerja", name: "login" },
  { path: "/daftar", title: "Minta akses uji coba", name: "trial" },
];

test("public product and legal navigation stays usable on desktop and phone", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const item of pages) {
      const response = await page.goto(item.path);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(item.title);
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("html")).toHaveAttribute("lang", "id");
      await expect(page.locator("main")).toHaveCount(1);
      const header = page.getByRole("banner");
      await expect(header.getByRole("link", { name: "Masuk", exact: true })).toBeVisible();
      await expect(header.getByRole("link", { name: "Minta uji coba", exact: true })).toBeVisible();
      await expect(page.getByRole("contentinfo").getByRole("link", { name: "Syarat", exact: true })).toHaveAttribute("href", "/syarat");
      await expect(page.getByRole("contentinfo").getByRole("link", { name: "Privasi", exact: true })).toHaveAttribute("href", "/kebijakan-privasi");
      await page.keyboard.press("Tab");
      const skip = page.getByRole("link", { name: "Lewati navigasi" });
      // Login intentionally focuses email; reach the document's skip link using the keyboard too.
      for (let step = 0; step < 8 && !await skip.evaluate((element) => element === document.activeElement); step++) await page.keyboard.press("Shift+Tab");
      await expect(skip).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("#public-main")).toBeFocused();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (item.path === "/") {
        await expect(page.getByRole("link", { name: "Minta akses uji coba", exact: true }).first()).toHaveAttribute("href", "/daftar");
        await expect(page.getByRole("link", { name: "Lihat deck", exact: true })).toHaveAttribute("href", "/deck");
        await expect(page.locator("main img")).toHaveCount(0);
        // Illustrations settle in as the reader scrolls; every one ends fully visible with its demo label.
        for (const figure of await page.locator("main figure").all()) {
          await figure.scrollIntoViewIfNeeded();
          await expect.poll(() => figure.evaluate((node) => getComputedStyle(node.querySelector("[data-reveal]") ?? node).opacity)).toBe("1");
          await expect(figure.locator("figcaption")).toContainText(/data demo|demonstrasi sintetis/);
        }
        await page.evaluate(() => scrollTo(0, 0));
      }
      await page.screenshot({ path: testInfo.outputPath(`public-${item.name}-${width}.png`), fullPage: true });
    }
  }
  expect(errors).toEqual([]);
});

test("public arrival motion respects reduced motion and metadata resolves", async ({ page, request, baseURL }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const item of pages.slice(0, 3)) {
    await page.goto(item.path);
    const canonical = await page.locator("link[rel='canonical']").getAttribute("href");
    expect(canonical).toBeTruthy();
    // Next normalises the root canonical without a trailing slash; both URLs name the same page.
    expect(new URL(canonical!).href).toBe(new URL(item.path, baseURL!).href);
    expect(await page.locator(".page-settle").first().evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  }
  await page.goto("/");
  // Reduced motion: nothing below the fold is ever hidden, so the page reads in full without scrolling.
  await expect(page.locator("[data-reveal='hidden']")).toHaveCount(0);
  for (const shape of await page.locator(".check-draw circle, .check-draw path").all()) {
    expect(await shape.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  }
  const image = await page.locator("meta[property='og:image']").getAttribute("content");
  expect(image).toBeTruthy();
  expect((await request.get(image!)).ok()).toBe(true);
  expect((await request.get("/icon.svg")).ok()).toBe(true);
  expect((await request.get("/favicon.ico")).ok()).toBe(true);
});

test("a prospect can open the deck, request access and read the linked terms", async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await page.getByRole("link", { name: "Lihat deck", exact: true }).click();
    await expect(page).toHaveURL(/\/deck\/?$/);
    await expect(page.getByRole("link", { name: /kantor akuntan/i }).first()).toBeVisible();
    await page.goBack();
    await page.getByRole("link", { name: "Minta akses uji coba", exact: true }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Minta akses uji coba");
    for (const name of ["Syarat", "Privasi"]) {
      await page.locator("#signup-consent").getByRole("link", { name, exact: true }).click();
      await expect(page.getByText("Draf", { exact: false }).first()).toBeVisible();
      await page.goBack();
      await expect(page.locator("#signup-consent")).toBeVisible();
    }
  }
});
