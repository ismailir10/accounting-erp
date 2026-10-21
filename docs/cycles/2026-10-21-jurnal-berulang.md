# Core accounting parity, round four: Jurnal berulang

**Roadmap:** core accounting parity with Jurnal and Zahir (`docs/roadmap.md` §3), after [round two](2026-10-20-paritas-inti.md) and
[round three](2026-10-20-lampiran-arsip.md), under the owner's request of 2026-10-20 to keep going until Buku is on par.

## Context
Jurnal's *transaksi berulang* and Zahir's recurring vouchers repeat a journal every month: the rent accrual, the BPJS share, the
amortisation of an insurance premium split over several accounts, the monthly management fee between companies. Buku repeats only one
kind: an adjustment schedule (`AdjustmentSchedule`) is one debit/credit pair for a fixed total over N months — depreciation,
amortisation, a single accrual. A multi-line journal that comes back every month is typed again, or copied with *Salin* one month at a
time, and nothing tells the accountant at the close that this month's copy is still missing.

Who feels it: the accountant at every month end (the same five journals typed again), and the partner (a missed recurring accrual is a
wrong month, found late).

## Decisions
- **Ulangi tiap bulan** on a posted Jurnal Penyesuaian (*Terakhir dicatat*): makes a `RecurringJournal` from it —
  company, memo, lines with their notes, the *Balik otomatis* tick, the day of the month (the original's day, the last day when it was
  the month's last), from the next month, until a month the accountant may set (optional).
- **Proposed, never posted by itself** (Buku's rule for anything typed by hand): every month from its start to its end or stop, an
  instalment not yet posted shows in *Jurnal terjadwal* on Jurnal Penyesuaian and in Kotak persetujuan with the schedules, dated that
  month's day, with *Catat*. *Catat* goes through Jurnal Penyesuaian's own writer and its route: above the firm's *Jurnal manual*
  threshold it waits for a second member like a typed journal and the month counts as waiting, not due; a rejection makes it due again.
- **Once per month:** the instalment's entry carries its template and month (`JournalEntry.recurringId` + `recurringMonth`, unique), a
  waiting one its request (`JournalApproval`, same pair), so a double click or two tabs post once.
- **Locked months:** an instalment of a closed month is not proposed (as schedules); a template never posts into one.
- **Close:** the close control that lists scheduled instalments still to post (`sched:`) lists due recurring journals too (REVIEW, with
  the way out: post it or stop the template).
- **Stop** (*Hentikan*) ends it: nothing more is proposed, overdue months included (so *Hentikan* is a way out of the close control);
  what was posted stays, a waiting request is still decided. The template's lines can't be edited: stop it and make a
  new one from a newer journal (an edit would change what earlier months mean).
- Every create, stop and post is in Riwayat (`RECURRING`).

## Acceptance criteria
- [ ] *Ulangi tiap bulan* on a three-line journal of July makes a template from August; August's Jurnal Penyesuaian proposes it dated the
      same day with the same lines and notes; *Catat* posts it once (a second click is refused).
- [ ] With *Balik otomatis* the instalment posts with its reversal on the 1st of the next month.
- [ ] Above the *Jurnal manual* threshold *Catat* creates a request; the month shows as waiting; approval posts it; rejection makes it due
      again.
- [ ] A closed month's instalment is not proposed; an end month stops the proposals after it; *Hentikan* stops them from the next month.
- [ ] Tutup Buku lists a due recurring journal under the scheduled-instalments control.
- [ ] Full gate green; `verify:books` ALL PASS.

## Non-goals
- Weekly, quarterly or yearly frequencies (monthly only, the close's unit).
- Amounts that change month to month (a template repeats the same lines; a varying amount is a typed journal or a schedule).
- Departments/projects (next round).

## Gate re-openers
- A migration: `RecurringJournal`, `recurringId` + `recurringMonth` on `JournalEntry` (unique pair) and `JournalApproval`. Additive.
- Posting goes through the existing writer (`postPreparedAdjustment` / `submitAdjustment`); no ledger rule changes.

## Tasks
- [x] T1 Schema + migration (`20261021090000_recurring_journal`).
- [x] T2 `lib/adjust/recurring.ts` (create, due list, stop, views) and `recurring-post.ts` (post through the route, *Catat semua*); approval
  hooks; tests.
- [x] T3 UI: *Ulangi tiap bulan*, *Jurnal terjadwal* and Kotak cards, *Jurnal berulang* list with *Hentikan*; close control; e2e.
- [x] T4 README, accounting-rules, deck.

## Implementation
- Posting reuses Jurnal Penyesuaian's writer: `submitAdjustment` is now `prepareAdjustment` + `submitPrepared(db, prepared, { guard,
  onPosted })`, and `PreparedAdjustment.recurring` is set on the entry by `postPreparedAdjustment` (never on its reversal). A request
  stores the pair and `preparedOf` reads it back, so an approval posts the instalment as the maker's click would.
- `recurringDue` proposes every month from the start (or after the client's latest locked month) to the viewed month or the end, unposted;
  a waiting month is returned with its request and left out of *Jurnal terjadwal* and the control. `lockPeriod`'s race check compares
  schedules and templates due by the month (`dueBy`).
- `recurring-post.ts` is apart from `recurring.ts` because the close controls read the due list, and the route reaches back to the
  controls through the checklist (an import cycle otherwise).
- Kotak persetujuan and Jurnal terjadwal read the same `proposalViews`; a recurring row is marked *Berulang*, names its first debit and
  credit account (`6120 +1 / 2150`), and its *Catat* says when it went to a second member. *Catat semua* posts schedules, then templates.

Decisions taken while building:
- The Buku Besar drawer does not get *Ulangi tiap bulan*: *Terakhir dicatat* is where a journal is typed and copied, and keeps one place
  for it.
- The instalment keeps the template's memo (as Jurnal's recurring transactions); Jurnal terjadwal and the control add the month to tell
  instalments apart.

## Verification
Verified locally — e5539f9 (code), with the e2e fix bdc8a79.
- `npm run lint && npm run typecheck && npm test`: exit 0; **335 files, 3071 tests passed** (dedicated test database), including
  `tests/db/recurring.test.ts` (8): the three-line template and its dates, once per month under two concurrent clicks, *Balik otomatis*,
  routing with reject → due again → approve, closed months, end month, *Hentikan*, refusals, the close control and *Catat semua*, client
  delete.
- `npm run build && npm run demo:reset && npm run verify:books`: build OK; **ALL PASS — 1765 checks**; `db:drift` shows no difference.
- `npm run test:e2e` on the production build with CI's env: 132 passed in the full run; the 3 that failed (fixed assets, investor demo,
  siklus) clicked *Catat* by its exact name, which an `aria-label` on the new button had changed. The label was removed and the four
  specs that post instalments re-run: **5 passed**. `e2e/jurnal-berulang.spec.ts` walks every acceptance criterion but the second-member
  route, which the DB test covers.
- Looked at Jurnal Penyesuaian at 1280 px: *Ulangi* beside *Salin* in *Terakhir dicatat*, the *Jurnal berulang* card with its status
  line, the recurring row in *Jurnal terjadwal* (*Jurnal berulang · PT … · 2026-08-31 · 6120 +1 / 2150*).

## Ship Notes
