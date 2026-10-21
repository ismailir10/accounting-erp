-- Antar entitas per pihak (cycle 2026-10-21-antar-entitas-per-pihak). Additive: one column, and for every client of three or more
-- companies an intercompany account per company (1190NN, in the order of their ids). A code a client already uses is
-- skipped; the app creates that company's account on the next free code when it is needed.

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "counterpartyEntityId" TEXT;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_counterpartyEntityId_fkey" FOREIGN KEY ("counterpartyEntityId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill
INSERT INTO "Account" ("id", "firmId", "clientId", "code", "name", "type", "normalBalance", "fsLine", "isIntercompany", "counterpartyEntityId")
SELECT gen_random_uuid()::text, e."firmId", e."clientId",
       '1190' || lpad((row_number() OVER (PARTITION BY e."clientId" ORDER BY e."id"))::text, 2, '0'),
       'Piutang/Utang Antar Entitas — ' || e."shortName", 'ASET'::"AccountType", 'DEBIT'::"NormalBalance", 'PIUTANG_LAIN', true, e."id"
FROM "Entity" e
WHERE (SELECT count(*) FROM "Entity" x WHERE x."clientId" = e."clientId") >= 3
ON CONFLICT ("clientId", "code") DO NOTHING;
