# Wawasan keuangan: trend, margin and the movers explained

**Roadmap:** firm-lens parity with Mekari Jurnal's *Financial reports & AI analytics* ("AI-driven trend, margin & insights"; owner's
choice 2026-10-17). Also the first half of Phase 2 item 4, *Flux as a close step* (`docs/roadmap.md` §5): the explanation flow — AI
drafts citing rows, the accountant edits and marks it *Disetujui*, approved explanations feed the management pack and are offered again
next month. Per-firm thresholds and the close step itself are the next cycle.

**Approval:** the owner approved building the four firm-lens cycles on 2026-10-17 ("go ahead, build all four without stopping"):
[credit limits and reminders](2026-10-17-pengingat-piutang.md), this one, [Coretax files](2026-10-17-coretax-files.md) and
[Kotak Persetujuan](2026-10-17-kotak-persetujuan.md). Open choices settled by the driver: *Wawasan* is the last tab, not the default
(existing links and the e2e walk stay true); only approved explanations are stored, as Catatan manajemen does.

## Context
Jurnal's Airene summarises the P&L and flags trends, in English, after the fact. Buku already has the numbers behind such a summary,
but they are spread over four places and none of them says what changed and why:
- *Analisis keuangan* shows the year month by month (Laba Rugi, Neraca, eleven ratios) as tables. The accountant reads the trend
  and the margin movement by eye.
- *Catatan manajemen* (Laporan Keuangan) turns this month against last month into sentences, which the accountant can have AI reword
  and then approves. It covers one month, not the year.
- The ledger anomaly scans flag P&L accounts whose month moved far from their usual (flux, fixed 1 % materiality and 50 %). They
  surface only as a REVIEW control on Tutup Buku, where the accountant writes a note to clear it. The note never reaches the client.
- The management pack's *Perubahan Akun* sheet lists every P&L account against its average, with no explanation.

Who feels it: the accountant preparing the monthly talk with the owner ("why did profit drop when sales rose?"), the partner reviewing
the pack before it goes out, and the owner or bank reading it.

Buku can do better than Airene because every finding is arithmetic on the general ledger and opens down to the row it came from, and
the explanation of a movement is the accountant's, approved and kept, with AI only drafting words that cite the rows behind it.

## Decisions
- **A fourth tab on Analisis keuangan, *Wawasan*** (`?tab=wawasan`), not a new page and not the close page: the findings are about the
  year's months, which this page already holds, and the explanations are written for the owner, not to clear a control. The tab is
  last, and *Laba Rugi per bulan* stays the default, so existing links and the e2e walk stay true.
- **Why this cycle and not the full flux close step:** the owner's ask is the insight surface, and the explanation flow is what turns a
  flagged movement into something worth sending. Both rest on the same scan. Per-firm thresholds and making explanations part of
  Tutup Buku change a close control and need a settings surface; they follow in their own cycle, on top of what this one stores.
