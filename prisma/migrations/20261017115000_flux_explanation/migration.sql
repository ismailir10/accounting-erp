-- Wawasan keuangan: the accountant-approved explanation of a P&L account's movement per company, month and account.
-- CreateTable
CREATE TABLE "FluxExplanation" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "accountCode" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "series" JSONB NOT NULL,
    "refs" JSONB NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FluxExplanation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FluxExplanation_clientId_idx" ON "FluxExplanation"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "FluxExplanation_entityId_year_month_accountCode_key" ON "FluxExplanation"("entityId", "year", "month", "accountCode");
