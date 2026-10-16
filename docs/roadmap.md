# Buku roadmap

> **Status:** accepted, 2026-10-16 ([ADR 0020](adrs/0020-roadmap-after-the-spine.md)). It is the basis for every `/spec`, and each
> spec names its phase.
> **Benchmarks:** Zahir and Mekari Jurnal for the Indonesian market; Rillet for how AI is built into the close.
> **Relation to [ADR 0014](adrs/0014-three-stage-spine.md):** the thesis, the three-stage spine, the AI pattern and the not-doing
> list do not change. ADR 0014's iterations I1–I5 are mostly built. This document replaces that iteration order from here on.

## 1. The answer in six lines

1. **Nobody serves the accounting firm.** Zahir and Jurnal sell to business owners, priced per company. Zahir even sells its own
   bookkeeping service, so it competes with firms for the same clients. Rillet sells to in-house finance teams, and firms only
   implement it. A close workspace across many clients is open ground, and Buku already stands on it.
2. **Indonesian "AI" today narrates reports after the fact.** Zahir AI is a WhatsApp chatbot sold separately. Airene summarises the
   P&L and replies in English. Neither reads statements, classifies transactions or drafts entries. Buku already does all three.
3. **Rillet's lesson is the control surface, not the model.** Every AI write is a card you approve, edit or reject. All cards wait
   in one queue, each shows its reasoning and the values it used, and automation is a dial you set. Rillet's own benchmark found
   that no frontier model produced revenue-recognition output good enough to post. Accounting policy belongs in code, with AI
   working on top of it. That is ADR 0003/0009 already.
4. **Buku's gap is proof, not breadth.**
   - No firm closes its clients in Buku every month yet.
   - The I0 real-month baseline was never recorded.
   - Only 3 of 25 bank formats have been checked against real files.
   - Invitations can't reach outside addresses until custom SMTP is set up.
   - The legal pages are still drafts.
5. **So the order is:**
   - Phase 0: make production ready for an outside firm.
   - Phase 1: prove it with one firm, every month.
   - Phase 2: make the AI pattern Rillet-grade.
   - Phase 3: fill the Indonesian firm gaps the pilot confirms.
6. **No ERP breadth.** Inventory, POS, invoicing, payroll and live bank feeds stay with Zahir, Jurnal and Accurate. Their exports
   are one of Buku's sources.

## 2. What the research found

**Zahir** (since 1996; roughly 30,000+ companies, claims conflict)
- **Pricing.** Cloud plans run from Rp150k/month (1 user). Every plan has caps: 1,000 transactions a month and Rp100M of sales a
  month. Bank reconciliation, multi-currency, branches and transaction import are each a paid add-on.
- **Bank data.** Only BCA Personal CSV imports as-is. Every other bank is retyped into a Zahir template. Matching is a plain rule:
  same date plus same amount.
- **Tax.** It exports e-Faktur CSV. We found no evidence that it supports Coretax.
- **AI.** Zahir AI (Sep 2024, with Lenna) is a business-intelligence chatbot on WhatsApp and Telegram, at Rp500k–5M a month. It does
  no bookkeeping.
- **Firms.** It has no accountant console. It does run Zahir Accounting Services (Rp5M a month to Rp150M a year), which sells
  bookkeeping straight to SMEs.
- **Legacy.** The desktop versions date back years: Firebird database, dongle licence. The help-centre articles are mostly from
  2019–2023.

**Mekari Jurnal** (35,000+ companies; part of the Mekari suite, now sold as an SME-to-enterprise ERP)
- **Pricing.** Essentials is Rp399k/month for 3 users; Plus is Rp899k/month for 5 users. Prices are per company, with no package
  for firms.
- **Bank data.** "Cashlink" pulls statements by API from 4–6 banks. Its feature page lists BCA (Corporate and Personal), Mandiri,
  CIMB Niaga, BNI, BNI Syariah and Danamon as examples. The help article updated in Jul 2026 names four: BCA, BNI, Mandiri and CIMB
  Niaga. BRI is in neither.
  Each bank needs the owner's signed authorisation. Reconciliation auto-matches on date, description and amount, plus "bank rules".
  No statement file formats are documented.
