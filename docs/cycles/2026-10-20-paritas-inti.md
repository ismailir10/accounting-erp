# Core accounting parity, round two: the hard end-to-end walk, Nomor bukti, Neraca Lajur

**Roadmap:** core accounting parity with Jurnal and Zahir (`docs/roadmap.md` §3). On 2026-10-20 the owner asked for "a hard end to
end test, make sure we are on par with Jurnal and Zahir on the core accounting feature", to keep iterating until the work is
something to be proud of, and to keep going without waiting. This record treats that message as the approval of the scope below and
logs every decision taken on the owner's behalf.

## Context
Round one (cycles of 2026-10-16: *Bagan akun*, *Jurnal Penyesuaian*, *Jurnal Umum*, *Anggaran*) brought the chart, adjusting journals,
the journal register and the ledger workbooks. It listed as non-goals journal numbering, attachments, archiving, sub-accounts,
recurring multi-line journals and custom date ranges.

This round starts with a test, not a feature: a fresh client walked through the real app as an accountant would, across a year end,
with every number computed by hand first (`e2e/siklus-akuntansi.spec.ts`):
- Saldo Awal on 31 Oct 2025 (bank, petty cash, a receivable, a payable, a partly depreciated fixed asset, capital, Saldo Laba), with the
  receivable and payable detailed as Saldo Awal items and the asset registered from Saldo Awal.
- November, December 2025 and January 2026 statements imported; lines classified in Review; the opening receivable and payable settled
  from the statement; a petty-cash expense and an accrual with *Balik otomatis* typed in Jurnal Penyesuaian; depreciation posted from
  its schedule each month; a December sales invoice with PPN settled in January.
- November and December closed (control notes written, checklist ticked, locked); January left open.
- Checked by hand: Laba Rugi per month and year to date, Neraca with its Saldo Awal column, Perubahan Ekuitas, Arus Kas (indirect),
  Neraca Saldo, Buku Besar, Jurnal Umum, the year-end roll of the result into Saldo Laba, and that a closed month refuses a journal.

The walk found two defects:
1. **Buku Besar 3200 Saldo Laba disagreed with the Neraca Saldo after a year end.** In January 2026 the trial balance opened Saldo Laba
   at Rp 99.550.000 (58.000.000 + the 2025 result of 41.550.000), the Neraca and the Excel Buku Besar agreed, but the on-screen Buku
   Besar opened at Rp 58.000.000: the drill-down from a report line showed a different number.
2. **A journal or invoice dated on or before Saldo Awal was accepted.** Saldo Awal already holds every balance up to its date, Saldo
   Laba included, so such an entry counts those months twice and silently changes the Neraca's Saldo Awal column.

Measured against the incumbents, two core gaps remain that an accountant meets every day:
- **No voucher number.** Every Jurnal transaction and every Zahir *bukti* carries a number (*no. bukti*) that the client, the auditor
  and the working papers refer to. A Buku journal has none: the only handle is its date and memo.
- **No Neraca Lajur.** The ten-column worksheet (Neraca Saldo → Penyesuaian → Neraca Saldo Disesuaikan → Laba Rugi → Neraca) is the
  working paper every Indonesian accountant is taught and that small firms still hand to the partner. Buku has every number it needs
  (adjusting journals are their own kind) but no page shows them that way.

Who feels it: the accountant (a number to quote, a worksheet to review), the partner reviewing the month, and the auditor asking for
"bukti JP-2512-0003".

## Decisions
- **Nomor bukti on every journal.** `JournalEntry.number`, assigned by `postJournal()` (the only writer) inside the posting
  transaction, never changed afterwards (DB trigger), unique per company.
  - Format `PREFIX-YYMM-NNNN`, a series per company, prefix and month (Indonesian vouchers restart monthly; the month in the number is
    the entry's own month). Prefixes: `SA` Saldo Awal, `BM` bank masuk / `BK` bank keluar (by the bank line's side), `RK` reklasifikasi,
    `JP` jurnal penyesuaian (every adjustment, reversal and schedule instalment), `JI` impor buku besar, `FJ` faktur penjualan / `FB`
    tagihan pembelian.
  - The counter row is incremented in the same transaction, so a rolled-back post leaves no gap and two posts at once get two numbers.
    Deleting an import leaves gaps; that is visible and honest, as in the incumbents.
  - Existing journals are numbered by the migration in date order (then creation order) per series.
  - Shown wherever a journal is shown: Jurnal Umum (header of each journal), Buku Besar rows and the journal drawer, Terakhir dicatat on
    Jurnal Penyesuaian; carried in the Excel Jurnal Umum and Buku Besar. The Jurnal Umum search finds a journal by its number.
