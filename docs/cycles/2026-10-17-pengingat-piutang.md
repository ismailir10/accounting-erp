# Credit limits and payment reminders on Piutang

**Roadmap:** firm-lens parity with Mekari Jurnal (owner's choice 2026-10-17): the *Invoice & payment* box, credit limits and payment reminders,
built for the accounting firm and not for the client's own billing desk. Buku already has the rest of that box on *Piutang & Utang*
([receivables cycle](2026-09-29-receivables-payables.md)). `docs/roadmap.md` §6 keeps invoicing out, and this cycle respects that: Buku
issues and sends nothing. The firm prepares the reminder and the client sends it.

**Approval:** the owner chose firm-lens parity and approved building its four cycles on 2026-10-17 ("go ahead, build all four
without stopping"): this one, [Wawasan](2026-10-17-wawasan-keuangan.md), [Coretax files](2026-10-17-coretax-files.md) and
[Kotak Persetujuan](2026-10-17-kotak-persetujuan.md).

## Context
*Piutang & Utang* shows each company's receivables per customer: sales invoices with PPN, settlements from bank lines (FIFO, advances),
aging (*Belum jatuh tempo*, 1–30, 31–60, 61–90, > 90 days) checked against the ledger, CKPN and the client's own aging. Mekari Jurnal
has two more things in that box that firms ask about:
- **Batas kredit.** A customer's credit limit, with a warning when their open receivable goes above it. Buku does not store a limit.
  An accountant who sees a customer at Rp 480 jt has no way to tell whether that is normal for them or a problem.
- **Pengingat tagihan.** A reminder for overdue invoices. Jurnal emails the reminder from the business's own account. Buku is the firm's
  tool, and the firm does not collect for the client. What the firm does at month end is tell the client "these customers are late". It
  sometimes also gives the client a ready reminder or a statement to forward. Today the accountant copies the numbers off the aging by hand.

Who feels it: the accountant at month end with overdue customers on the aging. The client's owner or finance staff, who gets a
message or PDF ready to send to the customer. The partner, who sees which customers sit above their limit.

Buku has the pattern already. *Minta data yang kurang ke klien* on Unggah builds a message the accountant can edit, with *Salin pesan*
and *Kirim lewat WhatsApp*, and Buku never sends anything itself. This cycle uses the same pattern for overdue customers.

## Decisions
- **Credit limit per customer, in Rupiah, optional.** It is stored on the contact. Empty means no limit. Only positive whole Rupiah are
  accepted. It is set from the customer's row on the *Piutang* aging (a visible pencil button next to the name, the same way *Channel* is
  set on *Penjualan per channel*). A writer can set it (Akuntan and above); a Peninjau sees it. Each change is recorded in Riwayat as *Batas
  kredit*, with the before and after amounts.
- **The limit applies per company.** A contact belongs to the client and is shared by name across the client's companies. The aging,
  the reminder and the statement are all per company (the legal seller), so a company's net receivable from the customer is compared with
  the limit. Most clients have one company. The limit only applies to companies whose books are in Rupiah; a company in another
  currency shows no limit.
- **Over limit = net receivable > limit at the aging date.** Net receivable = open invoices − that customer's advance (uang muka). This
  is the *Jumlah* the aging row already shows. The row shows the limit, plus *Lewat batas kredit* in the review colour when net receivable
  is above it. When the page is in its "cocok" state, the existing sentence also names how many customers are over their limit. **No close
  control:** a customer above their limit is a credit-management fact for the client. The books are not wrong, so the close must not be held
  up for it. **No blocking or warning when an invoice is saved:** the invoice is recorded after the fact, from a document that already
  exists.
- **A reminder per company and customer with overdue invoices** (sales only). The aging row has a visible *Pengingat* button. It opens a
  dialog with the message, which the accountant can edit, and three actions: *Salin pesan*, *Kirim lewat WhatsApp* (a `wa.me` link with no
  number, so the sender picks the chat) and *Unduh surat tagihan (PDF)*. Buku never sends the message itself.
- **The message is in the company's voice, not the firm's.** It opens with "Yth. <pelanggan>" and lists each overdue invoice (number,
  invoice date, due date, remaining amount, days late) and their sum. It says "menurut catatan kami per <tanggal>" and asks the customer to
  ignore it if they paid after that date. It is signed with the company's name. If the customer has an advance not yet applied, one line
  asks which invoices it is for. Invoices that are not due yet are left out, and so are amounts withheld as tax (bukti potong
  stays with *Minta data*).
- **Reminder date = the earlier of the month end and today.** For a month that has not ended, the month end would make invoices due later
  this month look late. The dialog shows the date. When the month is not closed yet, the dialog also says that receipts not yet imported are
  not deducted.
- **Surat tagihan (statement of account) as PDF**, per company and customer, on the same date: the company name and NPWP, *Surat Tagihan*,
  the customer, and every open invoice. Overdue invoices are marked with their days late. The columns are total, paid, and remaining. Then
  the total, the advance line if there is one, and a one-row aging summary (the five buckets). It has no firm name and no DRAF mark: it is
  the client's document to its customer, not the firm's report. A Peninjau can download it, as with other downloads. It does not create a
  *Laporan diunduh* event, so the firm board's *Terkirim* is unchanged.
- **Utang gets neither feature.** Supplier credit limits and supplier reminders are not part of this.

## Acceptance criteria
- [ ] On *Piutang*, an Akuntan sets a customer's *Batas kredit* from their aging row. The row then shows the limit. Clearing the field
      removes the limit. Zero, a negative amount and text are refused with a Bahasa message. A Peninjau sees the limit but has no pencil
      button.
- [ ] A customer whose net receivable (open − advance) in a Rupiah company is above their limit shows *Lewat batas kredit*. A customer
      exactly at the limit, or with no limit set, does not. A company in another currency shows no limit for the same contact.
- [ ] Riwayat lists each change as *Batas kredit* with the customer and the before and after amounts.
- [ ] Every aging row with an overdue invoice on the reminder date has *Pengingat*. Rows with nothing overdue do not, and neither do
      rows on the *Utang* tab.
- [ ] The reminder lists only that company's overdue invoices for that customer, with remaining amount and days late. Their sum equals
      the overdue part of the aging row when the reminder date is the month end. The message is signed with the company's name and can be
      edited before copying. *Kirim lewat WhatsApp* opens `wa.me` with the edited text.
- [ ] For the current month, the reminder date is today and an invoice due later this month is not listed.
- [ ] *Unduh surat tagihan (PDF)* downloads a PDF that lists every open invoice for that company and customer, and its total equals the
      row's open amount. A member who no longer has access to the client gets 404, and so does an unknown customer.
- [ ] Downloading the statement leaves the firm board's *Terkirim* unchanged.
- [ ] Works at 390 px without the page scrolling sideways, and the dialog fits.

## Verify flows
1. Accountant, a client with a sales invoice (the receivables e2e path: import a statement, *Faktur baru* INV-100 due 30 days before the
   month end, left unpaid): on *Piutang*, set INV-100's customer's *Batas kredit* below the open amount → *Lewat batas kredit* appears;
   raise it above → the badge goes; Riwayat shows both changes.
2. Same customer: *Pengingat* → the message lists INV-100 with its days late and the company signature. Edit a word, *Salin pesan*, then
   *Kirim lewat WhatsApp*, and check that the link carries the edited text. *Unduh surat tagihan (PDF)* → open the file: the open invoices,
   the total, and the aging summary.
3. Edge: select the current month while an invoice is due later this month. The reminder is dated today and leaves that invoice out.
   If nothing else is overdue, the row has no *Pengingat*.
4. Error: type `0` or `abc` as the limit → the Bahasa refusal, nothing saved. Sign in as Peninjau → no pencil button, but *Pengingat* and
   the PDF work. Request the statement URL with an unknown customer id → 404.

## UX notes
- The aging card is unchanged; additions go on the customer's row only. Next to the name there is a ghost pencil (*Ubah batas kredit
  <nama>*). Under the name, on wide screens, muted "Batas Rp …" text. When over the limit, *· lewat batas kredit* in `text-review`, the same
  way *· kelebihan bayar* is shown. On the right of the row there is a ghost *Pengingat* button, which also shows on phones, because the
  row is the only place for it.
