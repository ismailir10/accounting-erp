# A production build writes nothing to the database or Auth

## Context
Every merge to `main` is a production build, and `scripts/vercel-build.sh` ran, against the production database, whatever its
environment selected:
- `prisma migrate deploy` (DDL);
- `seed-if-empty` when `DEMO_MODE=true` (an empty database is truncated and seeded; on every build the demo admin's password is reset and
  it is forced back to ADMIN and enabled in the first firm);
- `bootstrap-admin` when `INITIAL_*` is set (a firm when none exists, and an ADMIN invitation whenever that member is missing).

Whether a deploy wrote anything therefore depended on env values and database state that are not reviewed at merge time. Raised in the
release review of the local DB guard; the user asked to fix Buku and ship it safely today.

## Decisions
- [ADR 0019](../adrs/0019-builds-never-write.md): the build runs `prisma generate`, a read-only `prisma migrate status` (a pending or failed
  migration fails the build) and `next build`, and nothing else. There is no flag that brings back the old steps.
- `scripts/seed-if-empty.ts` (hosted demo builds only) and `scripts/bootstrap-admin.ts` (build-time first admin) are removed. The first
  firm and admin come from the operator CLI (`npm run access -- init`, `invite --role ADMIN`); demo data is local-only (`npm run demo:reset`).
- A migration is applied deliberately before its code merges (`npm run db:migrate`, README → Schema changes).
- Limit, stated rather than solved: `migrate status` is not a drift check. An unknown extra applied migration, a checksum mismatch and a
  dropped column all read "up to date" (reproduced on fictional copies). The old `migrate deploy` was equally blind. A drift check is left
  as an open operator decision.

## Acceptance criteria
- [ ] With any combination of `DEMO_MODE`, `DEMO_ADMIN_*` and `INITIAL_*`, the build calls only `prisma generate`, `prisma migrate status`
      (direct URL) and `next build`; a pending or failed migration stops it before `next build`.
- [ ] A real build against fictional databases leaves every table unchanged and contacts no Auth, including with the `INITIAL_ADMIN_EMAIL`
      member absent and with no firm at all.
- [ ] Local demo and test setup still work (guarded `demo:reset`, e2e setup).
- [ ] Full gate on the final head.

## Tasks
- [ ] T1 Build script, removed hooks, docs and ADR, regression tests.

## Verification
To be recorded for the final head.
