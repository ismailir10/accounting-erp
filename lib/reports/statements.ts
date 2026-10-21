import type { Db } from "@/lib/db";
import type { Account } from "@/lib/generated/prisma/client";
import { ACCOUNT_CODES, FS_LINES, type FsLine } from "@/lib/coa/template";
import { fiscalEndMonth, fiscalYearStart } from "@/lib/fiscal";
import { isMixed, scopeEntities } from "@/lib/reports/fx";
import { balanceSheet, sumByAccount, type Scope } from "@/lib/reports/ledger";

/**
 * The statements beyond Laba Rugi and Neraca (accounting-rules 1): other comprehensive income, changes in equity and the indirect cash
 * flow, all from the GL movements of the period, so opening + movements = closing by construction and each is checked against the Neraca.
 * Single-currency scopes only (a mixed scope's translation isn't split into movements).
 */

export class MixedScopeError extends Error {
  constructor() {
    super("Laporan ini hanya untuk cakupan satu mata uang. Pilih satu entitas atau entitas dengan mata uang yang sama.");
  }
}

const C = ACCOUNT_CODES;
const OCI_LINES: FsLine[] = ["PKL_IMBALAN_KERJA", "SELISIH_PENJABARAN"];

type Movement = { account: Account; debit: bigint; credit: bigint; net: bigint };

/**
 * Movements per account in [from, to]. `opening`: "exclude" leaves out Saldo Awal entries (kind OPENING), "only" keeps just them — books
 * that start inside the year carry their opening balance in such an entry, which is a starting point, not a flow of the year.
 */
async function movements(db: Db, scope: Scope, from: Date | undefined, to: Date, opening: "all" | "exclude" | "only" = "all"): Promise<Movement[]> {
  const accounts = await db.account.findMany({ where: { clientId: scope.clientId }, orderBy: { code: "asc" } });
  const all = new Map((await sumByAccount(db, scope, { from, to })).map((r) => [r.accountId, r]));
  const open = new Map(
    opening === "all"
      ? []
      : (
          await db.journalLine.groupBy({ by: ["accountId"], where: { entityId: { in: scope.entityIds }, date: { gte: from, lte: to }, entry: { kind: "OPENING" } }, _sum: { debit: true, credit: true } })
        ).map((r) => [r.accountId, { debit: r._sum.debit ?? 0n, credit: r._sum.credit ?? 0n }]),
  );
  return accounts.map((a) => {
    const t = all.get(a.id);
    const o = open.get(a.id);
    const debit = opening === "only" ? (o?.debit ?? 0n) : (t?.debit ?? 0n) - (opening === "exclude" ? (o?.debit ?? 0n) : 0n);
    const credit = opening === "only" ? (o?.credit ?? 0n) : (t?.credit ?? 0n) - (opening === "exclude" ? (o?.credit ?? 0n) : 0n);
    return { account: a, debit, credit, net: debit - credit };
  });
}

/**
 * Balances at the start of the financial year (`rows`): everything to the day before it, plus the year's Saldo Awal when it opens the scope's
 * books (nothing of the scope dated before it; `openedOn` is then its date). A Saldo Awal of a company joining the scope later in the year —
 * a CV opened in May beside a PT kept since January — is not the group's opening: it comes back apart (`joined`), so the opening row stays
 * the group's position at its date and the year's movements stay the year's.
 */
async function yearOpening(db: Db, scope: Scope, from: Date, to: Date) {
  const before = new Date(+from - 86_400_000);
  const [prior, openings] = await Promise.all([
    movements(db, scope, undefined, before),
    db.journalEntry.findMany({ where: { entityId: { in: scope.entityIds }, kind: "OPENING", date: { gte: from, lte: to } }, orderBy: { date: "asc" }, select: { id: true, date: true } }),
  ]);
  const first = openings[0]?.date ?? null;
  const opensBooks = first !== null && !(await db.journalLine.findFirst({ where: { entityId: { in: scope.entityIds }, date: { lt: first } }, select: { id: true } }));
  const atStart = openings.filter((o) => opensBooks && +o.date === +first!).map((o) => o.id);
  const later = openings.filter((o) => !atStart.includes(o.id)).map((o) => o.id);
  const sums = async (entryIds: string[]) =>
    entryIds.length
      ? new Map((await db.journalLine.groupBy({ by: ["accountId"], where: { entryId: { in: entryIds } }, _sum: { debit: true, credit: true } })).map((r) => [r.accountId, { debit: r._sum.debit ?? 0n, credit: r._sum.credit ?? 0n }]))
      : new Map<string, { debit: bigint; credit: bigint }>();
  const [start, joinedSums] = await Promise.all([sums(atStart), sums(later)]);
  const plus = (m: Movement, x?: { debit: bigint; credit: bigint }) => (x ? { ...m, debit: m.debit + x.debit, credit: m.credit + x.credit, net: m.net + x.debit - x.credit } : m);
  const joined = prior.map((m) => {
    const x = joinedSums.get(m.account.id);
    return { account: m.account, debit: x?.debit ?? 0n, credit: x?.credit ?? 0n, net: (x?.debit ?? 0n) - (x?.credit ?? 0n) };
  });
  const joinedOn = later.length ? openings.find((o) => o.id === later[0])!.date : null;
  return { rows: prior.map((m) => plus(m, start.get(m.account.id))), joined, joinedOn, openedOn: opensBooks ? first : null };
}

