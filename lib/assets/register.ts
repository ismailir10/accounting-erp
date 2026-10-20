import { financialYear, fiscalEndMonth } from "@/lib/fiscal";
import type { Db, Tx } from "@/lib/db";
import type { AssetTaxGroup, FiscalMethod } from "@/lib/generated/prisma/enums";
import { LedgerError } from "@/lib/ledger/post";
import { closeLock, createSchedule, installments, owed } from "@/lib/adjust/schedules";
import { depreciates } from "@/lib/adjust/form";
import { fiscalDepreciation, fiscalMethodAllowed, TAX_GROUPS } from "@/lib/assets/fiscal";
import { dateOnly, formatDate, formatPeriod, periodBounds } from "@/lib/format";
import { parseMoney } from "@/lib/money";

/**
 * Fixed-asset register (accounting-rules 5b). An asset's book depreciation is its AdjustmentSchedule (rule 5a, created with it in
 * one transaction); accumulated depreciation and book value are read from the GL at the date asked, never stored; the fiscal
 * figures are the estimate of lib/assets/fiscal.ts. Nothing here posts except through the schedule and the disposal.
 */

export const DEFAULT_EXPENSE = "6180";
export const DEFAULT_ACCUMULATED = "1219";

export type AssetInput = {
  clientId: string;
  entityId: string;
  name: string;
  taxGroup: AssetTaxGroup;
  fiscalMethod: FiscalMethod;
  /** YYYY-MM-DD */
  acquiredOn: string;
  /** Typed in major units of the entity's functional currency (rule 6). */
  cost: string;
  residual?: string;
  /** Book useful life (PSAK 216 estimate); ignored for land. */
  usefulLifeMonths?: number | null;
  /** Assets from Saldo Awal: accumulated book depreciation at the opening date, and the months of life left to depreciate. */
  openingAccumulated?: string;
  remainingMonths?: number | null;
  assetAccountCode: string;
  expenseCode?: string;
  accumulatedCode?: string;
  /** First month of book depreciation; default the month after acquisition. */
  startYear?: number;
  startMonth?: number;
  /** The purchase entry whose debit on the asset account this asset is (the line = entry + asset account). */
  sourceEntryId?: string | null;
  /** An existing depreciation schedule to register as this asset (no new schedule). */
  scheduleId?: string | null;
  actorId?: string | null;
};

