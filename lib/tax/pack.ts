import type { Db, Tx } from "@/lib/db";
import type { CorrectionDirection, CorrectionKind, TaxCreditType, TaxPostingKind, TaxRegime } from "@/lib/generated/prisma/enums";
import { incomeStatement } from "@/lib/reports/ledger";
import { assetRegister } from "@/lib/assets/register";
import { ACCOUNT_CODES } from "@/lib/coa/template";
import { dateOnly, periodBounds } from "@/lib/format";
import { allowanceBalance } from "@/lib/receivables/ckpn";
import { terms as leaseTerms } from "@/lib/leases/register";
import { leaseSchedule, positionAt } from "@/lib/leases/schedule";
import { corporateTax, deferredTax, roundDownThousands, settlement, type CorporateTax, type Settlement } from "@/lib/tax/compute";
import { categoryOf, compensate, share, type LossRow } from "@/lib/tax/categories";

/**
 * The tax pack of one entity and fiscal year, through a month (accounting-rules 5d): commercial profit → koreksi fiskal → PKP → PPh
 * badan → credits → PPh 29 / 28A, deferred tax, and the journals that would bring the books to that position. Read from the GL and the
 * accountant's records at request time; nothing computed is stored.
 */

/** Bank interest and jasa giro: income already taxed finally under PPh 4(2), so it leaves fiscal profit. */
export const FINAL_TAXED_INCOME = /bunga|jasa giro|deposito/i;

export type Correction = {
  key: string;
  label: string;
  direction: CorrectionDirection;
  kind: CorrectionKind;
  amount: bigint;
  /** Where it comes from: the asset register, the lease register, an account's ledger, or the accountant's own row. */
  source: { type: "ASSETS" } | { type: "LEASES" } | { type: "ACCOUNT"; code: string; name: string } | { type: "MANUAL"; id: string; code: string | null; percent: number | null };
};
/** A correction category matched by an expense account's name (lib/tax/categories.ts); `amount` is the account, `corrected` its share. */
export type Suggestion = { key: string; code: string; name: string; amount: bigint; category: string; label: string; percent: number; direction: CorrectionDirection; kind: CorrectionKind; corrected: bigint };
export type Credit = { key: string; type: TaxCreditType | "PPH_25"; label: string; date: Date; /** PPh 25: the month the instalment is for (null: not set, counted by its bank date). */ masa: Date | null; amount: bigint; accountCode: string; source: { type: "BANK"; bankTransactionId: string } | { type: "MANUAL"; id: string } };
export type ProposalLine = { code: string; amount: bigint };

export type TaxPack = {
  entity: { id: string; name: string; shortName: string; kind: string; functionalCurrency: string };
  year: number;
  month: number;
  through: Date;
  applicable: boolean;
  regime: TaxRegime;
  taxYearId: string | null;
  profitBeforeTax: bigint;
  /** Peredaran bruto: the Laba Rugi revenue; under the normal regime less income a customer withheld final PPh 4(2) on (Pasal 31E). */
  turnover: bigint;
  /** PPh 4(2) customers withheld from the year's receipts (already on 8200): under PP 55 it is part of the 0,5 %, not remitted again. */
  finalWithheld: bigint;
  /** Months of the year the books cover through the chosen month; under 12, Pasal 31E is judged on the turnover annualised. */
  months: number;
  /** The Laba Rugi behind profit before tax, per account: income positive, expenses negative (the workpaper's first sheet). */
  profitAndLoss: { code: string; name: string; section: string; amount: bigint }[];
  corrections: Correction[];
  suggestions: Suggestion[];
  positive: bigint;
  negative: bigint;
  fiscalProfit: bigint;
  /** Kompensasi kerugian: each origin year's use this year, and the total taken off fiscal profit. */
  losses: LossRow[];
  compensation: bigint;
  /** Last year's fiscal loss as Buku computed it (December), offered as an origin-year row. */
  lossSuggestion: { originYear: number; amount: bigint } | null;
  tax: CorporateTax;
  credits: Credit[];
  settlement: Settlement | null;
  /** Temporary differences: fixed assets (fiscal − book value), the receivable allowance (1135, deductible when written off) and leases
   *  (prepaid − accrued fiscal rent, less ROU net of the liability) and the employee-benefit liability (2310, deductible when paid). `oci` is the
   *  part of the deferred tax that belongs to the remeasurement in 3920 (booked there, not to 8110). */
  deferred: { assets: bigint; allowance: bigint; leases: bigint; employeeBenefits: bigint; temporaryDifference: bigint; amount: bigint; oci: bigint } | null;
  /** Signed lines (debit +, credit −) still to post to reach the computed position, per kind; empty = nothing to post. */
  proposals: Record<TaxPostingKind, ProposalLine[]>;
  /** A posting of the kind dated after the chosen month: the position is booked there, so nothing is proposed here. */
  laterPosting: Record<TaxPostingKind, Date | null>;
};

