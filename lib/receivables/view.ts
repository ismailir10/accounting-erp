import type { Db } from "@/lib/db";
import type { InvoiceDirection } from "@/lib/generated/prisma/enums";
import { BUCKETS, agingByContact, invoicesAt, openingDates, subledgerFrom, subledgerVsLedger, type Bucket } from "@/lib/receivables/aging";
import { settleCandidates } from "@/lib/receivables/settle";
import { formatDate } from "@/lib/format";

/** Serialisable views for the Piutang & Utang page (bigint as string across the server → client boundary, rule 6). */

export type InvoiceView = {
  id: string;
  entityId: string;
  entity: string;
  currency: string;
  contact: string;
  number: string;
  issued: string;
  due: string;
  description: string;
  total: string;
  settled: string;
  open: string;
  daysPastDue: number;
  bucket: Bucket;
  opening: boolean;
  entryId: string | null;
  arApCode: string;
  /** Tax the counterparty withholds, and the part still expected (major-unit strings via bigint). */
  whtKind: string | null;
  whtExpected: string;
  settlements: { id: string; amount: string; withheld: string; date: string; description: string }[];
};
export type AgingView = {
  entityId: string;
  entity: string;
  currency: string;
  /**
   * `advance`: the contact's unmatched cash (uang muka / kelebihan bayar); `net` = total − advance; `credit`: they paid more than they owe.
   * `limit`: the customer's credit limit, on Piutang of a Rupiah company only; `over`: net above it (cycle 2026-10-17-pengingat-piutang).
   */
  rows: { contactId: string; contact: string; buckets: Record<Bucket, string>; total: string; count: number; advance: string; net: string; credit: boolean; limit: string | null; over: boolean }[];
  totals: Record<Bucket, string> & { total: string; advance: string; net: string };
  /** Cash on the accounts not allocated to anyone yet, and how many bank lines. */
  unallocated: string;
  unallocatedLines: number;
};
export type ComparisonView = { entityId: string; entity: string; currency: string; accounts: string[]; subledger: string; ledger: string; unsettledLines: number; equal: boolean };
export type UnsettledLineView = { id: string; entityId: string; entity: string; currency: string; date: string; description: string; free: string; accountCode: string; /** The contact this line was matched for: its unmatched rest is their advance (UC-B5). */ contact: { id: string; name: string } | null; /** Money the other way on the account (a refund to a customer, from a supplier): tagged, never settled. */ refund: boolean; /** A split line: only its part here, tagged, never settled. */ split: boolean };
/** A document taken out (UC-B5): listed struck through with its reason; it counts nowhere. */
export type VoidedView = { id: string; entity: string; currency: string; contact: string; number: string; issued: string; total: string; opening: boolean; reason: string; voidedAt: string; by: string | null };
export type CandidateView = { bankTransactionId: string; date: string; description: string; free: string; exact: boolean; named: boolean; onAccount: boolean; advance: boolean };