async function single(db: Db, scope: Scope) {
  if (isMixed(await scopeEntities(db, scope.entityIds))) throw new MixedScopeError();
}

export type OciItem = { fsLine: FsLine; label: string; amount: bigint; accounts: { code: string; name: string; amount: bigint }[] };

/** Other comprehensive income of [from, to]: the credit movement of the PKL equity lines. */
export async function otherComprehensiveIncome(db: Db, scope: Scope, from: Date, to: Date): Promise<{ items: OciItem[]; total: bigint }> {
  const rows = (await movements(db, scope, from, to, "exclude")).filter((m) => OCI_LINES.includes(m.account.fsLine as FsLine) && m.net !== 0n);
  const items = OCI_LINES.map((fs) => {
    const accs = rows.filter((r) => r.account.fsLine === fs);
    return { fsLine: fs, label: FS_LINES[fs].label, amount: accs.reduce((t, r) => t - r.net, 0n), accounts: accs.map((r) => ({ code: r.account.code, name: r.account.name, amount: -r.net })) };
  }).filter((i) => i.accounts.length);
  return { items, total: items.reduce((t, i) => t + i.amount, 0n) };
}

// ─── Laporan Perubahan Ekuitas ────────────────────────────────────────────────

export const EQUITY_ROWS = ["opening", "joined", "profit", "oci", "capital", "prive", "retained", "closing"] as const;
export type EquityRow = (typeof EQUITY_ROWS)[number];
export const EQUITY_ROW_LABEL: Record<EquityRow, string> = {
  opening: "Saldo awal",
  joined: "Ekuitas entitas yang bergabung (saldo awal)",
  profit: "Laba (rugi) tahun berjalan",
  oci: "Penghasilan komprehensif lain",
  capital: "Setoran (penarikan) modal",
  prive: "Prive",
  retained: "Dividen dan koreksi saldo laba",
  closing: "Saldo akhir",
};
const EQUITY_LINES: FsLine[] = ["MODAL", "SALDO_LABA", "SELISIH_SALDO_AWAL", "PRIVE", "SELISIH_PENJABARAN", "PKL_IMBALAN_KERJA"];
/** The row a year's movement of an equity line goes to (profit itself comes from the income statement). */
const ROW_OF: Record<string, EquityRow> = { MODAL: "capital", SALDO_LABA: "retained", SELISIH_SALDO_AWAL: "retained", PRIVE: "prive", SELISIH_PENJABARAN: "oci", PKL_IMBALAN_KERJA: "oci" };

export type EquityChanges = {
  from: Date;
  to: Date;
  /** The date of the opening balance: the year's Saldo Awal when the books start inside the year, else the previous financial-year end. */
  openedAt: Date;
  /** Each column's accounts (for drill-down to their ledgers). */
  columns: { fsLine: FsLine; label: string; codes: string[] }[];
  /** values[row][column], credit positive; the last column of each row is not included — `totals[row]` is the row total. */
  values: Record<EquityRow, bigint[]>;
  totals: Record<EquityRow, bigint>;
  /** Neraca equity at `to` (should equal totals.closing). */
  balanceSheetEquity: bigint;
};