type Reader = Db | Tx;

/**
 * Months of `year` the books cover through `month`. Books opened inside the year with a balance sheet only start the day after the
 * opening; an opening that carries income or expense holds the year so far, so it covers from January, as does any earlier opening.
 */
async function monthsCovered(db: Reader, entityId: string, year: number, month: number): Promise<number> {
  const opening = await db.journalEntry.findFirst({
    where: { entityId, kind: "OPENING", date: { gte: dateOnly(year, 1, 1), lte: periodBounds(year, month).end } },
    orderBy: { date: "asc" },
    select: { date: true, lines: { select: { account: { select: { type: true } } } } },
  });
  if (!opening || opening.lines.some((l) => l.account.type === "PENDAPATAN" || l.account.type === "BEBAN")) return month;
  const start = new Date(+opening.date + 86_400_000);
  return start.getUTCFullYear() > year ? month : Math.max(1, month - start.getUTCMonth());
}

/** A PPh badan pack applies to companies (not individuals) keeping IDR books. */
export const packApplies = (e: { kind: string; functionalCurrency: string }) => e.kind !== "PERORANGAN" && e.functionalCurrency === "IDR";

export async function taxPack(db: Db, clientId: string, entityId: string, year: number, month: number, opts: { nested?: boolean } = {}): Promise<TaxPack | null> {
  const entity = await db.entity.findFirst({ where: { id: entityId, clientId }, select: { id: true, name: true, shortName: true, kind: true, functionalCurrency: true } });
  if (!entity) return null;
  const through = periodBounds(year, month).end;
  const from = dateOnly(year, 1, 1);
  const taxYear = await db.taxYear.findUnique({ where: { entityId_year: { entityId, year } }, include: { losses: true, corrections: { include: { account: true }, orderBy: { createdAt: "asc" } }, credits: { include: { account: true }, orderBy: [{ date: "asc" }, { createdAt: "asc" }] } } });
  const regime: TaxRegime = taxYear?.regime ?? "NORMAL";
  const final = regime === "FINAL_UMKM";
  const scope = { clientId, entityIds: [entityId] };
  const is = await incomeStatement(db, scope, from, through);
  const profitBeforeTax = is.totals.profitBeforeTax;
  // Receipts a customer or tenant withheld PPh 4(2) from (rule 5h: Dr 8200, the income credited gross): final tax already paid on that
  // income. Under PP 55 it is part of the year's 0,5 % (the customer as designated withholder, Pasal 58); under the normal regime the
  // income is taxed finally and leaves the PPh badan computation (UU PPh Pasal 4 ayat (2)).
  const withheldFinal = await db.bankTransaction.findMany({ where: { entityId, direction: "IN", whtKind: "PPH_4_2", whtAmount: { gt: 0n }, date: { gte: from, lte: through } }, select: { id: true, whtAmount: true } });
  const finalWithheld = withheldFinal.reduce((t, x) => t + x.whtAmount, 0n);
  // The gross of that income, per income account: what the receipts' journals (bank entry and any reclass) credit to it.
  const finalIncome = new Map<string, { name: string; amount: bigint }>();
  if (!final && withheldFinal.length) {
    const rows = await db.journalLine.findMany({ where: { entityId, entry: { bankTransactionId: { in: withheldFinal.map((x) => x.id) } }, account: { clientId, type: "PENDAPATAN" } }, select: { debit: true, credit: true, account: { select: { code: true, name: true } } } });
    for (const r of rows) {
      const cur = finalIncome.get(r.account.code) ?? { name: r.account.name, amount: 0n };
      cur.amount += r.credit - r.debit;
      finalIncome.set(r.account.code, cur);
    }
  }
  // Pasal 31E is judged on peredaran bruto without income taxed finally (SE-02/PJ/2015); the 0,5 % of PP 55 is on all of it.
  const revenueCodes = new Set(is.revenue.flatMap((i) => i.accounts.map((a) => a.code)));
  const turnover = is.totals.revenue - [...finalIncome].reduce((t, [code, x]) => t + (revenueCodes.has(code) && x.amount > 0n ? x.amount : 0n), 0n);

  // ---- koreksi fiskal ----
  const corrections: Correction[] = [];
  const assets = await assetRegister(db, clientId, year, month, [entityId]);
  const depreciationDiff = assets.reduce((t, r) => t + (r.difference ?? 0n), 0n);
  if (depreciationDiff !== 0n) {
    corrections.push({ key: "auto:depreciation", label: "Selisih penyusutan komersial dan fiskal", direction: depreciationDiff > 0n ? "POSITIVE" : "NEGATIVE", kind: "TEMPORARY", amount: depreciationDiff < 0n ? -depreciationDiff : depreciationDiff, source: { type: "ASSETS" } });
  }
  // An asset disposed this year: the fiscal gain or loss is reckoned on the fiscal book value, so the difference of the two depreciations
  // so far reverses (without it a disposal in the acquisition year keeps a correction for a deduction that both sides end up equal on).
  const disposalDiff = assets.reduce((t, r) => t + (r.disposalDifference ?? 0n), 0n);
  if (disposalDiff !== 0n) {
    corrections.push({ key: "auto:disposal", label: "Selisih laba/rugi pelepasan aset tetap komersial dan fiskal", direction: disposalDiff > 0n ? "POSITIVE" : "NEGATIVE", kind: "TEMPORARY", amount: disposalDiff < 0n ? -disposalDiff : disposalDiff, source: { type: "ASSETS" } });
  }
  // Leases (rule 5f): the PSAK 116 depreciation + interest actually journalled (so an unposted month adds nothing the books don't carry)
  // out, rent straight line over the term in.
  const leases = (await db.lease.findMany({ where: { clientId, entityId, cancelEntryId: null }, include: { postings: { select: { month: true } } } }))
    .map((l) => {
      const t = leaseTerms(l);
      const s = leaseSchedule(t);
      const p = positionAt(t, s, year, month);
      const posted = s.months.filter((m) => l.postings.some((x) => x.month === m.k) && +m.date <= +through);
      const book = (ms: typeof posted) => ms.reduce((a, m) => a + m.depreciation + m.interest, 0n);
      return { started: p.started, bookYear: book(posted.filter((m) => m.year === year)), bookToDate: book(posted), fiscalYear: p.year.fiscalRent, fiscalToDate: p.fiscalToDate };
    })
    .filter((p) => p.started);
  const leaseDiff = leases.reduce((t, p) => t + p.bookYear - p.fiscalYear, 0n);
  if (leaseDiff !== 0n) {
    corrections.push({ key: "auto:leases", label: "Sewa (PSAK 116): penyusutan hak guna + bunga dikurangi sewa fiskal", direction: leaseDiff > 0n ? "POSITIVE" : "NEGATIVE", kind: "TEMPORARY", amount: leaseDiff < 0n ? -leaseDiff : leaseDiff, source: { type: "LEASES" } });
  }
  // P&L accounts with their year-to-date amount as income (+) or expense (+): the statement negates other expenses (BEBAN_LAIN).
  const income = [...is.revenue, ...is.other.filter((i) => i.fsLine === "PENDAPATAN_LAIN")].flatMap((i) => i.accounts.map((a) => ({ ...a, fsLine: i.fsLine })));
  const expenses = [...is.cogs, ...is.opex, ...is.other.filter((i) => i.fsLine === "BEBAN_LAIN").map((i) => ({ ...i, accounts: i.accounts.map((a) => ({ ...a, amount: -a.amount })) }))].flatMap((i) => i.accounts);
  const profitAndLoss = [
    ...is.revenue.flatMap((i) => i.accounts.map((a) => ({ code: a.code, name: a.name, section: i.label, amount: a.amount }))),
    ...is.cogs.flatMap((i) => i.accounts.map((a) => ({ code: a.code, name: a.name, section: i.label, amount: -a.amount }))),
    ...is.opex.flatMap((i) => i.accounts.map((a) => ({ code: a.code, name: a.name, section: i.label, amount: -a.amount }))),
    ...is.other.flatMap((i) => i.accounts.map((a) => ({ code: a.code, name: a.name, section: i.label, amount: a.amount }))),
  ];
  const interest = income.filter((x) => x.fsLine === "PENDAPATAN_LAIN" && FINAL_TAXED_INCOME.test(x.name) && x.amount > 0n);
  for (const a of interest) {
    corrections.push({ key: `auto:final:${a.code}`, label: `Penghasilan yang dikenai PPh final: ${a.name}`, direction: "NEGATIVE", kind: "PERMANENT", amount: a.amount, source: { type: "ACCOUNT", code: a.code, name: a.name } });
  }
  // Only the receipts' part of an account (the rest of it is taxed normally); an interest account already leaves whole above.
  for (const [code, x] of finalIncome) {
    if (x.amount <= 0n || interest.some((a) => a.code === code)) continue;
    const label = `Penghasilan yang dipotong PPh final 4(2) oleh pelanggan/penyewa: ${x.name}${revenueCodes.has(code) ? " (juga dikeluarkan dari peredaran bruto Pasal 31E)" : ""}`;
    corrections.push({ key: `auto:final42:${code}`, label, direction: "NEGATIVE", kind: "PERMANENT", amount: x.amount, source: { type: "ACCOUNT", code, name: x.name } });
  }
  for (const c of taxYear?.corrections ?? []) {
    // An accepted suggestion follows its account's year-to-date expense × its %; a typed correction keeps its amount.
    const live = c.suggestion && c.account ? (expenses.find((x) => x.code === c.account!.code)?.amount ?? 0n) : null;
    // A timing difference reverses: when its account turns to income this year (a provision released), the correction turns negative, so
    // what was added back before isn't taxed again. A permanent one is kept at zero, so the accountant still sees (and can remove) it.
    const flip = live !== null && live < 0n && c.kind === "TEMPORARY";
    const amount = live === null ? c.amount : live > 0n ? share(live, c.percent) : flip ? share(-live, c.percent) : 0n;
    const direction = flip ? (c.direction === "POSITIVE" ? "NEGATIVE" : "POSITIVE") : c.direction;
    corrections.push({ key: `manual:${c.id}`, label: c.description, direction, kind: c.kind, amount, source: { type: "MANUAL", id: c.id, code: c.account?.code ?? null, percent: c.suggestion ? c.percent : null } });
  }
  const accepted = new Set((taxYear?.corrections ?? []).flatMap((c) => (c.suggestion ? [c.suggestion] : [])));
  const dismissed = new Set(taxYear?.dismissedSuggestions ?? []);
  const suggestions: Suggestion[] = expenses.flatMap((x) => {
    const c = categoryOf(x.name);
    const key = `nd:${x.code}`;
    // A timing category with income this year (a release) is suggested the other way round.
    const reversal = x.amount < 0n && c?.kind === "TEMPORARY";
    if (!c || (x.amount <= 0n && !reversal) || accepted.has(key) || dismissed.has(key)) return [];
    const amount = reversal ? -x.amount : x.amount;
    return [{ key, code: x.code, name: x.name, amount, category: c.key, label: c.label, percent: c.percent, direction: reversal ? (c.direction === "POSITIVE" ? "NEGATIVE" : "POSITIVE") : c.direction, kind: c.kind, corrected: share(amount, c.percent) }];
  });

  const positive = final ? 0n : corrections.filter((c) => c.direction === "POSITIVE").reduce((t, c) => t + c.amount, 0n);
  const negative = final ? 0n : corrections.filter((c) => c.direction === "NEGATIVE").reduce((t, c) => t + c.amount, 0n);
  const fiscalProfit = profitBeforeTax + positive - negative;
  const carried = final ? { rows: [], used: 0n } : compensate(fiscalProfit, year, taxYear?.losses ?? []);
  const months = await monthsCovered(db, entityId, year, month);
  const tax = corporateTax({ regime, pkp: roundDownThousands(fiscalProfit - carried.used), turnover, months });
  // Last year's fiscal loss from Buku's own December pack (when that year has books), offered until recorded or dismissed.
  let lossSuggestion: { originYear: number; amount: bigint } | null = null;
  const lossKey = `loss:${year - 1}`;
  if (!opts.nested && !final && !(taxYear?.losses ?? []).some((l) => l.originYear === year - 1) && !(taxYear?.dismissedSuggestions ?? []).includes(lossKey)) {
    const booked = await db.journalLine.findFirst({ where: { entityId, date: { gte: dateOnly(year - 1, 1, 1), lte: dateOnly(year - 1, 12, 31) }, entry: { kind: { not: "OPENING" } } }, select: { id: true } });
    const prior = booked ? await taxPack(db, clientId, entityId, year - 1, 12, { nested: true }) : null;
    if (prior && prior.regime === "NORMAL" && prior.fiscalProfit < 0n) lossSuggestion = { originYear: year - 1, amount: -prior.fiscalProfit };
  }

  // ---- kredit pajak ----
  // By masa pajak: December's instalment, paid by 15 January, is a credit of the year that ended. A line without a masa (booked before
  // it existed) still counts by its bank date.
  const instalments = await db.bankTransaction.findMany({
    where: { entityId, taxTag: "PPH_25", direction: "OUT", status: { not: "NEEDS_REVIEW" }, OR: [{ taxMonth: { gte: from, lte: through } }, { taxMonth: null, date: { gte: from, lte: through } }] },
    orderBy: [{ date: "asc" }, { rowNumber: "asc" }],
  });
  const credits: Credit[] = [
    ...instalments.map((t) => ({ key: `bank:${t.id}`, type: "PPH_25" as const, label: t.description, date: t.date, masa: t.taxMonth, amount: -t.amount, accountCode: t.accountCode ?? "", source: { type: "BANK" as const, bankTransactionId: t.id } })),
    ...(taxYear?.credits ?? []).filter((c) => +c.date <= +through).map((c) => ({ key: `manual:${c.id}`, type: c.type, label: c.reference, date: c.date, masa: null, amount: c.amount, accountCode: c.account.code, source: { type: "MANUAL" as const, id: c.id } })),
  ];
  const sum = (xs: Credit[]) => xs.reduce((t, c) => t + c.amount, 0n);
  const settled = final
    ? null
    : settlement({ due: tax.due, instalments: sum(credits.filter((c) => c.type === "PPH_25")), withheld: sum(credits.filter((c) => c.type === "PPH_22" || c.type === "PPH_23" || c.type === "PPH_24")), other: sum(credits.filter((c) => c.type === "OTHER")), months });

  // ---- pajak tangguhan (fixed-asset register and the receivable allowance) ----
  const held = await allowanceBalance(db, clientId, entityId, through);
  const allowance = held > 0n ? held : 0n;
  // (payments − fiscal rent) − (ROU − accumulated − liability) = journalled depreciation + interest − fiscal rent, to date.
  const leaseTemporary = leases.reduce((t, p) => t + p.bookToDate - p.fiscalToDate, 0n);
  const benefitHeld = -(await glBalance(db, clientId, entityId, ACCOUNT_CODES.BENEFIT_LIABILITY, through));
  const employeeBenefits = benefitHeld > 0n ? benefitHeld : 0n;
  const fiscalValue = assets.reduce((t, r) => t + (r.fiscalBookValue ?? 0n), 0n);
  const bookValue = assets.reduce((t, r) => t + r.bookValue, 0n);
  // Only postings dated by the chosen month count; one dated later means the position is booked there.
  const postedCurrent = await postedLines(db, entityId, "CURRENT", year, false, through);
  const postedDeferred = await postedLines(db, entityId, "DEFERRED", year, true, through);
  // The remeasurement in 3920 other than the tax postings' own lines (a loss is a debit).
  const remeasurement = (await glBalance(db, clientId, entityId, ACCOUNT_CODES.BENEFIT_REMEASUREMENT, through)) - (postedDeferred.get(ACCOUNT_CODES.BENEFIT_REMEASUREMENT) ?? 0n);
  const laterPosting: Record<TaxPostingKind, Date | null> = { CURRENT: await postingAfter(db, entityId, "CURRENT", year, through), DEFERRED: await postingAfter(db, entityId, "DEFERRED", year, through) };
  // Under the final regime there is no fiscal profit, so no temporary difference; with no registered assets and no allowance there is none
  // either. Either way a deferred balance booked earlier is brought back to zero.
  const deferredBooked = [ACCOUNT_CODES.DEFERRED_TAX_ASSET, ACCOUNT_CODES.DEFERRED_TAX_LIABILITY].some((c) => (postedDeferred.get(c) ?? 0n) !== 0n);
  const deferred =
    entity.functionalCurrency !== "IDR" ? null
    : (assets.length || allowance > 0n || leases.length || employeeBenefits > 0n) && !final ? temporary(fiscalValue - bookValue, allowance, leaseTemporary, employeeBenefits, remeasurement)
    : deferredBooked ? { assets: 0n, allowance: 0n, leases: 0n, employeeBenefits: 0n, temporaryDifference: 0n, amount: 0n, oci: 0n }
    : null;

  const applicable = packApplies(entity);
  const proposals: Record<TaxPostingKind, ProposalLine[]> = { CURRENT: [], DEFERRED: [] };
  if (applicable && !laterPosting.CURRENT) {
    // The final regime books its own tax (0,5 % of the year's turnover to 8200 against 2145, which the monthly payments clear), less the
    // part customers already withheld (on 8200 with the receipt, never on 2145); a normal-regime posting made before the switch is
    // reversed in the same difference.
    const target = settled ? currentTarget(tax.due, credits, settled.balance) : finalTarget(tax.due - finalWithheld);
    proposals.CURRENT = diff(target, postedCurrent);
  }
  if (applicable && deferred && !laterPosting.DEFERRED) proposals.DEFERRED = deferredDiff(deferred.amount, postedDeferred, deferred.oci);
  return { entity, year, month, through, applicable, regime, taxYearId: taxYear?.id ?? null, profitBeforeTax, turnover, finalWithheld, months, profitAndLoss, corrections, suggestions, positive, negative, fiscalProfit, losses: carried.rows, compensation: carried.used, lossSuggestion, tax, credits, settlement: settled, deferred, proposals, laterPosting };
}

