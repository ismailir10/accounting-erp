import type { Tx } from "@/lib/db";
import type { EntryKind } from "@/lib/generated/prisma/enums";
import { formatPeriod } from "@/lib/format";
import { convertMinor, isCurrency } from "@/lib/fx/currency";
import { nextNumber, numberPrefix } from "@/lib/ledger/number";

/**
 * The ONLY writer of JournalEntry/JournalLine. Enforces (accounting-rules):
 *  1. Σdebit = Σcredit, ≥ 2 lines, each line exactly one positive side (also DB CHECK)
 *  2. period open (locked periods reject every write), and no later month of the client locked: a journal dated before a closed month
 *     changes that month's Neraca (an earlier month may stay open only while it is empty, `lockPeriod`)
 *  3. every account belongs to the entity's client COA, is not archived (Arsip akun) and is not the entity's own intercompany account;
 *     every source account belongs to the entity; a line's department and project are the client's, of their kind, not archived
 *  4. foreign-currency lines: currency ≠ functional, round(fxAmount × fxRate) = amount ± 1 minor unit (rule 6b)
 * and gives the entry its nomor bukti (lib/ledger/number.ts) in the same transaction.
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
  /** Departemen & Proyek (lib/dimensions): labels for analysis, never a balance; one of each kind at most. */
  departmentId?: string | null;
  projectId?: string | null;
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
  /** Instalment of a Jurnal berulang (lib/adjust/recurring.ts): the template and its month (year × 100 + month); both or neither. */
  /** Lines a stored document already carried (an approved request): an archived tag on them still posts. */
  keepTags?: boolean;
  recurringId?: string;
  recurringMonth?: number;
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
  const out: (Required<Pick<PostLine, "accountId">> & { debit: bigint; credit: bigint; memo?: string; sourceAccountId: string | null; sourceRef: string | null; fx: PostLine["fx"]; departmentId: string | null; projectId: string | null })[] = [];
  for (const l of lines) {
    const debit = l.debit ?? 0n;
    const credit = l.credit ?? 0n;
    if (debit < 0n || credit < 0n) throw new LedgerError("Nominal debit/kredit tidak boleh negatif");
    if (debit > 0n && credit > 0n) throw new LedgerError("Satu baris jurnal hanya boleh debit ATAU kredit");
    if (debit === 0n && credit === 0n) continue;
    out.push({ accountId: l.accountId, debit, credit, memo: l.memo, sourceAccountId: l.sourceAccountId ?? null, sourceRef: l.sourceRef ?? null, fx: l.fx ?? null, departmentId: l.departmentId ?? null, projectId: l.projectId ?? null });
  }
  return out;
}

