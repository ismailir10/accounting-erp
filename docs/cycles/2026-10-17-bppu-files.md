# Bukti potong Unifikasi for Coretax (BPPU XML import file)

**Roadmap:** Phase 3 item 3 (second half), *Coretax-ready output files* (`docs/roadmap.md` §5: "Faktur and bupot files the accountant or
a PJAP uploads"). Also firm-lens parity with Mekari Jurnal's *Tax & Coretax* box (Klikpajak covers e-Bupot). This is the follow-up that
[the faktur keluaran cycle](2026-10-17-coretax-files.md) deferred. Buku prepares the file and never files it (ADR 0014; roadmap §6,
*Becoming a PJAP*).

**Approval:** after #173 merged, the owner said to merge on green and keep going (2026-10-17, "merge on green then keep going",
"make sure you have regression test"). That covers the next roadmap cycles, built together: [BPPU files](2026-10-17-bppu-files.md), [Lihat alasan](2026-10-17-lihat-alasan.md), [Otomasi](2026-10-17-otomasi.md) and
[Checklist tutup buku](2026-10-17-checklist-tutup-buku.md). The schema and
permission changes are the ones this spec states under Gate re-openers; anything beyond them stops for the owner.

## Context
Pajak Masa lists every payment the company withheld PPh 23, 4(2) or 22 from. The card *Bukti potong (Unifikasi)* has the table *Dipotong
oleh perusahaan: buat bukti potongnya di Coretax*: contact, NPWP, gross, withheld. A slip export from Coretax (I5d) is tied back to those
lines afterwards. In between, someone creates every slip in Coretax by hand (*e-Bupot → BPPU*). They retype the supplier's NPWP, the tax
object code, the DPP and the reference document for each payment the accountant already booked in Review or in Piutang & Utang. The faktur
cycle closed that gap for faktur keluaran. Bukti potong is the other half of the monthly Coretax typing, and it comes back as the
*bupot* control's *pemotongan di buku tanpa bukti potong* when a slip is missed.

**Who feels it:** the accountant or the client's admin, who make each slip in Coretax for each client that withholds (services, rent,
construction) every month before the SPT Masa PPh Unifikasi. Also the partner, who sees a slip missing or of another kind come back as a
*bupot* difference.

