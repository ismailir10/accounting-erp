-- Data only (no schema change). Lines still waiting in Review whose AI suggestion was a trade receivable / payable the entity's books did not
-- hold were kept on that account at 55% with "Belum ada … tercatat" appended (lib/ai/unbacked.ts, before this change). The same rule now
-- replaces the account with the simple guess's (4100 / 6190, a person's 4910 / 3300, lib/classify/fallback.ts). Apply it to those lines.
-- Only NEEDS_REVIEW rows with the old reason text, only where the client's chart has the fallback account (a bank or suspense account never
-- qualifies) and only while the entity's books still hold nothing to settle by the line's own date (lib/ai/unbacked.ts `tradeBacking`): an invoice
-- or journal entered since the import, dated on or before the line, backs the AI's 1130 / 2110 again, so that line is left as it is.
-- Accepted lines and their journals are not touched; the statement is unchanged. Idempotent: the new reason no longer matches.
UPDATE "BankTransaction" t
SET "suggestedCode" = g."code",
    "taxTag" = NULL,
    "reason" = 'AI mengusulkan ' || a."code" || ' ' || a."name" || ', tetapi tidak ada '
      || CASE WHEN t."direction" = 'IN' THEN 'piutang usaha tercatat untuk entitas ini: dianggap penjualan tunai ('
              ELSE 'utang usaha tercatat untuk entitas ini: dianggap beban atau pembelian langsung (' END
      || g."code" || ' ' || g."name" || ').'
FROM "Entity" e, "Account" a, "Account" g
WHERE e."id" = t."entityId"
  AND a."clientId" = e."clientId" AND a."code" = t."suggestedCode"
  AND g."clientId" = e."clientId"
  AND g."isBank" = false AND g."isSuspense" = false
  AND g."code" = CASE
        WHEN e."kind" = 'PERORANGAN' AND t."direction" = 'IN' THEN '4910'
        WHEN e."kind" = 'PERORANGAN' THEN '3300'
        WHEN t."direction" = 'IN' THEN '4100'
        ELSE '6190' END
  AND t."status" = 'NEEDS_REVIEW'
  AND t."method" = 'AI'
  AND ((t."direction" = 'IN' AND a."fsLine" = 'PIUTANG_USAHA' AND t."reason" LIKE '%Belum ada piutang usaha tercatat untuk entitas ini%'
        AND COALESCE((SELECT SUM(l."debit" - l."credit") FROM "JournalLine" l JOIN "Account" ta ON ta."id" = l."accountId"
                      WHERE l."entityId" = t."entityId" AND ta."fsLine" = 'PIUTANG_USAHA' AND l."date" <= t."date"), 0) <= 0)
    OR (t."direction" = 'OUT' AND a."fsLine" = 'UTANG_USAHA' AND t."reason" LIKE '%Belum ada utang usaha tercatat untuk entitas ini%'
        AND COALESCE((SELECT SUM(l."credit" - l."debit") FROM "JournalLine" l JOIN "Account" ta ON ta."id" = l."accountId"
                      WHERE l."entityId" = t."entityId" AND ta."fsLine" = 'UTANG_USAHA' AND l."date" <= t."date"), 0) <= 0));
