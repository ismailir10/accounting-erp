# Lihat alasan: the steps, the values sent and the checks behind each AI card

**Roadmap:** Phase 2 item 2. `docs/roadmap.md` §5, Phase 2: "Each AI suggestion shows its steps, the rows it cited and the values it
used, and the values can be downloaded. The data exists already: 'cited or dropped' is ADR 0009 rule 3. This item shows it." Rillet's
pattern (§2): *View reasoning* shows the steps an answer took (retrieve → validate → calculate), links to the source records and a CSV
snapshot of the exact values used.

**Approval:** after #173 merged, the owner said to merge on green and keep going (2026-10-17, "merge on green then keep going",
"make sure you have regression test"). That covers the next roadmap cycles, built together: [BPPU files](2026-10-17-bppu-files.md), [Lihat alasan](2026-10-17-lihat-alasan.md), [Otomasi](2026-10-17-otomasi.md) and
[Checklist tutup buku](2026-10-17-checklist-tutup-buku.md). The schema and
permission changes are the ones this spec states under Gate re-openers; anything beyond them stops for the owner.

## Context
[Kotak persetujuan](2026-10-17-kotak-persetujuan.md) put every proposal of a client-month in one queue. Each AI card there, and on
Review, shows three things: the `AI` badge, a confidence and a one-line reason. The accountant can't see what the model was given, what
it answered before Buku changed it, or which checks it passed. So "why 6120?" and "what did you send to the AI?" can't be answered from
the screen. The deck already claims the second answer (kantor slide 08: "Anda tahu apa yang dikirim ke AI", with a "Yang dikirim untuk
baris itu" table), but no page shows it per line.

Who feels it:
- the accountant deciding a card;
- the partner reviewing what was approved;
- the firm answering a client's UU PDP question about AI processing (Phase 0 item 3);
- the pilot's exit test ("every AI-originated entry traces to its approved proposal").

What is stored today, read from the code:
- **Bank line on an AI suggestion** (Review, Kotak *Klasifikasi bank*):
  - What the line keeps: `method` AI, `confidence`, `reason` ("AI: <why>", or the replacement sentence below), `suggestedCode` and
    `taxTag`.
  - Nothing links the line to the answer it came from.
  - **The answer cache.** The cache (`AiSuggestion`) stores one row per hash of firm, client, chart version, model, prompt version and
    prompt. A row holds the account, confidence, tax tag, reason, model and time. It has no firm or client column and keeps no prompt.
  - **What the prompt holds:**
    - the client's name and industry (plus a note when the books are a person's);
    - the chart as code|name, without 1190/1199, and for a person without trade and sales accounts;
    - one item per counterparty: key|direction|the first 80 characters of *one* description.
    - The amount, date, balance and account number are never sent.
  - **Which description.** The one sent is the last line with that counterparty and direction in the batch, not necessarily this line.
  - **Which steps ran first.** A line reaches AI only after these all found nothing at import:
    - the transfer matcher;
    - the rules;
    - memory;
    - the financing / tax-payment text.

    This is true by construction: rule 13's order is the only path that sets method AI, at import or through *Minta saran AI* and the
    background run.
  - **When Buku replaces the answer.** An AI receivable or payable with nothing on the books to settle is replaced by the simple
    guess's account, and its confidence is capped at 55 % (`demoteUnbacked`). The cached answer keeps the original account.
- ***Jelaskan* draft** (Kotak *Draf jurnal*, `ProposedEntry` source AI_CONTROL):
  - **What the proposal keeps:**
    - `reason` (the explanation) and `lines`;
    - `refs`, the citations kept;
    - `snapshot`, a hash of the rows sent and of the bank line it moves;
    - `key`, which is "AI:" + the cache key.
  - **What the cache keeps** (`EvidenceAiCache`, under that key): the parsed answer (explanation, suggestion, kept refs, note, entry).
    It keeps neither the input nor the model.
  - **Can the rows be rebuilt?** Yes. `controlSnapshot` rebuilds the control's rows today and proves them equal to the rows sent when
    the snapshot matches. *Setujui* already relies on that check.
  - **Dropped citations.** Citations outside the rows sent are discarded inside the parse (ADR 0009 rule 3). Nothing counts them, so
    "dropped" can't be shown for any existing draft.
