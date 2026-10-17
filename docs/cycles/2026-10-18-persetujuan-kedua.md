# Persetujuan kedua: a second approver for large journals and for reopening a month

**Roadmap:** Phase 3 item 2. `docs/roadmap.md` §5, Phase 3: "**Second approver** for manual journals and for reopening a month, routed
by source (manual, AI draft, import) and amount." §3's benchmark row *Journal approval*: Rillet has "approval routing by source and
amount"; Buku: "accountant approves AI drafts; manual journals have no second approver" → **Gap**. Rillet's close also has "admin-only
reopen", which Buku has with one admin.

**Approval:** the owner approved building [Instruksi kantor](2026-10-18-instruksi-kantor.md), [Usulan akrual](2026-10-18-usulan-akrual.md) and [Persetujuan kedua](2026-10-18-persetujuan-kedua.md) on 2026-10-17 ("Build all three"). Open questions settled: with one active admin the step runs as today and Riwayat says it went without a second approver (owner's choice); Pemilik and Admin count as one tier; a non-Rupiah company routes every journal; `postedById` is the approver with the maker on the request; a month can't lock while a journal waits.

## Context
How a journal reaches the ledger today, read from the code:
- **One writer.** Every journal goes through `postJournal()`: balanced, open period, the client's chart (accounting-rules 2). A posted
  entry never changes; it is corrected by a new one (rule 3).
- **Manual journals.** *Jurnal Penyesuaian* posts one `ADJUSTMENT` on *Simpan jurnal*, by any member with `books.write` (Pemilik,
  Admin, Akuntan) on a client they hold.
  - *Balik otomatis pada 1 <bulan berikutnya>* posts the mirror on the 1st of the next month in the same transaction. A closed next
    month refuses both.
  - *Salin* only prefills the form from an earlier journal. The save is the same *Simpan jurnal*.
  - *Balik jurnal* on a posted manual adjustment posts its mirror on a date the accountant picks (rule 3a). It is also one click by one
    person.
  - Nobody else sees a manual journal before it is in Jurnal Umum, the trial balance and every report. A Rp 2 bn accrual by a new junior
    posts exactly like a Rp 50.000 one.
- **AI drafts.** *Jelaskan* on Tutup Buku may store a draft journal (`ProposedEntry`, source `AI_CONTROL`). It waits in Kotak
  persetujuan (*Draf jurnal*) and on Tutup Buku's *Usulan jurnal koreksi*. One click by the accountant posts it (rule 20b, invariant 4):
  - The click re-checks freshness (snapshot) and grounding (every amount is a cited row) inside one serializable transaction.
  - A draft that moves one bank line posts through the reviewer's writer (RECLASS + Memory).
  - So "AI never auto-posts" holds, but the approval is one person's, whatever the amount.
  - The 1999 corrections (`SUSPENSE`) share the table but are deterministic. They are not AI drafts.
- **Imports.** Since [Otomasi](2026-10-17-otomasi.md), a firm can send every imported line above *Batas nominal* (or from a switched-off
  source) to Review. That is the "import" route by amount: a person looks before it is accepted. The accept is one person's, as for
  every Review line.
- **Reopening a month.** `unlockPeriod`: OWNER/ADMIN only (`period.unlock`), a reason of at least 5 characters, reverse order, one
  `PeriodUnlockLog` row, and the month's sign-offs deleted, all in one transaction. One admin decides alone. Tutup Buku lists the last
  five reopenings ("Riwayat buka kembali").
- **Who ranks whom.** `ROLE_RANK` (OWNER 3 > ADMIN 2 > AKUNTAN 1 > VIEWER 0) and the "no self-review" rule already exist for the
  checklist's *Pereviu* ([Checklist tutup buku](2026-10-17-checklist-tutup-buku.md)). The reviewer there is chosen in advance per task.
- **Firm settings.** *Otomasi* is the first card a firm's admins save (`org.settings`) on Pengaturan kantor → *Umum*. Each change is one
  event in every client's Riwayat perubahan.

Who feels it:
- **The partner** who signs the report: a large adjustment or AI correction now reaches the numbers without a second pair of eyes, and
  so does a reopened month.
- **The junior accountant**, who wants a reviewer on a big accrual rather than carrying it alone.
- **The client or bank reading the report**: "every number traceable" becomes "and every large manual number approved by a second
  person".
- **The pilot.** Four-eyes on manual journals is a standard audit ask (segregation of duties). The benchmark row is a declared Gap.

## Decisions
- **One firm card, *Persetujuan kedua*, off by default.**
  - Three switches, each off by default:
    - *Jurnal manual*, with *di atas Rp*;
    - *Draf AI*, with *di atas Rp*;
    - *Buka kembali bulan*.
  - Each threshold is whole Rupiah. Empty = every journal of that source.
  - New `Firm` columns. Their defaults equal today: nothing is routed. Every existing firm, the demo and every new trial behave exactly
    as now, with no backfill.
  - Per firm, not per client, like Otomasi.
- **What is routed, by source:**
  - **Jurnal manual:** *Jurnal Penyesuaian*, with or without *Balik otomatis* (one approval covers the journal and its reversal), so also
    a *Salin* save; and *Balik jurnal*, because a reversal undoes an entry and would otherwise let one person reverse an approved
    journal.
  - **Draf AI:** a `ProposedEntry` with source `AI_CONTROL`, both the free journal and the one-bank-line reclass.
  - **Import:** stays with Otomasi's *Batas nominal* (Review). A second approver on Review accepts is a non-goal here (see Non-goals).
  - **Not routed:** the deterministic writers, which post what a register or schedule the accountant set up computes:
    - schedule instalments, assets, leases, benefits, CKPN, stock count;
    - tax postings, revaluation, invoices, Saldo Awal and Temuan;
    - the ledger import and the 1999 corrections.
- **The routed amount and the boundary.**
  - The amount is the journal's Σdebit in the company's functional currency. For *Balik jurnal* that is the original's Σdebit. For a
    draft it is the draft lines' Σdebit.
  - A journal waits when the amount is **strictly above** the threshold. Equal posts, as Otomasi's cap.
  - **Rupiah only.** A threshold is never compared with another currency's minor units without a rate (rule 3, Otomasi precedent). A
    company kept in another currency therefore routes **every** journal of a switched-on source, and the card says so.
- **A waiting journal is a request, never a ledger entry.**
  - Above the threshold, the form's save creates one `JournalApproval` row, status `PENDING`. It holds:
    - company, date, memo, reversal tick, routed amount and the threshold in force;
    - the lines, as account code + minor-unit strings + note (a draft's chosen accounts; *Balik jurnal*'s entry);
    - the maker and the maker's role at that moment.
  - No `JournalEntry` or `JournalLine` is written. The trial balance, every report, Jurnal Umum, Buku Besar and the controls read the
    same as before the save.
  - **On approval,** the posting goes through the very writer the maker's click would have used: the adjustment writer, the reversal
    writer, or `postProposal` for a draft. All of them call `postJournal()`, which **stays the only writer** (invariant 2). Every check
    runs again at that moment:
    - open month, and a closed next month for *Balik otomatis*;
    - accounts still in the chart;
    - not already reversed;
    - for a draft, the snapshot and grounding re-checks.
  - The status change to `APPROVED` (with `entryId`) and the posting are **one transaction**. A second click, or a concurrent reject,
    finds the row decided and changes nothing.
  - A refused approval (for example "Buku berubah sejak draf ini dibuat") leaves the row `PENDING` with the refusal shown. The approver
    then rejects it.
  - **Attribution.** The entry's `postedById` is the approver: the click that wrote it. The approval row keeps the maker. Jurnal Umum's
    drawer reads "Diajukan <maker> · Disetujui <approver>".
- **Who may approve: a different member, rank ≥ the maker's.**
  - The approver needs `books.write` on the client (active, and holding the client unless an admin), and is **never the maker**. That
    includes an admin's own journal.
  - The approver's role must rank at least the maker's role at the time it was submitted:
    - Akuntan's journal → Akuntan, Admin or Pemilik;
    - Admin's or Pemilik's journal → Admin or Pemilik.
    - For approval, Admin and Pemilik are **one tier** (*admin kantor*), the tier that may reopen a month. Under the checklist's strict
      rank, a Pemilik's journal would need a second Pemilik, which most firms don't have.
  - Peninjau never approves.
  - **Reject:** the same people who may approve, with a note of at least 5 characters, shown to the maker.
  - **Tarik kembali:** the maker only, while pending.
  - Nobody edits a pending journal. The maker withdraws and enters it again.
- **AI drafts: the accountant's click is the first approval.**
  - Above the threshold, *Catat jurnal* on a draft stores the chosen accounts in a `JournalApproval` (source `AI_DRAFT`). The
    `ProposedEntry` stays `PROPOSED` but leaves *Draf jurnal*: it shows under the new kind instead, never twice.
  - While the approval is pending, a direct *Catat jurnal* or *Abaikan* on the draft is refused ("Draf ini menunggu persetujuan").
  - Approval runs `postProposal` with those accounts, so the proposal becomes `POSTED` with `decidedById` = the approver.
  - A rejection puts the draft back in *Draf jurnal* with "Ditolak <nama>: <catatan>". The accountant may change accounts and submit
    again, or *Abaikan* it.
- **Pending journals in Kotak persetujuan, as a new kind first in the list: *Persetujuan kedua*** (`?jenis=kedua`).
  - Included: each pending journal dated on or before the month end (a draft by its period), oldest first, with "bulan lalu" on
    earlier months. This is Review's "through the month end", so an old request never hides.
  - The firm board's *Persetujuan* cell counts them, because it is the same `approvalCounts`.
  - The checklist's Otomatis *Review transaksi dan usulan* proof counts them too: a month isn't reviewed while a journal waits.
- **A month can't be locked while a journal in it waits.**
  - `lockPeriod` refuses while a pending journal is dated in that month, or has its *Balik otomatis* reversal there: "Belum bisa
    tutup buku: 2 jurnal menunggu persetujuan kedua."
  - *Tutup bulan-bulan sebelumnya* goes through the same `lockPeriod`.
  - Otherwise the request could never be approved and the maker's intent would be lost silently. The rule is stricter only, and with
    the default (nothing pending) the lock is unchanged.
- **Reopening a month with *Buka kembali bulan* on: one admin requests, another confirms.**
  - *Buka kembali periode* becomes *Minta buka kembali*. The same dialog and reason (≥ 5 characters) create a `ReopenRequest`
    (`PENDING`). It is checked like an unlock: the month is locked, and no later month is locked. The month **stays locked**.
  - **Confirm.** Another active Pemilik or Admin confirms (*Konfirmasi buka kembali*). The confirm runs today's `unlockPeriod`, in the
    same transaction as the request's status change, under the client lock: reverse order re-checked, sign-offs deleted.
    `PeriodUnlockLog` keeps the requester's reason, `unlockedById` = the confirmer, and a new `requestedById` = the requester.
  - **Reject or cancel.** Another admin may *Tolak* (note ≥ 5 characters). The requester may *Batalkan*.
  - **One pending request per client-month.**
  - **Where it shows.** On that month's Tutup Buku (a panel naming who asked and why), and in Kotak persetujuan under *Persetujuan kedua*
    for any month up to the one in scope. It shows there even when the scoped month is closed: the reopen card is the one card a closed
    month's queue can act on. The firm board counts it. The checklist proof does not, because a reopen of July is not August's review
    work.
  - **Setting off.** With *Buka kembali bulan* off, reopening is exactly today's. A direct unlock also closes any pending request for
    that month as cancelled ("dibuka langsung").
- **Fallback when no second person exists: the action runs as today, and says so.**
  - A one-admin firm can't have a second admin, so:
    - **Reopen.** When the firm has only one active Pemilik/Admin, the reopen happens at once, as today. The log and Riwayat say
      "Dibuka tanpa konfirmasi kedua: hanya satu admin aktif".
    - **Journals.** When no other active member may approve this maker's journal (in practice: the only admin-tier member's own
      journal), it posts at once. The Riwayat event says "Dicatat tanpa persetujuan kedua: tidak ada anggota lain yang berhak menyetujui".
      An Akuntan always has an approver, since every organisation keeps an active Pemilik.
  - The card warns while the setting is on and the firm has a single admin.
  - The alternative, refusing, would lock a one-partner firm out of its own books, or out of reopening.
