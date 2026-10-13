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

## Acceptance criteria
- [x] Each transport patch matches its declared size and SHA-256 checksum.
- [x] All six patches and the supplied generic precision contract apply cleanly.
- [x] Commentary is scoped by client, entity, year and month.
- [ ] Combined changed-path regressions and the repository full gate pass.
- [ ] Authenticated local report navigation preserves same-report drafts and
      prevents transferring them between reports.
- [ ] Outgoing diff contains only the approved code, synthetic tests and records.

## Verify flows
1. Synthetic client setup: a ledger without a currency column requests the
   bookkeeping currency and retains explicit accountant selection.
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
- [ ] T2 Run combined gates and authenticated synthetic verification.
- [ ] T3 Review the outgoing diff and coordinate publication/release.

## Implementation
- Plan: sequential, inline; mechanical restoration and one combined validation
  run share the same candidate and test services.
- Base: `9c6c0ded246f4e9738ebedfbc598bddaf3c66a52`.
- Pinned transfer: `426e6501a709c515fcec3e3ae2c50c10a7bddb37`.
- Reviewed source head: `c1c561210c1ef7119d87a2904a2ead598f5e96f9`.
- Commentary source: `c1b6797be7ebc46b0756cf10f7b94aa9496d6189`.
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
  five-test file passes in that configuration; the full suite is rerunning with
  the CI environment. No application code or test expectations were changed.
- The completed rerun in the unit/DB CI environment passes: 264 files, 2,428 tests
  (457.12 seconds). Local Auth remains configured for build and browser/E2E checks.
- Build, E2E and authenticated app flows remain pending. Earlier source-head
  results are not claimed as results of this integration.
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

## Ship Notes
- No schema, migration, dependency or deployment configuration change is included.
- Production main's existing hosted build applies pending migrations, conditionally
  seeds demo data, runs first-admin bootstrap and builds. Tests never use that build
  command or a production database.
- Publication and final merge are coordinated with the parent after validation.
- Rollback: revert the integration change; there is no new data migration to undo.
