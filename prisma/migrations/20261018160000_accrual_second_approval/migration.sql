-- Usulan akrual × Persetujuan kedua (docs/cycles/2026-10-18-usulan-akrual.md, "Decisions while integrating"). Additive: one nullable
-- column, no backfill. With *Jurnal manual* on, an approved accrual card above the threshold waits as a MANUAL request with *Balik
-- otomatis*; `accrualKey` names the proposal (its `ProposedEntry` key, stored only once the request is approved and posted), so the
-- card leaves *Usulan akrual* while it waits and the approval stores the decision. Null for every other request.
ALTER TABLE "JournalApproval" ADD COLUMN "accrualKey" TEXT;

-- An accrual request is a manual journal with its reversal; the other sources' fields stay as they were.
ALTER TABLE "JournalApproval" DROP CONSTRAINT "JournalApproval_source_check";
ALTER TABLE "JournalApproval" ADD CONSTRAINT "JournalApproval_source_check" CHECK (
  ("source" = 'REVERSAL') = ("reversesId" IS NOT NULL)
  AND ("source" = 'AI_DRAFT') = ("proposalId" IS NOT NULL)
  AND ("source" = 'MANUAL' OR NOT "reverseNextMonth")
  AND ("accrualKey" IS NULL OR ("source" = 'MANUAL' AND "reverseNextMonth"))
);

-- One waiting request per accrual proposal.
CREATE UNIQUE INDEX "JournalApproval_pending_accrual_key" ON "JournalApproval"("accrualKey") WHERE "status" = 'PENDING' AND "accrualKey" IS NOT NULL;