- **Changes apply to new journals and requests only.** Turning a switch on never pulls back a posted entry. Turning it off never posts
  what waits: pending rows are still decided in Kotak. The card says so.
- **Permissions, stated explicitly.** One guard per action, as every action today, plus the domain rules above. **No change to the
  permission matrix** (no new capability):
  - **Save the card:** `org.settings` (Pemilik, Admin). Akuntan and Peninjau see it read-only.
  - **Submit a journal or a draft:** `books.write` on the client, as today.
  - **Approve or reject a journal:** `books.write` on the client, not the maker, and tier ≥ the maker's.
  - **Withdraw:** `books.write`, and only the maker.
  - **Request, confirm or reject a reopen:** `period.unlock`. Confirm and reject also need not being the requester.
  - **Cancel a reopen request:** `period.unlock`, and only the requester.
  - **See pending journals and requests:** `books.read`. Peninjau sees them without buttons.
  - Every write is refused while the organisation is read-only or in a support session, as today.
- **Every step is in Riwayat perubahan:** a new `AuditKind` `APPROVAL`, label "Persetujuan kedua", written in the same transaction as
  the step.
  - **Journal events:** diajukan, disetujui (with the entry), ditolak (with the note), ditarik, and the fallback "tanpa persetujuan
    kedua".
  - **Reopen events:** diminta (with the reason), dikonfirmasi, ditolak, dibatalkan, and the fallback.
  - **A card save** that changes something writes one event per client of the firm, as Otomasi does, with a one-line diff:
    "Jurnal manual: tanpa persetujuan → di atas Rp 100.000.000".
  - Amounts in before/after are strings.
  - A journal posted directly under the threshold writes no event, as today.

