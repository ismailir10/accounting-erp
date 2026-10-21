import type { Db, Tx } from "@/lib/db";
import { ACCOUNT_CODES } from "@/lib/coa/template";

/**
 * Antar entitas per pihak (cycle 2026-10-21-antar-entitas-per-pihak). A client of three or more companies keeps an intercompany account
 * per company (`1190NN` *Piutang/Utang Antar Entitas — <nama singkat>*, `counterpartyEntityId`): company A records what it lends to or owes
 * B on B's account, so a receivable from one party never nets a payable to another. Two companies keep the one 1190: the other side is
 * implied. A company never posts to its own account (postJournal()).
 */

export const MIN_COMPANIES = 3;
export const intercompanyName = (shortName: string) => `Piutang/Utang Antar Entitas — ${shortName}`;

/** Where a company's removal (lib/clients/entities.ts) records its intercompany code in the Riwayat event's `before`. */
export const INTERCOMPANY_CODE_KEY = "intercompanyAccount";

/**
 * Creates the missing per-company accounts of a client of three or more companies (codes 119001–119098). A code is never issued twice:
 * each new one is above the highest the client ever had — its accounts now, and the codes of removed companies kept in their removal's
 * Riwayat event — so something still naming a removed company's code (a printed journal, an export, a stale request) can never come to
 * mean another company.
 */
export async function ensureIntercompanyAccounts(tx: Tx, clientId: string) {
  const entities = await tx.entity.findMany({ where: { clientId }, select: { id: true, firmId: true, shortName: true }, orderBy: { id: "asc" } });
  if (entities.length < MIN_COMPANIES) return;
  const accounts = await tx.account.findMany({ where: { clientId }, select: { code: true, counterpartyEntityId: true } });
  const have = new Set(accounts.map((a) => a.counterpartyEntityId).filter(Boolean));
  const removed = await tx.$queryRaw<{ code: string }[]>`
    SELECT DISTINCT before->>${INTERCOMPANY_CODE_KEY} AS code FROM "AuditEvent"
    WHERE "clientId" = ${clientId} AND kind = 'COMPANY_BANK' AND before->>${INTERCOMPANY_CODE_KEY} IS NOT NULL`;
  const perCompany = /^1190(\d{2})$/;
  const ever = [...accounts.map((a) => a.code), ...removed.map((r) => r.code)].map((c) => perCompany.exec(c)).filter((m) => m !== null).map((m) => Number(m[1]));
  let n = Math.max(0, ...ever);
  for (const e of entities) {
    if (have.has(e.id)) continue;
    n++;
    if (n >= 99) return; // 98 codes: past any group Buku serves; transfers then stay on 1190
    const code = `${ACCOUNT_CODES.INTERCOMPANY}${String(n).padStart(2, "0")}`;
    await tx.account.create({
      data: { firmId: e.firmId, clientId, code, name: intercompanyName(e.shortName), type: "ASET", normalBalance: "DEBIT", fsLine: "PIUTANG_LAIN", isIntercompany: true, counterpartyEntityId: e.id },
    });
  }
}

/** The intercompany account code to record a balance with `counterpartyEntityId` on: its own account, else 1190. */
export async function intercompanyCodes(db: Db | Tx, clientId: string): Promise<Map<string, string>> {
  const rows = await db.account.findMany({ where: { clientId, counterpartyEntityId: { not: null } }, select: { code: true, counterpartyEntityId: true } });
  return new Map(rows.map((r) => [r.counterpartyEntityId!, r.code]));
}
