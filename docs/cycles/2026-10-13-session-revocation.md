# Authorization revocation after an authorized session

## Context
An open report or document view must not preserve authorization for later
requests after tenant or member access changes. The user authorized this bounded
cloud investigation, missing targeted tests, and a narrow fix only if a defect
was demonstrated. Merge and deployment are excluded.

## Decisions
- Use the existing Vitest identity mocks and real disposable Postgres fixtures.
- Keep the same verified user identity before and after each access change.
- Exercise real guards, seven report export handlers, document page loaders,
  document reload action and citation retrieval from a pre-revocation answer.
- Preserve permitted reads for assigned viewers and expired grants.
- Work inline: one test slice shares the same fixture and request sequence;
  delegation would add coordination without separating independent work.

## Acceptance criteria
- [x] Establish a coverage gap from existing tests before adding tests.
- [x] Open authorized report/document access and obtain an evidence citation.
- [x] Subsequent requests deny disabled membership, revoked tenant grants,
  suspended tenant, removed client assignment and loss of implicit admin access.
- [x] Viewer and expired-grant controls preserve permitted downloads and source
  reads while refusing new answers.
- [x] Use only synthetic data, without external API/model calls.
- [x] Change no product code unless a defect is demonstrated.

## Verify flows
1. Assigned accountant opens documents and downloads reports. Change access
   without changing the login identity, then retry the saved URLs and actions.
2. Admin opens the same client without an explicit assignment; demote to viewer,
   then retry the saved export and citation URLs.
3. Downgrade an assigned accountant to viewer, or let a grant expire: existing
   source reads/downloads remain available, but new answers are refused.

## Test seams
[`session-revocation.test.ts`](../../tests/db/session-revocation.test.ts) calls
real route handlers, server page loaders and actions against the disposable DB.
Only the verified identity/configuration boundary is mocked; `fetch` is trapped
and asserted unused. Next.js redirect/not-found digests and download responses
are checked directly. This does not exercise a browser, React's server-render
request cache, or Supabase cookie/token refresh.

## Non-goals
Import, ledger locking, period closing, PDF processing changes, homepage/decks,
production data/writes, paid AI, credentials, permission expansion, merge/deploy
and a comprehensive readiness claim. No raw document download endpoint exists
at the baseline: report attachments and the document/source read paths are the
existing user-facing retrieval surfaces tested here.

## Tasks
- [x] T1 Inspect actual auth coverage and add only missing request-boundary tests.
- [x] T2 Complete checks and hand back a reviewable candidate.

## Implementation
- Exact baseline: `6edc604874b6c226de78fdbc712dd9242620b959` (also fetched main).
- Clean source checkout preserved at `/workspace/accounting-erp`.
- Isolated worktree: `/workspace/buku-session-revocation`.
- Branch: `task/session-revocation`.
- Coverage gap: `auth-tenant` checks a live member row and `action-access` checks
  write refusals, while `qa-access` tests cross-tenant requests. None exercises
  subsequent exports and saved evidence citations after access changes.
- Added one DB test file. No demonstrated product defect; no product fix.
- No files in the excluded ownership areas were edited.

## Verification
- Baseline auth regression: 2 files, 14 tests passed.
- Targeted new suite: 1 file, 7 tests passed (10.80 seconds).
- Initial candidate `acce6aa9cf6f9cf5013a86715cf114d0cb0b3d0b`: lint and
  typecheck passed; repository Vitest gate passed with 267 files,
  2,441 tests (429.43 seconds), including the new suite.
- Review follow-up: match the exact document-reload and answer refusal messages
  for each access change, including the distinct scope and viewer-role refusals.
  Rerun: lint/typecheck passed; affected auth suites passed with 3 files,
  21 tests (15.04 seconds).
- Exact candidate CI and independent review evidence are recorded on
  [PR #156](https://github.com/ismailir10/accounting-erp/pull/156). Skipped jobs
  are not passing gates; browser/E2E verification remains outside this check.
- The fixture retains its source version after refusal; denied downloads create
  no additional export audit events. Downloads return nonempty attachments with
  `Cache-Control: no-store` while permitted.
- Answer/citation generation uses the existing deterministic evidence path;
  no paid provider is invoked. All tests assert no `fetch` calls.
- Sensitivity check: a temporary copy of the session resolver, aliased only in
  a separate test configuration/database, deliberately retained the first
  authorization snapshot per user. All seven tests failed (11.59 seconds).
  The product resolver and repository configuration were never modified.
- These are authorization checks for later requests, not erasure of data already
  downloaded or rendered in a browser before revocation.
- Build, demo reset/books verification and browser E2E were not run: this bounded
  test-only investigation changes no runtime, accounting or UI behavior. The
  result is not a comprehensive readiness or release verification claim.

## Ship Notes
No migrations, environment changes, product behavior changes or deployment.
Candidate SHA and independent review artifacts are supplied in the handoff.
