import type { Db } from "@/lib/db";
import { fiscalEndMonth, fiscalYearStart } from "@/lib/fiscal";
import type { AccountType, EntryKind, NormalBalance } from "@/lib/generated/prisma/enums";
import { isMixed, scopeEntities } from "@/lib/reports/fx";
import type { Scope } from "@/lib/reports/ledger";
import { ENTRY_SOURCE_SELECT, entrySource } from "@/lib/reports/entry-source";
import { entryOrigins } from "@/lib/reports/entry-origin";

/** A month, or the client's financial year to date through that month (Jurnal Umum, Buku Besar and Neraca Saldo exports). */
export type LedgerRange = "month" | "ytd";

export const parseRange = (v: unknown): LedgerRange => (v === "ytd" ? "ytd" : "month");

/** The dates a range covers for the month ending `end`: the month itself, or from the first day of its financial year. */
export async function rangeBounds(db: Db, clientId: string, range: LedgerRange, month: { start: Date; end: Date }) {
  return range === "ytd" ? { start: fiscalYearStart(await fiscalEndMonth(db, clientId), month.end), end: month.end } : month;
}

export type GlLine = { date: Date; entity: string; kind: EntryKind; memo: string; source: string | null; debit: bigint; credit: bigint; balance: bigint };
export type GlAccount = {
  account: { id: string; code: string; name: string; type: AccountType; normalBalance: NormalBalance };
  opening: bigint;
  /** Earlier financial years' profit folded into the opening (Saldo Laba only), as the trial balance does. */
  priorYearProfit: bigint;
  lines: GlLine[];
  debit: bigint;
  credit: bigint;
  closing: bigint;
};

/**
 * The general ledger of a scope from `start` to `end`: every account with an opening balance or a movement (or one account), its lines
 * in date order with their source, the running balance and the closing. Balances read on the account's normal side (positive = normal).
 * Openings follow the trial balance (accounting-rules 1): balance-sheet accounts from the start, income and expense from the start of the
 * financial year holding `start`, and earlier years' income and expense folded into Saldo Laba — so every closing equals the account's
 * Neraca Saldo balance at `end` when `start` and `end` sit in one financial year. Single-currency scopes only.
 */
export async function generalLedger(db: Db, scope: Scope, start: Date, end: Date, opts: { accountCode?: string } = {}): Promise<GlAccount[]> {
  if (isMixed(await scopeEntities(db, scope.entityIds))) throw new Error("Buku besar hanya untuk satu mata uang. Pilih satu perusahaan.");
  const accounts = await db.account.findMany({
    where: { clientId: scope.clientId, ...(opts.accountCode ? { code: opts.accountCode } : {}) },
    select: { id: true, code: true, name: true, type: true, normalBalance: true, isRetained: true },
    orderBy: { code: "asc" },
  });
  if (!accounts.length) return [];
  const yearStart = fiscalYearStart(await fiscalEndMonth(db, scope.clientId), start);
  const entityIds = { in: scope.entityIds };
  const PL: AccountType[] = ["PENDAPATAN", "BEBAN"];
  const accountIds = opts.accountCode ? { accountId: { in: accounts.map((a) => a.id) } } : {};
  const [before, priorPl, lines] = await Promise.all([
    db.journalLine.groupBy({
      by: ["accountId"],
      where: { ...accountIds, entityId: entityIds, date: { lt: start }, OR: [{ account: { type: { notIn: PL } } }, { account: { type: { in: PL } }, date: { gte: yearStart } }] },
      _sum: { debit: true, credit: true },
    }),
    // Earlier years' result (debit − credit of income and expense before the financial year), folded into Saldo Laba.
    db.journalLine.aggregate({ where: { entityId: entityIds, date: { lt: yearStart }, account: { clientId: scope.clientId, type: { in: PL } } }, _sum: { debit: true, credit: true } }),
    db.journalLine.findMany({
      where: { ...accountIds, entityId: entityIds, date: { gte: start, lte: end } },
      select: {
        accountId: true,
        date: true,
        debit: true,
        credit: true,
        sourceRef: true,
        entryId: true,
        entry: { select: { memo: true, entity: { select: { shortName: true } }, ...ENTRY_SOURCE_SELECT } },
      },
      orderBy: [{ date: "asc" }, { entry: { createdAt: "asc" } }, { id: "asc" }],
    }),
  ]);
  // The proposal behind an entry joins its source (the Excel's one source column).
  const origins = await entryOrigins(db, lines.map((l) => l.entryId));
  const openNet = new Map(before.map((r) => [r.accountId, (r._sum.debit ?? 0n) - (r._sum.credit ?? 0n)]));
  const priorNet = (priorPl._sum.debit ?? 0n) - (priorPl._sum.credit ?? 0n);
  const byAccount = new Map<string, typeof lines>();
  for (const l of lines) byAccount.set(l.accountId, [...(byAccount.get(l.accountId) ?? []), l]);

  const out: GlAccount[] = [];
  for (const a of accounts) {
    const sign = a.normalBalance === "DEBIT" ? 1n : -1n;
    const fold = a.isRetained ? priorNet : 0n;
    const opening = ((openNet.get(a.id) ?? 0n) + fold) * sign;
    const own = byAccount.get(a.id) ?? [];
    if (opening === 0n && own.length === 0) continue;
    let balance = opening;
    let debit = 0n;
    let credit = 0n;
    const glLines = own.map((l) => {
      balance += (l.debit - l.credit) * sign;
      debit += l.debit;
      credit += l.credit;
      // An imported line names its own file row; the entry's rows otherwise.
      const source = [l.sourceRef && l.entry.ledgerImport ? `${l.entry.ledgerImport.fileName} · ${l.sourceRef}` : entrySource(l.entry), origins.get(l.entryId)].filter(Boolean).join(" · ") || null;
      return { date: l.date, entity: l.entry.entity.shortName, kind: l.entry.kind, memo: l.entry.memo, source, debit: l.debit, credit: l.credit, balance };
    });
    out.push({ account: { id: a.id, code: a.code, name: a.name, type: a.type, normalBalance: a.normalBalance }, opening, priorYearProfit: fold * sign, lines: glLines, debit, credit, closing: balance });
  }
  return out;
}
