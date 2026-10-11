# New client from files

## Context
"Klien baru" today is a form: client name, industry, then each company or owner (type, full and short name, NPWP,
currency) and every rekening (bank, number, label). On 2026-10-10 the test client needed one PT and one owner with
seven rekening — every value was printed on the statements the accountant already had. After the Unggah inbox
(`2026-10-10-unggah-inbox.md`) can propose rekening and owners from files, the same reading can start the client.

## Decisions
1. **"Klien baru" starts from files.** Two inputs: client name (prefilled from the first company holder found, editable)
   and a drop zone / Drive folder link. Buku reads the files and proposes, in one card: the entities (a holder with
   PT/CV/Tbk → company; a person's name → pemilik; NPWP when printed), and every rekening under its entity. One
   *Buat klien & impor* creates the client, entities and rekening, then lands on the client's Unggah page with the
   files already booked (same per-file list).
2. **The manual form stays** as "Isi manual" for clients without files yet.
3. **Nothing is guessed silently.** Entities and rekening the card proposes are visible and editable before creation;
   files that can't be assigned stay in the client's Dokumen with their reason.

## Acceptance criteria
- [ ] From Beranda, a new client is created from the walk's file set (synthetic copies) with one PT, one pemilik and
      all rekening in one confirmation; the client opens on Unggah with every statement booked.
- [ ] Editing a proposed entity name or moving a rekening to another entity in the card is respected.
- [ ] Holder names that look like the same person/company with spacing/case/PT-prefix differences become one entity.
- [ ] The manual path still works unchanged; the investor demo walk passes.

## Verify flows
1. Admin → Klien baru → name + drop synthetic statements (PT + owner, 5 banks) → card → *Buat klien & impor* → Unggah
   shows booked files; Pengaturan klien lists the entities and rekening.
2. Edge: files from two different companies → card proposes two companies; user removes one → its files stay in
   Dokumen only.
3. Error: only unreadable files → card says nothing could be read and offers *Isi manual*.

## UX notes
- Klien baru: "Nama klien" + drop zone "Tarik rekening koran klien ke sini — Buku menyiapkan perusahaan, pemilik dan
  rekeningnya." Link below: "Belum ada file? Isi manual".
- The card reuses the Unggah confirm card, grouped by entity.

## Test seams
- Unit: holder → entity proposal (company vs person, name normalisation).
- DB integration: create client + entities + rekening + imports in one action; partial assignment.
- e2e: flow 1.

## Non-goals
- Reading NPWP or addresses beyond what statements print; industry detection.
- Ledger/neraca-driven setup (entities from a trial balance) — later if needed.

## Assumptions
1. Builds on the Unggah inbox cycle (confirm card, sorting, keyring) and the reader `holder` field.
2. Client name defaults to the first company holder, else the first person's name.

## Gate re-openers
- Sensitive path: `app/actions.ts` (new create-from-files action; same permission as `client.create`). No schema
  change expected beyond the inbox cycle's.

## Tasks
- [x] T1 Proposal model: holders → entities (company/person, normalised), rekening grouped — accept: unit tests.
- [x] T2 Create-from-files action: client + entities + rekening + hand-off to Unggah processing — accept: DB tests.
- [x] T3 Klien baru page: name + drop + card + *Isi manual* — accept: verify flows 1–3.
- [x] T4 e2e + docs + full gate — accept: green.

## Implementation
- Approval: part of the three-cycle plan approved 2026-10-10 ("proceed"); merge on green, production check after merge.
- Plan: T1–T3 by one worker in a worktree (sequential, shared files), T4 by the driver after the worker's run ended on a
  full disk. Holder names are optional: the readers print them only once `bank-reader-fixes` (#143) lands.
- T1 (`lib/inbox/propose.ts`): `proposeClient(files)` → client name, entities with their rekening, valas, unread files,
  documents. Holders grouped with `names.ts` (company vs person, legal forms / case / spacing ignored); a rekening without
  a holder goes to the first company, else to one company named after the client; rekening deduped by bank + digits;
  negative balance → PRK; valas listed, not created. Tests `tests/unit/inbox-propose.test.ts` (holder fixtures included).
- T2: the reading core of the inbox check is shared (`firmLayouts`, opener, outcome); `previewFile()` reads a file with
  only the offered password and stores nothing; `previewClientFileAction` (`client.create`, 5 MB). Tests
  `tests/db/inbox-preview.test.ts` (nothing stored; locked PDF without / wrong / right password; full path preview →
  create → inbox → plan ready with the keyring holding the password).
- T3: `components/app/new-client-from-files.tsx` — Nama klien, Bidang usaha, drop zone, one password field, one card
  "Usulan dari file" (entity names editable, remove / restore, every rekening's *Milik* select incl. *Pemilik baru…*),
  *Buat klien & impor* → `addClientAction` (its field errors mapped onto the card) → each file into the new client's inbox
  with one batch → `/clients/<id>/import?lanjut=<batchId>`; files whose rekening all belonged to a removed entity are
  skipped (kept in Dokumen). Nothing readable → a card with *Isi manual*. `?manual=1` shows the old form unchanged,
  prefilled with the typed name. e2e specs that need the form open it through `openClientForm` (`e2e/qa-helpers.ts`).
- T4 (driver): `e2e/new-client-from-files.spec.ts` (verify flows 1 and 3); README onboarding row; Unggah's summary now
  counts a file whose every row was already booked as "sudah dibukukan sebelumnya" instead of "dibukukan" (seen in the
  production check of #148).
- Not built: a Drive folder link on Tambah klien (Unggah has it, one step later); verify flow 2 (two companies) needs
  holder names from #143 — the code path (remove an entity → its files skipped) is in place.

## Verification
Verified locally — `2c54d16` (on `main` @ `9c6d891`; the next commit only changes the deck):
- `npm run lint` clean · `npm run typecheck` clean · `npm test` → 253 files, 1996 tests passed.
- `npm run build` OK · `npm run demo:reset && npm run verify:books` → "ALL PASS — 1765 pemeriksaan saldo cocok dengan ground
  truth."
- `npm run test:e2e` → 88 passed, 4 failed: `auth-links`, `client-navigation`, `support-session`, `trial-signup` — the
  same four environment-only failures as `main` on this laptop (they pass on CI). All 21 specs moved to `openClientForm`
  pass; `new-client-from-files` (2 tests) passes. After the summary change: `new-client-from-files`, `unggah-inbox`,
  `dokumen-to-unggah`, `investor-demo` → 8 passed.
- Worker's browser walk (dev server): two BCA CSVs + a locked Mandiri PDF → wrong password refused, right one opens → one
  card (company named after the client, BCA ·1299 with 2 files, Mandiri ·9999) → moving Mandiri to *Pemilik baru…*
  without a name is refused on the row; with "Budi Santoso" the client gets a PT and a pemilik → Unggah "3 file selesai:
  3 dibukukan."; at 390 px no horizontal scroll; an unreadable `.txt` shows the nothing-read card and *Isi manual* keeps
  the name.
- Verify flow 2 (two companies, remove one) waits for holder names (#143); its code path is unit-tested.
- Review of #149 (`ce2c2d3`): the card follows later files (only a rekening the user moved keeps its owner; an unused
  proposed entity goes), upload failures after creation are listed with their reason and a *Buka Unggah* button, a lost
  request while unlocking isn't reported as a wrong password. Gate: `npm test` 254 files / 1998 tests, build, e2e
  `new-client-from-files`, `unggah-inbox`, `add-entity`, `investor-demo` → 6 passed.
- Highlight shots: `new-client-card.jpg` (the one card), `new-client-booked.jpg` (Unggah right after creation).
- Deck: kantor slide 15 step 1 now "Tambah klien dari file"; checked at 1440×900 (fits) and 375 (no overflow).

## Ship Notes
- No migration, no env change. Rollback: revert the PR (the manual form is unchanged at `?manual=1`).
- Post-merge: in production, Tambah klien shows the drop zone and *Isi manual*; a statement dropped there proposes its
  rekening (no client is created during the check).