- The limit dialog has one field, *Batas kredit (Rp)*, with the help text "Kosongkan bila tidak ada batas. Berlaku per perusahaan untuk
  piutang dalam Rupiah." *Simpan* is the primary button.
- The reminder dialog has the title *Pengingat tagihan · <pelanggan>* and the description "Per <tanggal> · <perusahaan>. Ubah bila perlu,
  lalu kirim lewat klien." It holds the textarea, then *Salin pesan* and *Kirim lewat WhatsApp* (outline) and *Unduh surat tagihan (PDF)*
  (outline, download icon). No button is primary: none of them changes anything. The hint about the month not being closed sits under the
  description in muted text.
- No new `NextStep`. The page's existing banner already says what to do. Its "cocok" sentence also counts customers over their limit.

## Test seams
- DB: `setCreditLimit` (set, clear, refuse 0 / negative, wrong client, audit event); the aging view's limit and over flag (net with an
  advance, at the limit, no limit, non-Rupiah company); the reminder loader (overdue only, per company, reminder date for the current
  month, advance line).
- Unit: the reminder text builder on fixed data (lines, sum, signature, advance line, no overdue → null).
- Route: the statement PDF returns `application/pdf` for a member and 404 after access is revoked or for an unknown customer (added to
  `tests/db/session-revocation.test.ts`, as the Jurnal Umum exports were).
