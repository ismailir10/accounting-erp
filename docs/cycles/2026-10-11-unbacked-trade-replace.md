# Unbacked trade suggestions: replace the account, don't just lower the confidence

## Context
When an entity's books hold no trade receivable (or payable), the AI still proposes *1130 Piutang Usaha* for customer receipts and
*2110 Utang Usaha* for supplier payments. Cycle `2026-10-09-close-run-polish` (A1) only lowered such a suggestion to 55% and added
"Belum ada piutang usaha tercatat…"; the **wrong account stays selected**.

Seen twice in production. Latest: the 2026-10-11 walk of client Belifi (PT Belifi, BCA ·3814, Jun + Agu 2026): ~200 of 248 Review rows
were pre-filled *1130 Piutang Usaha* at 55%. The accountant must retype the account per group (*Terima N serupa* / *Simpan untuk N
serupa*). Accepted unchanged, the receipts would leave Piutang Usaha **negative** and understate revenue — and a pre-filled account that is
known to be impossible is a trap, not a hint. It feels worst for the accountant on a first month-end of a new client (no invoices yet), which
is exactly the "rekening koran in → laporan out" promise.

Desired: when the guard fires, the suggestion is **replaced** by the account the simple guess already uses for an unexplained line —
customer receipt → *4100 Penjualan*, payment out → *6190 Beban Umum* (a person's books: 4910 / 3300, same as today's guess) — still only a
suggestion, with the reason saying why, below the bulk accept, so one *Terima N serupa* click fixes a whole group.

## Decisions
1. **Reuse the simple guess's account choice** (`simpleGuess`: company in → 4100, out → 6190; PERORANGAN in → 4910, out → 3300). No new
   account-picking logic; the choice stays in one place (rule 13). *Why:* the user asked for reuse, and a person's own books must not get a
   company sales account.
2. **The line stays an AI suggestion (method AI, confidence 0.55), not a plain HEURISTIC guess.** *Why:* an AI-method line is never re-asked by
   *Minta saran AI* (only HEURISTIC lines are) and the background run, so replacing cannot loop; Enter and *Terima N serupa* keep working (a
   HEURISTIC *tebakan* refuses Enter, which would leave ~200 rows needing manual picks again — the exact pain). Below 0.6 the sanity control
   *Tebakan diterima tanpa diubah* still raises it if accepted unchanged, as today.
3. **0.55 stays the confidence** (below the 0.8 bulk accept and the 0.6 *tebakan* line). Never auto-posts (< 0.9, method AI).
4. **The reason is rewritten, not appended.** The AI's own reason ("Pelunasan piutang usaha") contradicts the new account. New reason names
   what happened: "AI mengusulkan 1130 Piutang Usaha, tetapi tidak ada piutang tercatat: dianggap penjualan tunai (4100)." / payable:
   "…tidak ada utang usaha tercatat: dianggap beban (6190)." The reason is the accountant's cue to check, so it names the original account.
5. **The tax tag is cleared** on a replaced suggestion (a tag chosen for a receivable settlement says nothing about a sale).
6. **If the fallback account is not in the client's chart** (a client COA without 4100 / 6190), the old behaviour applies (keep the AI account,
   demote, append the reason). Never post or suggest an account the chart lacks.
7. **Date-aware backing is unchanged** (`tradeBacking(asOf)`): a receipt before an invoice booked later is replaced; one after it is left
   as the AI gave it. The cached AI answer is untouched; no extra AI call (rules 14, 17–20).

## Acceptance criteria
- [ ] Customer receipts of an entity with no receivable on its books are suggested as *Penjualan* (4100), not *Piutang Usaha*, at 55%, with a
      reason naming the original suggestion and "dianggap penjualan tunai".
- [ ] Payments out of an entity with no payable are suggested as *Beban Umum* (6190), not *Utang Usaha*, with the matching reason.
- [ ] A person's (PERORANGAN) books get that kind's guess accounts (4910 / 3300), never 4100 / 6190.
- [ ] The same happens at import and when AI suggestions arrive later (*Minta saran AI* / background run).
- [ ] With a receivable (or payable) on the books by the row's date, the AI's 1130 / 2110 is left exactly as given.
- [ ] Replaced rows are grouped as *serupa* and *Terima N serupa* books all of them to 4100 in one click; Enter accepts one; nothing is
      auto-posted (all stay NEEDS_REVIEW on 1999 until accepted).
- [ ] Accepted unchanged, the line is flagged by the existing *Tebakan diterima tanpa diubah* control (confidence < 0.6).
- [ ] When the client's chart lacks the fallback account, the AI account is kept with the old demotion.
- [ ] Belifi-like fixture (customer transfers, no invoices): no row proposes 1130; `verify:books` ALL PASS.

## Verify flows
1. **Belifi-like client, Review (accountant).** Import a statement with several transfers from the same customers and a few supplier payments,
   no invoices, AI answering with 1130 / 2110 (MockProvider only). Open Review → each customer row shows *4100 Penjualan* at 55% and the reason;
   *Terima N serupa* on a group records all N to 4100 and they leave the queue.
