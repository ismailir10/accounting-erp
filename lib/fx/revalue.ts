import type { Db, Tx } from "@/lib/db";
import { closeLock } from "@/lib/adjust/schedules";
import { ACCOUNT_CODES } from "@/lib/coa/template";
import { convertMinor } from "@/lib/fx/currency";
import { closingRate, loadRates } from "@/lib/fx/rates";
import { formatPeriod, periodBounds } from "@/lib/format";
import { postJournal, type PostLine } from "@/lib/ledger/post";

/**
 * Month-end revaluation of monetary foreign-currency balances (accounting-rules §6b). Deterministic, proposed only:
 * per (entity, account, currency) the foreign balance × closing rate is compared with the functional balance; the difference
 * goes to 7200 Laba/Rugi Selisih Kurs when the accountant clicks. Revaluation lines keep the currency with fx amount 0.
 */

export type RevalLine = { accountId: string; code: string; name: string; currency: string; fxBalance: bigint; carried: bigint; target: bigint; diff: bigint; rate: string };
export type RevalProposal = { entityId: string; entityName: string; functional: string; date: Date; lines: RevalLine[]; missingRates: string[] };

export class RevaluationError extends Error {}

/**
 * Non-monetary balance-sheet items stay at their historical rate (PSAK 210): fixed assets and their depreciation, inventory, prepayments,
 * intangibles and investments, and revenue received in advance. Everything else (cash, receivables, payables, loans) is monetary.
 */
const NON_MONETARY_LINES = new Set(["ASET_TETAP", "AKUM_PENYUSUTAN", "PERSEDIAAN", "BIAYA_DIBAYAR_DIMUKA", "ASET_TIDAK_LANCAR_LAIN"]);
const NON_MONETARY_CODES = new Set(["2160"]);
const monetary = (a: { type: string; fsLine: string; code: string }) =>
  (a.type === "ASET" || a.type === "LIABILITAS") && !NON_MONETARY_LINES.has(a.fsLine) && !NON_MONETARY_CODES.has(a.code);

export async function revaluationProposals(db: Db | Tx, clientId: string, year: number, month: number): Promise<RevalProposal[]> {
  const { end } = periodBounds(year, month);
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId }, include: { entities: true } });
  const rates = await loadRates(db, client.firmId);
  const out: RevalProposal[] = [];
  for (const e of client.entities) {
    const lines = await db.journalLine.findMany({
      where: { entityId: e.id, currency: { not: null }, date: { lte: end } },
      select: { accountId: true, currency: true, fxAmount: true, debit: true, credit: true, account: { select: { code: true, name: true, type: true, fsLine: true } } },
    });
    const groups = new Map<string, RevalLine>();
    for (const l of lines) {
      // Only monetary balance-sheet items are revalued; income & expense and non-monetary items stay at their transaction rate.
      if (!monetary(l.account)) continue;
      const key = `${l.accountId}|${l.currency}`;
      const g = groups.get(key) ?? { accountId: l.accountId, code: l.account.code, name: l.account.name, currency: l.currency!, fxBalance: 0n, carried: 0n, target: 0n, diff: 0n, rate: "" };
      const sign = l.debit > 0n ? 1n : -1n;
      g.fxBalance += sign * (l.fxAmount ?? 0n);
      g.carried += l.debit - l.credit;
      groups.set(key, g);
    }
    if (!groups.size) continue;
    const missing = new Set<string>();
    const result: RevalLine[] = [];
    for (const g of groups.values()) {
      const rate = closingRate(rates, g.currency, e.functionalCurrency, end);
      if (!rate) {
        missing.add(`kurs penutup ${g.currency}→${e.functionalCurrency} bulan ${formatPeriod(year, month)}`);
        continue;
      }
      const abs = g.fxBalance < 0n ? -g.fxBalance : g.fxBalance;
      const v = convertMinor(abs, g.currency, e.functionalCurrency, rate);
      g.target = g.fxBalance < 0n ? -v : v;
      g.diff = g.target - g.carried;
      g.rate = rate;
      if (g.diff !== 0n) result.push(g);
    }
    out.push({ entityId: e.id, entityName: e.shortName, functional: e.functionalCurrency, date: end, lines: result, missingRates: [...missing] });
  }
  return out;
}

/**
 * The accountant's click: post one ADJUSTMENT per entity with every difference against 7200. The proposal is read again under the client's
 * close lock, so a second click (or two tabs) finds nothing left to post instead of booking the difference twice.
 */
export async function postRevaluation(db: Db, clientId: string, entityId: string, year: number, month: number, actorId?: string | null) {
  const fx = await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId, code: ACCOUNT_CODES.FX_GAIN_LOSS } } });
  return db.$transaction(async (tx) => {
    await closeLock(tx, clientId);
    const proposal = (await revaluationProposals(tx, clientId, year, month)).find((p) => p.entityId === entityId);
    if (!proposal || !proposal.lines.length) throw new RevaluationError("Tidak ada selisih kurs yang perlu dicatat.");
    if (proposal.missingRates.length) throw new RevaluationError(`Isi dulu ${proposal.missingRates.join(", ")} di halaman Kurs.`);
    const lines: PostLine[] = [];
    let total = 0n;
    for (const l of proposal.lines) {
      const abs = l.diff < 0n ? -l.diff : l.diff;
      lines.push({ accountId: l.accountId, debit: l.diff > 0n ? abs : 0n, credit: l.diff < 0n ? abs : 0n, memo: `${l.currency} ${l.fxBalance} @ ${l.rate}`, fx: { currency: l.currency, amount: 0n, rate: l.rate, revaluation: true } });
      total += l.diff;
    }
    // Gain (total > 0) credits 7200, loss debits it.
    lines.push({ accountId: fx.id, debit: total < 0n ? -total : 0n, credit: total > 0n ? total : 0n, memo: "Laba/rugi selisih kurs belum direalisasi" });
    return postJournal(tx, { entityId, date: proposal.date, kind: "ADJUSTMENT", memo: `Revaluasi kurs ${formatPeriod(year, month)}`, lines, actorId });
  });
}
