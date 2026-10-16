# Bagan Akun: the client's chart of accounts, edited in Buku

**Roadmap:** core accounting parity with Jurnal and Zahir (`docs/roadmap.md` §3). The owner asked on 2026-10-16 for Buku to be on par
with Jurnal and Zahir and better on the core accounting features, and delegated the decisions ("i trust your judgment").

## Context
The first menu of Jurnal (*Daftar Akun*) and Zahir (*Data Akun*) is the chart of accounts: add an account, rename it, choose where it
reports. Buku has no such page. A client's chart is the 71-account template, plus accounts created in two narrow places: *Buat akun
baru* while mapping an imported ledger, and the bank GL accounts made with a rekening. So an accountant who wants "6125 Beban Sewa
Kendaraan" for a client today cannot make it, and has to park the cost on 6190 Beban Umum Lain-lain. An account the template names
wrongly for a client ("Penjualan" for a clinic's *Pendapatan Jasa Medis*) cannot be renamed either.

Who feels it: the accountant preparing the books (one more workaround each time), and the client reading a Laba Rugi whose lines don't
use their own words.

Buku can do this better than the incumbents because the chart is guarded: an account never changes its type or normal side (so no
posted number changes meaning), the special accounts the ledger relies on (bank, clearing, suspense, intercompany, Saldo Laba, the
opening difference, tax and FX accounts) can't be moved or removed, and every change is in Riwayat.

## Decisions
- **One page, *Bagan akun*** (client menu → settings group, next to *Perusahaan & aturan*). All accounts grouped by statement and report
  line (Aset lancar → … → Beban pajak), each with its code, name, report line, normal side, its balance at the working month and how many
  journal lines use it.
- **Tambah akun** (books.write): a name and a report line; the code is proposed as the next free code in that line's range (the same
  ranges as *Buat akun baru* in mapping) and may be typed instead (digits only, 3–10, unique in the client, not a reserved code). Type and
  normal side follow the report line.
- **Ubah** (books.write): the name, and the report line within the **same type and normal side** (e.g. Beban umum → Beban penjualan,
  current → non-current). Never the code, type or normal side. A move changes presentation only; totals per type stay, so the Neraca and
  the net profit don't change. When the account has lines in a closed month the form says that month's reports will show it under the
  new line; it does not refuse (the incumbents allow it; refusing would freeze most accounts).
- **Hapus** (books.write): only an account nothing points to — no journal line, rekening, imported account mapped to it, schedule,
  register, document, tax record, rule, memory or bank line suggestion. Otherwise the form names what uses it. Removing an unused account
  is reversible by adding it again, so no admin gate.
- **Protected accounts**: bank GL accounts (renamed through the rekening in *Perusahaan & aturan*), and the system accounts the ledger
  refers to by code (`ACCOUNT_CODES`: 1190, 1199, 1999, 3200, 3290, PPN, tax, FX, lease, benefit, inventory …) may be renamed but never
  moved or removed.
- **The AI chart cache follows**: every change bumps the client's chart version, as *Buat akun baru* does, so cached AI suggestions made
  against the old chart are not reused.
- **Riwayat**: one `ACCOUNT` event per change with before / after.

## Acceptance criteria
- [ ] *Bagan akun* lists every account grouped by report line with code, name, normal side, balance and line count.
- [ ] *Tambah akun* with a name and a report line creates the account with the proposed code; it then appears in the Jurnal
      Penyesuaian account picker and in Review's *Ubah akun*.
- [ ] A typed code that is taken, reserved, or not 3–10 digits is refused with a message saying why.
- [ ] *Ubah* renames an account; Buku Besar, Neraca Saldo and the statements show the new name.
- [ ] Moving an account to another report line of the same type moves it on the Laba Rugi / Neraca; the totals by type don't change.
      Report lines of another type or normal side are not offered (and refused if posted).
- [ ] *Hapus* removes an unused account; for a used one it is refused and the message names what uses it.
- [ ] A bank account or a system account cannot be moved or removed; a viewer sees the page without the buttons.
- [ ] Every change appears in Riwayat perubahan.

## Verify flows
1. Accountant, demo client: Bagan akun → Tambah akun "Beban Sewa Kendaraan" under Beban umum & administrasi → code 6191 proposed →
   save → Jurnal Penyesuaian picker offers 6191.
2. Rename 4100 to "Pendapatan Jasa" → Laporan Keuangan shows it. Move 6190 to Beban penjualan → Laba Rugi line moves, net profit equal.
3. Hapus the new 6191 → gone. Hapus 6100 (used) → refused, names the journal lines.
4. Edge: try code 1999 → refused (reserved). Error: viewer role → no buttons; the action refuses.

## UX notes
- PageHeader *Bagan akun* with the one primary *Tambah akun* (dialog). Sections per statement, each a card of divided rows; a row ends
  with an *Ubah* ghost button opening a dialog (name, report line, Hapus at the bottom when allowed).
- Protected rows show a lock icon + "akun sistem" / "akun bank" label instead of the move/remove options.
- No NextStep banner unless the chart is still only the template (then: "Tambahkan akun yang dipakai klien ini, atau ubah namanya agar
  laporan memakai istilah klien.").

## Test seams
- DB: `lib/coa/manage.ts` create / update / remove — codes, reserved, type guard, references, audit, coaVersion.
- Action: the server actions refuse a VIEWER (role test pattern).
- UI: Playwright walk of flows 1–3 with screenshots.

## Non-goals
- Sub-accounts / account hierarchy (Buku groups by report line; the client's own hierarchy lives in *Akun klien*).
- Archiving (an *inactive* flag needs a migration); changing an account's code or type; bulk import of a chart.

## Assumptions
- AKUNTAN may manage the chart (as they may create accounts during mapping today).

## Gate re-openers
None: no migration (the audit kind is a string), no dependency, no AI call. Permission: uses the existing books.write capability.

## Tasks
- [ ] T1 `lib/coa/manage.ts` (create, update, remove, usage) + DB tests.
- [ ] T2 Server actions + Bagan akun page + dialogs + nav + Riwayat label.
- [ ] T3 verify-local: walk flows 1–4, screenshots, full gate.

## Implementation

## Verification

## Ship Notes
