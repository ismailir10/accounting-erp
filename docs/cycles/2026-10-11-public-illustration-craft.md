# Public illustration craft

## Context

The owner finds the public illustration average and names ramp.com as the quality reference. The existing
three similarly weighted outlined objects explain the flow but lack a strong focal point. This is a further
visual iteration within the previously authorized public-site work and completion-through-merge request.

## Decisions

- Use Ramp's hierarchy, restraint and material detail as reference, with original Buku artwork.
- Compose one substantial ledger with a source statement and report around it. Preserve the actual source row,
  journal accounts, synthetic-data disclosure and existing genuine product screenshots below.
- Keep current layout, headline, fonts, tokens and approved arrival/check motion. Add no dependencies or capabilities.

## Acceptance criteria

- [x] One dominant ledger, fine paper/binding details and a clear source-to-report relationship.
- [x] Source row and journal accounts follow existing evidence; no invented financial figures.
- [x] Unclipped artwork and readable labels/captions at 1440, 1024, 768 and 390 px; reduced motion remains static.
- [x] Public navigation, trial access, native disclosures, legal links and no-em-dash copy still work.
- [x] Existing gates pass and fresh desktop/phone screenshots accompany the release.

## Verify flows

1. Anonymous prospect reads the flow on desktop/phone, follows deck and trial links, expands full captures.
2. Keyboard prospect uses skip navigation and section links, then repeats with reduced motion.
   Edge: narrow viewport; error case: console and failed-resource monitoring throughout navigation.

## UX notes

One coherent editorial illustration. Fine neutral details support large labels. The source row is identifiable;
artwork remains explicitly separate from genuine app views.

## Test seams

Reuse public-product rendering tests and public-route browser checks. Inspect actual desktop/phone screenshots.
No tests for SVG coordinates or styling implementation.

## Non-goals

Accounting, AI processing, auth, legal, member loading, schema, dependencies, typography optimization, pricing,
traction, startup application submission and production configuration changes.

## Assumptions

The owner's continuing request authorizes this visual revision and the already requested merge.
The preceding cycle's home performance exception remains disclosed; it is not relabeled a pass.

## Gate re-openers

New dependency, schema/auth/PII/accounting change, paid model call, real client data or production data/configuration write.

## Tasks

- [x] T1 Compose the original illustration with existing evidence and tokens.
- [x] T2 Inspect and verify the release candidate, prepare fresh highlight screenshots and release evidence.
  Exact-head CI and the authorized merge are subsequent release gates recorded in Ship Notes and the PR.

## Implementation

- Plan: T1 inline because visual refinement shares one small component. T2 uses independent spec and standards
  reviews once composition settles. Reference assets remain scratch-only.

- T1: replaced three equally weighted outline objects with one bound ledger, a perforated bank statement and
  folded report. Fine neutral paper edges and a dark binding replace heavy outlines. Every account and source row
  still derives from the same manifest; no amount or capability added.
- Round 2: widened the report and increased its labels, headers and annotations for phone readability. Replaced
  the rectangular return rail with a single arc and removed the disconnected lower arrow.
- Restored the original SVG overflow treatment so rotated paper outlines are not clipped; outer page bounds
  remain checked separately in the final browser pass.
- Independent spec and standards source/visual reviews pass after the phone-label and connector fixes.
- Local setup: unrelated merged base contains a tracked node_modules symlink pointing outside Turbopack's root.
  Verification uses a physical local dependency directory; restore the tracked symlink before shipping. No runtime
  configuration or dependency change is included. The pinned local auth CLI cannot create its home-directory cache;
  the existing local-only Auth/Gateway/Postgres/Mailpit setup is restarted instead. No hosted service is touched.

## Verification

- Full lint/typecheck pass. Full unit/database suite: 241 files / 1,915 tests pass (393.32 seconds).
- Final illustration rendering seam: 4 public-product tests pass (3.40 seconds); component lint passes.
- Synthetic books: ALL PASS, 1,765 balance checks. Full demo browser run: 87 pass, one default-template invitation test fails because the local gateway rejects its public verification URL with HTTP 401 before it reaches the app. The trace identifies the missing no-key verification route in the local harness. Restored only that local route: the unchanged auth-link suite now passes both tests (21.6 seconds), including the originally failing default-template link and replay/refusal behavior. No application code or test change. The initial full run is not relabeled a clean 88-pass run. Exact-head CI remains a release gate.
- Pre-release production browser pass: 10 public/auth views at 1440 and 390, no page errors or failed resources;
  native close/report disclosures, skip focus, copy and overflow checks pass. Five-width 1440/1024/768/390/320
  check and reduced motion pass. Fresh release-build captures below supersede these pre-release views.

## Ship Notes

- Sole runtime change is the illustration. Existing accounting, auth, member loading, routes, fonts and genuine
  captures remain untouched. No migration, dependency, environment or manual production setup.
- Deck: no change, because no capability, coverage, numerical evidence or audience flow changed.
- Add the existing e2e label and require actual complete demo/private jobs alongside CI/check on the final head.
- Existing completion-through-merge authorization applies. Merge only after exact-head jobs pass; rollback by reverting
  this merge. Verify the live new ledger marker, all five public/auth pages and versioned captures/fonts with TLS.
- Production member-session and build-log access remain unavailable, as in the preceding release.

### Verified locally: 758c754da8bde2cfd25380f122f8723dc6fade2c, 2026-10-11 (Asia/Tokyo)

- Only documentation follows this runtime commit.
- Gate: full lint/typecheck and 241 files / 1,915 unit/database tests pass; final public-product seam 4 tests pass.
  Production build passes; synthetic books ALL PASS / 1,765 checks. Full demo browser run is 87 pass / one local
  gateway fixture failure (11.2 minutes), then the unchanged affected auth-link suite passes 2/2 after the gateway
  correction. The full run precedes restoration of the original SVG overflow class; final changed-page checks below
  run against the freshly rebuilt release candidate. Both complete exact-head CI browser modes remain required.
- App: production build on localhost:3200, synthetic demo and real local-only authentication.
- Final public walk: 10 public/auth views at 1440 and 390, no page errors or failed resources; skip focus,
  native full checklist/report disclosures, capture delivery, no-em-dash copy and page overflow checks pass.
- Final geometry: 1440, 1024, 768, 390 and 320 pass without page overflow; original visible SVG overflow retained,
  captions stay readable, reduced-motion arrival/check shapes have no animation.
- Highlights: ledger-composition-desktop.png and ledger-composition-phone.png from the fresh release build;
  phone capture includes the page gutters and complete rotated paper edges.
- Reviews: independent standards/spec source and visual review pass after two useful polish corrections.
- Not remeasured: Lighthouse, because this revision adds no client dependency, image/font request or app-loading change.
  The preceding release's median-94 home exception is historical evidence, not a new score for this revision.

## Release gates

- Exact-head CI check and complete demo/private browser jobs: pending before ready status.
- Authorized merge and production public-byte/font/capture smoke: pending after CI.
- No hosted configuration, production test accounts, legal sign-off or application submission.
