# Jurnal Penyesuaian: line notes, automatic reversal, Salin

**Roadmap:** core accounting parity with Jurnal and Zahir (`docs/roadmap.md` §3). The owner asked on 2026-10-16 for Buku to be on par
with Jurnal and Zahir and better on the core accounting features, and delegated the decisions ("i trust your judgment").

## Context
The manual journal is where an accountant spends the close's last hour: accruals, reclassifications, corrections. Jurnal's *Jurnal
Umum* entry and Zahir's *Jurnal Memorial* both give each line its own description, and both have a way to repeat last month's journal
(Jurnal: *transaksi berulang*; Zahir: copy). Accruals are reversed at the start of the next month in every package. Buku's Jurnal
Penyesuaian has one memo for the whole entry, no line notes in the UI (the ledger stores them), no way to start from an earlier journal,
and an accrual is reversed by hand later from the Buku Besar drawer (*Balik jurnal*), which is easy to forget and then double-counts the
cost in the next month.

Who feels it: the accountant at month end (typing the same accruals every month, remembering to reverse them), and the reviewer reading
a journal whose lines don't say what they are.

## Decisions
- **Catatan baris**: each line of the form takes an optional note (≤ 200 characters), stored on the journal line. It shows under the
  account in Buku Besar's journal drawer (and in Jurnal Umum once that page ships).
- **Balik otomatis pada 1 <bulan berikutnya>** (a checkbox): the journal and its reversal post in one transaction. The reversal is
  exactly *Balik jurnal*'s: every line mirrored with its note, `reversesId` set (so the journal can't be reversed twice), memo
  "Pembalik: … (date)". A closed next month refuses both, and the form says so before saving.
- **Salin** on each of *Terakhir dicatat*: opens the form filled with that journal's company, memo, lines, amounts and notes, and ticks
  *Balik otomatis* when the source was reversed on the 1st of its next month. The date stays the selected month's last day; the
  accountant checks and saves. Foreign-currency journals are not copied (their rate must be typed again). `?salin=<id>` is the link, so
  other pages can offer it later.
- **No recurring schedule for multi-line journals**: *Salin* covers the monthly repeat without a new table; the adjustment schedules
  keep covering depreciation, amortisation and single-line accruals.

## Acceptance criteria
- [ ] A line note typed in the form is stored and shows in Buku Besar's journal drawer.
- [ ] With *Balik otomatis* ticked, saving a 31 July accrual also posts its mirror dated 1 August; *Terakhir dicatat* says "dibalik 1
      Agu 2026"; *Balik jurnal* on it then says it is already reversed.
- [ ] A 31 December accrual reverses on 1 January of the next year.
- [ ] A closed next month: the form warns and disables saving; the server refuses both and posts nothing.
- [ ] *Salin* fills the form from the chosen journal (company, memo, lines, notes; the reversal tick for a reversed accrual); the date
      stays the selected month's.

## Verify flows
1. Accountant, a fresh client: Jurnal Penyesuaian July → accrual with a line note, *Balik otomatis* → saved; Buku Besar 2150 August
   shows the reversal, its drawer shows the note.
2. August → *Salin* on the July accrual → form filled, date 31 August, *Balik otomatis* ticked.
3. Edge: December accrual → reversal on 1 January. Error: next month closed → warning, button disabled; server refuses (test).

## Test seams
- DB: `postAdjustment` with notes and `reverseNextMonth` (year end, closed next month, *Balik jurnal* refuses afterwards) in
  `tests/db/reverse-entry.test.ts`.
- e2e: `e2e/jurnal-penyesuaian.spec.ts`.

## Non-goals
- Attachments on journals; journal numbering; a second approver (roadmap Phase 3); recurring schedules for multi-line journals.

## Gate re-openers
None: no migration (the line memo column exists), no dependency, no AI call. The reversal goes through `postJournal()` like every
entry.

## Tasks
- [ ] T1 `postAdjustment` line notes + `reverseNextMonth`; reversal helpers shared with *Balik jurnal*; DB tests.
- [ ] T2 Form (line notes, checkbox, warning), action, *Salin* on the page, notes in the ledger drawer; e2e spec.
- [ ] T3 verify-local: walk flows 1–3, screenshots, full gate.

## Implementation

## Verification

## Ship Notes