## Acceptance criteria
- [ ] With default settings, *Simpan jurnal*, *Balik jurnal*, a draft's *Catat jurnal* and *Buka kembali periode* behave exactly as
      today, and no `JournalApproval` or `ReopenRequest` row is written. The demo seeds identically, `verify:books` is ALL PASS, and the
      investor walk and every existing e2e pass unchanged. *(DB: `tests/db/second-approval.test.ts` "defaults change nothing"; the
      existing `adjustment`, `reverse-entry`, `proposals`, `period-lock` tests green unchanged; full gate.)*
- [ ] With *Jurnal manual* above Rp 100.000.000:
      - a Rp 150.000.000 journal is saved as *Menunggu persetujuan*, with no journal entry; the trial balance and Jurnal Umum are
        unchanged;
      - a Rp 100.000.000 journal posts at once.
      *(Unit: `tests/unit/second-approval.test.ts` routing boundary; DB: `second-approval` submit.)*
- [ ] Approving it, as another eligible member, posts exactly the stored lines and notes through the adjustment writer.
      - With *Balik otomatis*, it posts the reversal too.
      - The entry's `postedById` is the approver, and the approval row reads `APPROVED` with the entry.
      *(DB: `second-approval` approve, deep-equal lines.)*
- [ ] Self-approval is refused, for an admin too. An Akuntan can't approve an Admin's or Pemilik's journal. An Admin can approve a
      Pemilik's. Peninjau is refused. Each refusal is a Bahasa sentence and nothing is written. *(Unit: approver rule matrix; DB:
      `second-approval` refusals through the actions.)*