export async function receivablesView(db: Db, clientId: string, direction: InvoiceDirection, asOf: Date, entities: { id: string; shortName: string; functionalCurrency: string; kind: string }[]) {
  const ids = entities.map((e) => e.id);
  const ent = new Map(entities.map((e) => [e.id, e]));
  const [items, comparisons, contactRows] = await Promise.all([
    invoicesAt(db, clientId, direction, asOf, ids),
    subledgerVsLedger(db, clientId, direction, asOf, ids),
    db.contact.findMany({ where: { clientId }, select: { id: true, name: true, creditLimit: true }, orderBy: { name: "asc" } }),
  ]);
  const limits = new Map(contactRows.flatMap((c) => (c.creditLimit !== null ? [[c.id, c.creditLimit] as const] : [])));
  const settlements = await db.invoiceSettlement.findMany({
    where: { invoiceId: { in: items.map((i) => i.id) }, bankTransaction: { date: { lte: asOf } } },
    include: { bankTransaction: { select: { date: true, description: true } } },
    orderBy: { bankTransaction: { date: "asc" } },
  });
  const invoices: InvoiceView[] = items
    .map((i) => ({
      id: i.id,
      entityId: i.entityId,
      entity: ent.get(i.entityId)!.shortName,
      currency: ent.get(i.entityId)!.functionalCurrency,
      contact: i.contact.name,
      number: i.number,
      issued: formatDate(i.issueDate),
      due: formatDate(i.dueDate),
      description: i.description,
      total: i.total.toString(),
      settled: i.settled.toString(),
      open: i.open.toString(),
      daysPastDue: i.daysPastDue,
      bucket: i.bucket,
      opening: i.opening,
      entryId: i.entryId,
      arApCode: i.arApCode,
      whtKind: i.whtKind,
      whtExpected: (i.whtExpected > 0n ? i.whtExpected : 0n).toString(),
      settlements: settlements.filter((s) => s.invoiceId === i.id).map((s) => ({ id: s.id, amount: s.amount.toString(), withheld: s.withheld.toString(), date: formatDate(s.bankTransaction.date), description: s.bankTransaction.description })),
    }))
    // Open first (oldest due first), then paid (latest first).
    .sort((a, b) => Number(BigInt(b.open) > 0n) - Number(BigInt(a.open) > 0n) || (BigInt(a.open) > 0n ? b.daysPastDue - a.daysPastDue : 0));
  const ordered = [...entities].sort((a, b) => Number(a.kind === "PERORANGAN") - Number(b.kind === "PERORANGAN"));
  const zero = () => Object.fromEntries(BUCKETS.map((b) => [b, 0n])) as Record<Bucket, bigint>;
  const aging: AgingView[] = ordered
    .map((e) => {
      const cmp = comparisons.find((c) => c.entityId === e.id);
      const open = agingByContact(items.filter((i) => i.entityId === e.id));
      // A contact with only an advance (nothing open) still has a row: their credit.
      const advance = new Map((cmp?.contacts ?? []).filter((c) => c.advance !== 0n).map((c) => [c.contact.id, c]));
      const rows = [
        ...open.map((r) => ({ ...r, advance: advance.get(r.contact.id)?.advance ?? 0n })),
        ...[...advance.values()].filter((c) => !open.some((r) => r.contact.id === c.contact.id)).map((c) => ({ contact: c.contact, buckets: zero(), total: 0n, count: 0, advance: c.advance })),
      ];
      const sum = (f: (r: (typeof rows)[number]) => bigint) => rows.reduce((t, r) => t + f(r), 0n);
      const totals = Object.fromEntries(BUCKETS.map((b) => [b, sum((r) => r.buckets[b]).toString()])) as Record<Bucket, string>;
      // A credit limit is a Rupiah figure for customers: it applies to Piutang of companies whose books are in Rupiah only.
      const limited = direction === "SALES" && e.functionalCurrency === "IDR";
      return {
        entityId: e.id,
        entity: e.shortName,
        currency: e.functionalCurrency,
        rows: rows.map((r) => {
          const limit = limited ? (limits.get(r.contact.id) ?? null) : null;
          return {
            contactId: r.contact.id,
            contact: r.contact.name,
            buckets: Object.fromEntries(BUCKETS.map((b) => [b, r.buckets[b].toString()])) as Record<Bucket, string>,
            total: r.total.toString(),
            count: r.count,
            advance: r.advance.toString(),
            net: (r.total - r.advance).toString(),
            credit: r.advance > r.total,
            limit: limit?.toString() ?? null,
            over: limit !== null && r.total - r.advance > limit,
          };
        }),
        totals: { ...totals, total: sum((r) => r.total).toString(), advance: sum((r) => r.advance).toString(), net: sum((r) => r.total - r.advance).toString() },
        unallocated: (cmp?.unallocated ?? 0n).toString(),
        unallocatedLines: cmp?.unsettledLines ?? 0,
      };
    })
    .filter((a) => a.rows.length > 0);
  const comparison: ComparisonView[] = comparisons.map((c) => ({ entityId: c.entityId, entity: ent.get(c.entityId)!.shortName, currency: ent.get(c.entityId)!.functionalCurrency, accounts: c.accounts, subledger: c.subledger.toString(), ledger: c.ledger.toString(), unsettledLines: c.unsettledLines, equal: c.equal }));

  // Bank lines on the receivable/payable accounts not (fully) matched to an invoice yet.
  const codes = [...new Set([...comparisons.flatMap((c) => c.accounts), direction === "SALES" ? "1130" : "2110"])];
  const lines = await db.bankTransaction.findMany({
    where: { entityId: { in: ids }, date: { lte: asOf }, status: { not: "NEEDS_REVIEW" }, OR: [{ accountCode: { in: codes }, splits: { none: {} } }, { splits: { some: { accountCode: { in: codes } } } }] },
    include: { settlements: { select: { amount: true, withheld: true, invoice: { select: { entityId: true, issueDate: true, opening: true } } } }, contact: { select: { id: true, name: true } }, splits: { select: { accountCode: true, amount: true } } },
    orderBy: [{ date: "asc" }, { rowNumber: "asc" }],
  });
  const settling = direction === "SALES" ? "IN" : "OUT";
  // A settlement counts from the date its document entered the subledger: at a past date, an advance that paid a later invoice was free.
  const lineOpenings = await openingDates(db, ids);
  const settledBy = (x: (typeof lines)[number]["settlements"][number]) => +subledgerFrom(x.invoice, lineOpenings) <= +asOf;
  const unsettled: UnsettledLineView[] = lines
    .map((t) => ({
      t,
      // Cash still free on the line (a split line: its part on these accounts, never settled).
      free: t.splits.length ? t.splits.filter((p) => codes.includes(p.accountCode)).reduce((u, p) => u + p.amount, 0n) : (t.amount < 0n ? -t.amount : t.amount) - t.settlements.filter(settledBy).reduce((u, x) => u + x.amount - x.withheld, 0n),
    }))
    .filter((x) => x.free > 0n)
    .map(({ t, free }) => ({
      id: t.id,
      entityId: t.entityId,
      entity: ent.get(t.entityId)!.shortName,
      currency: ent.get(t.entityId)!.functionalCurrency,
      date: formatDate(t.date),
      description: t.description,
      free: free.toString(),
      accountCode: t.splits.length ? t.splits.filter((p) => codes.includes(p.accountCode)).map((p) => p.accountCode).join(", ") : (t.accountCode ?? ""),
      contact: t.contact,
      refund: t.direction !== settling,
      split: t.splits.length > 0,
    }));
  const voidedRows = await db.invoice.findMany({
    where: { clientId, direction, entityId: { in: ids }, voidedAt: { not: null }, issueDate: { lte: asOf } },
    include: { contact: { select: { name: true } }, voidedBy: { select: { name: true } } },
    orderBy: { voidedAt: "desc" },
  });
  const voided: VoidedView[] = voidedRows.map((i) => ({
    id: i.id,
    entity: ent.get(i.entityId)!.shortName,
    currency: ent.get(i.entityId)!.functionalCurrency,
    contact: i.contact.name,
    number: i.number,
    issued: formatDate(i.issueDate),
    total: i.total.toString(),
    opening: i.opening,
    reason: i.voidReason ?? "",
    voidedAt: formatDate(i.voidedAt!),
    by: i.voidedBy?.name ?? null,
  }));
  const contacts = contactRows.map((c) => c.name);
  return { invoices, voided, aging, comparison, unsettled, contacts, contactOptions: contactRows.map((c) => ({ id: c.id, name: c.name })) };
}

export async function candidateViews(db: Db, clientId: string, invoiceId: string): Promise<CandidateView[]> {
  return (await settleCandidates(db, clientId, invoiceId)).slice(0, 30).map((c) => ({ bankTransactionId: c.bankTransactionId, date: formatDate(c.date), description: c.description, free: c.free.toString(), exact: c.exact, named: c.named, onAccount: c.onAccount, advance: c.advance }));
}

