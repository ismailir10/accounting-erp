# A ledger file posts once, even when two posts race

## Context
Posting a ledger or Neraca import (*Catat* on the draft, `postLedgerImportAction` → `postImport`) checked that the draft was not
posted and that no twin of the same file was posted **before** its write transaction, then wrote POSTED unconditionally. Two calls at
the same time (a double click, two tabs, or the same sheet staged twice from Unggah and Dokumen) both passed the checks and both booked
every journal. Reproduced on released `main` with fictional data: a sequential post books 28 entries (Σdebit 40 780); two concurrent
posts book 56 entries (Σdebit 81 560) in 6/6 runs. The duplicate is balanced, so neither the trial balance nor the balance guard sees it.

Separately, `tests/db/close-timeline.test.ts` failed (1 of 2532) whenever the shell running the suite had Auth variables set: since the
support-session change, `recordExport` reads `lib/auth/session`, but the test still mocked `lib/tenant`, so the real Supabase client called
`cookies()` outside a request and the export event was never written.

The owner set a hard release deadline (15:00 UTC, 2026-10-15) and asked for the smallest independently safe change. The larger import
and reconciliation release (six migrations) is deferred: it is not in this cycle.

## Spec
- [x] `postImport` takes a lock per client and file hash inside its write transaction, re-reads the draft and any posted twin under it,
  and marks the draft POSTED only from DRAFT. A second concurrent post is refused with the existing messages (*Impor ini sudah
  dicatat.* / *Sheet ini sudah diimpor.*) and books nothing.
- [x] A regression test proves it deterministically: it fails on the old code every time and passes on the fix every time.
- [x] The close-timeline test pins its identity source, so it passes with or without Auth variables in the shell.
- [x] accounting-rules 15a states the concurrency guarantee.

**Non-goals:** the deferred import/reconciliation release and its migrations; the period-lock race (a post committing into a month
locked meanwhile; fixed in the deferred release); bank-statement import changes; any schema change, data repair or production audit.

**Gate re-openers:** none. No migration, no new dependency, no env var, no AI use. Accounting invariant strengthened (rule 15a).

## Tasks
- [x] T1 Close-timeline test reads its session from a pinned identity.
- [x] T2 Per-file lock, re-check and conditional final write in `postImport`, with a deterministic regression test; rule 15a.

## Implementation
- T1: `tests/db/close-timeline.test.ts` declares the identity mocks of `tests/members.ts` (`@/lib/auth`, `@/lib/supabase/server`) and adds
  a signed-in case (the export event names the member).
- T2: `lib/ledger-import/post.ts`: `pg_advisory_xact_lock(hashtextextended('ledger-import:<client>:<fileHash>', 0))` first in the
  transaction; re-read of the draft's status and of a POSTED twin under it; `updateMany({ id, status: "DRAFT" })` with a refusal when it
  matches no row. No migration: a unique index would fail on any client already holding a doubled file, and that cannot be checked from
  here. `tests/db/ledger-import-concurrency.test.ts`: a separate session holds the draft row(s) `FOR NO KEY UPDATE` (journal inserts pass,
  the final status write waits) and releases them once both posts are blocked in the database (`pg_blocking_pids`, backend-status
  snapshot refreshed per poll); a timeout releases and settles the posts before failing.

## Verification
All on fictional data, loopback databases, `env -i`, AI off.
- T1 on released `aa5289f`: CI scope 5/5; fictional Auth variables 4/5 (`cookies` was called outside a request scope). After: 6/6 in both.
- T2 regression: on `aa5289f` with only the new test, both concurrency cases fail 5/5 runs (`['fulfilled','fulfilled']`, the double
  post) and the sequential case passes; with the fix 3/3 pass in 5/5 runs.
- Concurrency probes on the fix: two posts of one draft or of twin drafts post once (6/6 runs, 12/12 controls). Interruption: 9 cancels,
  terminates or client kills after every journal insert leave no journals and no POSTED status, the retry posts once, replays are
  refused; 3 lost acknowledgements after commit leave exactly one posting, replays refused.
- Full local gate on the reviewed code (product code identical to this branch): lint, typecheck, workflow sync check pass; unit + DB
  272 files / 2536 tests pass; build pass (CI scope and local Auth); `demo:reset` + `verify:books` ALL PASS (1765 checks); e2e
  `DEMO_MODE=true` 102/102 and `DEMO_MODE=false` 102/102.
- Independent review (separate session, same model): source review ACCEPT, then executed review ACCEPT on the all-new path (its own
  paused-overlap harness: the second post waits on the lock and is refused).

## Ship Notes
- No migration, no env var, no dependency. Rollback: revert the merge (no data to undo).
- **Deploy window.** Old code does not take the lock. While an old invocation is still running after the switch, an old/new pair can
  still double-post (17 of 24 mixed fictional runs did), as old/old already can on today's `main`. A freeze on new posts and closed tabs
  are not enough on their own: a post started before the freeze keeps running on the server after its tab closes. Before the merge,
  every post already started must have a **known terminal result**: its draft reads POSTED after a reload, or the caller saw an explicit
  refusal. Any post with no response (spinner, timeout, closed tab) is unresolved, and the merge waits until an approved, positive,
  read-only drain check shows it finished. Elapsed time is not that proof. Posting reopens only after the new deployment serves and
  every user has loaded it fresh.
- Unknown: whether production already holds doubled ledger postings (nothing was read). A read-only check and any repair are separate
  decisions.