/** Changes in equity from the start of the financial year holding `to` (lib/fiscal.ts). Prior-year profit sits in Saldo laba at the opening. */
export async function equityChanges(db: Db, scope: Scope, to: Date): Promise<EquityChanges> {
  await single(db, scope);
  const from = fiscalYearStart(await fiscalEndMonth(db, scope.clientId), to);
  const before = new Date(+from - 86_400_000);
  const [start, moved, bs] = await Promise.all([yearOpening(db, scope, from, to), movements(db, scope, from, to, "exclude"), balanceSheet(db, scope, to)]);
  const opening = start.rows;
  const zero = () => EQUITY_LINES.map(() => 0n);
  const values = Object.fromEntries(EQUITY_ROWS.map((r) => [r, zero()])) as Record<EquityRow, bigint[]>;
  const col = (a: Account) => EQUITY_LINES.indexOf(a.fsLine as FsLine);
  for (const [row, ms] of [["opening", opening], ["joined", start.joined]] as const) {
    for (const m of ms) {
      // Every P&L account up to last year is last year's (and earlier) profit, folded into Saldo laba.
      if (m.account.type === "PENDAPATAN" || m.account.type === "BEBAN") values[row][1] -= m.net;
      else if (m.account.type === "EKUITAS" && col(m.account) >= 0) values[row][col(m.account)] -= m.net;
    }
  }
  for (const m of moved) {
    if (m.account.type !== "EKUITAS" || col(m.account) < 0 || m.net === 0n) continue;
    values[ROW_OF[m.account.fsLine]][col(m.account)] -= m.net;
  }
  // Profit of the year after the opening (a Saldo Awal entry carries no P&L of the year, so the statement's YTD profit is the same).
  values.profit[1] = moved.filter((m) => m.account.type === "PENDAPATAN" || m.account.type === "BEBAN").reduce((t, m) => t - m.net, 0n);
  values.closing = EQUITY_LINES.map((_, i) => EQUITY_ROWS.slice(0, -1).reduce((t, r) => t + values[r][i], 0n));
  const used = EQUITY_LINES.map((fs, i) => ({ fs, i })).filter(({ fs, i }) => fs === "MODAL" || fs === "SALDO_LABA" || EQUITY_ROWS.some((r) => values[r][i] !== 0n));
  const pick = (xs: bigint[]) => used.map(({ i }) => xs[i]);
  const picked = Object.fromEntries(EQUITY_ROWS.map((r) => [r, pick(values[r])])) as Record<EquityRow, bigint[]>;
  const totals = Object.fromEntries(EQUITY_ROWS.map((r) => [r, picked[r].reduce((t, v) => t + v, 0n)])) as Record<EquityRow, bigint>;
  const codesOf = (fs: FsLine) => [...new Set([...opening, ...start.joined, ...moved].filter((m) => m.account.fsLine === fs && m.net !== 0n).map((m) => m.account.code))].sort();
  return { from, to, openedAt: start.openedOn ?? before, columns: used.map(({ fs }) => ({ fsLine: fs, label: FS_LINES[fs].label, codes: codesOf(fs) })), values: picked, totals, balanceSheetEquity: bs.totals.equity };
}

// ─── Mutasi aset tetap (CALK) ─────────────────────────────────────────────────

export type AssetMovementRow = { code: string; name: string; kind: "COST" | "ACCUMULATED"; opening: bigint; additions: bigint; deductions: bigint; closing: bigint };
export type AssetMovement = { openedAt: Date; to: Date; rows: AssetMovementRow[] };

/**
 * The carrying amount's reconciliation (PSAK 216 / SAK EP): every account on the Aset tetap and Akumulasi penyusutan lines, from the year's
 * opening (the previous year end plus the year's Saldo Awal, as in the changes in equity and the cash flow) to `to`. Signed as on the Neraca:
 * cost positive, accumulation negative; additions are debits to cost and credits to the accumulation (the depreciation charge), deductions the
 * other side, so opening + additions + deductions = closing on every row and the rows add up to the Neraca's book value.
 */
export async function fixedAssetMovement(db: Db, scope: Scope, to: Date): Promise<AssetMovement> {
  await single(db, scope);
  const from = fiscalYearStart(await fiscalEndMonth(db, scope.clientId), to);
  const [start, movedAll] = await Promise.all([yearOpening(db, scope, from, to), movements(db, scope, from, to, "exclude")]);
  // The Neraca's own test: an asset account on those lines (a mistyped account is shown by its type, not here).
  const isLine = (a: Account) => a.type === "ASET" && (a.fsLine === "ASET_TETAP" || a.fsLine === "AKUM_PENYUSUTAN");
  // A manual entry reversed inside the period (*Balik jurnal*) was neither a purchase nor a disposal: both entries leave the columns
  // (they cancel on every account, so the closing balance is the same).
  const pairs = await db.journalEntry.findMany({
    where: { entityId: { in: scope.entityIds }, date: { gte: from, lte: to }, reversesId: { not: null }, reverses: { date: { gte: from, lte: to } } },
    select: { id: true, reversesId: true },
  });
  const reversed = pairs.length
    ? new Map((await db.journalLine.groupBy({ by: ["accountId"], where: { entryId: { in: pairs.flatMap((p) => [p.id, p.reversesId!]) } }, _sum: { debit: true, credit: true } })).map((r) => [r.accountId, { debit: r._sum.debit ?? 0n, credit: r._sum.credit ?? 0n }]))
    : new Map<string, { debit: bigint; credit: bigint }>();
  const moved = movedAll.map((m) => {
    const x = reversed.get(m.account.id);
    return x ? { ...m, debit: m.debit - x.debit, credit: m.credit - x.credit } : m;
  });
  const rows: AssetMovementRow[] = [];
  start.rows.forEach((o, i) => {
    // A company joining the scope in the year brings its assets in as additions (and its accumulation as a charge).
    const j = start.joined[i];
    const m = { debit: moved[i].debit + j.debit, credit: moved[i].credit + j.credit };
    if (!isLine(o.account) || (o.net === 0n && m.debit === 0n && m.credit === 0n && movedAll[i].net === 0n && j.net === 0n)) return;
    const cost = o.account.fsLine === "ASET_TETAP";
    rows.push({
      code: o.account.code,
      name: o.account.name,
      kind: cost ? "COST" : "ACCUMULATED",
      opening: o.net,
      additions: cost ? m.debit : -m.credit,
      deductions: cost ? -m.credit : m.debit,
      closing: o.net + j.net + movedAll[i].net,
    });
  });
  rows.sort((a, b) => (a.kind === b.kind ? a.code.localeCompare(b.code) : a.kind === "COST" ? -1 : 1));
  return { openedAt: start.openedOn ?? new Date(+from - 86_400_000), to, rows };
}

