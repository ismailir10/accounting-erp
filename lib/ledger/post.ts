import type { Tx } from "@/lib/db";
import type { EntryKind } from "@/lib/generated/prisma/enums";
import { formatPeriod } from "@/lib/format";
import { convertMinor, isCurrency } from "@/lib/fx/currency";

/**
 * The ONLY writer of JournalEntry/JournalLine. Enforces (accounting-rules):
 *  1. Σdebit = Σcredit, ≥ 2 lines, each line exactly one positive side (also DB CHECK)
 *  2. period open (locked periods reject every write)
 *  3. every account belongs to the entity's client COA; every source account belongs to the entity
 *  4. foreign-currency lines: currency ≠ functional, round(fxAmount × fxRate) = amount ± 1 minor unit (rule 6b)
 * Amounts are minor units of the entity's functional currency (IDR = whole Rupiah).
 * Posted entries are immutable — corrections go through a new RECLASS/ADJUSTMENT entry.
 */
export class LedgerError extends Error {}

export type PostLine = {
  accountId: string;
  debit?: bigint;
  credit?: bigint;
  memo?: string;
  sourceAccountId?: string | null;
  sourceRef?: string | null;
  /** Foreign-currency line: original currency, its (unsigned) amount in minor units and the rate (functional per 1 unit). */
  fx?: { currency: string; amount: bigint; rate: string; revaluation?: boolean } | null;
};

export type PostInput = {
  entityId: string;
  date: Date;
  kind: EntryKind;
  memo: string;
  bankTransactionId?: string;
  ledgerImportId?: string;
  sourceRef?: string;
  /** Installment of an adjustment schedule (accounting-rules 5a); both or neither. */
  scheduleId?: string;
  installment?: number;
  /** Member doing the posting; null/undefined = system (seed, migration). Attribution only, never a rule. */
  actorId?: string | null;
  /** The entry this one reverses (lib/ledger/reverse.ts); unique, so an entry is reversed once. */
  reversesId?: string;
  lines: PostLine[];
};

export async function getOrCreatePeriod(tx: Tx, firmId: string, clientId: string, date: Date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  // INSERT … ON CONFLICT DO NOTHING, then read: two imports of the same new month at once both get the one row (an upsert with an
  // empty update reads then inserts, so the second one failed on the unique key).
  await tx.period.createMany({ data: [{ firmId, clientId, year, month }], skipDuplicates: true });
  return tx.period.findUniqueOrThrow({ where: { clientId_year_month: { clientId, year, month } } });
}

/** Merge lines on the same account+side and drop zero lines. Keeps entries compact. */
function normalizeLines(lines: PostLine[]) {
  const out: (Required<Pick<PostLine, "accountId">> & { debit: bigint; credit: bigint; memo?: string; sourceAccountId: string | null; sourceRef: string | null; fx: PostLine["fx"] })[] = [];
  for (const l of lines) {
    const debit = l.debit ?? 0n;
    const credit = l.credit ?? 0n;
    if (debit < 0n || credit < 0n) throw new LedgerError("Nominal debit/kredit tidak boleh negatif");
    if (debit > 0n && credit > 0n) throw new LedgerError("Satu baris jurnal hanya boleh debit ATAU kredit");
    if (debit === 0n && credit === 0n) continue;
    out.push({ accountId: l.accountId, debit, credit, memo: l.memo, sourceAccountId: l.sourceAccountId ?? null, sourceRef: l.sourceRef ?? null, fx: l.fx ?? null });
  }
  return out;
}

