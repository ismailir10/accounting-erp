# Public story: files to a reviewed close

## Context
Prospects at Indonesian accounting firms need to understand what Buku does, what
the accountant still supplies and reviews, and how to start a bounded trial.
The existing public page and decks imply too much from bank statements alone;
deck keyboard shortcuts also intercept links and phone mode hides PDF access.

## Decisions
- User-authorized public-surface improvement; proceed within the delegated scope.
- Keep the existing visual system and synthetic product evidence. Emphasise firms,
  source checks, accountant review, deterministic posting and controlled close.
- Explain opening balances and non-bank adjustments. Assess format fit in a trial,
  without accuracy, scale, readiness or competitor-parity promises.
- Keep trial requests on the existing access page. No new service or contact route.
- Remain a draft PR; the parent coordinates the active release before merge.

## Acceptance criteria
- [x] First view names accounting firms in Indonesia and a clear next action.
- [x] Page and both decks explain source → review → close without implying bank
      files alone form complete accrual accounts or AI approval guarantees accuracy.
- [x] Trial preparation names a month of bank files, opening balances and supporting
      adjustments; the CTA reaches the existing access request.
- [x] Deck links activate with Enter, hidden slides leave keyboard navigation, and
      phone readers can download PDF and identify slide sections.
- [x] Public layouts fit desktop and 375/390px phones; PDFs match revised HTML.
- [x] Claims use released main and current official evidence; no private lab results,
      client files, endorsements or new capability promises enter public surfaces.

## Verify flows
1. Anonymous firm prospect: read the hero and three steps; inspect source evidence,
   review/close context and trial preparation; open the access request without submitting.
2. Deck reader: open firm/company decks, navigate by keyboard, activate the final
   CTA with Enter, and download each PDF. On phone, scroll sections and use PDF link.
3. Reduced-motion and no-JavaScript readers: content and controls remain legible;
   no clipping, no hidden content required to understand the story.

## UX notes
Keep one primary CTA per view, Bahasa copy, warm canvas, blue actions, explicit
synthetic labels, and concise preparation lists. Preserve existing report evidence.

## Test seams
Existing public Vitest coverage plus focused public/deck browser checks for links,
keyboard behaviour, phone layout, PDF downloads, reduced motion and asset loading.

## Non-goals
Import/accounting/auth/backend changes, deployment, merge, production data,
outreach, new dependencies, hosted services, credentials or paid AI calls.

## Assumptions
Freshly fetched released main `e4899e1` is the capability baseline. Historical
research and unreleased experiments are not evidence of current product capability.

## Gate re-openers
Any non-public code change, new dependency, production action or private-data use.

## Tasks
- [x] T1 Clarify the public page and both decks; repair public deck navigation and
      phone reading; regenerate PDFs and verify the changed surfaces.
- [x] T2 Record the exact claim changes, source audit and verification; publish a
      draft PR with synthetic highlight screenshots.
- [x] T3 Fix public PDF link annotations after the parent review found local
      export-server links; regenerate downloads and verify canonical targets.

## Implementation
- Plan: sequential and inline; the copy, navigation and evidence share the same
  small public surface. Separate workers for these edits would duplicate context.
- T1: updated the firm-focused story, complete-close inputs, qualified formats and
  recognition, same-site CTAs, phone reading, native keyboard activation and
  final-value illustrations; regenerated both PDFs and added public regressions.
- Session setup initially failed because npm's default cache was outside writable
  roots. Installing with `/workspace/.npm` succeeds without dependency changes.

## Claim audit

Capability baseline: freshly fetched `origin/main` at `e4899e1`; no branch-only
experiment or private QA result was treated as a public product capability.

- Source formats: `lib/banks.ts` and `lib/public-product.ts`; public format rows
  already distinguish actual examples, documented layouts and inferred patterns.
- Deterministic posting and AI review: `lib/import/pipeline.ts` classification and
  posting stages; `lib/ledger/bank.ts`. Confidence and source/account checks still
  apply; recognition is not a guarantee that the accounting treatment is right.
- Opening balances and adjustments: the released opening-balance flow and
  `public/deck/kantor.html` adjustment-register story. Bank movement is a starting
  source, not a complete accrual ledger by itself.
