# Import quality: what the production walk of #149 found

## Context
The user walked [`2026-10-10-new-client-from-files.md`](2026-10-10-new-client-from-files.md) (#149) end to end in production with five
real clients (Belifi, Goers, Filosofi Kopi, Chickin; files from the shared Drive) and asked for everything that made the accountant do
the software's work to be fixed. The walk's findings, each seen on the real app:

1. Tambah klien proposes one company named after the *client*, though the files name the real one (Goers' neraca: "PT Sanraya"; Filosofi
   Kopi's: "PT FKM").
2. A multi-entity ledger workbook (Chickin: entity column SKP/SPN/CSP/CAH + HOLDCO sheets) becomes one company; Unggah then fails the
   file ("File ini berisi beberapa tabel"), "Coba cara lain" loses it, the sheet picker needs two clicks, and the importer's advice
   ("perbaiki filenya") is wrong: the fix is the companies.
3. Reports, Neraca Saldo and Review open on the current month and show nothing for a client whose only books are a Neraca (Dec 2024).
4. Unggah's banner says "Unggah rekening koran pertama" while the first files are booking.
5. Missing months are only said at Tutup Buku (Belifi: BCA Jun + Agu, no Jul → Rp 4.276.500 saldo mismatch).
6. Review pre-fills ~200 customer receipts with *1130 Piutang Usaha* when no receivable exists (owned by the cloud session
   "Replace unbacked AR/AP AI suggestions" — not in this cycle).

Not a defect after checking: the ~100 *"Kode X dipakai dengan nama berbeda"* warnings of the Chickin ledger are per entity (SKP reuses
21001 for two accounts across years), so they are real. And mapping a file account to *1999 Belum Terklasifikasi* stays refused: 1999
is a load-bearing transient account (accounting-rules 9, 15a, 22); mapped lines would be a permanent close blocker.

## Spec
- **Period default.** A client with only opening/Neraca entries opens Reports / Neraca Saldo / Review on the latest month it has,
  not today. With any real activity the picker is unchanged (opening months stay out of it).
- **Company from the file.** The card names the company after the name in the file's title rows ("PT …"), else the file name; a
  multi-entity ledger proposes one company per entity label, with the label as the short name (so Unggah matches rows to companies
  without asking).
- **Multi-sheet workbooks.** Unggah no longer fails a workbook with several postable sheets: each sheet becomes its own draft.
- **Honest copy.** The "Entitas … belum dipasangkan" check says what to do (add the company, or map the label), not "perbaiki filenya".
- **Unggah while booking** says what it is doing; the first-file banner only shows when nothing is booking.
- **Missing months on the card.** A rekening whose read statements skip a month says so, before the client is created.
- No schema change unless a task says so below.

## Tasks
- [x] T1 `dataMonths` falls back to opening months for a Neraca-only client — accept: `tests/db/data-months.test.ts`.
- [x] T2 Company name + entity labels from the files into the card (`LedgerSection.entities`, `PreviewFile.companyName`, label kept as the card's short name) — accept: `tests/unit/title-company.test.ts`, `tests/unit/inbox-propose.test.ts`, `tests/db/inbox-preview-ledger.test.ts`.
- [x] T3 Multi-sheet workbook → one draft per sheet in the inbox (`stageLedger`; a Neraca sheet that needs a company says so) — accept: the two cases in `tests/db/inbox-process.test.ts`.
- [x] T4 Importer copy for unmatched entities (message + the page's next step: add the company) and the Unggah banner while files are booking — accept: `tests/unit/ledger-check.test.ts`; the banner is walked in T6.
- [x] T5 Missing-month note on the card (`ProposedAccount.gaps`, by the statements' dates; Tutup Buku's coverage control stays the authority) — accept: `tests/unit/inbox-propose.test.ts`.
- [x] T6 The real files through the real preview and inbox, locally (`scripts/_tmp-*.ts`, untracked: private data) — Goers, Filosofi, Chickin, Belifi; found and fixed the merged-title bug the synthetic fixtures missed.
- [x] T7 The mapping table says when a file balance sits on the wrong side of the account it is mapped to (`againstNature`, `importBalances`) — accept: `tests/unit/nature.test.ts`, `tests/db/import-balances.test.ts`, the third case of `e2e/import-quality.spec.ts`.
- [ ] T8 Re-walk the five production clients after merge; record.

## Implementation

## Verification

## Ship Notes