function parseDay(s: string): Date {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m ? dateOnly(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  if (!d || d.getUTCMonth() + 1 !== Number(m![2])) throw new LedgerError("Tanggal perolehan tidak valid.");
  return d;
}

export async function createAsset(db: Db, input: AssetInput) {
  const entity = await db.entity.findFirst({ where: { id: input.entityId, clientId: input.clientId } });
  if (!entity) throw new LedgerError("Pilih entitas.");
  const name = input.name.trim();
  if (!name) throw new LedgerError("Isi nama aset.");
  if (!TAX_GROUPS[input.taxGroup]) throw new LedgerError("Pilih kelompok aset.");
  const land = input.taxGroup === "TANAH";
  const fiscalMethod: FiscalMethod = land ? "GARIS_LURUS" : input.fiscalMethod;
  if (!fiscalMethodAllowed(input.taxGroup, fiscalMethod)) throw new LedgerError("Bangunan disusutkan secara fiskal dengan garis lurus.");
  const acquiredOn = parseDay(input.acquiredOn);
  const cur = entity.functionalCurrency;
  const cost = parseMoney(input.cost, cur);
  const residual = input.residual?.trim() ? parseMoney(input.residual, cur) : 0n;
  const openingAccumulated = input.openingAccumulated?.trim() ? parseMoney(input.openingAccumulated, cur) : 0n;
  if (cost <= 0n) throw new LedgerError("Harga perolehan harus lebih dari nol.");
  if (residual < 0n || residual >= cost) throw new LedgerError("Nilai sisa harus nol atau lebih, dan kurang dari harga perolehan.");
  if (openingAccumulated < 0n || openingAccumulated > cost - residual) throw new LedgerError("Akumulasi penyusutan awal tidak boleh melebihi harga perolehan dikurangi nilai sisa.");
  if (land && (residual > 0n || openingAccumulated > 0n)) throw new LedgerError("Tanah tidak disusutkan: nilai sisa dan akumulasi penyusutan harus nol.");

  const accounts = await db.account.findMany({ where: { clientId: input.clientId } });
  const byCode = (code: string) => accounts.find((a) => a.code === code);
  const assetAccount = byCode(input.assetAccountCode);
  if (!assetAccount || assetAccount.fsLine !== "ASET_TETAP") throw new LedgerError("Pilih akun aset tetap untuk aset ini.");

  // A purchase line: the entry has a debit on the asset account for exactly this cost, cited by no asset or schedule yet.
  if (input.sourceEntryId) {
    const lines = await db.journalLine.findMany({ where: { entryId: input.sourceEntryId, accountId: assetAccount.id, entry: { entityId: entity.id } } });
    const net = lines.reduce((s, l) => s + l.debit - l.credit, 0n);
    if (!lines.length || net <= 0n) throw new LedgerError(`Jurnal sumber tidak punya pembelian di akun ${assetAccount.code}.`);
    if (net !== cost) throw new LedgerError("Harga perolehan harus sama dengan nilai pembelian di jurnal sumber (satu aset per baris pembelian).");
    const taken = await db.fixedAsset.findFirst({ where: { sourceEntryId: input.sourceEntryId, assetAccountId: assetAccount.id } });
    if (taken) throw new LedgerError(`Pembelian ini sudah terdaftar sebagai aset "${taken.name}".`);
  }
  // Assets from before the books started are part of the opening: they count from the opening date, and their opening accumulated
  // depreciation is what the opening entry holds.
  const opening = await db.journalEntry.findFirst({ where: { entityId: entity.id, kind: "OPENING" }, orderBy: { date: "asc" }, select: { date: true } });
  if (openingAccumulated > 0n) {
    if (!opening) throw new LedgerError("Akumulasi penyusutan awal berasal dari Saldo Awal: catat Saldo Awal entitas ini dulu.");
    if (+acquiredOn > +opening.date) throw new LedgerError(`Aset dengan akumulasi penyusutan awal diperoleh paling lambat ${formatDate(opening.date)} (tanggal Saldo Awal).`);
  }
  const effective = opening && +acquiredOn < +opening.date ? opening.date : acquiredOn;
  const monthIndex = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth() + 1;
  // Depreciation — a new schedule or one linked to this asset — can't start before the asset exists, nor, for an asset in Saldo Awal,
  // in months its opening accumulation covers.
  const assertStart = (start: { year: number; month: number }) => {
    if (start.year * 12 + start.month < monthIndex(acquiredOn)) throw new LedgerError("Penyusutan tidak bisa dimulai sebelum bulan perolehan.");
    if (openingAccumulated > 0n && opening && start.year * 12 + start.month <= monthIndex(opening.date)) throw new LedgerError(`Akumulasi penyusutan awal sudah mencakup sampai ${formatDate(opening.date)}: mulai penyusutan sesudah bulan Saldo Awal.`);
  };
  // A locked month's register can't change after the fact (rule 4): refuse an asset that would enter it. Checked under the close lock.
  // The asset is listed in every register from its effective month on, so any locked month from then on would change after the fact.
  const assertOpen = async (tx: Tx) => {
    const y = effective.getUTCFullYear();
    const m = effective.getUTCMonth() + 1;
    const locked = await tx.period.findFirst({ where: { clientId: input.clientId, status: "LOCKED", OR: [{ year: { gt: y } }, { year: y, month: { gte: m } }] }, orderBy: [{ year: "asc" }, { month: "asc" }] });
    if (locked) throw new LedgerError(`${formatPeriod(locked.year, locked.month)} sudah dikunci, dan aset ini masuk daftar aset bulan itu. Buka kunci bulan itu dulu.`);
  };
  const guarded = <T,>(write: (tx: Tx) => Promise<T>) =>
    db.$transaction(async (tx) => {
      await closeLock(tx, input.clientId);
      await assertOpen(tx);
      return write(tx);
    });
  const base = {
    firmId: entity.firmId,
    clientId: input.clientId,
    entityId: entity.id,
    name,
    taxGroup: input.taxGroup,
    fiscalMethod,
    acquiredOn,
    cost,
    residual,
    openingAccumulated,
    assetAccountId: assetAccount.id,
    sourceEntryId: input.sourceEntryId ?? null,
    createdById: input.actorId ?? null,
  };

  if (land) {
    if (input.scheduleId) throw new LedgerError("Tanah tidak disusutkan, jadi tidak memakai jadwal penyusutan.");
    return guarded((tx) => tx.fixedAsset.create({ data: { ...base, usefulLifeMonths: null } }));
  }

  // An existing depreciation schedule becomes this asset's: it must depreciate exactly cost − residual − opening accumulated.
  if (input.scheduleId) {
    const s = await db.adjustmentSchedule.findFirst({ where: { id: input.scheduleId, clientId: input.clientId, entityId: entity.id }, include: { asset: true } });
    if (!s || s.kind !== "DEPRECIATION") throw new LedgerError("Jadwal penyusutan tidak ditemukan untuk entitas ini.");
    if (s.asset) throw new LedgerError(`Jadwal ini sudah menjadi aset "${s.asset.name}".`);
    if (s.stoppedAt) throw new LedgerError("Jadwal ini sudah dihentikan.");
    if (s.amount !== cost - residual - openingAccumulated) throw new LedgerError("Harga perolehan − nilai sisa − akumulasi awal harus sama dengan total jadwal penyusutan.");
    const credit = accounts.find((a) => a.id === s.creditAccountId);
    if (credit?.fsLine !== "AKUM_PENYUSUTAN") throw new LedgerError("Jadwal ini tidak mengkredit akun akumulasi penyusutan; buat aset baru dengan akun akumulasi penyusutan.");
    assertStart({ year: s.startYear, month: s.startMonth });
    const life = input.usefulLifeMonths ?? s.months;
    // The schedule's own purchase line, when it stored one on this asset account.
    const sourceEntryId = input.sourceEntryId ?? (s.sourceAccountId === assetAccount.id ? s.sourceEntryId : null);
    try {
      return await guarded((tx) => tx.fixedAsset.create({ data: { ...base, sourceEntryId, usefulLifeMonths: life, scheduleId: s.id, accumulatedAccountId: credit.id } }));
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw new LedgerError("Jadwal atau pembelian ini sudah terdaftar sebagai aset.");
      throw e;
    }
  }

  const life = input.usefulLifeMonths ?? TAX_GROUPS[input.taxGroup].lifeYears! * 12;
  if (!(Number.isInteger(life) && life >= 1 && life <= 600)) throw new LedgerError("Masa manfaat 1–600 bulan.");
  const depreciable = cost - residual - openingAccumulated;
  const months = openingAccumulated > 0n ? input.remainingMonths ?? null : life;
  if (depreciable > 0n && !(months && Number.isInteger(months) && months >= 1 && months <= life)) throw new LedgerError(`Isi sisa masa manfaat (1–${life} bulan).`);
  const expense = byCode(input.expenseCode ?? DEFAULT_EXPENSE);
  const accumulated = byCode(input.accumulatedCode ?? DEFAULT_ACCUMULATED);
  if (!depreciates(expense, accumulated, assetAccount.code) || accumulated?.fsLine !== "AKUM_PENYUSUTAN") throw new LedgerError("Penyusutan: akun beban di debit, akun akumulasi penyusutan di kredit.");
  // Fully depreciated in Saldo Awal: registered without a schedule.
  if (depreciable === 0n) return guarded((tx) => tx.fixedAsset.create({ data: { ...base, usefulLifeMonths: life, accumulatedAccountId: accumulated.id } }));
  const start = input.startYear && input.startMonth ? { year: input.startYear, month: input.startMonth } : nextMonth(effective);
  assertStart(start);
  let assetId = "";
  await createSchedule(
    db,
    {
      clientId: input.clientId,
      entityId: entity.id,
      kind: "DEPRECIATION",
      memo: `Penyusutan ${name}`,
      debitCode: expense!.code,
      creditCode: accumulated!.code,
      amount: "",
      amountMinor: depreciable,
      months: months!,
      startYear: start.year,
      startMonth: start.month,
      sourceEntryId: input.sourceEntryId ?? null,
      sourceAccountCode: input.sourceEntryId ? assetAccount.code : null,
      actorId: input.actorId,
    },
    async (tx: Tx, schedule) => {
      await assertOpen(tx);
      assetId = (await tx.fixedAsset.create({ data: { ...base, usefulLifeMonths: life, scheduleId: schedule.id, accumulatedAccountId: accumulated.id } })).id;
    },
  ).catch((e) => {
    if ((e as { code?: string }).code === "P2002") throw new LedgerError("Pembelian ini sudah terdaftar sebagai aset.");
    throw e;
  });
  return db.fixedAsset.findUniqueOrThrow({ where: { id: assetId } });
}

function nextMonth(d: Date) {
  const m = d.getUTCMonth() + 2;
  return m === 13 ? { year: d.getUTCFullYear() + 1, month: 1 } : { year: d.getUTCFullYear(), month: m };
}

export type RegisterRow = {
  id: string;
  name: string;
  entity: { id: string; shortName: string; functionalCurrency: string };
  taxGroup: AssetTaxGroup;
  fiscalMethod: FiscalMethod;
  acquiredOn: Date;
  assetAccount: { code: string; name: string };
  accumulatedAccount: { code: string; name: string } | null;
  usefulLifeMonths: number | null;
  /** At the period end; 0 once disposed. */
  cost: bigint;
  accumulated: bigint;
  bookValue: bigint;
  /** Posted book depreciation from 1 January through the period. */
  bookYtd: bigint;
  /** Fiscal estimate from 1 January through the period (null for non-IDR entities). */
  fiscalYtd: bigint | null;
  fiscalBookValue: bigint | null;
  /** Book − fiscal this year: positive = koreksi fiskal positif. */
  difference: bigint | null;
  /**
   * Disposed this year: fiscal gain − book gain on the disposal = fiscal accumulated − book accumulated at disposal (the same proceeds on
   * both sides), the reversal of the depreciation timing difference; positive = koreksi fiskal positif. Null otherwise.
   */
  disposalDifference: bigint | null;
  /** Installments due through the period but not posted. */
  unposted: number;
  scheduleId: string | null;
  sourceEntryId: string | null;
  disposedOn: Date | null;
  proceeds: bigint | null;
  disposalEntryId: string | null;
};

/**
 * The register at the end of a month: assets acquired by then and not disposed before the year began (an asset disposed this
 * year stays listed with its year's depreciation, its cost and accumulated depreciation derecognised). "The year" is the client's
 * financial year (lib/fiscal.ts); fiscal (tax) depreciation is calendar only, so it is left out for a non-calendar tahun buku.
 */
export async function assetRegister(db: Db, clientId: string, year: number, month: number, entityIds?: string[]): Promise<RegisterRow[]> {
  const { end } = periodBounds(year, month);
  const endMonth = await fiscalEndMonth(db, clientId);
  const yearStart = financialYear(endMonth, year, month).start;
  const assets = await db.fixedAsset.findMany({
    where: { clientId, ...(entityIds ? { entityId: { in: entityIds } } : {}), acquiredOn: { lte: end }, OR: [{ disposedOn: null }, { disposedOn: { gte: yearStart } }] },
    include: {
      entity: { select: { id: true, shortName: true, functionalCurrency: true, kind: true, name: true } },
      assetAccount: { select: { code: true, name: true } },
      accumulatedAccount: { select: { code: true, name: true } },
      schedule: { include: { entries: { select: { date: true, installment: true, lines: { select: { accountId: true, credit: true, debit: true } } } } } },
    },
    orderBy: [{ acquiredOn: "asc" }, { name: "asc" }, { id: "asc" }],
  });
  const locked = new Set((await db.period.findMany({ where: { clientId, status: "LOCKED" }, select: { year: true, month: true } })).map((p) => p.year * 12 + p.month));
  const upTo = year * 12 + month;
  // An asset acquired before its entity's books started is part of the opening: listed (with its opening accumulation) from then.
  const openings = await db.journalEntry.groupBy({ by: ["entityId"], where: { kind: "OPENING", entityId: { in: [...new Set(assets.map((a) => a.entityId))] } }, _min: { date: true } });
  const openingOf = new Map(openings.map((o) => [o.entityId, o._min.date]));
  const listed = assets.filter((a) => {
    const opened = openingOf.get(a.entityId);
    const from = opened && +a.acquiredOn < +opened ? opened : a.acquiredOn;
    return +from <= +end;
  });
  return listed.map((a) => {
    const s = a.schedule;
    // Forward installments only (a reversal belongs to accruals); each one's amount = its credit on the accumulated account.
    const posted = (s?.entries ?? []).filter((e) => e.installment !== null && e.installment <= s!.months && +e.date <= +end);
    const amountOf = (e: (typeof posted)[number]) => e.lines.filter((l) => l.accountId === s!.creditAccountId).reduce((t, l) => t + l.credit - l.debit, 0n);
    const bookYtd = posted.filter((e) => +e.date >= +yearStart).reduce((t, e) => t + amountOf(e), 0n);
    const disposed = a.disposedOn !== null && +a.disposedOn <= +end;
    const bookAccumulated = a.openingAccumulated + posted.reduce((t, e) => t + amountOf(e), 0n);
    const accumulated = disposed ? 0n : bookAccumulated;
    const cost = disposed ? 0n : a.cost;
    const postedK = new Set((s?.entries ?? []).map((e) => e.installment));
    const unposted = s ? installments(s).filter((i) => !i.reversal && owed(s.stoppedAt, i) && i.year * 12 + i.month <= upTo && !locked.has(i.year * 12 + i.month) && !postedK.has(i.k)).length : 0;
    const idr = a.entity.functionalCurrency === "IDR";
    const fiscal = idr && endMonth === 12 ? fiscalDepreciation({ ...a, disposedOn: a.disposedOn }, year, month) : null;
    return {
      id: a.id,
      name: a.name,
      entity: { id: a.entity.id, shortName: a.entity.shortName, functionalCurrency: a.entity.functionalCurrency },
      taxGroup: a.taxGroup,
      fiscalMethod: a.fiscalMethod,
      acquiredOn: a.acquiredOn,
      assetAccount: a.assetAccount,
      accumulatedAccount: a.accumulatedAccount,
      usefulLifeMonths: a.usefulLifeMonths,
      cost,
      accumulated,
      bookValue: cost - accumulated,
      bookYtd,
      fiscalYtd: fiscal?.depreciation ?? null,
      fiscalBookValue: fiscal ? (disposed ? 0n : fiscal.bookValue) : null,
      difference: fiscal ? bookYtd - fiscal.depreciation : null,
      disposalDifference: fiscal && disposed ? fiscal.accumulated - bookAccumulated : null,
      unposted,
      scheduleId: a.scheduleId,
      sourceEntryId: a.sourceEntryId,
      disposedOn: a.disposedOn,
      proceeds: a.proceeds,
      disposalEntryId: a.disposalEntryId,
    };
  });
}

/** GL balance (debit − credit) of accounts for an entity through a date. */
async function glBalance(db: Db, entityId: string, accountIds: string[], end: Date) {
  if (!accountIds.length) return 0n;
  const s = await db.journalLine.aggregate({ where: { entityId, accountId: { in: accountIds }, date: { lte: end } }, _sum: { debit: true, credit: true } });
  return (s._sum.debit ?? 0n) - (s._sum.credit ?? 0n);
}

export type LedgerComparison = {
  entityId: string;
  assetAccounts: string[];
  accumulatedAccounts: string[];
  register: { cost: bigint; accumulated: bigint };
  ledger: { cost: bigint; accumulated: bigint };
  equal: boolean;
};

/**
 * Register vs GL at the period end, per entity with registered assets: cost against the asset accounts the register uses, accumulated
 * depreciation against its accumulated-depreciation accounts (GL credit balance). Land has none.
 */
export async function registerVsLedger(db: Db, clientId: string, year: number, month: number, entityIds?: string[]): Promise<LedgerComparison[]> {
  const { end } = periodBounds(year, month);
  const rows = await assetRegister(db, clientId, year, month, entityIds);
  const assets = await db.fixedAsset.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, assetAccountId: true, accumulatedAccountId: true } });
  const out: LedgerComparison[] = [];
  for (const entityId of [...new Set(rows.map((r) => r.entity.id))]) {
    const mine = rows.filter((r) => r.entity.id === entityId);
    const ids = new Set(mine.map((r) => r.id));
    const own = assets.filter((a) => ids.has(a.id));
    const assetIds = [...new Set(own.map((a) => a.assetAccountId))];
    const accumIds = [...new Set(own.flatMap((a) => (a.accumulatedAccountId ? [a.accumulatedAccountId] : [])))];
    const register = { cost: mine.reduce((t, r) => t + r.cost, 0n), accumulated: mine.reduce((t, r) => t + r.accumulated, 0n) };
    const ledger = { cost: await glBalance(db, entityId, assetIds, end), accumulated: -(await glBalance(db, entityId, accumIds, end)) };
    out.push({
      entityId,
      assetAccounts: mine.map((r) => r.assetAccount.code).filter((c, i, all) => all.indexOf(c) === i),
      accumulatedAccounts: mine.flatMap((r) => (r.accumulatedAccount ? [r.accumulatedAccount.code] : [])).filter((c, i, all) => all.indexOf(c) === i),
      register,
      ledger,
      equal: register.cost === ledger.cost && register.accumulated === ledger.accumulated,
    });
  }
  return out;
}

