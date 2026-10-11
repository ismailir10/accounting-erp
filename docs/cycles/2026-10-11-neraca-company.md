# A Neraca finds its company when the client has several

## Context
Follows [`2026-10-11-import-quality.md`](2026-10-11-import-quality.md) (#151). Walking Chickin showed that a Neraca dropped in Unggah for a client
with two or more companies always failed ("Pilih entitas untuk neraca ini"): the inbox passes an entity only when the client has exactly one.
A Neraca is usually the first file an accountant has, and its title already names the company.

## Spec
- When a Neraca (a file with no entity column) is staged for a client with several companies, the company is the one the file's title rows
  name (`companyFromTitleRows`, matched with `matchEntity`: same words in any order, legal form ignored). So the company *Tambah klien*
  proposes from a Neraca's title is the one its next Neraca goes to.
- No match (a title naming nobody the client has, or no title): unchanged — the line says a company is needed.
- Nothing is guessed from a file name; a ledger file with an entity column is unchanged.
- No schema change.

## Tasks
- [x] T1 `stageLedger` retries a Neraca refusal with the company its title names — accept: the new case in `tests/db/inbox-process.test.ts`.

## Implementation
- `stageLedger` (lib/inbox/process.ts): the entities now carry `name`/`shortName`; `stage(sheet?)` calls `stageImport` and, only on the
  "Pilih entitas untuk neraca" refusal for a client with several companies, reads the file's title rows once and retries with the matched
  entity. Works for a single-sheet file and for each sheet of a multi-sheet one.

## Verification

## Ship Notes
- No migration, no env change. Rollback: revert the PR.
