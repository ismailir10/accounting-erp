# Checklist tutup buku: tasks with a Pelaksana, a Pereviu and a due date, per client

**Roadmap:** Phase 3 item 1. `docs/roadmap.md` §5, Phase 3: "Close checklist per client: tasks with an owner, a reviewer (staff →
partner) and a due date, carried forward each month and rolled up on the firm board. It builds on the sign-offs that exist." §3 names
the gap against Rillet ("checklist with owners and reviewers, admin-only reopen"; Buku: "Par; **Gap**: tasks with owner, reviewer and
due date").

**Approval:** after #173 merged, the owner said to merge on green and keep going (2026-10-17, "merge on green then keep going",
"make sure you have regression test"). That covers the next roadmap cycles, built together: [BPPU files](2026-10-17-bppu-files.md), [Lihat alasan](2026-10-17-lihat-alasan.md), [Otomasi](2026-10-17-otomasi.md) and
[Checklist tutup buku](2026-10-17-checklist-tutup-buku.md). The schema and
permission changes are the ones this spec states under Gate re-openers; anything beyond them stops for the owner.

## Context
Tutup Buku already gates the month on proof (accounting-rules 22–23):
- **Controls** (PASS / REVIEW / FAIL). A FAIL blocks; a REVIEW needs a note, and the note clears it only while the control's detail is
  unchanged. Notes go to *Riwayat perubahan* (`CONTROL_NOTE`).
- **Three sign-offs** in the *Daftar periksa* card: *Bukti pendukung transaksi besar sudah diperiksa*, *Jurnal penyesuaian (penyusutan,
  akrual) sudah dicatat*, *Laporan keuangan sudah direview partner*. Each is one `CloseSignoff` row (who, when) per month, required for
  the lock.
- **The lock** goes in order (no earlier open month with entries) and re-checks under the client lock. **Reopening** is OWNER/ADMIN only
  (`period.unlock`), in reverse order, with a reason of at least 5 characters kept in `PeriodUnlockLog`. A reopened month loses its
  sign-offs, which are given again.
- *Tutup bulan-bulan sebelumnya* (admin only) closes migrated months in order and gives the sign-offs once for the run.

What is missing, read from the code:
- **Nobody owns a step and nothing is due.** A sign-off is ticked by whoever has `books.write` on the client. Any AKUNTAN can tick
  *direview partner*, and nothing records that a partner did it.
- **A sign-off leaves no trace.** `signoffAction` writes no change-log event, and unticking deletes the row. Riwayat shows notes but not
  sign-offs.
- **The firm's own steps live outside Buku.** Asking for the rekening koran by the 5th, the Pajak Masa by the 10th, sending the pack:
  none of these exist in Buku.
- **Beranda can't see lateness.** The firm board (*Papan kantor*: Sumber · Persetujuan · Tutup buku · Terkirim, as changed in
  [Kotak persetujuan](2026-10-17-kotak-persetujuan.md)) shows each client's state, but not who is late. Beranda's task list says
  "Lengkapi N pemeriksaan akhir" with no person and no date.

Who feels it:
- the partner, who can't see which staff member is late on which client;
- the staff accountant, who keeps the list in Excel or WhatsApp;
- the pilot's exit test ("from checklist to sign-off to pack to Coretax files, without leaving Buku").

