# 0009 — AI in the close: it explains and proposes, the accountant decides

**Context.** A hard test on real client files (27 Sep 2026) showed that Buku parses and posts faithfully (every Chickin account ×
month balance ties to its file) but that the close controls only prove arithmetic. A real bank month closed green while a loan
drawdown sat in revenue and total assets were negative. The direction is Rillet-style: the GL is the system of record and AI
watches it (anomalies, explanations, proposed entries). [0003](0003-hybrid-ai.md) keeps AI away from posting; [0007](0007-evidence-workspace.md)
bounds and budgets evidence calls. Neither covers AI reading the books themselves.

**Decision.**
1. **Deterministic checks first.** Sanity controls (negative asset total, balances against their nature, financing text in the
   P&L, months without data, accepted guesses) are plain code in `lib/controls`. AI never decides whether a control passes.
2. **AI explains and proposes, never acts.** An AI close review returns, per flagged control, an explanation and a proposed action.
   It cannot post, acknowledge, tick a sign-off or lock. Proposed entries (later cycles) are drafts the accountant accepts; posting
   still goes through `postJournal()` via the existing writers.
3. **Cited or dropped.** The review receives an explicit list of control keys and row ids; every returned item must cite only those.
   Anything else is discarded before it reaches the screen.
4. **Bounded payload.** Unlike classification and account mapping (names only), a close review may send **amounts and short bank
   descriptions**, but only of the rows behind flagged controls: at most 40 rows, descriptions cut to 80 characters, no files,
   no evidence passages.
5. **Same money discipline.** Every call reserves through `lib/ai/budget.ts`, has a per-period scope limit, is logged in `AiUsage`,
   and is cached by a hash of its input, model and prompt version, so reopening a page is free. No retries. Tests use `MockProvider`.

**Consequences.** Buku can refuse to call wrong-looking books "ready" without trusting a model, and AI adds value where the
accountant is stuck (why is this flagged, what should I do). Bank descriptions of flagged rows leave the firm's database to the
configured provider; firms that don't want that leave the AI key unset and keep the deterministic controls. Later cycles (1999
fixes, adjustment proposals, questions over the GL) extend this ADR instead of inventing new rules.

**Amendment (27 Sep 2026, cycle gl-anomaly-flux).** The deterministic checks now include ledger anomaly scans over journal lines
(flux against a 3-month baseline, P&L movement against its nature, new or reactivated accounts, possible duplicates; rule 22b). They
are REVIEW controls like the others: code decides, the accountant notes. For these controls the review may also send, within the
same ≤ 40-row cap, budget and cache: the flagged accounts' movement per baseline month and this month, and the month's journal lines
on them with their memo cut to 80 characters and their source (bank row, ledger `sheet!row`, adjustment). A ledger-file memo is the
client's own GL description, the ledger counterpart of a bank description; nothing else from the file (other rows, other accounts,
evidence passages) is sent.

**Note (27 Sep 2026, cycle adjustment-schedules).** The first "proposed entries" (decision 2) are deterministic, not AI: adjustment
schedules propose each month's depreciation, amortisation and accrual installment, and ledger candidates suggest new schedules. They
follow the same rule — nothing posts until the accountant clicks, and posting goes through `postJournal()` (accounting-rules 5a).
AI-drafted entries remain a later cycle and will reuse this path.

**Note (27 Sep 2026, cycle close-copilot).** Decision 2's AI-drafted entries now exist: *Jelaskan* on one flagged control may return
a draft journal, validated before storage (accounts from the chart, never a bank account; balanced; every amount equal to a cited
row's amount) and stored as a `ProposedEntry`. Only the accountant's click posts it — through `postJournal()`, or through the
reviewer's writer when the draft re-classifies a single bank line. A draft note only prefills the acknowledgement dialog.


**Note (17 Oct 2026, cycle wawasan-keuangan).** A second path reads the books under the amendment's payload: *Susun dengan AI* on a
mover of Analisis keuangan → *Wawasan* drafts why one flagged P&L account moved, for the owner. It sends only what the close review
sends for that account (its movement per baseline month and this month, and up to ten of the month's largest lines on it) and may only
cite those rows (decision 3); every number in the draft must appear in them, and only the accountant's approval stores it
(accounting-rules 20d). Same budget, cache and no-retry rules (decision 5).
