import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { addClient, asPeninjau, noSideScroll, uploadStatement } from "./qa-helpers";

/**
 * Usulan akrual (cycle 2026-10-18-usulan-akrual): accruals proposed from each vendor's history in Kotak persetujuan. Every flow runs
 * on QA clients of its own (never the investor walk's demo state). The books come in through the real import: one generic CSV per
 * period with a declared *Periode* (statement coverage needs it), then Review files each payee once with *serupa*.
 *
 * The QA client (verify flow 1): Bersih Prima pays 4,2 / 4,2 / 4,35 / 4,2 jt to 6190 April–July and nothing in August; PLN and Telkom
 * both pay to 6130, only PLN in August; Andalas pays 7,5 jt to 6170 May–July. August → three cards: Bersih, Telkom, Andalas.
 */
const BERSIH = "PT BERSIH PRIMA JASA KEBERSIHAN";
const PLN = "PLN POSTPAID";
const TELKOM = "TELKOM INDIHOME";
const ANDALAS = "KANTOR KONSULTAN ANDALAS";
type Row = [day: string, text: string, amount: number];

const HISTORY: Row[] = [
  ["10/04/2026", BERSIH, 4_200_000], ["12/04/2026", PLN, 2_100_000], ["14/04/2026", TELKOM, 500_000],
  ["10/05/2026", BERSIH, 4_200_000], ["12/05/2026", PLN, 2_300_000], ["14/05/2026", TELKOM, 500_000], ["20/05/2026", ANDALAS, 7_500_000],
  ["10/06/2026", BERSIH, 4_350_000], ["12/06/2026", PLN, 2_200_000], ["14/06/2026", TELKOM, 500_000], ["20/06/2026", ANDALAS, 7_500_000],
  ["10/07/2026", BERSIH, 4_200_000], ["12/07/2026", PLN, 2_250_000], ["14/07/2026", TELKOM, 500_000], ["20/07/2026", ANDALAS, 7_500_000],
  ["12/08/2026", PLN, 2_400_000],
];
const OPENING = 1_000_000_000;
const total = (rows: Row[]) => rows.reduce((s, r) => s + r[2], 0);

/** A generic statement: the declared period, a SALDO AWAL row and every row money out, each with its running balance. */
function statement(period: string, opening: number, rows: Row[]) {
  let balance = opening;
  const lines = [`Periode : ${period}`, "Tanggal;Keterangan;Debet;Kredit;Saldo", `${period.slice(0, 10)};SALDO AWAL;;;${opening}`];
  for (const [day, text, amount] of rows) lines.push(`${day};${text};${amount};0;${(balance -= amount)}`);
  return `${lines.join("\n")}\n`;
}

/** Upload one statement and wait for the import to answer. */
async function upload(page: Page, id: string, name: string, csv: string) {
  await uploadStatement(page, id, name, csv);
  await expect(page.getByTestId("import-result")).toContainText("Nyambung");
}

/** Review files each payee once for all its lines (*serupa*): Bersih keeps the suggested 6190, the others move. */
async function fileExpenses(page: Page, id: string) {
  await page.goto(`/clients/${id}/review?period=2026-08`);
  await expect(page.getByRole("heading", { name: "Review transaksi" })).toBeVisible();
  const item = (text: string) => page.getByTestId("review-item").filter({ hasText: text }).first();
  await item(BERSIH).getByRole("button", { name: "Terima 4 serupa", exact: true }).click();
  await expect(page.getByText(/^4 transaksi serupa dicatat ke 6190/)).toBeVisible();
  for (const [text, code, n] of [[PLN, "6130", 5], [TELKOM, "6130", 4], [ANDALAS, "6170", 3]] as const) {
    await item(text).getByRole("combobox", { name: "Akun", exact: true }).click();
    await page.getByRole("combobox", { name: "Cari akun", expanded: true }).fill(code);
    await page.keyboard.press("Enter");
    await item(text).getByRole("button", { name: `Simpan untuk ${n} serupa`, exact: true }).click();
    await expect(page.getByText(new RegExp(`^${n} transaksi serupa dicatat ke ${code}`))).toBeVisible();
    await expect(page.getByTestId("review-item").filter({ hasText: text })).toHaveCount(0);
  }
  await expect(page.getByTestId("review-item")).toHaveCount(0);
}