/** Every rule of postJournal() except the period (rules 1, 3, 4 above): the normalised lines and the entity, or a LedgerError. */
async function validate(tx: Tx, input: Pick<PostInput, "entityId" | "lines" | "reversesId" | "bankTransactionId" | "scheduleId" | "recurringId" | "keepTags">) {
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
  // Antar entitas per pihak: a company records what it owes or is owed by another on that company's account, never on its own.
  const own = accounts.find((a) => a.counterpartyEntityId === entity.id);
  if (own) throw new LedgerError(`Akun ${own.code} ${own.name} adalah akun antar entitas untuk ${entity.shortName} sendiri. Catat di akun pihak lawannya.`);
  const archived = accounts.find((a) => a.archivedAt);
  if (archived) throw new LedgerError(`Akun ${archived.code} ${archived.name} sudah diarsipkan. Aktifkan lagi di Bagan akun untuk memakainya.`);
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

  // Departemen & Proyek: the client's own, of the right kind, not archived.
  const dimIds = [...new Set(lines.flatMap((l) => [l.departmentId, l.projectId]).filter((x): x is string => !!x))];
  if (dimIds.length) {
    const dims = new Map((await tx.dimension.findMany({ where: { id: { in: dimIds } } })).map((d) => [d.id, d]));
    for (const l of lines) {
      for (const [id, kind] of [[l.departmentId, "DEPARTEMEN"], [l.projectId, "PROYEK"]] as const) {
        if (!id) continue;
        const d = dims.get(id);
        if (!d || d.clientId !== entity.clientId || d.kind !== kind) throw new LedgerError(kind === "DEPARTEMEN" ? "Departemen tidak termasuk klien ini." : "Proyek tidak termasuk klien ini.");
        // A reversal mirrors its original's tags (so the per-department Laba Rugi nets out) even after the tag was archived; a bank line's
        // re-posting keeps the tag the line carries (set while it was active: lib/review.ts `setBankTagsTx`), and a schedule's instalment the
        // tag the schedule carries (lib/adjust/schedules.ts), as do a Jurnal berulang instalment and an approved request (`keepTags`): a
        // tag stored while it was active. Archiving only stops new choices.
        if (d.archivedAt && !input.reversesId && !input.bankTransactionId && !input.scheduleId && !input.recurringId && !input.keepTags) throw new LedgerError(`${kind === "DEPARTEMEN" ? "Departemen" : "Proyek"} ${d.code} ${d.name} sudah diarsipkan. Aktifkan lagi di Pengaturan klien untuk memakainya.`);
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
  return { lines, entity, accounts };
}

const closed = (p: { year: number; month: number }) => new LedgerError(`Periode ${formatPeriod(p.year, p.month)} sudah ditutup`);

/** The first locked month after `year`/`month` of the client, if any: writing before it would change its balances. */
export async function lockedAfter(db: Pick<Tx, "period">, clientId: string, year: number, month: number) {
  return db.period.findFirst({
    where: { clientId, status: "LOCKED", OR: [{ year: { gt: year } }, { year, month: { gt: month } }] },
    orderBy: [{ year: "asc" }, { month: "asc" }],
    select: { year: true, month: true },
  });
}

const closedAfter = (p: { year: number; month: number }) =>
  new LedgerError(`${formatPeriod(p.year, p.month)} sudah ditutup, dan jurnal bertanggal sebelumnya mengubah saldo bulan itu. Buka kembali ${formatPeriod(p.year, p.month)} dulu di Tutup Buku.`);

/**
 * The same checks postJournal() makes, writing nothing: used where a journal is held back as a request (Persetujuan kedua) so the request
 * is refused now, not at approval, when it could never post. A month without a Period row yet is open.
 */
export async function checkJournal(tx: Tx, input: Pick<PostInput, "entityId" | "date" | "lines" | "reversesId" | "bankTransactionId" | "scheduleId" | "recurringId" | "keepTags">) {
  const { entity } = await validate(tx, input);
  const year = input.date.getUTCFullYear();
  const month = input.date.getUTCMonth() + 1;
  const period = await tx.period.findUnique({ where: { clientId_year_month: { clientId: entity.clientId, year, month } }, select: { status: true } });
  if (period?.status === "LOCKED") throw closed({ year, month });
  const later = await lockedAfter(tx, entity.clientId, year, month);
  if (later) throw closedAfter(later);
}

export async function postJournal(tx: Tx, input: PostInput) {
  const { lines, entity, accounts } = await validate(tx, input);
  const period = await getOrCreatePeriod(tx, entity.firmId, entity.clientId, input.date);
  if (period.status === "LOCKED") throw closed(period);
  const later = await lockedAfter(tx, entity.clientId, period.year, period.month);
  if (later) throw closedAfter(later);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const number = await nextNumber(tx, entity.id, numberPrefix(input.kind, lines.map((l) => ({ ...l, account: byId.get(l.accountId)! }))), input.date);

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
      recurringId: input.recurringId,
      recurringMonth: input.recurringMonth,
      reversesId: input.reversesId,
      postedById: input.actorId ?? null,
      number,
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
          departmentId: l.departmentId,
          projectId: l.projectId,
        })),
      },
    },
    include: { lines: true },
  });
}
