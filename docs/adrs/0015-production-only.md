# 0015 — Production is the only hosted environment

**Status.** Accepted, 2026-10-07 (owner: "just use production and treat it as the only"). Supersedes the remaining staging parts of
[0008](0008-one-workspace.md), [0010](0010-supabase-platform.md) §5 and [0011](0011-main-only-releases.md).

**Context.** [0011](0011-main-only-releases.md) already stopped deploying staging: PRs merge to `main` and each merge is one production
deploy. Staging survived only as the Supabase project `native-erp-v2-staging`, used for local-development Auth, e2e from a laptop and
on-demand previews. With one developer in the development phase, a second hosted environment costs attention without catching
anything CI does not. Cloud agent sandboxes could not reach it at all.

**Decision.**
1. **Production (`main`, Vercel project `native-erp-v2`, Supabase project `native-erp-v2`) is the only hosted environment.** Staging is
   retired: no previews, no local-dev Auth against it, no e2e against it. The git branch `staging` stays frozen as history (amended 2026-10-16: retired too, see below).
2. **Development and tests run on a throwaway local stack, never on production.**
   - Postgres: local (`docker compose` or the sandbox cluster).
   - Auth: the local Supabase stack CI already boots, via `npm run auth:local`. It needs Docker, and it writes the local URL and keys
     into `.env`.
   - The e2e setup still refuses any non-localhost database, because it reseeds and creates test accounts.

   So no test account, seed or synthetic data ever reaches production users or books.
3. **Checking a release** is CI (unit, DB, ground-truth `verify:books`, the full e2e on the local stack), then a read-only check of
   the production deploy: build log, migrations applied, `/login` up, no runtime errors.

**Consequences.**
- One set of production env vars. The Vercel *Preview* environment and the `native-erp-v2-staging` project are unused; the owner may
  pause or delete them.
- The Google OAuth client must list only the production and `localhost` callbacks.
- A laptop needs Docker for login in development. Without it, the app runs but stays on its "Akses belum siap" page.

**Amendment, 2026-10-16.** The owner asked for `main` to be the only branch. `staging` held no commit `main` lacks, so its history
is kept in `main` and the branch itself is retired: it is no longer protected or kept. Decision 1 otherwise stands.
