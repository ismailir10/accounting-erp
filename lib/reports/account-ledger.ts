import type { Db } from "@/lib/db";
import { fiscalEndMonthOfEntities, fiscalYearStart } from "@/lib/fiscal";
import type { AccountType, NormalBalance } from "@/lib/generated/prisma/enums";
import type { LedgerRow } from "@/components/app/ledger-table";
import { formatDate, formatDateTime, toIsoDate } from "@/lib/format";
import { REVERSAL_OWNERS, reversalBlocker } from "@/lib/ledger/reverse";
import { formatMoney } from "@/lib/money";
import { formatRateId } from "@/lib/fx/currency";
import { sourceAccountLabel } from "@/lib/ledger-import/code";
import { entryOrigins } from "@/lib/reports/entry-origin";
import { approvalLines } from "@/lib/approvals/pending";

/**
 * One account's ledger for a month: opening balance, lines with running balance, and the source behind each line
 * (bank row, or file `sheet!row`). Either a Buku account (`accountId`) or one of the client's own accounts
 * (`sourceAccountId`). Balances follow `normalBalance`. The opening follows each posted line's own account, as the TBs do:
 * income & expense lines count from the start of the client's financial year (1 January for a calendar year; earlier years sit in the
 * prior-year result), balance-sheet lines from the start. Saldo laba (`isRetained`) opens with those earlier years' result folded in, as
 * the trial balance and the Excel Buku Besar fold it (`priorYearProfit`, in the account's normal direction), so a drill-down shows the
 * same number.
 */
export async function accountLedger(
  db: Db,
  args: { entityIds: string[]; start: Date; end: Date; normalBalance: NormalBalance } & ({ accountId: string } | { sourceAccountId: string }),
): Promise<{ opening: bigint; priorYearProfit: bigint; rows: LedgerRow[] }> {
  const which = "accountId" in args ? { accountId: args.accountId } : { sourceAccountId: args.sourceAccountId };
  const PL: AccountType[] = ["PENDAPATAN", "BEBAN"];
  const yearStart = fiscalYearStart(await fiscalEndMonthOfEntities(db, args.entityIds), args.start);
  const before = await db.journalLine.aggregate({
    where: {
      ...which,
      entityId: { in: args.entityIds },
      date: { lt: args.start },
      OR: [{ account: { type: { notIn: PL } } }, { account: { type: { in: PL } }, date: { gte: yearStart } }],
    },
    _sum: { debit: true, credit: true },
  });
  const retained = "accountId" in args && (await db.account.findUnique({ where: { id: args.accountId }, select: { isRetained: true, clientId: true } }));
  const priorPl = retained && retained.isRetained
    ? await db.journalLine.aggregate({ where: { entityId: { in: args.entityIds }, date: { lt: yearStart }, account: { clientId: retained.clientId, type: { in: PL } } }, _sum: { debit: true, credit: true } })
    : null;
  const lines = await db.journalLine.findMany({
    where: { ...which, entityId: { in: args.entityIds }, date: { gte: args.start, lte: args.end } },
    include: {
      entry: {
        include: {
          entity: true,
          lines: { include: { account: true } },
          bankTransaction: { include: { import: true, bankAccount: true, splits: { orderBy: { position: "asc" } } } },
          ledgerImport: { select: { fileName: true } },
          postedBy: { select: { name: true } },
          ...REVERSAL_OWNERS,
        },
      },
      sourceAccount: { select: { code: true, name: true } },
    },
    orderBy: [{ date: "asc" }, { entry: { createdAt: "asc" } }],
  });
  // The other half of a transfer pair, named in the drawer next to *Lepas pasangan* (UC-B2).
  const pairIds = [...new Set(lines.map((l) => l.entry.bankTransaction?.matchedTxId).filter((x): x is string => !!x))];
  const pairs = new Map(
    (await db.bankTransaction.findMany({ where: { id: { in: pairIds } }, include: { bankAccount: { include: { entity: { select: { shortName: true } } } } } })).map((p) => [
      p.id,
      `${p.bankAccount.entity.shortName} · ${p.bankAccount.label} · ${formatDate(p.date)} · ${formatMoney(p.amount < 0n ? -p.amount : p.amount, p.bankAccount.currency)} · ${p.description}`,
    ]),
  );
  // Each bank line's own change history (ADR 0013), shown in its drawer.
  const txIds = [...new Set(lines.map((l) => l.entry.bankTransaction?.id).filter((x): x is string => !!x))];
  const history = new Map<string, { at: string; actor: string; summary: string }[]>();
  if (txIds.length) {
    const events = await db.auditEvent.findMany({ where: { entityId: { in: args.entityIds }, subject: { in: txIds.map((id) => `bankTx:${id}`) } }, include: { actor: { select: { name: true } } }, orderBy: { createdAt: "desc" } });
    for (const e of events) {
      const id = e.subject.slice("bankTx:".length);
      history.set(id, [...(history.get(id) ?? []), { at: formatDateTime(e.createdAt), actor: e.actor?.name ?? "Sistem", summary: e.summary }]);
    }
  }
  // The proposal an entry was approved from (Kotak persetujuan), shown in its drawer.
  const origins = await entryOrigins(db, lines.map((l) => l.entryId));
  // Persetujuan kedua: who asked and who approved, instead of only who posted.
  const approvals = await approvalLines(db, [...new Map(lines.map((l) => [l.entryId, { id: l.entryId, reversesId: l.entry.reversesId }])).values()]);
  const sign = args.normalBalance === "DEBIT" ? 1n : -1n;
  const priorYearProfit = ((priorPl?._sum.debit ?? 0n) - (priorPl?._sum.credit ?? 0n)) * sign;
  const opening = ((before._sum.debit ?? 0n) - (before._sum.credit ?? 0n)) * sign + priorYearProfit;
  const balances = lines.reduce<bigint[]>((acc, l) => [...acc, (acc.at(-1) ?? opening) + (l.debit - l.credit) * sign], []);
  const rows: LedgerRow[] = lines.map((l, idx) => {
    const t = l.entry.bankTransaction;
    return {
      id: l.id,
      date: formatDate(l.date),
      entity: l.entry.entity.shortName,
      memo: l.entry.memo,
      kind: l.entry.kind,
      postedBy: `${l.entry.postedBy?.name ?? "Sistem"} · ${formatDateTime(l.entry.createdAt)}`,
      approval: approvals.get(l.entryId) ?? null,
      origin: origins.get(l.entryId) ?? null,
      debit: l.debit.toString(),
      credit: l.credit.toString(),
      balance: balances[idx].toString(),
      entry: { lines: l.entry.lines.map((x) => ({ code: x.account.code, name: x.account.name, debit: x.debit.toString(), credit: x.credit.toString(), memo: x.memo })) },
      reversal: l.entry.kind === "ADJUSTMENT" ? { entryId: l.entry.id, blocker: reversalBlocker(l.entry), date: toIsoDate(l.entry.date) } : undefined,
      source: t
        ? { bankTxId: t.id, accountCode: t.accountCode, taxTag: t.taxTag, whtKind: t.whtKind, whtAmount: t.whtAmount.toString(), fileName: t.import.fileName, sheet: t.sourceSheet, rowNumber: t.rowNumber, rawRow: t.rawRow, description: t.description, amount: t.amount.toString(), bank: `${t.bankAccount.label} · ${t.bankAccount.number}`, method: t.method, reason: t.reason, status: t.status, pairedWith: t.matchedTxId ? (pairs.get(t.matchedTxId) ?? null) : null, history: history.get(t.id) ?? [], splits: t.splits.map((p) => ({ accountCode: p.accountCode, amount: p.amount.toString(), memo: p.memo })) }
        : null,
      fileSource: l.entry.ledgerImport
        ? {
            fileName: l.entry.ledgerImport.fileName,
            entryRef: l.entry.sourceRef ?? "",
            lineRef: l.sourceRef,
            sourceAccount: l.sourceAccount ? sourceAccountLabel(l.sourceAccount) : null,
            lineMemo: l.memo,
            fx: l.currency && l.fxAmount !== null && l.fxRate ? `${formatMoney(l.fxAmount, l.currency)} × kurs ${formatRateId(l.fxRate)}` : null,
          }
        : null,
    };
  });
  return { opening, priorYearProfit, rows };
}

