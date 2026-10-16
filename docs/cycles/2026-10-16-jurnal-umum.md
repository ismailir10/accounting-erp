# Jurnal Umum and the ledger as Excel

**Roadmap:** core accounting parity with Jurnal and Zahir (`docs/roadmap.md` §3, *Reports* row: "Par+"). The owner asked on
2026-10-16 for Buku to be on par with Jurnal and Zahir and better on the core accounting features, and delegated the decisions
("i trust your judgment").

## Context
Every Indonesian accounting package opens its report menu with **Jurnal Umum**: every journal of a period, with its lines, searchable,
printable. Jurnal and Zahir also export the **Buku Besar** and the **Neraca Saldo** to Excel; an auditor or the client's own staff asks
for exactly those two files. Buku has none of the three:
- No page lists the journals of a period. The only list is the eight latest adjustments on *Jurnal Penyesuaian*; everything else is
  reached one account at a time through Buku Besar.
- Buku Besar and Neraca Saldo show on screen only. The statement workbook (Laporan Keuangan → Unduh Excel) carries the statements and
  CALK, not the ledger or the trial balance.
- Nothing finds a journal by its text or its amount, except the Review queue for bank lines still under review.

Who feels it: the accountant answering "where did this Rp 4.250.000 go?", the partner reviewing a month's adjustments, and the auditor
or bank analyst who receives the books as Excel.

Buku can be better here than the incumbents because every line already knows its source: the Jurnal Umum and the exported ledger carry
the bank row (file, row) or the imported file row (`sheet!row`) next to every journal, which neither Jurnal nor Zahir can.

## Decisions
- **One new page, *Jurnal Umum*** (client menu, stage 2 after Buku Besar). A period is a month (the ScopeBar month) or the financial
  year to date through that month (`Bulan ini` / `Tahun buku s.d. bulan ini`), because Buku closes by month and the year to date is what
  an auditor asks for. No free date range: it would cut across months the close treats as a unit.
- **Filters:** source kind (Semua, Mutasi bank, Penyesuaian, Saldo awal, Impor buku besar, Faktur & dokumen), and one search box that
  matches the memo, a line's account code or name, the bank row's text, or — when the text is a number (`1.250.000`, `1250000`) — any line
  of exactly that amount. All state in the URL.
- **Read-only.** Corrections stay where they are today (Review, *Balik jurnal* on Buku Besar). Every account on a line opens that
  account's Buku Besar for the same month and scope.
- **50 journals per page**; the count and the total debit = total credit cover the whole filter, not the page.
- **Mixed-currency scopes** (a group whose entities keep different currencies) ask for one company first, as Buku Besar does: lines in
  different currencies can't be totalled.
- **Three Excel downloads**, all for the month or the year to date, with the standard title block (client, title, period, firm, time,
  DRAF while the month is open):
  1. *Jurnal Umum* — the page's filter, every journal (no paging), its lines and its source; total debit and credit as formulas.
  2. *Buku Besar* — every account with an opening balance or a movement: opening, lines with source, running balance and closing; or one
     account, from that account's page. The running balance and totals are formulas.
  3. *Neraca Saldo* — the classic six columns (saldo awal, mutasi, saldo akhir, each debit/credit) with total formulas; a mixed-currency
     group gets the closing columns only, translated, as on the page.
- **The ledger ties to the trial balance.** The exported Buku Besar folds earlier years' profit into Saldo Laba's opening exactly as the
  trial balance does, so every account's closing equals its Neraca Saldo balance. Tested.
- **A working paper is not a sent report.** These downloads do not write the *Laporan diunduh* event, which marks a month *Terkirim* on
  the firm board; only the statement packs do.
- **Buku accounts only.** The client-account view (*Akun klien*) keeps its own pages; its export is a follow-up if a firm asks.

## Acceptance criteria
- [ ] *Jurnal Umum* lists every journal of the month in date order, each with its date, kind, memo, who posted it, its source (bank
      account + file + row, or file + `sheet!row`) and its lines; the header shows the count and total debit = total credit.
