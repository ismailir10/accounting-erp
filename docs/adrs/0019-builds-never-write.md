# 0019 — Builds never write to the database or to Auth

**Status.** Proposed, 2026-10-15 (cycle [build-hooks](../cycles/2026-10-15-build-hooks.md)); accepted when it merges.
Replaces the build-time migration, demo seed and first-admin bootstrap of [0010](0010-supabase-platform.md) §5.

**Context.** Every merge to `main` is a production build ([0011](0011-main-only-releases.md), [0015](0015-production-only.md)), and
`scripts/vercel-build.sh` ran, against the production database, whatever its environment selected:
- `prisma migrate deploy` (DDL on the real database);
- `seed-if-empty` when `DEMO_MODE=true`: on an empty database a `TRUNCATE` of every table plus demo journals, and on **every** build the
  demo admin's password reset, unban, and ADMIN role in the first firm;
- `bootstrap-admin` when `INITIAL_*` is set: a firm when none exists, and an ADMIN invitation whenever that member is missing.

A deploy could therefore change the schema, data, roles or passwords depending on env values and database state that nobody reviews at
merge time. A fictional probe showed the demo-admin path forcing a demoted, disabled admin back to ADMIN and replacing its password on
every build.

**Decision.**
1. A build runs `prisma generate`, a **read-only** `prisma migrate status` on the non-pooling URL, and `next build`. A migration in
   `prisma/migrations` that is not recorded as applied, or is recorded as failed, fails the build, so code never ships ahead of its
   schema. No flag brings the old steps back. The check is **not** a drift check. Tested on Prisma 7.10: an unknown extra applied
   migration, a checksum mismatch (edited migration file) and a dropped column all still read "Database schema is up to date!". The old
   `migrate deploy` was equally blind to these; it reported "No pending migrations to apply". Detecting drift needs either a shadow
   database (DDL) or a schema-to-database diff validated against the triggers and CHECK constraints Prisma does not model, so it is left
   to an explicit operator check, not the build.
2. A migration is applied deliberately, before its code merges: an operator runs `npm run db:migrate` against the production
   non-pooling URL from a machine that can reach Supabase. Migrations stay additive (see `tests/unit/migration-protected-tables.test.ts`)
   so the running code keeps working in between.
3. The first firm and admin of a new workspace come from the operator CLI: `npm run access -- init` then `access -- invite --role ADMIN`.
   `scripts/bootstrap-admin.ts` is removed.
4. Demo data exists only on the local stack (`npm run demo:reset`, localhost-only). `scripts/seed-if-empty.ts`, which existed only for
   hosted demo builds, is removed; `DEMO_ADMIN_*` and `INITIAL_*` have no effect on a build.

**Consequences.**
- A deploy writes nothing; what a build can do no longer depends on unreviewed env values.
- A release with a migration has one manual step, and needs someone with production database access to take it. Until then the build
  fails with a message that says what to run.
- A hosted demo deployment no longer seeds itself; demos run locally (as ADR 0015 already says).
- `DEMO_ADMIN_*` / `INITIAL_*` left in the Vercel environment are inert and can be removed.
- Open (operator decision): a read-only drift check before a release with schema changes, designed and tested separately.
