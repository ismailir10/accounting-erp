import type { Db } from "@/lib/db";
import { recordEvent } from "@/lib/audit";
import { financialYear, fiscalEndMonth, fiscalLabel } from "@/lib/fiscal";
import { formatMonthShort, periodBounds } from "@/lib/format";
import { formatMoney, MoneyError, parseMoney } from "@/lib/money";
import type { AccountType } from "@/lib/generated/prisma/enums";
import { isMixed, scopeCurrency, scopeEntities } from "@/lib/reports/fx";
import type { Scope } from "@/lib/reports/ledger";

/**
 * Anggaran (budget vs actual). A budget is planning data: one amount per company, income or expense account and month, in minor units of
 * the company's currency on the account's normal side (revenue and expense both positive, as the Laba Rugi shows them). It is never posted
 * and never feeds a statement; the comparison reads the ledger at request time (accounting-rules 1). Edited per financial year.
 */
export class BudgetError extends Error {}

const PL: AccountType[] = ["PENDAPATAN", "BEBAN"];
export type BudgetMonth = { year: number; month: number; key: string; label: string };

/** The twelve months of the financial year holding `month` of `year`. */
export function yearMonths(endMonth: number, year: number, month: number): BudgetMonth[] {
  const fy = financialYear(endMonth, year, month);
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(fy.start.getUTCFullYear(), fy.start.getUTCMonth() + i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    return { year: y, month: m, key: `${y}-${String(m).padStart(2, "0")}`, label: formatMonthShort(y, m) };
  });
}

/** Income and expense of each account per month between two dates, on the normal side (revenue credit − debit, expense debit − credit). */
async function actuals(db: Db, entityIds: string[], from: Date, to: Date) {
  const lines = await db.journalLine.findMany({
    where: { entityId: { in: entityIds }, date: { gte: from, lte: to }, account: { type: { in: PL } } },
    select: { accountId: true, date: true, debit: true, credit: true, account: { select: { type: true } } },
  });
  const out = new Map<string, bigint>(); // `${accountId}|${YYYY-MM}`
  for (const l of lines) {
    const key = `${l.accountId}|${l.date.toISOString().slice(0, 7)}`;
    out.set(key, (out.get(key) ?? 0n) + (l.account.type === "PENDAPATAN" ? l.credit - l.debit : l.debit - l.credit));
  }
  return out;
}

export type GridRow = { accountId: string; code: string; name: string; type: AccountType; budget: (bigint | null)[]; actual: bigint[]; lastYear: bigint[] };

/**
 * The editor's grid for one company and financial year: every income and expense account with a budget this year or an actual this year
 * or last, each with its twelve budget cells, this year's actuals and last year's (for *Salin realisasi tahun lalu*).
 */
export async function budgetGrid(db: Db, input: { clientId: string; entityId: string; year: number; month: number }) {
  const entity = await db.entity.findFirst({ where: { id: input.entityId, clientId: input.clientId }, select: { id: true, functionalCurrency: true } });
  if (!entity) throw new BudgetError("Pilih perusahaan.");
  const endMonth = await fiscalEndMonth(db, input.clientId);
  const months = yearMonths(endMonth, input.year, input.month);
  const last = yearMonths(endMonth, input.year - 1, input.month);
  const fyStart = periodBounds(months[0].year, months[0].month).start;
  const fyEnd = periodBounds(months[11].year, months[11].month).end;
  const [accounts, budgets, now, before] = await Promise.all([
    db.account.findMany({ where: { clientId: input.clientId, type: { in: PL } }, select: { id: true, code: true, name: true, type: true }, orderBy: { code: "asc" } }),
    db.budget.findMany({ where: { entityId: entity.id, OR: months.map((m) => ({ year: m.year, month: m.month })) } }),
    actuals(db, [entity.id], fyStart, fyEnd),
    actuals(db, [entity.id], periodBounds(last[0].year, last[0].month).start, periodBounds(last[11].year, last[11].month).end),
  ]);
  const cell = new Map(budgets.map((b) => [`${b.accountId}|${b.year}-${String(b.month).padStart(2, "0")}`, b.amount]));
  const rows: GridRow[] = accounts
    .map((a) => ({
      accountId: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      budget: months.map((m) => cell.get(`${a.id}|${m.key}`) ?? null),
      actual: months.map((m) => now.get(`${a.id}|${m.key}`) ?? 0n),
      lastYear: last.map((m) => before.get(`${a.id}|${m.key}`) ?? 0n),
    }))
    .filter((r) => r.budget.some((v) => v !== null) || r.actual.some((v) => v !== 0n) || r.lastYear.some((v) => v !== 0n));
  return { months, currency: entity.functionalCurrency, fiscal: fiscalLabel(financialYear(endMonth, input.year, input.month)), rows, accounts };
}

