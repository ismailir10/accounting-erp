# Integrate reviewed accounting and report-commentary fixes

## Context
Combine the reviewed currency, exact-source rounding and foreign-summary safeguards
with the report commentary scope fix, on the current main baseline. Verification
uses disposable local services and synthetic fixtures only.

## Decisions
- Restore the complete six-patch sequence in order; final exact-source rounding
  supersedes the intermediate tie-marker implementation.
- Preserve the supplied arithmetic expectations and the original commentary fix.
- Keep PR #153's entity/account editing changes separate.
- Exclude transport files, omitted source documentation, original fixtures and
  private observations from this branch.
- Include the parent-authorized period-picker repair as a separate commit: the
  URL must retain the selected month, and commentary must follow that context.

## Acceptance criteria
- [x] Each transport patch matches its declared size and SHA-256 checksum.
- [x] All six patches and the supplied generic precision contract apply cleanly.
- [x] Commentary is scoped by client, entity, year and month.
- [x] Combined changed-path regressions and the repository full gate pass.
- [x] Authenticated local report navigation preserves same-report drafts and
      prevents transferring them between reports.
- [x] Outgoing diff contains only the approved code, synthetic tests and records.

## Verify flows
1. Synthetic client setup: a ledger whose explicit currency column is mostly
   non-Rupiah requests the bookkeeping currency and retains accountant selection.
   A missing currency column does not trigger this question.
2. Exact-source rounding: synthetic ledger and trial-balance fixtures preserve
   original rounding expectations, including six-decimal amounts and residues.
3. Synthetic report: write commentary, change month/company, return, then reopen;
   an unapproved draft is discarded on scope change and saved notes remain.
4. Same report: refresh while writing; an unsaved draft remains.

## Non-goals
PR #153, privacy/settings changes, raw client files, foreign-asset import expansion,
new dependencies or migrations, new financial implementation, and paid AI calls.

## Tasks
- [x] T1 Restore the verified source and combine the commentary fix.
- [x] T2 Run combined gates and authenticated synthetic verification.
- [x] T3 Review the outgoing diff and prepare verified publication/release.

## Implementation
- Plan: sequential, inline; mechanical restoration and one combined validation
  run share the same candidate and test services.
- Base: `9c6c0ded246f4e9738ebedfbc598bddaf3c66a52`.
- Pinned transfer: `426e6501a709c515fcec3e3ae2c50c10a7bddb37`.
- Reviewed source head: `c1c561210c1ef7119d87a2904a2ead598f5e96f9`.
- Commentary source: `c1b6797be7ebc46b0756cf10f7b94aa9496d6189`.
- Bounded navigation repair: `586d09180fea2f83978ccbfa700f03058dca229b`.
- The transfer commit is not merged. Its six raw patches were extracted privately,
  checksummed and applied with `git apply --index --unidiff-zero` in filename order.
- The non-vendored accounting rule now states the supplied six-decimal source
  precision and single-rounding contract; no omitted observations were recreated.
- Worktree: `/workspace/buku-release-integration`, branch
  `task/accounting-release-integration`.

## Verification
- All 17 restored code/test files match the final source blob prefixes in the
  transport patches. All three commentary files match their source commit bytes.
- Changed-path regressions: 8 files, 549 tests passed. Repository lint and
  typecheck passed. Synthetic books verification: ALL PASS, 1,765 checks.
- The first full unit/DB run had 2,427 passes and one existing close-timeline
  failure: local Auth configuration caused a request-scoped cookie call outside
  a request. The unit/DB CI job intentionally leaves Auth unconfigured. The same
  five-test file passes in that configuration. No application code or test
  expectations were changed.
- The completed rerun in the unit/DB CI environment passes: 264 files, 2,428 tests
  (457.12 seconds). Local Auth remains configured for build and browser/E2E checks.
- Production build passed. The integration worktree needed an identical local
  dependency tree because its original symlink lay outside the build root; no
  dependency, lockfile or build configuration changed.
- First E2E run: 92 passed, three invitation/recovery failures. The disposable
  Auth service fetched email templates through an injected proxy (503), and its
  default verification paths omitted the gateway prefix. Correcting only this
  local service makes all three affected tests pass (27.5 seconds).
- Second full E2E run: 93 passed, two access-test failures. Parallel supplementary
  walkthroughs created overlapping synthetic client names; existing substring
  selectors matched two clients. These fixtures came from verification, not the
  application patch. Both affected tests pass after clean demo setup (36.2 seconds).
  A clean run was then interrupted to include the newly authorized period-picker
  repair. Final gates rerun from clean demo setup without parallel walkthrough
  writes. No interrupted run or prior source-head result is a combined pass.
- Navigation repair: two focused URL tests pass; combined changed-path regressions
  now pass 9 files / 551 tests. Lint and typecheck pass. A private walkthrough
  helper was removed from the linted worktree; retained evidence lives separately.
- Local application and test databases use port 55433. Auth/gateway and mail catcher
  bind localhost ports 54321 and 54324. Real AI keys are empty.
- The full CLI database image could not unpack under the cloud Docker `vfs`
  driver. The disposable stack uses cached GoTrue/gateway/mail-catcher images and
  its own Auth database on the local PostgreSQL service.
- Local Auth user creation, password login, identity lookup, sign-out and captured
  invitation delivery passed before integration.
- Known source limits: majority/missing-column currency heuristics, six-decimal
  input precision, synthetic trial-balance evidence, and a foreign-summary warning
  rather than complete foreign-asset import support.

