-- Otomasi kantor (cycle 2026-10-17-otomasi): the firm's automation dial and flux thresholds. Additive; every default equals the behaviour
-- before these columns existed (all three sources post, no cap, no Rupiah floor, 50 %), so no backfill.
ALTER TABLE "Firm" ADD COLUMN "autoPostTransfer" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Firm" ADD COLUMN "autoPostRules" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Firm" ADD COLUMN "autoPostMemory" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Firm" ADD COLUMN "autoPostCap" BIGINT;
ALTER TABLE "Firm" ADD COLUMN "fluxFloor" BIGINT;
ALTER TABLE "Firm" ADD COLUMN "fluxPercent" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "Firm" ADD CONSTRAINT "Firm_autoPostCap_check" CHECK ("autoPostCap" IS NULL OR "autoPostCap" > 0);
ALTER TABLE "Firm" ADD CONSTRAINT "Firm_fluxFloor_check" CHECK ("fluxFloor" IS NULL OR "fluxFloor" > 0);
ALTER TABLE "Firm" ADD CONSTRAINT "Firm_fluxPercent_check" CHECK ("fluxPercent" BETWEEN 1 AND 1000);
