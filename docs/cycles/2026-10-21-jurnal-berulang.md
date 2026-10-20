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
- **Ulangi tiap bulan** on a posted Jurnal Penyesuaian (*Terakhir dicatat* and the Buku Besar drawer): makes a `RecurringJournal` from it —
  company, memo, lines with their notes, the *Balik otomatis* tick, the day of the month (the original's day, the last day when it was
  the month's last), from the next month, until a month the accountant may set (optional).
- **Proposed, never posted by itself** (Buku's rule for anything typed by hand): every month from its start to its end or stop, an
  instalment not yet posted shows in *Jurnal terjadwal* on Jurnal Penyesuaian and in Kotak persetujuan with the schedules, dated that
  month's day, with *Catat*. *Catat* goes through Jurnal Penyesuaian's own writer and its route: above the firm's *Jurnal manual*
  threshold it waits for a second member like a typed journal and the month counts as waiting, not due; a rejection makes it due again.
- **Once per month:** a posted or waiting month is recorded (`RecurringPosting`, unique per template and month), so a double click or
  two tabs post once.
- **Locked months:** an instalment of a closed month is not proposed (as schedules); a template never posts into one.
- **Close:** the close control that lists scheduled instalments still to post (`sched:`) lists due recurring journals too (REVIEW, with
  the way out: post it or stop the template).
- **Stop** (*Hentikan*) ends it from the next proposal; what was posted stays. The template's lines can't be edited: stop it and make a
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
- A migration: `RecurringJournal`, `RecurringPosting`, `JournalApproval.recurringKey`. Additive.
- Posting goes through the existing writer (`postPreparedAdjustment` / `submitAdjustment`); no ledger rule changes.

## Tasks
- [ ] T1 Schema + migration.
- [ ] T2 `lib/adjust/recurring.ts`: create from an entry, due list, post (with routing), stop; approval hooks; tests.
- [ ] T3 UI: *Ulangi tiap bulan*, *Jurnal terjadwal* and Kotak cards, *Hentikan*; close control; e2e.
- [ ] T4 README, accounting-rules, deck.

## Implementation

## Verification

## Ship Notes
