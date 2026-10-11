# Bank reader fixes: BRImo, Mandiri e-Statement, BNI wondr, holder name

> **Independent brief.** This cycle is self-contained and meant to be built by a separate agent working from this
> branch (`task/bank-reader-fixes`) in a cloud sandbox. It touches only the bank statement readers and their tests.
> Read `AGENTS.md` first (repo profile, gates, tool-neutral rules) and `.agents/skills/accounting-rules/SKILL.md`
> (you are in `lib/import/**`). The spec below is approved; go straight to `build`, then `ship` a draft PR to `main`.
> Do not touch `lib/ai/**`, `app/**`, `components/**`, `prisma/**` — other cycles are changing those in parallel.

## Context
On 2026-10-10 Buku's reader was run on real statements from six banks (files stay outside the repo; they contain
client data and are **not available to you** — this brief describes their layouts precisely instead). BCA (giro +
tahapan) and SMBC (three accounts in one PDF) read fully. Three layouts fail:

| Layout | Today | Wanted |
|---|---|---|
| BRI BRImo "Laporan Transaksi Finansial" | Whole file refused: `SourceAmountError` "Baris 21: Debet dan Kredit sama-sama berisi nominal…" | Reads; `format: "BRI"`, rekening, IDR, period, printed opening/closing |
| Mandiri e-Statement (Livin', password PDF) | Reads, but `format: "GENERIC"` | `format: "MANDIRI"` |
| BNI wondr "Laporan Mutasi Rekening" (password PDF) | Reads, but `format: "GENERIC"` and `accountNumber: null` | `format: "BNI"`, rekening number |

Also, a later cycle (one upload inbox, "Rekening baru BCA ·3814 a.n. <holder>" confirm card) needs the **account
holder name** as printed on the statement. No reader exposes it today.

## Decisions
1. **A zero side is an empty side.** In a two-column debit/credit table, a cell that is exactly zero (`0.00`, `0,00`,
   `0`) next to a non-zero cell on the same row is "no amount" on that side. Both sides non-zero still refuses
   (unchanged rule — never net them). Both zero stays whatever it is today.
2. **Bank detection stays header-only** (never transaction text — transfers name other banks). Add header phrases:
   Mandiri e-Statement (`Tabungan Mandiri`, `Giro Mandiri`, `Menara Mandiri` address line, `e-Statement` + `Livin'`
   disclaimer is footer — do **not** rely on footer); BNI wondr (`Laporan Mutasi Rekening` + a product line such as
   `TAPLUS`, `TAPLUS BISNIS`, `TAPLUS MUDA`, `BNI Taplus`, `Giro BNI`). Prefer specific phrases over a bare word.
3. **BNI wondr rekening** comes from the header line `<HOLDER NAME>  <PRODUCT NAME> - <10 digits>` (the product and
   number sit in the right-hand cell, e.g. `TAPLUS BISNIS - 8311100000` style). Only digits after ` - ` in that
   header cell; never a number from the transaction table.
4. **Holder name** is an optional new field on the parsed statement (`holder?: string`), read only from labelled
   header fields or the known header position of each layout, trimmed, uppercase as printed. Absent → undefined (no
   guessing). Layouts in scope: BCA e-statement, BRImo, Mandiri e-Statement, BNI wondr, SMBC Touchbiz (per section if
   the file prints one). Others may leave it undefined.

## Layouts (synthetic reproduction guide — values below are invented)

Build each as a synthetic PDF with `tests/pdf-fixture.ts` (it writes text at x/y and supports a user password) and
register it next to the existing layouts in `tests/bank-layouts.ts` / `tests/bank-fixture.ts`. Cells in one row are
separate text runs at different x; the reader groups them into lines.

**BRI BRImo** (not encrypted; A4; 5 pages for a month):
```
LAPORAN TRANSAKSI FINANSIAL
STATEMENT OF FINANCIAL TRANSACTION
Halaman 1 dari 5
Page 1 of 5
Tanggal Laporan | : | 02/02/26
Kepada Yth. / To :
Statement Date
BUDI CONTOH | Periode Transaksi | : | 01/01/26 - 31/01/26          <- holder at left of this row
Transaction Period
JL CONTOH NO 1 ...                                                   <- address lines
No. Rekening | : 123401000012345 | Unit Kerja | : | KCP Contoh
Account No | Business Unit
Nama Produk | : Britama-IDR | Alamat Unit Kerja | : | Jl. Contoh No.2
Product Name | Business Unit Address
Valuta | : IDR
Currency
Tanggal Transaksi | Uraian Transaksi | Teller | Debet | Kredit | Saldo
Transaction Date | Transaction Description | User ID | Debit | Credit | Balance
01/01/26 09:35:08 | Transfer Ke Andi via BRImo | 8888252 | 5,000,000.00 | 0.00 | 52,400,000.00
01/01/26 12:58:17 | Transfer Dari Sari via BRImo | 8888028 | 0.00 | 185,000.00 | 52,585,000.00
01/01/26 22:04:24 | Pembayaran Tagihan Kartu Kredit 5100xxxx001 via | 8888019 | 1,469,322.00 | 0.00 | 51,115,678.00
BRImo                                                                <- description continues on next line
...
ABC1234_..._e- | Created By BRIMO                                    <- page footer on every page; not a row
StatementBRImo_<digits>_Jan2026_<digits>
02/02/2026 10:00:00
2026010100000001
(last page)
Saldo Awal | Total Transaksi Debet | Total Transaksi Kredit | Saldo Akhir
Opening Balance | Total Debit Transaction | Total Credit Transaction | Closing Balance
57,400,000.00 | 120,000,000.00 | 110,000,000.00 | 47,400,000.00
Terbilang / In Words
EMPAT PULUH TUJUH JUTA EMPAT RATUS RIBU RUPIAH
```
Notes: dates `dd/MM/yy` with time; amounts US-style with cents (Buku rounds to whole Rupiah per existing rule and
notes it); the opening balance is printed only in the last-page summary (≠ first row's balance minus its amount when
the first row isn't the first movement — prove with the running balance as the reader already does). Summary totals
are independent evidence (existing rule).

**Mandiri e-Statement** (password-protected; 9 pages):
```
e-Statement
Menara Mandiri 1 Jalan Jenderal Sudirman Kav. 54-55, Jakarta 12190, Indonesia
Nama/Name | : | BUDI CONTOH | Periode/Period | : | 01 Jan 2026 - 31 Jan 2026 | 1 dari 9
1 of 9
Cabang/Branch | : | KCP Contoh | Dicetak pada/Issued on : | 02 Feb 2026
Tabungan Mandiri
Saldo Awal/Initial Balance | : | 80.000.000,50
Nomor Rekening/Account Number : | 1110001234567 | Dana Masuk/Incoming Transactions | : | + 10.000.000,00
Mata Uang/Currency | : | IDR
Dana Keluar/Outgoing Transactions | : | - 15.000.000,00
Saldo Akhir/Closing Balance | : | 75.000.000,50
No | Tanggal | Keterangan | Nominal (IDR) | Saldo (IDR)
No | Date | Remarks | Amount (IDR) | Balance (IDR)
Transfer ke BANK MANDIRI
01 Jan 2026
1 | ANDI CONTOH 1010000000001 | -5.000.000,00 | 75.000.000,50
21:41:32 WIB
...
(footer, last page) Disclaimer ... Bank Mandiri ... Livin' ...
```
Today this reads correctly except the bank (`GENERIC`). Only detection + holder (`Nama/Name`) change.

**BNI wondr "Laporan Mutasi Rekening"** (password-protected; 6 pages):
```
Laporan Mutasi Rekening
Periode: 1 - 31 Januari 2026
BUDI CONTOH | TAPLUS BISNIS - 8311100000                           <- holder | product - number
JL CONTOH NO 1 ... | Kantor Cabang: CONTOH • Mata Uang: IDR
KOTA CONTOH
Saldo Awal | Total Pemasukan | Total Pengeluaran | Saldo Akhir
20,000,000 | +5,000,000 | -7,000,000 | 18,000,000
Tanggal & Waktu | Rincian Transaksi | Nominal (IDR) | Saldo (IDR)
Saldo Awal | 20,000,000
02 Jan 2026 | Lainnya
+1,000,000 | 21,000,000
05:31:09 WIB | TRANSFER DARI
...
Saldo Akhir | 18,000,000
Informasi Lainnya ... BNI dapat ... (footer)
```
Today this reads correctly except bank (`GENERIC`), rekening (`null`) and period provenance (`INFERRED` — the
`Periode: 1 - 31 Januari 2026` line should make it `DECLARED`).

## Acceptance criteria
- [x] Synthetic BRImo statement reads: `format: "BRI"`, rekening, IDR, declared period, printed opening/closing,
      every row with the right direction; running balance continuous. A BRImo row with **both** sides non-zero still
      refuses with the existing message.
- [x] Synthetic Mandiri e-Statement (password) reads with `format: "MANDIRI"`; nothing else changes.
- [x] Synthetic BNI wondr (password) reads with `format: "BNI"`, `accountNumber` from the header, declared period.
- [x] `holder` is set for the five layouts listed in Decision 4 and undefined elsewhere; never taken from rows.
- [x] Every existing layout and mutation test still passes (`tests/unit/bank-*.test.ts`,
      `statement-mutations.test.ts`, `pdf.test.ts`); no transaction-text bank detection anywhere.
- [x] `lib/banks.ts` format lists mention the three layouts (so "Lihat 25 bank" stays honest).
- [x] Full gate green (`AGENTS.md` § Repo profile → Full gate), including `verify:books` ALL PASS.
- [x] Ship Notes say: "real-file check pending — run `scripts/check-real-statements.ts` locally" (see Tasks).

## Test seams
- Unit: `tests/unit/bank-layouts.test.ts` / `bank-parsers.test.ts` with the three synthetic layouts above, plus
  zero-side cases (zero debit / zero credit / both non-zero / both zero) and holder extraction.
- A small local-only script `scripts/check-real-statements.ts <dir> [--password X]` that prints, per file and
  section: format, accountNumber, holder, currency, period (+provenance), opening, closing, rows, error. It reads files
  from a directory given on the command line (never committed data) so the maintainer can run it on the real set.

## Non-goals
- Upload UI, rekening creation, password storage, AI — other cycles.
- New banks or OCR.
- Changing rounding of cents, dedupe, or continuity rules.

## Assumptions
1. `holder` is an additive optional field on `ParsedStatement` (`lib/import/types.ts`); nothing stores it yet.
2. Detection order in `lib/banks.ts` stays first-match; new phrases must not make an existing layout fixture switch
   bank (the bank-detect tests guard this).
3. If BRImo's opening balance can't be proven from the summary + running balance, the existing provenance rules
   decide (`opening: "DERIVED"` with its note) — don't invent a new rule.

## Gate re-openers
None: no schema, no dependency, no AI, no app code. Accounting invariants unchanged (refusal of two-sided amounts
kept).

## Tasks
- [x] T1 Zero side = empty in two-column amount tables; BRImo layout (synthetic fixture, header fields, footer lines
      ignored, last-page summary) — accept: BRImo tests + zero-side cases green, all bank tests green.
- [x] T2 Mandiri e-Statement + BNI wondr detection; BNI rekening from header; BNI declared period — accept: synthetic
      fixtures read as wanted; bank-detect tests green.
- [x] T3 `holder` for BCA, BRImo, Mandiri, BNI wondr, SMBC — accept: unit tests per layout; undefined elsewhere.
- [x] T4 `scripts/check-real-statements.ts` + `lib/banks.ts` format list + full gate + draft PR — accept: full gate
      green, PR open with the "real-file check pending" note.
- [x] T5 Review follow-up after the maintainer's real-file run (PR #143 comment): BRImo summary values printed atop
      the next page when the labels end a page; checker tries `--password` only on locked files; checker reports a
      running-balance break as `continuity`, so `error` means "would be refused" — accept: synthetic split fixture and
      checker tests fail before, pass after; full gate green.

## Implementation
- T1 `8bbbdc5` — a zero side is an empty side; BRImo layout (bilingual teller column, page footers, last-page summary
  read from its own cells as independent evidence).
- T2 `55de470` — Mandiri e-Statement and BNI wondr header detection; wondr rekening from the right-hand product cell;
  BRImo two-digit-year and wondr shared-month declared periods.
- T3 `4946cdf` — optional `holder` from labelled fields or each layout's known header cell (BCA, BRImo, Mandiri, BNI
  wondr, SMBC per section); never from rows.
- T4 `5222d86` — `scripts/check-real-statements.ts`, format listings in `lib/banks.ts` (count stays 25).
- T5 — the summary scan accepts only the English label row, that page's footer and the next page's title lines between
  labels and values; anything else, or a malformed/missing value, still refuses. The checker reads each file without a
  password first and retries with `--password` only on `PdfPasswordError("needed")`; `continuity` is `"ok"` or the
  continuity note, and the exit code is nonzero only when `error` is set.

## Verification
- T1–T4: full gate and local walk recorded in PR #143 (head `5222d86`).
- Maintainer real-file run (13 statements, results only): BRImo, BNI wondr ×2, Mandiri ×2, BCA ×5 and SMBC ×3 read;
  one BRImo file refused (summary split across a page break) — fixed in T5.

## Ship Notes
real-file check pending — run `scripts/check-real-statements.ts` locally on the BRImo file with the split summary.
