# Analisis keuangan: the year month by month, and the ratios

**Roadmap:** core accounting parity with Jurnal and Zahir (`docs/roadmap.md` §3, *Reports* row). The owner asked on 2026-10-16 for Buku
to be on par with Jurnal and Zahir and better on the core accounting features, and delegated the decisions ("i trust your judgment").

## Context
Jurnal sells *Laba Rugi multi periode* and a combined view; Zahir sells *Analisa rasio keuangan* and graphs. Buku's Laporan Keuangan
shows this month, last month, the year to date and the same months last year; nothing shows the year month by month, and no ratio beyond
the gross and net margin in the management pack. An accountant explaining a client's year to its owner, or a bank analyst reading the
credit pack, asks for exactly that table: twelve columns of Laba Rugi, the Neraca at each month end, and the liquidity, solvency and
margin ratios beside them.

Buku can do this better because every column is the month's own statement from the general ledger (the same function as Laporan
Keuangan, so the total equals the year to date and every Neraca column balances), every account opens its Buku Besar, and the ratios are
exact bigint arithmetic on those statements, each with its formula written next to it.

## Decisions
- **One page, *Analisis keuangan*** (client menu, stage 3 after Laporan Keuangan), three tabs in the URL: *Laba Rugi per bulan*,
  *Neraca per bulan*, *Rasio keuangan*. Columns are the months of the client's financial year through the selected month, starting at the
  first month the books hold an entry (no column of dashes before the books begin, as the statements' comparatives).
- **Laba Rugi per bulan:** the statement's own grouping (pendapatan usaha, beban pokok, laba kotor, beban usaha, laba usaha, lain-lain,
  laba sebelum pajak, pajak, laba bersih), each FS line with its accounts; a pinned last column *S.d. <bulan>* = the year to date.
- **Neraca per bulan:** each month end's Neraca (current / non-current, liabilities, equity with the year's profit), totals per section,
  assets = liabilities + equity.
- **Ratios** (each with its formula; "–" where the base is zero or negative, never a division by zero): rasio lancar, rasio cepat, rasio
  kas, modal kerja (Rp); utang terhadap ekuitas, utang terhadap aset; margin laba kotor / usaha / bersih of the month; umur piutang and
  umur utang in days of the month. Liquidity and solvency from the month end, margins and days from that month's Laba Rugi. No ROA/ROE:
  annualising a part year invites a wrong reading, and the pilot can ask for it.
- **Excel**: the three tabs as three sheets, the year-to-date column a SUM formula. A working paper: no *Terkirim* event. Rupiah (or a
  group translated to Rupiah) only, as the ledger downloads.
- **Mixed-currency groups** use the statements' own translation; a missing rate shows the usual *Isi kurs* step.

## Acceptance criteria
- [ ] *Laba Rugi per bulan*: each column equals that month's Laba Rugi; the last column equals Laporan Keuangan's year to date.
- [ ] *Neraca per bulan*: each column's total assets equals total liabilities + equity.
- [ ] Months before the books' first entry are not shown.
- [ ] *Rasio keuangan* shows the eleven ratios per month with their formulas; a zero base shows "–".
- [ ] Every account opens its Buku Besar for the selected month.
- [ ] *Unduh Excel* downloads three sheets; the year-to-date column is a formula.
- [ ] Works at 390 px without page scroll sideways (the months scroll inside the card; the labels and the total stay pinned).

## Verify flows
1. Accountant, demo group, Agustus 2026: Analisis keuangan → the *S.d. Agustus* net profit equals Laporan Keuangan's year to date.
2. *Neraca per bulan* → *Jumlah aset* row equals *Jumlah liabilitas dan ekuitas* in every month; *Rasio keuangan* → values per month.
3. Download the Excel → three sheets, SUM in the total column. Open an account → its Buku Besar.
4. Edge: a client whose books start in March → no January or February column. Error: unknown client on the export → 404.

## UX notes
- PageHeader + ScopeBar; LinkTabs and *Unduh Excel* (outline) under it; one card holding the table; a one-line note under the card that
  says how the tab reads. No NextStep: nothing to do here.

## Test seams
- DB: `monthlyIncome`, `monthlyBalance`, `ratios`, `activeMonths` (`tests/db/analysis.test.ts`); formatting helpers.
- Route: the export in `tests/db/session-revocation.test.ts` (200 for a member, 404 once access is gone).
- e2e: `e2e/analisis-keuangan.spec.ts`.

## Non-goals
- Charts (the Ringkasan already has the six-month chart); budget vs actual; quarterly columns; ROA/ROE; a PDF of this page.

## Assumptions
- Twelve monthly statements per request are fast enough (each is two grouped queries); measured on the demo below.

## Gate re-openers
None: read-only, no migration, no dependency, no AI call.

## Tasks
- [ ] T1 `lib/reports/analysis.ts` + DB tests.
- [ ] T2 Page, tables, Excel workbook + route, nav; route and nav tests; e2e spec.
- [ ] T3 verify-local: walk flows 1–4, screenshots, full gate.

## Implementation

## Verification

## Ship Notes
