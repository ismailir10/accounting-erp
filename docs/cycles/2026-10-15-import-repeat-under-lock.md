# A statement imported twice at once ends as a repeat, not a retry

## Context
Two imports of the same statement bytes into one bank account at the same time (a double click on *Impor*, two tabs, or the same file
dropped twice in Unggah) both read the account before either writes, then queue on the account's import lock. The first books every
line. The second repeats the dedupe under the lock, finds that the rows changed since its first look, and refuses with *Rekening ini baru
saja menerima impor lain. Ulangi impor file ini.* In Unggah its line ends **FAILED** although its rows are booked and the same statement is
on file; the accountant is told to retry something that is already done. Reproduced on released `main` (`6a33341`) with fictional data:
the Unggah pair ends `['FAILED', 'BOOKED']`, and the direct import pair `['rejected', 'fulfilled']`, in 5/5 runs each.

A sequential repeat already answers correctly: without a Dokumen source it returns the import on file and writes nothing; with one
(every Unggah line has one) it records its own empty import of that source and reads *Sudah dibukukan sebelumnya*. Who feels it: the
accountant booking statements in Unggah or *Impor*.

The owner authorized this narrow cycle (spec pre-approved in the request): migration-free, independent of the deferred import release,
fictional regression data only, independent review and exact-head gates before shipping.

## Decisions
- **The waiter ends exactly as a repeat started after the winner would.** Without a Dokumen source: the import on file, nothing written.
  With one: its own empty import of that source, as a sequential second drop records today (measured on `main`: a second Unggah drop of
  the same bytes writes an import with 2 rows, 2 duplicates and no lines). A handoff from an earlier review proposed answering with the
  winner's import in both cases; that would make the concurrent outcome differ from the sequential one for Unggah, so it was not taken.
- **Only the same bytes recover.** The retry stays for every other change seen under the lock: another file holding the same lines,
  a file overlapping in part, rows new or gone. Those keep going through retry and the normal dedupe, never passed off as a repeat.
- **"The same statement" is the match `main` already uses before the lock** (same account, period, source hash, source facts and
  issues), reused under the lock, not a new rule.

## Acceptance criteria
- [ ] Two imports of the same bytes at once book every line once; both succeed; the second answers with the import already on file.
- [ ] Two Unggah lines of the same file booked at once both end BOOKED (one *Dibukukan*, one *Sudah dibukukan sebelumnya*), lines booked once.
- [ ] With a Dokumen source the waiter records its own empty import of that source, as a sequential repeat does.
- [ ] A different file with the same lines, or a file overlapping in part, still gets the retry; nothing is booked twice and the retry
  then behaves as a sequential import.
- [ ] accounting-rules 12 states the concurrency behaviour.

## Verify flows
1. Accountant, Unggah: drop the same fictional BCA statement twice and book the batch with two parallel processors → both lines BOOKED,
   the account shows the statement's lines once (regression test; the UI cannot reliably force the interleaving).
2. Accountant, *Impor*: import the same file twice at once → both succeed, one import in Riwayat, lines once.
3. Edge: the same lines in other bytes at once → one succeeds, the other says *Ulangi impor*; the retry recognises the lines.
4. Error: a file overlapping in part at once → the retry message; the retry books only the new line.

## UX notes
No UI change. The waiter now shows the existing success copy for a repeat instead of the retry error.

## Test seams
One DB test file: imports paused after their pre-lock read until both arrive (a query hook, no sleeps), at the pipeline and at Unggah's
`processNext`.

## Non-goals
The deferred import/reconciliation release (and anything from its candidate patch); the period-lock race (a month locked between the
pre-lock check and the write); Unggah's stale-claim reprocessing; whether a repeat should record an empty import at all; any schema
change, data repair or production read.

## Assumptions
- The pre-lock same-statement match is the correct identity for "the same statement" (it is what sequential repeats already rely on).
- Identical bytes read in the same code version give the same validation (source facts and issues), so the match holds for the waiter.

## Gate re-openers
None. No migration, no dependency, no env var, no auth/PII change, no AI call, no production write. Accounting invariant clarified (rule 12).

## Tasks
- [ ] T1 Under the lock, a waiter whose rows were all booked by the same bytes ends as a repeat; regression test; rule 12.

## Implementation

## Verification

## Ship Notes
