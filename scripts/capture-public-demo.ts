/**
 * Saved public product evidence, captured through the real local app without changing the books.
 * Prerequisite: the local synthetic seed and demo login already exist; run the production app on :3200.
 * PW_CHROMIUM=/opt/pw-browsers/chromium npx tsx scripts/capture-public-demo.ts
 * Optional BASE_URL accepts loopback HTTP only. Never starts servers, reseeds, or calls an AI action.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect, type Locator, type Page } from "@playwright/test";

const OUTPUT = join(process.cwd(), "public/product");
const PERIOD = "2026-08";
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
let phase = "local environment checks";

function localUrl(value: string | undefined, label: string, http = false) {
  assert(value, `${label} must be configured locally.`);
  const url = new URL(value);
  assert(LOCAL.has(url.hostname), `${label} must use a loopback host; hosted targets are refused.`);
  assert(!http || url.protocol === "http:", `${label} must use local HTTP.`);
  return url;
}

async function stable(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
}

async function main() {
  // Validate before importing the DB module: its singleton opens a connection on import.
  assert.equal(process.env.DEMO_MODE, "true", "Capture requires DEMO_MODE=true.");
  const target = localUrl(process.env.BASE_URL ?? "http://localhost:3200", "BASE_URL", true);
  assert(!target.username && !target.password && target.pathname === "/" && !target.search && !target.hash, "BASE_URL must be a bare local origin.");
  const databaseUrl = process.env.POSTGRES_PRISMA_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  const database = localUrl(databaseUrl, "Database");
  assert(["postgres:", "postgresql:"].includes(database.protocol), "Capture requires local Postgres.");
  // pg-connection-string permits ?host= to override the URI hostname. A capture never needs
  // connection options; reject them all rather than validate a different host than the driver uses.
  assert(!database.search && !database.hash, "Capture database URL must have no query options or fragment.");
  localUrl(process.env.NEXT_PUBLIC_SUPABASE_URL, "Auth", true);
  const email = process.env.DEMO_ADMIN_EMAIL;
  const password = process.env.DEMO_ADMIN_PASSWORD;
  assert(email && password, "Existing DEMO_ADMIN_EMAIL and DEMO_ADMIN_PASSWORD are required.");

  const [{ createPrisma }, { scenarios, statementFiles }, { renderStatement }, { parseStatement }, { verifyBooks }, { trialBalanceMovement }, { runControls }, { formatMoney }] = await Promise.all([
    import("@/lib/db"), import("@/lib/demo/scenario"), import("@/lib/demo/writers"),
    import("@/lib/import/parsers"), import("@/lib/demo/verify"), import("@/lib/reports/ledger"),
    import("@/lib/controls"), import("@/lib/money"),
  ]);
  const db = createPrisma(databaseUrl);
  try {
    phase = "synthetic fixture and source verification";
    const firms = await db.firm.findMany({ where: { name: "KJA Demo & Rekan" }, include: { clients: { include: { entities: true } } } });
    assert.equal(firms.length, 1, "Exactly one KJA Demo & Rekan fixture must exist.");
    const firm = firms[0];
    const fixture = scenarios().find((s) => s.key === "grup-ayam")!;
    assert.deepEqual(firm.clients.map((c) => c.name).sort(), scenarios().map((s) => s.spec.name).sort(), "Demo firm must contain exactly the synthetic scenario clients.");
    const client = firm.clients.find((c) => c.name === fixture.spec.name)!;
    const entity = client.entities.find((e) => e.name === fixture.spec.entities[0].name)!;
    assert(entity && entity.functionalCurrency === "IDR", "Expected synthetic PT entity in IDR.");
    const member = await db.firmMember.findFirst({ where: { firmId: firm.id, email, disabled: false } });
    assert(member, "Demo login must be an enabled member of the synthetic firm.");
    const books = await verifyBooks(db);
    assert.equal(books.failures.length, 0, "The untouched synthetic fixture must match generator truth. Run verify:books separately to inspect failures.");

    // Validate every displayed source row against the rendered and parsed deterministic demo file,
    // not merely the firm name or a transaction's synthetic-looking description.
    const txs = await db.bankTransaction.findMany({
      where: { entityId: entity.id },
      include: { import: true, bankAccount: true, entries: { include: { lines: { include: { account: true } } } } },
      orderBy: [{ date: "asc" }, { rowNumber: "asc" }],
    });
    const expected = new Map<string, { rowNumber: number; rawRow: string; balance: bigint | null; fileName: string }>();
    const key = (number: string, date: Date, amount: bigint, description: string) => `${number}|${date.toISOString().slice(0, 10)}|${amount}|${description}`;
    for (const file of statementFiles(fixture).filter((f) => fixture.banks[f.bankKey].entity === 0)) {
      const rendered = await renderStatement(file);
      const parsed = await parseStatement(rendered.fileName, rendered.data);
      for (const row of parsed.rows) expected.set(key(file.accountNumber, row.date, row.amount, row.description), { ...row, fileName: rendered.fileName });
    }
    assert.equal(txs.length, expected.size, "Synthetic entity has an unexpected number of bank rows.");
    for (const tx of txs) {
      const row = expected.get(key(tx.bankAccount.number, tx.date, tx.amount, tx.description));
      assert(row && tx.firmId === firm.id && tx.import.firmId === firm.id, "Non-demo source row refused.");
      assert.equal(tx.rawRow, row.rawRow, "Source text must match the synthetic fixture.");
      assert.equal(tx.rowNumber, row.rowNumber);
      assert.equal(tx.balance, row.balance);
      assert.equal(tx.import.fileName, row.fileName);
    }
    const tx = txs.find((t) => t.date.toISOString().startsWith(PERIOD) && t.accountCode === "4100" && t.entries.some((e) => e.kind === "BANK"))!;
    assert(tx, "Seeded August sales journal is required.");
    const journal = tx.entries.find((e) => e.kind === "BANK")!;
    assert.equal(journal.bankTransactionId, tx.id);
    const debit = journal.lines.reduce((sum, l) => sum + l.debit, 0n);
    const credit = journal.lines.reduce((sum, l) => sum + l.credit, 0n);
    assert.equal(debit, credit);
    assert.equal(journal.lines.find((l) => l.account.id === tx.bankAccount.accountId)?.debit, tx.amount, "Bank leg must equal the positive source amount.");
    const rows = await trialBalanceMovement(db, { clientId: client.id, entityIds: [entity.id] }, new Date("2026-08-01T00:00:00Z"), new Date("2026-08-31T00:00:00Z"));
    const tbDebit = rows.reduce((sum, r) => sum + (r.net > 0n ? r.net : 0n), 0n);
    const tbCredit = rows.reduce((sum, r) => sum + (r.net < 0n ? -r.net : 0n), 0n);
    assert.equal(tbDebit, tbCredit);
    const controls = await runControls(db, client.id, 2026, 8);
    assert(controls.some((c) => c.status !== "PASS") && controls.some((c) => c.status === "PASS"), "Preserve genuine close blockers and passes; completed walkthrough data is refused.");
    const period = await db.period.findUnique({ where: { clientId_year_month: { clientId: client.id, year: 2026, month: 8 } } });
    assert.notEqual(period?.status, "LOCKED", "August must remain open so the public page shows an honest blocker.");

    const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : undefined);
    try {
      const context = await browser.newContext({ baseURL: target.origin, viewport: { width: 1440, height: 1700 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
      let signedIn = false;
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (!["data:", "blob:"].includes(url.protocol) && !LOCAL.has(url.hostname)) return route.abort("blockedbyclient");
        // The only mutation is the authorised existing demo login. After login every request is read-only.
        if (signedIn && !["GET", "HEAD", "OPTIONS"].includes(request.method())) return route.abort("blockedbyclient");
        await route.continue();
      });
      const page = await context.newPage();
      phase = "existing local demo login";
      await page.goto("/login");
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Kata sandi", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Masuk", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Beranda", exact: true })).toBeVisible({ timeout: 30_000 });
      signedIn = true;
      await expect(page.getByText(firm.name, { exact: true }).first()).toBeVisible();
      await mkdir(OUTPUT, { recursive: true });
      // The public page draws its illustrations from these verified values; each view is still opened and checked as the
      // accountant sees it, on desktop and phone, but nothing is saved as a screenshot.
      const capture = async (_name: string, locator: Locator, _description: string, bottom?: Locator) => {
        await stable(page);
        await expect(locator).toBeVisible();
        if (bottom) await expect(bottom).toBeVisible();
      };
      const scope = `period=${PERIOD}&entity=${entity.id}`;
      const base = `/clients/${client.id}`;
      const bankEvidence = async (mobile: boolean) => {
        phase = mobile ? "mobile source and journal capture" : "desktop source and journal capture";
        await page.goto(`${base}/ledger/4100?${scope}`);
        await expect(page.getByRole("heading", { name: "4100 Penjualan", exact: true })).toBeVisible();
        const ledgerRow = page.getByTestId("ledger-row").filter({ hasText: tx.description });
        await expect(ledgerRow).toHaveCount(1);
        await ledgerRow.getByRole("button").click();
        const sheet = page.getByRole("dialog");
        const source = page.getByTestId("source-row");
        await expect(source).toContainText(`${tx.import.fileName}, baris ${tx.rowNumber}`);
        await expect(source).toContainText(formatMoney(tx.amount, "IDR"));
        await expect(source.locator("pre")).toHaveText(tx.rawRow);
        const journalSection = sheet.locator("section").filter({ has: page.getByRole("heading", { name: "Jurnal", exact: true }) });
        for (const line of journal.lines) {
          const shown = journalSection.getByRole("row").filter({ hasText: line.account.code });
          await expect(shown).toContainText(line.account.name);
          for (const amount of [line.debit, line.credit].filter((a) => a !== 0n)) await expect(shown).toContainText(formatMoney(amount, "IDR", { bare: true }));
        }
        await capture(mobile ? "bank-journal-mobile.webp" : "bank-journal.webp", sheet, "Baris rekening koran demo dan jurnal terkait, nominal serta referensi sumber cocok.", journalSection);
        await capture(mobile ? "bank-source-mobile.webp" : "bank-source.webp", source, "Baris sumber rekening koran demo dengan nama file, nomor baris, dan nominal asli.", source.locator("pre"));
        await capture(mobile ? "journal-detail.webp" : "journal.webp", journalSection, "Rincian debit dan kredit jurnal dari baris demo yang sama.");
      };
      await bankEvidence(false);
      phase = "desktop trial balance capture";
      await page.goto(`${base}/trial-balance?${scope}`);
      await expect(page.getByRole("heading", { name: "Neraca Saldo", exact: true })).toBeVisible();
      const footer = page.locator("tfoot");
      await expect(footer).toContainText("Seimbang");
      const footerCells = footer.locator("td");
      await expect(footerCells.nth(-2)).toHaveText(formatMoney(tbDebit, "IDR", { bare: true }));
      await expect(footerCells.last()).toHaveText(formatMoney(tbCredit, "IDR", { bare: true }));
      await capture("trial-balance.webp", page.locator("#workspace-main"), "Neraca Saldo PT Ayam Nusantara Digital, Agustus 2026, dengan total seimbang dari buku demo.");
      await capture("trial-balance-totals.webp", footer, "Total debit dan kredit Neraca Saldo demo yang seimbang.");
      const closeEvidence = async (mobile: boolean) => {
        phase = mobile ? "mobile close controls capture" : "desktop close controls capture";
        await page.goto(`${base}/close?period=${PERIOD}`);
        await expect(page.getByRole("heading", { name: "Tutup Buku", exact: true })).toBeVisible();
        await expect(page.getByTestId("lock")).toBeDisabled();
        // Expanding the native disclosure is a view action; it records no sign-off or book change.
        await page.getByTestId("passed-controls").first().locator("summary").click();
        const panel = page.locator("div.grid").filter({ has: page.getByTestId("lock") }).last();
        await expect(panel).toContainText("Lolos");
        await expect(panel).toContainText("Perlu dicek");
        await capture(mobile ? "close-checklist-mobile.webp" : "close-checklist.webp", panel, "Kontrol Tutup Buku Grup Ayam Nusantara Agustus 2026, dengan masalah asli, kontrol lolos, dan daftar periksa akuntan.");
        if (mobile) {
          const firstBlocker = page.locator('[data-testid^="control-"]').filter({ hasText: "Perlu dicek" }).first();
          await capture("close-blocker-detail.webp", firstBlocker, "Rincian kontrol demo yang masih perlu dicek sebelum buku ditutup.");
          const firstPass = page.locator('[data-testid^="control-"]').filter({ hasText: "Lolos" }).first();
          await capture("close-pass-detail.webp", firstPass, "Kontrol Neraca Saldo demo yang lolos, dengan debit sama dengan kredit.");
        }
      };
      await closeEvidence(false);
      await page.setViewportSize({ width: 390, height: 2200 });
      await bankEvidence(true);
      phase = "mobile trial balance capture";
      await page.goto(`${base}/trial-balance?${scope}`);
      await expect(page.getByRole("heading", { name: "Neraca Saldo", exact: true })).toBeVisible();
      await capture("trial-balance-mobile.webp", page.locator("#workspace-main"), "Neraca Saldo demo pada lebar telepon, kolom saldo debit dan kredit tetap terbaca.");
      await capture("trial-balance-totals-mobile.webp", page.locator("tfoot"), "Total seimbang dari Neraca Saldo demo pada lebar telepon.");
      await closeEvidence(true);
      const manifest = {
        label: "Data demonstrasi sintetis — perusahaan, nama, rekening, dan angka rekaan.",
        command: "PW_CHROMIUM=/opt/pw-browsers/chromium npx tsx scripts/capture-public-demo.ts",
        period: PERIOD, firm: { id: firm.id, name: firm.name }, client: { id: client.id, name: client.name },
        reportEntity: { id: entity.id, name: entity.name, currency: "IDR" },
        source: { bankTransactionId: tx.id, journalEntryId: journal.id, date: tx.date.toISOString().slice(0, 10), description: tx.description, fileName: tx.import.fileName, rowNumber: tx.rowNumber, amount: tx.amount.toString(), journalDebit: debit.toString(), journalCredit: credit.toString(), lines: journal.lines.map((l) => ({ code: l.account.code, name: l.account.name, debit: l.debit.toString(), credit: l.credit.toString() })) },
        trialBalance: { debit: tbDebit.toString(), credit: tbCredit.toString(), source: "JournalLine via trialBalanceMovement; UI footer checked against these totals." },
        close: { scope: "All entities in Grup Ayam Nusantara", controls: controls.map((c) => ({ key: c.key, scope: c.scope, title: c.title, status: c.status, detail: c.detail })), lockEnabled: false },
        assertions: { generatorBookChecks: books.checks, syntheticSourceRowsVerified: txs.length, matchingSourceAndBankLeg: true, balancedJournal: true, balancedTrialBalance: true, genuineCloseBlockersAndPasses: true, noBookWritesOrModelActions: true },
      };
      await writeFile(join(OUTPUT, "capture-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(JSON.stringify({ period: PERIOD, assertions: manifest.assertions }, null, 2));
    } finally { await browser.close(); }
  } finally { await db.$disconnect(); }
}

main().catch((error: unknown) => {
  // Never print DB/auth objects or credentials, including connection errors with a URL.
  console.error(error instanceof assert.AssertionError ? error.message : `Public demo capture failed during ${phase}. Inspect the local app and fixture setup; no credentials were printed.`);
  process.exitCode = 1;
});
