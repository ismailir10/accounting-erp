-- Bukti potong Unifikasi for Coretax (docs/cycles/2026-10-17-bppu-files.md). Additive: one new table, no change to an existing column,
-- no backfill. The slip detail of an outgoing bank line the company withheld PPh 23 / 4(2) / 22 from: Kode Objek Pajak, rate (hundredths
-- of a percent), DPP (whole Rupiah), reference document, and the recipient when the line has no contact. Metadata only: never posted,
-- never changes the line's withholding (accounting-rules 5h). Validated in lib/tax/withholding-slip.ts.
-- CreateTable
CREATE TABLE "WithholdingSlip" (
    "id" TEXT NOT NULL,
    "firmId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "bankTransactionId" TEXT NOT NULL,
    "contactId" TEXT,
    "kop" TEXT,
    "rate" INTEGER,
    "dpp" BIGINT,
    "documentType" TEXT,
    "documentNumber" TEXT,
    "documentDate" DATE,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WithholdingSlip_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WithholdingSlip_dpp_positive" CHECK ("dpp" IS NULL OR "dpp" > 0),
    CONSTRAINT "WithholdingSlip_rate_range" CHECK ("rate" IS NULL OR ("rate" > 0 AND "rate" <= 10000)),
    CONSTRAINT "WithholdingSlip_kop_rate_paired" CHECK (("kop" IS NULL) = ("rate" IS NULL))
);

-- CreateIndex
CREATE UNIQUE INDEX "WithholdingSlip_bankTransactionId_key" ON "WithholdingSlip"("bankTransactionId");

-- CreateIndex
CREATE INDEX "WithholdingSlip_clientId_idx" ON "WithholdingSlip"("clientId");

-- CreateIndex
CREATE INDEX "WithholdingSlip_contactId_idx" ON "WithholdingSlip"("contactId");

-- AddForeignKey: the slip goes with its bank line (an import removed).
ALTER TABLE "WithholdingSlip" ADD CONSTRAINT "WithholdingSlip_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithholdingSlip" ADD CONSTRAINT "WithholdingSlip_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