- **Reports.** It claims 80+ reports and a combined multi-company view.
- **Close.** "Tutup Buku" is a date lock. We found no close checklist and no sign-off.
- **Tax.** Tax runs through Klikpajak, Mekari's own PJAP. It covers e-Faktur, e-Bupot and Coretax uploads, billed separately.
- **AI.** Airene summarises the P&L and cash flow and flags trends, but replies in English. "Rekonsiliasi AI" and receipt OCR appear
  on a landing page but have no documentation. Its Anomaly Checker (budget overruns) was demoed in Sep 2026.
- **Firms.** The firm channel is a reseller programme with up to 30% cashback, not a workspace. Reviewers name per-company pricing
  for multi-company users as a pain point.

**Rillet** (US; about $208M raised; Series C at a $1B valuation in Aug 2026; 600+ customers)
- **Product and price.** Own GL with sub-ledgers. Priced per quote with no per-seat fee, estimated at $20–35k a year.
- **Reports.** Every report figure drills down to its GL lines, with the documents shown inline.
- **Close.** "Zero-day close" is the pitch. The CEO says most customers close in a few days.
- **AI (Aura): verified patterns worth copying.**
  - **Approval cards.** Every change to data (journals, bills, payments, checklist ticks) arrives as an Approve / Edit / Reject
    card. Agents pause at each write step. All proposals land in one *Command Center Queue*, and each posted record links back to
    the agent or chat that made it.
  - **View reasoning.** Shows the steps an answer took (retrieve → validate → calculate), with links to source records and a CSV
    snapshot of the exact values used.
  - **Automation dial.** Bank matching runs in one of four modes: high confidence, rule, medium confidence, or never. An amount cap
    sends anything above it to a person.
  - **Accruals agent.** Compares this month's spend per vendor with its history and proposes an accrual with a written rationale,
    marked *Needs review*.
  - **Flux.** Flags movements over Rp and % materiality thresholds. AI drafts the explanation with source links; a person moves it
    from *Draft* to *Approved*, and approved explanations are kept.
  - **Memory.** Firm preferences ("flag bills > $10K") are stored and applied. An MCP connection inherits the user's role.
  - **Approval routing.** Journal approval rules can route by where the entry came from: AI, UI or API.
- **Gaps.** It has no multi-client firm console. Its first version of reporting groups has no eliminations.
- **Closest analogue for firms: Digits "Agentic Close"** (Jun 2026). A firm writes plain-English instructions, and Digits compiles
  them into *deterministic, always-on checks*. Its models abstain when unsure. Only exceptions reach the firm's checklist.

## 3. Benchmark vs Buku today

Lead = Buku is ahead · Par = good enough · Gap = worth building · Skip = not our fight.

