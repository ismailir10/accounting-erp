# Investor demo — 5 minutes

Automated end to end by `e2e/investor-demo.spec.ts` — if you change this script, change the test.

**Before you start:** seed an isolated demo database with `npm run demo:reset`, then provision an invited user through `npm run access`. Browser at 1440px; sign in with the email code. Manual login needs configured delivery; automated E2E captures a test code through the real auth flow without sending email. No paid AI is used.

---

### 0. The pitch (15 s)
> "Indonesian accounting firms still turn rekening koran into financial statements by hand in Excel —
> days per client per month. Buku does it in minutes, and every number traces back to the bank line it came from."

### 1. Beranda — the firm's month-end at a glance (30 s)
- **Kemajuan tutup buku** is the firm board: per client, *Sumber* (data complete?), *Review*, *Tutup buku* and *Terkirim*. Grup Ayam shows *1 kurang* under Sumber.
- Three main destinations: Beranda (with the task list), Dokumen, Laporan. Shared client/company and period selectors govern the work.
- Ask **Apa yang menghambat tutup buku?** and inspect the cited close controls. Answers keep their original context when selectors change.
- On **Beranda** open **Semua pekerjaan** and choose **Lengkapi 1 rekening koran** for Grup Ayam Nusantara. The held-back bank statement remains the next live step.

> Talking point: *the product gets cheaper to run every month — memory and rules replace AI calls.*

### 2. Unggah — the live moment (45 s)
- Before uploading, point at **Kelengkapan data**: the owner's BRI August is *Bolong*, and **Minta data yang kurang ke klien** already holds the WhatsApp message asking for it (*Salin pesan* / *Kirim lewat WhatsApp*).
- Open **Cara lain**: rekening *BRI Simpedes (Budi)* is preselected. Click **Pakai file contoh (BRI-5509-2026-08.csv)** (or drop the file from `public/demo/`).
- Result card: rows imported, **transfers paired automatically** (PT → owner, owner BCA → BRI), balance continuity *Nyambung*, **0 AI calls** (memory + cache), 1 line to review.

> Talking point: *no open banking in Indonesia — statements are the integration, so we made import bulletproof:
> format detection, running-balance check, dedupe on re-upload.*

### 3. Review — AI proposes, the accountant decides (60 s)
- Five lines, each with the suggested account, the reason, and confidence.
- The **Rp 185 jt "mesin pakan otomatis"**: AI suggested *5100 Pembelian* at **62% — flagged "keyakinan rendah"**.
  Change it to **1210 Aset Tetap** → *Simpan*. (Capitalise, don't expense — this is the moment accountants nod.)
- Press **Enter** four times to accept the rest. Queue empty.

> Talking point: *AI never writes to the books on its own. Every decision trains the client's memory.*

### 3b. Pajak Masa — the books tie to Coretax (30 s, optional)
- Open **Pajak Masa**. PPN, PPh 21 and the previous masa are *Lolos* (remitted in full, on time).
- *Ekualisasi PPN (Coretax)*: every faktur keluaran and masukan is matched to its line in the books. Before Review, the DP and the
  machine showed up as *faktur belum ada di buku*; now both tie.

> Talking point: *the firm's month-end question "do the faktur match the books?" is answered before the SPT, row by row.*

### 4. Laporan Keuangan — trace any number (45 s)
- Laba Rugi August + YTD. Click **4100 Penjualan** → Buku Besar → click any line →
  the sheet shows the **journal and the original statement row** (file, row number, raw text).
- Tab **Neraca** → balanced, with PPN split out automatically.
- Tab **Kertas Kerja Gabungan** → PT + owner side by side, **intercompany eliminated** (Rp 197 jt), *Antar entitas cocok*.
  Hover the ⓘ: it's a management combined view, not SAK consolidation — honesty that auditors appreciate.

### 5. Jurnal Penyesuaian — beyond cash basis (45 s)
- **Jurnal terjadwal Agustus 2026**: *Penyusutan aset tetap (garis lurus) (6/120) Rp 9.500.000* — the depreciation schedule
  proposes this month's installment → **Catat**. No typing; March–July were posted the same way.
- **Kandidat dari buku besar**: the Rp 166.666.667 *mesin pakan* reviewed in step 3 shows up as a fixed-asset purchase →
  **Buat jadwal** (prefilled: 6180 / 1219, 48 bulan from September, ± Rp 3.472.222 a month) → **Simpan jadwal**.

> Talking point: *bank data gives cash basis; schedules make it accrual-ready — Buku proposes each month's depreciation,
> amortisation and accruals, spots new assets and prepayments in the ledger, and the accountant posts with one click.*

### 6. Tutup Buku — the controlled close (60 s)
- **Arithmetic Lolos**: TB balanced, A = L + E, clearing 1199 = 0, nothing in suspense, intercompany eliminated. BCA has independently printed opening/closing and declared coverage. Mandiri and BRI exports need source review: derived openings and transaction-only dates do not prove a complete statement. Acknowledge their four bank/completeness reviews with an explicit synthetic-demo limitation note; do not claim the files prove completeness.
- **Two additional Perlu dicek.** From the ledger scan: *Akun baru atau aktif lagi — 1210 Aset Tetap* — the machine reviewed in step 3
  is the first movement on fixed assets since the opening balance. Click **Beri catatan** → "Pembelian mesin pakan otomatis,
  faktur ada. Penyusutan mulai September." → Simpan.
- **Persediaan akhir (stock opname)**: PT Ayam holds Rp 260 jt of feed and no August count is recorded. Either type the count on
  *Persediaan* (the difference is journaled to 5190, so HPP = awal + pembelian − akhir) or note it: "Klien menghitung stok hanya di
  akhir tahun" → Simpan.

> Talking point: *the close doesn't only check that the books add up — it reads the ledger like a reviewer would (swings
> against the last 3 months, accounts that wake up, P&L running backwards, double entries) and asks for a one-line note.*

- Tick the three accountant sign-offs → **Tutup buku Agustus 2026** → confirm in the dialog. Period locked; imports into it are now rejected.
  Reopening (admin, with a reason) clears the sign-offs: the month is reviewed again before it closes again.

### Close (15 s)
> "Three clients, one morning. The same engine scales to a firm's hundred clients — that's the business."

---

## Honest limits (have answers ready)
- **PDF statements** aren't parsed yet (next cycle; most firms receive PDFs). CSV/XLSX from KlikBCA, Mandiri, BRI + generic.
- Bank formats approximate 2026 exports — validate with real files before a pilot.
- Tax is an estimate card, not e-Faktur/Coretax. No auth/roles yet. IDR only.
- Demo data is synthetic, modelled on real engagements — no client data is shown.

## If something goes wrong
- Anything odd → sidebar **Reset data demo** (±5 s locally, ~20 s on Vercel) and restart from step 1.
- Live AI instead of cache: set `AI_API_KEY`/`AI_MODEL`, run `DEMO_LIVE_AI=1 npm run demo:reset`; step 2 then makes exactly one real call.
# Public document evidence demo

Open **Dokumen**, add a synthetic report, and ask a question about it: the answer cites the exact source line. Uploaded figures stay evidence; they never become journals on their own. Run this walk locally (or on an on-demand synthetic preview); production holds real client work.