// ─── Laporan Arus Kas (tidak langsung) ────────────────────────────────────────

export type CashSection = "OPERATING" | "INVESTING" | "FINANCING";
export type CashItem = { key: string; label: string; amount: bigint; codes: string[] };
export type CashFlow = {
  from: Date;
  to: Date;
  /** The date of the opening cash: the year's Saldo Awal when the books start inside the year, else the previous financial-year end. */
  openedAt: Date;
  netProfit: bigint;
  operating: CashItem[];
  investing: CashItem[];
  financing: CashItem[];
  totals: Record<CashSection, bigint>;
  net: bigint;
  /** Pengaruh perubahan kurs terhadap kas (PSAK 207): the month-end revaluation of foreign-currency cash, outside the three sections. */
  fxEffect: bigint;
  openingCash: bigint;
  /** Cash a company brought when it joined the scope in the year (its Saldo Awal, dated `joinedOn`): not a flow of the group's. */
  joinedCash: bigint;
  joinedOn: Date | null;
  closingCash: bigint;
};

const LEASE_CODES = new Set<string>([C.ROU_ASSET, C.LEASE_CURRENT, C.LEASE_NON_CURRENT]);
const DEFERRED_TAX_CODES = new Set<string>([C.DEFERRED_TAX_ASSET, C.DEFERRED_TAX_LIABILITY]);

/**
 * Where a balance-sheet account's movement goes in the cash flow, and under which line; null for cash itself. An intercompany account
 * (1190) is a loan given when it ends the period with a debit balance (`lentOut`, investing) and a loan received otherwise (financing).
 */
export function cashLine(a: Pick<Account, "code" | "fsLine" | "isIntercompany">, lentOut = false): { section: CashSection; key: string; label: string } | null {
  if (a.fsLine === "KAS_SETARA_KAS") return null;
  if (a.isIntercompany) return lentOut ? { section: "INVESTING", key: "INTERCOMPANY_LENT", label: "Pinjaman kepada pihak berelasi" } : { section: "FINANCING", key: "INTERCOMPANY", label: "Pinjaman dari pihak berelasi" };
  if (LEASE_CODES.has(a.code)) return { section: "FINANCING", key: "LEASES", label: "Pembayaran liabilitas sewa" };
  if (a.code === C.ROU_ACCUMULATED) return { section: "OPERATING", key: "AKUM_PENYUSUTAN", label: "Penyusutan dan amortisasi" };
  if (a.code === C.BENEFIT_LIABILITY) return { section: "OPERATING", key: "BENEFITS", label: "Liabilitas imbalan kerja" };
  if (DEFERRED_TAX_CODES.has(a.code)) return { section: "OPERATING", key: "DEFERRED_TAX", label: "Pajak tangguhan" };
  const fs = a.fsLine as FsLine;
  const label = FS_LINES[fs]?.label ?? fs;
  switch (fs) {
    case "AKUM_PENYUSUTAN":
      return { section: "OPERATING", key: fs, label: "Penyusutan dan amortisasi" };
    case "ASET_TETAP":
      return { section: "INVESTING", key: fs, label: "Aset tetap" };
    case "ASET_TIDAK_LANCAR_LAIN":
      return { section: "INVESTING", key: fs, label };
    case "UTANG_BANK":
    case "UTANG_JANGKA_PANJANG":
      return { section: "FINANCING", key: fs, label };
    case "MODAL":
      return { section: "FINANCING", key: fs, label: "Setoran (penarikan) modal" };
    case "PRIVE":
      return { section: "FINANCING", key: fs, label: "Prive" };
    case "SALDO_LABA":
    case "SELISIH_SALDO_AWAL":
      return { section: "FINANCING", key: "SALDO_LABA", label: "Dividen dan koreksi saldo laba" };
    case "PKL_IMBALAN_KERJA":
    case "SELISIH_PENJABARAN":
      return { section: "OPERATING", key: "OCI", label: "Penghasilan komprehensif lain (non-kas)" };
    default:
      return { section: "OPERATING", key: fs, label };
  }
}

