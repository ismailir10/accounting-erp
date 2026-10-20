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
- [ ] Each of the three areas has a hand-computed probe through the real writers, kept in `tests/db/`.
- [ ] Every defect found has a fix and a regression test; the list is in *Implementation*.
- [ ] Full gate green; `verify:books` ALL PASS.

## Non-goals
- Departments/projects (next round).
- New report layouts; UI changes beyond what a fix needs.

## Gate re-openers
- None planned. A fix that touches `postJournal()`, a DB guard or a migration is named here before it is built.

## Tasks
- [ ] T1 Probes: groups and intercompany; foreign currency; subledgers across a year end.
- [ ] T2 Fixes with regression tests, one commit per defect family.
- [ ] T3 README / accounting-rules where a rule became clearer; cycle doc.

## Implementation

## Verification

## Ship Notes