/**
 * The current-tax position: the expense equals the tax due (less credits already expensed on 8100, which the expense already holds), each
 * credit leaves the account it sits on, and the balance is PPh 29 payable (2146) or overpaid (1181). Signed: debit +, credit −; sums to 0.
 */
export function currentTarget(due: bigint, credits: { amount: bigint; accountCode: string }[], balance: bigint): Map<string, bigint> {
  const t = new Map<string, bigint>();
  const add = (code: string, v: bigint) => t.set(code, (t.get(code) ?? 0n) + v);
  add(ACCOUNT_CODES.CURRENT_TAX, due);
  for (const c of credits) {
    if (c.accountCode === ACCOUNT_CODES.CURRENT_TAX) add(ACCOUNT_CODES.CURRENT_TAX, -c.amount);
    else add(c.accountCode, -c.amount);
  }
  if (balance > 0n) add(ACCOUNT_CODES.TAX_PAYABLE_29, -balance);
  if (balance < 0n) add(ACCOUNT_CODES.TAX_OVERPAID, -balance);
  return t;
}

/**
 * PP 55/2022: the final tax on the year's turnover to date is an expense (8200) and a liability (2145) that the monthly payments —
 * filed to 2145 by the tax rules — clear; what is left on 2145 is the month not yet paid. `due` is what the company remits itself (the
 * 0,5 % less what customers withheld); nothing when they withheld it all. Signed: debit +, credit −.
 */