export type BudgetCellInput = { accountCode: string; key: string; amount: string };

/**
 * Save typed cells for one company and financial year: a number sets the month's budget, an empty cell removes it; cells not sent are left
 * as they are. Amounts are typed in major units of the company's currency (lib/money.ts `parseMoney`). One `BUDGET` event in Riwayat.
 */
export async function saveBudget(db: Db, input: { clientId: string; entityId: string; year: number; month: number; cells: BudgetCellInput[]; actorId?: string | null }) {
  const entity = await db.entity.findFirst({ where: { id: input.entityId, clientId: input.clientId }, select: { id: true, firmId: true, name: true, functionalCurrency: true } });
  if (!entity) throw new BudgetError("Pilih perusahaan.");
  if (input.cells.length > 12 * 400) throw new BudgetError("Terlalu banyak sel sekaligus.");
  const endMonth = await fiscalEndMonth(db, input.clientId);
  const months = new Map(yearMonths(endMonth, input.year, input.month).map((m) => [m.key, m]));
  const accounts = new Map((await db.account.findMany({ where: { clientId: input.clientId, type: { in: PL } }, select: { id: true, code: true, name: true } })).map((a) => [a.code, a]));
  const parsed = input.cells.map((c) => {
    const account = accounts.get(c.accountCode);
    if (!account) throw new BudgetError(`Akun ${c.accountCode} bukan akun pendapatan atau beban klien ini.`);
    const m = months.get(c.key);
    if (!m) throw new BudgetError("Anggaran hanya untuk bulan-bulan tahun buku yang dipilih.");
    let amount: bigint | null = null;
    if (c.amount.trim()) {
      try {
        amount = parseMoney(c.amount, entity.functionalCurrency);
      } catch (e) {
        if (e instanceof MoneyError) throw new BudgetError(`${account.code} ${m.label}: ${e.message}`);
        throw e;
      }
    }
    return { account, m, amount };
  });
  return db.$transaction(async (tx) => {
    let set = 0;
    let removed = 0;
    for (const { account, m, amount } of parsed) {
      const where = { entityId_accountId_year_month: { entityId: entity.id, accountId: account.id, year: m.year, month: m.month } };
      if (amount === null) removed += (await tx.budget.deleteMany({ where: where.entityId_accountId_year_month })).count;
      else {
        await tx.budget.upsert({ where, create: { firmId: entity.firmId, clientId: input.clientId, entityId: entity.id, accountId: account.id, year: m.year, month: m.month, amount, updatedById: input.actorId ?? null }, update: { amount, updatedById: input.actorId ?? null } });
        set++;
      }
    }
    const year = await tx.budget.aggregate({ where: { entityId: entity.id, OR: [...months.values()].map((m) => ({ year: m.year, month: m.month })) }, _count: true });
    const first = [...months.values()][0];
    await recordEvent(tx, {
      clientId: input.clientId,
      entityId: entity.id,
      kind: "BUDGET",
      subject: `budget:${entity.id}:${first.key}`,
      summary: `Anggaran ${entity.name} tahun buku mulai ${first.label}: ${set} sel diisi${removed ? `, ${removed} dikosongkan` : ""} (${year._count} sel beranggaran)`,
      after: { set, removed },
      actorId: input.actorId,
    });
    return { set, removed };
  });
}

export type VsRow = { code: string | null; label: string; kind: "account" | "total"; type: AccountType | null; month: [bigint, bigint]; ytd: [bigint, bigint] };