- **Neraca Lajur** as a view of *Neraca Saldo* (`?view=lajur`), month or year to date like the page, with Excel:
  - Neraca Saldo (before adjustments) = closing balance minus the period's `ADJUSTMENT` entries; Penyesuaian = those entries' debit and
    credit; Neraca Saldo Disesuaikan = closing; then the closing of P&L accounts under Laba Rugi and of the others under Neraca, with the
    period's profit as the balancing line of both, so each pair of columns totals equal.
  - "Penyesuaian" means Jurnal Penyesuaian and its kin (`ADJUSTMENT`: typed journals, reversals, schedules, tax and lease postings);
    bank lines, reclassifications, invoices and imports are the books before adjustment.
  - Single-currency scopes only, as the movement view of Neraca Saldo.
- **Bug fixes:** Buku Besar of the Saldo Laba account opens with earlier years' result folded in, labelled "termasuk laba (rugi)
  tahun-tahun lalu"; Jurnal Penyesuaian (and so approved accruals and waiting journals) and new invoices dated on or before the
  company's Saldo Awal date are refused with the date to use; Saldo Awal can't be dated on or after a journal already in the books.
- **Petty cash templates** in Jurnal Penyesuaian: *Kas kecil keluar* (beban / 1110) and *Kas kecil masuk* (1110 / pendapatan), the
  incumbents' *kas keluar / kas masuk* for money that never touches a statement.
