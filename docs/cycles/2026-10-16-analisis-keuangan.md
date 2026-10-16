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
- [x] *Laba Rugi per bulan*: each column equals that month's Laba Rugi; the last column equals Laporan Keuangan's year to date.
- [x] *Neraca per bulan*: each column's total assets equals total liabilities + equity.
- [x] Months before the books' first entry are not shown.
- [x] *Rasio keuangan* shows the eleven ratios per month with their formulas; a zero base shows "–".
- [x] Every account opens its Buku Besar for the selected month.
- [x] *Unduh Excel* downloads three sheets; the year-to-date column is a formula.
- [x] Works at 390 px without page scroll sideways (the months scroll inside the card; the labels and the total stay pinned).

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
- [x] T1 `lib/reports/analysis.ts` + DB tests.
- [x] T2 Page, tables, Excel workbook + route, nav; route and nav tests; e2e spec.
- [x] T3 verify-local: walk flows 1–4, screenshots, full gate.

## Implementation
- `lib/reports/analysis.ts`: `fiscalMonths`, `activeMonths` (from the books' first month), `monthlyIncome` (rows per FS line and account,
  totals, a year-to-date total per row), `monthlyBalance` (sections with totals), `ratios`, and the bigint formatters `times`,
  `percent`, `days`.
- `components/app/trend-table.tsx`: `TrendTable` (label column pinned left, the total column pinned right, months scrolling inside the
  card) and `RatioTable`.
- Page `analysis/page.tsx` (LinkTabs `?tab=pl|bs|rasio`), `lib/reports/analysis-workbook.ts` + route `analysis/export` (no export
  event), nav *Analisis keuangan* after Laporan Keuangan.
- Decisions while building: months before the books' first entry are dropped (a January column of dashes looked like a zero month);
  the year-to-date column is pinned so it stays visible on a laptop screen.

## Verification
- **Tests:** `tests/db/analysis.test.ts` (6: columns equal the monthly statements and the total equals the year to date; Neraca balances;
  ratios with dashes; first month of the books; February financial year; formatting), the export in
  `tests/db/session-revocation.test.ts`, `tests/unit/nav.test.ts`, `e2e/analisis-keuangan.spec.ts`.
- **Task gate:** lint exit 0, typecheck exit 0, `npm test` 280 files / 2,619 tests passed.
- **Full gate:** `npm run build` exit 0; `npm run verify:books` → "ALL PASS — 1765 pemeriksaan saldo cocok dengan ground truth";
  `npm run test:e2e` → 103 passed, 1 failed: `trial-expiry` expected "berakhir dalam 3 hari" and read "2 hari" because the run crossed
  midnight WIB after the seed (a date-boundary in that fixture, unrelated). After a fresh `demo:reset` it re-ran: 3 passed.
- **Walk (local, demo admin, Grup Ayam Nusantara, Agustus 2026):**
  - *Laba Rugi per bulan*: Laba bersih "… 148.231.324 156.543.009 1.208.350.226"; Laporan Keuangan shows "Laba bersih 156.543.009
    148.231.324 1.208.350.226" (month, last month, year to date).
  - *Neraca per bulan*: Jumlah aset = Jumlah liabilitas dan ekuitas in every month (3.395.000.000 … 4.795.347.937).
  - *Rasio keuangan*: rasio lancar 2,83x … 3,46x; utang/ekuitas 0,36x … 0,32x; margin laba kotor 35,1 % … 29,3 %.
  - Excel: three sheets; Laba bersih row ends `SUM(B37:I37)=1208350226`. An account opens `/ledger/4100?period=2026-08`.
  - 390 px: scroll width 390 = viewport (the months scroll inside the card).

Verified locally — fc3c2f7

## Ship Notes
- **Deck:** no deck change. No slide claims or denies month-by-month analysis or ratios; slide 12's reader packs stay true. A mention can
  be added with the next deck pass once #167's slide 12 edit is merged (both would regenerate the same PDF).
