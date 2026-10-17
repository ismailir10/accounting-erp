-- Persetujuan kedua (docs/cycles/2026-10-18-persetujuan-kedua.md). Additive: five Firm columns whose defaults equal the behaviour before
-- them (nothing is routed), two enums, two new tables and one nullable column on PeriodUnlockLog; no backfill. A JournalApproval is a
-- request, never a ledger entry: the entry exists only once another member approves it, posted by postJournal() in the same transaction
-- as the status change (accounting-rules 2a). A ReopenRequest keeps its month locked until another admin confirms it.

-- CreateEnum
CREATE TYPE "JournalApprovalSource" AS ENUM ('MANUAL', 'REVERSAL', 'AI_DRAFT');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "Firm" ADD COLUMN     "approvalAiDraft" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "approvalAiDraftAbove" BIGINT,
ADD COLUMN     "approvalManual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "approvalManualAbove" BIGINT,
ADD COLUMN     "approvalReopen" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PeriodUnlockLog" ADD COLUMN     "requestedById" TEXT;

-- CreateTable
CREATE TABLE "JournalApproval" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "source" "JournalApprovalSource" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "date" DATE NOT NULL,
    "memo" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "reverseNextMonth" BOOLEAN NOT NULL DEFAULT false,
    "reversesId" TEXT,
    "proposalId" TEXT,
    "accounts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "amount" BIGINT NOT NULL,
    "threshold" BIGINT,
    "makerId" TEXT NOT NULL,
    "makerRole" "MemberRole" NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "entryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReopenRequest" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReopenRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JournalApproval_entryId_key" ON "JournalApproval"("entryId");

-- CreateIndex
CREATE INDEX "JournalApproval_clientId_status_idx" ON "JournalApproval"("clientId", "status");

-- CreateIndex
CREATE INDEX "JournalApproval_proposalId_idx" ON "JournalApproval"("proposalId");

-- CreateIndex
CREATE INDEX "JournalApproval_reversesId_idx" ON "JournalApproval"("reversesId");

-- CreateIndex
CREATE INDEX "ReopenRequest_clientId_status_idx" ON "ReopenRequest"("clientId", "status");

-- AddForeignKey
ALTER TABLE "PeriodUnlockLog" ADD CONSTRAINT "PeriodUnlockLog_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "FirmMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalApproval" ADD CONSTRAINT "JournalApproval_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalApproval" ADD CONSTRAINT "JournalApproval_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalApproval" ADD CONSTRAINT "JournalApproval_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalApproval" ADD CONSTRAINT "JournalApproval_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "ProposedEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalApproval" ADD CONSTRAINT "JournalApproval_makerId_fkey" FOREIGN KEY ("makerId") REFERENCES "FirmMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalApproval" ADD CONSTRAINT "JournalApproval_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "FirmMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalApproval" ADD CONSTRAINT "JournalApproval_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReopenRequest" ADD CONSTRAINT "ReopenRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReopenRequest" ADD CONSTRAINT "ReopenRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "FirmMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReopenRequest" ADD CONSTRAINT "ReopenRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "FirmMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The firm's thresholds are whole Rupiah above zero (empty = every journal of that source), as Otomasi's cap.
ALTER TABLE "Firm" ADD CONSTRAINT "Firm_approvalManualAbove_check" CHECK ("approvalManualAbove" IS NULL OR "approvalManualAbove" > 0);
ALTER TABLE "Firm" ADD CONSTRAINT "Firm_approvalAiDraftAbove_check" CHECK ("approvalAiDraftAbove" IS NULL OR "approvalAiDraftAbove" > 0);

-- A journal request's invariants: a positive amount and threshold; an entry exactly when approved; a decision has a time; a rejection
-- has its reason; each source carries its own fields only (MANUAL may reverse next month; REVERSAL names the entry; AI_DRAFT the draft).
ALTER TABLE "JournalApproval" ADD CONSTRAINT "JournalApproval_amount_check" CHECK ("amount" > 0 AND ("threshold" IS NULL OR "threshold" > 0));
ALTER TABLE "JournalApproval" ADD CONSTRAINT "JournalApproval_entry_check" CHECK (("entryId" IS NOT NULL) = ("status" = 'APPROVED'));
ALTER TABLE "JournalApproval" ADD CONSTRAINT "JournalApproval_decided_check" CHECK (("status" = 'PENDING') = ("decidedAt" IS NULL));
ALTER TABLE "JournalApproval" ADD CONSTRAINT "JournalApproval_note_check" CHECK ("status" <> 'REJECTED' OR length(btrim(coalesce("note", ''))) >= 5);
ALTER TABLE "JournalApproval" ADD CONSTRAINT "JournalApproval_source_check" CHECK (
  ("source" = 'REVERSAL') = ("reversesId" IS NOT NULL)
  AND ("source" = 'AI_DRAFT') = ("proposalId" IS NOT NULL)
  AND ("source" = 'MANUAL' OR NOT "reverseNextMonth")
);
-- One waiting request per draft and per entry to reverse.
CREATE UNIQUE INDEX "JournalApproval_pending_proposal_key" ON "JournalApproval"("proposalId") WHERE "status" = 'PENDING' AND "proposalId" IS NOT NULL;
CREATE UNIQUE INDEX "JournalApproval_pending_reverses_key" ON "JournalApproval"("reversesId") WHERE "status" = 'PENDING' AND "reversesId" IS NOT NULL;

-- A reopen request: a real month, a reason as the unlock needs (≥ 5 characters), a decision with its time, a rejection with its reason;
-- one waiting request per client-month.
ALTER TABLE "ReopenRequest" ADD CONSTRAINT "ReopenRequest_month_check" CHECK ("month" BETWEEN 1 AND 12);
ALTER TABLE "ReopenRequest" ADD CONSTRAINT "ReopenRequest_reason_check" CHECK (length(btrim("reason")) >= 5);
ALTER TABLE "ReopenRequest" ADD CONSTRAINT "ReopenRequest_decided_check" CHECK (("status" = 'PENDING') = ("decidedAt" IS NULL));
ALTER TABLE "ReopenRequest" ADD CONSTRAINT "ReopenRequest_note_check" CHECK ("status" <> 'REJECTED' OR length(btrim(coalesce("note", ''))) >= 5);
CREATE UNIQUE INDEX "ReopenRequest_pending_month_key" ON "ReopenRequest"("clientId", "year", "month") WHERE "status" = 'PENDING';