export async function postJournal(tx: Tx, input: PostInput) {
  const lines = normalizeLines(input.lines);
  if (lines.length < 2) throw new LedgerError("Jurnal minimal dua baris");
  const totalDebit = lines.reduce((s, l) => s + l.debit, 0n);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0n);
  if (totalDebit !== totalCredit) {
    throw new LedgerError(`Jurnal tidak seimbang: debit ${totalDebit} ≠ kredit ${totalCredit}`);
  }

  const entity = await tx.entity.findUniqueOrThrow({ where: { id: input.entityId } });
  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  const accounts = await tx.account.findMany({ where: { id: { in: accountIds } } });
  if (accounts.length !== accountIds.length || accounts.some((a) => a.clientId !== entity.clientId)) {
    throw new LedgerError("Akun tidak termasuk bagan akun klien ini");
  }
  // A bank GL account belongs to one entity (BankAccount.entityId): another entity's books never touch it — money between
  // entities goes through 1190 in each entity's own books (rule 10), else its reconciliation breaks with no pointer to why.
  // The one exception clears what older books left there: a move toward zero of this entity's balance on that account.
  const bankIds = accounts.filter((a) => a.isBank).map((a) => a.id);
  if (bankIds.length) {
    const foreign = await tx.bankAccount.findMany({
      where: { accountId: { in: bankIds }, entityId: { not: entity.id } },
      select: { accountId: true, entity: { select: { shortName: true } }, account: { select: { code: true, name: true } } },
    });
    for (const f of foreign) {
      const held = await tx.journalLine.aggregate({ where: { entityId: entity.id, accountId: f.accountId }, _sum: { debit: true, credit: true } });
      const balance = (held._sum.debit ?? 0n) - (held._sum.credit ?? 0n);
      const move = lines.filter((l) => l.accountId === f.accountId).reduce((s, l) => s + l.debit - l.credit, 0n);
      const clears = balance > 0n ? move < 0n && -move <= balance : balance < 0n ? move > 0n && move <= -balance : false;
      if (!clears) {
        throw new LedgerError(
          `Akun ${f.account.code} ${f.account.name} adalah rekening bank ${f.entity.shortName}, jadi tidak bisa dipakai di buku ${entity.shortName}. Untuk uang antar entitas pakai 1190 Piutang/Utang Antar Entitas di buku masing-masing.`,
        );
      }
    }
  }

  const sourceIds = [...new Set(lines.map((l) => l.sourceAccountId).filter((x): x is string => !!x))];
  if (sourceIds.length) {
    const sources = await tx.sourceAccount.findMany({ where: { id: { in: sourceIds } }, select: { entityId: true } });
    if (sources.length !== sourceIds.length || sources.some((s) => s.entityId !== entity.id)) {
      throw new LedgerError("Akun sumber tidak termasuk entitas ini");
    }
  }
  for (const l of lines) {
    if (!l.fx) continue;
    if (!isCurrency(l.fx.currency)) throw new LedgerError(`Mata uang ${l.fx.currency} belum didukung`);
    if (l.fx.currency === entity.functionalCurrency) throw new LedgerError("Baris valas harus dalam mata uang selain mata uang fungsional entitas");
    if (l.fx.amount < 0n) throw new LedgerError("Nominal valas tidak boleh negatif");
    // Revaluation (rule 6b): the functional value moves while the foreign balance doesn't — fx amount 0, rate = closing rate.
    if (l.fx.revaluation) {
      if (l.fx.amount !== 0n) throw new LedgerError("Baris revaluasi tidak mengubah saldo valas (nominal valas harus 0)");
      continue;
    }
    const expected = convertMinor(l.fx.amount, l.fx.currency, entity.functionalCurrency, l.fx.rate);
    const actual = l.debit + l.credit;
    const diff = expected > actual ? expected - actual : actual - expected;
    if (diff > 1n) throw new LedgerError(`Nominal ${actual} tidak sama dengan ${l.fx.amount} ${l.fx.currency} × kurs ${l.fx.rate}`);
  }

  const period = await getOrCreatePeriod(tx, entity.firmId, entity.clientId, input.date);
  if (period.status === "LOCKED") {
    throw new LedgerError(`Periode ${formatPeriod(period.year, period.month)} sudah ditutup`);
  }

  return tx.journalEntry.create({
    data: {
      firmId: entity.firmId,
      entityId: entity.id,
      periodId: period.id,
      date: input.date,
      kind: input.kind,
      memo: input.memo,
      bankTransactionId: input.bankTransactionId,
      ledgerImportId: input.ledgerImportId,
      sourceRef: input.sourceRef,
      scheduleId: input.scheduleId,
      installment: input.installment,
      reversesId: input.reversesId,
      postedById: input.actorId ?? null,
      lines: {
        create: lines.map((l) => ({
          firmId: entity.firmId,
          entityId: entity.id,
          accountId: l.accountId,
          date: input.date,
          debit: l.debit,
          credit: l.credit,
          memo: l.memo,
          sourceAccountId: l.sourceAccountId,
          sourceRef: l.sourceRef,
          currency: l.fx?.currency ?? null,
          fxAmount: l.fx?.amount ?? null,
          fxRate: l.fx?.rate ?? null,
        })),
      },
    },
    include: { lines: true },
  });
}