- UI: extend `e2e/receivables.spec.ts` with flows 1–2 (limit badge, reminder text, PDF download), and take screenshots at 1440 and 390 px.

## Non-goals
- Buku sending anything: no email, no WhatsApp API, no scheduled or automatic reminders, no reminder history.
- Storing customer phone numbers or emails (the `wa.me` link lets the sender pick the chat).
- Supplier (utang) credit limits or reminders. Blocking or warning on invoice entry. A close control for limits.
- A firm-to-client summary of every overdue customer in one message (the aging is that summary).
- Statement as Excel; a statement over a date range with payments history (this one is open items at a date).
- Limits in other currencies, or one limit for a whole group.

## Assumptions
- Credit limits are a Rupiah figure the client gives the accountant; a contact has at most one.
- A customer has few enough overdue invoices that a WhatsApp message stays readable. Beyond 15, the message lists the oldest 15 and says
  the rest are in the attached statement.
- The company's `name` and optional `npwp` are enough for the statement header (Buku stores no company address).
- Reading the reminder and the statement is a read (`books.read`); setting the limit is a write (`books.write`).

## Gate re-openers
- **Schema migration (additive):** `Contact.creditLimit BigInt?` with a CHECK `creditLimit IS NULL OR creditLimit > 0`. It is nullable
  and has no backfill, so code from before this cycle ignores it, and a rollback can leave the column in place.
- No new dependency (`pdfkit` is already used for the statements PDF). No auth or permission change (existing `books.read` /
  `books.write` checks). No AI call. No number on a report changes, and nothing is posted (rule 5c unchanged; the limit is metadata).
  No PII leaves Buku through the server: the `wa.me` link is opened by the user, as *Minta data* does.

## Tasks
- [x] T1 Credit limit. Add the migration (`Contact.creditLimit` + CHECK) and `lib/receivables/credit-limit.ts` `setCreditLimit`, shaped
      like `setContactChannel` in `lib/receivables/channels.ts`: `LedgerError` Bahasa refusals, `parseMoney`, `recordEvent` with the new
      kind `CREDIT_LIMIT` "Batas kredit" in `lib/audit.ts`. Add `setCreditLimitAction` in `app/actions.ts` through `writeClient`. In
      `receivablesView`, aging rows gain `contactId`, `limit` and `over` (IDR companies only, `net > limit`). Accept: `prisma migrate diff`
      empty and DB tests green. (deps: none)
