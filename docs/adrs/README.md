# Architecture decisions

One file per decision: context → decision → consequences. Supersede, don't edit history.

| ADR | Decision |
|---|---|
| [0001](0001-stack.md) | Next.js 16 + Prisma 7 + Postgres (Neon in prod), local-first |
| [0002](0002-money-and-ledger.md) | BigInt Rupiah, single journal writer, GL-derived reports |
| [0003](0003-hybrid-ai.md) | Hybrid classification; OpenAI-compatible LLM last, never auto-posting |
| [0004](0004-wedge-and-scope.md) | Wedge = accounting firms, statement-driven close; what the MVP leaves out |
| [0005](0005-synthetic-demo-data.md) | Synthetic, deterministic demo data seeded through the real pipeline |
| [0006](0006-ledger-input-and-multicurrency.md) | Ledgers + Neraca as input, per-entity source accounts, functional currency per entity (updates 0002, 0004) |
| [0007](0007-evidence-workspace.md) | Versioned evidence beside the ledger, read-only Drive, cited answers and shared AI budgets |
| [0008](0008-one-workspace.md) | One workspace: production holds the real firm; staging is synthetic pre-production (staging part superseded by 0011) |
| [0009](0009-ai-in-the-close.md) | AI in the close: deterministic sanity controls first; AI explains and proposes with citations, never posts |
| [0010](0010-supabase-platform.md) | Supabase platform: email + password login, members with roles, who-did-what |
| [0011](0011-main-only-releases.md) | Merge to main directly; Vercel builds production only; staging frozen (supersedes part of 0008) |
| [0012](0012-no-plug-findings.md) | No plug: a Saldo Awal difference waits on 3290 as a Temuan (finding) the accountant resolves in writing; the close FAILs until then |
| [0013](0013-removing-an-import.md) | An admin removes a posted import (open months, nothing resting on it, with a reason) instead of reversing it; append-only change log `AuditEvent` |
| [0014](0014-three-stage-spine.md) | Three stages per client-month (Sumber → Buku Besar → Laporan) + a firm close board; AI proposes, arithmetic proves, the accountant approves; iteration order I0–I5 (updates 0004) |
| [0015](0015-production-only.md) | Production is the only hosted environment; development and e2e use a throwaway local Supabase stack (`npm run auth:local`), never production (supersedes the rest of staging in 0008/0010/0011) |
| [0016](0016-ramp-restyle.md) | Ramp-style look: Hanken Grotesk, warm greys, strong blue `#2152E8`, 8–16px radii (replaces Inter + Newsreader, ink blue, 2px) |
| [0017](0017-trial-tenants-roles.md) | Trial access by grant with a period; organisations (firm or company) → client → entity; Buku admins in a backoffice with read-only support sessions; four roles with client assignment; AI key owned by Buku (updates 0008, 0010) |
| [0018](0018-pdf-password-keyring.md) | PDF passwords that opened a client's statement are kept per client, encrypted, tried first on the next locked file; admins can clear them (replaces "never stored") |
