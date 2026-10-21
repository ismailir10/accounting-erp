import type { Db } from "@/lib/db";
import type { Account } from "@/lib/generated/prisma/client";
import { convertMinor, PRESENTATION_CURRENCY } from "@/lib/fx/currency";
import { averageRate, closingRate, hasYearPl, loadRates, type RateRow } from "@/lib/fx/rates";
import { ACCOUNT_CODES } from "@/lib/coa/template";
import { formatDate } from "@/lib/format";
import { financialYear, fiscalEndMonthOfEntities, fiscalLabel } from "@/lib/fiscal";

/**
 * Translation of non-IDR entities for the combined (IDR) view — accounting-rules §11, ADR 0006.
 * Assets & liabilities at the closing rate, income & expense at the period's average rate, equity at the historical rate
 * (rate in the month of the entity's first entry). The residue goes to 3900 Selisih penjabaran. A missing rate throws
 * FxMissingError — never a number computed with a guessed rate.
 */

export class FxMissingError extends Error {
  constructor(readonly missing: { entity: string; need: string }[]) {
    super(`Kurs untuk menjabarkan ke Rupiah belum lengkap: ${missing.map((m) => `${m.entity} — ${m.need}`).join("; ")}. Isi di halaman Kurs.`);
  }
}

export type EntityCurrency = { id: string; shortName: string; functionalCurrency: string };

export async function scopeEntities(db: Db, entityIds: string[]): Promise<EntityCurrency[]> {
  return db.entity.findMany({ where: { id: { in: entityIds } }, select: { id: true, shortName: true, functionalCurrency: true } });
}

/** Reporting currency of a scope: its one functional currency, or IDR when entities differ. */
export function scopeCurrency(entities: EntityCurrency[]): string {
  const set = new Set(entities.map((e) => e.functionalCurrency));
  return set.size === 1 ? [...set][0] : PRESENTATION_CURRENCY;
}

export const isMixed = (entities: EntityCurrency[]) => new Set(entities.map((e) => e.functionalCurrency)).size > 1;

const monthEnd = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));

export type EntityRates = { closing: string; average: string; historical: string };

/** Rates to translate one entity as of `asOf` (and for a P&L period ending `asOf`). */
export async function entityRates(db: Db, firmId: string, e: EntityCurrency, asOf: Date, rows?: RateRow[]): Promise<EntityRates | { missing: string[] }> {
  if (e.functionalCurrency === PRESENTATION_CURRENCY) return { closing: "1", average: "1", historical: "1" };
  const rates = rows ?? (await loadRates(db, firmId));
  const first = await db.journalEntry.findFirst({ where: { entityId: e.id }, orderBy: { date: "asc" }, select: { date: true } });
  const c = e.functionalCurrency;
  const histDate = monthEnd(first?.date ?? asOf);
  const closing = closingRate(rates, c, PRESENTATION_CURRENCY, asOf);
  // No income/expense this year → the average would translate only zeros, so it isn't demanded (rule 11: P&L only).
  const needAverage = await hasYearPl(db, e.id, asOf);
  const fem = await fiscalEndMonthOfEntities(db, [e.id]);
  const average = averageRate(rates, c, PRESENTATION_CURRENCY, asOf, fem) ?? (needAverage ? null : closing);
  const historical = closingRate(rates, c, PRESENTATION_CURRENCY, histDate);
  const missing: string[] = [];
  if (!closing) missing.push(`kurs penutup ${c}→IDR bulan ${formatDate(asOf).replace(/^\d+ /, "")}`);
  if (!average && needAverage) missing.push(`kurs rata-rata ${c}→IDR ${fiscalLabel(financialYear(fem, asOf.getUTCFullYear(), asOf.getUTCMonth() + 1))}`);
  if (!historical) missing.push(`kurs historis ${c}→IDR bulan ${formatDate(histDate).replace(/^\d+ /, "")}`);
  return missing.length ? { missing } : { closing: closing!, average: average!, historical: historical! };
}

/** Translate one signed functional amount into IDR minor units. */
export function translate(net: bigint, currency: string, rate: string): bigint {
  if (currency === PRESENTATION_CURRENCY) return net;
  const abs = net < 0n ? -net : net;
  const v = convertMinor(abs, currency, PRESENTATION_CURRENCY, rate);
  return net < 0n ? -v : v;
}

export function rateForAccount(a: Pick<Account, "type">, r: EntityRates) {
  return a.type === "ASET" || a.type === "LIABILITAS" ? r.closing : a.type === "EKUITAS" ? r.historical : r.average;
}

/**
 * Translate an entity's TB-shaped rows (net per account, debit-positive) and put the residue on 3900 so the translated
 * rows still sum to zero. Returns the translated nets keyed by account id plus the translation difference.
 */
export function translateNets<T extends { account: Account; net: bigint }>(rows: T[], currency: string, r: EntityRates): { nets: Map<string, bigint>; difference: bigint } {
  const nets = new Map<string, bigint>();
  let sum = 0n;
  for (const row of rows) {
    const v = translate(row.net, currency, rateForAccount(row.account, r));
    nets.set(row.account.id, v);
    sum += v;
  }
  const cta = rows.find((x) => x.account.code === ACCOUNT_CODES.TRANSLATION);
  if (cta && sum !== 0n) nets.set(cta.account.id, (nets.get(cta.account.id) ?? 0n) - sum);
  return { nets, difference: -sum };
}