const defaultNormal = (type: AccountType | null | undefined): NormalBalance => (type === "ASET" || type === "BEBAN" ? "DEBIT" : "CREDIT");

/** The one posted account a client account reads by: the earliest of the file's type, else the earliest (`posted` oldest first). */
export const postedBasis = <T extends { type: AccountType }>(posted: T[], typeHint: AccountType | null): T | undefined => posted.find((a) => a.type === typeHint) ?? posted[0];

/**
 * How a client account's ledger reads (normal side; whether it restarts on 1 January), taken from a Buku account its lines were
 * actually posted to: a later remap moves no posted line, so it must not reinterpret their history. That account is the earliest
 * posted one of the type in the client's file, else the earliest posted one, and it is the account the page links to. With nothing
 * posted, the current mapping decides.
 */
export async function sourceLedgerBasis(
  db: Db,
  src: { id: string; typeHint: AccountType | null; account: { code: string; name: string; type: AccountType; normalBalance: NormalBalance } | null },
  asOf?: Date,
): Promise<{ normalBalance: NormalBalance; isPL: boolean; account: { code: string; name: string } | null }> {
  // Only lines up to the report date count, the same horizon as the client-account TB row it drills from.
  const posted = (await db.journalLine.findMany({
    where: { sourceAccountId: src.id, ...(asOf ? { date: { lte: asOf } } : {}) },
    distinct: ["accountId"],
    orderBy: [{ date: "asc" }, { id: "asc" }],
    select: { account: { select: { code: true, name: true, type: true, normalBalance: true } } },
  })).map((l) => l.account);
  const basis = postedBasis(posted, src.typeHint);
  const type = basis?.type ?? src.account?.type ?? src.typeHint;
  const normalBalance = basis?.normalBalance ?? src.account?.normalBalance ?? defaultNormal(type);
  // The Buku account the row drills to: the posted basis for this period, the current mapping only when nothing was posted yet.
  const account = basis ?? src.account;
  return { normalBalance, isPL: type === "PENDAPATAN" || type === "BEBAN", account: account ? { code: account.code, name: account.name } : null };
}