| Area | Zahir | Jurnal | Rillet | Buku today | Verdict |
|---|---|---|---|---|---|
| Built for | SME owner | SME → enterprise | US finance team | Indonesian accounting firm | **Lead** (only one) |
| Bank data in | BCA CSV; others retyped | API feeds, 4–6 banks, owner's mandate | Plaid + CSV | 25 banks: PDF, CSV, XLSX, MT940, and scans read by OCR; every row proven by the running balance. **3 of 25 formats checked on real files** | **Lead** in coverage, **Gap** in proof |
| Matching / classification | date + amount | auto-match + bank rules | ML match, confidence modes, amount cap | transfer match → rules → memory → LLM → review with confidence %. Deterministic matches post at one fixed threshold | Par; **Gap**: per-firm automation dial |
| Moving an existing client's books in | master-data CSV; transactions are a paid add-on | API | specialist-led, 4–6 weeks | Jurnal, Accurate and Excel GL/Neraca exports, each line traced to `sheet!row` | **Lead** |
| GL integrity | — | audit trail | native GL | one writer, bigint money, DB triggers, no plugs, `verify:books` | **Lead** |
| Reports | 130+ | 80+, combined view | custom builder, drill-down | full SAK set + CALK, per-client format, credit and management packs, drill-down to the bank row | Par+; drill-down to the source row is **Lead** in Indonesia |
| Close | optional month lock | date lock | checklist with owners and reviewers, admin-only reopen | controls, sign-offs, sequential lock, admin unlock with a reason | Par; **Gap**: tasks with owner, reviewer and due date |
| Journal approval | ERP tier | multi-level approvals | approval routing by source and amount | accountant approves AI drafts; manual journals have no second approver | **Gap** |
| Tax | e-Faktur CSV; no Coretax found | Klikpajak (PJAP): e-Faktur, e-Bupot, Coretax | US | Pajak Masa workpaper, PPh 21 TER, PPh Badan pack, Coretax import reconciled to the GL | **Lead** on workpapers; **Gap**: Coretax-ready output files |
| AI | separate BI chatbot | P&L summaries in English | approval cards, reasoning, accruals, flux, memory, MCP | classification, account mapping, OCR, *Jelaskan* + draft entries, commentary citing only computed numbers, Tanya Buku; never posts | Ahead of the incumbents; **Gap** vs Rillet: one queue, reasoning view, flux approval, firm memory |
| Multi-client firm | none | reseller cashback | partners implement; no console | firm board, roles, client assignment, upload link `/kirim` | **Lead** |
| Sub-ledgers / ERP | full ERP | full ERP | AR, AP, prepaids, assets | AR/AP from bank, assets, leases, benefits, periodic stock count | **Skip** the rest |
| Pricing | per company, add-ons, caps | per company | no per-seat fee | not set | Decision (§7) |

Caveat: competitor facts come mostly from vendor pages and help docs read in October 2026. Review sites blocked fetching, so the
complaints come from search snippets. Prices exclude PPN and change often. Buku facts come from the code at `ec00b5b`.

## 4. "Best of three" — what we take, what we leave

| From | Take | Leave |
|---|---|---|
| Zahir | Standard Bahasa report names and layouts; teaching through campuses and schools (graduates already know the product) | Add-on pricing and usage caps; desktop legacy; AI as a separate product |
| Jurnal | Matching on date, description and amount; bank rules; a combined multi-company view; tax prepared for a PJAP partner, not by becoming one | Per-company pricing for firms; a date lock posing as a close; AI that only narrates, in English |
| Rillet | One approval queue; approval cards; *View reasoning* with a values snapshot; the automation dial; flux Draft → Approved; firm memory; routing by source; admin-only reopen | US scope (ASC 606, Plaid); "zero-day close" as a promise; quote-only opaque pricing |
| Digits | Plain-language firm instructions compiled into deterministic checks; abstain when unsure | — |

## 5. Development roadmap

Each phase ends on an **exit test**: something a person can see or measure, not "code merged". Sizes assume the current pace
(one developer plus agents). Every item still goes through the normal loop: `/spec` → approval → `/build` → verify-local → `/ship`.

### Phase 0 — Ready for an outside firm (1–2 weeks)
The basics a paying firm hits on day one. **Owner** means the item needs the owner's hands: private files, secrets, a signature.
Agents prepare those items and never perform them.

| # | Item | Who |
|---|---|---|
| 1 | **Ship the deferred import/reconciliation release** (six migrations). It includes the period-lock race fix: today a post can commit into a month that was locked in the meantime ([cycle](cycles/2026-10-15-ledger-post-once.md)) | Owner (private release pipeline) |
| 2 | **Custom SMTP and a verified mail domain** (SPF, DKIM, DMARC), so invitations reach addresses outside the Supabase organisation ([README](../README.md)) | Owner (secrets, DNS) |
| 3 | **Final legal pages.** `/syarat` and `/kebijakan-privasi` are drafts. They need a clear UU PDP position on AI processing, which follows ADR 0020 decision 3 | Agent drafts; owner signs off |
| 4 | **Migration drift check.** This is the open decision in [build-hooks](cycles/2026-10-15-build-hooks.md) | Agent |
| 5 | **Close the unchecked acceptance boxes** in the 2026-10-15 cycles | Owner (private acceptances) |

