-- Nomor bukti (cycle 2026-10-20-paritas-inti): every journal carries a voucher number PREFIX-YYMM-NNNN from its company's series per
-- prefix and month, assigned by postJournal() (lib/ledger/number.ts) and never changed afterwards.

-- AlterTable
ALTER TABLE "JournalEntry" ADD COLUMN     "number" TEXT;

-- CreateTable
CREATE TABLE "JournalSequence" (
    "entityId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "last" INTEGER NOT NULL,

    CONSTRAINT "JournalSequence_pkey" PRIMARY KEY ("entityId","prefix","year","month")
);

-- Existing journals, numbered in date order (then creation order) per series, with the same prefixes postJournal() gives:
-- SA Saldo Awal, BM/BK bank in/out by the bank line's side, RK reklasifikasi, JP penyesuaian, JI impor, FJ/FB invoice by its direction.
WITH prefixed AS (
  SELECT e.id, e."entityId", e.date, e."createdAt",
    CASE e.kind
      WHEN 'OPENING' THEN 'SA'
      WHEN 'BANK' THEN CASE WHEN EXISTS (
        SELECT 1 FROM "JournalLine" l JOIN "Account" a ON a.id = l."accountId" WHERE l."entryId" = e.id AND a."isBank" AND l.credit > 0
      ) THEN 'BK' ELSE 'BM' END
      WHEN 'RECLASS' THEN 'RK'
      WHEN 'ADJUSTMENT' THEN 'JP'
      WHEN 'IMPORTED' THEN 'JI'
      WHEN 'INVOICE' THEN CASE WHEN EXISTS (
        SELECT 1 FROM "JournalLine" l JOIN "Account" a ON a.id = l."accountId" WHERE l."entryId" = e.id AND a."fsLine" = 'PIUTANG_USAHA'
      ) THEN 'FJ' ELSE 'FB' END
    END AS prefix
  FROM "JournalEntry" e
), numbered AS (
  SELECT id, "entityId", prefix, EXTRACT(YEAR FROM date)::int AS year, EXTRACT(MONTH FROM date)::int AS month,
    ROW_NUMBER() OVER (PARTITION BY "entityId", prefix, date_trunc('month', date) ORDER BY date, "createdAt", id) AS n
  FROM prefixed
)
UPDATE "JournalEntry" e
SET number = n.prefix || '-' || lpad((n.year % 100)::text, 2, '0') || lpad(n.month::text, 2, '0') || '-' || lpad(n.n::text, 4, '0')
FROM numbered n WHERE n.id = e.id;

INSERT INTO "JournalSequence" ("entityId", "prefix", "year", "month", "last")
SELECT "entityId", split_part(number, '-', 1), EXTRACT(YEAR FROM date)::int, EXTRACT(MONTH FROM date)::int, COUNT(*)
FROM "JournalEntry" WHERE number IS NOT NULL
GROUP BY "entityId", split_part(number, '-', 1), EXTRACT(YEAR FROM date)::int, EXTRACT(MONTH FROM date)::int;

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_entityId_number_key" ON "JournalEntry"("entityId", "number");

-- AddForeignKey
ALTER TABLE "JournalSequence" ADD CONSTRAINT "JournalSequence_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The entry guard (20261006090000_ledger_guards) also keeps a given number: set once, never changed or cleared.
CREATE OR REPLACE FUNCTION "ledger_entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record; client text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO p FROM "Period" WHERE id = NEW."periodId";
    SELECT "clientId" INTO client FROM "Entity" WHERE id = NEW."entityId";
    IF p.id IS NULL OR p."clientId" <> client OR p.year <> EXTRACT(YEAR FROM NEW.date)::int OR p.month <> EXTRACT(MONTH FROM NEW.date)::int THEN
      RAISE EXCEPTION 'Buku besar: jurnal tanggal % harus masuk periode bulannya sendiri', NEW.date USING ERRCODE = 'check_violation';
    END IF;
    IF p.status = 'LOCKED' THEN
      RAISE EXCEPTION 'Buku besar: periode %-% sudah ditutup (aturan 4)', p.year, lpad(p.month::text, 2, '0') USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW."entityId" <> OLD."entityId" OR NEW."periodId" <> OLD."periodId" OR NEW.date <> OLD.date OR NEW.kind <> OLD.kind
       OR (OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number) THEN
      RAISE EXCEPTION 'Buku besar: jurnal % sudah diposting dan tidak bisa diubah; koreksi dengan jurnal baru (aturan 3)', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  ELSE
    IF NOT "ledger_client_delete"() AND EXISTS (SELECT 1 FROM "Period" WHERE id = OLD."periodId" AND status = 'LOCKED') THEN
      RAISE EXCEPTION 'Buku besar: jurnal % ada di periode yang sudah ditutup (aturan 4)', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
END $$;
