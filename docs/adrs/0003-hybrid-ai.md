# 0003 — Hybrid classification; LLM last, cached, never auto-posting (2026-09-24)

**Context.** "AI-native" is the pitch, but LLM credit is limited, the sandbox cannot reach the provider, and self-reported LLM confidence is not trustworthy enough to write to a client's books.

**Decision.** Transfer matcher → rules → memory → LLM → heuristic. LLM = any OpenAI-compatible `/chat/completions` (OpenCode Zen by default, model from env), called outside DB transactions, one question per unique merchant key, ≤40 per call, cached forever, capped per import and per month, output whitelisted against the COA. AI suggestions land in suspense (1999) for review; reviewer decisions train Memory.

**Consequences.** Demo and tests run with zero credit (MockProvider + pre-cached answers). Month-over-month the share coded without AI rises (66% → 91% in the demo) — a real unit-economics story. Swapping model/gateway is config.

**Update 2026-10-10** (cycle `docs/cycles/2026-10-10-import-ai-background.md`): ≤15 per call (reasoning models cut off 40-item answers), one bounded split of a cut-off batch, one per-run call cap (`AI_MAX_CALLS_PER_RUN`), and the LLM step runs after the import in a background run per client — the import itself answers from rules, memory and the cache only.

**Note 2026-10-18** (cycle `docs/cycles/2026-10-18-instruksi-kantor.md`, ADR 0020 §2): a firm's *Instruksi kantor* becomes a deterministic
rule, hold or close control a person approves; the sentence is never a prompt at run time. A sentence Buku's own reader does not
understand may be offered to the model once, on the accountant's click: the sentence and the account names a rule may target only (as
account mapping, accounting-rules 17), a closed JSON answer grounded in the sentence and the list, budgeted and cached, and a draft until
approved (accounting-rules 20e). Reversible, so no new ADR.
