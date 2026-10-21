# Core accounting parity, round ten: Departemen & Proyek on invoices, schedules and fixed assets

**Roadmap:** core accounting parity with Jurnal and Zahir (`docs/roadmap.md` §3), the non-goal of
[round eight](2026-10-21-departemen-proyek.md) that matters most: Zahir tags a sales invoice, a purchase and a fixed asset with its
department and project; Jurnal tags every transaction.

## Context
A contractor bills each project by invoice (Piutang & Utang), buys materials for it by purchase invoice, and depreciates the equipment
of a division. Today those journals carry no tag, so the Laba Rugi per proyek shows the project's bank-paid costs and none of its
revenue: the margin it exists to show is wrong. The same holds for a prepaid rent amortised per outlet and for an accrual schedule.

## Decisions
- **An invoice carries one department and one project** (`Invoice.departmentId`, `projectId`), set on the form when the client has
  any; its journal tags the revenue / expense (or asset) line only — never the receivable / payable or PPN line. Voiding mirrors them.
  Settlements are balance-sheet only and carry none.
- **A schedule carries them too** (`AdjustmentSchedule.departmentId`, `projectId`): each instalment tags its income or expense side;
  the balance-sheet side (prepaid, accumulated depreciation, accrued) stays untagged. A running schedule's tags can be changed; only
  later instalments follow (posted ones are immutable, rule 3).
- **A fixed asset's tags are its depreciation schedule's**, set on the register form; its disposal tags the gain / loss line.
- The same `postJournal()` check as round eight: the client's own, the right kind, not archived (a running schedule whose tag was
  archived keeps posting it, as a bank line does).

## Acceptance criteria
- [x] A sales invoice for PRJ-01 and a purchase invoice for it: the Laba Rugi per proyek shows PRJ-01's revenue and cost; the
      receivable, payable and PPN lines carry no tag.
- [x] A prepaid rent schedule for Outlet A: each instalment's expense is Outlet A's; changing the schedule to Outlet B moves only
      later instalments.
- [x] A fixed asset for Outlet B: its depreciation and its disposal gain or loss are Outlet B's.
- [x] Full gate green; `verify:books` ALL PASS.

## Non-goals
- Tags on leases, employee benefits, inventory counts, CKPN and ledger imports.
- Changing the tags of a posted invoice (void and re-enter, as for any other field).

## Gate re-openers
- A migration: nullable `departmentId` / `projectId` on `Invoice` and `AdjustmentSchedule`. Additive.

## Tasks
- [x] T1 Schema; invoice tags (form, journal, void).
- [x] T2 Schedule tags (create, change, instalments, accrual reversal); fixed-asset register and disposal.
- [x] T3 Tests, e2e, README, accounting-rules, deck.

## Implementation
- **T1** `ad98d6e` — migration `20261021150000_departemen_proyek_dokumen` (nullable tags on `Invoice` and `AdjustmentSchedule`); `checkTags`
  in `lib/dimensions` (the client's own, the right kind, not archived unless already carried); `createInvoice` tags the revenue / expense
  line, `voidInvoice` mirrors it; the Piutang & Utang form's pickers; `removeDimension` counts invoices and schedules.
- **T2** `be5ba29` — `createSchedule` / `setScheduleTags` (later instalments only; a Riwayat event); `postInstallment` tags the income /
  expense side as the schedule holds it at posting; `postJournal()` lets a schedule's instalment keep an archived tag; the asset register
  passes its tags to the depreciation schedule; `disposeAsset` tags the gain or loss line. The schedule panel's form and *Departemen*
  dialog; the asset form's pickers.
- **T3** — `tests/db/dimensions-documents.test.ts` (5 cases), `e2e/departemen-proyek-dokumen.spec.ts`, README, accounting-rules 3b.

### Decisions made while building
- **A schedule takes tags only when one side is income or expense** (refused otherwise): a balance-sheet reclass has no P&L to label.
- **The tag is read when the instalment posts**, not stored per month: a change applies from the next posting, which is what the
  accountant sees on the panel.
- **Land** has no depreciation schedule, so its disposal gain or loss carries no tag (it can be retagged by a Jurnal Penyesuaian).
- **An archived tag on a disposal is refused** (it is a new ADJUSTMENT, not a schedule instalment): reactivate the department first.

## Verification
- `tests/db/dimensions-documents.test.ts` 5 cases; `e2e/departemen-proyek-dokumen.spec.ts` (moved to July–August so it never shifts
  the firm's working month, which had made the investor walk look for August's task in September).
- Full gate on `6cb9050` (rounds nine and ten together): **358 files, 3303 of 3304 tests passed**. The one failure,
  `ai-background` "a time box that ends with work left…", is a 20 ms wall-clock budget test outside this diff; it failed while a build and
  the e2e suite shared the machine and passed 5 of 5 on its own and in every earlier full run.
- `npm run build && npm run demo:reset && npm run verify:books`: **ALL PASS — 1765 checks**; `db:drift` clean.
- `npm run test:e2e` on the production build of 0a3d64e: **137 passed (18.0m)**.

Verified locally — 0a3d64e

## Ship Notes
