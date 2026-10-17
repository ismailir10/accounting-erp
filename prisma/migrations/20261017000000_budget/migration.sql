-- Anggaran (budget vs actual): one planned amount per company, income/expense account and month. Additive: a new table only.
-- Planning data, never posted; no ledger table changes.
-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "amount" BIGINT NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Budget_clientId_year_month_idx" ON "Budget"("clientId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_entityId_accountId_year_month_key" ON "Budget"("entityId", "accountId", "year", "month");

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "FirmMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A month is 1-12.
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_month_check" CHECK ("month" BETWEEN 1 AND 12);
