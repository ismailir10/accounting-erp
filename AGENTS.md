# Buku — Operating Manual (for every coding agent)

> How to work on this repo. [README.md](./README.md) is the *what*; this file is the *how*.
> This file is for every coding agent. `CLAUDE.md` is a symlink to it and `.claude/skills` a symlink to `.agents/skills`,
> so tools that look for those names find the same content. Edit `AGENTS.md`, `docs/workflow/` and the Buku skills in
> `.agents/skills/` — never the vendored workflow skills (§2).
> Rule for editing this file: never hand-write a fact the code owns — link to it instead.

**Product in one line:** AI-native month-end close for Indonesian accounting firms (Rillet-style) —
*rekening koran in → laporan keuangan out, every number traceable to its bank row.*
Language: UI and domain copy in **Bahasa Indonesia**; code, comments, commits in **English**.

---

## 1. First five minutes of any session

```bash
bash scripts/session-start.sh     # starts Postgres, installs deps, migrates, seeds if empty (agents with a session hook run it)
npm run dev                       # http://localhost:3000 — demo firm "KJA Demo & Rekan"
npm test                          # Vitest (unit + DB + demo ground-truth)
npm run verify:books              # layer-2: app balances vs generator truth → must print ALL PASS
```

Then read, in this order: the latest `docs/cycles/*.md` (what happened last), `docs/adrs/` (why things
are the way they are), and the skill for the area you're about to touch (§4).

Next.js here is **16.x** — APIs differ from older training data. When unsure, read
`node_modules/next/dist/docs/` before writing code (`agentRules: false` in `next.config.ts` stops
`next dev` from overwriting this file with its own stub).

## 2. The loop — spec → build → verify-local → ship

The procedure lives in shared skills vendored from `ismailir10/agent-workflow` into `.agents/skills/` (pinned in
`.agents/skills/.agent-workflow.lock`). Never edit them here: `bash scripts/sync-agent-workflow.sh` updates them and
`--check` (in CI) fails on a hand edit. Start with [`working-principles`](.agents/skills/working-principles/SKILL.md):
who drives, the one gate, when to stop and ask, evidence, the proud bar.

| Step | Skill | Buku extensions | Output |
|---|---|---|---|
| `/spec` | [`spec`](.agents/skills/spec/SKILL.md) | [spec.md](docs/workflow/spec.md) | `docs/cycles/YYYY-MM-DD-<slug>.md`. **Stop for approval.** |
| `/build` | [`build`](.agents/skills/build/SKILL.md) | [build.md](docs/workflow/build.md) | One commit per task, gates between tasks, cycle doc updated as you go |
| — | [`verify-local`](.agents/skills/verify-local/SKILL.md) | [verify.md](docs/workflow/verify.md) | The real app walked until you'd demo it; `Verified locally — <sha>` in the cycle doc |
| `/ship` | [`ship`](.agents/skills/ship/SKILL.md) | [ship.md](docs/workflow/ship.md) | Draft PR to `main`, **deck reviewed** for big features, CI green, merge left to the user |

**You drive the loop, not the user.** A change to `app/ lib/ components/ prisma/ scripts/ e2e/` or CI is a cycle
(spec → approval → build → verify-local → ship). A change to docs or Buku skills only (`AGENTS.md`, `docs/**`, the
non-vendored `.agents/skills/*`) is a small PR, with a cycle doc only if it is more than a fix. A question, code read or DB
inspection is answered inline.

A different dev cycle = change agent-workflow upstream and re-sync. Buku-only steps go in `docs/workflow/`, facts in
§3 — not in this section.

## 3. Repo profile

