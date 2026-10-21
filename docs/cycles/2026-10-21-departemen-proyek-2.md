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
- [ ] A sales invoice for PRJ-01 and a purchase invoice for it: the Laba Rugi per proyek shows PRJ-01's revenue and cost; the
      receivable, payable and PPN lines carry no tag.
- [ ] A prepaid rent schedule for Outlet A: each instalment's expense is Outlet A's; changing the schedule to Outlet B moves only
      later instalments.
- [ ] A fixed asset for Outlet B: its depreciation and its disposal gain or loss are Outlet B's.
- [ ] Full gate green; `verify:books` ALL PASS.

## Non-goals
- Tags on leases, employee benefits, inventory counts, CKPN and ledger imports.
- Changing the tags of a posted invoice (void and re-enter, as for any other field).

## Gate re-openers
- A migration: nullable `departmentId` / `projectId` on `Invoice` and `AdjustmentSchedule`. Additive.

## Tasks
- [ ] T1 Schema; invoice tags (form, journal, void).
- [ ] T2 Schedule tags (create, change, instalments, accrual reversal); fixed-asset register and disposal.
- [ ] T3 Tests, e2e, README, accounting-rules, deck.

## Implementation

## Verification

## Ship Notes