- **The end-to-end walk becomes a regression spec** with its hand-computed figures as assertions.
- **Adversarial scenarios beside the walk** (added while building, same approval): two worker passes wrote DB-level scenarios with
  hand-computed figures over reports and close, and over subledgers, tax and FX. Their 13 findings (two the same as the walk's) are fixed
  in this cycle, each with its reproducer kept as a regression test (`tests/db/report-edge-cases.test.ts`,
  `tests/db/subledger-edge-cases.test.ts`):
  - a journal or a second company's Saldo Awal posted into an earlier, still-open empty month changed a locked later month's Neraca →
    **a locked month now freezes every month before it** (`postJournal`, the DB guard, import removal and ledger-import checks);
  - Saldo Awal holding income or expense balances made the Laba Rugi disagree with the equity statement and cash flow of the same
    labelled period → **Saldo Awal accepts balance-sheet accounts only** (the result to date is typed on 3200; a full-year P&L comes from
    a ledger import);
  - PPN lebih bayar carried across 31 December vanished from February's masa on; FX revaluation retranslated non-monetary items and
    posted twice on a double click; the PPh badan pack kept a depreciation correction on a disposal; three cash-flow classifications
    (intercompany loan given and repaid, a buyer's deposit before a disposal, an earlier year's disposal collected); a disposal refused
    forever after its depreciation month was closed without the instalment.

## Acceptance criteria
- [x] `e2e/siklus-akuntansi.spec.ts` walks Saldo Awal → three months → year end → reports and asserts the hand-computed figures listed
      in Context, including Buku Besar 3200 in January = Neraca Saldo.
- [x] A Jurnal Penyesuaian or a new invoice dated on or before Saldo Awal is refused with the reason; the day after posts.
- [x] Every new journal gets a number of the right prefix and month; numbers run 0001, 0002… per series, survive nothing being
      rewritten (DB refuses a change), and existing journals have numbers after the migration.
- [x] The number shows on Jurnal Umum, Buku Besar (row and drawer) and Terakhir dicatat, is in both Excel workbooks, and the Jurnal
      Umum search finds a journal by it.
- [x] Neraca Lajur shows the five column pairs, each pair balanced, the adjusted column equal to Neraca Saldo, profit equal to Laba Rugi;
      Excel the same with formulas.
- [x] Kas kecil templates fill the form.
- [x] Full gate green; `verify:books` ALL PASS.

## Non-goals
- Custom date ranges (decided against in the Jurnal Umum cycle: the close treats a month as a unit).
- Attachments on journals, account archiving and sub-accounts, recurring multi-line journals, departments/projects: candidates for a
  next round, each with its own migration.
- Renumbering, or a number typed by the accountant (the incumbents allow an override; a typed number would break the series' proof).

## Gate re-openers
- Migrations, additive only: `20261020100000_journal_number` (one column, one counter table, backfill, the entry trigger keeps a number)
  and `20261020110000_lock_freezes_earlier` (the lock check covers earlier months). No DROP or rename.
- `postJournal()` changes (it assigns the number; it refuses a write before a locked month): accounting-invariant areas, both
  tightened, none relaxed. Recorded in `accounting-rules` §2, §4, §5, §6b and the tax and cash-flow rules.

## Tasks
- [x] T1 Hard end-to-end walk; record the defects (this record).
- [x] T2 Fix: Buku Besar Saldo Laba opening after a year end.
- [x] T3 Fix: nothing typed by hand on or before Saldo Awal; Saldo Awal holds balance-sheet accounts only.
- [x] T4 Nomor bukti: schema + migration + backfill + trigger, `postJournal()`, tests.
- [x] T5 Nomor bukti on screen and in Excel; search by number.
- [x] T6 Neraca Lajur view + Excel.
- [x] T7 Kas kecil templates.
- [x] T8 Regression spec with assertions; README, deck claims.
- [x] T9 A locked month freezes the months before it (found by the adversarial scenarios).
- [x] T10 The other adversarial findings: PPN carry, FX revaluation, PPh badan disposal, cash flow, disposal after a closed month.

## Implementation
- `62fbe5b` fix(reports): Buku Besar of Saldo Laba opens with earlier years' result — `accountLedger` folds the prior-year result for the
  retained account (`priorYearProfit`), the row says so (`ledger-prior-year`).
- `4b14686` fix(ledger): nothing typed by hand lands inside Saldo Awal — `lib/ledger/opening-date.ts` (`assertAfterOpening`) in
  `prepareAdjustment` and `createInvoice`; `postOpening` refuses a date on or after a journal already typed, and income/expense lines.
- `74e9d1c` feat(ledger): nomor bukti — `lib/ledger/number.ts`, `JournalSequence`, `JournalEntry.number`, migration backfill, shown and
  searched; Excel columns.
- `7c6ee5d` fix(close): a locked month freezes the months before it — `lockedAfter` in `postJournal`/`checkJournal`, the DB guard,
  `lib/imports/remove.ts`, ledger-import `PERIOD_LOCKED`.
- `894bfcd` fix: the adversarial findings — `lib/tax/masa-report.ts`, `lib/fx/revalue.ts`, `lib/tax/pack.ts` + `assetRegister`
  (`disposalDifference`), `lib/reports/statements.ts`, `lib/assets/dispose.ts`.
- `fa2c369` feat(reports): Neraca Lajur — `lib/reports/worksheet.ts`, `components/app/worksheet-table.tsx`, `?bentuk=lajur` on Neraca
  Saldo and its export.
- `e009d55` feat(journals): kas kecil templates.
- `79c8ca5` test(e2e): a whole accounting cycle across a year end.

Decisions taken while building (logged for the owner):
- Branch: the harness names this session's branch (`claude/wonderful-volta-paxq4c`); the repo profile's `task/<slug>` could not be used.
- Neraca Lajur's adjustments are the `ADJUSTMENT` kind only; reclassifications of bank lines count as the books before adjustment,
  because they finish classifying a bank row rather than adjust the books.
- A mid-year client's results to date go to Saldo Laba in Saldo Awal; a firm that wants a full-year Laba Rugi imports the ledger. The
  incumbents allow income balances in an opening; Buku refuses them because its statements are labelled from the day after.

## Verification
Verified locally — `04e550e` (code; later commits are docs only).
- `npm run lint` exit 0; `npm run typecheck` exit 0.
- `npm test` on a fresh `buku_test`: `Test Files  332 passed (332)` · `Tests  3055 passed (3055)`.
- `npm run build` exit 0; `npm run demo:reset` then `npm run verify:books`: `ALL PASS — 1765 pemeriksaan saldo cocok dengan ground truth.`
- `npm run db:drift`: `✓ Database tables match prisma/schema.prisma.` (migrations applied to the local database, backfill numbered all
  487 seeded journals, no gaps: Σ counters = 487).
- `npm run test:e2e` on the production build (`next start -p 3200`, CI's env: `APP_URL=http://localhost:3200`, `SETTINGS_SECRET`):
  `132 passed (16.9m)`, including `e2e/siklus-akuntansi.spec.ts`.
- Walked by hand at 1440 px: Neraca Lajur December 2025 (year to date) — adjustments 6.500.000 = 6.500.000, adjusted 263.200.000 =
  Neraca Saldo, profit 41.550.000 balancing Laba Rugi and Neraca; Jurnal Umum search `jp-2512-2` → `JP-2512-0002`; Buku Besar rows
  with their numbers; Buku Besar 3200 in January 2026 opening 99.550.000 with "termasuk laba (rugi) tahun-tahun lalu 41.550.000". The
  deck slide at 375 px.
- A first local e2e run failed three specs on environment alone (no `SETTINGS_SECRET`, auth mails pointing at :3000); rerun with CI's
  environment: all pass.

## Ship Notes
- PR: https://github.com/ismailir10/accounting-erp/pull/176 (draft → ready with the `e2e` label after verify-local).
- Deck: kantor slide 12 *Laporan* names the numbered Jurnal Umum and the Neraca Lajur; PDFs regenerated.
- Production: the two migrations are applied by the owner before merging (backfill numbers every journal; trigger functions replaced).
