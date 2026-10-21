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
**Probe C — Departemen & Proyek: 6 defects** (`f0b4a6c` tests, `611352e` fixes; `tests/db/parity-hard-c-{bank,report,lifecycle}.test.ts`, 24 cases)
1. A tag change on a line still in Review posted its suggested PPN (1.100.000 from 1999 to 1150) → a Review line moves nothing.
2. A tag change on a Review line in a closed month wrote the row's tags and a Riwayat event → refused before anything is written.
3. A mixed-currency group's per-department columns missed the Total by 1 Rupiah (each column rounded alone) → the residue goes to
   *Tanpa*; subtotals are summed from the rows.
4. Removing a department while a request naming it was being stored left the request naming nothing → removal locks the row and
   re-checks; storing a request or a Jurnal berulang template share-locks the tags it names (`lockTags`).
5. Removing a department while a journal carrying it committed showed a raw foreign-key error → "sudah dipakai".
6. Two members adding the same code at once got a raw unique-key error → "Kode … sudah dipakai".

### Decisions taken while building
- **Final PPh 4(2) withheld on a receipt (8200) carries the line's tags**: it is the expense of that income; a tax receivable or payable
  (PPh 23 prepaid, PPh 21 owed) stays the company's.
- **A tag stored while active keeps posting after it is archived** (a waiting request, a Jurnal berulang template, a schedule): otherwise
  a month could never close behind a request that can't post. Archiving only stops new choices.

## Verification

## Ship Notes