### Verified locally — `166fc8884e27375467fc7479c9a90a0dee65e95e`, 2026-10-13
- App: production build at `http://localhost:3200`, synthetic authenticated member.
- Same-report router refresh preserves an unsaved commentary draft.
- Client-side navigation to another month clears the draft; returning shows the
  approved note. The downloaded management workbook contains that approved note.
- Entity picker: changing company clears the draft; returning does not restore it.
- Desktop and phone commentary captures have no horizontal page overflow.
- Screenshots: `/tmp/buku-comment-scope-1440.png`,
  `/tmp/buku-comment-scope-390.png`; highlight `/tmp/buku-approved-commentary.png`.
- Currency: the synthetic USD ledger requires explicit selection before client
  creation, retains USD after a client-name edit, and stores USD on the new entity.
  The expected destination is the ledger import page.
- Console/network: no browser console errors or unexpected HTTP errors in the
  supplementary walkthrough.
- Currency screenshots: `/tmp/buku-currency-choice-1440.png`,
  `/tmp/buku-currency-choice-390.png`; highlight `/tmp/buku-bookkeeping-currency.png`.
- Visual review: labels and the primary action are visible; approved commentary
  and currency controls fit desktop and phone widths without horizontal overflow.
- Out-of-scope defect found in baseline: the month picker's `ScopeBar.set` deletes `period`
  after setting it, so choosing a month returns to the default month. The month
  navigation above uses the client router directly to isolate commentary behavior;
  it does not claim the picker passed at that earlier runtime.
- Focused independent proof: the requested July URL receives `period=null`; the
  entity-navigation case passes. A two-line repair on an isolated component copy
  passes both tests. `/tmp/buku-scope-bar-repair-with-tests.patch` is prepared and
  applies cleanly. The parent subsequently authorized inclusion of this bounded
  repair with a real-browser regression for July selection and draft context.
- Browser reproduction confirms the same baseline behavior: choosing July removes
  `period`, the report still says August, and the August draft remains. Evidence:
  `/tmp/buku-period-picker-proof.log`, `/tmp/buku-baseline-period-picker.png`.
- Synthetic screenshots, walkthrough evidence and the separate proposed repair
  are retained privately in `/workspace/buku-integration-evidence/`; none is raw
  client material. Publication still contains only the approved paths.
- Rounds: disposable Auth verification paths corrected, then injected proxy use
  removed from that local Auth process. No runtime code changed after the candidate.
- Not checked: live AI responses (no real AI calls), private source fixtures,
  hosted data writes, and production release. No unverified result is a pass.

### Verified locally — `586d09180fea2f83978ccbfa700f03058dca229b`, 2026-10-13
- Gate: lint and typecheck pass; changed-path regressions pass 9 files / 551 tests;
  production build passes; reset synthetic books passes all 1,765 checks. Final
  full unit/DB passes 265 files / 2,430 tests (662.67 seconds), in the CI Auth
  environment. The final E2E run passes all 96 tests (12.4 minutes), with no
  parallel walkthrough writes. The vendored workflow drift check also passes.
- App: rebuilt production server at `http://localhost:3200`, synthetic member.
- Walked: selecting July from August changes the URL and report facts to July,
  discards August's draft and starts July's editor from July's facts. Returning to
  August discards July's draft. The seven affected report/navigation E2E tests pass
  (46.6 seconds), including this real-control regression.
- Supplementary walkthrough: same-report router refresh retains a draft; entity
  and month picker changes clear drafts; return shows the saved note; management
  workbook contains the approved note. Explicit USD selection is required,
  survives a client-name edit and is stored on the created entity.
- Console/network: clean in the supplementary walkthrough.
- Screenshots: `/tmp/buku-comment-scope-1440.png`,
  `/tmp/buku-comment-scope-390.png`, `/tmp/buku-currency-choice-1440.png`,
  `/tmp/buku-currency-choice-390.png` (retaken against this runtime).
- Highlight: `/tmp/buku-july-report-context.png`,
  `/tmp/buku-bookkeeping-currency.png`; reviewed for visible month/context,
  self-explanatory currency selection and desktop/phone overflow.
- Rounds: bounded navigation repair plus unit and real-browser regression; no
  accounting source or arithmetic expectation changed. Final app-DB E2E run has
  exclusive access after the supplementary walkthrough ended.
- Not checked: live AI responses, private source fixtures, hosted writes and
  production release. Local fixture services are disposable; no paid calls.

## Ship Notes
- No schema, migration, dependency or deployment configuration change is included.
- No deck change: both public decks already describe per-entity currency and
  ledger-based FX; these changes repair those existing capabilities.
- Production main's existing hosted build applies pending migrations, conditionally
  seeds demo data, runs first-admin bootstrap and builds. Tests never use that build
  command or a production database.
- Publication and final merge are coordinated with the parent after validation.
- The outgoing review has 25 approved paths. All 17 restored code/test blobs,
  all three commentary blobs and the supplied accounting-contract blob match their
  reviewed source. Transport files, the separate entity/account PR, migrations,
  permissions, dependencies and deployment settings remain excluded.
- The final authorized scope adds three navigation/regression files to the original
  22 paths. The two-line period-picker repair stays in its own commit, preserving
  the accounting source and original commentary bytes. Final full gate, affected
  browser flows and supplementary walkthrough all pass on `586d091`.
- Publication, exact-head CI and production release follow under the parent's
  standing authorization. Production metadata/build-log access may require the
  parent's Vercel session: the connected API returns 404 for the verified project
  ID and team, so it cannot inspect that project's build log.
- Rollback: revert the integration change; there is no new data migration to undo.
