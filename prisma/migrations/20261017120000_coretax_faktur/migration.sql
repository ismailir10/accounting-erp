-- Faktur keluaran for Coretax (docs/cycles/2026-10-17-coretax-files.md). Additive and nullable, no backfill.
-- Buyer identity on the contact (NIK, NITKU, address, email: personal data, never sent to AI), the seller's NITKU on the entity, and the
-- one faktur item of a sales invoice (Barang/Jasa, Kode, Satuan, name). Validated in lib/receivables/faktur-identity.ts.
ALTER TABLE "Contact" ADD COLUMN "nik" TEXT,
ADD COLUMN "nitku" TEXT,
ADD COLUMN "address" TEXT,
ADD COLUMN "email" TEXT;

ALTER TABLE "Entity" ADD COLUMN "nitku" TEXT;

ALTER TABLE "Invoice" ADD COLUMN "fakturItemKind" TEXT,
ADD COLUMN "fakturItemCode" TEXT,
ADD COLUMN "fakturUnit" TEXT,
ADD COLUMN "fakturItemName" TEXT;