export type AssetCandidate = { entryId: string; entity: { id: string; shortName: string; functionalCurrency: string }; account: { code: string; name: string }; date: Date; amount: bigint; description: string };

/**
 * Purchases in the ledger not registered yet: the net debit of an entry on an ASET_TETAP account (opening entries, lease
 * commencements, whose ROU asset the lease register holds, and entries reversed or voided away excluded), unless
 * an asset or a schedule cites that line — or, for schedules made before the line was stored, cites the entry at all.
 */
export async function assetCandidates(db: Db, clientId: string, entityIds?: string[]): Promise<AssetCandidate[]> {
  const lines = await db.journalLine.findMany({
    where: { account: { clientId, fsLine: "ASET_TETAP" }, ...(entityIds ? { entityId: { in: entityIds } } : {}), entry: { kind: { not: "OPENING" }, assetDisposal: null, leaseCommenced: null, leaseCancelled: null, voidedInvoice: null, reversedBy: null } },
    include: { account: { select: { id: true, code: true, name: true } }, entry: { select: { id: true, memo: true, date: true, entity: { select: { id: true, shortName: true, functionalCurrency: true } }, bankTransaction: { select: { description: true } } } } },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });
  const groups = new Map<string, { line: (typeof lines)[number]; net: bigint }>();
  for (const l of lines) {
    const k = `${l.entryId}|${l.accountId}`;
    const g = groups.get(k) ?? { line: l, net: 0n };
    g.net += l.debit - l.credit;
    groups.set(k, g);
  }
  const entryIds = [...new Set(lines.map((l) => l.entryId))];
  const assets = await db.fixedAsset.findMany({ where: { sourceEntryId: { in: entryIds } }, select: { sourceEntryId: true, assetAccountId: true } });
  const schedules = await db.adjustmentSchedule.findMany({ where: { sourceEntryId: { in: entryIds } }, select: { sourceEntryId: true, sourceAccountId: true } });
  const cited = new Set([...assets.map((a) => `${a.sourceEntryId}|${a.assetAccountId}`), ...schedules.filter((s) => s.sourceAccountId).map((s) => `${s.sourceEntryId}|${s.sourceAccountId}`)]);
  const legacy = new Set(schedules.filter((s) => !s.sourceAccountId).map((s) => s.sourceEntryId));
  return [...groups.entries()]
    .filter(([k, g]) => g.net > 0n && !cited.has(k) && !legacy.has(g.line.entryId))
    .map(([, g]) => ({
      entryId: g.line.entryId,
      entity: g.line.entry.entity,
      account: { code: g.line.account.code, name: g.line.account.name },
      date: g.line.entry.date,
      amount: g.net,
      description: g.line.entry.bankTransaction?.description ?? g.line.entry.memo,
    }));
}

