import type { Db } from "@/lib/db";
import { postJournal, type PostLine } from "@/lib/ledger/post";
import { formatDate } from "@/lib/format";
import { parseMoney } from "@/lib/money";
import { ACCOUNT_CODES } from "@/lib/coa/template";
import { templateAccounts } from "@/lib/coa/ensure";
import { closeLock } from "@/lib/adjust/schedules";
import { findingLabel, openFinding, openingQuestion } from "@/lib/findings";

/**
 * Saldo awal (accounting-rules §5): one OPENING entry per entity, posted through postJournal().
 * No plug (ADR 0012): a difference between the typed lines goes to 3290 Selisih Saldo Awal and opens a Temuan in the same
 * transaction; Saldo Laba (3200) is a line the accountant types. Bank lines are prefilled from the earliest imported statement's
 * opening balance, so bank recon holds.
 */
export class OpeningError extends Error {}

export type OpeningLineInput = { accountCode: string; debit: string; credit: string };

export async function openingContext(db: Db, clientId: string) {
  const entities = await db.entity.findMany({
    where: { clientId },
    include: { bankAccounts: { include: { account: true, imports: { orderBy: { periodStart: "asc" }, take: 1 } } } },
  });
  const openings = await db.journalEntry.findMany({
    where: { entityId: { in: entities.map((e) => e.id) }, kind: "OPENING" },
    include: { lines: { include: { account: true } } },
    // The Saldo Awal itself first; a Temuan's resolution is a later OPENING entry on the same date.
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });
  const firstTx = await db.bankTransaction.groupBy({ by: ["entityId"], where: { entityId: { in: entities.map((e) => e.id) } }, _min: { date: true } });
  // Loan principal moving in the statements means a loan existed (or started): its balance at the opening date belongs in Saldo Awal.
  const loanRows = await db.bankTransaction.groupBy({
    by: ["entityId"],
    where: { entityId: { in: entities.map((e) => e.id) }, OR: [{ suggestedCode: ACCOUNT_CODES.BANK_LOAN }, { accountCode: ACCOUNT_CODES.BANK_LOAN }] },
    _count: true,
  });
  const imports = await db.statementImport.findMany({
    where: { bankAccount: { entityId: { in: entities.map((e) => e.id) } } },
    select: { fileName: true, deposits: true, periodStart: true, bankAccount: { select: { entityId: true } } },
    orderBy: { createdAt: "asc" },
  });

  // An entity without statements of its own (the owner, a company kept from a ledger file) starts with the group: the earliest Saldo Awal
  // or first statement of its siblings, so a combined report never holds one entity's opening months after the others'.
  const groupStart = [
    ...openings.map((o) => o.date),
    ...entities.flatMap((e) => e.bankAccounts.flatMap((b) => b.imports)).map((i) => new Date(+i.periodStart - 86_400_000)),
  ].sort((x, y) => +x - +y)[0];

  return entities
    .sort((a, b) => Number(a.kind === "PERORANGAN") - Number(b.kind === "PERORANGAN")) // companies first
    .map((e) => {
      const firstImport = e.bankAccounts.flatMap((b) => b.imports).sort((x, y) => +x.periodStart - +y.periodStart)[0];
      const firstDate = firstTx.find((t) => t.entityId === e.id)?._min.date ?? null;
      const suggested = firstImport ? new Date(+firstImport.periodStart - 86_400_000) : (groupStart ?? lastDayOfPreviousMonth());
      const existing = openings.find((o) => o.entityId === e.id);
      return {
        entity: { id: e.id, name: e.name, shortName: e.shortName },
        existing: existing && {
          date: existing.date,
          lines: existing.lines.map((l) => ({ code: l.account.code, name: l.account.name, debit: l.debit, credit: l.credit })),
        },
        firstTransactionDate: firstDate,
        // Only deposits evidenced at the opening date: those listed on the entity's earliest statement period. A deposit placed
        // later is a movement in the statements, not an opening balance.
        deposits: depositsOf(
          imports.filter((i) => i.bankAccount.entityId === e.id && firstImport && +i.periodStart === +firstImport.periodStart),
          e.functionalCurrency,
        ),
        loanRows: loanRows.find((l) => l.entityId === e.id)?._count ?? 0,
        suggestedDate: suggested,
        banks: e.bankAccounts
          .sort((a, b) => a.account.code.localeCompare(b.account.code))
          .map((b) => ({
            accountCode: b.account.code,
            label: `${b.label} · ${b.number}`,
            isOverdraft: b.isOverdraft,
            statementOpening: b.imports[0]?.openingBalance ?? null,
            source: b.imports[0] ? `Saldo awal di ${b.imports[0].fileName} (${formatDate(b.imports[0].periodStart)})` : null,
          })),
      };
    });
}

export type OpeningDeposit = { number: string; amount: bigint; note: string };

/** Time deposits the entity's statements list, once per deposit number, in the entity's currency only (IDR books, IDR deposits). */
function depositsOf(imports: { fileName: string; deposits: unknown }[], currency: string): OpeningDeposit[] {
  const out = new Map<string, OpeningDeposit>();
  for (const imp of imports) {
    for (const d of Array.isArray(imp.deposits) ? (imp.deposits as Record<string, unknown>[]) : []) {
      const number = String(d.number ?? "");
      if (!number || out.has(number) || d.currency !== currency || currency !== "IDR" || !/^\d+$/.test(String(d.idrBalance ?? ""))) continue;
      const bits = [d.maturity ? `jatuh tempo ${formatDate(new Date(`${d.maturity}T00:00:00Z`))}` : null, d.rate ? `bunga ${d.rate}` : null].filter(Boolean);
      out.set(number, { number, amount: BigInt(String(d.idrBalance)), note: `${d.product ?? "Deposito"} ${number} di ${imp.fileName}${bits.length ? ` (${bits.join(", ")})` : ""}` });
    }
  }
  return [...out.values()];
}

function lastDayOfPreviousMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
}

export async function postOpening(db: Db, input: { clientId: string; entityId: string; date: Date; lines: OpeningLineInput[]; actorId?: string | null }) {
  const entity = await db.entity.findFirst({ where: { id: input.entityId, clientId: input.clientId } });
  if (!entity) throw new OpeningError("Entitas tidak ditemukan.");
  const existing = await db.journalEntry.findFirst({ where: { entityId: entity.id, kind: "OPENING" } });
  if (existing) throw new OpeningError(`Saldo awal ${entity.shortName} sudah dicatat per ${formatDate(existing.date)}. Koreksi lewat Jurnal Penyesuaian.`);
  const first = await db.bankTransaction.findFirst({ where: { entityId: entity.id }, orderBy: { date: "asc" } });
  if (first && +input.date >= +first.date) {
    throw new OpeningError(`Tanggal saldo awal harus sebelum transaksi bank pertama (${formatDate(first.date)}).`);
  }
  // A journal already typed on or before that date would sit inside the balances being entered (lib/ledger/opening-date.ts).
  const typed = await db.journalEntry.findFirst({ where: { entityId: entity.id, date: { lte: input.date } }, orderBy: { date: "asc" }, select: { date: true, memo: true } });
  if (typed) throw new OpeningError(`Tanggal saldo awal harus sebelum jurnal pertama entitas ini (${formatDate(typed.date)}: ${typed.memo}).`);

  const accounts = new Map((await db.account.findMany({ where: { clientId: input.clientId } })).map((a) => [a.code, a]));
  const lines: PostLine[] = [];
  let debit = 0n;
  let credit = 0n;
  for (const l of input.lines) {
    // Typed in major units of the entity's currency; an unreadable amount throws MoneyError with an example in it.
    const dr = parseMoney(l.debit, entity.functionalCurrency);
    const cr = parseMoney(l.credit, entity.functionalCurrency);
    if (dr === 0n && cr === 0n) continue;
    const acc = accounts.get(l.accountCode);
    if (!acc) throw new OpeningError("Pilih akun untuk setiap baris yang berisi nominal.");
    // Saldo Awal is a position at a date: a result earned before it sits in Saldo Laba. An income or expense balance here would be a flow
    // before the books start, counted in a Laba Rugi labelled from the day after (cycle 2026-10-20-paritas-inti).
    if (acc.type === "PENDAPATAN" || acc.type === "BEBAN") {
      throw new OpeningError(`${acc.code} ${acc.name} adalah akun laba rugi. Saldo awal berisi posisi neraca: masukkan laba (rugi) sampai tanggal ini ke ${ACCOUNT_CODES.RETAINED} Saldo Laba, atau impor buku besar klien untuk laba rugi setahun penuh.`);
    }
    lines.push({ accountId: acc.id, debit: dr, credit: cr });
    debit += dr;
    credit += cr;
  }
  if (lines.length === 0) throw new OpeningError("Isi minimal satu saldo.");
  if (lines.some((l) => l.accountId === accounts.get(ACCOUNT_CODES.OPENING_DIFFERENCE)?.id)) {
    throw new OpeningError("3290 Selisih Saldo Awal diisi otomatis dari selisihnya. Hapus baris itu.");
  }

  return db.$transaction(async (tx) => {
    // Two saves at once must not post two Saldo Awal (and two Temuan): checked again under the client's lock.
    await closeLock(tx, input.clientId);
    const raced = await tx.journalEntry.findFirst({ where: { entityId: entity.id, kind: "OPENING" } });
    if (raced) throw new OpeningError(`Saldo awal ${entity.shortName} sudah dicatat per ${formatDate(raced.date)}. Koreksi lewat Jurnal Penyesuaian.`);
    // The difference as it sits on 3290: typed debits above credits leave a credit there (negative), and the other way round.
    const difference = credit - debit;
    if (difference !== 0n) {
      const diffAccountId = (await templateAccounts(tx, input.clientId, [ACCOUNT_CODES.OPENING_DIFFERENCE])).get(ACCOUNT_CODES.OPENING_DIFFERENCE)!;
      const memo = "Selisih saldo awal, menunggu keputusan (Temuan)";
      lines.push(difference > 0n ? { accountId: diffAccountId, debit: difference, memo } : { accountId: diffAccountId, credit: -difference, memo });
    }
    const entry = await postJournal(tx, { entityId: entity.id, date: input.date, kind: "OPENING", memo: `Saldo awal per ${formatDate(input.date)}`, lines, actorId: input.actorId });
    const finding =
      difference !== 0n
        ? await openFinding(tx, {
            clientId: input.clientId,
            entityId: entity.id,
            kind: "OPENING_DIFFERENCE",
            date: input.date,
            amount: difference,
            question: openingQuestion(entity.shortName, input.date, difference, entity.functionalCurrency),
            sourceEntryId: entry.id,
            actorId: input.actorId,
          })
        : null;
    return { entry, finding: finding && { id: finding.id, label: findingLabel(finding.number), amount: finding.amount } };
  });
}