**Exit test:** an accountant from an outside firm accepts an invitation, signs in to production and imports a file, and the
lock-race fix is live.

### Phase 1 — Proof: one firm, every month (about 4 weeks, starts during Phase 0)
Nothing in Phase 2 is worth building until a real accountant closes real months.
1. **Run I0** exactly as in [docs/real-month.md](real-month.md): one client, one month, the firm's accountant at the keyboard,
   timed. **Record the baseline**: files received → pack sent.
2. **Then 5 clients for two consecutive months**, closed by the firm's own staff.
3. **Fix only what the blocker log shows, ranked by minutes lost.** No new modules.
4. **Promote bank formats to REAL only from real files.**
   - **What enters Git:** a new synthetic fixture that reproduces the layout only. Nothing is copied from the real file.
   - **The real file:** stays in `data/private/` or in production ([real-data.md](real-data.md); AGENTS.md §8).
   - A bank is added only when a real client's file arrives.

**Exit test:**
- the baseline is written in a cycle doc;
- 10 client-months have been sent by the firm;
- zero Temuan reached a sent report;
- the time from files received to pack sent is lower in month 2 than in month 1.

### Phase 2 — One AI pattern, Rillet-grade (4–6 weeks)
The rule stays the same: AI proposes, arithmetic proves, the accountant approves. This phase makes that rule visible and
controllable, in priority order:
1. **Kotak Persetujuan (one approval queue).**
   - **What goes in:** every proposal, in one queue per client with a count on the firm board. That covers AI classifications,
     *Jelaskan* drafts (`ProposedEntry`), adjustment-schedule instalments and Coretax mismatches.
   - **How it works:** each item is a card with Approve / Edit / Reject, and bulk approval applies only where it is already safe.
   - **Traceability:** every posted entry links back to the proposal that produced it.
2. **Lihat alasan (view reasoning).** Each AI suggestion shows its steps, the rows it cited and the values it used, and the values
   can be downloaded. The data exists already: "cited or dropped" is ADR 0009 rule 3. This item shows it.
3. **Automation dial per firm.**
   - **Settings:** which deterministic sources post directly (transfer match, rules, memory), plus an Rp cap above which they go to
     review anyway.
   - **Fixed rule:** AI suggestions stay review-only (invariant 4).
4. **Flux as a close step.**
   - **Thresholds:** materiality per firm in Rp and %. Today it is a fixed 1%.
   - **Flow:** AI drafts an explanation citing rows; the accountant edits it and marks it *Disetujui*.
   - **Reuse:** approved explanations feed the management pack and are offered again next month.
5. **Instruksi kantor (firm memory, the Digits pattern).**
   - **What the accountant writes:** a plain-Bahasa instruction, for example "biaya admin bank selalu 6190" or "tandai pengeluaran
     > Rp10 jt".
   - **What Buku does with it:** compiles it into a deterministic rule or control. The accountant previews it and approves it.
   - **Fixed rule:** the instruction is never a free-text prompt at run time.
6. **Accrual suggestions from history.** When a vendor that recurs every month is missing this month, Buku proposes an accrual with
   a rationale. This extends the existing ledger-derived adjustment candidates.

**Exit test** (measured against the Phase 1 baseline):
- a higher share of rows posted with proof and no manual touch;
- fewer review minutes per client-month;
- every AI-originated entry traces to its approved proposal.

### Phase 3 — Indonesian firm completeness (4–6 weeks; final scope set by the pilot)
1. **Close checklist per client:** tasks with an owner, a reviewer (staff → partner) and a due date, carried forward each month and
   rolled up on the firm board. It builds on the sign-offs that exist.
