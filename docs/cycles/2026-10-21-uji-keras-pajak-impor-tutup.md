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
- [x] Each of the three areas has a hand-computed probe through the real writers, kept in `tests/db/`.
- [x] Every defect found has a fix and a regression test; the list is in *Implementation*.
- [x] Full gate green; `verify:books` ALL PASS.

## Non-goals
- Departments/projects (next round).
- Filing anything with DJP (Buku prepares files, ADR 0014).

## Gate re-openers
- None planned. **Re-opened while building:** migration `20261021130000_lock_waits_for_posts` — the entry guard share-locks the client's
  period rows from its month on, so a journal posting while a lock runs either commits first (and the lock sees it) or waits and is
  refused. Tightened, not relaxed; no data change.

## Tasks
- [x] T1 Probes: tax; ledger import and Saldo Awal; the close, locks and approvals.
- [x] T2 Fixes with regression tests, one commit per defect family.
- [x] T3 README / accounting-rules where a rule became clearer; cycle doc.

## Implementation
24 defects across the three areas, each with its hand-computed regression test.

**The close — 8** (`d7c4e4a`; `tests/db/close-hard.test.ts`, `close-hard-reopen.test.ts`)
1. A journal posting while a lock ran could commit into the locked month unchecked → the entry guard share-locks the period rows
   (migration above); `lockPeriod` locks its period row and refuses when the ledger it checked changed (`ledgerFingerprint`).
2. A request dated in an empty earlier month was stranded by a later lock → every waiting request dated by the month end holds the lock.
3. A schedule could be created into, and keep proposing, a month frozen by a later lock → follows Jurnal berulang's rule.
4. Locking a closed month again rewrote who, when and why → refused.
5. A note on a control that wasn't showing cleared it in advance → only a control asking for a note takes one.
6. *Tutup bulan-bulan sebelumnya* wrote notes and sign-offs for a month the lock then refused, and overwrote a sign-off's author.
7. The firm board said "Siap tutup buku" for a month the lock refuses.
8. An account a running Jurnal berulang or a waiting journal uses could be archived.

**Tax — 5** (`72a944a`, `34b22ff`, `8a39634`; `tests/db/tax-hard.test.ts`, `tax-hard-masa.test.ts`)
1. A remittance filed to its tax account by a Review RECLASS (MPN G2, kode billing → 1999 → 2141 / 2130) didn't count as paid: PPh 23
   read KURANG and PPN turned into negative keluaran and a wrong compensation → a payment is decided by the outgoing bank line.
2. The reverse: a remittance moved off the tax account in Review still read as paid.
3. PP 55/2022 0,5 % withheld by a customer was expensed twice by the pack and asked to be remitted again.
4. Income a tenant or customer withheld final PPh 4(2) on stayed in PKP and the Pasal 31E turnover → an automatic negative correction.
5. Coretax `AMENDED` faktur counted beside its pengganti; natura still added back at 100 % after UU HPP.

**Ledger import & Saldo Awal — 11** (`0c7188b`, `722aa96`, `f46d5a3`; `tests/db/import-hard.test.ts`, `import-hard-more.test.ts`)
1. A re-exported GL over months already in posted every journal twice → BLOCK `GL_OVERLAP`.
2. A source system's year-end closing journal wiped the year's Laba Rugi → left out, REVIEW `CLOSING_ENTRY`.
3. Income or expense in a file's Saldo Awal was posted as an opening → BLOCK `OPENING_PL`, refused at posting.
4. An opening's rounding residue landed on 7190 (an expense) → 3290 with a Temuan.
5. A TB across a financial-year end put last year's P&L in this year → BLOCK `TB_YEAR_END`.
6. A Neraca line mapped to a bank account doubled with the statements, and another entity's bank was accepted → own bank, opening only.
7. A GL's own *Saldo Awal* rows posted as a January flow → OPENING the day before when nothing opened the books (INFO `GL_OPENING`).
8. The same rows over an existing Saldo Awal counted twice → BLOCK `GL_OPENING_ROWS`, acceptable (left out).
9. GL rows inside an opening bridge's span broke its anchor → BLOCK `BRIDGE_COVERS`, re-checked at posting; removal counts only earlier
   entries.
10. A 1999 correction inside an opening posted as an ADJUSTMENT in the year → posts as OPENING on the Saldo Awal date.
11. 3290 / 3900 / 7190 offered as mapping targets → never mapped; the dead rounding → 7190 keyword rule removed.

### Decisions taken while building
- **A repeated GL journal is matched line by line** (date, source account, amount, every line), not by period: a voucher split across
  two sheets, or an export per account, is legitimate.
- **A closing journal is REVIEW, not BLOCK**: there is no other correct way to post it, and every full-year export has one.
- **TB across a year end** is tested on the movement's span, not the years of the two dates: a 31 Dec → 30 Jun TB is normal.
- **7200 stays mappable**: a client's realised FX gain or loss belongs there; revaluation is recognised by its entry, not the account.
- **Pajak Masa payments by bank line**: per outgoing bank line and tax account the net of all its entries is one payment on the bank
  date; entries without a bank line keep the entry rule.
- **Not covered:** a one-date worksheet still posts its before-adjustment P&L as its own figures (by design); a two-step closing through
  an *Ikhtisar Laba Rugi* account is caught at step 1 only; Coretax's exact "Amended" wording is unconfirmed until a real export.

## Verification
- Each area's regression tests: `close-hard` + `close-hard-reopen`, `tax-hard` + `tax-hard-masa`, `import-hard` + `import-hard-more` (26 cases),
  all passing; the import fixes were also run against every ledger-import, opening, mapping and suspense test (157 files) before merging.
- Full gate on `f46d5a3` (this round merged with round eight): **348 files, 3208 tests passed**; build OK; **verify:books ALL PASS — 1765**;
  `db:drift` clean; **e2e 136 passed**.

Verified locally — f46d5a3

## Ship Notes