- [ ] *Tolak* needs a note (≥ 5 characters) and leaves no entry. *Tarik kembali* is the maker's only. A double approve, or an approve
      racing a reject, decides once. *(DB: `second-approval` reject, withdraw, concurrency.)*
- [ ] An approval the writer refuses (the *Balik otomatis* month closed meanwhile; a stale AI draft) leaves the row pending with the
      reason. *(DB: `second-approval` refused approvals.)*
- [ ] *Balik jurnal* above the threshold waits. A second reversal request of the same entry is refused while one is pending.
      *(DB: `second-approval` reversal.)*
- [ ] With *Draf AI* above Rp 50.000.000, *Catat jurnal* on a larger draft waits:
      - the draft leaves *Draf jurnal* and is refused for a direct post or dismiss;
      - approval posts it through `postProposal` (`POSTED`, decided by the approver);
      - a rejection returns it to *Draf jurnal* with the note.
      *(DB: `second-approval` AI draft, MockProvider only.)*
- [ ] Kotak persetujuan shows *Persetujuan kedua* first, with source, company, lines, total, maker and why it waits, and buttons only
      for eligible members. The firm board's *Persetujuan* count equals the page. The checklist proof counts pending journals but not
      reopen requests. *(DB: `tests/db/approvals.test.ts` queue = counts; e2e.)*
- [ ] Locking a month with a pending journal dated in it, or its reversal, is refused with the count. After approval or rejection it
      locks. *(DB: `tests/db/period-lock.test.ts`.)*
- [ ] With *Buka kembali bulan* on and two admins:
      - a request leaves the month locked;
      - another admin's confirmation opens it, deletes its sign-offs, and writes `PeriodUnlockLog` with requester, confirmer and
        reason;
      - the requester can't confirm;
      - an Akuntan is refused;
      - there is one pending request per month;
      - reject and cancel work.
      With one admin, the request opens at once and says so. With the setting off, reopening is today's, and a direct unlock cancels a
      pending request. *(DB: `period-lock` reopen cases.)*
- [ ] Pemilik and Admin save the card. Akuntan and Peninjau see it read-only, and the action refuses them with "Hanya admin kantor yang
      dapat mengubah ini.". Invalid amounts are refused with a field message and nothing is saved. *(DB:
      `tests/db/settings-actions.test.ts`; `firm-automation`-style save test.)*