- **Other AI surfaces**, for scope (see Non-goals):
  - *Wawasan* drafts already show their cited rows as links before approval. An approved AI explanation keeps its refs and the series it
    was approved against.
  - *Catatan manajemen* keeps the computed sentences it reworded (`facts`).
  - Ledger-file account mappings keep the suggested account, method, confidence and reason on the source account (names-only payload,
    `AiAccountMap` cache).
  - OCR drafts keep the rows read and the model, and every row is proved by the running balance.

## Decisions
- **Where in v1: AI bank lines on Review and Kotak, and AI drafts on Kotak.**
  - The roadmap says "each AI suggestion". These are the AI cards waiting for a decision, and the queue is where cards live now.
  - Rule, memory, transfer, simple-guess and 1999-correction cards are deterministic. Their reason already says why, and they get no
    disclosure.
- **A read model over existing rows, no new table, no migration** (as Kotak):
  - The reasoning is computed when the accountant opens it, from the line or proposal, the answer cache and the control rows.
  - Nothing new is stored per suggestion, with one exception: the count of dropped citations (below).
- **Bank line: find its cached answer by key, never by name.**
  - Buku recomputes the line's cache key from its own inputs: client, chart version, entity kind, the current chart, and the line's
    counterparty and direction.
  - Two inputs aren't stored, so Buku tries candidates for them, one batch of hashes and one lookup:
    - the models: each model this firm's AI usage names, the configured model, and the demo model;
    - the descriptions: those of the client's lines with the same counterparty and direction, newest first, at most 50.
  - A match proves which description and model were used.
  - The hash includes firm and client, so a match can't reach another tenant's answer. The cache is never queried by counterparty.
  - **No match** (the chart changed since, or the model is gone): the panel says so and shows only what the line itself stores. It
    never shows a payload it can't prove.
- **Draft: the rows sent are the control's rows today, shown only while the snapshot still matches.**
  - That is the same proof *Setujui* uses.
  - A stale draft shows the existing message ("Buku berubah sejak draf ini dibuat…") and no row values.
- **Record the count of dropped citations from now on** (*Jelaskan* only):
  - The explain parse also returns how many citations it discarded, and the count is stored in the cached answer's JSON. The cache key
    is unchanged and there is no column.
  - Only the count is kept, never the discarded strings: they are untrusted model text.
  - Drafts made before this release say "tidak tercatat".
  - Recorded as a line in accounting-rules 20b and a note on ADR 0009.