- [ ] *Tahun buku s.d. bulan ini* lists from the first month of the client's financial year.
- [ ] The kind filter and the search narrow the list and the totals; a search by amount finds the journal holding a line of that
      amount; an empty result says so and offers to clear the filter.
- [ ] Every account on a line opens its Buku Besar for the same month and scope.
- [ ] A mixed-currency group asks for one company instead of listing.
- [ ] *Unduh Excel* on Jurnal Umum downloads the filtered journals with their lines and source; totals are formulas and balance.
- [ ] *Unduh Excel* on Buku Besar downloads every account's ledger; on one account's page, that account. Each closing equals the Neraca
      Saldo balance of the same scope and date (test, including a year with prior-year profit).
- [ ] *Unduh Excel* on Neraca Saldo downloads saldo awal / mutasi / saldo akhir, debit and credit, with total formulas; debit = credit.
- [ ] The downloads leave the firm board's *Terkirim* untouched.
- [ ] Works at 390 px without page scroll sideways.

## Verify flows
1. Accountant, demo client, a month with bank lines: open Jurnal Umum → the count and totals show and balance; open a bank journal's
   account → its Buku Besar for the month.
2. Search `Gaji` then search an amount copied from a Buku Besar line → each finds the journal; filter *Penyesuaian* in a month with
   none → empty state with *Hapus filter*.
3. Download all three Excel files for the month and for the year to date; open them: totals balance, the Buku Besar closing of 1101
   equals the Neraca Saldo row.
4. Edge: a group of entities with different currencies → Jurnal Umum asks for a company. Error: an unknown client id on the export URL
   → 404.

## UX notes
- Jurnal Umum: PageHeader with the ScopeBar; under it the period toggle (LinkTabs: Bulan ini · Tahun buku s.d. bulan ini), the kind
  select and search (a GET form, works without JS), and *Unduh Excel* (outline). One card of divided rows: per journal a header line
  (date, kind · entity, memo, source, posted by) and its lines as a compact table. No NextStep banner: nothing on the page is a job.
- Buku Besar index and one account, and Neraca Saldo: one *Unduh Excel* (outline, with the download icon) next to the ScopeBar; the year
  to date as a second link in the same row (`Excel s.d. bulan ini`).

## Test seams
- DB: `generalLedger` (openings, prior-year fold into Saldo Laba, closing = trial balance, fiscal year not January), `journalRegister`
  (filters, search by text / code / amount, paging totals).
- Unit: search parsing (amount vs text), Excel builders (sheet rows, formulas balance) on fixed data.
- Route: the three exports return xlsx for a member and 404 otherwise (DB test calling the handlers).
- UI: Playwright walk of flows 1–3 with screenshots.

## Non-goals
- Editing or deleting journals; journal numbering; attachments.
- PDF of these three reports (the Excel prints on A4 landscape).
- Client-account (*Akun klien*) exports; custom date ranges.

## Assumptions
- A month in a demo client holds at most a few hundred journals; a year a few thousand. The Excel exports build in memory (as the
  statement workbook does).
- Viewers may see and download these (read-only), as they can the statements.

## Gate re-openers
None: no migration, no dependency, no auth or permission change (same member check as the statement downloads), no AI call, no number
on a report changes.

## Tasks
- [ ] T1 `lib/reports/general-ledger.ts` (ledger for all or one account, month or YTD, fold) + `lib/reports/journal-register.ts`
      (filters, search, paging, totals) + DB tests.
- [ ] T2 Excel builders (`lib/reports/ledger-workbook.ts`: Jurnal Umum, Buku Besar, Neraca Saldo) + export routes + unit/DB tests.
- [ ] T3 Jurnal Umum page + nav entry + download buttons on Buku Besar and Neraca Saldo.
- [ ] T4 verify-local: walk flows 1–4, screenshots, full gate.

## Implementation

## Verification

## Ship Notes