2. **Edge: backing appears.** Same client with one posted sales invoice dated before the receipts → the receipts keep *1130 Piutang Usaha*
   (≥ 80% where the AI said so); a receipt dated before the invoice is replaced.
3. **Error / change-mind case.** On a replaced row pick a different account and *Simpan untuk N serupa* → saved to the chosen account; a
   PERORANGAN entity's receipts show 4910, not 4100.

## UX notes
No new screen. Review row: same card, account selector pre-filled with 4100 / 6190, "keyakinan 55%", reason line as in Decision 4. No new
copy beyond the reason strings (Bahasa).

## Test seams
- Unit (`tests/unit`): the replace rule in `demoteUnbacked` — IN/OUT, company vs PERORANGAN, backed vs not, fallback account missing from
  the chart, non-AI method untouched, tax tag cleared, reason text.
- DB (`tests/db/ai-unbacked.test.ts`, extended): Belifi-like fixture through `importStatement` — account is 4100 / 6190 at 0.55, rows group as
  `serupa`, bulk accept (the reviewer's writer used by *Terima N serupa*) books them all and nothing was posted before; with a receivable on
  the books by date unchanged; *Minta saran AI* path replaces the same way. Update the existing assertions that expected 1130 / 2110 at 0.55.
- Browser: local walk of Review (verify flow 1–3).

## Non-goals
- Changing the AI prompt, model, cache or budget; making the model aware of the books (the guard stays deterministic, post-AI).
- Touching the 0.55 value, the bulk-accept line, or the *tebakan* sanity control.
- Customer-by-customer revenue accounts, or choosing the entity's "own" sales account beyond 4100 (the chart's other revenue accounts are not guessed).
- Rewriting rows already in Review is a separate task (T4), not part of the classifier change.

## Assumptions
1. 4100 / 6190 (4910 / 3300 for a person) are the right fallback accounts because they are what `simpleGuess` already proposes for an unexplained line.
2. Method stays AI (see Decision 2); a replaced suggestion accepted by the accountant teaches Memory like any accepted AI suggestion (an explicit
   decision by them), and the *tebakan* control still reports an unchanged accept.
3. No schema change, no new dependency, no AI call. The only production write is the T4 data migration.
4. Documentation to keep true: `accounting-rules` rule 14's unbacked sentence (the skill is a Buku skill, editable here) and the 2026-10-09 cycle's A1 is
   history, left as is.

## Decided (was open question)
Rows already sitting in production Review (Belifi's ~200, NEEDS_REVIEW with 1130 at 55%; re-import is blocked by the dedupe) **are fixed in
this cycle** by a one-off **data migration** (user said yes, 2026-10-11): it applies the same replacement to NEEDS_REVIEW, method AI rows whose
reason carries the old "Belum ada … tercatat" text, only where the client's chart has the fallback account, and never touches an accepted row.
It runs with the deploy's migrations (a production write: merge to main is the user's).

## Gate re-openers
Accounting-invariant text (rule 14) changes · production data write by the T4 data migration (approved) · none otherwise (no migration of schema,
no dependency, no real AI call, no auth/PII change).

## Tasks
- [x] T1 Replace rule in `lib/ai/unbacked.ts` (`demoteUnbacked` gets the entity kind and chart codes; reuses `simpleGuess`'s account) and the two
      callers in `lib/import/pipeline.ts` and `lib/ai/retry.ts` — accept: unit tests for the rule pass; typecheck clean (deps: none, reuse: `simpleGuess`)
- [x] T2 DB tests: Belifi-like fixture, group *serupa* bulk accept, date-aware backing, *Minta saran AI* path; update old assertions — accept: `npm test` green (deps: T1, reuse: `tests/helpers.ts`, `lib/review.ts` writer)
- [ ] T3 `accounting-rules` rule 14 sentence updated — accept: states replace-not-keep, links `lib/ai/unbacked.ts` (deps: T1)
- [ ] T4 Data migration for existing Review rows — accept: a db test applies it to a seeded old-style row (deps: T1)
- [ ] T5 Gates and verify-local: `npm run lint && npm run typecheck && npm test`, `npm run build && npm run demo:reset && npm run verify:books` (ALL PASS), local browser walk of Review — accept: `Verified locally — <sha>` recorded (deps: T1–T3)

## Implementation
- Plan: T1–T5 sequential, all inline (one small slice in `lib/ai`, each task needs the previous one's signature; a worker would need the whole plan as context). Reviews done by the driver on the diff.

- T1: `lib/ai/unbacked.ts` (`demoteUnbacked(c, direction, kind, accountOf, backing)`: replaces with `simpleGuess`'s account, rewrites the reason, clears the tax tag, caps at 0.55; `accountLookup` helper; falls back to the old demotion when the chart lacks the account), callers `lib/import/pipeline.ts` and `lib/ai/retry.ts`. Test: `tests/unit/ai-unbacked.test.ts`.
- T2: `tests/db/ai-unbacked.test.ts` — old assertions now 4100 / 6190, date-aware case (later receipt keeps 1130), Belifi-like fixture (3 + 1 customer receipts, 1 supplier payment, no invoices) with `acceptSimilar` booking the group to 4100 and 1130 untouched.

## Verification

## Ship Notes
