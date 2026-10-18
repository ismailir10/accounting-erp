-- Instruksi kantor (docs/cycles/2026-10-18-instruksi-kantor.md). Additive: three enums, one table and one nullable column on "Rule"; no
-- existing row changes and no backfill. An instruction stores the sentence for display and history, and what it compiled to as typed
-- columns (the only thing run time reads). An ACCOUNT instruction's Rule points back at it (unique, Restrict: *Matikan* deletes the rule).

-- CreateEnum
CREATE TYPE "InstructionKind" AS ENUM ('ACCOUNT', 'FLAG', 'HOLD');

-- CreateEnum
CREATE TYPE "InstructionStatus" AS ENUM ('ACTIVE', 'OFF');

-- CreateEnum
CREATE TYPE "InstructionOrigin" AS ENUM ('PARSER', 'AI', 'EDITED');

-- AlterTable
ALTER TABLE "Rule" ADD COLUMN     "instructionId" TEXT;

-- CreateTable
CREATE TABLE "Instruction" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "clientId" TEXT,
    "sentence" TEXT NOT NULL,
    "kind" "InstructionKind" NOT NULL,
    "status" "InstructionStatus" NOT NULL DEFAULT 'ACTIVE',
    "origin" "InstructionOrigin" NOT NULL,
    "pattern" TEXT,
    "direction" "Direction",
    "accountCode" TEXT,
    "taxTag" "TaxTag",
    "minAmount" BIGINT,
    "inclusive" BOOLEAN NOT NULL DEFAULT false,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "offById" TEXT,
    "offAt" TIMESTAMP(3),

    CONSTRAINT "Instruction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Instruction_firmId_status_idx" ON "Instruction"("firmId", "status");

-- CreateIndex
CREATE INDEX "Instruction_clientId_idx" ON "Instruction"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Rule_instructionId_key" ON "Rule"("instructionId");

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_instructionId_fkey" FOREIGN KEY ("instructionId") REFERENCES "Instruction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Instruction" ADD CONSTRAINT "Instruction_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "Firm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Instruction" ADD CONSTRAINT "Instruction_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Instruction" ADD CONSTRAINT "Instruction_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "FirmMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Instruction" ADD CONSTRAINT "Instruction_offById_fkey" FOREIGN KEY ("offById") REFERENCES "FirmMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The compiled form's invariants per kind: ACCOUNT has a keyword and an account and no amount; FLAG has an amount and neither account nor
-- tax tag; HOLD has a keyword and neither account nor tax tag. A keyword is upper case, 3–60 characters; an amount is above zero; the
-- sentence is 1–300 characters and not blank; OFF exactly when the turned-off time is set.
ALTER TABLE "Instruction" ADD CONSTRAINT "Instruction_kind_check" CHECK (
  ("kind" <> 'ACCOUNT' OR ("pattern" IS NOT NULL AND "accountCode" IS NOT NULL AND "minAmount" IS NULL))
  AND ("kind" <> 'FLAG' OR ("minAmount" IS NOT NULL AND "accountCode" IS NULL AND "taxTag" IS NULL))
  AND ("kind" <> 'HOLD' OR ("pattern" IS NOT NULL AND "accountCode" IS NULL AND "taxTag" IS NULL))
);
ALTER TABLE "Instruction" ADD CONSTRAINT "Instruction_pattern_check" CHECK ("pattern" IS NULL OR (char_length("pattern") BETWEEN 3 AND 60 AND "pattern" = upper("pattern")));
ALTER TABLE "Instruction" ADD CONSTRAINT "Instruction_minAmount_check" CHECK ("minAmount" IS NULL OR "minAmount" > 0);
ALTER TABLE "Instruction" ADD CONSTRAINT "Instruction_sentence_check" CHECK (char_length("sentence") BETWEEN 1 AND 300 AND length(btrim("sentence")) > 0);
ALTER TABLE "Instruction" ADD CONSTRAINT "Instruction_status_check" CHECK (("status" = 'OFF') = ("offAt" IS NOT NULL));