/** A QA client with the April–August history (August through `until`), filed. */
async function qaClient(page: Page, name: string, until = "31/08/2026") {
  const id = await addClient(page, { name });
  const rows = HISTORY.filter(([day]) => day.slice(3) !== "08/2026" || Number(day.slice(0, 2)) <= Number(until.slice(0, 2)));
  await upload(page, id, `${name}-apr-agu.csv`, statement(`01/04/2026 - ${until}`, OPENING, rows));
  await fileExpenses(page, id);
  return { id, closing: OPENING - total(rows) };
}

const accrualCards = (page: Page) => page.getByTestId("approval-accrual");
const card = (page: Page, text: string) => accrualCards(page).filter({ hasText: text });
const step = (panel: Locator, label: string) => panel.getByTestId("reasoning-step").filter({ has: panel.page().getByText(label, { exact: true }) });

/** The firm board's *Persetujuan* link of a client for August, and the count it shows. */
async function boardCell(page: Page, client: string) {
  await page.goto("/?period=2026-08");
  const link = page.getByTestId("board-row").filter({ hasText: client }).getByRole("link", { name: /usulan|Selesai/ });
  await expect(link).toBeVisible();
  return { link, text: (await link.textContent())!.trim() };
}

test("flows 1, 2 and 5: three cards with their reasons; Setujui, Ubah and Tolak; a field refusal; a Peninjau only reads; September proposes again", async ({ page, browser, baseURL }) => {
  const client = "QA Usulan Akrual";
  const { id, closing } = await qaClient(page, client);
  const kotak = `/clients/${id}/approvals?period=2026-08`;

  // Jurnal Penyesuaian no longer lists accruals; its next step points at the open proposals in Kotak.
  await page.goto(`/clients/${id}/journals/new?period=2026-08`);
  const adjustNext = page.getByTestId("next-step");
  await expect(adjustNext).toContainText("3 usulan akrual dari riwayat vendor menunggu di Kotak persetujuan.");
  await expect(adjustNext.getByRole("link", { name: "Buka Kotak persetujuan", exact: true })).toHaveAttribute("href", new RegExp(`/clients/${id}/approvals\\?.*jenis=akrual`));

  // Flow 1: the board counts the three proposals and opens Kotak.
  const before = await boardCell(page, client);
  expect(before.text).toBe("3 usulan");
  await page.goto(kotak);
  await expect(page.getByRole("heading", { name: "Kotak persetujuan" })).toBeVisible();
  await expect(page.getByTestId("approvals-accrual")).toContainText("Vendor yang rutin tiap bulan tetapi belum ada di bulan ini.");
  await expect(accrualCards(page)).toHaveCount(3);
  for (const text of [BERSIH, TELKOM, ANDALAS]) await expect(card(page, text)).toHaveCount(1);
  await expect(card(page, PLN)).toHaveCount(0);
  const bersih = card(page, BERSIH);
  await expect(bersih).toContainText("Perlu ditinjau");
  await expect(bersih).toContainText("6190 Beban Umum Lain-lain");
  await expect(bersih).toContainText("Dibalik otomatis 1 Sep 2026");
  await expect(bersih).toContainText(/dibayar ke 6190 Beban Umum Lain-lain pada Apr, Mei, Jun dan Jul 2026 \(Rp 4\.200\.000 – Rp 4\.350\.000\)\. Agustus belum ada sampai 31 Agu 2026, dan rekening koran .+ sudah lengkap sampai tanggal itu\. Usulan: Rp 4\.200\.000, nilai tengah riwayat \(Jul 2026\)\./);
  await expect(card(page, ANDALAS)).toContainText("pada Mei, Jun dan Jul 2026 (Rp 7.500.000 tiap bulan)");

  // Lihat alasan: five steps, four months, the median's month and no AI; the CSV holds every history row as text and minor units.
  await bersih.getByTestId("reasoning-toggle").click();
  const panel = bersih.getByTestId("reasoning-panel");
  await expect(panel.getByTestId("reasoning-step")).toHaveCount(5);
  for (const label of ["Riwayat dibaca", "Aturan", "Bulan ini", "Nominal", "Belum dicatat"]) await expect(step(panel, label)).toHaveCount(1);
  for (const month of ["Apr 2026: Rp 4.200.000 (1 baris)", "Mei 2026: Rp 4.200.000 (1 baris)", "Jun 2026: Rp 4.350.000 (1 baris)", "Jul 2026: Rp 4.200.000 (1 baris)"]) await expect(step(panel, "Riwayat dibaca")).toContainText(month);
  await expect(step(panel, "Aturan")).toContainText("Tanpa AI: tidak ada yang dikirim ke model.");
  await expect(step(panel, "Nominal")).toContainText("Rp 4.200.000, nilai tengah riwayat (Jul 2026).");
  const [download] = await Promise.all([page.waitForEvent("download"), panel.getByTestId("reasoning-download").click()]);
  expect(download.suggestedFilename()).toMatch(/^alasan-akrual-.+\.csv$/);
  const rows = readFileSync((await download.path())!, "utf8").replace(/^\uFEFF/, "").trimEnd().split("\r\n");
  const history = rows.filter((r) => r.startsWith("Riwayat dibaca;Baris;"));
  expect(history.map((r) => r.split(";").slice(2, 8))).toEqual([
    [BERSIH, "2026-04-10", "Rp 4.200.000", "4200000", "IDR", "6190"],
    [BERSIH, "2026-05-10", "Rp 4.200.000", "4200000", "IDR", "6190"],
    [BERSIH, "2026-06-10", "Rp 4.350.000", "4350000", "IDR", "6190"],
    [BERSIH, "2026-07-10", "Rp 4.200.000", "4200000", "IDR", "6190"],
  ]);

  // 390 px, a panel open: no sideways page scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(accrualCards(page)).toHaveCount(3);
  await noSideScroll(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Flow 5: Ubah with amount 0 is refused under its field; nothing is posted and the card stays.
  const andalas = card(page, ANDALAS);
  await andalas.getByRole("button", { name: "Ubah", exact: true }).click();
  await andalas.getByLabel("Nominal", { exact: true }).fill("0");
  await andalas.getByRole("button", { name: "Setujui", exact: true }).click();
  await expect(andalas.getByText("Nominal harus lebih dari nol.", { exact: true })).toBeVisible();
  await expect(accrualCards(page)).toHaveCount(3);
  await andalas.getByRole("button", { name: "Batal ubah", exact: true }).click();

  // Flow 5: a Peninjau sees the cards and Lihat alasan, and not one action.
  await asPeninjau(page, browser, baseURL, client, async (viewer) => {
    await viewer.goto(kotak);
    await expect(viewer.getByRole("heading", { name: "Kotak persetujuan" })).toBeVisible();
    await expect(accrualCards(viewer)).toHaveCount(3);
    await expect(viewer.locator("main").getByRole("button", { name: /^(Setujui|Ubah|Tolak)$/ })).toHaveCount(0);
    const seen = card(viewer, TELKOM);
    await seen.getByTestId("reasoning-toggle").click();
    await expect(seen.getByTestId("reasoning-step")).toHaveCount(5);
  });

  // Flow 1: Setujui → the accrual and its reversal are posted, the card leaves, the board drops by one.
  await page.goto(kotak);
  await card(page, BERSIH).getByRole("button", { name: "Setujui", exact: true }).click();
  await expect(page.getByText("Akrual dicatat, dibalik 1 Sep 2026", { exact: true })).toBeVisible();
  await expect(card(page, BERSIH)).toHaveCount(0);
  expect((await boardCell(page, client)).text).toBe("2 usulan");
  await page.goto(`/clients/${id}/journals?period=2026-08`);
  const accrual = page.getByTestId("journal-entry").filter({ hasText: `Akrual ${BERSIH} Agu 2026` });
  await expect(accrual).toHaveCount(1);
  await expect(accrual.getByTestId("entry-origin")).toHaveText(`Asal: Usulan akrual (riwayat ${BERSIH})`);
  await page.goto(`/clients/${id}/journals?period=2026-09`);
  await expect(page.getByTestId("journal-entry").filter({ hasText: `Pembalik: Akrual ${BERSIH} Agu 2026` })).toHaveCount(1);

  // Flow 2: Telkom changed to Rp 450.000 (credit 2150 kept) and approved; Andalas refused.
  await page.goto(kotak);
  const telkom = card(page, TELKOM);
  await telkom.getByRole("button", { name: "Ubah", exact: true }).click();
  await expect(telkom.getByRole("combobox", { name: "Akun kredit", exact: true })).toContainText("2150 Beban Masih Harus Dibayar");
  await telkom.getByLabel("Nominal", { exact: true }).fill("450.000");
  await telkom.getByRole("button", { name: "Setujui", exact: true }).click();
  await expect(page.getByText("Akrual dicatat, dibalik 1 Sep 2026", { exact: true }).first()).toBeVisible();
  await expect(card(page, TELKOM)).toHaveCount(0);
  await card(page, ANDALAS).getByRole("button", { name: "Tolak", exact: true }).click();
  await expect(page.getByText("Usulan akrual ditolak untuk Agustus 2026", { exact: true })).toBeVisible();
  await page.reload();
  await expect(accrualCards(page)).toHaveCount(0);
  await expect(page.getByTestId("next-step")).toContainText("Tidak ada usulan menunggu persetujuan untuk Agustus 2026.");
  await page.goto(`/clients/${id}/journals?period=2026-08`);
  await expect(page.getByTestId("entry-origin").filter({ hasText: `Usulan akrual (riwayat ${TELKOM}) diubah dari Rp 500.000` })).toHaveCount(1);

  // A September statement without Andalas: September's Kotak proposes it again.
  const september: Row[] = [["10/09/2026", BERSIH, 4_200_000], ["12/09/2026", PLN, 2_300_000], ["14/09/2026", TELKOM, 500_000]];
  await upload(page, id, "qa-akrual-sep.csv", statement("01/09/2026 - 30/09/2026", closing, september));
  await page.goto(`/clients/${id}/approvals?period=2026-09&jenis=akrual`);
  await expect(accrualCards(page)).toHaveCount(1);
  await expect(card(page, ANDALAS)).toContainText("Usulan akrual");
  await expect(card(page, ANDALAS)).toContainText("Rp 7.500.000");
});

test("flow 3: a late August payment still in Review removes the card without a click; a statement ending 25 Aug proposes nothing", async ({ page }) => {
  const { id, closing } = await qaClient(page, "QA Akrual Terlambat");
  const kotak = `/clients/${id}/approvals?period=2026-08`;
  await page.goto(kotak);
  await expect(card(page, BERSIH)).toHaveCount(1);
  // The late line: a simple guess (Bersih's 6190 was accepted unchanged, so nothing was learned) lands in Review on 1999.
  await upload(page, id, "qa-akrual-terlambat.csv", statement("30/08/2026 - 31/08/2026", closing, [["30/08/2026", BERSIH, 4_200_000]]));
  await page.goto(kotak);
  await expect(page.getByTestId("approval-bank").filter({ hasText: BERSIH })).toHaveCount(1);
  await expect(card(page, BERSIH)).toHaveCount(0);
  await expect(accrualCards(page)).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await noSideScroll(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // August covered only through the 25th: a missing statement is not a missing vendor.
  const partial = await qaClient(page, "QA Akrual Sebagian", "25/08/2026");
  await page.goto(`/clients/${partial.id}/approvals?period=2026-08`);
  await expect(page.getByRole("heading", { name: "Kotak persetujuan" })).toBeVisible();
  await expect(accrualCards(page)).toHaveCount(0);
  await expect(page.getByTestId("approvals-accrual")).toHaveCount(0);

  // An accrual's *Unduh nilai (CSV)* answers for its own client only: under another client it is 404.
  await page.goto(kotak);
  await card(page, TELKOM).getByTestId("reasoning-toggle").click();
  const csvHref = (await card(page, TELKOM).getByTestId("reasoning-download").getAttribute("href"))!;
  expect(csvHref).toMatch(new RegExp(`^/clients/${id}/approvals/alasan\\?item=ACCRUAL`));
  expect((await page.request.get(csvHref)).status()).toBe(200);
  expect((await page.request.get(csvHref.replace(`/clients/${id}/`, `/clients/${partial.id}/`))).status()).toBe(404);
});
