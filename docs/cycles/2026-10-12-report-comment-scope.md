# Keep management commentary with its report

## Context
The accountant can start writing commentary on Laporan Keuangan, then change the
company or period before approving it. The editor kept the previous report's draft
and busy state while its save target changed to the new report. An accountant's
wording is allowed to differ from computed facts, so the server's number check
does not prevent this misplaced commentary from reaching the management export.

The delegated scope authorizes one minimal, isolated report/export defect fix with
focused synthetic tests. It excludes financial imports, statement parsing, currency
selection, rounding, foreign-account safeguards, migrations, permissions, shared
databases, production, publishing and deployment.

## Decisions
- A draft belongs to the client, company, year and month where it was started.
  Changing any of those discards the editor state; refreshing the same report
  preserves an unsaved edit.
- A late AI response from the previous report cannot populate the new editor.
- Reuse React's keyed component identity, keeping the existing controls and actions.
- Run the bounded component checks with server actions mocked and no database setup.
  The normal Vitest configuration applies database migrations even for unit tests;
  an external temporary configuration avoids those writes.
- This is the sole work record and the client-free morning-report deliverable.

## Acceptance criteria
- [x] Changing client, company, year or month removes the previous draft and save button.
- [x] Reopening the editor uses the new report's commentary and saves to its identity.
- [x] Refreshing the same report preserves an unsaved edit.
- [x] Changing reports during an AI request releases the new editor's busy state;
      the old response cannot create a draft there.

## Verify flows
1. Accountant: start a manual note for August, change to September, open the editor
   again and approve it. Only September's note is sent to September's save target.
2. Edge: refresh August while writing. The text stays in the editor.
3. Delayed response: request an AI draft, change reports, then resolve the old request.
   The new report remains editable and contains no old AI draft.

## UX notes
No new controls or copy. An unsaved draft is discarded on a report change.

## Test seams
The actual commentary component in jsdom, rendered with the existing UI components.
Only navigation, toast and server actions are mocked. Tests exercise editing,
rerendering, approval payloads and a manually resolved AI promise.

## Non-goals
Monetary calculations, report rendering, import paths, server actions, permissions,
AI calls, export formats, dependencies, database setup and deployment.

## Assumptions
Discarding an unapproved draft when leaving its report is safer than transferring
it to another report. There is no existing save-on-navigation contract.

## Gate re-openers
Any expansion into the non-goals above requires coordination with the parent.

## Tasks
- [x] T1 Reproduce the scope leak, isolate the editor state and verify the component.

## Implementation
- Plan: T1 inline; one small component and its test, so delegation costs more than it saves.
- Baseline: freshly fetched `origin/main`, `9c6c0ded246f4e9738ebedfbc598bddaf3c66a52`.
- Worktree: `/workspace/buku-report-export`; branch: `task/report-export-reliability`.
- Exact patch scope: `components/app/management-note.tsx`,
  `tests/unit/management-note.test.ts`, this cycle record.
- The public card keys its internal editor by client, entity, year and month.
  React unmounts the previous editor and ignores its later state updates.
- Standards/spec review: no effect-based reset, no new dependencies or actions,
  existing Bahasa UI preserved, all four identity fields tested, same-scope edits preserved.
- The pushed comparison of the parallel import branch against the baseline
  contains no changed report/commentary paths. Unpushed work was not inspected;
  all delegated exclusions were respected.

## Verification
- Baseline component run: **5 failed, 1 passed**. Four failures reproduce retained
  manual drafts; the fifth reproduces retained busy state after a report change.
- Patched component run: **6 passed**, in 1.08 seconds; focused ESLint exits 0.
- Commands: `./node_modules/.bin/vitest run --config /tmp/buku-report-vitest.config.mjs`
  and `./node_modules/.bin/eslint components/app/management-note.tsx tests/unit/management-note.test.ts`.