/** Depreciation schedules not registered as an asset (made before the register, or from the Jurnal Penyesuaian page). */
export async function unregisteredSchedules(db: Db, clientId: string, entityIds?: string[]) {
  return db.adjustmentSchedule.findMany({
    where: { clientId, kind: "DEPRECIATION", stoppedAt: null, asset: null, ...(entityIds ? { entityId: { in: entityIds } } : {}) },
    include: { entity: { select: { id: true, shortName: true, functionalCurrency: true } }, debitAccount: { select: { code: true, name: true } }, creditAccount: { select: { code: true, name: true } }, sourceAccount: { select: { code: true } }, sourceEntry: { select: { date: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export type AssetMovement = {
  kind: "ACQUIRED" | "OPENING" | "DEPRECIATION" | "DISPOSAL";
  date: Date;
  label: string;
  /** Cost booked (acquisition) or taken off (disposal, negative). */
  cost: bigint;
  /** Accumulated depreciation added (depreciation, opening) or taken off (disposal, negative). */
  accumulated: bigint;
  /** The entry behind it and the ledger (account, month) where it shows; null for Saldo Awal detail without its own entry line. */
  entryId: string | null;
  ledger: { code: string; year: number; month: number } | null;
};

/**
 * Everything behind an asset's register figures, oldest first (the drill for cost, accumulated depreciation, book value and the
 * year's depreciation): the purchase or the Saldo Awal, every posted installment, the disposal. Read from the GL, like the register.
 */
export async function assetDetail(db: Db, clientId: string, assetId: string) {
  const a = await db.fixedAsset.findFirst({
    where: { id: assetId, clientId },
    include: {
      entity: { select: { id: true, name: true, shortName: true, functionalCurrency: true } },
      assetAccount: { select: { code: true, name: true } },
      accumulatedAccount: { select: { code: true, name: true } },
      sourceEntry: { select: { id: true, date: true, memo: true, bankTransaction: { select: { description: true } } } },
      disposalEntry: { select: { id: true, date: true, memo: true } },
      schedule: { include: { entries: { select: { id: true, date: true, memo: true, installment: true, lines: { select: { accountId: true, credit: true, debit: true } } }, orderBy: { date: "asc" } } } },
    },
  });
  if (!a) return null;
  const ym = (d: Date) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  // The Saldo Awal itself, not a Temuan resolution posted later on the same date (ADR 0012).
  const opening = await db.journalEntry.findFirst({ where: { entityId: a.entityId, kind: "OPENING" }, orderBy: [{ date: "asc" }, { createdAt: "asc" }], select: { id: true, date: true } });
  const moves: AssetMovement[] = [];
  const fromOpening = opening && +a.acquiredOn < +opening.date;
  if (a.sourceEntry) {
    moves.push({ kind: "ACQUIRED", date: a.sourceEntry.date, label: a.sourceEntry.bankTransaction?.description ?? a.sourceEntry.memo, cost: a.cost, accumulated: 0n, entryId: a.sourceEntry.id, ledger: { code: a.assetAccount.code, ...ym(a.sourceEntry.date) } });
  } else {
    const at = fromOpening ? opening.date : a.acquiredOn;
    moves.push({ kind: fromOpening ? "OPENING" : "ACQUIRED", date: at, label: fromOpening ? "Saldo Awal (termasuk di jurnal saldo awal)" : "Didaftarkan tanpa jurnal sumber", cost: a.cost, accumulated: a.openingAccumulated, entryId: fromOpening ? opening.id : null, ledger: { code: a.assetAccount.code, ...ym(at) } });
  }
  const s = a.schedule;
  for (const e of (s?.entries ?? []).filter((x) => x.installment !== null && x.installment <= s!.months)) {
    const amount = e.lines.filter((l) => l.accountId === s!.creditAccountId).reduce((t, l) => t + l.credit - l.debit, 0n);
    moves.push({ kind: "DEPRECIATION", date: e.date, label: e.memo, cost: 0n, accumulated: amount, entryId: e.id, ledger: a.accumulatedAccount ? { code: a.accumulatedAccount.code, ...ym(e.date) } : null });
  }
  if (a.disposalEntry) {
    const before = moves.reduce((t, m) => t + m.accumulated, 0n);
    moves.push({ kind: "DISPOSAL", date: a.disposalEntry.date, label: a.disposalEntry.memo, cost: -a.cost, accumulated: -before, entryId: a.disposalEntry.id, ledger: { code: a.assetAccount.code, ...ym(a.disposalEntry.date) } });
  }
  // The disposal is always the last event (its month's installment is dated the month's last day, after it); acquisition first.
  const rank = { OPENING: 0, ACQUIRED: 0, DEPRECIATION: 1, DISPOSAL: 2 } as const;
  moves.sort((x, y) => Number(x.kind === "DISPOSAL") - Number(y.kind === "DISPOSAL") || +x.date - +y.date || rank[x.kind] - rank[y.kind]);
  return { asset: a, moves };
}
