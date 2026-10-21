# Core accounting parity, round nine: a hard test of the parity features

**Roadmap:** core accounting parity with Jurnal and Zahir (`docs/roadmap.md` §3), under the owner's request of 2026-10-20 to keep testing
hard. Rounds one, five and seven found 58 defects by building hand-computed cases through the real writers; every feature added since
round two (Nomor bukti, Neraca Lajur, Lampiran jurnal, Arsip akun, Jurnal berulang, Antar entitas per pihak, Departemen & Proyek) was
tested only by its own cycle's tests, written by the same hand that built it.

## Context
Those features sit on the ledger's spine: a nomor bukti is on every printed journal, the Neraca Lajur is what an auditor ties to, a
recurring template posts every month without anyone retyping it, the per-counterparty accounts decide what a group's Neraca shows, and
the per-department Laba Rugi is what a contractor's bank reads. A defect in any of them is silent and repeats.

## Decisions
- **Hunt, then fix**, as rounds five and seven: three adversarial probes at the database level through the real writers, each expected
  figure computed by hand first; a defect is a failing test naming the wrong number or behaviour and the right one.
  - A: Nomor bukti, Neraca Lajur, Lampiran jurnal, Arsip akun.
  - B: Jurnal berulang with Persetujuan kedua and the close; Antar entitas per pihak through transfers, reports and controls.
  - C: Departemen & Proyek through splits, transfers, approvals, reversals, deletion and the per-department report in group scopes.
- **Every confirmed defect is fixed in this round** with its probe kept as a regression test; a product decision is logged, never
  silently changed.
- No new module; a schema change only if a defect needs one (named under Gate re-openers first).

## Acceptance criteria
- [ ] Each probe area has hand-computed cases through the real writers, kept in `tests/db/`.
- [ ] Every defect found has a fix and a regression test; the list is in *Implementation*.
- [ ] Full gate green; `verify:books` ALL PASS.

## Non-goals
- New features (round ten builds Departemen & Proyek part two alongside).

## Gate re-openers
- None planned.

## Tasks
- [ ] T1 Probes A, B, C.
- [ ] T2 Fixes with regression tests, one commit per defect family.
- [ ] T3 accounting-rules / README where a rule became clearer; cycle doc.

## Implementation

## Verification

## Ship Notes
