# Fix a company or bank account entered by mistake

## Context
A company/owner or a bank account can be *added* after "Simpan klien" (Pengaturan klien → *Perusahaan & rekening*, and Unggah adds rekening
from the files), but a typo'd name, a wrong account number or a company entered by mistake can't be fixed short of deleting the whole client.
Who feels it: the accountant setting up a client, and anyone reading a report that prints the wrong name (the bank GL account name is
`label (shortName)`, so a wrong short name shows on Neraca and Buku Besar).

Draft #74 (2026-09-30) built this on a main that was twelve days and ~80 PRs older; since then the books gained the audit log (*Riwayat*),
OCR drafts, Coretax faktur and bukti potong, PPh 25 instalments, report comments, stock counts, subledger reconciliation, findings and the
Unggah inbox — all of which point at an entity or a bank account. This cycle rebuilds it on today's main and closes #74.

What an accountant needs to be true:
- **Names are labels, numbers are not.** A rename never moves a figure, a journal or a period; the bank GL account name follows it.
- **Posted entries are immutable** (accounting-rules 3): anything a journal, bank row, import, draft or register points to can't be removed.
  Removal is for something entered by mistake and still empty; a correction to books goes through Jurnal Penyesuaian.
- **A bank account's number is what statements are matched against** (Unggah routes a file by the number inside it): once a statement
  has been read for it, the number stays.
- The ledger import matches a file's entity column by short name: two entities with one short name would make that ambiguous.

## Spec
- **E1 Ubah perusahaan/pemilik:** name, short name (unique per client, case-insensitive) and NPWP (same rule as creation, `normalizeNpwp`;
  blank clears; none for a foreign entity). Kind, currency and framework are not edited here (framework has its own card). Allowed in a
  locked month (labels only). The GL names of the entity's bank accounts follow, in the same transaction. Any member who may add an entity.
- **E2 Ubah rekening:** name (label) and bank any time — the bank is a label too, as *Catat sebagai &lt;bank&gt;* already allows; the GL
  name follows the label. The number only while nothing was read for that account (statement import, bank row, OCR draft, a document
  confirmed as its statement); afterwards the field is locked with the reason. PRK never changes (it decides the GL account type).
- **E3 Hapus rekening (admin):** only when nothing points to it or its GL account: statement imports, bank rows, OCR drafts, document
  selections, journal lines, ledger source-account mappings, tax credits, fiscal corrections, invoices, schedules, fixed assets, bank rows or
  splits classified to its code, client rules or remembered choices filing to its code. Deletes the bank account, its GL account and the close
  acknowledgements keyed by it. The freed code is reused by the next add.
- **E4 Hapus perusahaan/pemilik (admin):** only when the client keeps another entity and nothing points to it: journals (incl. Saldo Awal),
  bank rows and imports, source accounts, schedules, proposals, fixed assets, invoices, tax years, CKPN, leases, employees and benefits,
  stock counts, subledger imports, findings, report comments, Coretax faktur and bukti potong, PPh 25 instalments, document selections,
  ledger-import checks and draft ledger imports mapped to it — plus everything E3 lists for its bank accounts. Deletes its (empty) bank
  accounts with their GL accounts.
- **E5 Riwayat:** every rename, edit and removal writes an audit event (*Perusahaan & rekening*) with before/after, in the same transaction.
- **E6 UI on *Perusahaan & rekening*:** *Ubah* on each company and each rekening opens an inline form. The form ends with the removal part:
  for an admin either *Hapus …* (second click confirms) or, when something points to it, the reason in one sentence ("Sudah ada 12 jurnal
  (termasuk saldo awal), 40 mutasi bank. Pembukuan yang sudah tercatat tidak bisa dihapus; koreksi lewat Jurnal Penyesuaian."), computed on
  the server by the same check the action re-runs. Rows stay clean: no disabled buttons in the list. Viewers see no Ubah (as today: no Tambah).
- **E7 Adding** an entity refuses a short name the client already has (same reason as E1).

**Non-goals:** no schema change or migration; no change of kind, currency or PRK; no merging entities; no moving a bank account between
entities; no deletion of anything with posted entries (correct by Jurnal Penyesuaian, or delete the client as an admin).

**Decisions made (no question needed):**
1. Removal is admin only (OWNER/ADMIN, the `client.delete` capability, like *Hapus klien*); rename and edit need `client.create` (the role
   that may add an entity or rekening).
2. NPWP is edited with the name (a legal rename usually corrects it).
3. A rename in a locked month is allowed: it changes labels on reports, never numbers.
4. The bank is editable after imports (a label, consistent with *Catat sebagai &lt;bank&gt;*); only the number locks.
5. Audit events for a removed entity keep its id (history is append-only); they don't block removal.
6. The foreign keys are the last line of defence: a delete that races a concurrent import fails with a message and removes nothing.

**Acceptance:** every refusal leaves every row count unchanged; a rename leaves Neraca Saldo, Laba Rugi, Neraca and close controls identical
(also in a locked month); tenant isolation and the role gate hold; `verify:books` ALL PASS; the card walked in the browser at 1440 and 390 px.

## Tasks
- [x] T1 Domain `lib/clients/entities.ts` (usage, reasons, rename, edit, remove, audit) + E7 in `lib/onboarding.ts` + `tests/db/entity-edit.test.ts` — accept: E1–E5, E7 rules, refusals leave data untouched, books identical after rename.
- [x] T2 Server actions (role gate, tenant) + `tests/db/entity-edit-action.test.ts` — accept: akuntan edits, cannot remove; viewer refused; foreign client refused.
- [ ] T3 UI in `entities-card.tsx` + settings page (reasons from the server) — accept: E6 walked in the browser.
- [ ] T4 e2e (`e2e/add-entity.spec.ts`), README, accounting-rules note, full gate — accept: recorded in Verification.

## Implementation
- Plan: T1–T4 in order, by the driver (each builds on `lib/clients/entities.ts`; a fan-out would cost more than it saves). The draft #74
  was the starting point, re-checked against today's schema.
- T1: `lib/clients/entities.ts` — `clientUsage` counts what points at every entity and bank account of a client in one `groupBy` per
  table (the settings page shows it, the removal re-runs it inside its transaction); `renameEntity`, `updateBankAccount`, `removeBankAccount`,
  `removeEntity` write a `COMPANY_BANK` audit event (`lib/audit.ts`). `lib/onboarding.ts`: adding an entity keeps short names unique.
  `lib/inbox/plan.ts`: a new owner from Unggah whose first name is already a short name gets the full name, so the new rule never refuses
  it. Tests: `tests/db/entity-edit.test.ts` (26), one new case in `tests/db/inbox-plan.test.ts`.
- T2: `app/actions.ts` — `renameEntityAction`, `updateBankAccountAction` (`client.create`), `removeBankAccountAction`, `removeEntityAction`
  (`client.delete`, refusal "Hanya admin kantor yang dapat menghapus perusahaan atau rekening."); the member is the audit actor.
  `tests/db/entity-edit-action.test.ts` drives them through the real guard (akuntan, viewer, admin, another organisation).

## Verification

## Ship Notes