/**
 * Cash collected by `to` against each proceeds line of a disposal entry (line id → amount). Nothing links a receipt to a disposal — the bank line is
 * just classified to the same account — so the account is read as a first-in-first-out queue of open debits (its opening balance and every later debit,
 * disposals included): each credit clears the oldest open debit first, and only the cash part of a credit counts as collected. The cash part is what
 * reached the bank — a bank line's amount (a withheld tax leg on the same credit is not cash), or the cash debit of a typed entry — and is spent once per
 * bank line or entry however many rows credit the account. A later debit posted for the same bank line (a reclass away from the account) takes its
 * earlier clearing back, so the receivable is open again. Conservative by construction: a collection is credited to the disposal only after every older
 * debit in the account has been cleared, and later debits never take from it.
 */
export async function collectedProceeds(db: Db, entityIds: string[], to: Date, proceedsLines: { id: string; entryId: string; account: { code: string } }[]) {
  const collected = new Map<string, bigint>();
  if (!proceedsLines.length) return collected;
  const codes = [...new Set(proceedsLines.map((l) => l.account.code))];
  const rows = await db.journalLine.findMany({
    where: { entityId: { in: entityIds }, date: { lte: to }, account: { code: { in: codes } } },
    select: { id: true, entryId: true, entityId: true, debit: true, credit: true, account: { select: { code: true } }, entry: { select: { bankTransactionId: true } } },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });
  const tagged = new Set(proceedsLines.map((l) => l.id));
  const creditEntries = [...new Set(rows.filter((r) => r.credit > r.debit).map((r) => r.entryId))];
  const bankIds = [...new Set(rows.map((r) => r.entry.bankTransactionId).filter((x): x is string => x !== null))];
  // Cash available to credits, spent once: a bank line by its amount, any other entry by the debits it posts to cash accounts.
  const cash = new Map<string, bigint>();
  for (const b of await db.bankTransaction.findMany({ where: { id: { in: bankIds } }, select: { id: true, amount: true } })) cash.set(`b:${b.id}`, b.amount < 0n ? -b.amount : b.amount);
  for (const c of await db.journalLine.findMany({ where: { entryId: { in: creditEntries }, debit: { gt: 0n }, account: { fsLine: "KAS_SETARA_KAS" }, entry: { bankTransactionId: null } }, select: { entryId: true, debit: true } })) {
    cash.set(`e:${c.entryId}`, (cash.get(`e:${c.entryId}`) ?? 0n) + c.debit);
  }
  const queues = new Map<string, { tag: string | null; left: bigint }[]>();
  const surplus = new Map<string, bigint>(); // credits with nothing open yet (an advance): they absorb the next debit
  const surplusCash = new Map<string, bigint>(); // the cash part of that advance: a disposal it absorbs was collected by it
  const cleared = new Map<string, { key: string; tag: string | null; amount: bigint; cash: bigint; advance: boolean }[]>(); // per bank line, to take back
  for (const r of rows) {
    const key = `${r.entityId}:${r.account.code}`;
    const bankId = r.entry.bankTransactionId;
    const q = queues.get(key) ?? [];
    queues.set(key, q);
    let net = r.debit - r.credit;
    if (net > 0n && bankId) {
      // A reclass away from this account: what this bank line cleared here is open again (latest clearing first).
      const trail = cleared.get(bankId) ?? [];
      for (let i = trail.length - 1; i >= 0 && net > 0n; i--) {
        const c = trail[i];
        if (c.key !== key) continue;
        const undo = c.amount < net ? c.amount : net;
        const nonCash = c.amount - c.cash;
        const cashBack = undo > nonCash ? undo - nonCash : 0n;
        if (c.advance) {
          surplus.set(key, (surplus.get(key) ?? 0n) - undo);
          surplusCash.set(key, (surplusCash.get(key) ?? 0n) - cashBack);
        }
        else {
          q.unshift({ tag: c.tag, left: undo });
          if (c.tag && cashBack > 0n) collected.set(c.tag, (collected.get(c.tag) ?? 0n) - cashBack);
        }
        cash.set(`b:${bankId}`, (cash.get(`b:${bankId}`) ?? 0n) + cashBack);
        c.amount -= undo;
        c.cash -= cashBack;
        net -= undo;
        if (c.amount === 0n) trail.splice(i, 1);
      }
    }
    if (net > 0n) {
      const adv = surplus.get(key) ?? 0n;
      const absorbed = adv < net ? adv : net;
      surplus.set(key, adv - absorbed);
      // A deposit received before the disposal (a buyer's advance) collected that much of its proceeds.
      const advCash = surplusCash.get(key) ?? 0n;
      const cashAbsorbed = advCash < absorbed ? advCash : absorbed;
      surplusCash.set(key, advCash - cashAbsorbed);
      if (tagged.has(r.id) && cashAbsorbed > 0n) collected.set(r.id, (collected.get(r.id) ?? 0n) + cashAbsorbed);
      net -= absorbed;
      if (net > 0n) q.push({ tag: tagged.has(r.id) ? r.id : null, left: net });
    } else if (net < 0n) {
      let credit = -net;
      const cashKey = bankId ? `b:${bankId}` : `e:${r.entryId}`;
      let cashLeft = cash.get(cashKey) ?? 0n;
      if (cashLeft > credit) cashLeft = credit;
      cash.set(cashKey, (cash.get(cashKey) ?? 0n) - cashLeft);
      const note = (tag: string | null, amount: bigint, cashPart: bigint, advance: boolean) => {
        if (!bankId) return;
        const trail = cleared.get(bankId) ?? [];
        trail.push({ key, tag, amount, cash: cashPart, advance });
        cleared.set(bankId, trail);
      };
      while (credit > 0n && q.length) {
        const head = q[0];
        const take = head.left < credit ? head.left : credit;
        const cashTake = take < cashLeft ? take : cashLeft;
        head.left -= take;
        credit -= take;
        cashLeft -= cashTake;
        if (head.tag && cashTake > 0n) collected.set(head.tag, (collected.get(head.tag) ?? 0n) + cashTake);
        note(head.tag, take, cashTake, false);
        if (head.left === 0n) q.shift();
      }
      if (credit > 0n) {
        surplus.set(key, (surplus.get(key) ?? 0n) + credit);
        surplusCash.set(key, (surplusCash.get(key) ?? 0n) + cashLeft);
        note(null, credit, cashLeft, true);
      }
    }
  }
  return collected;
}