- Repository-wide `npm run lint` exits 0. `npm run typecheck` exits 0 with a
  dummy localhost DATABASE_URL; Prisma generated its client without connecting.
- The installed Next.js router keys template state with
  `createRouterCacheKey(activeSegment, true) // no search params`
  (`node_modules/next/dist/client/components/layout-router.js`), confirming that
  changing the report's query parameters does not remount the app template.
- The temporary Vitest config uses alias `@` → the worktree, includes only
  `tests/unit/management-note.test.ts`, and has no `globalSetup`. Server actions
  are mocked; no database or real AI call is made.
- Dependency setup: unmodified lockfile via `npm ci --ignore-scripts --no-audit --no-fund
  --cache /tmp/buku-report-npm-cache`. Initial default cache was unwritable;
  moving the cache to `/tmp` resolved it without dependency changes.
- Limits: no authenticated Next.js browser walk, real workbook download, full test
  suite, books verification, build or e2e run. This is a focused verified patch,
  not a claim that the repository's full release gates have passed.

## Independent finding
`lib/reports/management-pack.ts` writes commentary with `wrapText: false`, including
an approved note that can contain up to 1,500 characters. Long commentary can run
beyond the sheet's printed width. This is code evidence only; visual clipping was
not tested. The file also performs monetary calculations, so it was left untouched
under the delegated boundary. A later renderer-only change should wrap across the
summary columns and give merged rows sufficient height, with an XLSX round-trip
and print check.

## Focused follow-up review
- Reviewed the actual five-line runtime diff. The reset key includes all four
  fields used by the action target: client, entity, year and month. Display labels,
  updated facts and approval metadata are deliberately excluded so a same-report
  refresh does not discard an unsaved draft. There is no effect dependency list.
- Switching away and back creates a fresh editor. An unapproved edit is discarded;
  the saved note remains visible and reopening starts from that saved note. This
  is intentional draft loss on a context change, not cross-report persistence.
- No dirty-draft confirmation existed in the commentary card, report scope picker,
  report page, app template or the inspected navigation shell. This fix adds none.
- The existing synthetic jsdom component harness exercises the actual UI controls.
  Added regression checks cover returning to a saved note, late AI success after
  returning, late AI failure after changing reports, and an earlier save completing
  after a new draft is opened. The save retains the original target, and its old
  completion cannot clear the new editor's draft.
- Final focused regression result: **10 passed**. No runtime changes were needed
  after review. The original full lint/typecheck evidence still applies to the
  unchanged runtime patch; the extended tests also pass focused ESLint.
- Limit: keyed unmounting ignores old editor state updates; it does not cancel an
  already-started server action. Existing action handlers can still display a
  global toast on late failure/success or request a refresh after an earlier save.
  These existing side effects do not overwrite or clear the new editor's draft,
  and notifications/action cancellation are outside this bounded fix.
- No authenticated browser, database or external account was used. Component
  interaction checks do not establish the whole Next.js navigation/export flow.

## Library handoff
- The supported Library prepared-upload helper was invoked with the report and
  patch as one ordered batch. It stopped before upload preparation with:
  `library upload failed: hosted apps tools/list request failed with HTTP status 401`.
- A subsequent read-only Library metadata call succeeded. The blocker is the
  helper's hosted-tools authorization in this delegated execution environment,
  not a confirmed disconnected Library account. No upload session was prepared
  and no Library file IDs were created or confirmed.
- The workflow forbids switching a started helper write to a direct action;
  no fallback write was attempted. The parent needs an authorized helper runtime
  or explicit direction to use another supported create route.
- Local deliverables remain available: this report and
  `/workspace/buku-report-evidence/report-comment-scope.patch`, plus the focused
  regression and lint logs in that evidence directory.

## Ship Notes
- Local patch only. No push, PR, merge or deployment is authorized by this work.
- No migration, environment variable or manual production step.
- Rollback: revert the isolated fix commit.
- Before publication: parent reviews the patch and completes the release checks
  required for the eventual integration branch.
