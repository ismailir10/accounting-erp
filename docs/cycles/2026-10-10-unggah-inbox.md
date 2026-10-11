# One Unggah inbox: drop the client's files, Buku sorts and books them

## Context
A production walk on 2026-10-10 took one test client from "no rekening" to seven imported statements (a PT's BCA
giro; the owner's BCA giro + tahapan, BNI, Mandiri, BRI and SMBC). Bank reading itself works (see
`2026-10-10-bank-reader-fixes.md` for the three layouts that don't yet). The journey around it makes the user think
at every step:

- **No bank upload until a rekening exists.** With zero rekening, Impor Mutasi shows only "Impor Buku Besar"; nothing
  says to go to Pengaturan. Pengaturan says "Belum ada rekening bank. Buku diisi dari file buku besar atau neraca." as
  if that were a choice.
- **Rekening typed by hand.** Seven rekening ≈ 30 clicks and fields, every value copied off the statements.
- **Rekening picked before the file.** A file uploaded with the default (wrong) rekening is blocked although Buku
  knows the right one ("Pakai rekening …"). The select resets to the first rekening on every load. A file whose number
  isn't readable (BNI wondr today) imports into whatever is selected.
- **One file at a time; a password per file.** Two banks lock their PDFs; the same password is asked again for every
  file. Passwords differ per client and sometimes per bank.
- **Results don't stay.** Errors are toasts that vanish; the previous file's result stays on screen as if it were the
  new file's; the result card says "Nyambung" while Kelengkapan data above says "Tidak nyambung" for the same file.
- **Combined files.** SMBC's three-account PDF imports the selected account; the other two are listed "tidak diimpor"
  with no way to add them there.
- **Two places for the same file.** Dokumen reads the statements, labels them "Rekening koran", then asks for six
  fields by hand (Peran, Entitas, Mata uang, Dari, Sampai, Rekening) and cannot book them; Impor Mutasi books but
  doesn't keep the file for questions. Dokumen also confirmed an AI-proposed "Mata uang: INDONESIA".

Who feels it: the accountant every month for every client. Principle: drop the files; Buku reads what is printed on
them and asks only what it truly cannot know, once.

## Decisions
1. **One "Unggah" page per client** replaces Impor Mutasi in the menu (1 · Sumber → Unggah). Drop any number of files
   or paste a Google Drive folder link (the firm's existing Drive connection). Every file is kept in Dokumen (its
   library, versions, questions — unchanged), and Buku sorts it:
   - **rekening koran** → booked through the existing bank import;
   - **buku besar / neraca** → a ledger-import draft, opened for the usual mapping check;
   - **anything else** → kept as a document only.
   The global Dokumen page stays the library; its own upload box sends files through the same sorting.
2. **Rekening come from the files.** A number Buku knows routes to its rekening automatically (no select, no
   "Pakai rekening"). New numbers — including the other accounts of a combined PDF — appear together in **one confirm
   card**: "Rekening baru: BCA ·3814 a.n. <holder> → milik [entitas ▾]" with *Tambah & impor*. The entity is
   preselected when the holder matches an entity name; a person's name that matches no entity offers "Tambah pemilik
   <name>" in the same card. A file with no readable number asks for its rekening in that card — never silently into
   a default.
3. **Password keyring per client.** Every password that opened a file for this client is kept, encrypted (same
   secret as the AI key); the next locked file tries them all; only a file none opens asks, once, and that password
   joins the keyring. Admins can clear it in Pengaturan klien. Replaces today's "never stored" rule → ADR.
4. **Every file gets a line that stays.** The page shows the latest drop as a list: file → what Buku did (booked into
   BCA ·3814 for Jan 2026, 242 rows / ledger draft waiting for mapping / kept as document) or its own error in plain
   words. Continuity wording matches Kelengkapan data ("nyambung dengan Desember" / "selisih Rp … dengan bulan
   sebelumnya"). The AI progress line from `2026-10-10-import-ai-background.md` sits on each booked statement. No
   toast-only states.
5. **Holder mismatch warns, doesn't block.** A holder that matches no entity of the client shows "Nama di file:
   <holder> — bukan perusahaan atau pemilik klien ini. Klien yang benar?" on the card; *Tetap impor* proceeds.
6. **Files are processed oldest period first** within a drop, so continuity checks read naturally.
7. **Dokumen's bank path simplifies.** A statement that was booked shows "Dibukukan → BCA ·3814 · Jan 2026" instead of
   the six-field role form; the manual form remains only for files Buku couldn't classify. Country names are no
   longer accepted as a currency fact.

## Acceptance criteria
- [ ] With zero rekening, Unggah is the first thing on the client's Sumber step; dropping a statement proposes the
      rekening in the confirm card — no visit to Pengaturan. Pengaturan's empty-rekening copy no longer reads as a
      choice.
- [ ] Dropping the walk's file set at once (7+ statements, mixed banks, two locked) asks at most once per distinct
      password and once for the confirm card, then books every readable statement into the right rekening, oldest
      first; the SMBC file adds and books all three accounts.
- [ ] A known rekening number never needs a click; a file without a readable number never books into a default.
- [ ] Passwords: a second drop next month with the same locked files asks nothing; clearing the keyring makes it ask
      again; passwords never appear in logs, URLs or responses.
- [ ] Every file in a drop has a persistent line (also after reload) with its outcome or its own error; no stale
      result from another file; continuity wording agrees with Kelengkapan data.
- [ ] A Drive folder link with subfolders imports the same way as dropped files (files already imported are skipped
      as duplicates, as today).
- [ ] Ledger/neraca files land as ledger-import drafts; other files only in Dokumen; nothing outside bank statements
      is booked without the existing review.
- [ ] Dokumen shows booked statements as booked (link to the import), not the six-field form.
- [ ] `verify:books` ALL PASS; investor demo walk passes (updated for the new menu label if needed).
- [ ] Deck claims to review (ship.md § Deck review): any slide about uploading statements.

## Verify flows
1. **Empty client, whole set** (Admin, synthetic statements of 5 banks incl. two locked and one combined PDF): drop all
   → password asked once → one card with every new rekening and a proposed pemilik → *Tambah & impor* → every file's
   line shows booked; Kelengkapan shows the months.
2. **Next month** (Akuntan): drop the next month's files → no password, no card → booked in seconds.
3. **Edge — wrong client**: drop a statement whose holder is another company → warning on the card → *Tetap impor*
   works; *Batal* books nothing and keeps the file in Dokumen only.
4. **Error — unreadable**: a photo of a statement and a corrupt PDF in the same drop → each has its own line with the
   reason (OCR offer for the photo, as today); the rest books.
5. **Drive folder**: paste a folder link with bank subfolders → same outcome as flow 1.

## UX notes
- Menu: 1 · Sumber → **Unggah** (was Impor Mutasi), Saldo Awal unchanged.
- Page top: one big drop zone "Tarik file klien ke sini — rekening koran, buku besar, neraca, atau dokumen lain. Bisa
  banyak sekaligus, atau tempel tautan folder Google Drive." Below it: the latest drop's file list; below that,
  Riwayat (history) as today.
- Confirm card: one card for the whole drop; primary *Tambah & impor*, secondary *Batal*. Entity select appears only
  when more than one entity fits.
- Password: one inline field "Kata sandi PDF (dipakai untuk semua file terkunci, disimpan untuk klien ini)".
- Copy in Bahasa Indonesia, sentence case (ui-rules).

## Test seams
- Unit: file sorting (bank / ledger / other), holder ↔ entity matching, oldest-first ordering.
- DB integration: drop with known + new + numberless + combined files; keyring (try all, add, clear, never logged);
  per-file outcome records survive reload; Drive folder path with a mocked Drive client.
- e2e: flow 1 on synthetic files (extend the bank-import spec); investor walk updated.

## Non-goals
- AI timing (cycle `import-ai-background`, ships first) and reader fixes (cycle `bank-reader-fixes`, independent).
- Creating a new client from files (cycle `new-client-from-files`, after this one).
- Review-load reduction (own cycle later, measured after AI suggestions improve).
- Non-IDR bank posting (unchanged refusal).

## Assumptions
1. Every dropped file is stored as a Dokumen version (existing tables), so per-file outcomes hang off what already
   exists; at most one additive column/table if a drop needs grouping.
2. The keyring is one additive table (client, encrypted password, added by, added at); ADR records the change from
   "never stored".
3. Holder names come from the reader (`bank-reader-fixes` adds `holder`); until it merges, the card works without the
   name and skips the mismatch warning.
4. Drive folder reading reuses Dokumen's Drive code (folder walk, download) and walks subfolders (the walk's files
   sat in "REKENING KORAN/<bank>/"), with Dokumen's existing limits.
5. Large drops run file by file within a few short requests (bank import is seconds once AI is in the background).

## Gate re-openers
- **Schema (additive):** password keyring table; possibly a drop/batch grouping.
- **Security/PII:** stored PDF passwords (encrypted, admin-clearable, never logged) → ADR + security review in ship.
- **Sensitive paths:** `app/actions.ts`, `lib/settings/**` (encryption helper reuse).
- No new dependency, no AI change, accounting invariants unchanged (deterministic pipeline stays the only writer).

## Tasks
- [x] T1 ADR: per-client PDF password keyring (replaces "never stored") — accept: ADR merged in the PR.
- [x] T2 Sorting + per-file outcome: every file → Dokumen version + kind (bank / ledger / other) + outcome record —
      accept: DB tests for the three kinds and reload persistence. (reuse: evidence store, `parseStatementSections`,
      ledger-import read)
- [x] T3 Rekening from files: route known numbers; build the confirm card model (new numbers, combined sections,
      numberless files, holder ↔ entity, proposed pemilik); server action *Tambah & impor* — accept: DB tests incl.
      SMBC three accounts and wrong-client warning. (reuse: `addBankAccount`, `addEntity`, `importStatement`)
- [x] T4 Keyring: encrypt/store/try-all/clear; never logged — accept: DB + unit tests; grep proves no plaintext path.
- [x] T5 Unggah page + menu: drop zone, Drive link, password field, confirm card, per-file list, oldest-first —
      accept: verify flows 1–5 locally. (deps: T2–T4)
- [x] T6 Dokumen: booked statements show "Dibukukan →"; no country-as-currency facts; Pengaturan empty-rekening copy —
      accept: verify on the walk's files.
- [x] T7 e2e + investor walk + docs (README routes, demo script) + full gate — accept: full gate green.

## Implementation
- Approval: user approved the four-cycle plan on 2026-10-10 ("proceed"), merge on green, production check with Chrome
  after merge; subagent-driven development.
- Production evidence feeding this cycle (2026-10-11, after `import-ai-background` merged): a BCA tahapan import answered
  in ~15 s, its background run settled 556 of 813 waiting lines and stopped at the 20-call cap; Review then says
  "257 transaksi hanya punya tebakan sederhana karena AI tidak memberi saran saat impor" — no longer true (AI doesn't run
  at import) → copy fix in T6.
- Review findings on #144 fixed in #145 (merged `7acb301`): slices now fit the function limit and chain themselves
  through `app/api/ai-run`. Production check 2026-10-11 18:02 UTC: *Minta saran AI* for the 257 lines left, tab closed
  after the first slice; Vercel logged `POST /api/ai-run 202` at 18:05:29 and the run settled every line (Review no longer
  offers *Minta saran AI*).
- Plan (driver): tasks regrouped for the build, same scope — T1 ADR (driver, inline); T2 inbox store + preview + keyring
  (lib); T3 plan / confirm / process (lib); T4 actions + Drive folder; T5 Unggah page + menu + setup copy; T6 Dokumen
  "Dibukukan", Pengaturan and Review copy; T7 e2e + docs + full gate. Sequential, one worker each (shared files);
  driver reviews every diff and re-runs the gate.
- Design (driver):
  - **Inbox intake:** one `EvidenceIntake` per client flagged `isInbox` (additive column, partial unique per client),
    found or created on first upload; files stored with the existing begin/append/finish flow, so they show in Dokumen
    like any upload (dedupe by hash per intake is free).
  - **`UploadItem`** (additive table): one row per dropped file — firm, client, `batchId`, file name, sha256, evidence
    version, `kind` (BANK | LEDGER | OTHER), `status` (CHECKED | NEEDS_PASSWORD | NEEDS_ACCOUNT | BOOKED | DRAFT | KEPT |
    FAILED), `message`, period, `sections` JSON (bank, number, holder, currency, period, rows, error per section),
    links to the StatementImport(s) / LedgerImport. The page's per-file list reads these rows (persists across reloads).
  - **`ClientPdfPassword`** (additive table): firm, client, `secret` (encryptSecret), added by/at, last used. Tried in
    order on a locked PDF; a password that opens a file is added once; admins clear them in Pengaturan klien. Never
    logged, never returned to the browser.
  - **Requests stay short:** one server action per file to check it (store + preview), one to build the plan, one to
    confirm the card, and one per file to process it (oldest period first, driven by the page) — no request handles
    the whole drop. Drive folders: one action lists the folder (recursive, Dokumen's limits), then one action per file
    fetches and checks it.
  - **Holder name:** read from `ParsedStatement.holder` once `bank-reader-fixes` (#143) merges; until then the card works
    without it (no mismatch warning).
- T1: `docs/adrs/0018-pdf-password-keyring.md` + ADR index — per-client encrypted keyring, server-only, clearable by
  admins; replaces "never stored".
- T2 (build regrouping: inbox store + check + keyring): migration `20261010170721_unggah_inbox` (EvidenceIntake.isInbox +
  partial unique "one inbox per client", UploadItem, ClientPdfPassword, enums), `lib/inbox/store.ts` (inbox intake,
  server-side chunked store), `lib/inbox/keyring.ts` (try without → offered → stored, most recent first; encrypted,
  stored once under an advisory lock; never logged/returned), `lib/inbox/check.ts` (store + classify BANK/LEDGER/OTHER
  with sections, books nothing), `postableTables` exported from evidence extract, `StatementRepairError` (a subclass of
  UnreadableFileError so a real statement with a broken balance is FAILED with its reason, not kept as "other"),
  tests `inbox-store`, `inbox-keyring`, `inbox-check`. Known gaps kept for later: year-less / ambiguous-date statements
  end FAILED with the reader's message (the old import page keeps its year prompt and *Atur kolom*); locked Excel files
  are kept as documents; the inbox has Dokumen's per-intake limits (500 files / 100 MiB).
- T3 (plan / confirm / process): `lib/inbox/names.ts` (normalised names: legal forms, punctuation and word order
  ignored; company vs person), `lib/inbox/plan.ts` (planBatch: known numbers routed, new rekening per bank+number with a
  proposed entity or new pemilik and the wrong-client warning, numberless files, locked files; confirmBatch with tenancy
  checks before any write and per-account errors; skipItems; unlockBatch re-checks stored files with one password),
  `lib/inbox/process.ts` (processNext: oldest period first, one importStatement per rekening with `aiLater`, ledger →
  draft, per-file Bahasa outcome), `recheckItem` in check.ts, tests `inbox-names`, `inbox-plan`, `inbox-process`;
  `verify:books` ALL PASS. A new rekening whose balance is negative is proposed as an overdraft (PRK); a combined file
  with some sections booked stays BOOKED with the failures in its message. Open for T4: an atomic claim so two
  parallel `processNext` calls can't take the same file.
- T4 (actions + Drive + claim): `UploadStatus.PROCESSING` (in the branch's `unggah_inbox` migration); processNext claims
  its file with a conditional update (CHECKED → PROCESSING), always ends it in a final status (unexpected error →
  FAILED), releases claims older than 10 minutes, and counts claimed files as remaining; planBatch's status writes are
  conditional too. Parallel imports of the same new month raced on the period row (`getOrCreatePeriod` upsert) → now
  `INSERT … ON CONFLICT DO NOTHING` + read. `app/inbox-actions.ts` (re-exported by app/actions.ts): check file, plan,
  unlock, confirm (zod-validated card), skip, process next (schedules the background AI run once after the last file of
  a drop that booked a statement), latest batch (`batchItems`, read-only), Drive list / fetch-by-id with the firm's
  token (`lib/inbox/drive.ts`: Dokumen's ignored/backup filters, readable formats only, no shortcuts, ≤ 20 levels,
  ≤ 200 files), keyring count / clear (admins, `org.settings`). Tests `inbox-actions` (through the real guard),
  `inbox-drive` (fake Drive), claim / recovery / failure cases in `inbox-process`.

- T5 (Unggah page): `components/app/unggah-inbox.tsx` (drop zone + Drive link → check each file → plan → one
  password field → one confirm card → book oldest first, live per-file lines, "Saran AI" line; reload shows the last drop
  and resumes only on "Lanjutkan"), `lib/inbox/view.ts` (pure line/summary helpers), page reordered (Unggah first;
  Riwayat / Cara lain tabs — the single-file forms for scans, year prompts and *Atur kolom* live in Cara lain), menu
  "Unggah", NextStep for a client without rekening, e2e/doc label updates. Driver's browser walk (production build,
  fake AI endpoint, demo client): six files at once → one password → one card with four new rekening (PRK badge on the
  negative SMBC account) → "6 file selesai: 3 dibukukan, 1 draf buku besar, 1 disimpan di Dokumen, 1 gagal" (SMBC: May
  2026 is closed in the demo) → "Saran AI selesai · 5 saran"; the list survives a reload. Walk fixes: no "Coba cara lain"
  for failures another form can't fix (closed month, valas, password, size); one line per account instead of "; ".

- T6: Dokumen shows a booked file as "Dibukukan → BCA ·3814 · Jan 2026" (or "Draf buku besar →") instead of the role
  form, from the version's newest booked/draft UploadItem in the existing workspace query; currency facts must be
  registry codes at parse, store, confirm and display (an "INDONESIA" fact is never stored or shown — older ones are
  hidden and can't be confirmed); Pengaturan's empty-rekening copy points to Unggah; Review's banner says "{n}
  transaksi belum punya saran AI."; Pengaturan klien gets a "Kata sandi PDF" card (admins: count + "Hapus semua"
  behind the confirm dialog); deck slides (kantor 08, perusahaan 12) say passwords are kept encrypted and can be
  cleared — `deck:pdf` regenerated, the new sentence checked in both PDFs with Buku's own PDF reader.

- T7: `e2e/unggah-inbox.spec.ts` (verify flow 1 in a real browser: a client with no rekening drops two BCA months and a
  locked Mandiri PDF → one password → one card with two new rekening → "3 file selesai: 3 dibukukan" → lines survive a
  reload → Pengaturan shows both rekening and "1 kata sandi tersimpan"); `openManualImport` in `e2e/qa-helpers.ts` for
  the specs that use the single-file forms (now under *Cara lain*); README (Import, Onboarding, `SETTINGS_SECRET`,
  Document evidence) and `docs/real-data.md` (rule 6, §4, §5) describe Unggah and the keyring. Driver: the public privacy
  page still said PDF passwords are never stored — now it says Unggah keeps them encrypted per client (admins clear
  them) and the other import paths don't; legal date 11 Oktober 2026; pinned by `public-legal.test.ts`.

## Verification
Verified locally — `08f54ab` (rebased on `main` @ `7acb301`):
- `npm run lint` clean · `npm run typecheck` clean · `npm test` → 250 files, 1973 tests passed.
- `npm run build` OK · `npm run demo:reset && npm run verify:books` → "ALL PASS — 1765 pemeriksaan saldo cocok dengan
  ground truth."
- `npm run test:e2e` → 85 passed, 4 failed: `auth-links`, `client-navigation` (Control+a on macOS), `support-session`
  (TOTP) and `trial-signup` — the same four fail on this laptop on `main` too and pass on CI (Linux). `unggah-inbox` and
  `investor-demo` pass. (Built at `4b7fe9e`; the two later commits change no page: tracking and AI resume, covered by
  `tests/db/ai-background.test.ts`.)
- Verify flows: 1 (whole drop) walked in the browser and in `e2e/unggah-inbox.spec.ts`; 2 (next month, no password) and
  the keyring clear in `tests/db/inbox-keyring.test.ts` / `inbox-plan.test.ts`; 4 (unreadable / closed month / valas)
  in the walk below and `inbox-check` / `inbox-process`; 5 (Drive folder) against a fake Drive in
  `tests/db/inbox-drive.test.ts` only — no Drive connection locally, checked in production after merge. 3 (wrong-client
  warning) waits for the holder name from `bank-reader-fixes` (#143); the card works without it.
- CI e2e on #146 found a real bug: with no `SETTINGS_SECRET` (CI's e2e env) the password opened the locked PDF at check
  time but couldn't be kept, so booking found it locked again and asked in a loop. Fixed in `3312727`: the page offers the
  passwords that opened this drop's files with each booking call (memory only); CI e2e gets a test-only secret like
  production. Locally: `unggah-inbox` books all three files with `SETTINGS_SECRET=` (only the keyring-count step differs,
  as it should), and passes with the secret together with `investor-demo`; `npm test` 250 files / 1975 tests.
- Review of #146 (`01b7c17`): lines are derived from the imports that still exist (`lib/inbox/live.ts`; Unggah list, plan and
  Dokumen), and classification uses the firm's *Atur kolom* layouts. Gate: lint, typecheck, `npm test` (1 fixture fixed to
  a real ledger draft), build, e2e `unggah-inbox`, `investor-demo`, `evidence-workspace`, `ledger-import` → 7 passed.
- Highlight shots (production build, demo client, six walk files): `unggah-card.jpg` (one card, four new rekening, PRK
  badge, JPY account refused) and `unggah-result.jpg` ("6 file selesai: 3 dibukukan, 1 draf buku besar, 1 disimpan di
  Dokumen, 1 gagal", one line per account).
- Not built from Decision 1: the global Dokumen upload box does not route files through Unggah's sorting yet (Dokumen
  shows what Unggah booked). Next, as its own PR before `new-client-from-files`: "Bukukan lewat Unggah" on an unbooked
  rekening koran in a client's Dokumen collection.

## Ship Notes
- Migration `20261010170721_unggah_inbox` — additive: `EvidenceIntake.isInbox` (+ partial unique per client),
  `UploadItem`, `ClientPdfPassword`, enums `UploadKind` / `UploadStatus`. Rollback: revert the PR; the tables stay unused.
- Env: none new. `SETTINGS_SECRET` now also encrypts saved PDF passwords (rotating it makes them ask again).
- Deck: kantor 08 and perusahaan 12 say passwords are kept encrypted per client and can be cleared; PDFs regenerated.
- Privacy page: PDF password paragraph updated, legal date 11 Oktober 2026.
- Also in this PR: untracked the `node_modules` symlink from #145; AI resume paths no longer start a new run (review
  of #145).
- Post-merge: Unggah on the Skypuats client in production — drop a statement Buku already has a rekening for (no card),
  a locked PDF (asks once, then remembered), a Drive folder link; Dokumen shows "Dibukukan →"; Pengaturan klien shows
  the keyring count.