- **Three sections, deterministic findings first.** Each section opens with one computed sentence (true in either direction, never a
  hard-coded "naik"), then the figures. Nothing is stored except the approved explanations.
  1. **Tren.** Pendapatan, laba kotor and laba bersih of the selected month against last month (Rp and %), against the average of the
     year's earlier months, the run ("naik 3 bulan berturut-turut", shown from 2), and the highest and lowest month of the year so far.
     From the same monthly statements as *Laba Rugi per bulan*, so every figure equals a cell there.
  2. **Margin.** Margin laba kotor, usaha and bersih: this month, last month and the year to date, and the change in percentage points.
     When the gross margin moved, one sentence says which side moved it ("Margin laba kotor turun 4,1 poin: beban pokok naik 18,0 %,
     pendapatan naik 3,2 %"). Same formulas as *Rasio keuangan*.
  3. **Penggerak bulan ini.** The five P&L accounts that moved most against their usual month (the *Perubahan Akun* comparison: this
     month against the average of up to three earlier active months), largest first; an account with no difference is not a mover.
     Each shows this month, the average, the difference and %, its three largest lines of the month with their source (bank account +
     file + row, or file + `sheet!row`), and a mark *Melewati ambang* when the flux scan flags it (the same accounts as *Fluktuasi Laba
     Rugi tidak biasa* on Tutup Buku).
- **Every figure opens its source.** An account opens its Buku Besar for the month (where each line opens its source row); a trend or
  margin figure opens the *Laba Rugi per bulan* or *Rasio keuangan* tab for the same scope.
- **Scope.** Tren and Margin work for any scope, groups included (a mixed-currency group uses the statements' own translation; a
  missing rate shows the usual *Isi kurs* step). Penggerak and their explanations are per company, as the scan and the management
  pack are: a group view asks the accountant to pick one company.
- **Penjelasan per mover: AI drafts, arithmetic checks, the accountant approves** (ADR 0009, accounting-rules 20c's pattern).
  - Any of the five movers can get an explanation the accountant types. *Susun dengan AI* appears only on movers *Melewati ambang*,
    because ADR 0009's amendment allows sending only flagged accounts' series and lines.
  - The model receives exactly what the close review sends for that account: its movement per baseline month and this month, and up
    to ten of the month's largest lines on it (date, memo cut to 80 characters, amount, source label), each with an id. Nothing else.
  - **Cited or dropped:** citations outside the ids sent are removed; a draft that cites none is not shown ("AI tidak mengutip baris;
    tulis sendiri"). Every number in the draft must appear in what was sent; a draft with any other number is shown with those numbers
    named and cannot be approved as AI text.
  - Only the accountant's *Setujui* saves it. Their own or edited wording may hold another number, with a warning (they own their
    words). One approved explanation per company, month and account; *Hapus penjelasan* removes it.
  - An approved explanation keeps the account's series it was approved against. When the books move that series, it shows *Perlu
    ditinjau ulang* and the pack leaves it out until approved again.
  - **Offered next month.** When an account is a mover again and the previous month holds an approved explanation for it, the mover
    shows that text with *Pakai lagi*, which opens the editor prefilled. Nothing is approved for the accountant.
  - Approving is allowed in a closed month: an explanation is commentary, not the books (as *Catatan manajemen* today).
- **The management pack carries them.** *Perubahan Akun* gets a *Penjelasan* column holding each approved, current explanation; when one
  was left out because the books moved, a line under the sheet says so.
- **One budget, one cache.** Each draft is one call through the firm's monthly allowance with a per-month scope limit, cached by its
  input, model and prompt version, so asking again for an unchanged account is free. No retry.
- **Who:** members who can write the books draft, approve and remove; viewers see approved explanations only.

## Acceptance criteria
- [ ] *Wawasan* shows Tren, Margin and Penggerak bulan ini for the selected month; every Tren figure equals the matching cell of
      *Laba Rugi per bulan* and every margin equals *Rasio keuangan*.
- [ ] The run, the highest and the lowest month are right in both directions (rising and falling test data); a month with no earlier
      month in the year says there is nothing to compare yet instead of showing dashes.
- [ ] Penggerak lists the five largest movements in the order of the pack's *Perubahan Akun*; *Melewati ambang* marks exactly the
      accounts in Tutup Buku's flux control; each shows its three largest lines with their source.
- [ ] Every account opens its Buku Besar for the same month and company; every trend or margin figure opens its tab.
- [ ] A group scope shows Tren and Margin and asks for one company for Penggerak.
- [ ] *Susun dengan AI* on a flagged mover returns a draft that cites only rows it was sent; a draft citing nothing is not shown; an AI
      draft with a number that was not sent cannot be approved unedited.
- [ ] *Setujui* saves the explanation with who and when; the pack's *Perubahan Akun* carries it; a change to the account's movement
      marks it *Perlu ditinjau ulang* and the pack leaves it out with a line saying so.
- [ ] Next month, the same account offers last month's approved text with *Pakai lagi*; nothing is approved until the click.
- [ ] A viewer sees approved explanations and no draft, approve or remove buttons; the actions refuse a viewer.
- [ ] No real model is called by tests or the seed; with no AI key the tab, typed explanations and the pack work fully.
- [ ] Works at 390 px without page scroll sideways.
- [ ] Deck: `kantor.html` slide 12 (*Satu buku besar. Paket untuk setiap pembaca.*, "laporan manajemen dengan catatan yang Anda
      setujui") and the *AI mengusulkan. Anda memutuskan.* slide are reviewed in ship.

## Verify flows
1. Accountant, Grup Ayam Nusantara, Agustus 2026, *Gabungan*: Analisis keuangan → *Wawasan* → Tren's laba bersih this month equals
   *Laba Rugi per bulan*'s August cell; Margin's laba kotor equals *Rasio keuangan* (the year falls from 35,1 % to 29,3 %, so the
   sentence reads as a fall); Penggerak asks for one company.
2. Accountant, PT Jasa Kreatif Digital, Juli 2026: Penggerak shows 6170 Beban Jasa Profesional *Melewati ambang* (Rp 17.450.000 against
   an average of Rp 11.466.666) with its three largest lines and sources; open it → Buku Besar 6170 for July. Type an explanation →
   *Setujui* → the management pack's *Perubahan Akun* carries it.
3. Same company, Agustus 2026: 6170 is the second mover (Rp 12.300.000 against Rp 13.733.333, not flagged); July's explanation is
   offered with *Pakai lagi*; prefill, edit, approve.
   (With MockProvider in DB tests only: *Susun dengan AI* drafts, cites a row, approves.)
4. Edge: change a July line on 6170 (a reclass in Review) → the July explanation shows *Perlu ditinjau ulang* and the pack leaves it out.
   Error: a viewer opens the tab → no buttons; calling the approve action as a viewer is refused.

## UX notes
- PageHeader + ScopeBar and the four LinkTabs as today; *Unduh Excel* stays (the workbook's three sheets are unchanged).
- A NextStep only when a mover *Melewati ambang* has no current explanation: "Jelaskan 1 akun yang melewati ambang sebelum laporan
  manajemen dikirim", CTA to the first one; done state with the check when all are explained. No NextStep otherwise.
- Tren and Margin: one card each, a short table (metric · bulan ini · bulan lalu · rata-rata tahun ini · tertinggi · terendah; margins in
  %) under the sentence. No chart: the Ringkasan already has the six-month chart.
- Penggerak: one card of divided rows. Per mover: code and name (`.drill`), figures right-aligned, the *Melewati ambang* mark as icon +
  label in the review colour, the three lines as a compact list with their source in muted text, then the explanation: the approved
  text with *Disetujui* · who · when (or *Perlu ditinjau ulang*), or *Tulis penjelasan* (outline) and *Susun dengan AI* (outline, only
  on flagged movers when AI is set up). An AI draft carries the `AI` badge and its citations as links. One primary per editor:
  *Setujui*.
- A hint line under Penggerak states the threshold in words ("Ambang: selisih ≥ 1 % dari rata-rata volume Laba Rugi bulanan dan ≥ 50 %
  dari rata-rata akunnya").
- Empty states: "Belum ada bulan pembanding di tahun buku ini" (first month); "Tidak ada mutasi akun laba rugi bulan ini".

## Test seams
- Unit: trend and margin findings on fixed monthly statements (rising, falling, flat, zero revenue, single month); the sentences say
  "naik" and "turun" correctly; the flux prompt parse with citations outside the list and foreign numbers.
- DB: movers equal the pack's *Perubahan Akun* order and the flux control's accounts; lines carry their source; draft via MockProvider
  (cache hit on the second ask, budget recorded, cited-or-dropped, foreign numbers), approve, stale after a reclass, offered next month,
  remove; the management workbook's *Penjelasan* column; client deletion removes explanations; the actions refuse a viewer.
- e2e: extend `e2e/analisis-keuangan.spec.ts` with flows 1 and 2 (typed explanation; CI has no AI key, the AI path is covered by DB
  tests).

## Non-goals
- Per-firm materiality in Rp and %, and explanations clearing or gating the flux control on Tutup Buku (next cycle, Phase 2 item 4).
- Explaining flip, dormant or duplicate findings; AI on movers below the threshold.
- Same month last year (Laporan Keuangan shows it), forecasts, budgets, ROA/ROE, charts, a PDF or an Excel sheet of the tab.
- A chat over the books, English output, a second approver (Phase 3 item 2).

## Assumptions
- Five movers and three lines each are enough on screen; the pack keeps every account.
- The tab's extra work (one scan and one management summary on top of the monthly statements) is fast enough on the demo; measured in
  verify-local.
- Reusing the close review's rows for one account keeps the AI payload inside ADR 0009's amendment; the new path is recorded as
  accounting-rules 20d and a note on ADR 0009, not a new ADR.
- The demo holds one flagged movement in June–August 2026 (PT Jasa Kreatif Digital, Juli, 6170; read from the local demo on
  2026-10-17); the flows use it. Its July movers are 4110, 6170, 6100, then two accounts with no difference, which drop out.

## Gate re-openers
- **Migration (additive):** one table for approved explanations (firm, client, company, year, month, account; text; source AI or
  accountant; the series it was approved against; cited ids; who and when), unique per company, month and account. Added to client
  deletion (accounting-rules 25).
- **New paid AI path:** one budgeted, cached call per flagged account on the accountant's click. Tests and seed use MockProvider; no
  real call in this cycle (`npm run ai:smoke` unchanged).
- **Sensitive paths:** `app/actions.ts` (three new actions behind the books-write capability), `prisma/migrations/**`.
- No dependency, no auth change, no number on any report changes, no accounting invariant changes.

## Tasks
- [x] T1 `lib/reports/insights.ts`: trend and margin findings from `monthlyIncome` statements (reuse `activeMonths`, `percent` from
      `lib/reports/analysis.ts`, `percentOf` from `lib/reports/management.ts`); `topMovers` from `managementSummary().changes` +
      `scanLedger().flux` + `scan.series`, lines via `ENTRY_SOURCE_SELECT` / `entrySource`; unit + DB tests — accept: figures equal the
      analysis tables, movers equal *Perubahan Akun*'s order and the flux control's accounts.
- [ ] T2 *Wawasan* tab on `analysis/page.tsx` (LinkTabs `?tab=wawasan`, Tren, Margin, Penggerak, drill links, group asks for a company,
      empty states, 390 px); e2e flow 1 — accept: flows 1 and the drill-downs walk (deps: T1).
- [ ] T3 Explanations: migration + model; `lib/reports/flux-explanation.ts` (draft, save, clear, stale, previous month) with
      `draftFluxExplanation` on `AiProvider`, the OpenAI-compatible provider and `MockProvider`; account rows extracted from `gather`'s
      anomaly branch (`lib/controls/ai-review.ts`) so the close review and the draft send identical rows; reuse `runBudgetedAi`,
      `EvidenceAiCache`, `allowedNumbers` / `foreignNumbers`, `recordEvent` (`REPORT_COMMENT`); three actions via `writeClient`; client
      deletion; accounting-rules 20d + ADR 0009 note; DB tests — accept: Test seams' DB list passes (deps: T1; parallel with T2).
- [ ] T4 Editor on each mover (keyed like `ManagementNoteCard`), NextStep, *Pakai lagi*, the *Penjelasan* column in
      `managementWorkbook`; e2e flow 2; workbook test — accept: flows 2–4 walk (deps: T2, T3).
- [ ] T5 verify-local: walk flows 1–4, screenshots at 1440 and 390 px, full gate.

## Implementation
- Plan: T1–T4 sequential, inline in one build worker (each task builds on the last: T2 renders T1, T4 joins T2 and T3); T5
  (verify-local) by the driver.
- T1: `lib/reports/insights.ts`, `lib/reports/analysis.ts` (`ytd` on `MonthlyIncome`, `tenthsOf`), `lib/reports/management.ts`
  (`changes` carry `accountId` and the scan's `series`, `baseline`, `changePercent` shared with the pack), `lib/reports/entry-source.ts`
  (`lineSource`, now also used by the Buku Besar), `tests/unit/insights.test.ts`, `tests/db/insights.test.ts` — trend (last month,
  average of the year's earlier months, run from 2, highest/lowest), margins with the change in points and the side that moved it,
  movers from *Perubahan Akun* with *Melewati ambang* from the flux scan and their three largest lines with source.
  Decision: a flagged account outside the five largest differences is listed too (after them, in the pack's order), so every
  account the flux control names can be explained.

## Verification

## Ship Notes