/**
 * Anggaran vs realisasi for a scope (one company, or a group in one currency): the month and the financial year to date, per income and
 * expense account with a budget or an actual, the totals per type and the net result. Values are [budget, actual] on the normal side.
 */
export async function budgetVsActual(db: Db, scope: Scope, year: number, month: number) {
  const entities = await scopeEntities(db, scope.entityIds);
  if (isMixed(entities)) throw new BudgetError("Anggaran grup dengan mata uang berbeda tidak dijumlahkan. Pilih satu perusahaan.");
  const endMonth = await fiscalEndMonth(db, scope.clientId);
  const months = yearMonths(endMonth, year, month);
  const through = months.slice(0, months.findIndex((m) => m.year === year && m.month === month) + 1);
  const key = `${year}-${String(month).padStart(2, "0")}`;
  const [accounts, budgets, act] = await Promise.all([
    db.account.findMany({ where: { clientId: scope.clientId, type: { in: PL } }, select: { id: true, code: true, name: true, type: true }, orderBy: { code: "asc" } }),
    db.budget.findMany({ where: { entityId: { in: scope.entityIds }, OR: through.map((m) => ({ year: m.year, month: m.month })) } }),
    actuals(db, scope.entityIds, periodBounds(through[0].year, through[0].month).start, periodBounds(year, month).end),
  ]);
  const sum = (pairs: [string, bigint][], f: (k: string) => boolean) => pairs.filter(([k]) => f(k)).reduce((s, [, v]) => s + v, 0n);
  const budgetPairs = budgets.map((b) => [`${b.accountId}|${b.year}-${String(b.month).padStart(2, "0")}`, b.amount] as [string, bigint]);
  const actualPairs = [...act.entries()];
  const used = new Set([...budgetPairs, ...actualPairs].map(([k]) => k.split("|")[0]));
  const rows: VsRow[] = [];
  const totals: Record<"PENDAPATAN" | "BEBAN", { month: [bigint, bigint]; ytd: [bigint, bigint] }> = { PENDAPATAN: { month: [0n, 0n], ytd: [0n, 0n] }, BEBAN: { month: [0n, 0n], ytd: [0n, 0n] } };
  for (const type of ["PENDAPATAN", "BEBAN"] as const) {
    for (const a of accounts.filter((x) => x.type === type)) {
      const of = (pairs: [string, bigint][], monthOnly: boolean) => sum(pairs, (k) => k.startsWith(`${a.id}|`) && (!monthOnly || k.endsWith(key)));
      const r: VsRow = { code: a.code, label: a.name, kind: "account", type, month: [of(budgetPairs, true), of(actualPairs, true)], ytd: [of(budgetPairs, false), of(actualPairs, false)] };
      if (!used.has(a.id)) continue; // kept when its months net to zero: the activity is still worth seeing
      rows.push(r);
      totals[type].month = [totals[type].month[0] + r.month[0], totals[type].month[1] + r.month[1]];
      totals[type].ytd = [totals[type].ytd[0] + r.ytd[0], totals[type].ytd[1] + r.ytd[1]];
    }
    rows.push({ code: null, label: type === "PENDAPATAN" ? "Jumlah pendapatan" : "Jumlah beban", kind: "total", type, ...totals[type] });
  }
  const p = totals.PENDAPATAN;
  const b = totals.BEBAN;
  rows.push({ code: null, label: "Laba (rugi) bersih", kind: "total", type: null, month: [p.month[0] - b.month[0], p.month[1] - b.month[1]], ytd: [p.ytd[0] - b.ytd[0], p.ytd[1] - b.ytd[1]] });
  return { rows, currency: scopeCurrency(entities), hasBudget: budgets.length > 0, fiscal: fiscalLabel(financialYear(endMonth, year, month)) };
}

/** Whether a difference is good news: more income, or less cost, than planned; the net result likewise. */
export const favourable = (row: Pick<VsRow, "type">, budget: bigint, actual: bigint) => (row.type === "BEBAN" ? actual <= budget : actual >= budget);

/** A typed cell's text for an amount (Indonesian notation, no symbol), as the editor shows it. */
export const cellText = (v: bigint | null, currency: string) => (v === null ? "" : formatMoney(v, currency, { bare: true }));
