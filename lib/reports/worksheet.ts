import type { Db } from "@/lib/db";
import type { Account } from "@/lib/generated/prisma/client";
import { isMixed, scopeEntities } from "@/lib/reports/fx";
import { trialBalance, type Scope } from "@/lib/reports/ledger";

/**
 * Neraca Lajur (cycle 2026-10-20-paritas-inti): the ten-column worksheet. Per account, debit − credit (`net`):
 *  - Neraca Saldo = the closing balance before this range's adjustments (closing − the range's ADJUSTMENT lines);
 *  - Penyesuaian = those lines' debit and credit, gross (an accrual and its reversal both show);
 *  - Neraca Saldo Disesuaikan = the closing balance, the Neraca Saldo page's number;
 *  - Laba Rugi = the adjusted balance of income and expense accounts, Neraca = of every other account;
 * and the profit that balances the last two pairs (credit − debit of Laba Rugi). "Penyesuaian" is the ADJUSTMENT kind: Jurnal
 * Penyesuaian, reversals, schedule instalments, tax, lease and benefit postings; bank lines, reclassifications, invoices, imports and
 * Saldo Awal are the books before adjustment. Derived from JournalLine at read time; single-currency scopes only.
 */
export type WorksheetLine = {
  account: Pick<Account, "id" | "code" | "name" | "type">;
  /** Before adjustments: net (debit − credit). */
  unadjusted: bigint;
  adjDebit: bigint;
  adjCredit: bigint;
  /** After adjustments: net, equal to the trial balance. */
  adjusted: bigint;
  /** Income or expense: the adjusted balance goes to Laba Rugi, else to Neraca. */
  pl: boolean;
};

export type Worksheet = {
  lines: WorksheetLine[];
  totals: {
    unadjusted: { debit: bigint; credit: bigint };
    adjustments: { debit: bigint; credit: bigint };
    adjusted: { debit: bigint; credit: bigint };
    pl: { debit: bigint; credit: bigint };
    bs: { debit: bigint; credit: bigint };
  };
  /** Credit − debit of the Laba Rugi columns: profit is positive. */
  profit: bigint;
};

const sides = (net: bigint) => ({ debit: net > 0n ? net : 0n, credit: net < 0n ? -net : 0n });

export async function neracaLajur(db: Db, scope: Scope, start: Date, end: Date): Promise<Worksheet> {
  if (isMixed(await scopeEntities(db, scope.entityIds))) throw new Error("Neraca lajur hanya untuk satu mata uang. Pilih satu perusahaan.");
  const [closing, adjustments] = await Promise.all([
    trialBalance(db, scope, end),
    db.journalLine.groupBy({
      by: ["accountId"],
      where: { entityId: { in: scope.entityIds }, date: { gte: start, lte: end }, entry: { kind: "ADJUSTMENT" } },
      _sum: { debit: true, credit: true },
    }),
  ]);
  const adj = new Map(adjustments.map((a) => [a.accountId, { debit: a._sum.debit ?? 0n, credit: a._sum.credit ?? 0n }]));
  const lines: WorksheetLine[] = [];
  for (const r of closing) {
    const a = adj.get(r.account.id) ?? { debit: 0n, credit: 0n };
    const unadjusted = r.net - (a.debit - a.credit);
    if (r.net === 0n && unadjusted === 0n && a.debit === 0n && a.credit === 0n) continue;
    lines.push({
      account: { id: r.account.id, code: r.account.code, name: r.account.name, type: r.account.type },
      unadjusted,
      adjDebit: a.debit,
      adjCredit: a.credit,
      adjusted: r.net,
      pl: r.account.type === "PENDAPATAN" || r.account.type === "BEBAN",
    });
  }
  const sum = (pick: (l: WorksheetLine) => { debit: bigint; credit: bigint }) =>
    lines.reduce((t, l) => {
      const s = pick(l);
      return { debit: t.debit + s.debit, credit: t.credit + s.credit };
    }, { debit: 0n, credit: 0n });
  const zero = { debit: 0n, credit: 0n };
  const totals = {
    unadjusted: sum((l) => sides(l.unadjusted)),
    adjustments: sum((l) => ({ debit: l.adjDebit, credit: l.adjCredit })),
    adjusted: sum((l) => sides(l.adjusted)),
    pl: sum((l) => (l.pl ? sides(l.adjusted) : zero)),
    bs: sum((l) => (l.pl ? zero : sides(l.adjusted))),
  };
  return { lines, totals, profit: totals.pl.credit - totals.pl.debit };
}