Facts the design relies on:
- Roles rank OWNER > ADMIN > AKUNTAN. VIEWER only reads (`books.read`) and is labelled ***Peninjau*** in the UI (`ROLE_LABEL`, team
  page, Kotak's viewer state).
- AKUNTAN and VIEWER see only assigned clients (`ClientAccess`); OWNER and ADMIN see every client. Members are disabled, never deleted.
- Buku can already prove from the books, at read time:
  - Sumber complete: the completeness grid has no missing or broken month, as the board's *Sumber* cell shows.
  - Kotak empty: `approvalCounts` total = 0.
  - Controls of one kind PASS or noted: the `ar:` / `ap:` / `subledger:` and `masa:` / `faktur:` / `bupot:` keys.
  - Every control clear: `closeReadiness` with no fails and no unacknowledged REVIEW.
  - Month locked: `Period.status`.
  - A report out after the lock: the first `REPORT_EXPORT` for `period:YYYY-MM` after `lockedAt`, as on the board's *Terkirim*. This
    proves a download after the lock, not delivery to the client.
- The client's modules (`receivables` …) and whether a company still needs a Saldo Awal (`setupProgress`) are known per client.
- The demo seed creates no `FirmMember`. The admin comes from `demo:reset`, and the e2e members from `scripts/e2e-setup.ts`.

## Decisions
- **Its own page, *Checklist tutup buku*** (`/clients/[id]/checklist`, client menu stage 2, directly before *Tutup Buku*), scoped by
  month like Tutup Buku. The checklist is a client operation: there is no company picker.
- **A template per client, carried forward without copying.**
  - Each task is a row of the client's template: title, kind, *Pelaksana*, *Pereviu* (optional), due day (1–28), and the first month
    (and, once removed, the last month) it applies to.
  - A month's checklist is the template's tasks active in that month, joined with that month's marks. So every new month has the list
    without a write, and the template never retroactively adds tasks to months before it started.
  - Marks are sparse: a row exists only once someone ticks or reviews.
  - Template edits (title, Pelaksana, Pereviu, due day) show in every month the task covers. A mark keeps who actually ticked and who
    actually reviewed, and Riwayat keeps the assignment history.
- **Three kinds of task:**
  1. **Otomatis.** Buku ticks it from the books and says how. It is never stored and never reviewed, because the proof is the review.
     It stays live, so it unticks itself if the books change in an open month. A locked month's books are frozen, so its proof is too.
     The kinds, each with its proof line:
     - *Rekening koran dan data bulan ini lengkap*: Sumber has no gap ("Semua rekening koran Agustus 2026 lengkap").
     - *Saldo awal dicatat*: no company still needs one.
     - *Review transaksi dan usulan*: Kotak persetujuan is empty for the month.
     - *Rekonsiliasi piutang & utang*: every `ar:` / `ap:` / `subledger:` control PASS or noted.
     - *Pajak Masa diperiksa*: every `masa:` / `faktur:` / `bupot:` control PASS or noted.
     - *Kontrol tutup buku dicek*: no FAIL, every REVIEW noted.
     - *Tutup buku*: the month is locked.
     - *Laporan dikirim ke klien*: "Laporan diunduh <tanggal> setelah tutup buku". The wording says what Buku can prove.
  2. **Pemeriksaan akhir.** The three existing sign-offs are three tasks.
     - *Selesai* **is** the `CloseSignoff` row: ticking on the checklist or on Tutup Buku is the same writer.
     - The lock rule (accounting-rules 23) and *Tutup bulan-bulan sebelumnya* are unchanged.
     - A reopened month deletes its sign-offs as today, so these tasks are *Belum* again. Their old review no longer counts (see
       statuses).
  3. **Manual.** The accountant's own task, free title, ticked by its Pelaksana.
- **Statuses: *Belum · Selesai · Direviu*.**
  - Selesai records who and when. Direviu records who and when, and only after Selesai.
  - A review counts only while the task is Selesai and the review is later than the tick, so untick + retick asks for review again.
  - A task is **finished** when it is Direviu (with a Pereviu), Selesai (without one), or proven (Otomatis).
- **The reviewer is called *Pereviu*, not *Peninjau*.** *Peninjau* is already the VIEWER role's label, and a viewer can't review: two
  meanings for one word on the team page and the checklist would confuse.
  - *Pereviu / Direviu* follows KBBI *reviu* and the existing copy ("direview partner").
  - If the owner prefers *Peninjau / Ditinjau*, the VIEWER label changes first (team page, Kotak, deck).
- **Buku proposes the first list; it never creates it on its own.** With no template, the page shows the default derived from what the
  client uses, each line with its reason, and *Pakai daftar ini* creates it. The default is:
  - *Minta rekening koran dan data*, Otomatis Sumber, tanggal 5;
  - *Saldo awal dicatat*, only while a company still needs one;
  - *Review transaksi dan usulan*, tanggal 8;
  - *Rekonsiliasi piutang & utang*, only when the Piutang & Utang module shows;
  - *Pajak Masa diperiksa*, only when the month has a `masa:` control, tanggal 10;
  - *Kontrol tutup buku dicek*;
  - the three *Pemeriksaan akhir* (review partner: tanggal 12);
  - *Tutup buku* (tanggal 15) and *Laporan dikirim ke klien* (tanggal 15).

  The rest of the list is due on tanggal 10. In the accept dialog, one Pelaksana (default: me) and one Pereviu (default: none) apply to
  every task, and each task can be changed afterwards. Otomatis tasks left out can be added later from the same list.
- **Due day = a day of the month after the period** (tanggal 10 for Agustus = 10 September 2026), capped at 28. It is compared with
  today in WIB.
  - **Lewat tenggat** = the due date has passed and the task isn't finished. The row names who it waits on: the Pelaksana before
    Selesai, the Pereviu after.
- **Permissions, stated explicitly** (one guard per action, as every action today, plus the domain rules below):
  - **See the checklist:** `books.read` on the client. VIEWER sees it read-only, without buttons.
  - **Set up the checklist** (accept the default; add an Otomatis task; rename, reassign, change a due day, remove): OWNER/ADMIN only,
    through a new capability `checklist.manage` (ADMINS). Assigning who reviews whom is the partner's decision, as Rillet's admins
    configure checklists.
  - **Add a task of one's own:** any member with `books.write` on the client may add a Manual task with themselves as Pelaksana. They
    may pick a Pereviu under the same rule.
  - **Who can be assigned:** Pelaksana and Pereviu must be active members who can open the client and hold `books.write` (OWNER, ADMIN,
    or an AKUNTAN assigned to it).
    - The Pereviu's role must rank equal to or higher than the Pelaksana's (AKUNTAN → AKUNTAN, AKUNTAN → ADMIN/OWNER, ADMIN →
      ADMIN/OWNER), and must be a different person.
    - Both are checked when assigning and again on every tick, because roles and assignments change.
    - A task whose member was disabled or unassigned says so ("Pelaksana tidak lagi memegang klien ini") and waits for an admin to
      reassign it.
  - **Tick / untick Selesai:** the task's Pelaksana, or an OWNER/ADMIN covering for them. Untick is allowed only while not Direviu.
  - **Mark / undo Direviu:** the task's Pereviu, or an OWNER/ADMIN whose role ranks at least the Pelaksana's.
    - Never the member who ticked Selesai: no self-review, even for an admin.
    - With no Pereviu set, there is no review step.
  - **Pemeriksaan akhir follow the same rules from both pages** once the client has a checklist. On Tutup Buku a member who may not tick
    sees the checkbox disabled, with the reason. A client without a checklist keeps today's behaviour (any writer ticks).
  - **Locked months:**
    - Manual ticks and every review stay open after the lock, because work continues after the books close (the pack, a Coretax
      upload). These are not book writes.
    - Pemeriksaan akhir can't be ticked or unticked in a locked month, as today.
    - Template changes apply only from the month on screen, which must be open.
  - Support sessions and read-only organisations write nothing (the existing guard).
- **The lock warns; it does not block.** Tutup Buku shows "N tugas checklist belum selesai" under the blockers as a muted line, not a
  blocker, links to the checklist, and repeats it in the lock dialog. *Tutup buku* and *Laporan dikirim* are left out of that count
  because they can't be done before the lock. Reasons:
  - Controls and the sign-offs already gate the lock (rule 23). The one sign-off that matters (*direview partner*) now has an owner and
    can have a reviewer.
  - A blocking checklist would push staff to tick tasks to get the lock, which corrupts the record the checklist exists to keep.
  - Firm tasks legitimately outlive the lock.
  - A one-person firm or a company organisation has no second person to review.
  - Blocking would change accounting-rules 23 and *Tutup bulan-bulan sebelumnya*. If the pilot asks for a firm-level "kunci hanya bila
    checklist direviu" switch, that is a later setting.
- **Every human tick in Riwayat.** A new change-log kind, *Checklist tutup buku* (`CHECKLIST`), covers:
  - Selesai, untick, Direviu and undo, the sign-offs included (which gain a trace they never had);
  - accepting the default;
  - every template change, with before → after: title, Pelaksana, Pereviu, due day, added, removed.

  Otomatis tasks write nothing. They are read from the books at every view, like controls. Riwayat stays append-only.
- **Rolled up on the firm board and Beranda.**
  - **Board:** a ***Checklist*** column between *Persetujuan* and *Tutup buku*, linking to the client's checklist for the board's month.
    - "3 lewat tenggat" (REVIEW) when the month or an earlier month since the template began has an overdue task.
    - Otherwise "7 / 10 selesai" (REVIEW), or "Lengkap" (PASS).
    - "Belum diatur" (muted text) without a template.
    - The read model takes the controls, completeness, Kotak count, period and *Terkirim* the board already computes, so it adds two
      small queries per client.
  - **Beranda:** one high-priority task per client with overdue tasks, "Selesaikan 3 tugas checklist lewat tenggat", detailing the
    month and who it waits on. It ranks with missing statements and late taxes, and links to the earliest month with an overdue task.
- **Remove = end, not erase.** Removing a task ends it before the month on screen. Earlier months keep it with their marks. A task that
  never applied to a month before the one on screen is deleted with its marks, and Riwayat keeps the trail.
- **No number moves.** The checklist reads the books and writes no journal.

## Acceptance criteria
- [ ] A client without a checklist shows the default list for the month, each line with its kind and reason. Rekonsiliasi piutang &
      utang appears only with the Piutang & Utang module, Pajak Masa only with a `masa:` control, Saldo awal only while a company needs
      one. An OWNER/ADMIN creates it with *Pakai daftar ini*; an AKUNTAN and a viewer see the list without that button.
- [ ] The next month shows the same tasks with fresh statuses. A month before the template's first month shows no checklist.
- [ ] Each Otomatis task ticks itself when its proof holds and shows the proof line, and unticks when the proof stops holding in an
      open month. *Laporan dikirim* reads "diunduh … setelah tutup buku".
- [ ] Ticking a Pemeriksaan akhir on the checklist ticks it on Tutup Buku, and the other way round. Unlocking a month returns them to
      *Belum* and their earlier review no longer counts.
- [ ] A Manual task goes Belum → Selesai (Pelaksana or admin) → Direviu (Pereviu or eligible admin), and each step shows who and when.
      The person who ticked can't review, a lower-ranked member can't review, and a non-Pelaksana AKUNTAN can't tick. Each refusal is a
      Bahasa message shown verbatim.
- [ ] Assigning a VIEWER, an unassigned AKUNTAN, a disabled member, or a Pereviu ranked below the Pelaksana is refused.
- [ ] A task past its due day and not finished shows *Lewat tenggat* with who it waits on. The board's *Checklist* cell and Beranda's
      task count it ("3 lewat tenggat"), and both link to the checklist.
- [ ] Tutup Buku shows the unfinished-tasks line and the lock dialog repeats it. The lock still succeeds when controls and sign-offs
      allow it.
- [ ] Every human tick, untick, review, undo and template change appears in Riwayat perubahan under *Checklist tutup buku*, with who,
      when and before → after. Otomatis tasks write nothing.
- [ ] In a locked month, Manual ticks and reviews still work, Pemeriksaan akhir are frozen, and template edits are refused.
- [ ] No number on any report changes (`verify:books` ALL PASS).
- [ ] Works at 390 px without sideways page scroll.
- [ ] Deck claims to review in ship:
      - `kantor.html` slide 04 *Papan kantor* (the board's columns);
      - `kantor.html` slide 11 *Tutup buku* ("Tiga pemeriksaan akhir, berurutan…": now tasks with a Pelaksana, a Pereviu and a due
        date);
      - `perusahaan.html` *Tutup buku* slide ("tiga pemeriksaan akhir dicentang");
      - `index.html` chooser line ("papan kemajuan semua klien…");
      - `docs/demo/investor-demo.md` (the board's columns).

## Verify flows
1. **Admin, demo client Grup Ayam Nusantara, its working month.**
   - Checklist → the default list shows; Piutang & Utang appears only if its module shows.
   - *Pakai daftar ini* with Pelaksana = the e2e AKUNTAN and Pereviu = the admin.
   - Otomatis rows show their proof (Sumber "Ada celah" until the held-back BRI file is uploaded, Kotak not empty).
   - Upload the BRI file → *Rekening koran* ticks itself.
2. **The AKUNTAN signs in.**
   - They tick a Manual task and *Bukti pendukung* → Tutup Buku's checkbox is ticked too.
   - They try to review it → refused.
   - The admin reviews → Direviu with name and time. Riwayat lists all three events.
3. **Overdue.**
   - On a QA client, set a task's due day so the date has passed (a month whose due date is behind today in WIB).
   - Beranda shows "Selesaikan 1 tugas checklist lewat tenggat" and the board's *Checklist* cell "1 lewat tenggat"; both open the
     checklist on that month.
4. **Edge:** lock the month with two tasks unreviewed → the warning shows and the lock succeeds. A Manual task can still be ticked after
   the lock; a sign-off can't. Unlock with a reason → the sign-offs are *Belum* again and their reviews no longer count.
5. **Error:** as an AKUNTAN, open *Atur checklist* → not offered. Calling the action directly → "Hanya admin kantor yang dapat mengatur
   checklist." The admin assigns a VIEWER as Pereviu → refused with the rank/role message.

## UX notes
- **Page.** PageHeader *Checklist tutup buku* with the ScopeBar (month only); description "<bulan> · tenggat di bulan berikutnya".
  - **NextStep, for the viewer of the page:**
    - "Kerjakan 2 tugas Anda: <first title>." or "Reviu 3 tugas yang menunggu Anda.";
    - else "N tugas menunggu orang lain";
    - done: "Semua tugas <bulan> selesai dan direviu.";
    - no template (admin): "Buku menyusun daftar dari yang dipakai klien ini. Periksa, lalu pakai." with CTA *Pakai daftar ini*.
- **Summary line** under the banner: "7 / 10 selesai · 2 menunggu reviu · 3 lewat tenggat", with `ProgressFill` on done / total.
- **One card, divided rows (no boxes in boxes), problems first:** Lewat tenggat, then Belum, then Selesai awaiting review. Finished
  tasks fold into "N tugas selesai" (still in the DOM). Each row has:
  - a checkbox (Manual, Pemeriksaan akhir; `id` + `htmlFor`, never wrapped in a label) or a check / empty icon (Otomatis);
  - the title;
  - an eyebrow: *Otomatis*, *Pemeriksaan akhir* or none;
  - the line "Pelaksana Rina · Pereviu Budi · Tenggat 10 Sep 2026", with "lewat 3 hari" in the review colour;
  - for Otomatis, the proof line linking to where it is fixed (Unggah, Kotak, Piutang, Pajak Masa, Tutup Buku);
  - for done steps, "Selesai Rina · 9 Sep 13.10 · Direviu Budi · 11 Sep 08.02";
  - buttons: *Tandai direviu* (outline) when the viewer may review, and *Batalkan* (ghost) to undo one's own step.
- **The one primary button:** *Pakai daftar ini* without a template. Otherwise none: ticks are checkboxes.
- ***Atur checklist*** (outline, admins): a dialog per task (title, Pelaksana and Pereviu selects of eligible members only, *Tanggal
  tenggat* 1–28) plus *Tambah tugas* and *Tambah tugas otomatis* (the kinds not in the template), and *Hapus dari checklist* with
  "Bulan sebelumnya tetap menyimpan tugas ini."
- **Locked month:** "Buku <bulan> sudah ditutup. 1 tugas masih terbuka: Laporan dikirim ke klien." Sign-off checkboxes disabled.
- **Tutup Buku:** the *Daftar periksa* card keeps its three checkboxes. Once a checklist exists, each shows "Pelaksana X" and the link
  *Buka checklist*. One muted line under the blockers: "Checklist: 2 tugas belum selesai" (not a "•" blocker).
- **Board:** column header *Checklist*; cell `StatusPill` as decided. Mobile keeps the 2-column `dl` grid (five cells).
- Copy: *Belum / Selesai / Direviu*, *Lewat tenggat*, *Pelaksana*, *Pereviu*, *Tenggat*. No "task"/"owner" in English.

## Test seams
- DB: `lib/checklist`.
  - Default proposal per client facts (module, `masa:` control, Saldo Awal).
  - The month view (start / end months, sparse marks), the Otomatis proofs from fixtures (each kind true and false), finished / overdue
    in WIB, and the review-after-tick rule.
  - Pemeriksaan akhir = `CloseSignoff`, and after `unlockPeriod`.
- DB: permission rules, each refusal.
  - Pelaksana/admin tick; Pereviu rank; no self-review; VIEWER / unassigned / disabled assignment.
  - `checklist.manage`; locked-month rules.
  - Cross-tenant: another firm's task reads as not found.
- DB: every write records one `CHECKLIST` event with before → after; `deleteClient` removes the new tables (accounting-rules 25).
- DB: the board overview's *Checklist* cell and Beranda task equal the checklist read model (`tests/db` workspace test).
- Unit: due date (day 1–28 of the next month, December → January), overdue in WIB, the rank rule, the capability matrix
  (`tests/unit` permissions), nav order (`tests/unit/nav.test.ts`).
- Unit: the guard test that every exported action calls the guard, extended to the new actions.
- E2E: `e2e/checklist.spec.ts` walks flows 1, 2 (the e2e AKUNTAN and the admin) and 4 on a QA client of its own. The investor walk is
  unchanged: it reads only the board's *Sumber* cell, and the sign-off checkboxes stay on Tutup Buku.

## Non-goals
- Blocking the lock on the checklist, or a per-firm switch for it.
- Second approver for manual journals and for reopening a month (roadmap Phase 3 item 2).
- E-mail / WhatsApp reminders and notifications; a cross-client "Tugas saya" page (Beranda's count links per client).
- Firm-level templates copied to many clients at once; user-defined Otomatis rules (Instruksi kantor, Phase 2 item 5).
- Subtasks, attachments and comments on a task (notes stay on controls).
- Seeding a checklist in the demo: the seed has no members, so the demo board shows "Belum diatur" until someone accepts the default.
- Renaming the VIEWER role.

## Assumptions
- A client's template holds a few dozen tasks at most. A client-month's marks hold the same.
- An untouched task in a locked month shows its *current* Pelaksana/Pereviu. Who actually ticked or reviewed is on the mark, and the
  assignment history is in Riwayat. No per-month snapshot is stored.
- "Higher or equal role" uses OWNER > ADMIN > AKUNTAN. Two AKUNTAN may review each other (staff peer review). The partner step is
  expressed by assigning an OWNER/ADMIN as Pereviu of *direview partner*.
- Otomatis proofs reuse the board's and Tutup Buku's existing reads. The checklist page adds no AI call and no new control.
- The due day is the same every month (no holiday calendar). Overdue is evaluated at render time in WIB.
- A company organisation (`PERUSAHAAN`) gets the same page. With one member it simply sets no Pereviu.

## Gate re-openers
- **Schema migration (additive):** an enum for the task kind and two tables, the client's template tasks and the per-month marks, with
  FKs to `FirmMember`, `firmId` on both, unique (task, year, month), and CHECKs (due day 1–28; a review only with a tick on Manual
  marks). No existing column changes. `deleteClient` gains the two tables.
- **Auth / permission change:**
  - a new capability `checklist.manage` (OWNER, ADMIN) in the permissions module;
  - new server actions in `app/actions.ts` (sensitive path), each through `requireCapability`;
  - the per-task Pelaksana / Pereviu / rank / no-self-review rules;
  - `signoffAction` gaining those rules once the client has a checklist.
- **Accounting rules:** rule 23 (the lock) is unchanged, and the spec keeps it so. Rule 25 gains the two tables. Riwayat gains a kind.
- None: no dependency, no real AI call, no production write, no number on a report changes.

If the warning must become a block, or the reviewer must become a second approver of the lock, that changes rule 23: stop and ask.

## Tasks
- [x] T1 Schema, migration and the `lib/checklist` domain: template, month view, default proposal, Otomatis proofs, statuses, due /
      overdue, permission rules, `CHECKLIST` change-log kind, `deleteClient`, `checklist.manage`. Accept: the DB and unit seams above.
      Reuse: `completenessMatrix`, `approvalCounts`, `runControls` / `closeReadiness`, `setupProgress`, `clientModules`, the board's
      *Terkirim* read, `recordEvent`, `can` / `isAdminRole`, `ROLE_LABEL`.
- [ ] T2 Server actions and the *Checklist tutup buku* page: accept default, add / edit / remove a task, tick, review, undo; the nav
      entry. Accept: flows 1, 2 and 5 on the dev server. Reuse: `loadClientPage`, `ScopeBar`, `NextStep`, `StatusPill`, `ProgressFill`,
      `Checkbox`, the access context for viewers. (deps: T1)
- [ ] T3 Tutup Buku: `signoffAction` through the checklist writer (rules + `CHECKLIST` event); the *Daftar periksa* card names the
      Pelaksana and links to the checklist; the unfinished-tasks line and the lock dialog. Accept: flow 4. (deps: T1; parallel with T2)
- [ ] T4 Firm board *Checklist* column and the Beranda overdue task from the same read model; `docs/demo/investor-demo.md` and README
      routes. Accept: flow 3; board = page (DB test). (deps: T1; parallel with T2/T3)
- [ ] T5 verify-local: walk flows 1–5 with screenshots at 1440 and 390 px; `e2e/checklist.spec.ts`; the full gate (`verify:books` ALL
      PASS). (deps: T2–T4)

## Implementation
- Plan: T1 → T2 → T3 → T4 sequential, inline in one worker (they share the `lib/checklist` read model, `app/actions.ts` and the close
  page; a fan-out would cost more than it saves). T5: the e2e spec and docs here; verify-local runs centrally.
- T1: `prisma/schema.prisma`, `prisma/migrations/20261018120000_close_checklist/migration.sql`, `lib/checklist/{rules,proofs,view,write}.ts`,
  `lib/auth/permissions.ts`, `lib/audit.ts`, `lib/clients/delete.ts`, `.agents/skills/accounting-rules/SKILL.md` (rule 25 names the
  checklist), `tests/unit/checklist-rules.test.ts`, `tests/unit/permissions.test.ts`, `tests/db/checklist.test.ts` — enum `ChecklistKind`
  (AUTO · SIGNOFF · MANUAL) and two tables: `ChecklistTask` (the template: title, Pelaksana, optional Pereviu, due day, `startPeriod` /
  `endPeriod` as YYYYMM) and `ChecklistMark` (sparse per-month Selesai / Direviu of a human task). The mark carries the task's kind
  through a composite FK `(taskId, kind)`, so the CHECKs can say "a Manual review only with a tick" and "a Pemeriksaan akhir mark holds
  only the review" (its Selesai stays the `CloseSignoff` row). Other CHECKs: due day 1–28, valid months with end ≥ start, key iff not
  Manual, no Pereviu on Otomatis, Pereviu ≠ Pelaksana, who/when paired, no empty mark. `rules.ts` (pure): due date in the month after
  the period, today in WIB, the holder / pair / tick / review rules and the review-after-tick status. `proofs.ts` (pure): the eight
  Otomatis kinds and their proof lines. `view.ts`: month view (`checklistMonth`), default proposal (`defaultLines` /
  `proposeChecklist`), and the board roll-up (`checklistRollup`), all from one `buildRows`. `write.ts`: accept, add, edit, remove,
  tick / review (`markTask`) and the one `CloseSignoff` writer (`setSignoff`), each with one `CHECKLIST` event. Capability
  `checklist.manage` (OWNER, ADMIN): "Hanya admin kantor yang dapat mengatur checklist."

## Verification

## Ship Notes
