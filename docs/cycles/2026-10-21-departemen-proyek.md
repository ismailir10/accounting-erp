# Core accounting parity, round eight: Departemen & Proyek

**Roadmap:** core accounting parity with Jurnal and Zahir (`docs/roadmap.md` §3, Reports row), the last gap named in
[round two](2026-10-20-paritas-inti.md)'s non-goals, under the owner's request of 2026-10-20 to keep going until Buku is on par.

## Context
Zahir has *Departemen* and *Proyek* on every transaction and a Laba Rugi per department or project; Jurnal has *Tag* on every line and a
Laba Rugi by tag. An accountant's client that runs two outlets, a contractor with several projects, or a firm with divisions wants to know
which one earns and which one costs — and Buku can only answer for the whole company. The work-around today is a separate account per
outlet (4100 Penjualan Outlet A, 4101 …), which bloats the chart and breaks every template.

Who feels it: the accountant asked "berapa laba proyek X?", the owner of a multi-outlet business, the contractor's bank (project margins).

## Decisions
- **Two dimensions per client: Departemen and Proyek** (`Dimension`: kind, a short code, a name, archived). Set up on *Pengaturan klien →
  Departemen & Proyek*; an archived one leaves the pickers and stays in reports (as Arsip akun).
- **A journal line may carry one of each** (`JournalLine.departmentId`, `projectId`). They are labels for analysis: they never change a
  balance, and `postJournal()` only checks they belong to the entity's client and are not archived.
- **Where they are set (this round):**
  - *Jurnal Penyesuaian*: per line, pickers shown only when the client has any (also kept by *Salin*, *Jurnal berulang* and a waiting
    request).
  - *Review*: on a bank line's classification (`BankTransaction.departmentId`, `projectId`), applied to the line's classification side
    (not the bank, not the tax legs). Changing only the tag reclassifies by difference, as changing the account does (rule 3).
- **Laba Rugi per Departemen / per Proyek** (Laporan Keuangan, a tab): one column per department (or project) in use, *Tanpa departemen*,
  and the total — the total column is exactly the Laba Rugi; drill-down to Buku Besar filtered by the tag; Excel download.
- **Buku Besar and Jurnal Umum** show a line's tags and filter by one.
- Riwayat records dimension changes (create, rename, archive).

## Acceptance criteria
- [ ] Two departments and a project set up; a Jurnal Penyesuaian with a line on each; a bank line classified to 6120 with *Outlet A*.
- [ ] Laba Rugi per departemen: Outlet A, Outlet B and *Tanpa departemen* columns add up to the Laba Rugi on every row.
- [ ] Changing only a bank line's department in Review posts a RECLASS moving it; the per-department report follows; Laba Rugi unchanged.
- [ ] An archived department leaves the pickers; `postJournal()` refuses it on a new line; reports still show its history.
- [ ] Full gate green; `verify:books` ALL PASS.

## Non-goals
- Tags on invoices, fixed assets, schedules and ledger imports (a later round once the pilot asks).
- A Neraca per department (balance-sheet items are the company's).
- Budgets per department.

## Gate re-openers
- A migration: the `Dimension` table, `departmentId` / `projectId` on `JournalLine` and `BankTransaction`. Additive.
- `postJournal()` gains one check (the line's dimensions belong to the client and are not archived). Tightened, not relaxed.

## Tasks
- [ ] T1 Schema + migration; `lib/dimensions` (create, rename, archive); `postJournal()` check; Pengaturan klien page.
- [ ] T2 Jurnal Penyesuaian lines (form, stored lines, Salin, Jurnal berulang, approvals).
- [ ] T3 Review: tag on a bank line, reclass by (account, tags).
- [ ] T4 Laba Rugi per Departemen / Proyek (page tab, Excel); Buku Besar and Jurnal Umum tags and filter.
- [ ] T5 Tests, e2e, README, accounting-rules, deck.

## Implementation
- **T1** `d23e553` — `Dimension` table + `JournalLine` / `BankTransaction` tags (migration `20261021140000_departemen_proyek`, additive);
  `lib/dimensions` (create, rename, archive, remove only when nothing carries it — lines, bank lines, Jurnal berulang templates, waiting
  requests); `postJournal()` refuses another client's, the wrong kind, or an archived tag; *Pengaturan klien → Departemen & proyek*;
  client delete removes them after the lines; Riwayat kind `DIMENSION`.
- **T2** `bffd674` — Jurnal Penyesuaian per-line pickers (only when the client has any); the tags travel through `prepareAdjustment`,
  stored request lines (`StoredLine.departmentId` / `projectId`), Kotak persetujuan's line view, Jurnal berulang, *Salin* (active ones),
  *Balik otomatis* and *Balik jurnal* (`mirrorLines`).
- **T3** `4c944ad` — a bank line's tags on `BankTransaction`; `postBankTransaction` nets by (account, department, project) and puts the
  tags on the classification account only (each split part); `setBankTagsTx` (Buku Besar drawer) and Review's decision set them; the ledger
  shows each line's tags and filters by one (`?tag=`).
- **T4** `fb36365` — `lib/reports/by-dimension.ts`: Laba Rugi per departemen / per proyek as `incomeStatement` per tag + *Tanpa* + Total,
  month or year so far, Excel at `/clients/[id]/reports/export/dimensi`; Jurnal Umum shows tags.
- **T5** — tests (`tests/db/dimensions.test.ts`, 9 cases), e2e `e2e/departemen-proyek.spec.ts`, README, accounting-rules 3b.

### Decisions made while building
- **An archived tag stays valid where it is already carried**: a reversal mirrors it (otherwise a per-department column could never
  net out) and a bank line's re-posting keeps it (otherwise archiving Outlet B would block a later change of account on its old lines).
  Choosing it anew — a new journal line, a bank line retagged to it — is refused.
- **Tags never go on the bank, PPN, withholding or suspense legs**: the per-department view is of income and expense; the bank and tax
  balances are the company's. A line still in Review keeps its tags until it is classified.
- **The per-department Excel is plain numbers, no formulas**: every column is its own Laba Rugi; the page and the file read the same rows.
- **Buku Besar download is hidden while a tag filter is on**: the Excel Buku Besar is the whole account; a filtered file would need its
  own title and opening, a later round if asked.

## Verification

## Ship Notes
