-- CreateEnum
CREATE TYPE "AiRunStatus" AS ENUM ('RUNNING', 'DONE');

-- CreateTable
CREATE TABLE "AiRun" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" "AiRunStatus" NOT NULL DEFAULT 'RUNNING',
    "totalLines" INTEGER NOT NULL DEFAULT 0,
    "askedLines" INTEGER NOT NULL DEFAULT 0,
    "suggestedLines" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "skippedKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AiRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiRun_clientId_createdAt_idx" ON "AiRun"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "AiRun_firmId_idx" ON "AiRun"("firmId");

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one RUNNING run per client (lib/ai/run.ts startAiRun relies on it for concurrent imports). Prisma can't express a
-- partial unique index, so it lives here only.
CREATE UNIQUE INDEX "AiRun_one_running_per_client" ON "AiRun"("clientId") WHERE "status" = 'RUNNING';