| Key | Value |
|---|---|
| Work record | Cycle doc: `docs/cycles/YYYY-MM-DD-<slug>.md` ([shape](docs/workflow/spec.md#rules)) |
| Read first | The latest `docs/cycles/*.md`, [`docs/adrs/`](docs/adrs/README.md), the §4 skill for the area; [docs/real-data.md](docs/real-data.md) before real client files; `node_modules/next/dist/docs/` for Next.js 16 APIs |
| Base branch | `main` |
| Production branch | `main` — every merge is one Vercel production deploy; no promotion step ([ADR 0015](docs/adrs/0015-production-only.md)). `main` is the only long-lived branch; `staging` is retired (all of it is in `main`; ADR 0015, amended) |
| Branch name | `task/<slug>` |
| Isolation | `git fetch origin && git worktree add ../buku-<slug> -b task/<slug> origin/main`, then Setup inside it. A cloud sandbox's own clone is already isolated |
| Setup | `bash scripts/session-start.sh` (Postgres, deps, migrate, seed if empty; wired as a session-start hook) and `npm run auth:local` (local Supabase Auth, Docker) |
| Run locally | `npm run dev` → http://localhost:3000; final round `npm run build && npm run start -- -p 3200` → http://localhost:3200. Health: `/login` shows the form. [Details](docs/workflow/verify.md#run-the-app) |
| Sign in locally | `/login` with `DEMO_ADMIN_EMAIL` / `DEMO_ADMIN_PASSWORD` from `.env`, created by `npm run demo:reset` on the local stack. Never production |
| Task gate | `npm run lint && npm run typecheck && npm test` |
| Full gate | Task gate **+** `npm run build && npm run demo:reset && npm run verify:books && npm run test:e2e` (`verify:books` → ALL PASS). `test:e2e` builds nothing itself (it starts `next start`) and needs `npm run auth:local`. Cloud sandbox with a preinstalled browser: `PW_CHROMIUM=/opt/pw-browsers/chromium`, never `playwright install` |
| CI | `.github/workflows/ci.yml` job `check` (sync `--check`, lint, typecheck, `npm test`, build on a Postgres service) on every ready PR and push to `main`; drafts skip it; `check` is required to merge. `.github/workflows/e2e.yml` (local Supabase, `verify:books`, Playwright) only on pushes to `main`, manual dispatch or the `e2e` label — add the label when the PR touches an app flow or auth |
| Load on demand | [§4](#4-where-the-rules-live-load-on-demand) |
| Sensitive paths | `lib/auth.ts lib/auth/** lib/supabase/** lib/tenant.ts proxy.ts lib/settings/** lib/upload-links.ts app/*actions.ts app/api/** app/auth/** app/login/** app/atur-sandi/** app/kirim/** scripts/access.ts prisma/migrations/** .github/workflows/**` |
| Docs to keep true | [README](README.md) (routes, modules, env vars, setup, commands); `.env.example` for env vars; §5 for new modules; `docs/demo/investor-demo.md` + `e2e/investor-demo.spec.ts` together when the demo walk changes; `public/deck/` claims for big features ([ship.md](docs/workflow/ship.md#deck-review)) |
| Commit style | §8: conventional subject, one task = one commit, body says why and ends `Cycle: docs/cycles/<file>.md` |
| Attribution | None: no AI-tool names anywhere, no attribution trailers, no "generated with" footers (§8) |
| Merge | The user merges into `main` (merge to `main` = production deploy). The agent stops at "ready": CI green, evidence for the head SHA |
| Post-merge | Production `/login` form, migrations line in the build log, Beranda shows the real firm ([ship.md](docs/workflow/ship.md#post-merge)) |

## 4. Where the rules live (load on demand)

| Touching | Load first |
|---|---|
| `lib/ledger/** lib/import/** lib/ledger-import/** lib/fx/** lib/classify/** lib/ai/** lib/reports/** lib/controls/** prisma/**` | [`accounting-rules`](.agents/skills/accounting-rules/SKILL.md) — **non-negotiable invariants** |
| `app/** components/**` | [`ui-rules`](.agents/skills/ui-rules/SKILL.md) — Ramp-style look with one strong blue, shadcn-first, "don't make me think" |
| `lib/demo/** scripts/seed.ts e2e/**` | [`demo-data`](.agents/skills/demo-data/SKILL.md) |
| Anything that changes a number on a report | [`verify-books`](.agents/skills/verify-books/SKILL.md) |

Top five invariants (full list in `accounting-rules`):
1. **GL is the single source of truth.** No stored balances; TB/FS are derived from `JournalLine`.
2. **`postJournal()` is the only writer** of journals. Balanced, open period, client COA — plus DB CHECKs.
3. **Money is `bigint` minor units of the entity's currency** (IDR = whole Rupiah). Never `Number`/`parseFloat` an amount. Use `lib/money.ts`.
4. **AI never auto-posts.** LLM suggestions go to review; only deterministic methods post directly.
5. **Every entry keeps its source** (`bankTransactionId`, or `ledgerImportId` + `sheet!row`) so any report number drills to its source row.

## 5. Repo map

```
app/(app)/                 pages (Beranda + /clients/[id]/{import,review,ledger,trial-balance,reports,journals/new,close,settings})
app/*actions.ts            server actions — the only UI write paths, each through `requireCapability` (or `requirePlatformAdmin`)
components/ui/             shadcn (base-nova on @base-ui/react), vendored — edit sparingly
components/app/            product components (Money, StatusPill, NextStep, charts, forms)
components/motion/         the few approved motions (CountUp, CheckDraw, DotGrid, ProgressFill), ported from React Bits
lib/ledger/                postJournal, bank posting + reclass
lib/import/                parsers (25 banks from lib/banks.ts, MT940, generic, combined PDFs), Atur kolom (grid, mapped), normalize (merchant key, continuity), pipeline
lib/ledger-import/         ledger/Neraca files: read → check → map (source accounts) → post
lib/fx/                    currency registry + exact rate math, Kurs table, revaluation
lib/classify/  lib/ai/     transfer matcher, rules, memory; OpenAI-compatible LLM provider + cache + budget
lib/reports/  lib/controls/ TB, Laba Rugi, Neraca, client report format, Excel/PDF set, combined worksheet, tax card; close controls + lock
lib/demo/                  scenario generator, bank-format writers, seed, ground-truth verifier
prisma/                    schema + migrations (CHECK constraints live in the init migration)
tests/{unit,db}/           Vitest (DB tests use buku_test)       e2e/  Playwright investor walk
docs/{cycles,adrs,demo}/   history, decisions, demo script
```

## 6. Environment

- Postgres 16 locally (`docker compose up -d` or the sandbox's preinstalled server); Supabase Postgres in production ([ADR 0010](docs/adrs/0010-supabase-platform.md)).
- Login = Supabase Auth, email + password. **Production is the only hosted environment** ([ADR 0015](docs/adrs/0015-production-only.md)): local dev and e2e
  use a throwaway local Supabase stack (`npm run auth:local`, needs Docker; in a cloud sandbox start `dockerd` first). Never point dev, seeds
  or e2e at production. Access = an organisation's grants + `FirmMember` (OWNER | ADMIN | AKUNTAN | VIEWER, clients assigned);
  Buku admins (`PlatformAdmin`) work in `/backoffice` ([ADR 0017](docs/adrs/0017-trial-tenants-roles.md)).
- `.env` from `.env.example`. `DEMO_MODE=true` enables synthetic demo fixtures; see [operator reset boundaries](README.md#deploy-vercel--supabase).
- AI: `AI_BASE_URL` (env-only, default OpenCode Zen); key + model from **Backoffice → Pengaturan AI** (encrypted, `SETTINGS_SECRET`,
  Buku admins only), else `AI_API_KEY` / `AI_MODEL`; a monthly token cap per organisation. No key = rules-only mode, fully working.
- Real client files: only locally or in production, the one real workspace ([ADR 0008](docs/adrs/0008-one-workspace.md)); local is synthetic. Read [docs/real-data.md](docs/real-data.md) first.
  **Credit is limited** — tests and seed never call a real model (MockProvider + cache). `npm run ai:smoke` makes one real call.
- Access and environment setup: [README → Access operations](README.md#access-operations). Session tenancy lives in [`lib/tenant.ts`](lib/tenant.ts), authentication in [`lib/auth/`](lib/auth/).

## 7. Deliberately not copied from annisaa-erp-v3 (and why)

Session-role files, worktree scripts, git-hook suite, doc-count audits.
Greenfield + one developer + CI as the enforcement boundary doesn't need them yet. Add one only
when a real incident shows the need, and record it as an ADR.

## 8. Commits & PRs

- Conventional subjects: `feat(scope): …`, `fix(scope): …`, `docs: …`, `test: …`. One task = one commit.
- Body references the cycle doc: `Cycle: docs/cycles/<file>.md`.
- Never commit `.env`, real client statements, or anything under `data/private/` (gitignored). Demo data is synthetic only.
- PRs are drafts to `main`, body follows `.github/pull_request_template.md`.
- **Tool-neutral.** Any coding agent (or person) works here the same way: branches `task/<slug>`, no AI-tool names in
  branches, code, docs, commits or PRs, and no AI attribution trailers or "generated with" footers.
- Branch lifecycle and production deploys: follow [README → Branch workflow](README.md#branch-workflow), the ship skill and [docs/workflow/ship.md](docs/workflow/ship.md). Start new work from main; a task branch lives only until its PR merges or is closed (GitHub deletes merged branches; delete a closed one by hand).
