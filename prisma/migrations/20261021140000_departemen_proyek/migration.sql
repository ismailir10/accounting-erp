-- Departemen & Proyek (cycle 2026-10-21-departemen-proyek). Additive: one table, an enum, and two nullable columns on JournalLine and
-- BankTransaction (labels for analysis; they never change a balance).

-- CreateEnum
CREATE TYPE "DimensionKind" AS ENUM ('DEPARTEMEN', 'PROYEK');

-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "projectId" TEXT;

-- AlterTable
ALTER TABLE "JournalLine" ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "projectId" TEXT;

-- CreateTable
CREATE TABLE "Dimension" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" "DimensionKind" NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Dimension_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Dimension_clientId_idx" ON "Dimension"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Dimension_clientId_kind_code_key" ON "Dimension"("clientId", "kind", "code");

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Dimension"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Dimension"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dimension" ADD CONSTRAINT "Dimension_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Dimension"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Dimension"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

