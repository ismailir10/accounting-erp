# Core accounting parity, round three: Lampiran jurnal and Arsip akun

**Roadmap:** core accounting parity with Jurnal and Zahir (`docs/roadmap.md` §3), continuing
[round two](2026-10-20-paritas-inti.md) under the owner's request of 2026-10-20 to keep going until Buku is on par on the core
accounting features. Round two's non-goals named the remaining gaps; this round takes the two an accountant meets weekly.

## Context
- **No evidence on a journal.** In Jurnal every transaction takes an attachment (*lampiran*); in Zahir a *bukti* scan. In Buku a bank
  line drills to its statement row, but a journal typed by hand — petty cash, an accrual, a correction — carries only its memo. The
  receipt, the invoice or the partner's approval mail lives outside the books, so "every number traceable to its source" stops at the
  manual journals, exactly the ones an auditor samples first.
- **No way to retire an account.** A chart grows (Bagan akun adds accounts; ledger imports create them). An account a client stopped
  using still shows in every picker for ever: Review, Jurnal Penyesuaian, invoices, assets. Jurnal archives an account; Zahir marks it
  *non-aktif*. Buku can only delete an account that was never used.

Who feels it: the accountant (a cleaner picker, the receipt one click from the journal), the auditor and partner sampling manual
journals, and the client's own staff reading the Jurnal Umum.

## Decisions
- **Lampiran jurnal**
  - Any journal can carry files: PDF, JPG, PNG, up to 5 MB each and 10 per journal (the upload limit Buku already uses).
  - Attached from the journal's place in Jurnal Umum (*Lampirkan bukti*) and, for a new Jurnal Penyesuaian, chosen on the form and
    stored with it. Bank lines keep their statement row as source; a lampiran adds to it, it does not replace it.
  - Stored in the database like every other file (`JournalAttachment`: bytes, name, type, size, who, when), never sent to a model,
    never read for amounts. A lampiran is evidence, not a ledger record: it never changes a number.
  - Served only to members who may open the client (the same tenancy check as every client page), as a download with its own name.
  - Removable while the journal's month is open (books.write); a closed month keeps its lampiran, like its journals. Adding one to a
    closed month's journal is allowed — evidence arriving after the close is normal and changes no number. Every add and remove is in
    Riwayat.
  - Shown wherever the journal is: a paperclip with the count on Jurnal Umum and in the Buku Besar drawer, each file listed with a
    download link; the Jurnal Umum Excel names the files in its source column.
- **Arsip akun**
  - *Arsipkan* on Bagan akun for an account that may be edited (not a system, bank, guess or protected account) and whose balance is
    zero at the client's latest month with entries and that has no line in an open month after it — so archiving hides nothing that
    still counts. *Aktifkan lagi* undoes it at any time.
  - An archived account leaves every picker (Review, Jurnal Penyesuaian, Saldo Awal, invoices, assets, rules, mapping suggestions)
    and the classifier never proposes it (a rule or a remembered choice pointing at it falls through to Review). Reports and ledgers
    still show it wherever it has a figure, for the months it was used.
  - `postJournal()` refuses a new line on an archived account, so nothing can reach it around the pickers; the message names the
    account and the way back (*Aktifkan lagi* on Bagan akun).
  - Riwayat records archive and reactivation.

## Acceptance criteria
- [ ] A Jurnal Penyesuaian saved with a PDF shows a paperclip on Jurnal Umum; the file downloads with its name; another firm's member
      gets 404 for its URL.
- [ ] *Lampirkan bukti* adds a file to any journal, also a bank line's; *Hapus* removes it in an open month and is refused in a closed
      one; both are in Riwayat.
- [ ] A file over 5 MB or of another type is refused with the reason; nothing is stored.
- [ ] *Arsipkan* hides an unused-now account from Jurnal Penyesuaian and Review pickers; Bagan akun lists it under *Diarsipkan* with
      *Aktifkan lagi*.
- [ ] An account with a balance, a system account, or one with lines in an open later month can't be archived, with the reason.
- [ ] `postJournal()` refuses an archived account; a classification rule pointing at it leaves the line in Review.
- [ ] Full gate green; `verify:books` ALL PASS.

## Non-goals
- Recurring multi-line journals and departments/projects (next round).
- OCR or AI reading of a lampiran.
- Sub-accounts.

## Gate re-openers
- A migration: one table (`JournalAttachment`) and one column (`Account.archivedAt`). Additive.
- `postJournal()` gains one refusal (archived account). Tightened, not relaxed.
- A new download route serving client files: same tenancy check as the client pages (`findClientForMember`).

## Tasks
- [x] T1 Schema + migration (`20261020120000_lampiran_arsip`).
- [x] T2 Lampiran: store, upload actions, download route, Jurnal Umum and Buku Besar drawer, form upload, Riwayat, tests.
- [x] T3 Arsip akun: rules, Bagan akun actions, pickers and classifier, `postJournal()`, Riwayat, tests.
- [x] T4 e2e: lampiran and arsip walk; README, deck claims.

## Implementation
- `b28dfc9` feat(ledger): lampiran jurnal — `lib/ledger/attachments.ts` (type told by the first bytes, 5 MB, 10 per journal; removal only
  while the month and every later month are open), `addAttachmentsAction` / `removeAttachmentAction`, the download route
  `/clients/[id]/journals/lampiran/[attachmentId]` (`findClientForMember`, attachment disposition, `nosniff`), Jurnal Umum, Buku Besar
  drawer, the form's *Lampirkan bukti*, the Jurnal Umum workbook's source column; import removal refuses while a lampiran exists.
- `091db9d` feat(coa): arsip akun — `archiveAccount` / `unarchiveAccount`, `postJournal` refusal, pickers (`classifiableOptions`,
  `openingTargetOptions`, `isClassifiable`, the page queries), the import classifier (code set and memory), AI scopes; Bagan akun's
  *Diarsipkan* section with *Aktifkan lagi*, *Arsipkan* in the edit dialog.
- `1aba287` test(e2e): lampiran jurnal and arsip akun.

Decisions taken while building:
- *Arsipkan* is offered for unused accounts too (next to *Hapus akun*): a template account the client never uses is the most common
  thing to hide, and archiving keeps the code reserved.
- Removing an import whose journals carry a lampiran is refused (the cascade would delete evidence silently).

## Verification
Verified locally — 1aba287.
- `npm run lint && npm run typecheck && npm test`: exit 0; **334 files, 3063 tests passed** (dedicated test database), including
  `tests/db/attachments.test.ts` and `tests/db/archive-account.test.ts`.
- `npm run build && npm run demo:reset && npm run verify:books`: **ALL PASS — 1765 checks**; `db:drift` clean.
- `npm run test:e2e` on the production build with CI's env: **134 passed**, `e2e/lampiran-arsip.spec.ts` among them.

## Ship Notes
