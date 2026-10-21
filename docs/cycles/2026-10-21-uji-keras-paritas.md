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
- [x] Each probe area has hand-computed cases through the real writers, kept in `tests/db/`.
- [x] Every defect found has a fix and a regression test; the list is in *Implementation*.
- [x] Full gate green; `verify:books` ALL PASS.

## Non-goals
- New features (round ten builds Departemen & Proyek part two alongside).

## Gate re-openers
- None planned.

## Tasks
- [x] T1 Probes A, B, C.
- [x] T2 Fixes with regression tests, one commit per defect family.
- [x] T3 accounting-rules / README where a rule became clearer; cycle doc.

## Implementation
**23 defects** across the three areas (A 9; B 7, two of them the same as A's; C 6; plus three of the probes' suspicions that proved
real), each
with its hand-computed regression test. The probes ran in their own worktrees on their own test databases; two fix agents took A and B
(all of `lib/coa/manage.ts` to one, so they never collided); I fixed C.

**Probe A — Nomor bukti, Neraca Lajur, Lampiran, Arsip akun: 9 defects** (`3f3057c` tests; `tests/db/parity-hard-a-*.test.ts`, 33+ cases)
1–2. An account two companies held opposite balances on (or Rp and US$ minor units that "summed" to zero) could be archived → each
   company's own balance must be zero (`c6fa8e6`).
3. A Jurnal berulang whose end month had passed but still owed instalments didn't block archiving → `recurringOwing()` (`c6fa8e6`).
4. A posting already past its checks landed on an account archived meanwhile → `postJournal` re-reads its accounts `FOR KEY SHARE`
   after taking its number (`f98eb9b`).
5–6. Ledger-import mapping suggested and accepted an archived account → never (`ae766cb`).
7. Two uploads at once broke the ten-file limit → counted under the journal's row lock; and (suspicion, real) removing a lampiran
   could race the close → re-checked under the close lock (`a405e60`).
8. A PDF uploaded as `bukti.html` kept `.html` → the extension follows the bytes (`a405e60`).
9. A purchase bill recharged to a receivable account was numbered FJ → the series follows the invoice's direction (`6cb9050`).
Plus (probe B's #5): removal and archiving didn't count a waiting request, a running template or a draft proposal naming the account by code → a
removed code was reused and an approval posted to the new account (`c6fa8e6`).

**Probe B — Jurnal berulang, Antar entitas per pihak: 7 defects** (`001275e` tests; `tests/db/parity-hard-b-*.test.ts`, 25+ cases)
1. *Ulangi tiap bulan* accepted a stock-count journal (and any register-owned one) → `reversalBlocker` refuses it (`391ff60`).
2. *Ulangi* again after *Hentikan* proposed months the first template had posted → starts after them (`391ff60`).
3. A template from a journal whose account was archived since could never post → its lines are checked at creation (`391ff60`).
4–5. (Archive / removal with templates and waiting requests: fixed with probe A's, above.)
6. A company could be removed while a waiting request named its 1190NN, and the code was reissued to the next company → removal refused
   while anything names it; a code is never issued twice (`b8464ab`).
7. In a group of three, PT's payment to the CV paired with the owner's receipt from PT and was re-posted onto the owner's account → a line
   naming a group company pairs only with that company (`0edc081`).
Plus (suspicions, real): with a group's rates missing, the intercompany controls were skipped and the month could close unchecked → FAIL
(`f3bfdd7`); a source account could be mapped to its company's own 1190NN → refused at mapping (`45aee44`).
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
- **A restarted Jurnal berulang starts after what the earlier one posted** (or has waiting), rather than being refused: a pause and
  restart is legitimate.
- **An intercompany code is never reissued**: removal records the code in Riwayat and new codes go above the highest ever issued (no
  schema change). Codes removed before this change were not recorded, so one could still be issued once.
- **Missing rates make the intercompany control FAIL**, not REVIEW: a FAIL can't be noted away, so the pairs are checked before a close.
- **Old FJ numbers on recharged bills stay** (numbers are immutable and the backfill migration is applied); their voids keep that series.
- **Final PPh 4(2) withheld on a receipt (8200) carries the line's tags**: it is the expense of that income; a tax receivable or payable
  (PPh 23 prepaid, PPh 21 owed) stays the company's.
- **A tag stored while active keeps posting after it is archived** (a waiting request, a Jurnal berulang template, a schedule): otherwise
  a month could never close behind a request that can't post. Archiving only stops new choices.

## Verification
- The probes' 82 cases (A 33, B 25, C 24) and every related test file passed on the merged head; `tests/db/entity-edit` gained the
  rekening case.
- Full gate on `6cb9050` (rounds nine and ten together): **358 files, 3303 of 3304 tests passed**. The one failure,
  `ai-background` "a time box that ends with work left…", is a 20 ms wall-clock budget test outside this diff; it failed while a build and
  the e2e suite shared the machine and passed 5 of 5 on its own and in every earlier full run.
- `npm run build && npm run demo:reset && npm run verify:books`: **ALL PASS — 1765 checks**; `db:drift` clean.
- `npm run test:e2e` on the production build of 0a3d64e: **137 passed (18.0m)**.

Verified locally — 0a3d64e

## Ship Notes
