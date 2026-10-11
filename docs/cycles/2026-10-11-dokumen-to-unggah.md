# Dokumen → Unggah: a client's rekening koran books with one click

## Context
Finishes Decision 1 of [`2026-10-10-unggah-inbox.md`](2026-10-10-unggah-inbox.md) ("its own upload box sends files through the
same sorting"), which that cycle left unbuilt. In production a user uploaded a plain BCA statement to Dokumen: Dokumen recognised it
as "Rekening koran" and then showed the six-field role form (Peran, Entitas, Mata uang, Dari, Sampai, Rekening). Unggah already
reads the rekening and period from the file and books it with one card; Dokumen already shows *Dibukukan →* for what Unggah booked.

## Spec
- A bank unit in a **client's** Dokumen collection, not yet imported or booked, shows one primary button *Bukukan lewat Unggah*
  ("Buku membaca rekening dan periodenya dari file."). The role form stays, collapsed, under *Isi manual*.
- Firm-wide collections (no client) and ledger units are unchanged.
- The click makes the stored version a line of a new Unggah drop — read like a dropped file (keyring included), the bytes not stored
  again — and opens Unggah, which books at once when nothing needs asking, else shows the password field or the one card.
- A version Unggah already booked or staged is never adopted again (no double booking); the action opens Unggah as it is.
- Only a version of a collection of the same client and firm is accepted; the member needs `books.write` on that client.
- No schema change.

## Tasks
- [x] T1 `adoptVersion` (lib/inbox/check.ts) + `inboxFromDocumentAction` (app/inbox-actions.ts, re-exported by app/actions.ts) —
      accept: `tests/db/inbox-adopt.test.ts`, the hand-over case in `tests/db/inbox-actions.test.ts`, action guard test.
- [x] T2 Unggah `?lanjut=1` books a handed-over drop at once; Dokumen's *Bukukan lewat Unggah* with *Isi manual* — accept:
      `e2e/dokumen-to-unggah.spec.ts`.
- [x] T3 README (Document evidence workspace) + this cycle doc.

## Implementation
- `adoptVersion(db, { firmId, clientId, batchId, versionId, actorId })` finds the version through its document's intake
  (`firmId` + `clientId`), else "Dokumen tidak ditemukan."; returns the newest BOOKED/DRAFT item of the version if any; otherwise runs the
  same private `classify` as `checkFile` and creates the `UploadItem` with that `evidenceVersionId` and the version's hash. The item
  columns from an outcome are one helper (`outcomeData`) shared by `checkFile`, `adoptVersion` and `recheckItem`.
- `inboxFromDocumentAction(intakeId, versionId)`: Dokumen must be enabled; the firm from `requireCapability("books.write")`, the
  intake firm-scoped and linked to a client ("Hubungkan kumpulan ini ke klien dulu." otherwise), then the inbox guard
  (`books.write` on that client); a new `crypto.randomUUID()` drop. Returns `{ ok: true, href }` — `/clients/<id>/import?lanjut=1`
  for a new drop, `/clients/<id>/import` when the file was already booked.
- Unggah page: `handedOver` prop from `?lanjut=1`; the existing resume effect calls `continueWith(plan)` (books when nothing is
  asked) instead of `apply(plan)`, and drops `lanjut` from the URL so a reload behaves as before.
- Dokumen `UnitReview`: `handoff = bankUnit && intake.clientId && !saved?.importId` (booked versions don't render units at all);
  the role form, valas select, buttons and password field are one `manual` fragment, shown as is or inside `<details>` *Isi manual*.
- Not done: a version with an open (CHECKED / NEEDS_*) item from an earlier hand-over gets a new line in a new drop; the older drop
  keeps its waiting line (the import pipeline also dedupes rows).

## Verification
Verified locally — `18cb6c9` (on `main` @ `0020a07`):
- `npm run lint` clean · `npm run typecheck` clean · `npm test` → 251 files, 1982 tests passed.
- `npm run build` OK · `npm run demo:reset && npm run verify:books` → "ALL PASS — 1765 pemeriksaan saldo cocok dengan ground
  truth."
- `npm run test:e2e` → 86 passed, 4 failed: `auth-links`, `client-navigation`, `support-session`, `trial-signup` — the
  same four environment-only failures as on `main` locally (they pass on CI). `dokumen-to-unggah` (new) passes.
- Driver review fixes: the hand-off reads an earlier booked line against the imports that still exist (a removed import
  can be handed over again); the entity/period notes moved inside *Isi manual* (they asked what Unggah reads itself).
- Review of #148 (`f649722`): `?lanjut=<batchId>` opens exactly the handed-off drop; a combined file counts as
  booked only while every one of its imports exists. Gate: lint, typecheck, `npm test` 251 files / 1983 tests, build, e2e
  `dokumen-to-unggah`, `unggah-inbox`, `evidence-workspace` → 5 passed.
- Highlight shot: `dokumen-handoff.jpg` — a client's rekening koran in Dokumen: one button, one sentence, *Isi manual*.

## Ship Notes
- No migration, no env change. Rollback: revert the PR.
- Post-merge: in production, a BCA statement in Skypuats' Dokumen collection shows *Bukukan lewat Unggah*; the click
  opens Unggah and books it (or says it was booked before).