- [ ] Every request, approval, rejection, withdrawal, reopen step, fallback and card change writes one "Persetujuan kedua" event to the
      right client's Riwayat. *(DB: `second-approval`, `period-lock`, save test.)*
- [ ] Every new exported action calls `requireCapability`. *(Unit: `tests/unit/action-guards.test.ts`, unchanged, covers them.)*
- [ ] Deleting a client removes its approval and reopen rows. *(DB: `tests/db/delete-client.test.ts`.)*
- [ ] Works at 390 px without sideways page scroll. *(e2e.)*
- [ ] Deck claims to review in ship:
      - `kantor.html`: "Membuka kembali hanya admin, dengan alasan tercatat." gains "dan, bila kantor memilih, dikonfirmasi admin
        kedua". The Beranda slide's "usulan yang menunggu persetujuan" stays true.
      - `perusahaan.html`: "Membuka kembali tercatat. Hanya admin, dengan alasan yang disimpan." is checked the same way.
      - `docs/roadmap.md` §3: the *Journal approval* row moves from Gap to Par.
      - `docs/demo/investor-demo.md` is unchanged (defaults).

## Verify flows
1. **Admin, Pengaturan kantor → *Persetujuan kedua*.** Turn on *Jurnal manual* above Rp 100.000.000, *Draf AI* above Rp 50.000.000 and
   *Buka kembali bulan*, then *Simpan*. Expected:
   - the toast confirms, and the card shows "Terakhir diubah … oleh …";
   - a client's Riwayat shows the diff;
   - Jurnal Umum is unchanged.
2. **Akuntan, a QA client of its own, Jurnal Penyesuaian July.** Save a Rp 150.000.000 accrual with *Balik otomatis*. Expected:
   - the form says it waits, and *Terakhir dicatat* lists it as *Menunggu persetujuan*;
   - the trial balance is unchanged, and Kotak shows it under *Persetujuan kedua* with no buttons for the maker except *Tarik kembali*;
   - as Admin, *Setujui & catat*: Jurnal Umum shows the entry and its 1 August reversal, with "Diajukan … · Disetujui …", and Riwayat
     has both events;
   - a Rp 100.000.000 journal posts at once.
3. **Admin A and Admin B, Tutup Buku of a closed month.** A asks *Minta buka kembali* with a reason, and the month stays closed. B sees
   the panel on Tutup Buku and in Kotak, and confirms: the month opens, and *Riwayat buka kembali* names both.
4. **Edge.** Try to lock July while a journal waits: refused with the count. As the Akuntan, a crafted approve of the Admin's own
   journal is refused. Turning *Jurnal manual* off doesn't post the waiting one.
5. **Error.** *Tolak* with an empty note → field message and nothing changes. An approval whose *Balik otomatis* month was closed
   meanwhile → the refusal shows, and the row stays pending until rejected. The card with "abc" or 0 as threshold → "Isi nominal
   Rupiah lebih dari 0, atau kosongkan.".

## UX notes
- **Place.** Pengaturan kantor, tab *Umum*, right after *Otomasi*: Otomasi decides what may skip you, *Persetujuan kedua* decides what
  needs two of you.
  - Card title *Persetujuan kedua*. Description: "Jurnal besar dan pembukaan kembali bulan perlu disetujui anggota lain sebelum
    mengubah buku."
- **Rows** (the Checkbox the Otomasi card uses, never wrapped in a label), each with a muted hint and, for journals, a Rupiah input
  "di atas" with placeholder "Semua nominal":
  - *Jurnal manual* ("Jurnal Penyesuaian dan Balik jurnal");
  - *Draf AI* ("draf jurnal dari Jelaskan di Tutup Buku");
  - *Buka kembali bulan* ("satu admin meminta dengan alasan, admin lain mengonfirmasi").
- **Footer.** Muted lines:
  - "Penyetuju: anggota lain yang memegang klien, berperan setara atau lebih tinggi dari pembuatnya; Admin dan Pemilik saling
    menyetujui. Tidak ada yang menyetujui jurnalnya sendiri."
  - "Perusahaan berbuku selain Rupiah: semua jurnal sumber ini perlu persetujuan."
  - "Berlaku untuk jurnal dan permintaan berikutnya."
  - With one admin: "Kantor ini baru punya satu admin aktif, jadi jurnal admin dan pembukaan kembali berjalan tanpa persetujuan kedua
    sampai ada admin kedua."
  - *Simpan* (outline, as Otomasi), disabled until something changes.
  - Read-only for Akuntan and Peninjau, with "Diatur oleh admin kantor."
