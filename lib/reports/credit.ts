import type { Db } from "@/lib/db";
import { periodBounds } from "@/lib/format";
import { incomeStatement, trialBalance } from "@/lib/reports/ledger";
import { collectedProceeds } from "@/lib/reports/statements";

/**
 * Paket Kredit Bank (I4a, ADR 0014): what a bank's analyst checks first, prepared from the books. Read-only; nothing is stored.
 *
 * `receiptsVsRevenue` — per month, the money in on the company's bank accounts, read by how each line was classified:
 *   transfers between own accounts (1199 / 1190), loans & capital (a LIABILITAS or EKUITAS account) and lines not classified yet
 *   (1999, or still in Review) are set apart, and so are the proceeds of a fixed asset sold (what the bank receipts collected of a disposal's
 *   proceeds, as the cash flow's investing line counts them); the rest is *penerimaan usaha*, set against the Laba Rugi's revenue. A split line counts
 *   by its parts. Receipts include PPN and collections of earlier sales, so the ratio is a reading, not a reconciliation.
 * `sourceTrail` — per account, how many journal lines came from bank rows, ledger file rows, Saldo Awal, and the rest (adjustments,
 *   invoices, manual journals): every number in Buku traces to one of these.
 */
export type ReceiptsMonth = { year: number; month: number; moneyIn: bigint; transfers: bigint; financing: bigint; disposals: bigint; unclassified: bigint; operating: bigint; revenue: bigint };

const TRANSFER = new Set(["1199", "1190"]);
const SUSPENSE = "1999";

export async function receiptsVsRevenue(db: Db, input: { clientId: string; entityId: string; year: number; month: number; months?: number }): Promise<ReceiptsMonth[]> {
  const span = input.months ?? 12;
  const first = await db.bankTransaction.findFirst({ where: { entityId: input.entityId }, orderBy: { date: "asc" }, select: { date: true } });
  if (!first) return [];
  const firstKey = first.date.getUTCFullYear() * 12 + first.date.getUTCMonth();
  const lastKey = input.year * 12 + input.month - 1;
  const months = Array.from({ length: span }, (_, i) => lastKey - (span - 1 - i)).filter((k) => k >= firstKey);
  if (!months.length) return [];
  const from = periodBounds(Math.floor(months[0] / 12), (months[0] % 12) + 1).start;
  const to = periodBounds(input.year, input.month).end;

  const [types, lines] = await Promise.all([
    db.account.findMany({ where: { clientId: input.clientId }, select: { code: true, type: true } }).then((as) => new Map(as.map((a) => [a.code, a.type]))),
    db.bankTransaction.findMany({
      where: { entityId: input.entityId, amount: { gt: 0n }, date: { gte: from, lte: to } },
      select: { date: true, amount: true, accountCode: true, status: true, splits: { select: { accountCode: true, amount: true } } },
    }),
  ]);
  const out = new Map<number, ReceiptsMonth>(
    months.map((k) => [k, { year: Math.floor(k / 12), month: (k % 12) + 1, moneyIn: 0n, transfers: 0n, financing: 0n, disposals: 0n, unclassified: 0n, operating: 0n, revenue: 0n }]),
  );
  for (const l of lines) {
    const m = out.get(l.date.getUTCFullYear() * 12 + l.date.getUTCMonth())!;
    m.moneyIn += l.amount;
    const parts = l.splits.length ? l.splits : [{ accountCode: l.accountCode, amount: l.amount }];
    for (const p of parts) {
      const type = p.accountCode ? types.get(p.accountCode) : undefined;
      if (l.status === "NEEDS_REVIEW" || !p.accountCode || p.accountCode === SUSPENSE) m.unclassified += p.amount;
      else if (TRANSFER.has(p.accountCode)) m.transfers += p.amount;
      else if (type === "LIABILITAS" || type === "EKUITAS") m.financing += p.amount;
      else m.operating += p.amount;
    }
  }
  // Disposal proceeds collected in each month (first in, first out on the proceeds account, cash receipts only) were counted above as
  // receipts on an asset account: they are an asset sold, not business.
  const disposals = await db.fixedAsset.findMany({ where: { entityId: input.entityId, disposalEntryId: { not: null } }, select: { disposalEntryId: true } });
  if (disposals.length) {
    const proceeds = (
      await db.journalLine.findMany({ where: { entryId: { in: disposals.map((d) => d.disposalEntryId!) } }, select: { id: true, entryId: true, debit: true, credit: true, account: { select: { code: true, type: true, fsLine: true } } } })
    ).filter((l) => l.debit > l.credit && l.account.type === "ASET" && l.account.fsLine !== "ASET_TETAP" && l.account.fsLine !== "AKUM_PENYUSUTAN");
    const total = async (at: Date) => [...(await collectedProceeds(db, [input.entityId], at, proceeds)).values()].reduce((t, v) => t + v, 0n);
    let before = await total(new Date(+from - 86_400_000));
    for (const m of out.values()) {
      const now = await total(periodBounds(m.year, m.month).end);
      const sold = now - before < m.operating ? now - before : m.operating;
      m.disposals += sold;
      m.operating -= sold;
      before = now;
    }
  }
  const scope = { clientId: input.clientId, entityIds: [input.entityId] };
  await Promise.all(
    [...out.values()].map(async (m) => {
      const { start, end } = periodBounds(m.year, m.month);
      m.revenue = (await incomeStatement(db, scope, start, end)).totals.revenue;
    }),
  );
  return [...out.values()];
}

/** Penerimaan usaha ÷ pendapatan in thousandths (1.080 → "1,08"); null without revenue. */
export const receiptsRatio = (m: Pick<ReceiptsMonth, "operating" | "revenue">) => (m.revenue > 0n ? (m.operating * 1000n) / m.revenue : null);

export type TrailRow = { code: string; name: string; type: string; balance: bigint; bank: number; ledger: number; opening: number; other: number };

export async function sourceTrail(db: Db, input: { clientId: string; entityId: string; year: number; month: number }): Promise<TrailRow[]> {
  const end = periodBounds(input.year, input.month).end;
  const [tb, counts] = await Promise.all([
    trialBalance(db, { clientId: input.clientId, entityIds: [input.entityId] }, end),
    db.$queryRaw<{ accountId: string; bank: bigint; ledger: bigint; opening: bigint; other: bigint }[]>`
      SELECT l."accountId",
        COUNT(*) FILTER (WHERE e."bankTransactionId" IS NOT NULL) AS bank,
        COUNT(*) FILTER (WHERE e."bankTransactionId" IS NULL AND e."ledgerImportId" IS NOT NULL) AS ledger,
        COUNT(*) FILTER (WHERE e."bankTransactionId" IS NULL AND e."ledgerImportId" IS NULL AND e.kind = 'OPENING') AS opening,
        COUNT(*) FILTER (WHERE e."bankTransactionId" IS NULL AND e."ledgerImportId" IS NULL AND e.kind <> 'OPENING') AS other
      FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId"
      WHERE l."entityId" = ${input.entityId} AND l.date <= ${end}
      GROUP BY l."accountId"`,
  ]);
  const byId = new Map(counts.map((c) => [c.accountId, c]));
  return tb
    .filter((r) => byId.has(r.account.id))
    .map((r) => {
      const c = byId.get(r.account.id)!;
      return { code: r.account.code, name: r.account.name, type: r.account.type, balance: r.net, bank: Number(c.bank), ledger: Number(c.ledger), opening: Number(c.opening), other: Number(c.other) };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}