export function finalTarget(due: bigint): Map<string, bigint> {
  return due > 0n ? new Map([[ACCOUNT_CODES.FINAL_TAX, due], [FINAL_TAX_PAYABLE, -due]]) : new Map();
}
export const FINAL_TAX_PAYABLE = "2145";

/**
 * Lines booked by the entity's tax postings of a kind dated by `through`: of that year, or — for deferred balances — of every year up to
 * it.
 */
export async function postedLines(db: Reader, entityId: string, kind: TaxPostingKind, year: number, cumulative: boolean, through: Date): Promise<Map<string, bigint>> {
  const postings = await db.taxPosting.findMany({
    where: { kind, taxYear: { entityId, ...(cumulative ? { year: { lte: year } } : { year }) }, entry: { date: { lte: through } } },
    include: { taxYear: { select: { year: true } }, entry: { include: { lines: { include: { account: { select: { code: true } } } } } } },
  });
  const out = new Map<string, bigint>();
  for (const p of postings) {
    for (const l of p.entry.lines) {
      // Cumulative (deferred): balance-sheet accounts over all years, the expense only for this year.
      if (cumulative && p.taxYear.year !== year && l.account.code === ACCOUNT_CODES.DEFERRED_TAX) continue;
      out.set(l.account.code, (out.get(l.account.code) ?? 0n) + l.debit - l.credit);
    }
  }
  return out;
}

