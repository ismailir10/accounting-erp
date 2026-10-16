# A build refuses a database that drifted from the migrations

**Roadmap:** Phase 0, item 4 (`docs/roadmap.md`, ADR 0020; both in PR #163).

## Context
ADR 0019 made the production build read-only: `prisma migrate status` fails it while a migration is pending or failed. The
[build-hooks](2026-10-15-build-hooks.md) cycle recorded the limit and left it open: `migrate status` is not a drift check. All of these
still read "up to date" (reproduced there on fictional copies):
- an extra applied migration that is not in the repo;
- an edited migration file (checksum mismatch);
- a hand-changed table, for example a dropped column.

Code can then ship against a schema it was never tested on. Separately, CI never checks that `schema.prisma` matches the migrations.
A PR that edits the model without a migration passes CI, and its generated client expects columns the database doesn't have.

Probe on a fresh local database (2026-10-16):
- after `prisma migrate deploy`, `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` reports
  *No difference detected*;
- after a hand `ALTER TABLE "Client" ADD COLUMN`, it reports the change;
- `_prisma_migrations.checksum` is the SHA-256 of each `migration.sql` file as stored.

## Spec
- [x] `scripts/db-drift.sh` runs two read-only checks against `DATABASE_URL`. It stops at the first failure and says what differs, and
      it never prints a URL.
  1. **History** (`scripts/migration-history.mjs`, plain Node and `pg`, inside a `READ ONLY` transaction). Every applied,
     not-rolled-back row in `_prisma_migrations` must name a folder in `prisma/migrations`, and its checksum must equal the SHA-256 of
     that folder's `migration.sql`. Pending and failed migrations are left to `migrate status`.
  2. **Schema**: `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` must be empty.
- [x] `scripts/vercel-build.sh` runs it on the direct URL after `migrate status` and before `next build`. Drift fails the build with
      the differences and the next step.
- [x] CI `check` runs `npm run db:drift` right after `prisma migrate deploy`. On a fresh database that proves the check gives no false
      positive, and it catches a `schema.prisma` change that has no migration.
- [x] Tests:
  - the history comparison is unit-tested: extra applied, edited, pending, rolled back, clean;
  - `vercel-build.test.ts` pins the new call order and shows that drift stops the build before `next build`;
  - a DB test runs the real script against a fresh `buku_test` copy: clean passes, a hand-added column fails, an edited checksum
    fails.
- [x] Docs:
  - an ADR 0019 amendment;
  - the README → Schema changes step;
  - the build-hooks open decision closed.

**Decisions made** (the owner delegated spec approval, 2026-10-16):
- **Drift fails the build, with no override flag.** This is the same rule as a pending migration (ADR 0019). A flag would be the
  first thing set when it is inconvenient.
- **Triggers and CHECK constraints are out of scope.** `migrate diff` does not model them. The history check still catches an edited
  migration that would have changed them. A hand-dropped trigger stays undetected, and this limit is stated, not solved.
- **History check in plain Node, not tsx.** The build test bans `tsx` from the build script, and a `.mjs` file with `pg` needs no
  compile step on Vercel.

**Merge danger:**
- If production already drifts, the first build after merge fails and the current deployment keeps serving.
- If the build machine cannot connect to the direct URL, the drift check fails the build even though `migrate status` connected
  through Prisma's engine. The app reaches the same Supabase URLs with `pg`, so this is unlikely.
- **Owner step before merging:** run `DATABASE_URL=<production direct URL> npm run db:drift` once. It is read-only.

**Gate re-openers:** none. No new dependency (`pg` is already one), no migration, no env var, no auth or PII change. Touches the
sensitive paths `.github/workflows/ci.yml` and the build script, as named here.

## Tasks
- [x] T1 History script, drift script, npm script, unit and DB tests.
- [x] T2 Build script and CI wiring, build test, docs.
- [x] T3 Gate: task gate + build + a real drift run on a fictional copy.

## Verification
All runs were local, on fictional databases. Nothing touched production.
- **Manual runs of `npm run db:drift`:**
  - fresh migrated database: exit 0 ("62 applied", "No difference detected");
  - hand-added column: exit 2, names `Client`;
  - edited checksum plus an unknown applied row: exit 2, both listed and the schema not compared;
  - unreachable host: exit 1, and the password is not printed.
- **New tests:** `tests/unit/migration-history.test.ts` (6) and `tests/db/db-drift.test.ts` (3), which runs the real script on a
  freshly migrated `buku_drift_check` database.
- **Build test:** `tests/unit/vercel-build.test.ts` has 13 tests. It pins the call order (generate → status → history → schema diff →
  next build, all on the direct URL) and shows that either kind of drift stops the build before `next build`. The drift scripts
  contain no writing statement, and the history SQL runs in `BEGIN READ ONLY`.
- **Task gate:** `npm run lint` exit 0, `npm run typecheck` exit 0, `npm test` with 279 files and 2,609 tests passed (641 s).
- **Real build:** `scripts/vercel-build.sh` on the local stack, with the integration's variable names pointing at the local
  database: "Database schema is up to date!", "✓ Migration history matches prisma/migrations (62 applied)", "✓ Database tables
  match prisma/schema.prisma", "✓ Compiled successfully", exit 0.
- `verify:books` and e2e not run. No report number, app flow or auth changed.
