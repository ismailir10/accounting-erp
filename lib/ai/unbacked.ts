import type { Db } from "@/lib/db";
import type { Direction, EntityKind } from "@/lib/generated/prisma/enums";
import type { Classification } from "@/lib/classify/types";
import { simpleGuess } from "@/lib/classify/fallback";

/**
 * An AI suggestion of a trade receivable for money in (or a trade payable for money out) settles something — so the books must hold
 * something to settle. With nothing on the entity's PIUTANG_USAHA (or UTANG_USAHA) accounts the suggestion would leave them against
 * their nature (seen in production: every customer receipt of a client with no invoices proposed as *1130 Piutang Usaha* at 85%).
 * Such a suggestion is **replaced** by the account the simple guess uses for an unexplained line (`lib/classify/fallback.ts`: a company's
 * money in → 4100 Penjualan, out → 6190 Beban Umum; a person's 4910 / 3300) — keeping the impossible account selected made the accountant
 * retype it for every group (seen in production: ~200 of 248 rows of one client pre-filled 1130). It stays an AI suggestion, below the bulk
 * accept (0.8) and the *tebakan* line (0.6), with the reason said: accepted unchanged, the sanity control's "tebakan yang diterima begitu
 * saja" raises it. Deterministic; the cached AI answer is untouched. A chart without the fallback account keeps the AI's account, demoted.
 */
export const UNBACKED_CONFIDENCE = 0.55;

const TRADE = { IN: "PIUTANG_USAHA", OUT: "UTANG_USAHA" } as const;

/** What the entity's books hold to settle: a debit balance on its trade receivables, a credit balance on its trade payables. */
export type TradeBacking = { receivable: boolean; payable: boolean };

/**
 * The entity's trade receivable/payable position as of any date (inclusive): one query, then each bank row asks about its own date —
 * a receivable booked after an older row can't have been what that row settled.
 */
export async function tradeBacking(db: Db, entityId: string): Promise<(asOf: Date) => TradeBacking> {
  const lines = await db.journalLine.findMany({
    where: { entityId, account: { fsLine: { in: [TRADE.IN, TRADE.OUT] } } },
    select: { date: true, debit: true, credit: true, account: { select: { fsLine: true } } },
  });
  return (asOf) => {
    let receivable = 0n;
    let payable = 0n;
    for (const l of lines) {
      if (+l.date > +asOf) continue;
      if (l.account.fsLine === TRADE.IN) receivable += l.debit - l.credit;
      else payable += l.credit - l.debit;
    }
    return { receivable: receivable > 0n, payable: payable > 0n };
  };
}

export type AccountLookup = (code: string) => { fsLine: string; name: string } | undefined;

/** The client's accounts by code, for `demoteUnbacked` (the classifiable ones: never a bank or suspense account). */
export const accountLookup = (accounts: { code: string; name: string; fsLine: string }[]): AccountLookup => {
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  return (code) => byCode.get(code);
};

const REASON = {
  IN: { what: "piutang usaha", then: "dianggap penjualan tunai", keep: "periksa apakah ini penjualan tunai" },
  OUT: { what: "utang usaha", then: "dianggap beban atau pembelian langsung", keep: "periksa apakah ini beban atau pembelian langsung" },
} as const;

/**
 * The suggestion as Review should see it: an AI receivable/payable the books don't hold is replaced by the simple guess's account
 * (reason rewritten, tax tag cleared, confidence capped), or only demoted when the chart lacks that account.
 */
export function demoteUnbacked(c: Classification, direction: Direction, kind: EntityKind, accountOf: AccountLookup, backing: TradeBacking): Classification {
  if (c.method !== "AI") return c;
  const from = accountOf(c.accountCode);
  const unbacked = direction === "IN" ? from?.fsLine === TRADE.IN && !backing.receivable : from?.fsLine === TRADE.OUT && !backing.payable;
  if (!unbacked || !from) return c;
  const confidence = Math.min(c.confidence, UNBACKED_CONFIDENCE);
  const r = REASON[direction];
  const fallback = simpleGuess(direction, kind).accountCode;
  const to = accountOf(fallback);
  if (!to) return { ...c, confidence, reason: `${c.reason} · Belum ada ${r.what} tercatat untuk entitas ini: ${r.keep}.` };
  return {
    ...c,
    accountCode: fallback,
    taxTag: null,
    confidence,
    reason: `AI mengusulkan ${c.accountCode} ${from.name}, tetapi tidak ada ${r.what} tercatat untuk entitas ini: ${r.then} (${fallback} ${to.name}).`,
  };
}
