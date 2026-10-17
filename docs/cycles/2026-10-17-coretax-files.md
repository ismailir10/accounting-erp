# Faktur keluaran for Coretax (XML import file)

**Roadmap:** Phase 3 item 3, *Coretax-ready output files* (`docs/roadmap.md` §5), and firm-lens parity with Mekari Jurnal's *Tax &
Coretax* box (owner's choice, 2026-10-17). Buku prepares the file and never files it (ADR 0014; roadmap §6, *Becoming a PJAP*).

**Approval:** the owner approved building the four firm-lens cycles on 2026-10-17 ("go ahead, build all four without stopping"):
[credit limits and reminders](2026-10-17-pengingat-piutang.md), [Wawasan](2026-10-17-wawasan-keuangan.md), this one and
[Kotak Persetujuan](2026-10-17-kotak-persetujuan.md). Open choices settled by the driver: bukti potong (BPPU) waits for its own cycle,
because Buku does not hold the tax object code, DPP and rate a slip needs; the buyer's NIK and address are stored as this spec states,
and never reach AI.

## Context
Today Buku reads Coretax and does not write to it. Pajak Masa imports the *Daftar Faktur Keluaran / Masukan* and the bukti potong lists.
It ties them to the GL (ekualisasi PPN, I5c/I5d), and it can book a missing faktur as an invoice (I5e). Coretax import works the other
way round. When a client sells with PPN, someone creates every faktur keluaran in Coretax by hand: they retype the buyer, the item, the
DPP and the PPN from the invoices the accountant already recorded in *Piutang & Utang*. Jurnal sends the same data to Coretax through
Klikpajak, its PJAP. Zahir only exports e-Faktur CSV, and e-Faktur closed when Coretax opened. Buku has the invoices and does nothing with them.

**Who feels it:** the accountant or the client's admin, typing faktur one by one into Coretax for each PKP client every month. Also the
partner, who sees typing errors come back a month later as an ekualisasi *selisih*.

**What Coretax accepts** (read from DJP's own files on 2026-10-17, not from memory):
- Coretax takes faktur keluaran in bulk as **one XML file** (*e-Faktur → Faktur Keluaran → Impor Data*), up to 1,000 faktur per file.
  CSV is no longer accepted. DJP publishes an Excel template and a Windows converter that turns the Excel into that XML.
  - Index: https://www.pajak.go.id/en/node/112031 (*Template XML dan Converter*).
  - Sample XML: `Sample Faktur PK Template v.1.4.xml` (2025-03-01), https://pajak.go.id/sites/default/files/2025-03/Sample%20Faktur%20PK%20Template%20v.1.4.xml.zip
  - Converter and Excel template: `ConverterEfakturCoretax v1.6` (release notes dated 2025-07-22) with `Sample Faktur PK Template v.1.6.1.xlsx`,
    https://pajak.go.id/sites/default/files/2026-01/ConverterEfakturCoretax__v1.6.zip
  - The sample cites `TaxInvoice.xsd`, but DJP does not publish that schema.
- **XML shape** (v1.4 sample, element order as written there): root `TaxInvoiceBulk` → `TIN` (seller NPWP, 16 digits) → `ListOfTaxInvoice`
  → `TaxInvoice`*.
  - Each `TaxInvoice`: `TaxInvoiceDate` (yyyy-mm-dd), `TaxInvoiceOpt` (`Normal`), `TrxCode`, `AddInfo`, `CustomDoc`, `CustomDocMonthYear`,
    `RefDesc`, `FacilityStamp`, `SellerIDTKU`, `BuyerTin`, `BuyerDocument`, `BuyerCountry`, `BuyerDocumentNumber`, `BuyerName`,
    `BuyerAdress` (DJP's spelling), `BuyerEmail`, `BuyerIDTKU`, `ListOfGoodService`.
  - `ListOfGoodService` holds one or more `GoodService`: `Opt` (A barang / B jasa), `Code`, `Name`, `Unit`, `Price`, `Qty`,
    `TotalDiscount`, `TaxBase`, `OtherTaxBase`, `VATRate`, `VAT`, `STLGRate`, `STLG`.
- **Filling rules** (the template's *Keterangan* sheet, v1.6.1):
  - **Seller:** *ID TKU Penjual* is the 22-digit NITKU.
  - **Buyer with an NPWP:** *NPWP/NIK Pembeli* is that NPWP and *Jenis ID* is `TIN`. *Nomor Dokumen* is `-`. *ID TKU Pembeli* is the
    buyer's 22-digit NITKU. For a TIN buyer, Coretax prefills name and address from its own records.
  - **Buyer without an NPWP:** *Jenis ID* is `National ID`, `Passport` or `Other ID`. *NPWP/NIK Pembeli* is `0000000000000000`, the ID
    goes in *Nomor Dokumen*, and *ID TKU Pembeli* is `000000`.
  - **Country:** the code comes from the template's *REF-KodeNegara* list; Indonesia is `IDN`.
  - **Facility codes:** `AddInfo` and `FacilityStamp` are required for kode transaksi 07 and 08 only.
  - **Amounts:** at most 2 decimals, commercial rounding. *Total Diskon* is 0 when there is none.
  - **DPP Nilai Lain:** equals the DPP when no other base applies.
  - **PPN:** = tarif × DPP Nilai Lain, and only kode transaksi 01, 04 and 09 must use exactly that value.
  - **PPnBM:** 0 when there is none.
  - **Item code:** `000000` is accepted when no Kode Barang/Jasa fits (DDTC, 2025: news.ddtc.co.id/berita/nasional/1813280). The name
    then carries the detail.
- **PPN at 12 % (PMK 131/2024):** for ordinary (non-luxury) supplies, the v1.6.1 template's own sample uses kode transaksi **04 (DPP
  Nilai Lain)**: DPP Nilai Lain = 11/12 × DPP and *Tarif PPN* = **12**. The template accepts only the whole number 12 in that column. The
  result is PPN = 11 % of the DPP, the same as Buku's effective rate (accounting-rules 8). DDTC confirms the code: "Kode faktur yang
  dicantumkan dalam faktur pajak adalah 04" (news.ddtc.co.id/berita/nasional/1808027, 2025-01-05).
- **Coretax numbers the faktur itself** on import and signing. The file carries no faktur number, only a free *Referensi* (`RefDesc`).

**What Buku holds vs what the file needs:**

| Field | Buku today | Gap |
|---|---|---|
| Seller NPWP (`TIN`) | `Entity.npwp`: 15 digits (formatted) or 16 | 15 → 16 by a leading `0` (as `npwpDigits` already reads it) |
| Seller NITKU | none | head office = NPWP16 + `000000`; branches can't be expressed |
| Buyer NPWP | `Contact.npwp`: free text, not checked (`createInvoice` only trims it) | digits checked at export |
| Buyer NIK, NITKU, address, email | none | **new nullable columns** |
| Faktur date, *Referensi* | `Invoice.issueDate`, `Invoice.number` | — |
| Item: Barang/Jasa, Kode, Satuan, name | one `description`, no item lines | **new nullable columns**; one item per faktur |
| DPP, PPN | `Invoice.dpp`, `Invoice.ppn` (whole Rupiah; PPN may be typed) | PPN must equal 12 % × 11/12 × DPP to the Rupiah |

## Decisions
- **One file this cycle: faktur keluaran XML** for one company and one masa. It is what Coretax imports, and it saves the most typing.
  - **Format version:** the DJP sample v1.4 element order and the v1.6.1 template rules, named in the file's comment and on screen as
    *format DJP v1.4 / template 1.6.1, belum diuji dengan unggahan nyata*.
  - **No DJP Excel template output.** The converter only adds a step.
- **Bukti potong (BPPU) is the next cycle, not this one.** The `BpuBulk` XML (DJP `bppu.zip`, 2024-11-07; converter
  `BPPU Excel to XML v.3.xlsx`, 2025-09-04) needs per slip:
  - Kode Objek Pajak, DPP and Tarif (Coretax computes the PPh; the file has no PPh field);
  - the recipient's NPWP/NIK and NITKU;
  - a reference document (type, number, date) and the withholding date.
  Buku's withholding on a bank line holds only the kind (23, 4(2), 22) and the amount. There is no KOP, no DPP when PPN was split, and no
  rate. That needs its own data entry and its own pilot check. PPh 21 (BPMP/BP21) stays out: `Employee` has no NIK or NPWP, and the
  census wage is not the paid gross.
- **Source = sales invoices only.** An invoice is in the file when all of these hold:
  - it is *Piutang* (SALES), not voided, not a Saldo Awal item;
  - its issue date falls in the masa and its PPN is above 0;
  - it belongs to a Rupiah PT/CV (`packApplies`).
  Bank lines with an estimated PPN split (rule 8) are never exported: they have no buyer and no faktur-grade DPP. The card lists them as
  *PPN dari mutasi bank: catat sebagai faktur penjualan dulu*.
- **An invoice already in Coretax is left out.** This covers a counted Coretax faktur keluaran matched to the invoice in this masa's
  ekualisasi, or an invoice made from a faktur (I5e). The card shows it as *Sudah ada di Coretax*. A re-import after the upload ties it
  through the existing ekualisasi, so the round trip closes in Buku.
- **Kode transaksi 04, DPP Nilai Lain** for every row. DPP Nilai Lain = 11/12 × DPP, to the sen, half up. VATRate 12, and VAT = 12 % ×
  DPP Nilai Lain to the sen. *Pre-flight* blocks a row whose VAT differs from the invoice's PPN by Rp 1 or more, because for 04 Coretax
  takes only the formula. Other codes (01 luxury, 02/03 pemungut, 07/08 facilities) are blocked with a message: *kode transaksi selain
  04 belum didukung*.
- **Buyer identity lives on the contact**, entered once and reused every month:
  - NPWP (checked: 15 or 16 digits), or else NIK (16 digits) with an address;
  - NITKU (22 digits; prefilled NPWP16 + `000000`, which can be changed for a branch);
  - address and email (optional for an NPWP buyer).
  - An NPWP buyer goes out as `TIN`. A NIK buyer goes out as `National ID` with `0000000000000000`, the NIK as the document number, and
    `000000`. Passport and foreign buyers are blocked (non-goal).
- **Seller NITKU** = the entity's NPWP16 + `000000` unless one is typed on the entity (new optional field).
- **One item per faktur.** Each invoice gets Barang/Jasa, Kode Barang/Jasa (default `000000`), Satuan (a code from the template's
  *Satuan Ukur* list) and a name (default: the invoice description).
  - The amounts are Qty 1, Price = DPP, Discount 0, and PPnBM 0 at rate 0.
  - The card sets these in one form for every listed invoice, with *Terapkan ke semua*, and saves them on the invoice. Next month
    prefills from the contact's last invoice.
  - Multi-line faktur are a follow-up.
- **Pre-flight before download:** each candidate invoice is *Siap*, *Diblokir* (with every reason, each linking to where it is fixed) or
  *Sudah ada di Coretax*. *Unduh XML* includes the *Siap* rows only and says how many were left out. With more than 1,000 rows, the
  file is offered in parts of 1,000.
- **Not a sent report.** The download writes an audit event (kind `FAKTUR`, "XML faktur keluaran … diunduh: n faktur"). It does not
  write *Laporan diunduh* / `REPORT_EXPORT`, so the firm board's *Terkirim* is untouched.
- **Who:** downloading needs the same access as the Pajak Masa workbook. Editing buyer identity and item detail needs the capability
  that records invoices. The file and the identity fields hold personal data (NIK, address), so no AI ever sees them.

## Acceptance criteria
- [ ] Pajak Masa for a Rupiah PT with sales invoices in the masa shows a card *Faktur keluaran untuk Coretax*. It shows counts: siap,
      diblokir, sudah ada di Coretax.
- [ ] Each blocked row names every reason:
  - NPWP and NIK both empty, or an NPWP that is not 15/16 digits;
  - NIK without an address;
  - NITKU not 22 digits;
  - no Barang/Jasa or Satuan;
  - PPN ≠ 12 % × 11/12 × DPP;
  - a company without an NPWP, which blocks the whole file.
  Fixing the reason in place turns the row *Siap* without a reload of the masa.
- [ ] *Unduh XML* downloads one XML with only the *Siap* invoices, in the DJP element order. Seller TIN is 16 digits and every date is
      yyyy-mm-dd. TrxCode is 04, `RefDesc` = the invoice number, and Indonesia is `IDN`. Name and address are XML-escaped. Each row's
      DPP, DPP Nilai Lain, VAT 12 and PPN tie to the invoice.
- [ ] An invoice matched to a counted Coretax faktur in the masa's ekualisasi is not in the file and reads *Sudah ada di Coretax*.
- [ ] A NIK buyer is written as `National ID` with `0000000000000000` and `000000`. An NPWP buyer is written as `TIN` with its NITKU.
- [ ] More than 1,000 *Siap* rows → the file comes in parts of at most 1,000.
- [ ] The download is audited and leaves the firm board's *Terkirim* untouched. A viewer without access gets 404.
- [ ] The card says the format version and that it still needs a real Coretax upload. Bank-line PPN with no invoice is listed apart
      and never exported.
- [ ] Works at 390 px without page scroll sideways.
- [ ] Deck claims reviewed in `ship`:
  - `kantor.html` *Pajak* bullet ("Kertas kerja Pajak Masa untuk Coretax");
  - the *Faktur Coretax dicocokkan* bullet;
  - the "Kasir, faktur, dan penggajian tetap dipakai" line (Buku now prepares the faktur file but issues no customer invoice).

## Verify flows
1. Accountant, local demo client (PT Ayam Nusantara), August 2026: in Piutang & Utang record two sales invoices with PPN. Buyer A has a
   15-digit NPWP. Buyer B has none. Open Pajak Masa:
   - the card shows 1 siap and 1 diblokir ("NPWP atau NIK pembeli belum diisi");
   - fill B's NIK and address, and set Jasa / `000000` / Satuan *Kegiatan* for both;
   - both turn *Siap*. Download, open the XML: two `TaxInvoice`, B as `National ID`, totals tie.
2. Import a *Daftar Faktur Keluaran* holding buyer A's faktur (I5c). The card now shows A as *Sudah ada di Coretax*, and the next XML
   holds only B.
3. Edge: an invoice whose PPN was typed at 12 % of the DPP → blocked with the PPN reason; correcting the invoice (void + re-record)
   clears it. A month with no sales invoice → the card says there is nothing to prepare and points to Piutang & Utang.
4. Error: a company with no NPWP → the whole card is blocked with a link to the client's company settings. An unknown client on the
   download URL → 404.

## UX notes
- Pajak Masa, a card after *Ekualisasi PPN (Coretax)*, titled *Faktur keluaran untuk Coretax*.
  - **First thing seen:** the three counts and one primary *Unduh XML (n faktur)*, disabled at 0.
  - **Under it:** the rows grouped *Diblokir* first, then *Siap*, then *Sudah ada di Coretax*, each with invoice number, date, buyer,
    DPP and PPN.
  - **Blocked rows:** each reason is a link or an inline action, *Lengkapi pembeli* (sheet: NPWP / NIK, NITKU, alamat, email) or *Atur
    barang/jasa*. A bulk *Atur barang/jasa untuk semua* sits above the list.
  - **Footnote:** *Format impor DJP v1.4 (template 1.6.1). Unggah lewat Coretax → e-Faktur → Faktur Keluaran → Impor Data; Buku tidak
    mengirim ke DJP.*
- Empty state: *Belum ada faktur penjualan ber-PPN di masa ini.* plus a link *Buka Piutang & Utang*.
- Copy in Bahasa. Element names and codes appear only in the file.

## Test seams
- Unit (pure XML builder):
  - a golden file for a fixed company + three invoices (NPWP buyer, NIK buyer, a name with `&` and `<`);
  - the tag sequence equals DJP's v1.4 sample's;
  - the 11/12 and 12 % arithmetic in bigint sen at edge DPPs (1, 11, 999,999, 10^12);
  - the 1,000 split.
  DJP's sample sits in `tests/fixtures/` as the reference for the order check. It is a public DJP file holding no client data.
- Unit (pre-flight rules): every block reason; NPWP 15 → 16; default NITKU.
- DB: the candidate set (voided, opening, purchase, other masa and zero PPN left out; matched-to-Coretax faktur excluded), and the contact
  and item updates audited and scoped to the client.
- Route: XML for a member, 404 for a stranger or a revoked session (added to `tests/db/session-revocation.test.ts`); no
  `REPORT_EXPORT` written.
- UI: Playwright walk of flows 1 and 3 with screenshots.

## Non-goals
- Sending anything to Coretax or a PJAP, signing, or keeping a faktur number (ADR 0014).
- Bukti potong Unifikasi (BPPU), PPh 21 (BPMP/BP21), retur, Lampiran C, faktur masukan, dokumen lain: later cycles.
- Kode transaksi other than 04, PPnBM, uang muka / pelunasan faktur, passport and foreign buyers, branches as sellers beyond a typed
  NITKU, multi-line faktur.
- A customer-facing invoice document (PDF): invoicing stays the client's tool (roadmap §6).
- The DJP Excel template as output; the demo scenario (it has no sales invoices; `verify:books` unchanged).

## Assumptions
- **The format is per DJP sample v1.4 / template v1.6.1 and must be confirmed with a real Coretax upload by the pilot firm before it
  is called done** (roadmap Phase 3 item 3). Until then the card says so. If the pilot's upload fails, the error list Coretax returns
  sets a fix round.
- DJP's sample XML writes `BuyerCountry` `IND`, which is India in DJP's own *REF-KodeNegara*. Buku writes `IDN` (Indonesia, the v1.6.1
  Excel sample). To be confirmed on the real upload.
- For a TIN buyer, Buku fills `BuyerName` from the contact and leaves `BuyerAdress` empty when none is known, as DJP's sample does
  (Coretax prefills both). To be confirmed.
- Coretax rounds VAT on 2-decimal DPP Nilai Lain the way the template does (12 × DPP Nilai Lain / 100, 2 decimals). An invoice whose
  whole-Rupiah PPN differs by less than Rp 1 is *Siap*.
- `000000` is accepted for services as well as goods (DJP guidance names goods; to confirm). The card keeps the code editable.
- A faktur dated in a masa may need to be uploaded by the 15th of the next month. This needs confirming against PER-11/PJ/2025: the card
  shows it as a hint, not a block.
- Invoices per company per masa are in the hundreds; the XML builds in memory.

## Gate re-openers
- **Migration (additive, nullable):**
  - `Contact`: `nik`, `nitku`, `address`, `email`;
  - `Entity`: `nitku`;
  - `Invoice`: `fakturItemKind` (A/B), `fakturItemCode`, `fakturUnit`, `fakturItemName`.
  No backfill; no CHECK change.
- **PII:** NIK, address and email of the client's buyers are stored and written into a file (UU PDP). They are never sent to a model and
  never put in the demo or Git. The legal pages' data list may need a line (Phase 0 item 3).
- **Sensitive path:** new server actions in `app/actions.ts` (contact identity, item detail), each through `requireCapability`.
- No new dependency (XML written by a small escaping builder), no AI call, no number on a report changes. The `e2e` label applies (an
  app flow).

## Tasks
- [x] T1 Migration + `lib/receivables` contact identity (`setContactTaxIdentity`: NPWP / NIK / NITKU / address / email, normalised,
      audited) + invoice item detail (`setInvoiceFakturItem`, bulk) — accept: DB tests for validation, scoping and audit.
- [x] T2 `lib/tax/coretax-faktur-xml.ts`, a pure builder (company + rows → XML string, parts of 1,000) with the bigint 11/12 and 12 %
      math. Golden fixture + DJP sample tag-order test — accept: unit tests green. (Parallel with T1.)
- [ ] T3 `lib/tax/coretax-faktur.ts` `fakturKeluaranDraft` (candidates, exclusion via `fakturRecon` matches and I5e numbers, block
      reasons) — accept: DB tests for every inclusion and block rule. (Deps: T1; reuse `fakturRecon`, `npwpDigits`, `packApplies`.)
- [ ] T4 Download route `tax/masa/coretax` (`?entity&period&part`), audit event, server actions — accept: route DB tests (member 200,
      stranger and revoked 404, no `REPORT_EXPORT`). (Deps: T2, T3.)
- [ ] T5 Card *Faktur keluaran untuk Coretax* on Pajak Masa, with the identity sheet and the bulk item form — accept: Playwright flows
      1 and 3. (Deps: T4.)
- [ ] T6 verify-local: walk flows 1–4, open the XML, screenshots at 1440 and 390 px, full gate.

## Implementation
- Plan: T1–T5 sequential, inline in one build worker (the driver gave this worker the whole cycle; T3–T5 share `lib/tax`,
  `app/actions.ts` and the Pajak Masa page, and T2's builder is small). T6 (verify-local, the Playwright run) by the driver.
- T1: `prisma/migrations/20261017120000_coretax_faktur`, `prisma/schema.prisma`, `lib/tax/coretax-codes.ts`,
  `lib/receivables/faktur-identity.ts`, `lib/clients/entities.ts`, `tests/db/faktur-identity.test.ts` — the nullable columns;
  `setContactTaxIdentity` (NPWP via `normalizeNpwp`, NIK 16 digits, NITKU 22 digits starting with the NPWP16, address, email; field
  errors as `OnboardingError`) and `setInvoiceFakturItem` (bulk, SALES only, one company), both audited as `FAKTUR`; `renameEntity`
  takes an optional seller NITKU. DJP's REF-General lists (Barang/Jasa, Satuan UM.0001–UM.0039) live in `coretax-codes.ts`.
  - Decision: the change log names the identity fields changed ("Identitas pajak X diubah: NIK, alamat"), never their values (UU PDP).
  - Decision: a NITKU must start with its holder's NPWP16 (catches a typo before Coretax does); one equal to the head office's
    NPWP16 + `000000` is stored as null, so the default keeps following the NPWP.
  - Decision: item detail may be set on an invoice in a locked month: it is faktur metadata and moves no figure.
- T2: `lib/tax/coretax-faktur-xml.ts`, `tests/unit/coretax-faktur-xml.test.ts`, `tests/fixtures/coretax/` — the pure builder (DJP
  v1.4 element order, tab-indented like DJP's sample, empty elements self-closed as there), kode 04 arithmetic in bigint sen
  (DPP Nilai Lain = half-up 11/12, PPN = half-up 12 % of it), files of at most 1,000. The golden file was checked by hand.
  - Decision: DJP's sample itself is not committed. `djp-sample-v1.4-shape.xml` is our transcription of its element names and order
    with placeholder values (checked tag-for-tag against DJP's file on 2026-10-17); the order test reads it.
  - Decision: amounts are written as DJP's sample writes them, whole numbers without decimals and others with two (`9166666.67`).
  - Decision: `BuyerDocumentNumber` is `-` for a TIN buyer (the template's Keterangan rule; DJP's XML sample leaves it empty).

## Verification

## Ship Notes