**What Coretax accepts** (read from DJP's own files on 2026-10-17, not from memory; neither file is committed):
- Coretax takes bukti potong Unifikasi in bulk as **one XML file** (*e-Bupot → BPPU → Impor Data*). DJP publishes a sample XML and an
  Excel converter whose embedded XML map carries the schema.
  - Index: https://www.pajak.go.id/en/node/112031 (*Template XML dan Converter*, section BPPU).
  - Sample XML: `bppu.zip` → `bppu.xml` (dated 2024-11-07 on the index), https://pajak.go.id/sites/default/files/2024-12/bppu.zip
  - Converter: `BPPU Excel to XML v.3.xlsx` (2025-09-04), https://pajak.go.id/sites/default/files/2025-09/BPPU%20Excel%20to%20XML%20v.3.xlsx.
    Its sheets are *DATA* (the rows), *BPPU* (column guide and validation notes) and *REF* (Kode Objek Pajak with rates, facility codes,
    document codes). Its XML map embeds an XSD (`id="BPU"`).
- **XML shape** (the sample and the converter's XSD agree on names and order): root `BpuBulk` (namespace `xsi` declared) → `TIN` (the
  withholder's NPWP, `[0-9]{15,16}`) → `ListOfBpu` → `Bpu`+.
  - Each `Bpu`, in this order: `TaxPeriodMonth` (integer, the sample writes `1`), `TaxPeriodYear`, `CounterpartTin`,
    `IDPlaceOfBusinessActivityOfIncomeRecipient`, `TaxCertificate`, `TaxObjectCode`, `TaxBase` (decimal > 0), `Rate` (decimal ≥ 0, dot
    as separator: `2`, `0.5`, `1.75`), `Document`, `DocumentNumber`, `DocumentDate` (yyyy-mm-dd), `IDPlaceOfBusinessActivity`,
    `GovTreasurerOpt`, `SP2DNumber` (the sample writes `<SP2DNumber xsi:nil="true"/>`), `WithholdingDate` (yyyy-mm-dd).
  - **There is no `CounterpartOpt`** in either file, and **no PPh element**: Coretax computes the tax from DPP × Tarif. The converter's
    helper column next to the table is `DPP × Tarif / 100`, and it is not exported.
- **Filling rules** (the converter's *BPPU* sheet):
  - *NPWP Pemotong* (`TIN`) must be the NPWP of the login.
  - *NPWP* (`CounterpartTin`) is "NPWP/NIK penerima penghasilan" and must be valid. The sample has 16-digit NPWPs and NIK-shaped
    numbers, each with *ID TKU* = the number + `000000`.
  - *ID TKU Pemotong* (`IDPlaceOfBusinessActivity`) is the withholder's 22-digit NITKU, given on every slip and not on the root.
  - *Fasilitas* (`TaxCertificate`): `N/A` without a facility. The others are SKB 22/23, SKB bunga, SKB PHTB, DTP, `PP23` and `ETC`, and
    Coretax checks that a named facility is valid.
  - *Tarif* must match the REF rate of the Kode Objek Pajak unless a facility applies.
  - *Jenis Dok. Referensi* is one of the XSD's `DocType` values. When it is `TaxInvoice`, the number must be a valid faktur pajak number
    and the date its faktur date.
  - *Opsi Pembayaran* / *Nomor SP2D* are for government treasurers only (`N/A`, empty).
  - *Tanggal Pemotongan* may not fall before the masa of the slip.
- **Document codes disagree inside DJP's own converter:** the XSD allows `TaxInvoice`, `CommercialInvoice`, `Announchment`, `Contract`,
  `PaymentProof`, `DeedofEngangement`, `DeedofGeneralMeetingStakeholder`, `StatementLetter` and `BankAccountNumber`. The REF sheet spells
  some of them differently (`Announcement`, `DeedOfEngagement`) and adds others (`Other`, `TradeConfirmation`, …). Only `TaxInvoice`,
  `CommercialInvoice`, `Contract`, `PaymentProof` and `StatementLetter` are spelled the same in both.
- **Kode Objek Pajak:** the REF sheet lists 198 codes with rates, e.g. 24-104-03 *Jasa Konsultan* 2, 28-403-02 *Persewaan Tanah dan/atau
  Bangunan* 10, 28-409-22 *Pekerjaan Konstruksi … Kualifikasi Kecil* 1.75, 22-900-01 *Pembelian Barang … oleh BUMN/Badan Usaha
  Tertentu* 1.5. The first group gives the tax, as Buku's slip reader already reads it (24 = PPh 23, 28 = 4(2), 22 = PPh 22).

**What Buku holds vs what the file needs:**

| Field | Buku today | Gap |
|---|---|---|
| `TIN`, `IDPlaceOfBusinessActivity` | `Entity.npwp`, `Entity.nitku` (faktur cycle; default NPWP16 + `000000`) | none (shared with the faktur file) |
| Masa, `WithholdingDate` | the bank line's date (withholding is counted by bank date month, accounting-rules 5h/5k) | none |
| Kind (23 / 4(2) / 22), PPh | `BankTransaction.whtKind`, `whtAmount`: the only record of a withholding; settlements write it there too | none |
| `CounterpartTin`, recipient ID TKU | the line's `contactId` (set by a settlement or *tandai*), `Contact.npwp/nik/nitku` (faktur cycle) | a line withheld in Review often has **no contact** |
| `TaxObjectCode`, `Rate` | none | **new** |
| `TaxBase` (DPP) | none on the line. A settled purchase invoice has `Invoice.dpp`; a PPN split line has only an estimate | **new** |
| `Document`, `DocumentNumber`, `DocumentDate` | none. A settled purchase invoice has `number` and `issueDate` | **new** |
| `TaxCertificate`, `GovTreasurerOpt`, `SP2DNumber` | — | constants (`N/A`, `N/A`, nil) |

## Decisions
- **One file this cycle: the BPPU XML (`BpuBulk`)** for one company and one masa, built from the payments the company withheld from.
  - **Format version:** DJP's `bppu.xml` sample element order and the converter v.3 rules, named in the file's comment and on screen as
    *format DJP bppu.xml / converter v.3, belum diuji dengan unggahan nyata*.
  - **No DJP Excel output.** The converter only adds a step.
- **One slip per withheld bank line.** Candidates are outgoing bank lines (`OUT`) of the masa (by bank date) with PPh 23, 4(2) or 22
  above 0, of a Rupiah PT/CV (`packApplies`). This is the same set as today's *Dipotong oleh perusahaan* table and the *bupot* control's
  book side.
  - Withholding on incoming lines (the customer's slip, *diterima*) is never exported. PPh 21 stays out (BPMP/BP21: `Employee` has no
    NIK or NPWP).
  - A line still in Review is *Diblokir* until it is reviewed.
- **The slip detail lives in a new table, one row per bank line** (KOP, rate, DPP, document type, number, date, and the recipient when
  the line has no contact). It is not stored as columns on `BankTransaction`.
  - `BankTransaction` is the hot, guarded row (transfer guard field list, posting writer). Slip detail is metadata that moves no figure.
  - The row is deleted with its bank line when an import is removed.
  - Like faktur item detail, it may be set in a locked month.
  - It never posts and never changes `whtKind` / `whtAmount`. Those still change only through Review or (un)settling (rule 5h).
- **Recipient** = the line's contact. A line with none (withheld in Review) gets the recipient on the slip row, picked from the client's
  contacts or typed as a new name (the same upsert by name that invoices use). The line itself is not tagged, so the subledger proof and
  `tagAdvance`'s locked-month rule are untouched.
  - Identity comes from the contact, entered once in the faktur cycle's sheet (labelled for a supplier here): NPWP (15/16 digits → 16)
    or else NIK (16 digits). No address is needed for a slip.
  - `CounterpartTin` = NPWP16 or the NIK. ID TKU = `Contact.nitku`, else the number + `000000` (as DJP's sample).
- **Kode Objek Pajak from a short list filtered by the line's kind**, each with DJP's REF rate (rate not editable), plus *Kode lain*:
  - The list, all checked against the REF sheet v.3:
    - PPh 23 at 2 %: 24-104-01 Jasa Teknik, 24-104-02 Jasa Manajemen, 24-104-03 Jasa Konsultan, 24-104-06 Jasa Akuntansi,
      24-104-07 Jasa Hukum, 24-104-17 Outsourcing, 24-104-24 Jasa software/hardware, 24-104-29 Perawatan mesin/peralatan,
      24-104-30 Perawatan kendaraan, 24-104-36 Kebersihan, 24-104-39 Katering, 24-104-56 Pengangkutan/ekspedisi, and 24-100-02 Sewa harta
      selain tanah/bangunan.
    - PPh 23 at 15 %: 24-103-01 Royalti and 24-102-01 Bunga.
    - PPh 4(2): 28-403-02 Sewa tanah/bangunan 10; construction 28-409-22 1.75, 28-409-23 4 and 28-409-24 2.65.
    - PPh 22: 22-900-01 1.5.
  - *Kode lain*: any `NN-NNN-NN` with a typed rate (up to 2 decimals). Coretax validates both.
  - The code's first group must match the line's kind (reuse `kindOf`). Otherwise the row is blocked: "kode 28-… adalah PPh 4(2), mutasi
    mencatat PPh 23".
  - Next month prefills the KOP and document type from the same contact's last slip. The DPP is never carried over.
- **DPP prefill, never a rounded guess:**
  - first, the DPP of the one purchase invoice the line settled with tax withheld, when that DPP × rate holds;
  - else withheld ÷ rate when it divides exactly (e.g. Rp 200.000 at 2 % → Rp 10.000.000);
  - else empty, and the accountant types it.
  A rounded withheld ÷ rate would always pass the check below and hide a wrong DPP (e.g. a PPN-split line, where the DPP is the
  accountant's to state).
- **Tax check:** DPP × rate must equal the line's withheld amount within Rp 1, computed in bigint (rate in hundredths of a percent). The
  file carries no PPh, so this check is what keeps the slip and the books equal. A difference blocks the row with both amounts and points
  to Review for the withheld amount, or to the slip for the DPP.
- **Reference document** is required (Coretax marks it `*`). Four types are offered, all spelled identically in DJP's XSD and REF:
  *Surat Tagihan / Invoice* (`CommercialInvoice`, the default), *Faktur Pajak* (`TaxInvoice`), *Kontrak* (`Contract`), *Bukti
  Pembayaran* (`PaymentProof`).
  - Prefill: the settled invoice's number and issue date, else empty.
  - A `TaxInvoice` number must be 16 or 17 digits. Buku cannot check that the faktur exists.
- **Constants:** `TaxCertificate` `N/A`, `GovTreasurerOpt` `N/A`, `SP2DNumber` nil, `TaxPeriodMonth` without a leading zero, and `Rate`
  as a dot decimal without trailing zeros. Facilities (SKB, DTP, PP 23 Suket) and government treasurers are non-goals. A supplier with a
  Suket PP 23 stays typed in Coretax.
- **Already in Coretax:** a line matched to a counted *dibuat* slip in this masa's bukti potong recon (I5d) is left out and shows *Sudah
  ada di Coretax*. A re-import after the upload ties it, so the round trip closes in Buku, as with faktur.
- **Pre-flight before download:** every candidate is *Siap*, *Diblokir* (every reason, each linking to where it is fixed) or *Sudah ada
  di Coretax*. *Unduh XML BPPU (n bukti potong)* includes the *Siap* rows only and says how many were left out. The company's NPWP or
  NITKU blocks the whole file, as for faktur (shared check).
- **One file, no parts:** DJP publishes no per-file limit for BPPU, and a company has tens of withheld payments a masa, not thousands.
- **Where:** the new list replaces the *Dipotong oleh perusahaan* table inside the existing *Bukti potong (Unifikasi)* card. It is one
  list of the same lines with the same columns plus status, not a second card repeating them. *Dipotong oleh pelanggan* and the recon stay
  as they are, and the Excel kertas kerja is unchanged.
- **Not a sent report.** The download writes `BUKTI_POTONG` ("XML bukti potong … diunduh: n bukti potong"), not `REPORT_EXPORT`, so the
  firm board's *Terkirim* is untouched. Saving slip detail is audited `BUKTI_POTONG` with KOP, DPP and document. A contact's identity
  change keeps the faktur cycle's rule: it names the fields changed, never the values.
- **Who:** downloading needs the Pajak Masa workbook's access (`exportContext`). Editing slip detail needs `books.write` (`writeClient`),
  as recording a withholding does. NIK and NPWP never reach AI.

## Acceptance criteria
- [ ] Pajak Masa for a Rupiah PT with outgoing PPh 23 / 4(2) / 22 lines in the masa shows, in *Bukti potong (Unifikasi)*, the list
      *Dipotong oleh perusahaan* with counts (siap, diblokir, sudah ada di Coretax) and one primary *Unduh XML BPPU (n bukti potong)*,
      disabled at 0.
- [ ] Each blocked row names every reason:
  - line still in Review;
  - no recipient, or the recipient has no NPWP and no NIK, or an NPWP that is not 15/16 digits / a NIK that is not 16;
  - no Kode Objek Pajak, or a KOP whose group is not the line's kind;
  - no DPP, or DPP × rate ≠ withheld (by Rp 1 or more), with both amounts;
  - no document type, number or date, or a faktur pajak number that is not 16/17 digits;
  - the company's NPWP / NITKU, which blocks the whole file.
  Fixing the reason in place turns the row *Siap* without reloading the masa.
- [ ] The slip form prefills the DPP and document from a settled purchase invoice, the DPP from withheld ÷ rate only when that is exact,
      and the KOP and document type from the contact's last slip. Picking a listed KOP sets its rate, and the rate is not editable then.
- [ ] *Unduh XML BPPU* downloads one XML with only the *Siap* rows, in DJP's `bppu.xml` element order: 16-digit `TIN`, the company's
      NITKU on each slip, masa = bank month, `WithholdingDate` = bank date, yyyy-mm-dd dates, `N/A` / `N/A` / nil constants, dot-decimal
      rate, whole-Rupiah DPP, and the document number XML-escaped. Each row's DPP × rate ties to the line's withheld amount within Rp 1.
- [ ] A line matched to a counted *dibuat* slip in the masa's recon is not in the file and reads *Sudah ada di Coretax*. Incoming lines
      and PPh 21 are never in it.
- [ ] An NPWP recipient is written as NPWP16 with its NITKU (default + `000000`), a NIK recipient as the NIK with NIK + `000000`.
- [ ] The download is audited and leaves *Terkirim* untouched. A viewer without access gets 404. Saving slip detail is in Riwayat.
- [ ] The list says the format version and that it still needs a real Coretax upload.
- [ ] Works at 390 px without page scroll sideways. The existing `qa-tax-split` e2e assertions on the card (contact, gross) still hold.
- [ ] Deck claims reviewed in `ship`:
  - `kantor.html` *Pajak* bullet ("file impor faktur keluaran Coretax" → add bukti potong);
  - the *Faktur Coretax dicocokkan* bullet;
  - the limits row "Menerbitkan faktur, menyampaikan SPT";
  - `perusahaan.html` limit rows naming "file impor faktur".

## Verify flows
1. Accountant, local demo client (PT Ayam Nusantara), August 2026:
   - in Piutang & Utang record a purchase invoice from *CV Konsultan A* (NPWP 15 digits), DPP Rp 10.000.000 with PPh 23 expected at
     2 %, and settle it with a payment line (Rp 9.800.000 + Rp 200.000 withheld);
   - in Review give another payment line PPh 4(2) by hand (rent, no contact).
   Open Pajak Masa:
   - the list shows 2 diblokir. The first is prefilled with DPP 10.000.000, *Surat Tagihan* and the
     invoice number; it needs a KOP. The second reads "Penerima belum dipilih", "Kode objek pajak belum dipilih", "DPP belum diisi" and
     "Dokumen referensi belum diisi";
   - pick 24-104-03 on the first; on the second pick a new recipient by name with a NIK, 28-403-02 (10 %), DPP and a contract;
   - both turn *Siap*. Download, open the XML: two `Bpu` in DJP order, rates `2` and `10`, the NIK recipient with NIK + `000000`.
2. Import a Coretax *bukti potong dibuat* export holding the first slip (I5d). The list now shows it as *Sudah ada di Coretax*, and the
   next XML holds only the second.
3. Edge: a payment with PPN split and PPh 23 typed in Review (no exact withheld ÷ rate). The DPP stays empty; typing a DPP off by Rp 5 of
   the formula blocks the row with both amounts; correcting it clears it. A masa with no company withholding → the list says there is
   nothing to prepare.
4. Error: a company with no NPWP → the whole list is blocked with a link to the company settings. An unknown client on the download URL →
   404. A KOP of PPh 4(2) on a PPh 23 line → blocked with the kind reason.

## UX notes
- Pajak Masa, card *Bukti potong (Unifikasi)*, first block *Dipotong oleh perusahaan*:
  - **First thing seen:** the three counts and one primary *Unduh XML BPPU (n bukti potong)*.
  - **Rows:** *Diblokir* first, then *Siap*, then *Sudah ada di Coretax* folded. Each row shows date, description, recipient, KOP,
    gross, withheld and DPP.
  - **Blocked rows:** each reason links to its fix. *Atur bukti potong* opens a sheet with recipient, KOP (select, filtered by the kind;
    *Kode lain* reveals code + rate), DPP (with the formula line "2% × DPP = Rp …, buku Rp …"), and document type, number and date.
    *Lengkapi identitas* opens the faktur cycle's identity sheet, labelled *penerima penghasilan*. *Buka di Review* fixes the withheld
    amount or kind.
  - **Footnote:** *Format impor DJP bppu.xml (converter v.3), belum diuji dengan unggahan nyata. Unggah lewat Coretax → e-Bupot → BPPU →
    Impor Data; Buku tidak mengirim ke DJP.* Plus a hint: *SPT Masa PPh Unifikasi paling lambat 20 <bulan berikutnya>*, a hint and
    never a block.
- Empty state: *Tidak ada pemotongan oleh perusahaan masa ini.* (today's copy).
- Copy in Bahasa. Element names and codes appear only in the file (KOP codes also in the select, next to their names).

## Test seams
- Unit (pure XML builder):
  - a golden file for a fixed company and three slips (NPWP recipient, NIK recipient, a document number with `&` and `<`);
  - the tag sequence equals DJP's sample, through our transcription `tests/fixtures/coretax/djp-bppu-shape.xml` with placeholder values
    (as the faktur cycle did; DJP's file itself is not committed);
  - rate formatting (2, 0.5, 1.75, 2.65), and the DPP × rate check in bigint at edges (1, 999,999, 10^12; within / off by Rp 1).
- Unit (pre-flight rules and prefill): every block reason; the KOP-kind agreement; the exact-division prefill and its refusal to round.
- DB:
  - the candidate set: incoming, PPh 21, other masa, zero and other-company lines left out; recon-matched lines are *Sudah ada*;
  - prefill from a settled invoice and from the contact's last slip;
  - slip writes audited, scoped to the client, refused for a line of another client, allowed in a locked month;
  - the slip row goes with its bank line when the import is removed.
- Route: XML for a member, 404 for a stranger or a revoked session (added to `tests/db/session-revocation.test.ts`), no `REPORT_EXPORT`.
- UI: Playwright walk of flows 1 and 3 with screenshots; `qa-tax-split` still green.

## Non-goals
- Sending anything to Coretax or a PJAP, signing, or keeping a slip number (ADR 0014).
- PPh 21/26 (BPMP, BP21, BP26, BPA1/A2), BPNR (non-residents), BPSP, digunggung (BPCY), DDBU.
- Facilities (SKB 22/23, DTP, Suket PP 23, ETC), government treasurer payments (SP2D).
- Withholding booked by journal only (Jurnal / accrual on 2141 / 2145 with no bank line): the list notes that such slips are made in
  Coretax directly.
- Several slips for one bank line, or one slip for several lines. Document types outside the four, and checking that a faktur pajak
  exists. The DJP Excel as output.
- The demo scenario (its withholdings come from QA fixtures; `verify:books` unchanged).

## Assumptions
- **The format is per DJP's `bppu.xml` sample and the converter v.3 XSD. A real Coretax upload by the pilot firm must confirm it before
  it is called done** (roadmap Phase 3 item 3). Until then the list says so. If the upload fails, Coretax's error list sets a fix round.
- `CounterpartOpt`, named in the request, is in neither DJP file and is not written. To be confirmed on the real upload.
- A NIK goes in `CounterpartTin` as is, with NIK + `000000` as its ID TKU (the converter's "NPWP/NIK" and DJP's sample). A 15-digit NPWP
  is written as 16 with a leading `0` (`TinType` allows 15, but the sample writes 16).
- Coretax's own rounding of DPP × rate (down or half up) is within Rp 1 of the withheld amount whenever Buku's check passes.
- The REF rate is what Coretax expects for a listed code without a facility. A supplier without NPWP or NIK cannot be put in the file
  at all, so the 100 % higher PPh 23 rate never arises here.
- The masa of a slip is the bank date's month, as the books and the recon count it. A withholding owed at accrual in an earlier month is
  a Coretax correction, not this file.
- One reference document per line is enough. A payment settling two invoices of one supplier carries the accountant's chosen reference.

## Gate re-openers
- **Migration (additive):** a new table `WithholdingSlip` (`bankTransactionId` unique, FK cascade on delete; `contactId` nullable, FK set
  null; `kop`, `rate` in hundredths of a percent, `dpp`, document type / number / date, `firmId`/`clientId`/`entityId`, `updatedById`,
  `updatedAt`), with CHECKs `dpp > 0` and `0 < rate <= 10000`. No change to an existing column, no backfill.
- **PII:** the supplier's NIK (individual recipients) is already stored (faktur cycle). It is now also written into this file. It is never
  sent to a model, never put in the demo or Git, and never in an audit summary.
- **Sensitive path:** new server actions in `app/actions.ts` (slip detail; the identity action reused), each through `requireCapability`
  via `writeClient`; a new download route beside `tax/masa/coretax`.
- No accounting invariant changes: nothing posts, and the withholding stays the bank line's (rule 5h). Add one line to accounting-rules
  5k for the export.
- No new dependency (the faktur cycle's escaping XML writer is reused), no AI call, no report number moves. The `e2e` label applies (an
  app flow).

## Tasks
- [x] T1 Migration + `lib/tax/bppu-codes.ts` (the short KOP list with DJP REF rates, document types, rate parse/format in hundredths) +
      `setWithholdingSlip` (recipient pick or new name, KOP, rate, DPP, document; audited `BUKTI_POTONG`) — accept: DB
      tests for validation, scoping, locked month allowed, cascade with the bank line. (Reuse: `kindOf`, `upsert` of invoices' contacts.)
- [x] T2 `lib/tax/coretax-bppu-xml.ts`, a pure builder (company + rows → `BpuBulk` XML) with the rate formatting and the bigint tax check;
      golden fixture + DJP shape tag-order test — accept: unit tests green. (Parallel with T1; reuse the faktur builder's escaping.)
- [x] T3 `lib/tax/coretax-bppu.ts` `bppuDraft` (candidates, *Sudah ada* via `bupotRecon` DIBUAT matches, prefill from settled invoice /
      exact division / last slip, every block reason; the company identity check shared with `coretax-faktur.ts`) — accept: DB tests for
      every inclusion, prefill and block rule. (Deps: T1, T2.)
- [x] T4 Download route `tax/masa/coretax-bppu` (`?entity&period`), `recordBupotDownload`, server action, identity sheet's holder label
      — accept: route DB tests (member 200, stranger and revoked 404, no `REPORT_EXPORT`). (Deps: T3.)
- [x] T5 The *Dipotong oleh perusahaan* list in *Bukti potong (Unifikasi)* with counts, the slip sheet, the identity sheet, the download,
      footnote and hint; README Pajak Masa line — accept: Playwright flows 1 and 3, `qa-tax-split` green. (Deps: T4.)
- [ ] T6 verify-local: walk flows 1–4, open the XML against DJP's sample, screenshots at 1440 and 390 px, full gate.

## Implementation
- Plan: T1–T5 sequential, inline in one build worker (the driver gave this worker the whole cycle; T3–T5 share `lib/tax`, `app/actions.ts`
  and the Pajak Masa page, and T2's builder is small). T6 (verify-local, the Playwright run) by the driver.
- T1: `prisma/migrations/20261018100000_withholding_slip`, `prisma/schema.prisma`, `lib/tax/bppu-codes.ts`, `lib/tax/withholding-slip.ts`,
  `lib/tax/bupot-read.ts`, `lib/clients/delete.ts`, `tests/db/withholding-slip.test.ts`, `tests/unit/bppu-codes.test.ts` — the
  `WithholdingSlip` table (one row per bank line, cascade with it; CHECKs `dpp > 0`, `0 < rate <= 10000`, KOP and rate paired), DJP's
  short KOP list with REF v.3 rates, the four document types, rate parse/format in hundredths, the bigint tax check (`taxTies`) and the
  exact-division DPP (`exactDpp`); `setWithholdingSlip` (recipient picked or a new name upserted, KOP with DJP's rate or *Kode lain* with
  a typed one, DPP, document; audited `BUKTI_POTONG`, subject `slip:<line>`); client deletion removes the slips.
  - Decision: every slip field may be saved empty (a partial save is allowed); the pre-flight names what is still missing. A KOP of
    another kind is stored and blocked by the pre-flight with the kind reason (flow 4), not refused at save.
  - Decision: the KOP-group → kind mapping moved into `bppu-codes.ts` (`kopKind`, pure, safe for the client form); `kindOf` of the slip
    reader calls it, so the reader and the export read a code the same way.
  - Decision: a line already tied to a contact keeps it as the recipient; naming another on the slip is refused (change it in Piutang &
    Utang), and the slip stores no contact then.
- T2: `lib/tax/coretax-bppu-xml.ts`, `lib/tax/coretax-faktur-xml.ts`, `tests/unit/coretax-bppu-xml.test.ts`, `tests/fixtures/coretax/` —
  the pure builder (`BpuBulk`, DJP's `bppu.xml` element order and header, tab-indented, `SP2DNumber` as `xsi:nil`), constants `N/A` /
  `N/A` / nil, masa without a leading zero, dot-decimal rate without trailing zeros, whole-Rupiah DPP, and a refusal of any row whose
  DPP × rate is Rp 1 or more off the withheld amount (bigint). The faktur builder's escaping writer is shared (`writeXml`, which now writes
  a null value as `xsi:nil="true"`); the faktur golden file is unchanged. The golden file was checked by hand.
  - Decision: `djp-bppu-shape.xml` is our transcription of DJP's sample (element names and order, placeholder values), checked
    tag-for-tag against DJP's `bppu.xml` on 2026-10-17; DJP's file itself is not committed (as in the faktur cycle).
- T3: `lib/tax/coretax-bppu.ts`, `lib/tax/coretax-faktur.ts`, `tests/db/coretax-bppu.test.ts`, `.agents/skills/accounting-rules/SKILL.md`
  — `bppuDraft` (candidates: the masa's outgoing lines by bank date with PPh 23 / 4(2) / 22 above 0 of a Rupiah PT/CV; *Sudah ada di
  Coretax* from `bupotRecon`'s *dibuat* matches; the prefill; every block reason with where it is fixed: Review, the slip sheet, the
  recipient's identity sheet or the company) and `bppuFile` (the *Siap* rows; none while the company blocks). The company identity check
  is shared with the faktur file (`companyIdentity`, which names the file: "faktur" / "bukti potong"). Rule 5k names the export.
  - Decision: no withheld ÷ rate prefill on a line whose PPN was split (`taxTag` PPN): at 2 % every whole-Rupiah withholding divides
    exactly, so the division would always "succeed" and hide that the DPP is the accountant's to state (flow 3 expects it empty).
  - Decision: the settled invoice's DPP is prefilled while no KOP is chosen (flow 1 shows it before the KOP); once a rate is known it is
    kept only when DPP × rate ties.
  - Decision: the last slip's KOP is carried to a recipient's next line only when it is of the line's kind, with its document type
    (never its number, date or DPP).
  - Decision: an in-review line is listed with *every* reason (Review first), so the slip can be prepared while Review is pending.
- T4: `app/(app)/clients/[id]/tax/masa/coretax-bppu/route.ts`, `lib/reports/export-log.ts`, `app/actions.ts`,
  `lib/receivables/faktur-identity.ts`, `lib/tax/coretax-codes.ts`, `tests/db/coretax-bppu-route.test.ts`,
  `tests/db/session-revocation.test.ts` — the download (`?entity&period`, the workbook's access through `exportContext`; 400 with the
  reason when nothing is *Siap* or the company blocks; file `bppu-<company>-YYYY-MM.xml`), audited by `recordBupotDownload`
  (`BUKTI_POTONG`, subject `coretax-bppu:<entity>:YYYY-MM`, a support session to the support log through the shared `logDownload`);
  `setWithholdingSlipAction` through `writeClient` (`books.write`); `setContactTaxIdentityAction` takes `holder` (*pembeli* /
  *penerima*) so the identity sheet's messages name the recipient.
- T5: `components/app/coretax-bppu.tsx`, `components/app/coretax-faktur.tsx`, `app/(app)/clients/[id]/tax/masa/page.tsx`,
  `lib/tax/coretax-bppu.ts`, `e2e/coretax-bppu.spec.ts`, `README.md` — the list replaces the *Dipotong oleh perusahaan* table inside
  *Bukti potong (Unifikasi)*: the three counts and one primary *Unduh XML BPPU (n bukti potong)* (disabled at 0 or while the company
  blocks, with the company alert and *Lengkapi data perusahaan*), what was left out, rows *Diblokir* first with every reason and its fix
  (*Atur bukti potong* sheet, *Lengkapi identitas* = the faktur cycle's identity sheet labelled *penerima penghasilan*, *Buka di Review*
  for a line in Review, a tax difference or a kind mismatch), *Siap* and *Sudah ada di Coretax* folded; each row shows date, description,
  kind, recipient, KOP, gross, withheld and DPP (phones: under the description). The footnote names the format as untested, the upload
  path, that journal-only withholding is typed in Coretax, and the SPT hint (20th of the next month, a hint, never a block). A viewer (or a
  support session) sees the list and the download, no edit buttons. The e2e spec walks flows 1–3 (written, not run here: the driver runs
  Playwright).
  - Decision: the identity sheet became `IdentityForm` (exported from `coretax-faktur.tsx`) with a `holder` prop; for a recipient it asks
    NPWP / NITKU / NIK only (no address or email: a slip needs none). The faktur e2e labels are unchanged.
  - Decision: the slip form fills an empty DPP with the exact withheld ÷ rate when a listed KOP is picked (not on a PPN-split line), the
    same rule the pre-flight applies, so flow 1's rent shows its DPP as soon as 28-403-02 is chosen.
  - Decision: the Excel kertas kerja's *Bukti Potong* sheet is unchanged (as the spec says).
- `npm run build` could not run in this worktree (Turbopack refuses the symlinked `node_modules`); lint and typecheck are green, and the
  build is part of the driver's full gate.
- **Acceptance criteria → tests:**
  - Counts and the one primary download, disabled at 0 → `e2e/coretax-bppu.spec.ts` (counts 3/0/0, *Unduh XML BPPU (0 bukti potong)*
    disabled, then 3 and 2), `tests/db/coretax-bppu.test.ts` *candidates* (counts).
  - Every block reason → `tests/db/coretax-bppu.test.ts`: in Review (*candidates*), no recipient (*candidates*), no NPWP/NIK, bad NPWP,
    NITKU, NIK, KOP of another kind, DPP × rate off with both amounts, faktur number not 16/17 digits (*block reasons*), no KOP / DPP /
    document (*candidates*), the company's NPWP and NITKU (*block reasons*; `tests/db/coretax-bppu-route.test.ts` 400 with the reason).
    Fixed in place without reloading → e2e (each row's `data-status` turns READY after the sheet saves; flow 3's Rp 5 difference shows
    both amounts, then clears).
  - Prefill (settled bill's DPP and document, exact withheld ÷ rate only, never on a PPN split, KOP and document type from the last slip,
    never its DPP; a listed KOP's rate not editable) → `tests/db/coretax-bppu.test.ts` *prefill*, `tests/unit/bppu-codes.test.ts`
    (`exactDpp` refuses to round), e2e (DPP 10.000.000 and B-77 from the bill, *Tarif 2% sesuai referensi DJP.* with no rate input, the
    rent's DPP on picking 28-403-02, the PPN-split DPP left empty).
  - The XML (Siap rows only, DJP order, 16-digit TIN, NITKU per slip, masa = bank month, WithholdingDate = bank date, yyyy-mm-dd, N/A /
    N/A / nil, dot-decimal rate, whole-Rupiah DPP, escaped document number; DPP × rate ties within Rp 1) →
    `tests/unit/coretax-bppu-xml.test.ts` (golden file, DJP shape, constants, rates, the tie refusal at edges), `tests/unit/bppu-codes.test.ts`
    (`taxTies` at 1, 999.999, 10^12), `tests/db/coretax-bppu.test.ts` (*writes the Siap rows only*), e2e (the downloaded file).
  - *Sudah ada di Coretax*; incoming lines and PPh 21 never in the file → `tests/db/coretax-bppu.test.ts` (*candidates*: both tests),
    e2e flow 2 (import a *dibuat* slip, the row reads *Sudah ada di Coretax: bukti potong 2600000123.*, the next file has 2 slips).
  - NPWP recipient as NPWP16 + NITKU (default + 000000), NIK recipient as NIK + 000000 → `tests/db/coretax-bppu.test.ts`, the golden
    file, e2e.
  - Download audited, *Terkirim* untouched, a viewer without access 404, slip saving in Riwayat → `tests/db/coretax-bppu-route.test.ts`
    (BUKTI_POTONG events, no REPORT_EXPORT, no NIK in any event, unassigned Akuntan and another firm 404, a Peninjau downloads and is
    refused the write), `tests/db/session-revocation.test.ts` (the route in every revocation case), `tests/db/withholding-slip.test.ts`
    (the slip's event), e2e (Riwayat shows both; an unassigned member gets 404; a Peninjau downloads, sees no edit button).
  - Format version and the untested upload on the list → e2e (footnote), `tests/unit/coretax-bppu-xml.test.ts` (the file's comment).
  - 390 px without sideways scroll → e2e, on every run: the list, the slip sheet open, the Peninjau's view and the empty masa.
    `qa-tax-split`'s assertions on the card (description, gross) are untouched and hold: the rows show both.
  - Deck claims → reviewed in `ship` (not a test).

## Verification

## Ship Notes
