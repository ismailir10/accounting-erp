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
- **Only the same bytes recover.** The waiter recovers when, under the lock, every row is on file and an import of its same bytes is on
  file. The retry stays for every other change: another file holding the same lines with no import of these bytes, a file overlapping in
  part, rows new or gone. Those keep going through retry and the normal dedupe, never passed off as a repeat. (Review: if these bytes
  already have an import, even an empty one from an earlier repeat, the waiter recovers to it however the rows came back; a sequential
  repeat answers the same, so nothing differs from today's sequential behaviour.)
- **"The same statement" is the match `main` already uses before the lock** (same account, period, source hash, source facts and
  issues), reused under the lock, not a new rule.

## Acceptance criteria
- [x] Two imports of the same bytes at once book every line once; both succeed; the second answers with the import already on file.
- [x] Two Unggah lines of the same file booked at once both end BOOKED (one *Dibukukan*, one *Sudah dibukukan sebelumnya*), lines booked once.
- [x] With a Dokumen source the waiter records its own empty import of that source, as a sequential repeat does.
- [x] A different file with the same lines, or a file overlapping in part, still gets the retry; nothing is booked twice and the retry
  then behaves as a sequential import.
- [x] accounting-rules 12 states the concurrency behaviour.

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
- [x] T1 Under the lock, a waiter whose rows were all booked by the same bytes ends as a repeat; regression test; rule 12.

## Implementation
- T1 (`af04395`, wording `6e41946`): `importStatement` (`lib/import/pipeline.ts`) keeps the pre-lock read and the account lock as they were.
  The pre-lock same-statement match moved into one helper, `sameStatement`, used both before the lock (a sequential repeat) and under it.
  Under the lock, when the dedupe now differs from the first read: every row a duplicate and `sameStatement` finds the bytes → without a
  Dokumen source the call returns the import on file (nothing written, the repeat's summary); with one it writes its own empty import of
  that source (no lines, no transfer guard or links, as a sequential repeat). Otherwise the retry, unchanged. Rule 12 states it.
- Regression `tests/db/import-same-file-race.test.ts`: two imports held after their first read (a query hook on the rules read, no sleeps)
  until both arrive, then released into the lock: same bytes direct, same bytes with a Dokumen source, Unggah's two drops via
  `processNext`, and retry controls for the same lines in other bytes and a partial overlap. Fictional values only (the `makeGroup`
  group, fictional counterparties and evidence id).
- A handoff from an earlier review session proposed a test expecting one shared import for Unggah; measured on `main`, a sequential
  second drop writes its own empty import, so the waiter matches that (Decisions). Its test text was not added.

## Verification
All on fictional data, loopback databases, AI off. Code head `6e41946` (later commits change docs only).
- Reproduced on released `main`: the new race cases fail 5/5 runs (Unggah `['FAILED','BOOKED']`, direct `['rejected','fulfilled']`), the
  two retry controls pass; with the fix 5/5 runs pass 5/5.
- **Clean task gate** at `6e41946`, nothing else on `buku_test`: lint and typecheck pass; `npm test` 273/273 files, 2541/2541 tests, exit 0.
  An earlier run at `af04395` (same counts, exit 0) overlapped the first review's database work on the shared `buku_test` and is
  **excluded as contaminated**; its log is kept. The reviews then used their own database (`buku_review_race`).
- `npm run build` exit 0; `demo:reset` + `verify:books` ALL PASS (1765 checks), without and with the local Auth stack.
- Local Auth stack (pinned `supabase@2.118.0`): run on a pre-created Docker network whose default host binding is `127.0.0.1`; every
  published port verified loopback-only before first use (`127.0.0.1:54321`, `:54322`, `:54324`). A first start without that network
  published `0.0.0.0` and was stopped before any use. Keys kept in a mode-600 file outside the worktree, never printed.
- **Independent reviews** (separate subagents; served model read from their own transcripts):
  - code: `claude-opus-5-5`, effort high, ACCEPT. Low findings: recovery keys on "same bytes on file" (wording fixed in rule 12 and the
    code comment); the no-source repeat reports zero AI calls like a sequential repeat; removal is not under the import lock (pre-existing,
    no new hazard). Its own probes: three concurrent copies, a waiter with earlier duplicates, the empty-import case; mixed old/new
    deploy: no hazard.
  - capture harness (below): `claude-opus-5-5`, effort high, ACCEPT with gaps, all applied.
  - A first research helper (`claude-opus-5-5`, effort high) was stopped before it returned; nothing from it was read or used.
- **Local e2e, behavioral only.** Some older e2e inputs are not proven fictional, and the specs take 46 direct screenshots that no
  config option turns off. So the suite ran through an **uncommitted verification harness outside the repository** (reviewed twice,
  ACCEPT): every direct screenshot, `page.pdf` and failure context writes nothing; trace, screenshot and video off; a reporter that prints
  status, `file:line` and test id only (no titles, no error text). Every assertion runs; a failure still fails the run. No visual
  coverage is claimed and the test tree is not the unchanged CI one. Against the production build on `127.0.0.1:3200` with the local
  Auth stack (synthetic users only):
  - `DEMO_MODE=true`, first run: 101 as expected, 1 timed out (`client-navigation.spec.ts:81`, a navigation test), exit 1. It ran while
    browser self-tests and review probes ran beside it. That file then passed 5/5 alone, and a **clean full rerun passed 102/102**,
    exit 0. **The cause of that timeout is unknown.**
  - `DEMO_MODE=false`: 102/102 as expected, exit 0.
  - These earlier runs (15:48–16:18 UTC) are kept as **mode-unverified**: nothing recorded the effective mode.
  - **Attested runs** (re-established loopback fixture, one fresh build `CwZXOlOB3eA0okCQfEo15` from the clean head, strictly
    sequential, no other load): full suites `DEMO_MODE=true` 102/102 and `DEMO_MODE=false` 102/102, exit 0, each with its own run id,
    server process and window, server and runner flags recorded per run. A separate behavioural probe per mode (fresh server, same
    build, same controlled preconditions: the sample account unique and the exact live-upload file not booked, on the authorized
    import page with the form shown) found the demo sample control **present with `true` and absent with `false`**: both modes
    **attested**. The suites' own in-run probes failed on probe bugs and are kept as failures, so for the suite runs the flags are
    attested by environment and the effective mode is inferred. `DEMO_MODE` is a runtime read in compiled server code only. Reviewed
    read-only (`claude-opus-5-5`, high). Limits: one probe sample per mode; synthetic names in server logs (not attached). The server
    line "The destination stream closed early" recurs (8 and 15 in the suites) during varying tests with no failure; it comes from
    React's server renderer when a response closes early; no causal claim. Hashes in the metadata receipt (outside the repository).
  - No screenshot, video, trace or failure-context file written in the repository or the harness output.
- Verify flows 1–4 are covered by the regression test (Unggah's `processNext` and the direct import, real database); the interleaving
  cannot be forced from the UI, so no manual browser walk of the race was done.
- **Hosted CI:** none ran (draft). Marking the PR ready runs `ci.yml` `check` (no browser without an `e2e` label), but its unmodified
  `npm test` prints assertion diffs, messages and console output on a failure, and some unit fixtures are not proven fictional: **not
  privacy-safe** while the CI route is open. The merge's push to `main` runs `e2e.yml` with the unmodified captures. A capture-safe CI
  change (unit-log reporting and e2e) is proposed separately and awaits the owner's scope decision.

## Ship Notes
- No migration, no env var, no dependency. Rollback: revert the merge (no data to undo).
- Deploy window: both versions take the same account lock and neither double-books. An old waiter still answers the race with the
  retry (today's behaviour); a new waiter recovers. No cutover step is needed for the code itself.
- Branch: the PR uses the session's assigned branch (`claude/…`), a user-directed exception to the `task/<slug>` rule (AGENTS §8).
- **Merge and deploy held** for the owner's separate human cutover confirmation, which is a release decision, not a code risk, in this
  order: (1) resolve the safe CI route, covering both the unit-log reporting in `ci.yml` and the hosted e2e run the merge triggers (the
  capture-safe CI proposal or another route); (2) only then mark the PR ready, and CI `check` must be green on its head; (3) the merge
  itself (= the production deploy). No production data was read or written in this cycle; whether
  production already holds FAILED Unggah lines from this defect is unknown.
