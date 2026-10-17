-- Credit limits on Piutang (cycle 2026-10-17-pengingat-piutang): a customer's limit in whole Rupiah, optional, metadata only.
ALTER TABLE "Contact" ADD COLUMN "creditLimit" BIGINT;
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_creditLimit_check" CHECK ("creditLimit" IS NULL OR "creditLimit" > 0);