2. **Second approver** for manual journals and for reopening a month, routed by source (manual, AI draft, import) and amount.
3. **Coretax-ready output files.** Faktur and bupot files the accountant or a PJAP uploads. Buku prepares them and never files
   (ADR 0014). The DJP format must be confirmed against a real upload before building.
4. **Report layouts as configuration.** Report customisation is the incumbents' most frequent complaint. New layouts the pilot asks
   for are added through the account-to-line mapping, not new code.
5. **Billing per firm** in Backoffice grants, once the pricing decision in §7 is made.

**Exit test:** the pilot firm runs its month-end, from checklist to sign-off to pack to Coretax files, without leaving Buku except
to upload the Coretax files.

### Later — only when a paying firm asks
- Exporting adjusted journals back to Jurnal or Accurate (clients keep using those tools).
- Foreign-currency bank statements.
- Full consolidation beyond the combined worksheet.
- Booking continuously as files arrive in the inbox.
- Read-only MCP/API access to "ask your books" from outside assistants.

## 6. Not doing
These follow ADR 0014, sharpened by the research:
- **Inventory, BOM, POS, invoicing, payroll.** That is the incumbents' ground, and their exports are Buku's input.
- **Live bank feeds.** They need the owner's e-banking login and mandate, which firms don't hold. The rekening koran stays the
  integration.
- **Becoming a PJAP.** Buku prepares the files and a partner submits them.
- **Marketplace settlements** (Shopee, Tokopedia).
- **A chat-on-WhatsApp BI bot or after-the-fact AI narration as a product.** AI lives inside the close.

## 7. Metrics and decisions

**North star:** the time from client files received to a pack ready to send. First measured in Phase 1.

**Companion metrics:**
- the share of rows posted with proof and no manual touch;
- Temuan in sent reports (target 0);
- review minutes per client-month;
- the share of cycles that are fix rounds.

**Decisions made** (2026-10-16; the owner delegated them; recorded in [ADR 0020](adrs/0020-roadmap-after-the-spine.md)):
1. **The roadmap is accepted.** It replaces ADR 0014's iteration order.
2. **AI on real files is off by default during the pilot.** It is switched on only if the firm agrees in writing (UU PDP;
   [real-month.md](real-month.md) §2). Phase 1 must succeed on rules alone.
3. **Pricing model:** per firm, by active client-months, with no per-seat fee and no add-ons. The Rupiah amounts are set after
   Phase 1, from the measured time saved.

**Only the owner can do:** choose the pilot firm and the accountant who sits at the keyboard. Phase 1 cannot start without them.

## Sources
- **Zahir:** zahiraccounting.com/id/harga · zahiraccounting.com/id/zahir-accounting-7 · help.zahironline.com (bank reconciliation,
  e-Faktur plugin) · zahir.ai · zahir.co.id/produk/zas · industri.kontan.co.id (Zahir AI launch, Sep 2024).
- **Jurnal:** jurnal.id/id/harga · jurnal.id/id/fitur/kas-transaksi/cashlink-bank · jurnal.id/id/blog/rekonsiliasi-bank-cash-link · jurnal.id/id/blog/cara-rekonsiliasi-bank-otomatis
  · jurnal.id/id/fitur/airene-artificial-intelligence-accounting-software · jurnal.id/en/partnership/consultant ·
  klikpajak.id/blog/pjap-era-coretax · softwareadvice.com/accounting/jurnal-profile.
- **Rillet:** docs.rillet.com (actions and approvals, audit trail, transaction automation, AI accruals, flux analysis, close the
  books, memory) · rillet.com/blog (Sep 2026 updates, revenue-recognition benchmark, MCP/Aura Flow) · iconiq.com (Series C) ·
  numeric.io/blog/rillet-pricing (competitor estimate).
- **Digits:** cpapracticeadvisor.com, 2026-06-08 "Digits unveils Agentic Close for accounting firms".
- **Buku:** code at `ec00b5b`; ADRs 0003, 0004, 0009, 0012, 0014, 0017; cycles 2026-10-06 to 2026-10-15; `lib/banks.ts` evidence
  levels.