- [x] T2 Reminder and statement. Add `lib/receivables/reminder.ts`: a pure `paymentReminder()` text builder, plus `reminderItems(db,
      clientId, entityId, contactId, asOf)` over `invoicesAt` and `unmatchedLines` (advance), with reminder date = min(month end, today).
      Add `lib/receivables/statement-pdf.ts` `customerStatementPdf`, reusing `winAnsi` and the palette and margins from
      `lib/reports/pdf.ts`, and `BUCKETS` / `BUCKET_LABEL` / `bucketOf` from `aging.ts`. Add the route
      `app/(app)/clients/[id]/receivables/statement/route.ts` (GET `?entity&contact&period`, `findClientForMember`, 404 otherwise, no
      `recordExport`). Accept: unit + DB + route tests. (deps: T1 for `contactId` on rows; can run in parallel with T3's limit UI)
- [x] T3 UI. On the *Piutang* aging rows in `components/app/receivables.tsx`: the pencil, the limit dialog, the limit text and the over
      marker, and *Pengingat* with its dialog. Pull the copy + WhatsApp buttons out of `components/app/data-request-card.tsx` into one
      shared piece that both use. The page passes the reminder texts, built server-side with the view, and the closed-month flag. Add the
      over-limit count to the "cocok" `NextStep` sentence. Extend `e2e/receivables.spec.ts`. Accept: e2e flows 1–2, screenshots at 1440 and
      390 px. (deps: T1, T2)
- [x] T4 Docs + verify-local. Update the README *Piutang & Utang* row and the accounting-rules 5c sentence (limit = metadata, reminders
      derived, nothing posted). Run the full gate and walk flows 1–4. (deps: T3)

## Implementation
- Plan: T1–T3 sequential in one worker (T2 reads T1's `contactId` on the aging rows, T3 renders both); T4's docs part inline with T3;
  verify-local, the e2e run and screenshots by the driver.
- T1: `prisma/migrations/20261017110000_contact_credit_limit`, `prisma/schema.prisma`, `lib/receivables/credit-limit.ts`, `lib/audit.ts`,
  `app/actions.ts`, `lib/receivables/view.ts`, `tests/db/credit-limit.test.ts` — `Contact.creditLimit` (CHECK NULL or > 0);
  `setCreditLimit` parses whole Rupiah, refuses zero and negatives in Bahasa (text gets `parseMoney`'s own message), and records a
  *Batas kredit* event with the amounts before and after (none when the value is unchanged); `setCreditLimitAction` through
  `writeClient`; aging rows carry `contactId`, `limit` and `over` (Piutang of IDR companies only, net > limit).
- T2: `lib/receivables/reminder.ts`, `lib/receivables/statement-pdf.ts`, `lib/reports/pdf.ts` (exports the page, margins, palette and
  `amountIn`), `app/(app)/clients/[id]/receivables/statement/route.ts`, `tests/unit/payment-reminder.test.ts`,
  `tests/db/payment-reminder.test.ts`, `tests/db/session-revocation.test.ts` — `reminderDate` (min of the month end and today in WIB),
  `customerReminders` (every company × customer of the scope in one pass, for the page) and `reminderItems` (one, for the statement; null
  for a contact not the client's, an empty statement for one with nothing open), the pure `paymentReminder` text, `customerStatementPdf`,
  and the GET route (404 for another client, an unknown company or customer; no `recordExport`).
  - Decision: `reminderItems` takes the page's month end and computes the reminder date itself (with `now` injectable for tests), so the
    route and the page cannot disagree on the date.
  - Decision: the reminder asks for each overdue invoice's open amount **less the tax the customer still withholds** (`whtExpected`), and
    drops an invoice whose only rest is that tax: the decisions leave withheld tax to *Minta data* (bukti potong). Without expected tax
    the sum equals the aging row's overdue part at the month end (tested); with it, it is that part less the tax. The statement stays gross
    (total, paid, remaining), so its total equals the row's open amount.
  - Decision: the statement prints the advance as its own line and then *Sisa setelah uang muka* (open − advance, the row's *Jumlah*); the
    footer names the company and the page, never the firm.
- T3: `components/app/share-message.tsx` (new), `components/app/data-request-card.tsx`, `components/app/receivable-reminder.tsx` (new),
  `components/app/receivables.tsx`, `app/(app)/clients/[id]/receivables/page.tsx`, `e2e/receivables.spec.ts` — *Salin pesan* and *Kirim
  lewat WhatsApp* are one `ShareMessageActions` used by *Minta data* and the reminder; Piutang aging rows get the pencil (writers only,
  via `useAccess`, Rupiah companies only), "Batas Rp …" on wide screens and *lewat batas kredit* in the review colour, and a ghost
  *Pengingat* column only on a card with a reminder; the page builds every reminder text server-side with `customerReminders`, passes the
  reminder date, the period and whether the month is still open, and counts distinct customers over their limit in the "cocok" sentence.
  The e2e extends the receivables walk with INV-300 (due 1 Aug, unpaid): refusals, over / not over, the reminder text edited into the
  WhatsApp link, the PDF's content, no buttons on Utang, both Riwayat events, and 1440 / 390 screenshots with a no-sideways-scroll check.
  - Decision: the limit dialog shows the server's refusal under the field (`FieldError`) and stays open, rather than a toast, so the
    accountant fixes the value in place; a success is a toast as on *Channel*.
  - Decision: both dialogs are keyed by their row, so each opens with that customer's current limit or a fresh message (an edit never
    leaks to another customer's reminder).
  - Not run here (the driver runs them centrally): `next build` (Turbopack refuses this worktree's symlinked `node_modules`), Playwright,
    verify-local and the screenshots.
- T4 (docs part): `README.md`, `.agents/skills/accounting-rules/SKILL.md` — the *Piutang & Utang* row names *Batas kredit*, *Pengingat* and
  the statement route; rule 5c says the limit is metadata (never posted, no control, no block, audited) and that reminders and the
  statement are derived at read time, with nothing posted, stored or sent. The full gate and flows 1–4 stay with verify-local.

## Verification
- **Walk (local, production build on :3200, demo admin):** `e2e/receivables.spec.ts` on a fresh client: a limit below the open amount shows
  *lewat batas kredit*, above it the mark goes, `0` and `abc` are refused in Bahasa, both changes are in Riwayat; *Pengingat* on INV-300
  ("jatuh tempo 1 Agu 2026 … terlambat 30 hari", Rp 5.550.000, signed "PT Piutang Uji"), the edited text in the `wa.me` link, the statement
  PDF with every open invoice, no *Pengingat* on Utang. Screenshots at 1440 and 390 px; no sideways scroll.
- **Task gate (head `ff2dbee`, all four cycles merged):** `npm run lint` exit 0, `npm run typecheck` exit 0, `npm test` "Test Files 298
  passed (298) · Tests 2710 passed (2710)" (1041 s).
- **Full gate:** `npm run build` exit 0; `npm run demo:reset`; `npm run verify:books` → "ALL PASS — 1765 pemeriksaan saldo cocok dengan
  ground truth"; `npm run test:e2e` 110 passed and 3 failed only on the local environment (`APP_URL` and the local auth stack on port 3000
  instead of 3200, the same as the jurnal-umum cycle recorded); with both on 3200 `auth-links` and `trial-signup` re-ran and passed (3/3),
  and `public-site` passed.
- **While walking:** two new e2e expectations were wrong against the demo (the July 6170 mover holds one line, not three; the closed-month
  Kotak test read the URL before navigation) and were fixed; Wawasan counted the group's opening-only February as the year's lowest month
  and in the average, fixed in `d096678` (the trend starts at the first month with a Laba Rugi figure, unit-tested).

Verified locally — ff2dbee

## Ship Notes
- Migration `20261017110000_contact_credit_limit`: one nullable `Contact.creditLimit BIGINT` with a CHECK (NULL or > 0). Apply it to
  production before merging (README → Schema changes; the build refuses a pending migration, ADR 0019). Rollback: revert the code; the
  column can stay.
- No env var, dependency or AI call; no report number moves.
- Deck: kantor slides 04 (Persetujuan column), 07 (Kotak), 10 (Piutang: batas kredit, pengingat), 12 (Coretax file, Wawasan) and 16
  (limits), perusahaan slide 13; PDFs regenerated; checked at 1440×900 and 375×812, no overflow.
- The `e2e` label applies (app flows).
