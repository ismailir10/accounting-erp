-- Data only (no schema change). Lines still waiting in Review whose AI suggestion was a trade receivable / payable the entity's books did not
-- hold were kept on that account at 55% with "Belum ada … tercatat" appended (lib/ai/unbacked.ts, before this change). The same rule now
-- replaces the account with the simple guess's (4100 / 6190, a person's 4910 / 3300, lib/classify/fallback.ts). Apply it to those lines.
-- Only NEEDS_REVIEW rows with the old reason text, only where the client's chart has the fallback account (a bank or suspense account never
-- qualifies). Accepted lines and their journals are not touched; the statement is unchanged. Idempotent: the new reason no longer matches.
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
  AND ((t."direction" = 'IN' AND a."fsLine" = 'PIUTANG_USAHA' AND t."reason" LIKE '%Belum ada piutang usaha tercatat untuk entitas ini%')
    OR (t."direction" = 'OUT' AND a."fsLine" = 'UTANG_USAHA' AND t."reason" LIKE '%Belum ada utang usaha tercatat untuk entitas ini%'));
