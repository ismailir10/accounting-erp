-- Jurnal berulang (cycle 2026-10-21-jurnal-berulang). Additive: one table, two columns on JournalEntry and JournalApproval.

-- AlterTable
ALTER TABLE "JournalApproval" ADD COLUMN     "recurringId" TEXT,
ADD COLUMN     "recurringMonth" INTEGER;

-- AlterTable
ALTER TABLE "JournalEntry" ADD COLUMN     "recurringId" TEXT,
ADD COLUMN     "recurringMonth" INTEGER;

-- CreateTable
CREATE TABLE "RecurringJournal" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "memo" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "day" INTEGER NOT NULL,
    "reverseNextMonth" BOOLEAN NOT NULL DEFAULT false,
    "startYear" INTEGER NOT NULL,
    "startMonth" INTEGER NOT NULL,
    "endYear" INTEGER,
    "endMonth" INTEGER,
    "stoppedAt" TIMESTAMP(3),
    "sourceEntryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringJournal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringJournal_clientId_idx" ON "RecurringJournal"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_recurringId_recurringMonth_key" ON "JournalEntry"("recurringId", "recurringMonth");

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_recurringId_fkey" FOREIGN KEY ("recurringId") REFERENCES "RecurringJournal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringJournal" ADD CONSTRAINT "RecurringJournal_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringJournal" ADD CONSTRAINT "RecurringJournal_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringJournal" ADD CONSTRAINT "RecurringJournal_sourceEntryId_fkey" FOREIGN KEY ("sourceEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringJournal" ADD CONSTRAINT "RecurringJournal_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "FirmMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalApproval" ADD CONSTRAINT "JournalApproval_recurringId_fkey" FOREIGN KEY ("recurringId") REFERENCES "RecurringJournal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