export function diff(target: Map<string, bigint>, posted: Map<string, bigint>): ProposalLine[] {
  const codes = [...new Set([...target.keys(), ...posted.keys()])].sort();
  return codes.map((code) => ({ code, amount: (target.get(code) ?? 0n) - (posted.get(code) ?? 0n) })).filter((l) => l.amount !== 0n);
}

/** Deferred tax: move 1270 / 2320 to the computed balance; the change goes to 8110. */
export function deferredDiff(amount: bigint, posted: Map<string, bigint>, oci = 0n): ProposalLine[] {
  const asset = posted.get(ACCOUNT_CODES.DEFERRED_TAX_ASSET) ?? 0n;
  const liability = posted.get(ACCOUNT_CODES.DEFERRED_TAX_LIABILITY) ?? 0n;
  const dAsset = (amount > 0n ? amount : 0n) - asset;
  const dLiability = (amount < 0n ? amount : 0n) - liability;
  // The remeasurement's tax effect sits in 3920 (a DTA on a loss is credited there).
  const dOci = -oci - (posted.get(ACCOUNT_CODES.BENEFIT_REMEASUREMENT) ?? 0n);
  const lines: ProposalLine[] = [
    { code: ACCOUNT_CODES.DEFERRED_TAX_ASSET, amount: dAsset },
    { code: ACCOUNT_CODES.DEFERRED_TAX_LIABILITY, amount: dLiability },
    { code: ACCOUNT_CODES.BENEFIT_REMEASUREMENT, amount: dOci },
    { code: ACCOUNT_CODES.DEFERRED_TAX, amount: -(dAsset + dLiability + dOci) },
  ];
  return lines.filter((l) => l.amount !== 0n);
}

