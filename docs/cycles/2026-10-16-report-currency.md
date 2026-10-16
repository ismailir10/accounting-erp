# Reports print a foreign-currency company in its own currency

**Roadmap:** found while building [Jurnal Umum](2026-10-16-jurnal-umum.md) (core accounting parity with Jurnal and Zahir). A bug fix;
the owner delegated the decisions on 2026-10-16.

## Context
A company may keep its books in another currency (ADR 0006: functional currency per entity, e.g. a Singapore subsidiary in SGD).
Its amounts are stored in that currency's minor units (cents). The page already shows them as S$ with cents. The files that leave Buku
did not:
- **Laporan Keuangan → Unduh Excel** wrote every amount as the stored integer under "Dinyatakan dalam Rupiah": S$ 12.345,67 (1.234.567
  cents) became "1.234.567" Rupiah.
- **Unduh PDF** printed it the same way, through the Rupiah formatter, under the same header.
- **Laporan manajemen** (Excel) wrote cents as whole units under a Rupiah header line, while its subtitle said "Dalam SGD".
- The **ribuan** format divided the cents by a thousand, so on the page and in the PDF S$ 12.345,67 showed as S$ 12,35 thousand.

Who feels it: the client and the bank receiving a foreign subsidiary's statements, a hundred times too large and labelled Rupiah.
The mixed group (Gabungan) is not affected: it is translated to Rupiah first.

## Decisions
- One rule for every statement output: amounts in the **scope's currency** (the one functional currency; a mixed group stays IDR,
  translated). The header names it ("Dinyatakan dalam Dolar Singapura"); Excel cells hold the major unit with its decimals (12345.67,
  format `#,##0.00`), formulas unchanged; the PDF formats with the currency's own decimals.
- **Ribuan** means thousands of the major unit in every currency: S$ 12.345,67 → 12,00 (thousand dollars). The page, the PDF and the
  Excel agree; Rupiah is unchanged (Rp 1.234.567 → 1.235).
- The credit pack, the tax workbooks and the ledger downloads stay Rupiah-only, as they are today (each refuses or hides for other
  currencies).

## Acceptance criteria
- [x] The statement Excel of an SGD company says "Dinyatakan dalam Dolar Singapura" on every sheet and writes 12345.67 for S$ 12.345,67.
- [x] The statement PDF prints "12.345,67" under "Dinyatakan dalam Dolar Singapura"; in ribuan, "12,00" under "ribuan Dolar Singapura".
- [x] The management pack names the currency and writes dollars with cents.
- [x] Rupiah outputs are unchanged (existing tests and `verify:books`).

## Test seams
- DB: `tests/db/report-currency.test.ts` (Excel, PDF in both units, management pack, conversion helpers); the existing Rupiah PDF and
  workbook tests stay green.

## Non-goals
- Other currencies in the credit pack, the tax workbooks and the ledger downloads.

## Gate re-openers
None: no migration, no dependency, no number in the ledger changes; presentation of existing figures only.

## Tasks
- [x] T1 `toUnit` / `renderFormat` with the currency's exponent; `excelAmount` and the currency name in the workbook header; the statement
      set carries its currency; PDF and management pack follow; tests.
- [x] T2 verify-local: an SGD company's page, Excel and PDF; full gate.

## Implementation
- `lib/fx/currency.ts` `currencyName`; `lib/reports/format.ts` `toUnit(v, unit, exponent)` and `renderFormat(…, exponent)` (ribuan =
  thousands of the major unit, still in minor units); `lib/reports/workbook.ts` `excelAmount`, the sheet header and number format by
  currency, `WorkbookMeta.currency`; `lib/reports/statement-set.ts` carries `currency`; `lib/reports/pdf.ts` formats and labels with
  it; `lib/reports/management-pack.ts` writes its amounts with it; the reports page passes the exponent and names the currency.

## Verification
- **Tests:** `tests/db/report-currency.test.ts` (4: Excel set, PDF in whole units and ribuan, management pack, conversions); the
  existing Rupiah PDF and layout tests pass unchanged.
- **Task gate:** lint exit 0, typecheck exit 0, `npm test` 280 files / 2,617 tests passed.
- **Full gate:** `npm run build` exit 0; `npm run verify:books` → "ALL PASS — 1765 pemeriksaan saldo cocok dengan ground truth";
  `npm run test:e2e` → 103 passed.
- **Walk (local; PT Jasa Kreatif Digital switched to SGD in the local demo database for the walk, reseeded after):**
  - Laporan Keuangan → "Dinyatakan dalam Dolar Singapura".
  - Unduh Excel: Neraca header "Dinyatakan dalam Dolar Singapura", a cell 5543683.52 with format `#,##0.00`.
  - Unduh PDF: "Dinyatakan dalam Dolar Singapura", "Jumlah aset lancar 6.943.683,52".
  - Laporan manajemen: "Dinyatakan dalam Dolar Singapura".

Verified locally — 6df35d9

## Ship Notes
- **Deck:** n/a (a fix).