- **Rillet's three steps, in Buku's words.** Each panel is one ordered list:
  1. *Dicek dulu tanpa AI* / *Kontrol menandai* (retrieve);
  2. *Dikirim ke AI*;
  3. *Jawaban AI*;
  4. *Diperiksa Buku* (validate);
  5. *Belum dicatat* (calculate is Buku's own arithmetic, already done in step 4).
- **Only what was sent goes under *Dikirim ke AI*.**
  - A field the model didn't receive is never listed there.
  - A bank line's amount, date and source row already show on the card or under its source line, so they aren't repeated in the panel
    (ui-rules 9).
  - The chart sent is shown as a count ("82 akun, tanpa 1190 dan 1199"). The CSV lists it.
- ***Unduh nilai (CSV)***, one file per card, with the values the panel shows:
  - One row per value sent, per value returned and per check, each with its source.
  - Amounts exactly as sent, plus the same amount as an integer in minor units with its currency.
  - A bank line's amount appears only in a row marked *tidak dikirim*.
  - The format opens in Excel id-ID: semicolon, UTF-8 with BOM. A cell starting with `= + - @` or a tab is neutralised, because bank text
    is untrusted.
  - Served by a GET route under the Kotak page, like the other downloads.
  - Not a `REPORT_EXPORT`: a working file, not a report sent (ADR 0014's measure).
- **Loaded on open.**
  - One read-only server action behind `books.read` returns the panel, so Review and Kotak load exactly as today.
  - A draft's panel reruns the controls (as *Setujui* does), so it is paid for only when the accountant asks.
- **Who:** anyone who can read the books, viewers (*Peninjau*) included, may open and download. It writes nothing: no event, no AI
  call, no budget.

## Acceptance criteria
- [ ] Every AI bank line on Review and Kotak, and every AI draft on Kotak, has *Lihat alasan*; no other card has it.
- [ ] Bank line, the panel shows:
      - [ ] that transfer, rules, memory and financing/tax text found nothing at import;
      - [ ] exactly the fields sent: client context, direction, counterparty, description ≤ 80 characters, and the number of accounts
            offered;
      - [ ] a sentence that amount, date, balance and account number were not sent;
      - [ ] what came back: account, confidence, tax tag, reason, and the model and date (or *Jawaban demo, tanpa panggilan AI*);
      - [ ] Buku's checks: the code is in the chart; the receivable/payable replacement, with the original account, when it happened;
            whether the line may go in *Setujui N usulan yakin*, and why not.
- [ ] When the cached answer can't be matched, the panel says so and shows only the line's stored suggestion.
- [ ] Draft, the panel shows:
      - [ ] the control that flagged it;
      - [ ] the rows sent (date, text, amount, account, how), each marked cited or not;
      - [ ] the number of citations dropped (*tidak tercatat* for older drafts);
      - [ ] the checks it passed;
      - [ ] whether the books still match. A stale draft shows the existing message and no row values.
- [ ] *Unduh nilai (CSV)* holds the panel's values. Amounts are as sent and as integers. The line's amount is only in a *tidak dikirim*
      row. No cell runs as a formula. It opens in Excel id-ID.
- [ ] A viewer can open and download. An item of another client returns 404. Opening a panel writes nothing and calls no model.
- [ ] Enter on *Lihat alasan* in Review toggles the panel and does not accept the line.
- [ ] Works at 390 px without sideways page scroll.
- [ ] No number on any report changes (`verify:books` ALL PASS).
- [ ] Deck claims to review in ship:
      - `kantor.html` slide 07 *Review* ("Usulan akun dengan alasan dan tingkat keyakinan");
      - `kantor.html` slide 08 *Data dan AI* ("Anda tahu apa yang dikirim ke AI", the "Yang dikirim untuk baris itu" table);
      - `perusahaan.html` slide 12 *Data dan AI*;
      - `docs/demo/investor-demo.md` step 3 (an optional talking point).

## Verify flows
1. Accountant, CV Sinar Retail, August, Kotak: the 83 % grosir line → *Lihat alasan*.
   - The five steps show. *Dikirim ke AI* lists client, direction, counterparty, description and the account count, and nothing else.
   - *Jawaban AI* says *Jawaban demo, tanpa panggilan AI*. *Diperiksa Buku* says the line may be approved in bulk.
   - *Unduh nilai (CSV)* → the file holds the same values, and the amount sits only in the *tidak dikirim* row.
2. Same client, Review: the 74 % RAK DISPLAY line → *Lihat alasan* with the keyboard (Tab, Enter).
   - The panel opens and the line is not accepted.
   - *Diperiksa Buku* says why it is not offered in bulk (below 80 %).
   - Read-only on the demo, so `review-safety` and the investor walk stay as seeded.
3. AI draft: on the local stack, store one through `explainControl` with `MockProvider`, using a recorded answer that cites one row not
   sent (a one-off local script, no model call, not committed).
   - Kotak → the draft → *Lihat alasan*: the rows sent with the cited one marked, and "1 kutipan di luar baris yang dikirim dibuang".
   - CSV downloads.
   - Error: reclassify the cited bank line in Review → the panel shows "Buku berubah sejak draf ini dibuat…" and no row values.
4. Edge: on a QA client with an AI line, add an account in *Bagan akun* (the chart version moves) → the panel says the original answer
   can't be matched and shows the stored suggestion. A viewer opens and downloads. A CSV URL with another client's item id → 404.

## UX notes
- **Trigger.** *Lihat alasan* (ghost, small, chevron) at the end of the reason line, after the confidence. When open it reads *Tutup
  alasan*. It is visible, not hover-only (ui-rules 11).
- **Panel.** Inline under the reason line, in the same row: no box in a box, no sheet.
  - A numbered list of the steps. Each step has a short bold label and one or two plain lines.
  - Checks are icon + label (`Check` / `CircleAlert` in the review colour), never colour alone.
  - While loading, a one-line skeleton. If the panel fails to load, the action's Bahasa error, verbatim.
- **Bank line copy** (sentence case, accountant words):
  1. *Dicek dulu tanpa AI*: "Saat impor tidak ada pasangan transfer, aturan, memori klien, atau teks pinjaman, modal atau pajak yang
     cocok, jadi baris ini ditanyakan ke AI."
  2. *Dikirim ke AI*:
     - Klien "<context>" · Arah: uang keluar · Pihak lawan: <key> · Keterangan: "<80 characters>" · Daftar akun: N akun.
     - Then, muted: "Nominal, tanggal, saldo dan nomor rekening tidak dikirim."
  3. *Jawaban AI*: <code> <name> · keyakinan 92 % · pajak – · "<why>" · <model>, <date>.
  4. *Diperiksa Buku*: "Kode 6120 ada di bagan akun klien." The replacement sentence when it applies. "Boleh disetujui massal" or
     "Tidak ikut setujui massal: keyakinan di bawah 80 %" / "ada catatan akuntan di atas".
  5. *Belum dicatat*: "Baris ini tetap di 1999 sampai Anda menyetujuinya."
  - No match: one line above step 2: "Jawaban AI asli tidak bisa dicocokkan lagi karena bagan akun atau model berubah sejak usulan ini
    dibuat. Yang tampil: usulan yang tersimpan di baris ini."
- **Draft copy:**
  1. *Kontrol menandai*: title · company · *Perlu dicek* / *Gagal*, then the control's detail.
  2. *Dikirim ke AI*:
     - A compact table: Tanggal · Keterangan · Jumlah · Akun · Dikutip. Tanggal and Akun hide below `sm`.
     - Then, muted: "Juga nama klien, periode, mata uang, daftar N akun (tanpa akun bank, 1190 dan 1199) dan perusahaan grup."
  3. *Jawaban AI*:
     - "Penjelasan dan draf jurnal di atas."
     - "Mengutip 2 dari 6 baris." and "1 kutipan di luar baris yang dikirim dibuang" / "Kutipan yang dibuang: tidak tercatat".
  4. *Diperiksa Buku*:
     - Every account is in the chart and is not a bank account; debit = kredit; every amount equals a cited row's amount.
     - "Memindahkan satu baris bank: dicatat lewat Review" when it does.
     - Last: "Buku belum berubah sejak draf dibuat", or the stale or double-correction message.
- **Download.** *Unduh nilai (CSV)* is a link at the foot of the panel, the only action in it. The page's one primary button is
  unchanged.
- **Loading state.** No empty state exists: the trigger only renders on AI cards.

## Test seams
- **DB, bank-line reasoning:**
  - Import with `MockProvider` → the line's panel finds its cache row (model "mock") and the description sent.
  - Two lines with one counterparty and different descriptions → the right description.
  - A replaced receivable shows the original account.
  - A chart-version bump → the no-match result.
  - The same counterparty in another client never matches.
  - The demo's AI review lines all match (seeded model `demo-seed`).
- **DB, draft reasoning:**
  - `explainControl` with a recorded `MockProvider` answer that cites one id not sent → `dropped` 1 in the cache JSON. The panel shows
    the rows sent with the cited marks.
  - A cache hit keeps the count.
  - After a reclass → stale, no rows.
  - A proposal of another client is refused.
  - Extend `tests/db/close-explain.test.ts` where it already sets up.
- **Unit:**
  - the CSV writer: semicolon, BOM, quoting, formula neutralisation, bigint integers;
  - the explain parse's dropped count;
  - the step texts for each case.
- **E2E:** `e2e/lihat-alasan.spec.ts`, read-only on the demo.
  - Flows 1 and 2 (the CSV body asserted, Enter on the toggle doesn't accept).
  - A *Peninjau* opens and downloads.
  - 390 px without sideways scroll.
  - CI has no AI key and needs none.

## Non-goals
- *Lihat alasan* on these, each a later step on the same read model:
  - posted entries (the Jurnal Umum / Buku Besar origin line);
  - Wawasan's approved AI explanations (refs and series are stored, so this is the first follow-up);
  - Catatan manajemen (its facts are the computed sentences already on the page);
  - ledger-file account mappings (accepted inside the import draft; names-only payload);
  - Tutup Buku's AI review and *Jelaskan* answers without a draft;
  - OCR (proof checks, not proposals).
- A disclosure on deterministic cards (transfer, rule, memory, simple guess, financing/tax hint, 1999 correction, instalment, faktur).
- Storing prompts, raw answers or the discarded citation strings; a per-suggestion table or column.
- Re-running the chain against today's rules and memory ("would a rule match now?").
- The automation dial (Phase 2 item 3); changing what is sent to any model.

## Assumptions
- **The cache key can be recomputed.** It comes from inputs Buku still has: the current chart and chart version, the entity kind, a
  model from the firm's AI usage or the configured or demo model, and one of the same-counterparty descriptions. Every demo AI line in
  review matches, to be checked on the local demo in T1. Lines answered before a chart change fall back honestly.
- **The cache is only ever looked up by key.** It holds no firm or client column, so it is never filtered by counterparty.
- **At most 50 descriptions × a handful of models** per line is one batch of hashes and one indexed lookup.
- **A draft's panel reruns the controls once** per open, as *Setujui* does. Acceptable; measured in verify-local.
- **Enter is safe.** Review's keyboard handler already ignores Enter on a focused button.
- **Older drafts read fine.** A cached *Jelaskan* answer without the dropped count re-reads unchanged (the parse ignores extra and
  missing fields).
- **A viewer may see what was sent to the AI**, as they see the line itself.
- **There is no CSV writer yet.** A small one is added; it is not a general export framework.

## Gate re-openers
None planned:
- no migration (the dropped count is JSON in the existing cache row, for new answers only);
- no dependency;
- no real AI call (tests and the walk use `MockProvider` and the demo cache);
- no number on a report changes;
- no accounting invariant changes (the same discards, now counted).

Sensitive path: `app/actions.ts` gets one read-only action behind the existing `books.read` capability. The CSV route sits under
`app/(app)/`, outside the sensitive list.

If the recomputed key can't match the demo's AI lines reliably, linking a line to its answer needs a column. That is a migration: stop
and ask.

## Tasks
- [x] T1 Bank-line reasoning (`lib/approvals/reasoning.ts`) and the CSV writer, plus DB and unit tests.
      - Reasoning: the steps, the payload rebuilt as the prompt builds it, the cache match over candidate descriptions × models, the
        replacement, and the checks (whitelist, bulk rule, hints count).
      - Accept: the bank seams pass, and every demo AI review line matches.
      - Reuse: `aiCacheKey`, `aiScope`, `aiAccounts`, `isClassifiable`, `demoteUnbacked`'s reason, `bulkAcceptable` / `isSureSuggestion`,
        `accountantHints`, `entrySource`; `draftCsv`'s cell rules as a model.
- [x] T2 Count dropped *Jelaskan* citations.
      - `parseControlExplain` returns `dropped`. The provider passes it through. `explainControl` stores it in the cached answer and
        keeps it on a cache hit.
      - `MockProvider` gets a recorded explain answer (as `fluxAnswer`).
      - accounting-rules 20b line, ADR 0009 note.
      - Accept: the parse unit test and the DB cache test. (Parallel with T1.)
- [x] T3 Draft reasoning, in the same module.
      - The control, `controlSnapshot` against the stored snapshot, rows with cited marks, the dropped count from the cache row, the
        checks and the blocked or stale state.
      - Accept: the draft seams pass. (deps: T2)
- [x] T4 UI and download.
      - The `ReasoningPanel` disclosure on Review's AI items and Kotak's AI bank and draft cards, the read-only `reasoningAction`
        (`books.read`), and the GET `/clients/[id]/approvals/alasan?item=` CSV route (item checked against the client).
      - README's Kotak and Review rows.
      - Accept: flows 1–4 on the dev server, 390 px. Reuse: `MethodBadge`, `Collapsible`, `Skeleton`, `exportContext` /
        `findClientForMember`. (deps: T1, T3)
- [ ] T5 verify-local.
      - Walk flows 1–4 with screenshots at 1440 and 390 px. Add `e2e/lihat-alasan.spec.ts`. Run the full gate (`verify:books` ALL PASS).
        (deps: T4)

## Implementation
- Plan: T1–T4 inline by one build worker, in order (T1 and T3 share `lib/approvals/reasoning.ts`, T4 renders both; a fan-out would
  have split one module). T5's e2e spec is written here; the walk, screenshots and the full gate run centrally in verify-local.
- T1: `lib/approvals/reasoning.ts`, `lib/csv.ts`, `tests/db/reasoning-bank.test.ts`, `tests/unit/reasoning.test.ts`,
  `tests/db/demo.test.ts` — the bank-line read model: the line's cache key is recomputed from its own inputs (client, chart version,
  entity kind, today's chart as `aiScope` + `aiAccounts` build it, counterparty and direction) over candidate descriptions (its own, then
  its import's, then the counterparty's newest, ≤ 50, cut to 80 characters) × candidate models (the firm's `AiUsage` models, the
  configured one, `demo-seed`), one `findMany` by `cacheKey`. A row counts only when the line still reads as made from it (as given,
  replaced or capped by `demoteUnbacked`), so an equal answer under another description doesn't stand in. Every demo AI line in Review
  matches (`demo.test.ts`, the live upload's line included): no schema column needed. The CSV writer: semicolon, BOM, CRLF, quoting,
  formula cells (`= + - @`, tab, CR) neutralised with an apostrophe, plain integers kept as numbers.
- T2: `lib/ai/provider.ts`, `lib/controls/explain.ts`, `tests/unit/close-explain.test.ts`, `tests/db/close-explain.test.ts`,
  accounting-rules 20b, ADR 0009 note — `parseControlExplain` returns `dropped` (distinct citations outside the rows sent, or not an
  id); `explainControl` adds the provider's count to its own re-check's, stores it in the cached answer's JSON and keeps the stored
  count on a cache hit (re-reading filtered refs can't recount it). `MockProvider.explainAnswer` replays a recorded answer.
- T3: `lib/approvals/reasoning.ts`, `lib/controls/explain.ts`, `tests/db/close-explain.test.ts`, `tests/unit/reasoning.test.ts` — the
  draft read model: the control as it flags today, its rows rebuilt by `gather` and shown (cited marked) only while `snapshotOf` equals
  the draft's snapshot (*Setujui*'s proof), the dropped count from the cached answer (`storedDropped`; null → "tidak tercatat"), and the
  checks (chart and no bank account, debit = kredit, every amount a cited row's, a bank line through Review, `priorCorrection`, fresh or
  the existing stale message). `explainInput` / `explainKey` are extracted from `explainControl` (same input, same key) so the panel can
  recompute the answer's key over the candidate models: a match proves the chart size sent and the model, else the note names no count.
  `reasoningFor` routes an item id to the bank line or the draft of the client; anything else is "Usulan tidak ditemukan."
- T4: `components/app/reasoning-panel.tsx`, `components/app/review-queue.tsx`, `components/app/approval-queue.tsx`, `app/actions.ts`,
  `app/(app)/clients/[id]/approvals/alasan/route.ts`, README (Classify and Kotak rows) — `ReasoningDisclosure`: a ghost *Lihat alasan* /
  *Tutup alasan* toggle (chevron, `aria-expanded`) at the end of the reason line of Review's AI items and Kotak's AI bank and draft cards
  only, and the panel as a full-width row under it (numbered steps, checks as `Check` / `CircleAlert` + label, a draft's rows as a compact
  table with Tanggal and Akun hidden below `sm`, a one-line skeleton while loading, the action's error verbatim, *Unduh nilai (CSV)* as the
  only action). `reasoningAction` reads behind `books.read` (viewers included), writes nothing. The CSV route answers 404 for a client
  outside the member's reach and for an item that isn't that client's AI line or draft. The toggle is a button, so Review's Enter handler
  leaves it alone (it toggles, never accepts). Which cards get it is one rule (`lib/approvals/has-reasoning.ts`, AI bank lines and AI
  drafts) both components use.
- T5 (build part): `e2e/lihat-alasan.spec.ts` — flows 1 and 2 on the demo, read-only (CV Sinar's grosir and rack lines answer from the
  seed's `demo-seed` cache, so CI needs no AI key): the panel's steps, the downloaded CSV's body, Enter on the toggle, a Peninjau
  opening and downloading, 404s, 390 px. Not run here: the walk with screenshots, Playwright and the full gate (`verify:books`) run in
  verify-local.
- Acceptance criteria → tests (unit `tests/unit/reasoning.test.ts` = U, `tests/unit/close-explain.test.ts` = UC; DB
  `tests/db/reasoning-bank.test.ts` = DB, `tests/db/close-explain.test.ts` = DC, `tests/db/demo.test.ts` = DD; e2e
  `e2e/lihat-alasan.spec.ts` = E):
  - *Lihat alasan* on every AI bank line and AI draft, on no other card: U "which cards carry Lihat alasan" (the rule both components
    use); E `toggleOnlyOnAi` on CV Sinar's Kotak and Review and Grup Ayam's Kotak (with its schedule and faktur cards). The draft card's
    toggle on screen: verify-local flow 3 (an AI draft needs a model or a fixture; the demo has none).
  - Bank panel, checked first: U "lists the five steps"; E flow 1. Exactly the fields sent (client, direction, counterparty, ≤ 80
    characters, account count): DB "finds its cached answer…" (exact lines, no amount, date or account number), DB "names the description
    that was sent", U, E. The not-sent sentence: U, E. What came back with model and date or *Jawaban demo*: DB (mock + date), U (a real
    model and date), DD (every demo AI line matches `demo-seed`; Sinar's grosir answer), E. Buku's checks — in the chart, the replacement
    with the original account, bulk and why not: DB "shows the original account…", U (capped, missing account, hints, low), DD (grosir
    may go in bulk, rack below 80 %), E (both).
  - No match → said, only the stored suggestion: DB "…once the chart version moved", DB "never matches another client's answer", U.
  - Draft panel — the control, rows sent with cited marks, dropped count (*tidak tercatat* for older answers), the checks, fresh or stale
    with no row values: DC "Lihat alasan — an AI draft" (three tests), U "a draft's steps"; the count itself: UC "counts the citations
    it discards", DC "stores how many citations were outside the rows sent… keeps the count on a cache hit".
  - CSV — the panel's values, amounts as sent and as integers, the line's amount only in a *tidak dikirim* row, no formula cell, Excel
    id-ID (semicolon, BOM): U "the CSV writer" and "a bank line's CSV", U draft CSV, DC (rows as sent and as integers, no dropped string),
    E (the downloaded file, admin and Peninjau).
  - A viewer opens and downloads; another client's item 404; opening writes nothing and calls no model: E (Peninjau, 404 for the item
    under another client and for an unknown item), DB / DC refusals (another client, another firm, a non-AI line), DB and DC footprints
    (cache, usage, runs, journals, proposals and lines unchanged; `MockProvider.calls` unchanged).
  - Enter on *Lihat alasan* in Review toggles and accepts nothing: E flow 2.
  - 390 px without sideways scroll: E (Kotak with both panels open, Review), unconditional.
  - No report number changes: DD (`verifyBooks` still has no failures) and verify-local's `verify:books`.
  - Deck claims: reviewed in ship.

## Verification

## Ship Notes
