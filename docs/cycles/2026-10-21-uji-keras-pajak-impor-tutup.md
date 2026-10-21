# Core accounting parity, round seven: a hard test of tax, ledger import and the close

**Roadmap:** core accounting parity with Jurnal and Zahir (`docs/roadmap.md` §3: Tax, Moving books in, Close, Journal approval rows),
under the owner's request of 2026-10-20 to keep testing hard. [Round one](2026-10-20-paritas-inti.md) and
[round five](2026-10-21-uji-keras-grup.md) found 34 defects by building hand-computed cases through the real writers; this round takes the
three areas neither touched.

## Context
- **Tax** is where Buku claims to lead (Pajak Masa workpaper, PPh 21 TER, PPh badan pack, Coretax reconciliation, faktur and BPPU files).
  A wrong PPN or PPh figure reaches a SPT the client signs.
- **Moving books in** (Jurnal, Accurate and Excel GL / Neraca exports, mapped to the client's chart) is how every client with history
  starts; an import that posts a wrong balance poisons every month after it.
- **The close** (controls, sign-offs, lock in order, reopen with a reason, Persetujuan kedua, schedules and recurring journals, the
  checklist) is the product's spine; a month that locks with something wrong, or a write that slips into a locked month, is the worst
  kind of defect.

## Decisions
- **Hunt, then fix**, as round five: each area is probed at the database level through the real writers (tax posting and pack
  functions, `stageImport` / mapping / post, `lockPeriod` / `unlockPeriod` / approvals / schedules / recurring), every expected figure
  computed by hand first. A defect is a failing test naming the wrong number or behaviour and the right one.
- **Every confirmed defect is fixed in this round** with its test kept as a regression test; a product decision (two defensible
  treatments) is logged under *Decisions taken while building*, never silently changed.
- No new module; a schema change only if a defect needs one (named under Gate re-openers first).

## Acceptance criteria
- [ ] Each of the three areas has a hand-computed probe through the real writers, kept in `tests/db/`.
- [ ] Every defect found has a fix and a regression test; the list is in *Implementation*.
- [ ] Full gate green; `verify:books` ALL PASS.

## Non-goals
- Departments/projects (next round).
- Filing anything with DJP (Buku prepares files, ADR 0014).

## Gate re-openers
- None planned.

## Tasks
- [ ] T1 Probes: tax; ledger import and Saldo Awal; the close, locks and approvals.
- [ ] T2 Fixes with regression tests, one commit per defect family.
- [ ] T3 README / accounting-rules where a rule became clearer; cycle doc.

## Implementation

## Verification

## Ship Notes