- **Jurnal Penyesuaian.** Above the threshold, a muted line under the totals: "Di atas Rp 100.000.000: jurnal ini menunggu persetujuan
  anggota lain sebelum dicatat." The button reads *Ajukan persetujuan* instead of *Simpan jurnal*. Toast: "Jurnal menunggu persetujuan".
  *Terakhir dicatat* lists waiting journals first, with a *Menunggu persetujuan* pill (StatusPill, review colour) and the link to Kotak.
  *Balik jurnal*'s dialog and a draft's *Catat jurnal* show the same line and button.
- **Kotak persetujuan, *Persetujuan kedua*.** One divided row per request (no card per row):
  - a source badge (*Jurnal manual*, *Balik jurnal*, *Draf AI*, *Buka kembali*), company, date, memo, lines (account, debit,
    credit), total;
  - "Diajukan <nama> · <waktu>" and why it waits ("di atas Rp 100.000.000");
  - for an eligible member: *Setujui & catat* (primary) and *Tolak* (outline, a dialog with *Alasan menolak*);
  - for the maker: *Tarik kembali* (ghost);
  - for the others, muted: "Menunggu Akuntan lain, Admin atau Pemilik".
- **Tutup Buku.**
  - A pending request is a `NextStep`-style panel: "<nama> meminta membuka kembali Juli 2026: '<alasan>'". Another admin sees
    *Konfirmasi buka kembali* / *Tolak*; the requester sees *Batalkan permintaan*.
  - With a pending journal, the lock button's refusal names the count and links to Kotak.
- **Copy.** Every label is Bahasa, with no "approval workflow", "maker" or "checker". *Pereviu* stays the checklist's word; here it is
  *penyetuju* / *Setujui*, as Kotak already says.

## Test seams
- **Unit:** `tests/unit/second-approval.test.ts`, the pure rules in one module.
  - Routing (source × amount × currency × settings):
    - off routes nothing;
    - empty threshold routes all;
    - equal posts, above waits;
    - non-Rupiah routes all.
  - The approver rule:
    - self refused;
    - tier matrix over the 4 × 4 roles, with Admin/Pemilik as one tier;
    - Peninjau refused.
  - The fallback test (no eligible approver; one admin), the reopen confirm rule, and the summary texts.
