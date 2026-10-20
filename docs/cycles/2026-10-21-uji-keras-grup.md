# Core accounting parity, round five: a hard test of groups, foreign currency and subledgers

**Roadmap:** core accounting parity with Jurnal and Zahir (`docs/roadmap.md` §3, GL integrity and Reports rows), under the owner's
request of 2026-10-20 to keep testing hard until Buku is on par. [Round one](2026-10-20-paritas-inti.md) walked one Rupiah company across
a year end and found 15 defects; this round takes the shapes it did not touch.

## Context
Jurnal sells a combined multi-company view and Zahir multi-currency; an accounting firm's clients are often a group (PT + CV + the owner)
with money between them, a company keeping dollar accounts, and receivables and payables that run across a year end. A wrong number in
any of these reaches a sent report. Round one proved the single-company spine; nothing yet has been proved end to end for:
- **Groups:** intercompany (1190) on both sides, the combined worksheet and statements, eliminations, a company closed while another is
  open, the owner's personal books beside the company's.
- **Foreign currency:** a Rupiah company with USD bank and receivable lines, Kurs, month-end revaluation and its reversal, settlement at
  another rate (realised difference), a company kept in USD, statements in each currency and combined.
- **Subledgers across a year end:** sales and purchase invoices with PPN and PPh withheld, partial and over-payments, voids, aging, the
  subledger-vs-GL control, a fixed asset bought, depreciated and disposed mid-year, the stock count.

Who feels it: the accountant whose group pack does not foot, the partner signing it, the client's bank reading the combined Neraca.

## Decisions
- **Hunt, then fix.** Each area is probed at the database level as an adversarial reviewer would: build the case through the real writers
  (`postJournal`, imports, invoice, asset, FX and close functions), compute every expected figure by hand first, and assert the reports
  (TB, Laba Rugi, Neraca, cash flow, combined worksheet, subledger aging, Excel set) against it. A defect is a failing test that names
  the wrong number and the right one.
- **Every confirmed defect is fixed in this round with its test kept** as a regression test (`tests/db/`), as in round one. A probe that
  passes is kept too when it covers a case no test had.
- A finding that is a product decision rather than a defect (two defensible treatments) is logged under *Decisions taken while building*
  with the treatment chosen and why, never silently changed.
- No new module, no schema change unless a defect needs one (then it is named under Gate re-openers before it is built).

## Acceptance criteria
- [x] Each of the three areas has a hand-computed probe through the real writers, kept in `tests/db/`.
- [x] Every defect found has a fix and a regression test; the list is in *Implementation* (the per-counterparty gap goes to its own cycle).
- [x] Full gate green; `verify:books` ALL PASS.

## Non-goals
- Departments/projects (next round).
- New report layouts; UI changes beyond what a fix needs.

## Gate re-openers
- None planned. A fix that touches `postJournal()`, a DB guard or a migration is named here before it is built.

## Tasks
- [x] T1 Probes: groups and intercompany (17); foreign currency (16); subledgers across a year end (22).
- [x] T2 Fixes with regression tests, one commit per defect family.
- [x] T3 README / accounting-rules where a rule became clearer; cycle doc.

## Implementation
Three probes ran in parallel, each on its own test database, writing only tests: 55 cases built through the real writers with every
figure computed by hand. 24 failed: 19 defects fixed here (8 foreign currency, 8 subledgers, 3 the joining company), 3 the per-counterparty
gap carried to the next cycle (it needs a schema change), 2 ruled a decision (what Gabungan eliminates).

`04c43b5` fix(fx) — eight defects (`tests/db/fx-hard.test.ts`, 16 cases):
1. The cash flow counted an unrealised FX gain on a dollar bank account as operating cash, and a USD loan's revaluation as loan cash
   received. A revaluation now moves no cash (PSAK 207): its cash part is *Pengaruh perubahan kurs terhadap kas* (`fxEffect`) outside
   the sections, the unrealised 7200 a non-cash adjustment, the revalued receivable or loan out of its section.
