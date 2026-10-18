# Usulan akrual: accruals proposed from each vendor's history

**Roadmap:** Phase 2 item 6. `docs/roadmap.md` §5, Phase 2: "Accrual suggestions from history. When a vendor that recurs every month is
missing this month, Buku proposes an accrual with a rationale. This extends the existing ledger-derived adjustment candidates." Rillet's
pattern (§2): the accruals agent "compares this month's spend per vendor with its history and proposes an accrual with a written
rationale, marked *Needs review*".

**Approval:** the owner approved building [Instruksi kantor](2026-10-18-instruksi-kantor.md), [Usulan akrual](2026-10-18-usulan-akrual.md) and [Persetujuan kedua](2026-10-18-persetujuan-kedua.md) on 2026-10-17 ("Build all three"). Open questions settled: the amount is the median of the history (owner's choice); *Lihat alasan* extends to this card, the double-count REVIEW control and the ±25 % band stay as recommended.

## Context
What exists today, read from the code:
- **One accrual candidate, per account, on Jurnal Penyesuaian.** The ledger-derived candidates (fixed-asset purchase, prepayment,
  deferred revenue, recurring cost missing this month) are computed at read time and shown with a prefilled schedule form. The
  recurring-cost branch:
  - takes every BEBAN account except 7190 and 7200;
  - needs the ledger scan's three baseline months to all have activity, the account's movement > 0 in each of them, and *exactly zero*
    movement on the account this month;
  - proposes the **average** of the three months, Dr the account / Cr **2150 Beban Masih Harus Dibayar** (only when the chart has
    2150), as a one-month ACCRUAL schedule that reverses on the 1st of the next month;
  - is hidden when a running schedule has an instalment on that account this month, and floors out amounts below the scan's
    materiality (1 % of the baseline's average monthly P&L volume).
- **What that misses.**
  - It works per **account**, not per vendor. Rent for two buildings on 6120, or PLN and Telkom on 6130: when one of them is missing
    and the other paid, the account moved, so nothing is proposed.
  - Any movement hides it, including a refund, a reclass or a manual journal.
  - It proposes in the middle of a month, before the statements reach its end, so a vendor that pays on the 25th shows as "missing"
    on the 10th.
  - Goods purchases (5100) count, though a supplier that did not deliver this month is no cost to accrue (periodic stock, rule 5i).
  - It is not in Kotak persetujuan: the queue shows Review lines, *Jelaskan* drafts and 1999 corrections, due schedule instalments
    and unbooked Coretax faktur. A candidate has no *Tolak*, so one the accountant disagrees with stays on the page every visit.
- **Pieces to reuse.**
  - **Counterparties.** Every bank line keeps a `merchantKey` (its description stripped of references and channel noise);
    `isGenericKey` says when a key names nobody ("BI FAST OUTGOING"), and such a key is never learned or grouped. A purchase invoice
    (`Invoice`, PURCHASE) has a `Contact`, and its INVOICE entry debits the expense. A bank line matched for AR/AP keeps `contactId`.
    Ledger-file lines (IMPORTED) have only their account, memo and `sheet!row`.
  - **Statement coverage.** `statementCoverage` says per bank account whether the declared statement periods cover a date range
    (rule 22c).
  - **Proposals.** `ProposedEntry` holds deterministic proposals too (SUSPENSE, 1999 corrections): computed at read time, stored
    only when decided, one row per `key` (unique), linked to its posted entry (`entryId`). Sources today: AI_CONTROL, SUSPENSE.
  - **Balik otomatis.** `postAdjustment(… reverseNextMonth)` posts an ADJUSTMENT and its mirror on the 1st of the next month in one
    transaction (`reversesId` set, "Pembalik: …" memo); a locked next month refuses both.
  - **Kotak persetujuan** is a read model; the firm board's *Persetujuan* count and the checklist's Otomatis proof "Kotak kosong" both
    call `approvalCounts`, so a new kind shows on the board and holds the checklist task without extra work.
  - **Lihat alasan** shows the steps, rows and values behind an AI card, with *Unduh nilai (CSV)*. Its cycle limited it to AI cards:
    "deterministic cards' reason already says why".
  - **Entry origin.** Jurnal Umum, the Buku Besar drawer and the Excel source column print where a posted entry came from
    (`originText`): "Usulan AI (Jelaskan …)", "Koreksi selisih 1999".

Who feels it:
- **The accountant at close,** who remembers from last month that the cleaning service, the rent or the consultant's fee should be in
  the books, and types each accrual by hand with *Balik otomatis*, or forgets one.
- **The partner reviewing the pack,** who sees a month where 6120 dropped by a third and asks why.
- **The client reading Laba Rugi,** whose month looks better than it was.
- **The pilot's exit test:** "fewer review minutes per client-month".

## Decisions
- **One source of truth: the accrual candidate moves out of the schedule candidates into Kotak persetujuan.**
  - The recurring-cost branch is removed from the ledger-derived candidates; fixed-asset, prepayment and deferred-revenue candidates
    are unchanged.
  - A new module computes the accrual proposals, and Kotak shows them as a new kind, *Usulan akrual*. Nothing else proposes accruals.
  - Jurnal Penyesuaian no longer lists accrual candidates. Its NextStep names the open accrual proposals and links to Kotak. The manual
    *Akrual* schedule form and *Balik otomatis* on the journal form stay as they are.
- **The unit is a counterparty on an expense account, per company.** A bucket is (company, account, counterparty), where the
  counterparty is:
  - **a bank payee:** the `merchantKey` of the bank line behind the entry (BANK or RECLASS), only when `isGenericKey` is false;
  - **a supplier:** the `Contact` of a purchase invoice (INVOICE entry, not voided);
  - **none, for ledger-fed books:** lines of imported ledger files (IMPORTED) form one bucket per account. A ledger file names no
    payee Buku can trust, so these clients keep today's per-account behaviour under the new rule.

  Other entries are the accountant's own or a register's (ADJUSTMENT, schedules, reversals, OPENING): they never count as spend.
- **Accounts:** BEBAN accounts on *Beban umum & administrasi*, *Beban penjualan* and *Beban lain-lain*, except 7190 (rounding), 7200
  (FX) and 7300 (disposals). HPP (5100–5190) and tax expense (8xxx) are out: goods not delivered, or tax not yet computed, are no
  accrual.
- **The rule (deterministic, one pure function).**
  - **History:** the four calendar months before the month (M−4 … M−1). Each month's amount is the bucket's net natural movement
    (Σ debit − Σ credit) from the counted lines.
  - **Recurs:** at least 3 of the 4 months have movement, and every month with movement is > 0 (a refund month disqualifies).
  - **Stable:** every month's amount is within 25 % of the median: 4 × |amount − median| ≤ median, exact in bigint.
  - **Median:** with three months, the middle one; with four, of the two middle amounts the one from the later month. So the
    proposed amount is always an amount one month actually carried, and that month's rows are its proof. An average would be a number
    no row shows; the last month alone would let one odd month (a late fee, a part payment) set the accrual.
  - **Material:** the median is at least the ledger scan's materiality for the company (the same floor as today's candidate).
  - **Missing:** nothing from the counterparty is dated in M through its last day:
    - a bank payee: no bank line of the company with that `merchantKey`, direction out, in M, **whatever its status**. A payment still
      in Review on 1999 has arrived;
    - a supplier: no purchase invoice of that contact in M, and no bank line matched to that contact in M;
    - a ledger bucket: no imported line on that account in M.
  - **The month is complete:** M has ended, and
    - for a bank payee, every bank account that carried its history lines is covered through M's last day (`statementCoverage`).
      A missing statement is not a missing vendor;
    - for a ledger bucket, the company has imported ledger lines dated in M.
  - **Open:** M is not locked (a locked month has nothing to approve, as Kotak leaves out locked instalments).
- **The proposal.** Dr the bucket's account / Cr **2150 Beban Masih Harus Dibayar**, dated M's last day, reversed on the 1st of M+1.
  A chart without 2150 still gets the proposal with the credit empty: *Setujui* stays disabled until *Ubah* picks a liability.
  - **Memo:** "Akrual <counterparty> <Agu 2026>" (≤ 120 characters); line notes name the counterparty.
  - **Rationale (Bahasa, one paragraph),** built only from computed facts, for example: "HJ MARYAM SEWA GUDANG dibayar ke 6120 Beban
    Sewa pada Apr, Mei, Jun dan Jul 2026 (Rp 25.004.000 – Rp 25.007.000). Agustus belum ada sampai 31 Agu 2026, dan rekening koran
    BCA Giro sudah lengkap sampai tanggal itu. Usulan: Rp 25.007.000, nilai tengah riwayat (Jul 2026)."
  - **Refs:** every history line it counted, as `jl:<journal line id>` (the anomaly scans' citation form), so each one drills to its
    bank row or `sheet!row`.
- **Stored only when decided, as a `ProposedEntry`** (source **ACCRUAL**, a new enum value), as the 1999 corrections are:
  - key = company, month, account and counterparty (`ACCRUAL:<entityId>:<YYYY-MM>:<code>:<bucket>`);
  - *Setujui* stores it POSTED with `entryId`, the proposed lines, the rationale and the refs; *Tolak* stores it DISMISSED;
  - an undecided proposal is never stored, so it vanishes on its own when the payment line arrives before close.
- ***Setujui*: the adjustment writer with *Balik otomatis*.** One SERIALIZABLE transaction:
  1. recompute the bucket and refuse if it is no longer missing ("Pembayaran HJ MARYAM SEWA GUDANG 28 Agu 2026 sudah masuk; usulan
     ini tidak berlaku lagi.") or already decided;
  2. post the ADJUSTMENT on M's last day and its mirror on the 1st of M+1 through the same code path as Jurnal Penyesuaian's
    *Balik otomatis* (refactored so both share it, minor units in, no re-parsing). A locked M+1 refuses both;
  3. store the POSTED proposal with `entryId`.
  The entry's origin reads "Usulan akrual (riwayat HJ MARYAM SEWA GUDANG)" on Jurnal Umum, in the drawer and in the Excel source
  column.
- ***Ubah*: amount and accounts, before *Setujui*.**
  - The amount is typed in the company's currency (`parseMoney`), > 0. An accrual is an estimate, so unlike an AI draft its amount
    may change; the origin line then reads "… diubah dari Rp 25.007.000".
  - The debit is any account of the chart except bank, clearing (1190/1199) and 1999. The credit is a LIABILITAS account, none of
    those either.
  - The proposal keeps Buku's lines; the entry holds what was posted.
- ***Tolak*: dismissed for that month, remembered.** The bucket doesn't come back for M. Next month is evaluated afresh.
- **Already accrued by hand.** When M already has an ADJUSTMENT (not a reversal, not from this feature) debiting the bucket's account
  and crediting a liability, or an ACCRUAL schedule's instalment on that account:
  - a ledger bucket is hidden, as today: the account is the bucket;
  - a payee or supplier bucket stays, with a warning line: "Sudah ada akrual 6120 bulan ini: “Akrual sewa Agustus” Rp 25.000.000.
    Pastikan bukan untuk HJ MARYAM SEWA GUDANG sebelum menyetujui." The journal can't say which vendor it was for.
- **Payment after approval: a REVIEW control** *Akrual dan pembayaran di bulan yang sama* (open for the owner, question 3). When a
  POSTED accrual's counterparty gets a line in M afterwards (a late statement), the expense is counted twice. The control lists both
  rows and says how to cancel: *Salin* the accrual's reversal into M with *Balik otomatis*. Acknowledged with a note like any REVIEW,
  never FAIL.
- **Lihat alasan on accrual cards** (open for the owner, question 2). The panel and CSV of the Lihat alasan cycle, with a deterministic
  step list:
  1. *Riwayat dibaca*: the four months, each month's amount and rows;
  2. *Aturan*: ≥ 3 of 4 months, within 25 % of the median, at least the materiality;
  3. *Bulan ini*: nothing from the counterparty through M's last day, and the statements covering it;
  4. *Nominal*: the median and its month;
  5. *Belum dicatat*.
  The panel says "Tanpa AI: tidak ada yang dikirim ke model." An accrual is an estimate the accountant must judge, as an AI card is,
  and the rows are the evidence.
- **No AI in v1.** The rule decides completely: which vendor, whether it is missing and how much are arithmetic on cited rows, and the
  rationale is a template of those facts. A model would cost credit (rule 17) and could not post anyway (invariant 4). Later, AI could
  find payees in ledger-file memos or word the rationale; neither is needed for the rule to be right.
- **Who:** *Setujui*, *Ubah* and *Tolak* need `books.write` (the existing guard of Kotak's writers). Viewers see the cards and
  *Lihat alasan*.

## Acceptance criteria
- [x] A bank payee paid to the same expense account in 3 or 4 of the last four months, within 25 % of the median and above
      materiality, with no line in an ended, fully covered M, gets one *Usulan akrual* card: Dr the account / Cr 2150, the median, the
      rationale citing the months and amounts, and refs that drill to each history row.
- [x] No card when:
      - only 2 of 4 months have movement, a month is negative, or a month is outside the 25 % band (exactly 25 % qualifies);
      - the median is below materiality;
      - the key is generic, or the account is HPP, tax, 7190, 7200 or 7300;
      - M hasn't ended, a bank account of the history isn't covered through M's last day, or M is locked.
- [x] The median: with three months the middle; with four, the later of the two middle months. Asserted on both.
- [x] The card vanishes when a bank line of that payee in M is imported, including one still in Review; a purchase invoice of that
      contact in M does the same for a supplier bucket.
- [x] Two payees on one account: the missing one is proposed while the other paid.
- [x] A ledger-fed company gets the per-account proposal under the same rule; a manual accrual on that account in M hides it.
- [x] Jurnal Penyesuaian's candidates no longer include any accrual; depreciation, amortisation and deferred-revenue candidates are
      unchanged. Its NextStep names open accrual proposals with a link to Kotak.
- [x] *Setujui* posts one ADJUSTMENT on M's last day and its mirror on the 1st of M+1 (`reversesId` set), stores the proposal POSTED
      with `entryId`, and the card leaves the queue. Trial balance: M's expense and 2150 up by the amount; M+1 back.
- [x] *Setujui* refuses, posting nothing, when the payment arrived meanwhile, when the proposal was already decided, or when M+1 is
      locked (the card says so first).
- [x] *Ubah*: a new amount and accounts post as typed; 0, a bank or clearing account, 1999, or a non-liability credit are refused
      with a field message. The origin line says "diubah dari Rp …".
- [x] *Tolak* stores the decision; the card doesn't return in M, and returns in M+1 if the vendor is still missing.
- [x] A manual accrual on the account in M puts the warning on a payee card; the card still approves.
- [x] Kotak's count, the firm board's *Persetujuan* and the checklist's Kotak proof include *Usulan akrual*; counts equal the queue.
- [x] Jurnal Umum, the Buku Besar drawer and the Excel source column show "Usulan akrual (riwayat …)".
- [x] *Lihat alasan* on an accrual card shows the five steps and "Tanpa AI"; *Unduh nilai (CSV)* holds every history row as text and
      as an integer in minor units; a viewer can open it; another client's id returns 404.
- [x] A POSTED accrual whose payee then gets a line in M raises the REVIEW control with both rows (if question 3 is accepted).
- [x] The demo seeds no accrual proposal (each scenario vendor pays every month): Kotak counts, the investor walk and `verify:books`
      ALL PASS are unchanged.
- [x] Works at 390 px without sideways page scroll.
- [x] Deck claims to review in ship: `kantor.html` slide 10 *Penyesuaian* ("Jurnal bulanan … diusulkan dari registernya") gains
      accruals proposed from each vendor's history; slide 07 *Review* (Kotak persetujuan) names the new kind.

## Verify flows
1. **Accountant, a QA client of its own** (PT with one BCA rekening; synthetic generic-CSV statements April–August 2026):
   - "PT BERSIH PRIMA JASA KEBERSIHAN" pays Rp 4.200.000 / 4.200.000 / 4.350.000 / 4.200.000 to 6190 April–July, nothing in August;
   - "PLN POSTPAID" and "TELKOM INDIHOME" both on 6130 April–July; in August only PLN;
   - "KANTOR KONSULTAN ANDALAS" on 6170 May–July (3 of 4), nothing in August.

   Kotak persetujuan, August 2026 → *Usulan akrual* lists three cards (Bersih Prima, Telkom, Andalas), each with its rationale. *Lihat alasan*
   on Bersih Prima shows four months and Rp 4.200.000 (Jul). *Setujui* → toast, the card leaves; Jurnal Umum shows the 31 Aug accrual
   with "Usulan akrual (riwayat …)" and the 1 Sep "Pembalik: …"; the firm board's count drops by one.
2. **Same client.** Telkom card → *Ubah*: amount Rp 450.000, credit 2150 kept → *Setujui*; the origin says "diubah dari Rp …".
   Andalas card → *Tolak*: reload, gone. Import a September statement without Andalas: September's Kotak shows it again.
3. **Edge: the payment arrives.** On a fresh copy of flow 1's data, import a late August line "PT BERSIH PRIMA JASA KEBERSIHAN"
   (lands in Review): the Bersih Prima card is gone without any click. With a statement ending 25 Aug instead of 31 Aug: no card at all.
4. **Edge: payment after approval.** Approve Bersih Prima, then import its 30 Aug line: Tutup Buku shows *Akrual dan pembayaran di
   bulan yang sama* with both rows; *Salin* the reversal into August with *Balik otomatis* and acknowledge.
5. **Error.** *Ubah* with amount 0 or credit 1100 → field message, nothing posted. As Peninjau: cards and *Lihat alasan* visible,
   no *Setujui*/*Ubah*/*Tolak*, and a crafted action call is refused.

## UX notes
- **Place.** Kotak persetujuan, kind *Usulan akrual* (`?jenis=akrual`), after *Jurnal terjadwal* and before *Faktur Coretax*.
  Description: "Vendor yang rutin tiap bulan tetapi belum ada di bulan ini. Setujui untuk mencatat akrual yang dibalik otomatis tanggal 1
  bulan berikutnya."
- **Card** (a divided row, no box in a box):
  - eyebrow "Usulan akrual · <perusahaan> · <31 Agu 2026>";
  - title: the counterparty, then "<kode> <akun>" muted;
  - the two lines (Dr / Cr) with `Money`, and "Dibalik otomatis 1 Sep 2026";
  - the rationale paragraph; a warning line in the review colour when there is one; problems first (a blocked or warned card leads);
  - actions: *Setujui* (primary), *Ubah* (outline: opens the amount and two account selects in the row), *Tolak* (ghost), and
    *Lihat alasan* as on AI cards.
- **Status word:** "Perlu ditinjau" (Rillet's *Needs review*) next to the eyebrow, no badge colour beyond the review token.
- **Blocked text:** "1 Sep 2026 sudah dikunci, jadi pembaliknya tidak bisa dicatat." / "Pilih akun kredit (liabilitas): bagan akun
  klien tidak punya 2150."
- **Toasts:** "Akrual dicatat, dibalik 1 Sep 2026" · "Usulan akrual ditolak untuk Agustus 2026".
- **Jurnal Penyesuaian NextStep:** "<N> usulan akrual dari riwayat vendor menunggu di Kotak persetujuan." with *Buka Kotak
  persetujuan*.
- **Copy:** Bahasa throughout; no "accrual", "median" or "bucket" on screen ("nilai tengah riwayat", "vendor rutin").

## Test seams
- **Unit** `tests/unit/accrual-rule.test.ts`: the pure decision of (four monthly amounts, floor):
  - 3 of 4 and 4 of 4 qualify; 2 of 4 doesn't; a negative month doesn't;
  - the 25 % band at the boundary (equal qualifies, one minor unit over doesn't);
  - the median for three and for four months (the later middle month);
  - below materiality doesn't;
  - the rationale text from fixed facts.
- **DB** `tests/db/accrual-proposals.test.ts` (one client built in the test, bank lines through the import pipeline):
  - the card, refs and rationale; two payees on one account; a supplier bucket from purchase invoices; a ledger bucket;
  - every "no card" case of the criteria, including partial coverage, M not ended and a locked M;
  - the payment arriving (posted, and still in Review) removes the card;
  - *Setujui* (entries, reversal, `reversesId`, POSTED with `entryId`, trial balance), *Ubah* (amount, accounts, refusals), *Tolak*
    (remembered in M, back in M+1);
  - refusals: payment arrived meanwhile, decided twice, M+1 locked (nothing posted);
  - the manual-accrual warning and the ledger-bucket hide;
  - the REVIEW control for a payment after approval;
  - the seeded demo yields no accrual proposal.
- **DB** existing suites: `tests/db/schedule-candidates.test.ts` (accrual cases move to the new suite; the rest unchanged, and no
  candidate is ACCRUAL), `tests/db/approvals.test.ts` (the kind, counts = queue), `tests/db/reverse-entry.test.ts` (*Balik otomatis*
  unchanged after the refactor), `tests/db/reasoning.test.ts` (the accrual panel and CSV, 404 for another client), the entry-origin
  test.
- **E2E** `e2e/usulan-akrual.spec.ts`: flows 1, 2 (approve, edit, reject), 3 (arrival) and 5 on QA clients of its own, 390 px.

## Non-goals
- AI anywhere in this flow (finding payees in ledger memos, wording the rationale).
- Accruals for revenue (unbilled income), for goods (HPP) or for tax.
- Partial-month accruals (a vendor that paid less than usual), quarterly or yearly vendors, and amounts that trend (indexation).
- Bulk *Setujui* for accrual cards: each is an estimate.
- Undoing *Tolak* in the UI, or remembering a dismissal beyond its month ("never for this vendor").
- A *Batalkan akrual* button: the double-count control points to *Salin* + *Balik otomatis*.
- Changing the schedule form, manual ACCRUAL schedules, or *Balik otomatis* on Jurnal Penyesuaian.
- A demo vendor that skips a month (the investor walk stays as it is).
- Firm-level settings for the 4-month window, the 3-month minimum, the 25 % band or the credit account.

## Assumptions
- **"The last four closed months" means the four calendar months before M, locked or not.** Requiring locked months would switch the
  feature off for any client that doesn't lock monthly (most of the Phase 1 pilot); the existing candidate and the ledger scan also
  use calendar months.
- **Amounts are the journal lines' functional amounts**, so a payment with PPh withheld counts gross (the expense line), one with PPN
  Masukan counts its DPP, and a foreign-currency bank account counts in the company's currency. The PPN of an unbilled month is not
  accrued.
- **"The month has ended"** is compared with today's date in Asia/Jakarta, date-only.
- **A ledger bucket's "month complete"** is "the company has imported ledger lines dated in M". A ledger file exported mid-month
  could pass it; such a file also fails the other closing checks.
- **Read cost.** Per company: one query over five months of counted expense lines, one over M's out bank lines, coverage per bank
  account and the existing scan's materiality. The firm board calls it per client, as it does the other kinds; tens of clients.
- **Accounting-rules** 5a (candidates no longer include the recurring cost; accruals proposed from history, posted with their
  reversal on click) and 20b (deterministic proposals include accruals; an accrual's amount may be changed) are updated in the same
  commits. Invariant 4 is untouched: nothing posts without the click.
- **Open for the owner** (the recommended answer is the one written above):
  1. **The amount.** The recommendation is the median (later middle month on four). The alternatives are the last month, or the
     average as today.
  2. **Lihat alasan on a deterministic card.** The recommendation is yes, for accruals only. The alternative is the rationale and an
     inline list of history rows, keeping Lihat alasan AI-only.
  3. **Payment after approval.** The recommendation is the REVIEW control. The alternative is nothing in v1, relying on the flux
     control to catch a doubled expense.
  4. **The band.** 25 % around the median. A tighter 10 % would miss utilities; a wider 50 % would accrue one-off spikes.

## Gate re-openers
- **Migration (planned):** `ALTER TYPE "ProposalSource" ADD VALUE 'ACCRUAL'`. Additive, no backfill, no new column (the dismissal is
  the existing `ProposedEntry` row). It goes under `prisma/migrations/**`, a sensitive path.
- **Accounting invariant text changes:** rules 5a and 20b as above. The writer is still `postJournal()` through the adjustment code
  path; invariant 4 is unchanged.
- **Sensitive paths touched:** `app/actions.ts` (accrual *Setujui* / *Tolak* behind the existing `books.write` guard, as the 1999
  corrections are routed by an id prefix), `prisma/migrations/**`. The permission matrix is unchanged.
- **Reports:** a number moves only when the accountant approves an accrual, by design. With no click nothing changes, and the demo has
  no proposal (`verify:books` ALL PASS).
- **None of the rest:** no dependency, no AI call, no production write.

If the stored dismissal needs more than a `ProposedEntry` row (for example a "never for this vendor" flag), that is a second
migration: stop and ask.

## Tasks
- [x] T1 `ProposalSource.ACCRUAL` + migration; `lib/adjust/accruals.ts`: buckets, the pure rule, arrival, coverage, warning,
      rationale and refs; remove the recurring-cost branch from the ledger candidates. Accept: unit + DB tests for the rule and every
      "no card" case; schedule-candidates suite green. (reuse: `scanLedger` materiality, `statementCoverage`, `isGenericKey`,
      `formatMoney`)
- [x] T2 Writer: share *Balik otomatis* between `postAdjustment` and the accrual post; `postAccrual` (recheck, post, store POSTED) and
      `dismissAccrual`; the actions; the entry origin; accounting-rules 5a and 20b. Accept: DB tests for *Setujui*, *Ubah*, *Tolak* and
      refusals; `reverse-entry` unchanged. (deps: T1)
- [x] T3 Kotak *Usulan akrual*: queue kind and counts, the card with *Setujui* / *Ubah* / *Tolak*, blocked and warning lines; Jurnal
      Penyesuaian NextStep; *Lihat alasan* accrual panel + CSV. Accept: approvals and reasoning DB tests; flows 1, 2 and 5 on the dev
      server. (deps: T2; parallel with T4)
- [x] T4 The REVIEW control *Akrual dan pembayaran di bulan yang sama* (if question 3 is accepted). Accept: DB test; flow 4. (deps: T2;
      parallel with T3)
- [x] T5 verify-local: `e2e/usulan-akrual.spec.ts`; walk flows 1–5 at 1440 and 390 px; the full gate (`demo:reset`, `verify:books`
      ALL PASS, investor walk unchanged). (deps: T3, T4)

## Implementation
- Plan: T1 → T2 → T3 → T4 → T5 sequential, inline by one build worker: each task builds on the previous one's module (the read model,
  then its writer, then the queue, the control and the e2e), so a fan-out would share every file. T5's e2e spec is written here; the
  walk on the dev server and the Playwright runs that need the shared `buku` database are left to the driver.
- T1: `prisma/migrations/20261018140000_accrual_proposals` (`ALTER TYPE "ProposalSource" ADD VALUE 'ACCRUAL'`, nothing else in it
  uses the value), `lib/adjust/accruals.ts` (pure `accrualRule` / `medianOf` / `accrualRationale`, keys, `accrualProposals`,
  `arrivals`), `lib/adjust/candidates.ts` (the recurring-cost branch removed), `lib/format.ts` (`formatMonthYear`) — the rule,
  buckets, arrival, coverage, warning, rationale and refs. Tests: `tests/unit/accrual-rule.test.ts`,
  `tests/db/accrual-proposals.test.ts`, `tests/db/accrual-regression.test.ts` (the removed candidate kept as an oracle: every case
  it proposed for ledger-fed books over six seeded rounds is proposed again unless it falls in a decided exclusion — account, band,
  refund or materiality; at least 15 kept), `tests/db/schedule-candidates.test.ts` (accrual cases moved out; no candidate is
  ACCRUAL), `tests/db/demo.test.ts` (no accrual proposal in any demo month).
- T2: `lib/ledger/adjustment.ts` (`postAdjustmentTx`: the *Balik otomatis* writer, minor units in, shared by Jurnal Penyesuaian and
  the accrual post), `lib/adjust/accruals.ts` (`currentAccrual`, `postAccrual` — SERIALIZABLE recheck of decided and arrival, post,
  store POSTED — `dismissAccrual`, `AccrualFieldError`), `app/actions.ts` (`postAccrualAction`, `dismissAccrualAction` behind
  `books.write`; a field refusal returns `fields`), `lib/reports/entry-origin.ts` ("Usulan akrual (riwayat …)", "diubah dari Rp …"),
  accounting-rules 5a and 20b. Dedicated actions rather than an id prefix on `postProposalAction`: an accrual takes an amount and two
  accounts, a draft only account codes. Tests: `tests/db/accrual-proposals.test.ts` (*deciding*), `tests/unit/entry-origin.test.ts`;
  `reverse-entry`, `adjustment`, `entry-origin` (DB) unchanged and green.
- T3: `lib/approvals/queue.ts` (kind `accrual`, `?jenis=akrual`, after *Jurnal terjadwal*; `AccrualCard`; counts; `now` on
  `QueueInput` for tests), `components/app/approval-queue.tsx` (`AccrualItem`: eyebrow with *Perlu ditinjau*, counterparty and
  account, Debit/Kredit lines, *Dibalik otomatis*, rationale with *Lihat alasan*, warning, blocked and no-2150 lines, *Ubah* with
  amount and two selects whose refusals show under the field; toasts as specified), `app/(app)/clients/[id]/approvals/page.tsx`
  (the accounts *Ubah* offers), `app/(app)/clients/[id]/journals/new/page.tsx` (NextStep "<N> usulan akrual dari riwayat vendor
  menunggu di Kotak persetujuan." → *Buka Kotak persetujuan*, after due instalments, which this page posts itself),
  `lib/approvals/has-reasoning.ts`, `lib/approvals/reasoning.ts` (`accrualReasoning`, five steps, "Tanpa AI", CSV rows with every
  history row as text and minor units), the CSV route's file name, README. *Setujui* on an accrual card is an outline button like
  every other Kotak card (ui-rules 2: one primary per view), not the primary the UX note named. Tests: `tests/db/approvals.test.ts`
  (the kind, counts = queue, the firm board and the checklist's Kotak proof), `tests/db/reasoning-accrual.test.ts`; the fixture is
  shared in `tests/accrual-books.ts`.
- T4: `lib/adjust/accruals.ts` (`paidAfterAccrual`: POSTED accruals of the company-month whose counterparty has a line in the month
  now), `lib/controls/index.ts` (REVIEW `accrual-paid:<proposal>` *Akrual dan pembayaran di bulan yang sama*: the accrual and the
  payment in its detail, `href` to Jurnal Penyesuaian with `salin=<the reversal>`), accounting-rules 5a, README (Close). Test:
  `tests/db/accrual-proposals.test.ts` (no control before the payment; raised after a late statement; the copied reversal with
  *Balik otomatis* nets August to the payment alone and 2150 to zero; a note acknowledges it, status stays REVIEW).
- T5 (build part): `e2e/usulan-akrual.spec.ts` — flows 1, 2 and 5 on "QA Usulan Akrual" and flow 3 on "QA Akrual Terlambat" /
  "QA Akrual Sebagian", each a QA client of its own (never the investor walk's state): books through the real import (generic CSV
  with a declared *Periode*) and Review's *serupa*; 390 px without sideways scroll in both tests; the Peninjau check through
  `asPeninjau` with the client assigned and restored; exact-name selectors; every read after a server action waits for its toast or
  the card count. `tests/db/accrual-actions.test.ts`: the real actions behind the guard (a crafted *Setujui* / *Tolak* by a
  Peninjau is refused verbatim, a Peninjau reads *Lihat alasan*, a refused field comes back by name, an unassigned Akuntan reaches
  nothing). Left to the driver: walking flows 1–5 at 1440 and 390 px on the dev server, `demo:reset` + `verify:books` and the
  Playwright run (they need the shared `buku` database).
- **Acceptance criteria → tests** (the owner's ask: every criterion asserted at least once):
  | Criterion | Asserted by |
  |---|---|
  | Bank payee card: Dr account / Cr 2150, the median, rationale, refs drilling to each history row | `accrual-proposals` "proposes a recurring payee…"; e2e flow 1 |
  | No card: 2 of 4, a negative month, outside the band (exactly 25 % qualifies), below materiality | `accrual-rule` (few, refund, band boundary ±1 minor unit, material); `accrual-proposals` "no card for 2 of 4…" |
  | No card: generic key, HPP, tax, 7190, 7200, 7300 | `accrual-proposals` "no card for a generic key…"; `accrual-regression` (account exclusions) |
  | No card: M not ended, a history bank account not covered, M locked | `accrual-proposals` "no card before the month has ended…", "a statement ending 25 Aug…"; e2e flow 3 |
  | The median for three and four months | `accrual-rule` "the median…"; `accrual-proposals` (Andalas 3 months, Bersih 4) |
  | The card vanishes on the payee's August line (posted or in Review); a supplier's August invoice | `accrual-proposals` "the card vanishes…", "a supplier bucket…"; e2e flow 3 |
  | Two payees on one account | `accrual-proposals` first test (Telkom proposed, PLN not); `approvals`; e2e flow 1 |
  | Ledger-fed per-account proposal; a manual accrual hides it | `accrual-proposals` "a ledger-fed company…"; `accrual-regression` (no case of the old candidate lost beyond the decided exclusions) |
  | Jurnal Penyesuaian: no accrual candidate, the rest unchanged; NextStep to Kotak | `schedule-candidates` (whole suite, "no candidate is an accrual…"); e2e flow 1 (NextStep and link) |
  | *Setujui*: ADJUSTMENT on M's last day + mirror on the 1st (`reversesId`), POSTED with `entryId`, card leaves, TB | `accrual-proposals` "Setujui posts one ADJUSTMENT…"; `accrual-actions`; e2e flow 1 |
  | *Setujui* refuses (payment arrived, decided, M+1 locked; the card says so first) | `accrual-proposals` "refuses, posting nothing…", "a locked next month blocks the card first…" |
  | *Ubah*: amount and accounts as typed; 0, bank, clearing, 1999, non-liability refused by field; "diubah dari" | `accrual-proposals` "Ubah posts…"; `accrual-actions` (fields); `entry-origin` (unit); e2e flows 2 and 5 |
  | *Tolak*: gone in M, back in M+1 | `accrual-proposals` "Tolak stores the decision…"; e2e flow 2 |
  | Manual-accrual warning on a payee card; it still approves | `accrual-proposals` "a manual accrual on the account puts a warning…", "a payee card with a manual-accrual warning still approves…" |
  | Kotak count, firm board, checklist Kotak proof; counts = queue | `approvals` "accruals from vendor history are their own kind…"; e2e flow 1 (board 3 → 2) |
  | Origin on Jurnal Umum, the drawer and the Excel source column | `accrual-proposals` "Setujui posts…" (`journalRegister`, `accountLedger`, `generalLedger`); `entry-origin` (unit); e2e flows 1–2 |
  | *Lihat alasan*: five steps, "Tanpa AI", CSV rows as text and minor units, a viewer opens it, another client's id 404 | `reasoning-accrual`; `accrual-actions` (viewer); e2e flows 1, 3 (CSV 404 under another client) and 5 |
  | REVIEW control for a payment after approval | `accrual-proposals` "a payment after approval raises the REVIEW control…" |
  | The demo seeds no accrual proposal | `demo` (every client, March–September); `verify:books` ALL PASS left to the driver |
  | 390 px without sideways scroll | e2e (both tests) |
  | Deck claims (`kantor.html` slides 10 and 07) | ship (driver) |

- **Decisions while integrating** (merge onto *Instruksi kantor* and *Persetujuan kedua*, driver's decision):
  - **An accrual card's *Setujui* follows Persetujuan kedua's *Jurnal manual* route.** With the firm's *Jurnal manual* on, the
    accountant's *Setujui* (with *Ubah*'s edits) is the maker's click: strictly above the threshold it becomes a pending
    `JournalApproval` instead of posting (no `JournalEntry`, no `ProposedEntry`); equal posts; a non-Rupiah company routes every
    accrual; when no other member may approve (the only admin's own click) it posts at once and Riwayat says "Dicatat tanpa persetujuan
    kedua". With the setting off (the default) *Setujui* is exactly as built in this cycle.
  - **One writer.** Persetujuan kedua split the adjustment writer into `prepareAdjustment` + `postPreparedAdjustment`; this cycle's
    `postAdjustmentTx` is folded into the latter, so Jurnal Penyesuaian, an approved waiting journal and the accrual post all go through
    `postPreparedAdjustment` (*Balik otomatis* included). The accrual writer is split the same way: `prepareAccrual` (the proposal as it
    reads now, *Ubah* checked, a `PreparedAdjustment`) and `postPreparedAccrual` (SERIALIZABLE: a `guard`, the undecided/still-missing
    re-check `checkAccrualOpen`, the one adjustment writer, the POSTED decision, an `onPosted` hook). `postAccrual` (direct),
    `submitAccrual` (routing, `lib/approvals/journals.ts`) and `approveJournal` (the approval) all use it.
  - **The link is one nullable column, `JournalApproval.accrualKey`** (migration `20261018160000_accrual_second_approval`: additive, no
    backfill; the source CHECK allows it only on a MANUAL request with *Balik otomatis*; a partial unique index keeps one PENDING per
    proposal). The request is MANUAL with *Balik otomatis*, lines as typed (Dr the account / Cr the liability, the counterparty as each
    line's note); Kotak shows it under *Persetujuan kedua* labelled *Usulan akrual*, and `accrualProposals` leaves a waiting key out, so
    the card is never in both kinds. While it waits, a direct *Setujui* or *Tolak* (and a second request) is refused: "Usulan akrual ini
    menunggu persetujuan kedua. Putuskan di Kotak persetujuan." August (dated) and September (its reversal) can't lock meanwhile.
  - **Approval** re-reads the proposal (`currentAccrual` with `withPending`): a payment that arrived, a decision made or a locked next
    month refuses and leaves the request PENDING; otherwise the stored lines post, the `ProposedEntry` is stored POSTED with the entry
    (`decidedById` = the approver, so the origin line reads as an approved accrual) and the request becomes APPROVED, in one transaction
    under the client's close lock. **Reject or withdraw** stores nothing on the proposal: the card comes back to *Usulan akrual*, a
    rejected one with "Ditolak <nama>: <alasan>" (as a rejected AI draft), and may be submitted again or rejected.
  - The card says so before the click with the forms' own line (`formNotice` on the typed amount): "Di atas Rp …: jurnal ini menunggu
    persetujuan anggota lain sebelum dicatat." and *Ajukan persetujuan*; the toast reads "Jurnal menunggu persetujuan".
    `postAccrualAction` now answers like `adjustmentAction` (`entryId`, `pending`, `fallback`).
  - Tests: `tests/db/accrual-second-approval.test.ts` — card off posts at once with no request; above the threshold a request with no
    entry, the card under *Persetujuan kedua* only, counts = queue, direct paths refused, both months' lock blocked; approval by a second
    member posts the accrual and its 1 Sep reversal (`postedById` = approver), stores POSTED and approves the request (never the maker's
    own; a second click decides nothing); at/below the threshold posts directly and *Ubah*'s amount is what is routed; a rejection
    returns the card with the reason and an approval after the payment arrived stays pending; the one-admin fallback. Kotak:
    `tests/db/approvals.test.ts` (both kinds, `second` and `accrual` in the counts, *Persetujuan kedua* first).

## Verification
- Build worker, on its own test database (`buku_test_b`), before the driver's walk:
  - `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` after `migrate deploy`:
    "No difference detected."
  - Full `npm test`: `Tests  2858 passed (2858)`; `Test Files  1 failed | 315 passed (316)` — the one file is
    `tests/db/db-drift.test.ts` ("Hook timed out in 10000ms"), which shares the fixed database `buku_drift_check` with two other
    worktrees' suites running at the same time; re-run alone once they finished: `Test Files  1 passed (1)`, `Tests  3 passed (3)`.
  - `npm run build`: exit 0 (Next.js 16.3.6, compiled and type-checked).
- Driver, after the merge with Persetujuan kedua and Instruksi kantor:
  - **Task gate (all three cycles merged, `40d4f74`):** `npm run lint` exit 0, `npm run typecheck` exit 0, `npm test` on a fresh
    `buku_test`: "Test Files 326 passed (326) · Tests 2997 passed (2997)".
  - **Full gate:** `npm run build` exit 0; `npm run demo:reset`; `npm run verify:books` → "ALL PASS — 1765 pemeriksaan saldo cocok dengan
    ground truth"; `npm run test:e2e` (stack on :3200) on `7c3b553`: 127 passed, 3 failed. All three were test faults, not product bugs:
    - `instruksi-kantor`: `name: "Matikan"` also matched the "2 dimatikan" toggle (fixed in `3ab4a07`, exact match);
    - `usulan-akrual` (both tests): the setup expected PLN and Telkom in Review, but Buku's built-in rules post them to 6130 at import
      (fixed in `1121246`).
    On `1121246` the three batch-3 specs re-run: **6 passed (6)** (`instruksi-kantor` 3, `persetujuan-kedua` 1, `usulan-akrual` 2).
  - **Acceptance criteria → tests:** each criterion names the unit, DB or e2e test that asserts it; those suites pass in full above, and
    390 px is asserted in every new e2e spec.
  - **Walk (local production build on :3200, demo admin, freshly seeded), at 1440 and 390 px:** Pengaturan kantor *Umum* (the
    *Persetujuan kedua* card, all off, with the one-admin notice) and *Instruksi* (editor, empty list), CV Sinar's Kotak August, Jurnal
    Penyesuaian and Tutup Buku. No error, and the scroll width equals the viewport on every page.

Verified locally — 1121246

## Ship Notes
- Migration `20261018140000_accrual_proposals`: `ALTER TYPE "ProposalSource" ADD VALUE 'ACCRUAL'` only — additive, no backfill.
- Migration `20261018160000_accrual_second_approval` (after Persetujuan kedua's): `JournalApproval.accrualKey` (nullable), the source
  CHECK extended for it, a partial unique index of one PENDING request per proposal — additive, no backfill.
- No env var, no dependency, no AI call. Numbers move only when an accountant approves an accrual.
- The `e2e` label applies (Kotak, Jurnal Penyesuaian, Tutup Buku flows).
- Deck review at ship: `kantor.html` slide 10 *Penyesuaian* (accruals proposed from each vendor's history) and slide 07 *Review*
  (Kotak names *Usulan akrual*).
- Post-merge: production `/login` form, the migrations line in the build log, Beranda shows the real firm; a real client's Kotak
  August shows *Usulan akrual* only where a vendor recurs and is missing.
- Rollback: revert the merge; the enum value stays (unused) and stored ACCRUAL proposals stay as history of posted entries.
