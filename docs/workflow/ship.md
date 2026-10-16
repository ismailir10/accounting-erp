# Ship — Buku extensions

Extends the shared [`ship`](../../.agents/skills/ship/SKILL.md) skill; each section adds to the step of the same name.
Commands and paths: [AGENTS.md § Repo profile](../../AGENTS.md#3-repo-profile).

## Preflight

- The cycle doc's Implementation, Verification (the verify-local block, with the `verify:books` and e2e tails) and Ship
  Notes are filled.
- The branch is not `main`, and its base is `main` (the only long-lived branch).
- Big feature? The deck review below is part of this PR, not a follow-up and not a cycle task.

## PR body

Open a **draft** PR to `main`. The body follows `.github/pull_request_template.md`, with the shared sections slotted in:

| Template section | Holds |
|---|---|
| Summary | the shared Summary |
| Cycle doc | `docs/cycles/<file>.md` |
| How to verify | the template's checkboxes, ticked, followed by the shared **Verified locally** block |
| Screenshots | the highlight shots, or `n/a — no UI change` |
| Deck | the result of the deck review below |
| Risks / follow-ups | the shared **Decisions made**, **Merge danger** and **Ship notes**, as sub-headings |

### Deck review

Right after the PR is open, for every big feature: anything a buyer would notice (a new capability, a new bank or file
format, a changed flow, a removed limit, a new report, a number the deck quotes). The decks are the sales story and must
say only what Buku does today.

1. Read `public/deck/index.html` (chooser), `kantor.html` (firms) and `perusahaan.html` (companies); list every claim
   the feature touches: capability lists, counts ("4 bank"), format chips, the limits slides, objection answers, demo
   numbers.
2. Update stale claims in this PR as a separate commit (`fix(deck): …`), keeping the deck's grammar: one idea per slide,
   ≤ 3 short points, Bahasa, no slop ([deck rebuild cycle](../cycles/2026-10-08-deck-rebuild.md)). Never claim what is
   not merged. Then `npm run deck:pdf` so the downloadable PDFs match.
3. Look at each changed slide at 1440×900 and 375×812 (`npm run dev` → `/deck/kantor#<n>`): no overflow, no bad wraps.
4. Record the result in the cycle doc's Ship Notes and the PR's **Deck** section: slides changed, or
   "no deck change — <why>". Small fixes, refactors and docs-only PRs say "n/a".

## CI

- Drafts skip CI. Once verify-local passed and the deck review is done, mark the PR ready (`gh pr ready <pr>`); that
  starts `ci.yml` (`check`, the required check).
- `e2e.yml` runs only on pushes to `main`, manual dispatch, or a ready PR with the `e2e` label. Add the label when the
  PR touches an app flow or auth (`app/`, `components/`, `lib/auth*`, `lib/supabase/`, `proxy.ts`, `e2e/`, the demo
  scenario); adding it to a ready PR starts the run at once.

## Merge

- The user merges, unless they said otherwise. Merging to `main` is a production deploy (the real workspace): it is the
  only Vercel build, and PR branches get no preview (`vercel.json`). When CI is green, say it is ready and stop.
- After the user merges: GitHub deletes the remote task branch. Locally fast-forward `main` from `origin/main`,
  `git fetch --prune`, delete the merged task branch and its worktree, then run the post-merge checks. Never delete
  `main`. GitHub deletes only merged branches: when a PR is closed unmerged, delete its branch by hand.

## Post-merge

Verify the production deployment (`https://native-erp-v2.vercel.app`):

- `/login` shows the email + password form, not "Akses belum siap";
- the build log says "Database schema is up to date!" (every migration recorded as applied, none failed; not a drift check) and
  shows no seed, demo-admin or invitation output;
- Beranda shows the real firm's clients, not "KJA Demo & Rekan".

Hosted builds never seed demo data ([ADR 0019](../adrs/0019-builds-never-write.md)): walk
[docs/demo/investor-demo.md](../demo/investor-demo.md) on the local stack.

## Promotion

There is no promotion step: `main` is production ([ADR 0011](../adrs/0011-main-only-releases.md),
[ADR 0015](../adrs/0015-production-only.md)). Deploy and environment work happens only when the user asks.

Vercel project `native-erp-v2` (team "Ismail's projects", slug `ismails-projects-196d40d3`) + Supabase org Rightjet,
project `native-erp-v2` (production, the only hosted environment). The environment ↔ Supabase project map and the env
var list are owned by [README → Deploy](../../README.md#deploy-vercel--supabase) and
[ADR 0008](../adrs/0008-one-workspace.md); check them, don't restate them.

- **Production (`main`) is the one real workspace**: `DEMO_MODE=false`, invitation login. Real client files live there
  or locally, nowhere else. Development, CI and e2e use the local Supabase stack; never point them at production.
- A login that says "Email atau kata sandi tidak cocok" for a known member: first check which Supabase project the
  environment's `NEXT_PUBLIC_SUPABASE_URL` and database URL point at (auth users and members must be in the same one).
- **Build:** `npm run vercel-build` → `scripts/vercel-build.sh`: `prisma generate`, a read-only `prisma migrate status` on
  `POSTGRES_URL_NON_POOLING` (a pending or failed migration fails the build; drift is not detected), `next build`. It writes nothing to the database or
  Auth. A migration is applied deliberately before its code merges (README → Schema changes).
- **Env vars** that matter are the Production ones; the Preview environment is unused.
  - Inspect names with `vercel env ls production` (values stay hidden). The Vercel MCP cannot list env vars (403): use
    the CLI or the dashboard.
  - Non-secret values (`APP_URL`, `EVIDENCE_ENABLED`, `GOOGLE_REDIRECT_URI`, `GOOGLE_CLIENT_ID`) you may set with `printf %s VALUE | vercel env add NAME production`.
  - **Secrets are set by the user or the Supabase integration** (`GOOGLE_CLIENT_SECRET`, `SETTINGS_SECRET`,
    `DEMO_ADMIN_PASSWORD`, Supabase keys and DB URLs): give them a command that pipes the value straight in.
    Secret-type vars cannot be pulled back; generate or rotate instead.
  - Env changes take effect only after a redeploy: `vercel redeploy <latest production URL> --target production`
    (ask first).
- **Google OAuth** (GCP project `native-erp-v2`, testing mode): the client lists the production and `localhost`
  `/api/google/callback` URLs, and the connecting Google account must be a test user.
- `SETTINGS_SECRET` encrypts the Drive refresh token and the Pengaturan AI key. Changing it (or pointing at a DB written
  under another secret) means reconnecting Google and re-saving the AI key.
- Cloud sandboxes may not reach Supabase (proxy): never migrate or seed a hosted database from a sandbox. The build does not
  migrate either; an operator applies a migration from a machine that can reach Supabase (README → Schema changes).