/** Indirect cash flow from the start of the financial year holding `to`: net profit and the movement of every other balance-sheet account. */
export async function cashFlow(db: Db, scope: Scope, to: Date): Promise<CashFlow> {
  await single(db, scope);
  const from = fiscalYearStart(await fiscalEndMonth(db, scope.clientId), to);
  const before = new Date(+from - 86_400_000);
  const [moved, start] = await Promise.all([movements(db, scope, from, to, "exclude"), yearOpening(db, scope, from, to)]);
  const opening = start.rows;
  const isPl = (a: Account) => a.type === "PENDAPATAN" || a.type === "BEBAN";
  const netProfit = moved.filter((m) => isPl(m.account)).reduce((t, m) => t - m.net, 0n);
  // Each intercompany account's side at the period end decides its section (cashLine); a balance settled to zero by the period end keeps the
  // side it opened with (a loan given and repaid is still lending).
  // Per counterparty (its own account, lib/coa/intercompany.ts); balances between companies of the scope are read as one, so a loan inside
  // a group shown together cancels instead of showing as lending and borrowing.
  const inScope = new Set(scope.entityIds);
  const counterpartyOf = new Map((await db.account.findMany({ where: { clientId: scope.clientId, isIntercompany: true }, select: { code: true, counterpartyEntityId: true } })).map((a) => [a.code, a.counterpartyEntityId]));
  const icKey = (code: string) => {
    const party = counterpartyOf.get(code);
    return scope.entityIds.length > 1 && (!party || inScope.has(party)) ? "group" : code;
  };
  const icNet = new Map<string, bigint>();
  const icOpen = new Map<string, bigint>();
  for (const m of opening) if (m.account.isIntercompany) icOpen.set(icKey(m.account.code), (icOpen.get(icKey(m.account.code)) ?? 0n) + m.net);
  for (const m of [...opening, ...moved]) if (m.account.isIntercompany) icNet.set(icKey(m.account.code), (icNet.get(icKey(m.account.code)) ?? 0n) + m.net);
  const lentOut = (code: string) => {
    const key = icKey(code);
    const end = icNet.get(key) ?? 0n;
    return end !== 0n ? end > 0n : (icOpen.get(key) ?? 0n) > 0n;
  };
  const lineOf = (a: Pick<Account, "code" | "fsLine" | "isIntercompany">) => cashLine(a, a.isIntercompany && lentOut(a.code));
  const groups = new Map<string, CashItem & { section: CashSection }>();
  for (const m of moved) {
    if (isPl(m.account) || m.net === 0n) continue;
    const line = lineOf(m.account);
    if (!line) continue;
    const g = groups.get(line.key) ?? { key: line.key, label: line.label, amount: 0n, codes: [], section: line.section };
    g.amount -= m.net; // an asset that grew used cash; a liability or equity that grew brought it
    g.codes.push(m.account.code);
    groups.set(line.key, g);
  }
  const add = (key: string, label: string, section: CashSection, amount: bigint, code?: string) => {
    const g = groups.get(key) ?? { key, label, amount: 0n, codes: [], section };
    g.amount += amount;
    if (code && !g.codes.includes(code)) g.codes.push(code);
    groups.set(key, g);
  };

  // Non-cash transactions (no cash line, not from a bank row) that cross sections — an asset bought on credit, a dividend declared, a first-year benefit
  // obligation to Saldo laba — must not show as investing or financing flows: their investing/financing part is moved into operating as
  // one "non-kas" line, where it offsets the other side (the payable, the obligation). Non-cash entries within one section stay as they are.
  const lines = await db.journalLine.findMany({
    where: { entityId: { in: scope.entityIds }, date: { gte: from, lte: to }, entry: { kind: { not: "OPENING" } } },
    select: { id: true, entryId: true, debit: true, credit: true, currency: true, fxAmount: true, entry: { select: { bankTransactionId: true } }, account: { select: { code: true, type: true, fsLine: true, isIntercompany: true } } },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });
  const byEntry = new Map<string, typeof lines>();
  for (const l of lines) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l]);
  const NONCASH = "Transaksi non-kas (dilawankan dengan pos investasi/pendanaan)";
  // A disposal entry (the register's `disposalEntryId`) has no bank row: its proceeds sit on a receivable until the bank receipt is classified to
  // the same account. The proceeds collected by the period end (collectedProceeds: first-in-first-out on that account, cash receipts only) are the
  // investing inflow; the rest of the entry (cost off, accumulated depreciation off, the gain or loss) is non-cash, so the sections still add up
  // to the change in cash.
  const disposals = new Set((await db.fixedAsset.findMany({ where: { entityId: { in: scope.entityIds }, disposalEntryId: { in: [...byEntry.keys()] } }, select: { disposalEntryId: true } })).map((d) => d.disposalEntryId!));
  const isProceeds = (l: (typeof lines)[number]) => l.account.fsLine !== "ASET_TETAP" && l.account.fsLine !== "AKUM_PENYUSUTAN" && l.account.type !== "PENDAPATAN" && l.account.type !== "BEBAN";
  const collectedBy = await collectedProceeds(db, scope.entityIds, to, [...byEntry.values()].filter((e) => disposals.has(e[0].entryId)).flat().filter((l) => isProceeds(l) && l.debit - l.credit > 0n));
  const sectionOf = (a: (typeof lines)[number]["account"]) => (a.type === "PENDAPATAN" || a.type === "BEBAN" ? "OPERATING" : (lineOf(a)?.section ?? "CASH"));
  let fxEffect = 0n;
  for (const entry of byEntry.values()) {
    // A bank-derived entry is cash even without a cash line: a statement row is posted to 1999 first and moved by a RECLASS entry.
    if (entry[0].entry.bankTransactionId) continue;
    // A month-end revaluation (lines in a currency with fx amount 0, lib/fx/revalue.ts) moves no cash (PSAK 207): its cash part is the
    // effect of exchange rates on cash, shown apart; the rest — the revalued receivable or loan and the unrealised 7200 — leaves the
    // sections, the gain or loss shown as a non-cash adjustment of the profit.
    if (entry.some((l) => l.currency && l.fxAmount === 0n)) {
      let unrealised = 0n;
      for (const l of entry) {
        const net = l.debit - l.credit;
        const section = sectionOf(l.account);
        if (section === "CASH") fxEffect += net;
        else if (l.account.type === "PENDAPATAN" || l.account.type === "BEBAN") unrealised += net;
        else {
          const line = lineOf(l.account);
          if (line) add(line.key, line.label, line.section, net);
        }
      }
      if (unrealised) add("FX_UNREALISED", "Laba/rugi selisih kurs belum direalisasi", "OPERATING", unrealised);
      continue;
    }
    if (disposals.has(entry[0].entryId)) {
      const assetLines = entry.filter((l) => l.account.fsLine === "ASET_TETAP");
      const cost = -assetLines.reduce((t, l) => t + l.debit - l.credit, 0n);
      if (cost > 0n) {
        for (const l of assetLines) {
          const line = lineOf(l.account)!;
          add(line.key, line.label, line.section, l.debit - l.credit); // undo the cost's investing effect …
        }
        let proceeds = 0n;
        let received = 0n;
        for (const l of entry) {
          if (!isProceeds(l)) continue;
          const net = l.debit - l.credit;
          if (net <= 0n) continue;
          proceeds += net;
          received += collectedBy.get(l.id) ?? 0n;
        }
        const collected = received < proceeds ? received : proceeds;
        add("DISPOSAL", "Hasil pelepasan aset tetap", "INVESTING", collected);
        add("DISPOSAL_NONCASH", "Pelepasan aset tetap (non-kas): nilai buku dan laba/rugi", "OPERATING", cost - collected); // … and what wasn't cash is operating
        continue;
      }
    }
    const sections = new Set(entry.map((l) => sectionOf(l.account)));
    if (sections.has("CASH") || sections.size < 2) continue;
    for (const l of entry) {
      const line = lineOf(l.account);
      if (!line || line.section === "OPERATING" || l.account.type === "PENDAPATAN" || l.account.type === "BEBAN") continue;
      const net = l.debit - l.credit;
      add(line.key, line.label, line.section, net); // undo its investing/financing effect …
      // … and show it in operating. Interest accrued on a lease liability is part of the rent, which is paid (and shown) in financing.
      if (LEASE_CODES.has(l.account.code)) add("LEASE_INTEREST", "Bunga dan reklasifikasi liabilitas sewa (dibayar di pendanaan)", "OPERATING", -net, l.account.code);
      else add("NONCASH", NONCASH, "OPERATING", -net, l.account.code);
    }
  }

  // A disposal of an earlier year whose proceeds are collected in this period: the receipt only moved the receivable (operating above); the part
  // of its proceeds collected between the year start and `to` is an investing inflow instead.
  const earlier = await db.fixedAsset.findMany({ where: { entityId: { in: scope.entityIds }, disposalEntry: { date: { lt: from } } }, select: { disposalEntryId: true } });
  if (earlier.length) {
    const proceeds = (await db.journalLine.findMany({
      where: { entryId: { in: earlier.map((d) => d.disposalEntryId!) } },
      select: { id: true, entryId: true, debit: true, credit: true, account: { select: { code: true, type: true, fsLine: true, isIntercompany: true } } },
    })).filter((l) => isProceeds(l as (typeof lines)[number]) && l.debit - l.credit > 0n);
    const [byEnd, byStart] = await Promise.all([collectedProceeds(db, scope.entityIds, to, proceeds), collectedProceeds(db, scope.entityIds, before, proceeds)]);
    for (const l of proceeds) {
      const now = (byEnd.get(l.id) ?? 0n) - (byStart.get(l.id) ?? 0n);
      if (now <= 0n) continue;
      const line = lineOf(l.account);
      if (line) add(line.key, line.label, line.section, -now, l.account.code);
      add("DISPOSAL", "Hasil pelepasan aset tetap", "INVESTING", now);
    }
  }

  // Equipment bought on a payable: the bill's journal is non-cash (above), the payment only moves the payable. What the settled bank lines paid
  // (in the period, by the bill's settlements, less the tax they withheld) of the bill's investing debits is an investing outflow — also for a bill of an earlier year.
  const bills = await db.invoice.findMany({
    where: { entityId: { in: scope.entityIds }, direction: "PURCHASE", entryId: { not: null }, settlements: { some: { bankTransaction: { date: { gte: from, lte: to } } } } },
    select: { total: true, entryId: true, settlements: { select: { amount: true, withheld: true, bankTransaction: { select: { date: true } } } } },
  });
  if (bills.length) {
    const debits = await db.journalLine.findMany({ where: { entryId: { in: bills.map((b) => b.entryId!) }, debit: { gt: 0n } }, select: { entryId: true, debit: true, account: { select: { code: true, type: true, fsLine: true, isIntercompany: true } } } });
    for (const bill of bills) {
      // Cash only: the withheld part of a settlement is tax owed, not paid to the supplier. Paid up to `to` less paid before `from`, each
      // apportioned the same way, so a bill paid across two years adds up to its cost exactly (the rounding telescopes).
      const paidBy = (until: Date) => bill.settlements.filter((x) => +x.bankTransaction.date <= +until).reduce((t, x) => t + x.amount - x.withheld, 0n);
      const [paidTo, paidBefore] = [paidBy(to), paidBy(before)];
      for (const l of debits.filter((d) => d.entryId === bill.entryId)) {
        const line = lineOf(l.account);
        if (!line || line.section !== "INVESTING" || bill.total <= 0n) continue;
        const part = (paidTo * l.debit) / bill.total - (paidBefore * l.debit) / bill.total;
        add(line.key, line.label, "INVESTING", -part);
        add("NONCASH", NONCASH, "OPERATING", part, l.account.code);
      }
    }
  }

  const of = (s: CashSection) => [...groups.values()].filter((g) => g.section === s && g.amount !== 0n).map(({ key, label, amount, codes }) => ({ key, label, amount, codes }));
  const operating = of("OPERATING");
  const investing = of("INVESTING");
  const financing = of("FINANCING");
  const totals = { OPERATING: netProfit + operating.reduce((t, i) => t + i.amount, 0n), INVESTING: investing.reduce((t, i) => t + i.amount, 0n), FINANCING: financing.reduce((t, i) => t + i.amount, 0n) };
  const cash = (xs: Movement[]) => xs.filter((m) => m.account.fsLine === "KAS_SETARA_KAS").reduce((t, m) => t + m.net, 0n);
  const openingCash = cash(opening);
  const joinedCash = cash(start.joined);
  return { from, to, openedAt: start.openedOn ?? before, netProfit, operating, investing, financing, totals, net: totals.OPERATING + totals.INVESTING + totals.FINANCING, fxEffect, openingCash, joinedCash, joinedOn: start.joinedOn, closingCash: openingCash + joinedCash + cash(moved) };
}