- **DB:** `tests/db/second-approval.test.ts`.
  - Defaults change nothing (the existing writers' outcomes deep-equal).
  - Submit, approve (lines, reversal, `postedById`), reject, withdraw, concurrency.
  - Refused approvals stay pending, and the AI draft path (MockProvider).
  - *Balik jurnal* and the duplicate reversal request.
  - Fallback, Riwayat events, and a pending row is not in the TB.
- **DB:** extend the existing suites.
  - `tests/db/period-lock.test.ts`: the lock refusal, and every reopen case.
  - `tests/db/approvals.test.ts`: the new kind, queue = counts, the checklist proof.
  - `tests/db/settings-actions.test.ts`: the card save, refusals, validation, events.
  - `tests/db/delete-client.test.ts`: the new tables.
- **E2E:** `e2e/persetujuan-kedua.spec.ts`, on e2e-setup's second organisation (*KAP Uji Lain*). `scripts/e2e-setup.ts` gives it a
  second Admin and an Akuntan, so the demo firm's settings never change under parallel specs.
  - Flows 1–5, with every setting restored in `finally`.
  - 390 px on the card, Kotak and Tutup Buku.

## Non-goals
- **A second approver on Review accepts and on the ledger import.** Otomasi's *Batas nominal* already routes large imported lines to a
  person. A second person on that accept is a follow-up, if the pilot asks.
- **Routing the deterministic writers:** schedules, registers, tax, revaluation, invoices, Saldo Awal, Temuan and the 1999 corrections.
- Multi-level chains (two approvers, amount bands), named approvers per client, and delegation.
- Notifications (email or push), editing a pending journal, and *Salin* from a pending one.
- A per-client setting.
- Making `AuditEvent.clientId` optional, and a firm-wide Riwayat page.

## Assumptions
- **Maker's role is fixed at submission.** A later promotion or demotion doesn't change who may approve that request. The approver's
  role is read at the click.
- **Approving posts on the approver's click, at the stored date.** A journal approved after its month was reopened and changed is
  re-checked by the writer like any post. It is not re-checked for meaning: that is the approver's job.
- **The fallback can be engineered** by disabling the other admins. Disabling a member is itself `members.manage`, and the Riwayat event
  names the fallback. That is accepted for a trial-stage product.
- **Pending rows stay after the setting is turned off**, and are decided in Kotak. Nothing expires them.
- **No ADR.** The change is reversible (switch it off) and follows the roadmap item. Accounting-rules carries the rule text.
- **Open for the owner** (the recommended answer is the one written above):
  1. **Admin and Pemilik as one tier for approval.** The recommendation is yes. The alternative is the checklist's strict rank, so a
     Pemilik's journal needs another Pemilik, else the fallback.
  2. **Fallback when no second person exists.** The recommendation is to run as today and log it. The alternative is to refuse, and the
     card refuses to turn on without two admins. That locks out a one-partner firm.
  3. **Non-Rupiah companies.** The recommendation is to route every journal of a switched-on source. The alternative is to route none of
     them.
  4. **`postedById` = the approver**, with the maker on the approval row. The alternative is the maker, with the approver on the row.
  5. **The lock waits for pending journals.** The recommendation is yes. The alternative is that locking rejects them automatically.

## Gate re-openers
- **Migration (planned, additive, defaults = today, no backfill):**
  - `Firm`: five columns:
    - `approvalManual` and `approvalAiDraft`, boolean, default false;
    - `approvalManualAbove` and `approvalAiDraftAbove`, bigint Rupiah, nullable, CHECK > 0;
    - `approvalReopen`, boolean, default false.
  - New enums: `JournalApprovalSource` (MANUAL, REVERSAL, AI_DRAFT) and `ApprovalStatus` (PENDING, APPROVED, REJECTED, WITHDRAWN).
  - New table `JournalApproval`:
    - firm, client and entity;
    - source, status, date, memo, lines JSON, reversal tick;
    - `reversesId?`, `proposalId?`, chosen accounts;
    - amount (CHECK > 0) and threshold;
    - maker, maker's role, decider, note and timestamps;
    - `entryId?` unique → `JournalEntry`, Restrict.
    - CHECKs: `entryId` set iff APPROVED; a note on REJECTED; source-specific fields.
    - Partial unique indexes: one PENDING per `proposalId`, and one per `reversesId`.
  - New table `ReopenRequest`: client, year, month, status, reason, requester, decider, note. A partial unique index allows one PENDING
    per client-month.
  - `PeriodUnlockLog.requestedById`: nullable.
  - It goes under `prisma/migrations/**`, a sensitive path.
- **Permission and auth behaviour changes:**
  - `unlockAction` may now create a request instead of unlocking.
  - The journal and draft actions may now return "menunggu persetujuan" instead of posting.
  - New approve, reject, withdraw, confirm, reject-reopen and cancel actions in `app/actions.ts`; the card's save in
    `app/firm-settings-actions.ts`. Each is behind `requireCapability`, plus the domain rule.
  - The permission matrix (`lib/auth/permissions.ts`) is **unchanged**.
  - Sensitive paths touched: `app/*actions.ts`, `lib/settings/**` (the card's read, validation and save), `prisma/migrations/**`.
- **Accounting-rules text changes, stricter only, no invariant weakened:**
  - rule 3a: *Balik jurnal* may wait;
  - rule 4: reopen may need a confirming admin, with the one-admin fallback;
  - rule 20b: a large AI draft needs a second approver after the accountant's click;
  - rule 23: no lock while a journal in the month waits;
  - rule 25: the delete list.
  - A new rule states that a pending journal is a request row, never a `JournalEntry`. **`postJournal()` stays the only writer**
    (invariant 2), and the ledger never holds an unapproved routed entry. **Invariant 4 is unchanged:** AI still never posts, and a
    draft now needs one or two human clicks.
- **Reports:** no number moves with default settings (`verify:books` ALL PASS). With the setting on, a waiting journal is absent from
  every report until approved, by design.
- **None of the rest:** no dependency, no real AI call (MockProvider only), no production write.

If approving a draft needs a new `ProposalStatus` value, or attribution needs a second column on `JournalEntry`, that is beyond this
migration: stop and ask.

## Tasks
- [x] T1 Migration + schema: the `Firm` columns, `JournalApproval`, `ReopenRequest`, `PeriodUnlockLog.requestedById`. Then
      `lib/settings/approvals.ts` (read with defaults, validate, save with one `APPROVAL` event per client), the `AuditKind` +
      label, and `deleteClient`. Accept: DB tests for save, no-op, validation, events, delete. (reuse: `lib/settings/automation.ts`
      shape, `recordEvent`, `parseMoney`)
- [x] T2 The pure rules in `lib/approvals/second.ts`: routing, approver tier, fallback, reopen confirm, texts. Accept: unit tests.
      (parallel with T1)
- [x] T3 Journals:
      - submit / approve / reject / withdraw for manual journals, *Balik otomatis* and *Balik jurnal*;
      - the adjustment writer split into parse + post, so approval posts stored minor units in one transaction with the status change;
      - the AI draft path around `postProposal`;
      - the lock refusal;
      - accounting-rules 3a, 20b, 23 and the new rule.
      Accept: `second-approval` and `period-lock` DB tests; existing `adjustment`, `reverse-entry`, `proposals` unchanged. (deps: T1, T2)
- [ ] T4 Reopen: request / confirm / reject / cancel around `unlockPeriod`, the fallback, the log's requester, accounting-rules 4.
      Accept: `period-lock` reopen tests. (deps: T1, T2; parallel with T3)
- [ ] T5 Kotak *Persetujuan kedua* (queue, counts, firm board, checklist proof), the Jurnal Penyesuaian form and *Terakhir dicatat*,
      the *Balik jurnal* dialog, the draft card, the Tutup Buku panel, the Jurnal Umum drawer line, and the card on Pengaturan kantor
      with its actions; README (settings, actions). Accept: `approvals` DB test; flows 1–5 on the dev server. (deps: T3, T4; reuse:
      the `AutomationCard` layout, `StatusPill`, `NextStep`, the approval-queue rows)
- [ ] T6 verify-local:
      - `scripts/e2e-setup.ts` members and `e2e/persetujuan-kedua.spec.ts`;
      - walk flows 1–5 with screenshots at 1440 and 390 px;
      - the full gate (`demo:reset`, `verify:books` ALL PASS, the investor walk unchanged).
      (deps: T5)

## Implementation
- Plan: T1–T5 sequential, inline, by one build worker (each task builds on the previous one's schema and writers; T2 is small enough
  that a parallel worker would cost more than it saves). T6's e2e spec is written here; its Playwright run and the app walk are the driver's.
- T1: `prisma/migrations/20261018150000_second_approver`, `prisma/schema.prisma`, `lib/settings/approvals.ts`, `lib/audit.ts`,
  `lib/clients/delete.ts`, `lib/imports/remove.ts`, `app/firm-settings-actions.ts` — the five `Firm` columns (CHECK > 0), `JournalApproval`
  and `ReopenRequest` (CHECKs: amount, entry iff APPROVED, decided iff not PENDING, a note on REJECTED, source fields; partial unique
  PENDING per draft, per reversed entry, per client-month), `PeriodUnlockLog.requestedById`; the card's read/parse/save with one
  `APPROVAL` ("Persetujuan kedua") event per client; `saveApprovalsAction` behind `org.settings`; client deletion and import removal drop
  the new rows. Otomasi's threshold parser is exported (`rupiahThreshold`) and reused.
- T2: `lib/approvals/second.ts`, `tests/unit/second-approval.test.ts` — routing (off, empty threshold, equal posts / above waits,
  non-Rupiah routes all), the approver rule (never the maker; Admin and Pemilik one tier; Peninjau never), the fallback tests
  (`hasApprover`, `hasSecondAdmin`), the reopen decider rule, the wait reasons and event heads.
- T3: `lib/approvals/journals.ts`, `lib/approvals/pending.ts`, `lib/ledger/post.ts` (`checkJournal`: postJournal's checks without the
  write; postJournal itself unchanged in behaviour and still the only writer), `lib/ledger/adjustment.ts` (`prepareAdjustment` +
  `postPreparedAdjustment`), `lib/ledger/reverse.ts` (`checkReversal` + `reverseEntryTx`), `lib/adjust/proposals.ts` (`chosenAccounts`,
  `onPosted` hook, dismiss refused while waiting, Draf jurnal hides waiting drafts and shows "Ditolak …"), `lib/controls/index.ts` (lock
  refusal, checked again under the client lock), `app/actions.ts` (`adjustmentAction`, `reverseEntryAction`, `postProposalAction` route
  through the submit functions and return `pending`; new `approveJournalAction`, `rejectJournalAction`, `withdrawJournalAction`, each
  behind `requireCapability("books.write", { clientId })`), accounting-rules 2a (new), 3a, 20b, 23, 25. Submits take the client's close
  lock so a lock either sees the request or refuses it; approvals lock the row (`FOR UPDATE`) so a double click or an approve racing a
  reject decides once.

## Verification

## Ship Notes