/** The date of a posting of the kind after `through` (the same year for current tax; any later date for deferred balances), if any. */
export async function postingAfter(db: Reader, entityId: string, kind: TaxPostingKind, year: number, through: Date): Promise<Date | null> {
  const later = await db.taxPosting.findFirst({
    where: { kind, taxYear: { entityId, ...(kind === "CURRENT" ? { year } : { year: { gte: year } }) }, entry: { date: { gt: through } } },
    include: { entry: { select: { date: true } } },
    orderBy: { entry: { date: "desc" } },
  });
  return later?.entry.date ?? null;
}

function temporary(assets: bigint, allowance: bigint, leases: bigint, employeeBenefits: bigint, remeasurement: bigint) {
  const temporaryDifference = assets + allowance + leases + employeeBenefits;
  return { assets, allowance, leases, employeeBenefits, temporaryDifference, amount: deferredTax(temporaryDifference), oci: deferredTax(remeasurement) };
}

/** Debit balance of an account of the entity at a date (0 when the client has no such account). */
export async function glBalance(db: Reader, clientId: string, entityId: string, code: string, asOf: Date) {
  const acc = await db.account.findFirst({ where: { clientId, code }, select: { id: true } });
  if (!acc) return 0n;
  const s = await db.journalLine.aggregate({ where: { entityId, accountId: acc.id, date: { lte: asOf } }, _sum: { debit: true, credit: true } });
  return (s._sum.debit ?? 0n) - (s._sum.credit ?? 0n);
}
