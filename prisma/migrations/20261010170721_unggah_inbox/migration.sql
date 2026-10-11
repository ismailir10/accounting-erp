-- CreateEnum
CREATE TYPE "UploadKind" AS ENUM ('BANK', 'LEDGER', 'OTHER');

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('CHECKED', 'PROCESSING', 'NEEDS_PASSWORD', 'NEEDS_ACCOUNT', 'BOOKED', 'DRAFT', 'KEPT', 'FAILED');

-- AlterTable
ALTER TABLE "EvidenceIntake" ADD COLUMN     "isInbox" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "UploadItem" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "evidenceVersionId" TEXT,
    "kind" "UploadKind" NOT NULL,
    "status" "UploadStatus" NOT NULL,
    "message" TEXT,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "sections" JSONB NOT NULL DEFAULT '[]',
    "statementImportIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ledgerImportId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientPdfPassword" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "ClientPdfPassword_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UploadItem_clientId_batchId_idx" ON "UploadItem"("clientId", "batchId");

-- CreateIndex
CREATE INDEX "UploadItem_clientId_createdAt_idx" ON "UploadItem"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "ClientPdfPassword_clientId_idx" ON "ClientPdfPassword"("clientId");

-- AddForeignKey
ALTER TABLE "UploadItem" ADD CONSTRAINT "UploadItem_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadItem" ADD CONSTRAINT "UploadItem_evidenceVersionId_fkey" FOREIGN KEY ("evidenceVersionId") REFERENCES "EvidenceVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPdfPassword" ADD CONSTRAINT "ClientPdfPassword_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one Unggah inbox per client (lib/inbox/store.ts inboxIntake relies on it for concurrent drops). Prisma can't express a
-- partial unique index, so it lives here only.
CREATE UNIQUE INDEX "EvidenceIntake_one_inbox_per_client" ON "EvidenceIntake"("clientId") WHERE "isInbox";