2. A USD time deposit on 1260 (`ACCOUNT_CODES.DEPOSIT`) was never revalued (the whole *Aset tidak lancar lain* line was non-monetary).
3. An inverted rate kept 10 decimals: Rp 10 miliar in a USD company revalued 37 cents off. Now 18 significant digits.
4. The revaluation memo printed minor units ("USD 100000 @ 15500"); now "USD 1.000,00 × kurs 15.500".
5. A dollar balance entered as Saldo Awal had no USD amount, so revaluation saw only later movements. Saldo Awal lines take the foreign
   amount (*Saldo dalam valas?*), posted at the implied rate.
6. With a financial year ending in March, the year's P&L before 1 January made the average rate look unneeded and the closing rate was
   used. `hasYearPl`, `averageRate` and the rate list read the financial year.
7. A ledger import (CONVERT) used any older Kurs rate, three years stale. Now the row's month or the month before, else `MISSING_RATE`.

`657b505` fix(subledgers) — eight defects (`tests/db/subledger-hard-{ar,assets,inventory}.test.ts`, 22 cases):
1. A December advance could not be applied to a January invoice once December was closed (the invoice aged as overdue for ever).
2. The CALK aging note and 3. the credit pack's Umur Piutang / Utang did not tie to the Neraca line when a customer held an advance.
4. The Piutang page at a past date dropped an advance that was applied later from the unmatched list.
5. The credit pack's Aset Tetap sheet hid an asset sold after the pack's month.
6. A bill paid across a year end left its investing outflows 1 Rupiah short of the cost (rounding per year).
7. Books opened mid-year counted a full year of fiscal depreciation against half a year's profit in the tax pack.
8. Mutasi vs Omzet counted disposal proceeds as business receipts.

`18a6a03` fix(reports) — the joining company (`tests/db/groups-hard.test.ts`, 12 cases): a CV opening in May beside a PT kept since
January was folded into the group's opening ("Saldo 31 Mei" 580 where the group held 640, in equity and cash flow), and the comparative
column called the PT's year-end close a Saldo Awal. A later Saldo Awal now stays apart (*Ekuitas / Kas entitas yang bergabung*).

Decisions taken while building:
- **1260 is monetary.** It is where Buku files deposits and placements (`ACCOUNT_CODES.DEPOSIT`, the ledger mapping's "penempatan"); a
  foreign equity investment there would be revalued too — rarer for these clients than a dollar deposit, and visible in the proposal.
- **Gabungan stays an aggregation** (accounting-rules 11, "not SAK consolidation"): only 1190 is eliminated. Intra-group income and
  expense (a management fee) and the owner's investment in the PT stay summed; the page note and the CALK now say so. Eliminating them
  needs an intra-group flag on accounts — a product decision for the owner, not a defect fix.
- **Stale import rates:** the row's month or the month before (a rate typed at the previous month end converts this month's rows); the
  Kurs page's closing rate stays same-month.
- **An advance after a close** applies only when no tax is withheld: the tax leg posts in the line's (closed) month.

Gap carried to the next cycle (needs a schema change, Gate re-opener):
- **One 1190 per client nets every related party.** PT's own Neraca offsets a receivable from the CV against a payable to the owner
  (no right of set-off between different parties), PT's own cash flow nets lending to the CV (investing) with borrowing from the owner
  (financing), and two broken pairs that offset make the intercompany control PASS. The fix is an intercompany account per counterparty
  entity, matched and eliminated per pair. Its three probes are kept for that cycle.

## Verification
Verified locally — 18a6a03.
- `npm run lint && npm run typecheck && npm test`: exit 0; **340 files, 3121 tests passed** (dedicated test database), the 50 hard cases
  among them (`fx-hard` 16, `subledger-hard-*` 22, `groups-hard` 12).
- `npm run build && npm run demo:reset && npm run verify:books`: build OK; **ALL PASS — 1765 checks**.
- `npm run test:e2e` on the production build with CI's env: **135 passed (15.5m)**.
- Looked at Saldo Awal at 1280 px: *Saldo dalam valas?* under a line's account opens the currency and the amount, *Bukan valas* closes it.

## Ship Notes
