# 0020 — Roadmap after the spine: proof first, then a Rillet-grade AI pattern (2026-10-16)

**Status.** Accepted, 2026-10-16. The owner delegated the decision ("i trust your judgment"). The plan is
[docs/roadmap.md](../roadmap.md); its record is [cycle 2026-10-16-roadmap](../cycles/2026-10-16-roadmap.md).
This ADR replaces the iteration order (decision 4) of [0014](0014-three-stage-spine.md). The rest of 0014 stands.

**Context.**
- ADR 0014 ordered I0–I5. By 2026-10-16 most of I1–I5 is built: the inbox and upload link, completeness, OCR with running-balance
  proof, the confidence review, the report packs, cited commentary, anomalies, the firm board and Coretax reconciliation.
- I0 never ran. No accountant from a firm has closed a real month in Buku and been timed doing it.
- A fresh study of Zahir, Mekari Jurnal and Rillet (October 2026) found three things:
  - None of them serves the accounting firm.
  - Indonesian AI only narrates reports after the fact.
  - Rillet's advantage is its control surface: one approval queue, a reasoning view with the values it used, an automation
    setting, and flux explanations that move from draft to approved.

**Decision.**
1. **Four phases, in order. Each ends on an exit test a person can see:**
   - **0 — Ready for an outside firm.** The deferred import and reconciliation release (including the period-lock race fix),
     custom SMTP, final legal pages and a migration drift check.
   - **1 — Proof.** One firm closes clients every month, I0 included. Only the blocker log sets fix scope, and no new modules are
     added.
   - **2 — One AI pattern, Rillet-grade:**
     - Kotak Persetujuan (one approval queue);
     - Lihat alasan (a reasoning view);
     - a per-firm automation setting for deterministic sources only;
     - flux explanations as an approved close step;
     - Instruksi kantor, compiled into deterministic rules;
     - accrual suggestions from history.
   - **3 — Indonesian firm completeness:**
     - a close checklist with owner, reviewer and due date;
     - a second approver for manual journals and for reopening a month;
     - Coretax-ready output files (Buku prepares them and never files);
     - report layouts as configuration;
     - billing per firm.
2. **Invariants unchanged.** AI never posts. The automation setting covers only the deterministic sources (transfer match, rules,
   memory) and adds an Rp cap above which even these go to review. "Instruksi kantor" becomes deterministic rules the accountant
   approves; it is never a prompt at run time.
3. **AI on real client files during the pilot: off by default.** It is switched on only when the firm agrees in writing (UU PDP),
   as [real-month.md](../real-month.md) §2 already says. Phase 1 must succeed on rules alone.
4. **Pricing model:**
   - per firm, by active client-months;
   - no per-seat fee and no add-ons;
   - Rupiah amounts set after Phase 1, from measured time saved.
   Every benchmark shows that per-company pricing hurts firms.
5. **Not doing** (unchanged from 0014, plus one item): ERP breadth (inventory, POS, invoicing, payroll), live bank feeds, becoming a
   PJAP, marketplace settlements, and **AI narration or a chat bot as a product of its own**.

**Consequences.**
- Every `/spec` names its phase. Work outside the current phase needs a reason in its spec.
- **Owner-held work:**
  - choosing the pilot firm and accountant;
  - written consent before AI is used on real files;
  - SMTP and DNS secrets;
  - signing off the legal text;
  - the private release pipeline (the deferred release and private acceptances).
  Agents prepare these and never perform them.
- Phase 2 waits for the Phase 1 exit test, except work that is needed to run the pilot.
