import type { Db, Tx } from "@/lib/db";
import { formatRate, invertRate, isCurrency, normalizeRateInput, parseRate } from "@/lib/fx/currency";
import { dateOnly, formatPeriod } from "@/lib/format";
import { fiscalEndMonthOfEntities, fiscalLabel, financialYear, fiscalYearStart } from "@/lib/fiscal";

/**
 * Exchange-rate table (ADR 0006): rows are typed in or taken from an imported file — never fetched live.
 * A rate row says: 1 `currency` = `rate` `quote`.
 */

export type RateRow = { currency: string; quote: string; date: Date; kind: "SPOT" | "AVERAGE"; rate: string };

/**
 * Latest SPOT on or before `date` for (currency → quote); falls back to the inverse pair. Pure, for plan-time lookups. `since`: the
 * oldest date a rate may carry (a ledger import converts only at a rate of the row's month or the month before, never a stale one).
 */
export function lookupRate(rows: RateRow[], currency: string, quote: string, date: Date, kind: "SPOT" | "AVERAGE" = "SPOT", since?: Date): string | null {
  if (currency === quote) return "1";
  const pick = (c: string, q: string) =>
    rows
      .filter((r) => r.currency === c && r.quote === q && r.kind === kind && +r.date <= +date && (!since || +r.date >= +since))
      .sort((a, b) => +b.date - +a.date)[0] ?? null;
  const direct = pick(currency, quote);
  if (direct) return direct.rate;
  const inverse = pick(quote, currency);
  return inverse ? invertRate(inverse.rate) : null;
}

export async function loadRates(db: Db | Tx, firmId: string): Promise<RateRow[]> {
  const rows = await db.exchangeRate.findMany({ where: { firmId }, orderBy: { date: "asc" } });
  return rows.map((r) => ({ currency: r.currency, quote: r.quote, date: r.date, kind: r.kind, rate: r.rate }));
}

export class RateError extends Error {}

/**
 * Rates picked up from an imported file only fill empty dates. The Kurs table is per firm, so a stale rate written in one
 * client's file must never replace a rate another import or the accountant already recorded (the draft says so instead).
 */
export async function upsertFileRate(db: Db | Tx, firmId: string, r: RateRow & { note?: string | null }) {
  const key = { firmId, currency: r.currency, quote: r.quote, date: r.date, kind: r.kind };
  // Insert-only (ON CONFLICT DO NOTHING): two imports racing for the same empty date keep whichever landed first.
  await db.exchangeRate.createMany({ data: [{ ...key, rate: formatRate(parseRate(r.rate)), source: "FILE", note: r.note ?? null }], skipDuplicates: true });
  return db.exchangeRate.findUniqueOrThrow({ where: { firmId_currency_quote_date_kind: key } });
}

export async function upsertRate(db: Db | Tx, firmId: string, r: RateRow & { source?: "MANUAL" | "FILE"; note?: string | null }) {
  const rate = formatRate(parseRate(r.rate));
  return db.exchangeRate.upsert({
    where: { firmId_currency_quote_date_kind: { firmId, currency: r.currency, quote: r.quote, date: r.date, kind: r.kind } },
    create: { firmId, currency: r.currency, quote: r.quote, date: r.date, kind: r.kind, rate, source: r.source ?? "MANUAL", note: r.note ?? null },
    update: { rate, source: r.source ?? "MANUAL", note: r.note ?? null },
  });
}

/** Validate a typed-in rate (Kurs page). Throws RateError with a Bahasa message the UI shows verbatim. */
export function validateRateInput(input: { currency: string; quote: string; date: string; kind: string; rate: string }): RateRow {
  if (!isCurrency(input.currency) || !isCurrency(input.quote)) throw new RateError("Pilih mata uang dari daftar.");
  if (input.currency === input.quote) throw new RateError("Mata uang asal dan tujuan harus berbeda.");
  const m = input.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new RateError("Isi tanggal kurs.");
  if (input.kind !== "SPOT" && input.kind !== "AVERAGE") throw new RateError("Pilih jenis kurs.");
  let rate: string;
  try {
    rate = formatRate(parseRate(normalizeRateInput(input.rate, { currency: input.currency, quote: input.quote })));
  } catch {
    throw new RateError('Kurs harus angka positif, mis. "11.250" atau "1.31".');
  }
  return { currency: input.currency, quote: input.quote, date: dateOnly(Number(m[1]), Number(m[2]), Number(m[3])), kind: input.kind, rate };
}

// ─── What translation needs (rule 11) ─────────────────────────────────────────
// Closing: SPOT in the same month as the report date (no stale rates).
// Average: the first AVERAGE dated on/after the period end within the same financial year (a yearly average dated at the year end
// covers every month).
// Historical (equity): SPOT in the month of the entity's first entry.

const sameMonth = (a: Date, b: Date) => a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();

