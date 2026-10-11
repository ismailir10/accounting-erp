import { expect, test } from "@playwright/test";
import { openManualImport } from "./qa-helpers";

/** A statement uploaded to the wrong account names the right one and switches in one click (staging E2E 2026-09-29, L2). */
test("wrong account: the error offers the client's matching account", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Grup Ayam Nusantara", exact: true }).first().click();
  await expect(page).toHaveURL(/\/clients\/[^/?]+/);
  const base = new URL(page.url()).pathname.match(/\/clients\/[^/]+/)![0];
  await page.goto(`${base}/import`);
  await openManualImport(page);
  // Companies first (ui rule 13): the PT's accounts are listed before the owner's. Pick the PT's BCA on purpose.
  await page.getByRole("combobox", { name: "Rekening", exact: true }).click();
  await expect(page.getByRole("option").first()).toContainText("8720145566");
  await page.getByRole("option", { name: /8720145566/ }).click();
  await expect(page.getByRole("combobox", { name: "Rekening", exact: true })).toContainText("8720145566");
  await page.getByTestId("file-input").setInputFiles("public/demo/BRI-5509-2026-08.csv");
  await page.getByRole("button", { name: "Proses mutasi", exact: true }).click();
  const alert = page.getByTestId("account-mismatch");
  await expect(alert).toContainText("berbeda dengan rekening terpilih (8720145566)");
  await alert.getByRole("button", { name: "Pakai rekening BRI Simpedes · 012301004455509" }).click();
  await expect(page.getByRole("combobox", { name: "Rekening", exact: true })).toContainText("012301004455509");
  // Imported into the owner's BRI (or, after the investor walk closed August, refused with the lock message).
  await expect(page.getByText(/Nyambung|sudah ditutup/).first()).toBeVisible();
});
