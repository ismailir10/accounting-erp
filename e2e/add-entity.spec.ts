import { expect, test } from "@playwright/test";
import { openManualImport, openClientForm } from "./qa-helpers";

/** A forgotten bank account or owner is added after "Simpan klien", from the client's settings page; nothing has to be deleted and redone. */
test("add a bank account and an owner to an existing client", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Klien Tambah Rekening");
  await page.getByLabel("Nama lengkap").fill("PT Tambah Rekening");
  await page.getByLabel("Nomor rekening").fill("5550009999");
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  const base = new URL(page.url()).pathname.match(/\/clients\/[^/]+/)![0];

  // Impor says how it differs from Dokumen, and where a missing account is added.
  await expect(page.getByText("Yang diimpor di sini langsung menjadi jurnal.")).toBeVisible();
  await openManualImport(page);
  await page.getByRole("link", { name: "Tambahkan di Pengaturan klien" }).click();
  const card = page.getByTestId("entities-card");
  await expect(card).toContainText("PT Tambah Rekening");
  await expect(card).toContainText("5550009999 · 1101");

  // A second account for the PT, then a wrong number says what to fix.
  await card.getByRole("button", { name: "Tambah rekening", exact: true }).click();
  const addBank = card.getByTestId(/^add-bank-/);
  await addBank.getByLabel("Nomor rekening").fill("12");
  await addBank.getByRole("button", { name: "Simpan rekening" }).click();
  await expect(addBank).toContainText("Nomor rekening berisi 6–20 angka.");
  await addBank.getByLabel("Nomor rekening").fill("5550008888");
  await addBank.getByLabel("Nama rekening").fill("Mandiri Tambahan");
  await addBank.getByRole("button", { name: "Simpan rekening" }).click();
  await expect(card).toContainText("Mandiri Tambahan");
  await expect(card).toContainText("5550008888 · 1102");

  // The owner, with no bank account yet.
  await card.getByRole("button", { name: "Tambah perusahaan atau pemilik" }).click();
  const addEntity = card.getByTestId("add-entity");
  await addEntity.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(addEntity).toContainText("Isi nama pemilik.");
  await addEntity.getByLabel("Nama lengkap").fill("Budi Tambah");
  await addEntity.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(card).toContainText("Budi Tambah");
  await expect(card).toContainText("Perorangan (pemilik)");

  // The new account is offered on the upload page.
  await page.goto(`${base}/import`);
  await openManualImport(page);
  await page.getByRole("combobox", { name: "Rekening", exact: true }).click();
  await expect(page.getByRole("option", { name: /Mandiri Tambahan/ })).toBeVisible();
});

/** A name or number typed wrong is fixed in place; something entered by mistake and still empty can go; anything with books stays and says why. */
test("fix and remove companies and bank accounts", async ({ page }) => {
  await openClientForm(page);
  await page.getByLabel("Nama klien").fill("Klien Ubah Hapus");
  await page.getByLabel("Nama lengkap").fill("PT Ubah Hapus");
  await page.getByLabel("Nomor rekening").fill("5551110000");
  await page.getByLabel("Nama rekening").fill("BCA Giro");
  await page.getByRole("button", { name: "Simpan klien" }).click();
  await expect(page.getByRole("heading", { name: "Unggah", exact: true })).toBeVisible();
  const base = new URL(page.url()).pathname.match(/\/clients\/[^/]+/)![0];

  // Books: one statement imported into the BCA account.
  const file = ["Tanggal;Keterangan;Debet;Kredit;Saldo", "05/08/2026;TRSF CR TOKO MAJU;0;5000000;105000000", ""].join("\n");
  await openManualImport(page);
  await page.getByTestId("file-input").setInputFiles({ name: "rekening-agustus.csv", mimeType: "text/csv", buffer: Buffer.from(file) });
  await page.getByRole("button", { name: "Proses mutasi" }).click();
  await expect(page.getByTestId("import-result")).toContainText("Nyambung");

  // Two things entered by mistake: an empty second account and an empty owner.
  await page.goto(`${base}/settings`);
  const card = page.getByTestId("entities-card");
  await card.getByRole("button", { name: "Tambah rekening", exact: true }).click();
  const addBank = card.getByTestId(/^add-bank-/);
  await addBank.getByLabel("Nomor rekening").fill("5551119999");
  await addBank.getByLabel("Nama rekening").fill("Mandiri Kosong");
  await addBank.getByRole("button", { name: "Simpan rekening" }).click();
  await expect(card).toContainText("Mandiri Kosong");
  await card.getByRole("button", { name: "Tambah perusahaan atau pemilik" }).click();
  const addEntity = card.getByTestId("add-entity");
  await addEntity.getByLabel("Nama lengkap").fill("Pemilik Kosong");
  await addEntity.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(card).toContainText("Pemilik Kosong");

  // The BCA account has a statement: its number is locked, its name is not, and it can't be removed — the reason says why.
  await card.getByRole("button", { name: "Ubah rekening BCA Giro" }).click();
  const editBca = card.getByTestId(/^edit-bank-/);
  await expect(editBca.getByLabel("Nomor rekening")).toBeDisabled();
  await expect(editBca).toContainText("Nomor tetap: rekening korannya sudah dibaca");
  await expect(editBca).toContainText(/Tidak bisa dihapus\. Sudah ada 1 impor rekening koran, 1 mutasi bank.*Rekening yang sudah dipakai tidak bisa dihapus\./);
  await editBca.getByLabel("Nama rekening").fill("BCA Operasional");
  await editBca.getByRole("button", { name: "Simpan rekening" }).click();
  await expect(card).toContainText("BCA Operasional");

  // The company with books: renamed in place (labels only); removal is refused with what is there.
  await card.getByRole("button", { name: "Ubah PT Ubah Hapus" }).click();
  const editPt = card.getByTestId(/^edit-entity-/);
  await expect(editPt).toContainText(/Tidak bisa dihapus\. Sudah ada .*1 mutasi bank.*koreksi lewat Jurnal Penyesuaian/);
  await expect(editPt.getByRole("button", { name: /^Hapus/ })).toHaveCount(0);
  await editPt.getByLabel("Nama lengkap").fill("PT Ubah Hapus Makmur");
  await editPt.getByRole("button", { name: "Simpan perubahan" }).click();
  await expect(card).toContainText("PT Ubah Hapus Makmur");

  // The empty account and the empty owner go, after a second click.
  await card.getByRole("button", { name: "Ubah rekening Mandiri Kosong" }).click();
  const editEmpty = card.getByTestId(/^edit-bank-/);
  await editEmpty.getByRole("button", { name: "Hapus rekening" }).click();
  await editEmpty.getByRole("button", { name: "Ya, hapus rekening" }).click();
  await expect(card).not.toContainText("Mandiri Kosong");
  await card.getByRole("button", { name: "Ubah Pemilik Kosong" }).click();
  const editOwner = card.getByTestId(/^edit-entity-/);
  await editOwner.getByRole("button", { name: "Hapus pemilik" }).click();
  await expect(editOwner).toContainText("Hapus Pemilik Kosong? Belum ada pembukuan di sini");
  await editOwner.getByRole("button", { name: "Ya, hapus pemilik" }).click();
  await expect(card).not.toContainText("Pemilik Kosong");

  // The books are what they were: the statement's account is still there, and Riwayat says what changed.
  await expect(card).toContainText("5551110000 · 1101");
  await page.goto(`${base}/history`);
  await expect(page.getByText("Pemilik Kosong dihapus")).toBeVisible();
  await expect(page.getByText("Rekening BCA Giro diubah menjadi BCA Operasional")).toBeVisible();
});
