# Destructive tooling refuses any database or Auth target that is not this machine

## Context
`createPrisma()` connects to `POSTGRES_PRISMA_URL || POSTGRES_URL || DATABASE_URL` (`lib/db.ts:7`), and node-postgres, the driver behind
PrismaPg, dials a `?host=` query parameter over the URL's host and falls back to `PGHOST` for an empty host
(`pg/lib/connection-parameters.js`). The local tooling that wipes or reseeds a database did not check that target:
- `npm run demo:reset` (`scripts/seed.ts`) truncates every table (`lib/demo/seed.ts:31,41`) with no check at all;
- e2e setup (`scripts/e2e-setup.ts:17-18`) and e2e table counts (`:11`) checked only `DATABASE_URL`'s hostname;
- the DB tests pin only `DATABASE_URL` (`vitest.config.ts:13`) while `tests/helpers.ts:4` uses `createPrisma()`, and the test migrations
  (`tests/global-setup.ts:6`) ran `prisma migrate deploy` on `TEST_DATABASE_URL` before any check;
- `lib/db.ts` builds its client when first imported, so a check inside `main()` would run after a client for the target exists;
- the demo admin and e2e member are written to whatever `NEXT_PUBLIC_SUPABASE_URL` holds.

So a shell or `.env` that also held a hosted URL (a pooled override, a `?host=`, a `PGHOST`) sent truncates, reseeds, migrations and Auth
writes there. Found in a release-evidence review of the preview-database hold; the fix was independently reviewed on another base
(one rejection with five findings, then acceptance) and is applied here, byte-identical, to `main`.

## Decisions
- `lib/db-url.ts`: the runtime precedence unchanged (`databaseUrl`), and `assertLoopbackDatabase`, which judges every database variable
  with the parser `pg` itself requires (`pg-connection-string`) and fails closed: postgres schemes only; any `host`, `hostaddr`, `service`,
  `servicefile` or `socket` query parameter refused, even when local; the WHATWG hostname and the driver's host must both be a loopback
  name; `PGHOST` / `PGHOSTADDR` loopback; any `PGSERVICE` / `PGSERVICEFILE` refused; `NEXT_PUBLIC_SUPABASE_URL` loopback http(s). Messages
  name variables, never values.
- `lib/local-database-only.ts`: the check as a side-effect import, placed after `dotenv/config` and before any app module in
  `scripts/seed.ts`, `scripts/e2e-setup.ts`, `scripts/e2e-table-counts.ts` and `tests/helpers.ts`, so a refusal happens before any client,
  truncate, seed or socket. A refused script exits non-zero while it loads.
- `tests/global-setup.ts` checks `TEST_DATABASE_URL` and the `PG*` variables before `prisma migrate deploy` and blanks the `POSTGRES_*` /
  `DIRECT_URL` overrides for that child; `vitest.config.ts` blanks them for the test workers.
- Refused by policy (fail closed): uppercase or trailing-dot `localhost`, other `127/8` addresses, sockets (also `?host=/path`), keyword DSNs,
  host lists, percent-encoded hosts. Accepted: `localhost`, `127.0.0.1`, `[::1]` (and its long form), an empty host with `PGHOST` unset or
  loopback.
- Not changed: runtime connection precedence, `scripts/vercel-build.sh`, `seed-if-empty`, `bootstrap-admin`, operator tools
  (`scripts/access.ts`, `scripts/verify-real.ts`, `scripts/capture-public-demo.ts`). No schema or migration change; no dependency change.
- Notes kept: `pg-connection-string` is imported but reached through `pg` (not declared); a test proves it is the same file `pg` loads.
  Every `prisma` CLI call makes a checkpoint telemetry request unless `CHECKPOINT_DISABLE=1` (pre-existing, not changed here).

## Acceptance criteria
- [ ] A hosted `POSTGRES_PRISMA_URL` / `POSTGRES_URL` / `POSTGRES_URL_NON_POOLING` / `DIRECT_URL`, a `?host=` override, a hosted `PGHOST`, or a
      hosted Auth URL is refused before any client, truncate, seed, reseed, migration or socket; loopback still works.
- [ ] Runtime connection precedence is unchanged; no schema, migration or dependency change.
- [ ] Error messages carry no URL values.
- [ ] Full gate on this exact head: unit + DB (CI env, no Auth), build, `verify:books`, e2e in both modes.

## Tasks
- [ ] T1 Guard and its regressions on `main`.

## Verification
To be recorded for this exact head.
