# Kotak Persetujuan: one approval queue per client

**Roadmap:** Phase 2 item 1 (firm-lens parity, owner's choice 2026-10-17). `docs/roadmap.md` §5, Phase 2: "every proposal, in one queue
per client with a count on the firm board … each item is a card with Approve / Edit / Reject, and bulk approval applies only where it is
already safe … every posted entry links back to the proposal that produced it."

**Approval:** the owner approved building the four firm-lens cycles on 2026-10-17 ("go ahead, build all four without stopping"):
[credit limits and reminders](2026-10-17-pengingat-piutang.md), [Wawasan](2026-10-17-wawasan-keuangan.md),
[Coretax files](2026-10-17-coretax-files.md) and this one.

## Context
Buku already proposes and never posts on its own (ADR 0003, 0009; accounting-rules 14, 5a, 20b). But each kind of proposal waits on its
own page, so the accountant has to know where to look:
- **Account suggestions on bank lines** (AI, simple guesses, ambiguous transfers, financing and tax-payment hints) wait on *Review
  transaksi*, every line still in review through the month.
- ***Jelaskan* drafts** (`ProposedEntry`, AI) and **1999 corrections** of an accepted ledger-file difference (`ProposedEntry`,
  deterministic) wait on *Tutup Buku*, in *Usulan jurnal koreksi*.
- **Adjustment-schedule instalments** due through the month (depreciation, amortisation, accruals) wait on *Jurnal Penyesuaian* and
  *Tutup Buku*.
- **Coretax faktur not in the books** wait on *Pajak Masa* (*Catat piutang / Catat utang*), per company.

The firm board on Beranda counts only the bank lines in review (*Review: N transaksi*), so a client with no bank lines left but three
unposted depreciation instalments and an AI draft reads as done until Tutup Buku says otherwise.

Who feels it: the accountant working a month (four pages to sweep before the close), the partner scanning the firm board (the count is
partial), and the pilot's exit test ("every AI-originated entry traces to its approved proposal").

Traceability today, read from the schema:
- A posted draft or 1999 correction is linked: `ProposedEntry.entryId` (unique) → the journal; the journal shows nothing of it on
  Jurnal Umum or Buku Besar yet.
- An instalment carries `scheduleId` + `installment`, and Jurnal Umum already names "Jadwal “…”, cicilan n".
- A booked faktur is an invoice whose number is the faktur's number (`bookFaktur` refuses a second one), so the Coretax row is found by
  (company, direction, number); Jurnal Umum shows only "Dokumen <number>".
- An accepted account suggestion is a RECLASS with `bankTransactionId`. The line keeps only its *current* method, confidence and
  suggested account, and the `CLASSIFY` audit event records the decision (from 1999 to the account, who, when) but not the suggestion it
  decided on, nor the RECLASS it produced. A later *Ubah akun* overwrites the line's method, so which entry came from an accepted AI
  suggestion is not recoverable per entry.

## Decisions
- **A read model over existing tables, no new table and no migration.** The queue is computed at read time from what each page already
  reads (bank lines in review, open `ProposedEntry` rows, the month's 1999 corrections, due instalments, the faktur reconciliation).
  Every action on a card is an existing server action, so every writer, lock, re-check and refusal stays exactly as it is.
- **One page per client, *Kotak persetujuan*** (client menu, first item of stage 2, before Review transaksi), scoped like Review: the
  ScopeBar month and company (or the whole group). Kinds in v1, in this order:
  1. **Klasifikasi bank:** every line in review through the month end (same set and order as Review).
     - *Setujui* = Review's own accept with the suggestion unchanged (account and tax tag; the line's withholding is kept).
     - *Ubah* opens Review on that line, where account, tax, withholding, split and *jadikan aturan* live. Rebuilding that editor here
       would be a second classification UI.
     - No *Tolak*: a bank line can't be refused, only classified. Until then it stays on 1999 and the close FAILs, as today.
     - At most 50 cards; the rest are counted, with a link to Review.
  2. **Draf jurnal:** open AI drafts (*Jelaskan*) and 1999 corrections of the month, as the *Usulan jurnal koreksi* card shows them.
     - *Ubah* = the account of a line (amounts never; a bank line's own account stays fixed).
     - *Setujui* posts through the existing post action, with its snapshot, grounding and double-correction re-checks.
     - *Tolak* = *Abaikan* (status DISMISSED), for AI drafts only. A 1999 correction can't be refused: the close FAILs until 1999 is
       cleared. A draft that would correct twice shows why and offers only *Tolak*.
  3. **Jurnal terjadwal:** each due instalment (overdue ones included), *Setujui* = *Catat*.
     - *Ubah* opens Jurnal Penyesuaian: a schedule is never edited, only stopped and made again.
     - No *Tolak*: an owed instalment can't be skipped. To leave it, write a note on the *Jurnal terjadwal belum dicatat* control.
  4. **Faktur Coretax belum di buku:** each counted faktur of the masa that matches nothing in the books, for a Rupiah company that
     imported faktur for the month.
     - *Ubah* = the revenue (keluaran) or expense/asset (masukan) account, prefilled as on Pajak Masa (4100 / 5100), from the same
       account lists.
     - *Setujui* = *Catat piutang / Catat utang* (the invoice writer).
     - No *Tolak*: a difference is explained with a note on the *Faktur Coretax = buku* control.
- **Out of the queue, and why:**
  - Coretax differences with nothing to approve stay REVIEW controls explained on Tutup Buku: PPN in the books without a faktur, and
    bukti-potong mismatches (the fix is a Review edit of the line's withholding).
  - Schedule *candidates* create a schedule from a form; they post nothing.
  - Ledger-file account mappings are accepted before the file posts, inside the import draft.
  - OCR rows are proof checks, not proposals.
  - FX revaluation and the module journals (CKPN, tax pack, leases, benefits, stock count) are computations owned by their pages and
    controls.
  - The roadmap names none of these for this item. Each can join later as one more kind in the read model.
- **Bulk only where it is already safe, using the rules that exist:**
  - **Bank lines:** *Setujui N usulan yakin*, by Review's rule. Method AI, confidence ≥ 80 %, a suggested account and no accountant hint
    (capex, down payment, missing withholding). Lines go one by one, in order, through the same accept.
  - **Instalments:** *Catat semua N* (`postAllDue`).
  - **Nothing else in bulk:** AI drafts are re-checked one by one, and 1999 corrections and faktur need an account chosen.
- **One vocabulary on the page: *Setujui · Ubah · Tolak*.** Tutup Buku, Jurnal Penyesuaian and Pajak Masa keep their buttons
  (*Catat jurnal*, *Abaikan*, *Catat*); renaming them is a follow-up, not this cycle.
- **The firm board counts the queue.** The *Review* column becomes ***Persetujuan***. It shows "N usulan" (Perlu dicek) or "Selesai"
  (Lolos) and links to the client's Kotak for the board's month. The count is computed by the same read model, so it always equals
  the page. Beranda's task list keeps its per-company *Periksa N transaksi* tasks.
- **Every posted entry names the proposal it came from**, on Jurnal Umum, the Buku Besar drawer and the Jurnal Umum / Buku Besar Excel
  source column:
  - from a draft: "Usulan AI (Jelaskan · <control title>)" or "Koreksi selisih 1999", read from `ProposedEntry.entryId`;
  - from an instalment: the existing "Jadwal “…”, cicilan n";
  - from a booked faktur: "Faktur Coretax <file> <row>", found by company, direction and number;
  - from an accepted account suggestion: "Usulan AI 6120 (92 %) disetujui" or "Usulan AI 6120 diubah ke 6130". To make this exact per
    entry, the reviewer's writer adds to the `CLASSIFY` event it already writes the suggestion it decided on (account, method,
    confidence) and the id of the RECLASS it posted. That is JSON on an append-only row: no column, no migration.
  - Decisions made before this release show what they show today: audit events are never rewritten.

## Acceptance criteria
- [x] *Kotak persetujuan* lists, for the month and scope: the bank lines in review, the open AI drafts and 1999 corrections, the due
      instalments and the counted Coretax faktur not in the books. A count per kind is shown, and the total equals the sum of the kinds.
- [x] *Setujui* on a bank line posts it to its suggested account and tax tag exactly as Review's accept does, and the card leaves.
      *Ubah* opens Review with that line active.
- [x] *Setujui N usulan yakin* accepts only AI lines ≥ 80 % with a suggestion and no accountant hint; a hinted, heuristic, simple-guess
      or < 80 % line stays.
- [x] A draft's accounts can be changed (not its amounts) before *Setujui*. *Tolak* dismisses an AI draft. A 1999 correction offers no
      *Tolak*. A stale or twice-correcting draft is refused with the existing message.
- [x] *Setujui* on an instalment posts it; *Catat semua* posts every due one; *Ubah* opens Jurnal Penyesuaian.
- [x] *Setujui* on a faktur books it as a receivable or payable against the chosen account, and the faktur control moves accordingly.
- [x] An empty queue says so ("Tidak ada usulan menunggu persetujuan …") with *Tutup buku* as the next step. A locked month shows the
      queue read-only. A viewer (*Peninjau*) sees the queue without action buttons.
- [x] The firm board's *Persetujuan* column shows each client's count for the month, equal to that client's Kotak (all companies), and
      links there.
- [x] Jurnal Umum and the Buku Besar drawer name the proposal behind an entry posted from a draft, an instalment, a Coretax faktur or a
      review decision taken after this release (accepted unchanged vs changed, with the suggested account and confidence). The Excel
      source column says the same.
- [x] No number on any report changes (`verify:books` ALL PASS).
- [x] Works at 390 px without sideways page scroll.
- [x] Deck claims to review in ship: `kantor.html` slide 04 *Papan kantor* ("transaksi yang menunggu review") and slide 07 *Review*
      ("menunggu di antrean review"); `docs/demo/investor-demo.md` (the board's *Review* column).

## Verify flows
1. Accountant, demo client Grup Ayam Nusantara, its working month. Beranda → the *Persetujuan* cell shows "N usulan" → Kotak opens
   with the same total.
   - *Setujui* one AI line ≥ 80 % → it leaves and the count drops by one.
   - *Setujui N usulan yakin* → only confident, unhinted lines leave.
   - *Ubah* on a low-confidence line → Review opens on that line.
2. Same client: post a due depreciation instalment from Kotak, then *Catat semua*. Jurnal Umum shows the entries with
   "Jadwal “…”, cicilan n". Accept a bank line unchanged and change another in Review. Jurnal Umum shows "Usulan AI … disetujui" and
   "… diubah ke …" on their reclassifications.
3. AI draft: on the local stack, store one through `explainControl` with `MockProvider` (a one-off local script, no model call, not
   committed).
   - Change a line's account and *Setujui*. Jurnal Umum names "Usulan AI (Jelaskan · …)".
   - A second draft → *Tolak* → it leaves, and Tutup Buku no longer lists it.
4. Coretax: import the e-faktur fixture the `ekualisasi-ppn` e2e uses → the unbooked faktur appears. Pick an account and *Setujui*:
   the faktur control shows one fewer, and Jurnal Umum names the Coretax file and row.
5. Edge: a locked month → the queue is read-only with the closed-month NextStep. Error: an AI draft made stale by a later review →
   *Setujui* shows "Buku berubah sejak draf ini dibuat…" verbatim and the card stays.

## UX notes
- **Page.** PageHeader *Kotak persetujuan* with the ScopeBar; description "<scope> · usulan sampai <tanggal>".
  - NextStep: "Setujui, ubah atau tolak N usulan di bawah. Tidak ada yang dicatat tanpa klik Anda." Done state: "Tidak ada usulan
    menunggu persetujuan untuk <bulan>." with the CTA *Tutup buku*.
- **Kind tabs.** Under the header, LinkTabs by kind with counts (`?jenis=`, default *Semua*): Semua · Klasifikasi bank · Draf jurnal ·
  Jurnal terjadwal · Faktur Coretax. A kind with 0 is hidden.
- **One card per kind, divided rows (no boxes in boxes).** Each row reads, top to bottom:
  - eyebrow: kind, company, date;
  - title: the bank text, memo, or faktur number and counterparty;
  - the amount, right-aligned (`Money`);
  - the reason line: `MethodBadge` (AI / Tebakan / Aturan / Jadwal / Coretax), the confidence (< 70 % in the review colour), the reason
    in full;
  - for journals, the lines with the account select where *Ubah* is allowed;
  - the buttons *Setujui* (outline), *Ubah* (ghost or link) and *Tolak* (ghost; AI drafts only).
- **The one primary button** on the page is the bulk *Setujui N usulan yakin* when there is one. Otherwise there is none.
- **Problems first** inside a kind: blocked drafts, then low confidence, then the rest by date.
- **Board.** The column header *Persetujuan*; the cell is a `StatusPill` "N usulan" (REVIEW) or "Selesai" (PASS), linked like the other
  cells.
- **Entry origin.** One muted line under the existing source line, with the same `.drill` link rules. The link goes to the
  proposal's place when it still exists (Review line, schedule).

## Test seams
- DB: `approvalQueue` / `approvalCounts`.
  - Each kind appears from fixtures; scope by company and month; overdue instalments; locked months excluded.
  - The faktur kind appears only once faktur were imported; counts = queue.
- DB: each approval through its existing action leaves the queue and the posted entry carries its link (`ProposedEntry.entryId`,
  `scheduleId`, invoice number = faktur, the `CLASSIFY` event's suggestion and entry id). Extend `tests/db/proposals.test.ts` and
  `schedules.test.ts` where they already set up.
- DB: the board overview's per-client count equals `approvalCounts` (`tests/db` workspace test).
- Unit: entry-origin text (draft, 1999, instalment, faktur, review accepted vs changed); bulk-eligibility filter (shared with Review);
  nav order (`tests/unit/nav.test.ts`).
- E2E: `e2e/kotak-persetujuan.spec.ts` walks flows 1, 2 and 4 on the demo. The investor walk is updated only if it reads the board's
  *Review* cell (today it checks only *Sumber*).

## Non-goals
- *Lihat alasan* (roadmap Phase 2 item 2), the automation dial (item 3), flux approval (item 4): later cycles that build on this queue.
- New proposal kinds beyond the four, and a stored proposals table.
- Renaming the buttons on Tutup Buku, Jurnal Penyesuaian or Pajak Masa; moving those cards off their pages.
- Editing a bank line's tax, withholding or split inside Kotak (Review owns it).
- A queue across all clients (the board's count links per client); a count badge in the sidebar.
- Backfilling origin for review decisions made before this release.

## Assumptions
- The queue for a client-month holds at most a few hundred items. Bank lines dominate, so they are capped at 50 cards with the full
  count shown.
- The board's extra cost per client is small: a proposal count, `dueProposals`, the 1999 corrections, and the faktur reconciliation
  only when faktur exist for the masa.
- `CLASSIFY` events stay append-only. Enriching new events doesn't change how *Riwayat perubahan* or the close timeline read them: they
  read `subject`, `summary` and time, and the change test before writing an event is unchanged.
- A faktur number is unique per company and direction (schema unique), so (company, direction, number) finds the Coretax row of a booked
  invoice.
- Viewers may see the queue (read-only), as they see Review.

## Gate re-openers
None planned:
- no migration;
- no dependency;
- no auth or permission change (the existing `books.write` actions);
- no real AI call (the walk uses `MockProvider`);
- no number on a report changes.

If traceability turns out to need a column after all, that is a migration: stop and ask.

## Tasks
- [x] T1 `lib/approvals/queue.ts`: `approvalQueue` and `approvalCounts` over the four kinds, plus DB tests. Accept: each kind, scope,
      overdue and locked cases, counts = queue. Reuse: Review's query, `proposalViews` / `correctionViews` (`lib/adjust/proposals.ts`,
      `suspense.ts`), `dueProposals` / `proposalViews` (`lib/adjust/view.ts`), `fakturRecon`, `packApplies`, `isSimpleGuess`.
- [x] T2 Kotak page (`/clients/[id]/approvals`), the `ApprovalQueue` client component, the nav entry, and Review's `?tx=` focus.
      Accept: flows 1, 3 and 4 on the dev server. Reuse: `reviewAction`, `postProposalAction` / `dismissProposalAction`,
      `postInstallmentAction` / `postAllDueAction`, `bookFakturAction`, `accountantHints`, `MethodBadge`, `Money`, `LinkTabs`,
      `NextStep`. (deps: T1)
- [x] T3 Firm board: a per-client `approvals` count in `getWorkspaceOverview`, the *Persetujuan* column linking to Kotak, and the
      investor-demo doc line. Accept: the board count = Kotak total (DB test). (deps: T1; can run parallel with T2)
- [x] T4 Entry origin.
      - `reviewTransactionTx` records the suggestion and the RECLASS id on its `CLASSIFY` event.
      - `ENTRY_SOURCE_SELECT` / `entrySource` (or a sibling `entryOrigin`) name the draft, 1999 correction, Coretax faktur or review
        decision.
      - Shown on Jurnal Umum, the Buku Besar drawer and the Excel source column.
      Accept: unit and DB tests, flow 2. (parallel with T2/T3)
- [x] T5 verify-local: walk flows 1–5 with screenshots at 1440 and 390 px; `e2e/kotak-persetujuan.spec.ts`; the full gate
      (`verify:books` ALL PASS). (deps: T2–T4)

## Implementation
- Plan: T1 → T2, T3, T4 sequential, inline in one worker (they share the read model and the views it reads; a fan-out would cost
  more than it saves). T5: the e2e spec and docs here; verify-local runs centrally.
- T1: `lib/approvals/queue.ts`, `lib/classify/hints.ts`, `lib/adjust/{proposals,suspense,view}.ts`, `lib/tax/faktur.ts`,
  `components/app/review-queue.tsx`, `app/(app)/clients/[id]/tax/masa/page.tsx`, `tests/db/approvals.test.ts`,
  `tests/unit/review-hints.test.ts` — `approvalQueue` / `approvalCounts` over the four kinds (Review's query and order for bank lines,
  `correctionViews`, the schedule `proposalViews`, `fakturRecon` per Rupiah company that imported faktur for the masa). Views gained
  `entityId` for the scope filter. Review's bulk rule is now `isSureSuggestion` / `bulkAcceptable` (hints.ts), shared by both pages;
  Pajak Masa's faktur account lists are `fakturCounterAccounts`, shared with Kotak.
- T2: `app/(app)/clients/[id]/approvals/page.tsx`, `components/app/approval-queue.tsx`, `lib/nav.ts`, `components/app/app-sidebar.tsx`,
  `components/app/status.tsx`, `components/app/review-queue.tsx`, `app/(app)/clients/[id]/review/page.tsx`, `app/actions.ts`,
  `README.md`, `AGENTS.md`, `tests/unit/nav.test.ts` — the page (ScopeBar, `?jenis=` LinkTabs for kinds with a proposal, NextStep for
  open / done / locked / viewer), one card per kind with divided rows, every button an existing action; Review opens on `?tx=<id>`;
  the menu lists *Kotak persetujuan* first in stage 2. `postAllDueAction` takes an optional `entityId` so *Catat semua* in a
  one-company scope posts only that company's instalments (`postAllDue` already took it; a foreign id matches no schedule).
- T3: `lib/workspace/index.ts`, `components/app/workspace-overview.tsx`, `tests/db/workspace.test.ts`, `docs/demo/investor-demo.md`,
  `README.md` — each board client carries `approvals` (`approvalCounts` for the month, every company) and `approvalsHref`
  (`/approvals?…&entity=combined`); the *Review* column is *Persetujuan* ("N usulan" / "Selesai"). The client-level `openReview` /
  `reviewHref` had no other reader and went; Beranda's per-company *Periksa N transaksi* tasks are unchanged.
- T4: `lib/review.ts`, `lib/reports/entry-origin.ts`, `lib/reports/{journal-register,general-ledger,account-ledger,ledger-workbook}.ts`,
  `components/app/ledger-table.tsx`, `app/(app)/clients/[id]/journals/page.tsx`, `tests/unit/entry-origin.test.ts`,
  `tests/unit/ledger-workbook.test.ts`, `tests/db/entry-origin.test.ts` — `reviewTransactionTx` adds `suggestion` (account, tax tag,
  method, confidence; only for a line still in Review) and `entryId` (the RECLASS) to the `after` of the `CLASSIFY` event it already
  writes; the change test before the event is untouched. `entryOrigins(db, entryIds)` reads, in one batch per page, the draft
  (`ProposedEntry.entryId`), the booked faktur (invoice by `entryId` → Coretax faktur by company, direction, number) and the review
  decision (the event whose `after.entryId` is the RECLASS); a draft wins over the review event its bank-line RECLASS also wrote.
  Shown as "Asal: …" under *Sumber* on Jurnal Umum and in the Buku Besar drawer, and appended to the Excel source column of both
  workbooks. No schema column was needed.
- T5 (worker part): `e2e/kotak-persetujuan.spec.ts` — on the demo it only reads (CV Sinar's board cell equals its Kotak, the 83 %
  line is the one offered in bulk, *Ubah* opens Review on the 74 % line; Grup Ayam's closed July is read-only), because CV Sinar's
  two Review lines belong to `review-safety` and Grup Ayam's August to the investor walk. Every approval runs on a client of its own
  (flows 1, 2 and 4): three bank lines, a depreciation schedule from June (two overdue instalments) and an unbooked faktur → board
  "7 usulan" = Kotak; *Setujui* a line, *Ubah* → Review, *Setujui* + *Catat semua 2*, the faktur booked; Jurnal Umum names
  "Tebakan 4100 disetujui", "Tebakan 6190 diubah ke 6130" and the Coretax file; 390 px without sideways scroll. The investor walk
  reads only the board's *Sumber* cell, so it is unchanged; `docs/demo/investor-demo.md` names the *Persetujuan* column. Not run
  here: verify-local (flows 1–5 walked, screenshots) and the full gate run centrally.
- Decisions made while building:
  - Bank cards keep Review's set; inside the kind, lines under 70 % (simple guesses included) come first, then Review's date order
    (the UX note's "problems first"). The 50-card cap applies after that order.
  - *Setujui N usulan yakin* takes every confident line in scope, not only the 50 cards on screen (the full count is the queue's).
  - The kind tabs show only when more than one kind has proposals.
  - A faktur origin needs both the number match and the description `bookFaktur` writes ("Faktur pajak <n> (Coretax …"), so an
    invoice typed by hand with a faktur's number is never called a Coretax faktur.
  - A *Jelaskan* draft's control title is read from that month's controls. A control the month no longer raises (a scan finding the
    draft fixed) leaves the title out: "Usulan AI (Jelaskan)". Titles are not stored and the spec rules out a column.
  - The origin line is text without a link: once approved, the proposal's own page no longer lists it (Review, Tutup Buku, Pajak
    Masa). Instalments keep their existing "Jadwal “…”, cicilan n" source line and get no second line.
  - Origin wording for other methods follows the method badge: "Tebakan 6190 disetujui", "Aturan …", a confidence only for AI; a
    changed tax tag counts as a change ("… diubah ke 6120").
  - `postAllDueAction` (sensitive path) gains an optional `entityId`; it goes through the same `writeClient` (`books.write`) check
    and is only used inside the client-scoped schedule query.
  - A viewer gets a NextStep of their own and no buttons at all (the *Ubah* links included).

## Verification
- **Walk (local, :3200, demo admin):** CV Sinar Retail, August: the board's *Persetujuan* cell equals the Kotak count (2 usulan), *Setujui 1
  usulan yakin* offers only the 83 % grosir line, *Ubah di Review* opens Review on the RAK DISPLAY line; Grup Ayam July (closed) shows the
  queue read-only; on a QA client bank lines, scheduled journals and a Coretax faktur approved from Kotak each name their origin in Jurnal
  Umum. 1440 and 390 px: scroll width = viewport. `verify:books` ALL PASS (no report number moves).
- **Task gate (head `ff2dbee`, all four cycles merged):** `npm run lint` exit 0, `npm run typecheck` exit 0, `npm test` "Test Files 298
  passed (298) · Tests 2710 passed (2710)" (1041 s).
- **Full gate:** `npm run build` exit 0; `npm run demo:reset`; `npm run verify:books` → "ALL PASS — 1765 pemeriksaan saldo cocok dengan
  ground truth"; `npm run test:e2e` 110 passed and 3 failed only on the local environment (`APP_URL` and the local auth stack on port 3000
  instead of 3200, the same as the jurnal-umum cycle recorded); with both on 3200 `auth-links` and `trial-signup` re-ran and passed (3/3),
  and `public-site` passed.
- **While walking:** two new e2e expectations were wrong against the demo (the July 6170 mover holds one line, not three; the closed-month
  Kotak test read the URL before navigation) and were fixed; Wawasan counted the group's opening-only February as the year's lowest month
  and in the average, fixed in `d096678` (the trend starts at the first month with a Laba Rugi figure, unit-tested).

- **Acceptance criteria → tests** (checked assertion by assertion after the walk; `40aa478` and the payable-faktur DB test closed the
  gaps): every criterion is asserted by a unit, DB or e2e test, except where noted. 390 px: the receivables, Coretax, Wawasan and Kotak
  walks assert no sideways scroll on every run (and that the reminder dialog fits), not only when screenshots are taken. Viewer checks run
  as a Peninjau in e2e (Kotak, Wawasan, Piutang). Proven below the UI only: Kotak's draft account edit and Tolak (the proposal writers'
  DB tests; the 1999 card's missing *Tolak* is read in code), the bulk *Setujui N usulan yakin* rule (unit, the same action as Review's),
  and the five-mover cap (code, `MOVERS_SHOWN`).

Verified locally — ff2dbee

## Ship Notes
- No migration: the origin is JSON added to the `CLASSIFY` event already written. Decisions taken before this ships show no origin (audit
  events are append-only).
- The board's *Review* column is now *Persetujuan*; the deck says so (kantor slide 04).
- Deck: kantor slides 04 (Persetujuan column), 07 (Kotak), 10 (Piutang: batas kredit, pengingat), 12 (Coretax file, Wawasan) and 16
  (limits), perusahaan slide 13; PDFs regenerated; checked at 1440×900 and 375×812, no overflow.
- The `e2e` label applies (app flows).