- Close controls and report source: released `lib/controls/` and `lib/reports/`;
  existing labelled product captures are retained byte-for-byte.
- Export intake: released `lib/ledger-import/` takes mapped ledger/TB files. Named
  Accurate/Jurnal exports were replaced by format-and-mapping copy, with no parity
  or direct integration implication.

Official competitor evidence read on 2026-10-13:

- [Zahir Online bank reconciliation](https://help.zahironline.com/portal/id/kb/articles/rekonsiliasi-bank-zahir-online-v2)
  documents CSV import, preview/correction, deterministic matching conditions and
  bulk reconciliation of matched entries. Historical “all manual-entry” research
  is not used as a present-day claim.
- [Mekari Jurnal recommendations](https://help-center.jurnal.id/hc/id/articles/43402941944729-Bagaimana-Cara-Melakukan-Rekonsiliasi-dengan-Rekomendasi-Jurnal-New)
  documents matching recommendations, bank rules and bank-feed/import inputs.
  [Cashlink](https://www.jurnal.id/id/fitur/kas-transaksi/cashlink-bank/) describes
  API bank feeds and automated journal creation following reconciliation.
  [Guided close](https://help-center.jurnal.id/hc/id/articles/43448083771161-Bagaimana-Cara-Melakukan-Tutup-Buku-New)
  documents checks for reconciliation, approvals, stock and depreciation, with a
  trial-balance worksheet and confirmation. Human control is not unique to Buku.
- [Rillet accruals](https://www.rillet.com/blog/how-ai-handles-accruals) documents
  proposed accrual journals with controller review, editing and approval before
  posting. [Bank reconciliation](https://www.rillet.com/product/bank-reconciliation)
  describes automated matching. These are provider descriptions, not independent
  performance tests. No absence-of-PDF/CSV or uniqueness claim is made.

No public competitor comparison was added. No claims of unique PDF intake,
guaranteed accuracy, 100k-file support, autonomous background import, feature
parity, production readiness, private pilot outcomes or endorsements were added.
Removed the deployment-region assertion because this public copy review does not
verify current hosted configuration. Both decks now link the existing privacy page.

### Exact changed public claims

The following is a complete prose replacement list for changed deck headings,
paragraphs, points, stage descriptions and metadata. HTML links and formatting are
shown as plain text; the PR diff retains exact markup and CTA destinations.



**public/deck/kantor.html**

Before:

- Tutup buku semua klien tanpa mengetik ulang rekening koran. Buku membaca rekening koran, memeriksa saldo dan kelengkapan sumber, mengusulkan jurnal untuk Anda putuskan, dan menyusun laporan yang bisa ditelusuri.
- Tutup buku semua klien tanpa mengetik ulang rekening koran.
- Buku membaca rekening koran klien, memeriksa saldo dan kelengkapan sumber, mengusulkan jurnal untuk Anda putuskan, lalu menyusun laporan yang setiap angkanya bisa ditelusuri.
- File lengkap, saldo terbukti
- melengkapi file yang kurang
- memutuskan yang ragu, mengunci bulan
- 25 bank, rekening Rupiah. PDF, CSV, Excel, atau MT940; juga PDF bersandi atau berisi beberapa rekening.
- Bank lain: tunjuk kolomnya sekali. File yang belum dikenal dibaca setelah kolom tanggal, keterangan, nominal, dan saldonya ditunjuk; file berikutnya langsung terbaca.
- Buku tahu file yang kurang, dan menulis permintaannya.
- Yang sudah pasti, tanpa AI. Transfer antar rekening sendiri, aturan, dan memori klien langsung dibukukan.
- Keputusan Anda diingat. Bulan depan, penerima yang sama dikenali memori klien.
- Basis data dan server aplikasi di region Singapura
- Kasir, faktur, dan penggajian tetap dipakai. Hasilnya tiba di rekening koran, dan dari situ Buku mulai.
- Buku lama ikut masuk. Ekspor buku besar atau neraca dari Accurate, Jurnal, atau Excel, diperiksa dulu baris per baris.
- Tambah klien dari file tarik rekening koran: entitas dan rekening diusulkan, file langsung dibukukan
- Kami tunjukkan alurnya dengan data demo, lalu kami jalankan satu klien nyata bersama Anda. Ukur hasilnya dengan waktu yang biasanya Anda butuhkan untuk klien yang sama.
- Harga dibahas saat demo
- rekening koran asli, saldo awal dari neraca terakhir
- klien berikutnya memakai alur yang sama

After:

- Dari file klien ke tutup buku yang ditinjau akuntan. Periksa sumber, putuskan usulan akun, lengkapi penyesuaian dan telusuri laporan ke jurnalnya.
- Semua ilustrasi memakai data demo sintetis.
- Dari file klien ke tutup buku yang ditinjau akuntan.
- Buku membaca rekening koran dan memeriksa saldo. Anda meninjau usulan akun, melengkapi saldo awal dan penyesuaian, lalu menutup bulan dengan laporan yang bisa ditelusuri.
- File dan saldo diperiksa
- memeriksa hasil baca, melengkapi file dan saldo awal
- meninjau usulan, mencatat penyesuaian, mengunci bulan
- Format rekening Rupiah dari 25 bank. PDF, CSV, Excel, atau MT940 sesuai tata letaknya; termasuk PDF bersandi. Periksa kecocokan file saat uji coba.
- Format berbeda: atur kolomnya. Tunjuk tanggal, keterangan, nominal dan saldo pada file bertabel. Pemetaan bisa dipakai ulang untuk tata letak yang sama.
- Sebagian format belum diuji dengan contoh asli. Lihat format bank .
- Lihat file yang kurang. Siapkan permintaan ke klien.
- Yang memenuhi pemeriksaan, tanpa AI. Transfer yang terbukti, aturan dan memori klien bisa dibukukan langsung; akuntan tetap memeriksa hasilnya.
- Keputusan Anda diingat. Memori klien membantu mengenali penerima dan arah transaksi yang sama; hasilnya tetap bisa dikoreksi.
- Baca Kebijakan privasi : pemrosesan AI dan akses dukungan
- Kasir, faktur, dan penggajian tetap dipakai. Rekening koran, ekspor buku dan dokumen pendukung menjadi bahan pembukuan.
- Buku lama ikut masuk. Ekspor buku besar atau Neraca Saldo dalam Excel/CSV: petakan akun dan periksa barisnya sebelum masuk ke Buku.
- Tambah klien dari file unggah rekening koran; periksa usulan entitas dan rekening sebelum melanjutkan
- Uji kecocokan format dan hasil baca. Lengkapi saldo awal serta dokumen penyesuaian, lalu jalani review sampai laporan. Bandingkan hasil dan waktunya dengan cara kerja Anda sekarang.
- Permintaan ditinjau sebelum undangan dikirim
- rekening koran, saldo awal, bukti dan penyesuaian
- periksa hasil, temuan dan waktu pengerjaan

**public/deck/perusahaan.html**

Before:

- Laporan keuangan bulanan langsung dari rekening koran perusahaan Anda, disusun bersama akuntan Anda, dengan setiap angka bisa ditelusuri.
- Laporan keuangan bulanan, langsung dari rekening koran Anda.
- Buku membaca rekening koran perusahaan, akuntan Anda memutuskan yang meragukan, dan setiap bulan Anda menerima laba rugi, neraca, dan arus kas yang setiap angkanya bisa ditelusuri.
- Tim Anda mengirim file. Buku mengerjakan sisanya. Akuntan memutuskan.
- Rekening koran apa adanya, lewat tautan, dari ponsel. Tanpa akun.
- Memutuskan yang ragu
- Usulan akun dari AI menunggu persetujuan. Keputusannya diingat.
- Cukup kirim file, dari ponsel, tanpa akun.
- Rekening Rupiah dari 25 bank. PDF, CSV, Excel, atau MT940; termasuk PDF bersandi.
- Yang ragu diputuskan sekali. Bulan berikutnya, Buku ingat.
- Yang sudah pasti dibukukan langsung. Listrik, gaji, BPJS, setoran pajak menurut kode setorannya, transfer antar rekening sendiri.
- Keputusan menjadi memori. Penerima yang sama dikenali lagi tanpa AI.
- Basis data dan server aplikasi di region Singapura
- Kasir, stok harian, atau marketplace Tetap pakai aplikasi Anda; hasilnya masuk lewat rekening koran.
- Pakai rekening koran perusahaan Anda sendiri, lalu bandingkan dengan cara sekarang: angkanya, waktunya, dan pertanyaan yang selama ini dijawab “nanti dulu”.
- Harga dibahas saat demo
- 3 Akuntan Anda Tim keuangan Anda atau kantor akuntan Anda: yang meninjau usulan dan menutup bulan.

After:

- Dari file perusahaan ke laporan bulanan yang ditinjau akuntan, dengan saldo awal, penyesuaian dan jejak sumber.
- Semua ilustrasi memakai data demo sintetis.
- Laporan bulanan dari buku yang ditinjau akuntan Anda.
- Mulai dari rekening koran, saldo awal dan dokumen pendukung. Akuntan meninjau transaksi serta penyesuaian; Buku menyusun laporan dari jurnal yang sudah dibukukan.
- Tim Anda mengirim file. Buku memeriksa. Akuntan meninjau.
- Rekening koran dan bukti pendukung lewat tautan unggah, dari ponsel. Tanpa akun.
- Meninjau pembukuan
- Periksa usulan akun, saldo awal dan penyesuaian. AI menunggu persetujuan.
- Kirim file dari ponsel. Akuntan memeriksa sebelum impor.
- Format rekening Rupiah dari 25 bank. PDF, CSV, Excel, atau MT940 sesuai tata letaknya. Periksa kecocokan file saat uji coba.
- Sebagian format belum diuji dengan contoh asli. Lihat format bank .
- Keputusan akuntan membantu review bulan berikutnya.
- Aturan dan memori bisa membukukan langsung. Berlaku untuk transaksi yang memenuhi pemeriksaan; hasilnya tetap ditinjau akuntan.
- Keputusan menjadi memori. Penerima dan arah transaksi yang sama bisa dikenali tanpa AI; hasilnya tetap bisa dikoreksi.
- Baca Kebijakan privasi : pemrosesan AI dan akses dukungan
- Kasir, stok harian, atau marketplace Tetap pakai aplikasi Anda; lengkapi rekening koran dengan ekspor buku dan bukti pendukung.
- Uji format dan hasil baca bersama akuntan. Lengkapi saldo awal dan bukti penyesuaian, lalu bandingkan laporan serta waktu pengerjaan dengan cara sekarang.
- Permintaan ditinjau sebelum undangan dikirim
- 3 Akuntan dan bukti pendukung Faktur, daftar aset dan penyesuaian sesuai kebutuhan. Akuntan memeriksa hasil dan menutup bulan.

**public/deck/index.html**

Before:

- Tutup buku bulanan dari rekening koran, dengan laporan yang setiap angkanya bisa ditelusuri. Pilih yang sesuai dengan pembacanya.
- Laporan bulanan dari rekening koran sendiri, bersama akuntan Anda: untuk pemilik, bank, dan pajak.
- Panah kiri/kanan untuk berpindah slide · F untuk layar penuh

After:

- Dari file ke pembukuan yang ditinjau akuntan. Pilih presentasi sesuai pekerjaan Anda. Semua contoh memakai data demo sintetis.
- Rekening koran, saldo awal dan penyesuaian, ditinjau akuntan menjadi laporan untuk pemilik, bank dan pajak.
- Kembali ke Buku · Minta akses uji coba Di komputer: panah kiri/kanan untuk berpindah slide, F untuk layar penuh. Di ponsel: gulir untuk membaca.

**Public page**

- Audience: “Pembukuan untuk kantor akuntan dan perusahaan” → “Tutup buku bulanan
  untuk kantor akuntan di Indonesia”.
- Hero: “Setiap angka punya asal. Buku menjaga jejaknya, akuntan Anda memutuskan yang
  perlu ditinjau.” → “Buku membantu memeriksa file klien, transaksi dan selisih.
  Akuntan melengkapi saldo awal serta penyesuaian, meninjau usulan AI, lalu menutup
  bulan dengan laporan yang bisa ditelusuri.”
- Three steps now say: “Unggah rekening koran. Cek saldo dan file yang kurang.”;
  “Putuskan usulan akun, catat penyesuaian, selesaikan temuan.”; “Telusuri angka ke
  jurnal dan sumber. Unduh Excel atau PDF.”
- Automation qualification: “Aturan yang sudah dikenali bisa membukukan transaksi
  langsung. Usulan AI menunggu persetujuan akuntan.” → “Aturan dan memori klien yang
  memenuhi pemeriksaan bisa membukukan transaksi langsung. Usulan AI menunggu
  persetujuan akuntan. Saldo yang cocok tetap perlu ditinjau bersama bukti transaksi.”
- Company context: “Kirim rekening koran dan saldo awal. Tim keuangan atau kantor
  akuntan meninjau transaksi; Anda membaca laporan dari pembukuan yang sama.” →
  “Rekening koran menjadi titik awal. Saldo awal, faktur, daftar aset dan penyesuaian
  melengkapi pembukuan sesuai kebutuhan klien. Tim keuangan atau kantor akuntan
  memeriksanya.”
- Trial: “Ajukan uji coba untuk kantor atau perusahaan Anda” → “Uji kecocokan format,
  hasil pembacaan dan alur review pada satu bulan pembukuan sebelum menambah klien.”
  Adds: “Rekening koran satu bulan · seluruh rekening usaha klien”; “Saldo awal · dari
  neraca atau Neraca Saldo terakhir”; “Dokumen pendukung · faktur, daftar aset dan
  penyesuaian yang perlu ditinjau”. Existing invitation/legal explanation remains.

**Related illustration and CTA changes**

- Both cover alternatives now mention opening balances, adjustments and accountant
  review, consistent with nearby prose. Original cover illustrations remain.
- Both final CTAs change from external right-jet.com contact/invitation to
  “Minta akses uji coba” at `/daftar`; no new form or outbound contact is introduced.
- Cover footers say “Ilustrasi · data demo sintetis”; synthetic notes and slide
  counts are now visible on phone. The full invented account number in each
  AI-flow example is replaced by “REKENING SENDIRI”; masked demo numbers remain.
- Counts in financial illustrations remain unchanged. Removing number count-up and
  looping packet motion keeps the same example value visible throughout a slide.

## Verification
- Repository task gate: lint and typecheck pass. Full unit/DB suite:
  `Test Files 265 passed (265)`; `Tests 2430 passed (2430)`; 442.86 seconds.
  Final affected public tests: `Test Files 5 passed (5)`; `Tests 25 passed (25)`,
  including the new PDF artifact regression (5.75 seconds).
- Production build passes with a localhost application origin and unconfigured
  Auth, matching the CI build environment. No hosted credentials or data used.
- Anonymous browser suite: existing `public-site.spec.ts` plus new
  `public-decks.spec.ts`, nine tests passed (20.4 seconds) against the final rebuilt
  app at `http://localhost:3200`. A temporary public-only Playwright config excludes
  authenticated global setup; test files/expectations themselves run unchanged.
- Desktop/phone evidence: 62 deck captures (all slides at 1440×900 and 390×844),
  plus landing, chooser and trial states. Browser errors: `[]`; page or desktop
  body overflow: `[]`. New phone/deep-link tests also pass at 375×812.
- Walked the anonymous page → chooser → deck → access-request journey and legal
  links. No access request was submitted. Keyboard Enter activates deck buttons
  and final CTA, hidden slides are inert, phone PDF links download the right files,
  no-JavaScript content remains readable, and reduced-motion checks pass.
- PDF export: regenerated both downloads; exactly 17 and 14 pages, revised copy and
  `/daftar` CTA. A new artifact test checks HTML/PDF page parity and current copy.
  The initial export exposed an extra page from the live announcement; print CSS
  now hides it. The final PDF counts were independently checked with `pdfinfo`.
- Synthetic books: `ALL PASS — 1765 pemeriksaan saldo cocok dengan ground truth.`
  Existing product capture bytes/dimensions remain verified by public unit tests.
- Workflow drift check passes; `git diff --check` is clean. Independent standards
  and spec reviewers reported no blockers. Cover alternative text was aligned with
  balances/adjustments/review after their optional suggestion.
- Local setup-only corrections: writable npm cache, missing throwaway test DB and
  localhost canonical origin. No source checks were weakened to obtain passes.
- Not run: authenticated full E2E, new Auth/service/credential setup, paid model
  calls, private QA input, production writes or release. They are outside this
  delegated public-only verification; the PR remains a draft for parent review.
- Highlight screenshots: `/tmp/buku-public-evidence/buku-public-page-desktop.png`,
  `/tmp/buku-public-evidence/buku-firm-deck-phone.png`. All captures show existing
  synthetic fixtures or illustrative data. Logs and complete captures are retained
  locally in `/tmp/buku-public-*.log` and `/tmp/buku-public-evidence/`.


### Verified locally — `9f355f770077106eb921bc038f6e44f008443ea8`, 2026-10-13

Production build at `http://localhost:3200`, anonymous prospect. Final public tests
pass (25 unit/artifact, 9 browser), lint/typecheck/build pass, 62 deck captures have
no browser errors or page/body overflow. Highlights named above were captured
against this final runtime. The subsequent record update changes documentation
only. Full existing suite passed 2,430 tests; synthetic books pass 1,765 checks.

### PDF annotation correction — 2026-10-13

Parent review identified a release blocker missed by the original text/page-count
checks: both committed PDFs contained four loopback link targets on the temporary
export server. This includes trial, privacy, bank-format and deck navigation links.

- Parent explicitly authorized the directly related public exporter repair.
  `scripts/deck-pdf.ts` resolves same-origin anchors to the repo's documented
  production origin before printing; local rendering/assets stay local. It does
  not read local `APP_URL` as a publication origin.
- Added an annotation regression using `unpdf.extractLinks`, which reads the actual
  PDF link annotations. Both tests fail against the old PDFs (two failures, two
  existing artifact passes), then pass against the regenerated downloads.
- Independent annotation audit: firm PDF has 17 pages / 20 link annotations;
  company PDF has 14 pages / 17 annotations. Both have exactly these public targets:
  `https://native-erp-v2.vercel.app/deck`,
  `https://native-erp-v2.vercel.app/#bank-formats`,
  `https://native-erp-v2.vercel.app/kebijakan-privasi`,
  `https://native-erp-v2.vercel.app/daftar`.
- Tests require the canonical HTTPS origin and expected target set, rejecting
  localhost, loopback, private/internal hosts, temporary ports and URL credentials.
- Corrective checks: lint and typecheck pass; 5 focused files / 27 tests pass
  (7.07 seconds); the 9 anonymous public browser tests pass (14.5 seconds), including
  desktop/phone navigation and downloads. No HTML/CSS/product runtime changed.
- Visual checks: raster-rendered all 31 PDF pages before and after the link repair;
  raw pixels are identical on every page (`pagesCompared: 31`,
  `pixelDifferences: []`). Inspected regenerated firm source and company CTA pages.
  Existing PR highlight screenshots remain visually exact.
- Evidence: `/tmp/buku-public-evidence/pdf-annotation-audit.json`,
  `/tmp/buku-public-evidence/pdf-links/visual-comparison.json`,
  `/tmp/buku-public-annotations-before.log`,
  `/tmp/buku-public-annotations-focused.log`,
  `/tmp/buku-public-annotations-browser.log`.
- This supersedes the earlier PDF link coverage gap; the earlier 2,430-test full
  suite is historical, not a claimed rerun of this correction. Keep PR #155 draft
  for renewed exact-head parent review; do not enable CI or merge yet.

## Ship Notes
- Branch: `task/public-reviewed-close`, fresh main `e4899e1` unchanged at final fetch.
- Changed firm slides: 1, 3, 5–8, 14, 15, 17. Company slides: 1, 3, 4, 10, 12–14.
  Shared deck reading/navigation styles affect all slides; both PDFs regenerated.
- Scope review: only the public landing component, public deck files/PDFs,
  anonymous public tests and this work record. No product/auth/import/backend edits.
- Draft PR: [#155](https://github.com/ismailir10/accounting-erp/pull/155).
- Final public evidence is recorded above; synthetic highlights are attached to
  the PR from the never-merged `pr-assets` branch. CI remains draft-skipped until
  parent release coordination and review.

No merge/deploy in this worker. No migrations, environment changes or manual data
steps. Rollback: revert this public-only change.
