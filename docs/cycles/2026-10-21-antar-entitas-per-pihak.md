# Core accounting parity, round six: Antar entitas per pihak

**Roadmap:** core accounting parity with Jurnal and Zahir (`docs/roadmap.md` §3, GL integrity and Reports rows), the gap
[round five](2026-10-21-uji-keras-grup.md) found and carried over, under the owner's request of 2026-10-20 to keep going until Buku is on par.

## Context
A client's chart has one intercompany account, **1190 Piutang/Utang Antar Entitas**, shared by every company of the group. With two
companies (a PT and its owner, the common case) the other party is implied and nothing is wrong. With three or more, 1190 nets different
related parties together, and round five's probes showed three wrong outcomes:
- **PT's own Neraca** offsets a receivable from the CV (100) against a payable to the owner (300) and shows one *Utang antar entitas* 200;
  assets are understated by 100. There is no right of set-off between different parties (PSAK 207/SAK EP: no offsetting without one).
- **PT's own cash flow** nets lending to the CV (investing −70) with borrowing from the owner (financing +40) into one line (investing −30,
  financing 0).
- **The intercompany control** tests only the group total: PT books +100 to the CV but the CV books it as a sale, and the CV books −100 from
  the owner who books it as prive; the totals offset, the control PASSes ("Tereliminasi 100") while both pairs are broken and group
  revenue carries a loan as a sale.

Jurnal and Zahir keep a related-party account per company (*piutang/utang afiliasi* per pihak). Who feels it: the accountant of a group of
three or more companies, the partner signing each company's own statements, the bank reading them.

## Decisions
- **One intercompany account per counterparty**, only for a client with three or more companies (two companies keep 1190; the other side is
  implied): `1190NN` *Piutang/Utang Antar Entitas — <nama singkat>*, `isIntercompany`, `Account.counterpartyEntityId` = that company.
  Created for every company when the client gets its third (and for a fourth when added); renamed with the company. A company never posts
  to its own account (`postJournal()` refuses it).
- **Writers:** the transfer matcher posts each half to the account of the *other* company (a paired transfer, and an unpaired one naming
  a group company); Review, Jurnal Penyesuaian, Saldo Awal and ledger-import mapping offer the accounts like any other (their names say
  the party).
- **A company's own statements** show each counterparty account by its sign: a receivable from the CV as an asset, a payable to the owner
  as a liability — never netted. Its cash flow keeps lending (investing) and borrowing (financing) per counterparty.
- **Gabungan and any scope of several companies:** balances between companies in the scope eliminate (their intercompany accounts are read
  together, as 1190 is today); a balance with a company outside the scope is shown as above.
- **Kertas kerja gabungan and the control eliminate per pair:** company A's account for B against B's account for A. The control names
  every pair that does not mirror ("PT–CV selisih 100; CV–Andi selisih 100") and is PASS only when each pair is zero.
- **Old balances on 1190** in a client with three or more companies cannot tell their party: a REVIEW control lists them per company, the
  way out a Jurnal Penyesuaian moving them to the party's account (nothing is moved by itself).

## Acceptance criteria
- [x] A client with three companies has `119001`–`119003`; adding a fourth adds `119004`; a client with two keeps 1190 only.
- [x] A paired transfer PT → CV posts PT's half to *Antar Entitas — CV* and the CV's half to *Antar Entitas — PT*; the Kertas kerja
      eliminates them as a pair; the control PASSes.
- [x] PT's own Neraca shows *Piutang antar entitas* 100 (CV) and *Utang antar entitas* 300 (owner); its cash flow shows lending to the CV
      in investing and borrowing from the owner in financing.
- [x] Two broken pairs that offset make the control REVIEW naming both pairs.
- [x] A 1190 balance in a three-company client is a REVIEW with the way out; `postJournal()` refuses a company's own account.
- [x] Gabungan totals unchanged for a mirrored group (no intercompany line, same assets as today); full gate green; `verify:books` ALL PASS.

## Non-goals
- Eliminating intra-group income, expense or investments (round five's decision: Gabungan stays an aggregation).
- Moving old 1190 balances by themselves.
- Per-counterparty accounts for a two-company client.

## Gate re-openers
- A migration: `Account.counterpartyEntityId` (nullable, `SetNull` when the company is removed). Additive.
- `postJournal()` gains one refusal (a company's own intercompany account). Tightened, not relaxed.

## Tasks
- [x] T1 Schema + migration (`20261021120000_intercompany_counterparty`, with a backfill for existing groups of three or more);
  `ensureIntercompanyAccounts` on client creation and *Tambah perusahaan*, the name on rename, removal with the company; `postJournal()`
  refusal.
- [x] T2 Transfer matcher per counterparty; `isIntercompanyCode` wherever 1190 was special.
- [x] T3 Reports: Neraca and cash flow internal vs external; Kertas kerja per pair; the control per pair and `intercompany-party`.
- [x] T4 Tests (`tests/db/intercompany-party.test.ts`, round five's group tests moved to the party accounts), README, accounting-rules.

## Implementation
- `lib/coa/intercompany.ts`: `ensureIntercompanyAccounts(tx, clientId)` creates `1190NN` for every company of a client with three or more
  (lowest free code, by company id — the migration's backfill uses the same order); `intercompanyCodes` maps a company to its account.
- `postJournal()` refuses a company's own account. `removeEntity` deletes the company's account while it is unused, else refuses with
  the reason; `renameEntity` renames it.
- The matcher takes `intercompanyCode(companyId)`: each half of a pair on the other's account; an unpaired line naming a group company
  on that company's account.
- `balanceSheet`: intercompany accounts whose company is in the scope (and 1190 in a scope of several) are read as one balance; the rest
  stay per account, so a company's own Neraca keeps each party apart. `cashFlow` keys lending/borrowing the same way.
- `combinedWorksheet` returns `pairs` (every company pair whose two sides differ) and eliminates a per-company account row by what the
  other side shows back; the `intercompany` control lists broken pairs; `intercompany-party` lists balances left on 1190.

Decisions taken while building:
- **Codes `1190NN`** (six digits, sorted between 1190 and 1199) rather than a new range: the chart already reads 1190 as intercompany,
  and `isIntercompanyCode` keeps every "is this a transfer account" check in one place.
- **Pairs read in the worksheet's company order** (companies by name, owners last), as the columns do.
- **1190 stays in the pickers** of a three-company client: it is where an old balance is moved from.

## Verification
Verified locally — 65bdb2c.
- `npm run lint && npm run typecheck && npm test`: exit 0; **341 files, 3126 tests passed** (two tests that count a client's accounts
  updated: a third company now adds its intercompany accounts, and removing it removes its own).
- `npm run build && npm run demo:reset && npm run verify:books`: build OK; **ALL PASS — 1765 checks** (the demo group has two companies:
  its 1190 is unchanged); `db:drift` clean.
- `npm run test:e2e` on the production build with CI's env: **135 passed (16.3m)**.

## Ship Notes