export function closingRate(rows: RateRow[], currency: string, quote: string, asOf: Date): string | null {
  if (currency === quote) return "1";
  const pick = (c: string, q: string) =>
    rows.filter((x) => x.kind === "SPOT" && x.currency === c && x.quote === q && +x.date <= +asOf && sameMonth(x.date, asOf)).sort((a, b) => +b.date - +a.date)[0];
  const direct = pick(currency, quote);
  if (direct) return direct.rate;
  const inverse = pick(quote, currency);
  return inverse ? invertRate(inverse.rate) : null;
}

export function averageRate(rows: RateRow[], currency: string, quote: string, periodEnd: Date, fiscalEndMonth = 12): string | null {
  if (currency === quote) return "1";
  const yearEnd = financialYear(fiscalEndMonth, periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() + 1).end;
  const pick = (c: string, q: string) =>
    rows.filter((x) => x.kind === "AVERAGE" && x.currency === c && x.quote === q && +x.date >= +periodEnd && +x.date <= +yearEnd).sort((a, b) => +a.date - +b.date)[0];
  const direct = pick(currency, quote);
  if (direct) return direct.rate;
  const inverse = pick(quote, currency);
  return inverse ? invertRate(inverse.rate) : null;
}

/**
 * Whether an entity has income/expense lines in the financial year of `asOf` up to `asOf`. Without them the year's average rate
 * translates nothing (prior years' P&L sits in retained earnings at the historical rate), so it isn't needed.
 */
export async function hasYearPl(db: Db, entityId: string, asOf: Date): Promise<boolean> {
  const start = fiscalYearStart(await fiscalEndMonthOfEntities(db, [entityId]), asOf);
  const line = await db.journalLine.findFirst({
    where: { entityId, date: { gte: start, lte: asOf }, account: { type: { in: ["PENDAPATAN", "BEBAN"] } } },
    select: { id: true },
  });
  return line !== null;
}

export type RateNeed = { currency: string; quote: string; kind: "SPOT" | "AVERAGE"; date: Date; label: string; present: boolean };

/** Rates the Gabungan (IDR) needs for every non-IDR entity: historical, each year-end spot and each year's average. */
export async function rateNeeds(db: Db, clientId: string, asOf?: Date): Promise<RateNeed[]> {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId }, include: { entities: true } });
  const rows = await loadRates(db, client.firmId);
  const fem = client.fiscalYearEndMonth ?? 12;
  const needs: RateNeed[] = [];
  for (const e of client.entities.filter((x) => x.functionalCurrency !== "IDR")) {
    const span = await db.journalEntry.aggregate({ where: { entityId: e.id }, _min: { date: true }, _max: { date: true } });
    if (!span._min.date || !span._max.date) continue;
    const c = e.functionalCurrency;
    const first = span._min.date;
    const monthEnd = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    const push = (kind: "SPOT" | "AVERAGE", date: Date, label: string, present: boolean) => {
      if (!needs.some((n) => n.currency === c && n.kind === kind && +n.date === +date)) needs.push({ currency: c, quote: "IDR", kind, date, label, present });
    };
    push("SPOT", monthEnd(first), `Kurs historis ${e.shortName} (entri pertama)`, closingRate(rows, c, "IDR", monthEnd(first)) !== null);
    if (asOf && +asOf >= +first) {
      // The period on screen: its closing spot and its year's average.
      push("SPOT", monthEnd(asOf), `Kurs penutup ${formatPeriod(asOf.getUTCFullYear(), asOf.getUTCMonth() + 1)}`, closingRate(rows, c, "IDR", monthEnd(asOf)) !== null);
      if (await hasYearPl(db, e.id, monthEnd(asOf))) push("AVERAGE", monthEnd(asOf), `Kurs rata-rata s.d. ${formatPeriod(asOf.getUTCFullYear(), asOf.getUTCMonth() + 1)}`, averageRate(rows, c, "IDR", monthEnd(asOf), fem) !== null);
    }
    // Each financial year (the client's tahun buku): its closing spot and, with income or expense in it, its average.
    const nextYear = (fy: { end: Date }) => {
      const d = new Date(+fy.end + 86_400_000);
      return financialYear(fem, d.getUTCFullYear(), d.getUTCMonth() + 1);
    };
    const last = monthEnd(span._max.date);
    for (let fy = financialYear(fem, first.getUTCFullYear(), first.getUTCMonth() + 1); +fy.start <= +last; fy = nextYear(fy)) {
      const end = +fy.end > +last ? last : fy.end;
      push("SPOT", end, `Kurs penutup ${fiscalLabel(fy)}`, closingRate(rows, c, "IDR", end) !== null);
      if (await hasYearPl(db, e.id, end)) push("AVERAGE", end, `Kurs rata-rata ${fiscalLabel(fy)}`, averageRate(rows, c, "IDR", end, fem) !== null);
    }
  }
  return needs;
}
