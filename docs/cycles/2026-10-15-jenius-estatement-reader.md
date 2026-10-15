# Jenius / JFB 2025 e-statements read automatically

## Context
Released `main` (`6a33341`) reads one SMBC PDF layout, the *Laporan Konsolidasi Rekening* (Touchbiz / Jenius). A private acceptance
on monthly Jenius/JFB 2025 e-statements of a real client (originals kept on the owner's machine only) found that Buku refuses every
one of them with *Tabel transaksi di PDF tidak dikenali*: no line of the file is recognised as the transaction table's header. The same
result on Node 24 and Node 22. The acceptance kit's independent facts reader does not know the layout either, so the refusal is a
support gap, not a misreading of a layout Buku claims. Today these statements can enter Buku only through *Atur kolom* (manual column
mapping, untested on these files) or not at all. Who feels it: the accountant whose clients bank with Jenius.

The layout is not publicly documented (no bank documentation, no open-source reader found). Everything this cycle knows about it comes
from the private layout probe: words from a fixed public vocabulary, token shapes and position buckets, never content.

## Decisions
1. **Fix automatic reading** of the Jenius/JFB 2025 e-statement in released Buku (owner's product decision after the diagnosis; the
   reader route was chosen over manual mapping, a source-format change or deferral).
2. **Independent facts stay independent.** The source-facts reader for this layout lives in the private acceptance kit, shares no Buku
   code and is tested on its own fictional files. Buku's own tests use fictional fixtures only.
3. **Layout knowledge from safe structure metadata only.** Raw originals, samples, screenshots and extracts never leave the Mac.
4. **Acceptance targets are the owner's, independently verified**, and stay in the private acceptance evidence (counts and
   identities of the real sources are not written here). They are used only to judge the private acceptance. Neither the reader nor its
   tests are fitted to them, and no expected fact is derived from Buku.
5. **Delivery:** branch `task/jenius-estatement-reader` from released `main`. The output of this cycle is a private release candidate
   (diff plus checksum) for testing on the Mac. No PR, merge or deploy until the owner decides. The held import fix (PR #160) stays
   separate.

## Acceptance criteria
- [ ] A Jenius/JFB 2025 e-statement in the layout the metadata describes is read automatically on Unggah: account, period, opening,
  every row (date, signed amount, running balance) and closing, tagged as SMBC.
- [ ] Every fictional month's running balance is continuous; a fictional file with a row removed shows the break (existing rule).
- [ ] A month spread over several pages reads as one statement; repeated page headers and footers are never rows.
- [ ] The same file imported again writes nothing; an overlapping statement's repeated rows are recognised as duplicates.
- [ ] Every layout Buku already reads still reads the same (all bank-layout fixtures and SMBC tests pass; `verify:books` ALL PASS).
- [ ] The bank catalogue lists the new format with its evidence level, so the coverage test requires its fixture.
- [ ] A PDF that is no known statement is still refused with today's message.
- [ ] Private acceptance on the owner's machine: facts sealed before Buku runs; no FAIL in S0–S7; every approved source matches its
  independent facts and the owner's verified targets; REVIEW items stay visible.

## Verify flows
1. Accountant, *Unggah*: drop a fictional Jenius 2025 month for a client with that account → the result names the rows read, the month,
   continuity OK; *Review* lists the rows.
2. Same file again → nothing new is written; the result says it was already imported.
3. Edge: a fictional month without transactions, if the layout has one (opening and closing only) → no rows, no error beyond today's
   behaviour for an empty statement.
4. Error: a fictional month with one row removed → the import shows the continuity break.

## UX notes
No UI change. The existing Unggah result and Review screens show the outcome.

## Test seams
- Unit: a synthetic fixture of the new layout in the bank-layout set (`tests/bank-layouts.ts`, checked by the bank-layout and coverage
  tests) plus focused parser tests: several pages, wrapped descriptions, same-day identical amounts, password, a broken chain.
- DB: import, repeat import and overlap through the import pipeline.
- Private: the acceptance kit on the Mac (facts first, then parse, import, duplicates, reconciliation, reports).

## Non-goals
*Atur kolom* and any UI change; other banks or SMBC layouts; foreign-currency pockets (listed, not imported, as today); the Nex and
BCA files; PR #160 and its CI-capture question; migrations; production data; publishing a PR.

## Assumptions
- "JFB" names the second series of these Jenius e-statements. Whether it shares the layout is read from the metadata, not assumed.
- The files are text PDFs (the probe found a text layer in every one), possibly password-protected (today's password flow applies).
- Whether a file holds one account or several, and whether a month without activity exists, is read from the metadata.

## Gate re-openers
None expected: no migration, dependency, env var, Auth or AI change. Re-open if the layout needs a new bank code (a Prisma enum value is
a migration), a change to an accounting invariant (e.g. the repair rules of accounting-rules 12), or UI work.

## Tasks
- [ ] T0 Probe detail mode (private kit): enough safe structure metadata to build the reader — accept: probe self-test passes with its
  leak scan on the detail output.
- [ ] T1 Fictional fixture(s) of the 2025 layout and failing tests — accept: they fail on released `main` with today's refusal.
  (deps: metadata)
- [ ] T2 Reader support and the bank catalogue entry — accept: T1 green, every existing layout test green.
- [ ] T3 Import regressions: import, repeat import, overlap — accept: green on a fresh test database.
- [ ] T4 Kit v3: the independent facts reader for the layout and a check against the owner's targets — accept: fictional self-test all
  PASS. (parallel with T2–T3)
- [ ] T5 Full gate, `verify:books`, e2e where local Auth is available — accept: recorded evidence for the candidate SHA.
- [ ] T6 Independent review of code and kit, findings fixed — accept: ACCEPT recorded.
- [ ] T7 Private release candidate (patch, checksums) for the owner's private acceptance — accept: owner's acceptance result recorded.

## Implementation

## Verification

## Ship Notes
