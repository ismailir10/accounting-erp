import type { Db } from "@/lib/db";
import type { EntryKind } from "@/lib/generated/prisma/enums";
import type { Prisma } from "@/lib/generated/prisma/client";
import { MoneyError, parseMoney } from "@/lib/money";
import { ENTRY_SOURCE_SELECT, entrySource } from "@/lib/reports/entry-source";
import { entryOrigins } from "@/lib/reports/entry-origin";
import { approvalLines } from "@/lib/approvals/pending";
import type { Scope } from "@/lib/reports/ledger";

/** The kinds Jurnal Umum filters by (`?jenis=`). A bank line's later reclassification belongs with the bank lines. */
export const KIND_FILTERS: { value: string; label: string; kinds: EntryKind[] | null }[] = [
  { value: "semua", label: "Semua jenis", kinds: null },
  { value: "bank", label: "Mutasi bank", kinds: ["BANK", "RECLASS"] },
  { value: "penyesuaian", label: "Penyesuaian", kinds: ["ADJUSTMENT"] },
  { value: "saldo-awal", label: "Saldo awal", kinds: ["OPENING"] },
  { value: "impor", label: "Impor buku besar", kinds: ["IMPORTED"] },
  { value: "faktur", label: "Faktur & dokumen", kinds: ["INVOICE"] },
];

export const parseKindFilter = (v: unknown) => KIND_FILTERS.find((k) => k.value === v) ?? KIND_FILTERS[0];

/**
 * What a search box text looks for: always the text itself (memo, bank row, account code or name), and — when it reads as an amount in
 * the scope's currency ("1.250.000", "Rp 1.250.000", "1250000") — lines of exactly that amount on either side.
 */
export function parseSearch(q: string | undefined, currency: string): { text: string; amount: bigint | null } | null {
  const text = (q ?? "").trim().slice(0, 100);
  if (!text) return null;
  let amount: bigint | null = null;
  if (/\d/.test(text) && /^[\s\d.,()+-]*$/.test(text.replace(/^rp\.?/i, ""))) {
    try {
      const v = parseMoney(text, currency);
      amount = v === 0n ? null : v < 0n ? -v : v;
    } catch (e) {
      if (!(e instanceof MoneyError)) throw e;
    }
  }
  return { text, amount };
}

export type RegisterFilter = { start: Date; end: Date; kinds: EntryKind[] | null; search: { text: string; amount: bigint | null } | null };

function entryWhere(scope: Scope, f: RegisterFilter): Prisma.JournalEntryWhereInput {
  const contains = (s: string) => ({ contains: s, mode: "insensitive" as const });
  return {
    entityId: { in: scope.entityIds },
    date: { gte: f.start, lte: f.end },
    ...(f.kinds ? { kind: { in: f.kinds } } : {}),
    ...(f.search
      ? {
          OR: [
            { memo: contains(f.search.text) },
            { sourceRef: contains(f.search.text) },
            { bankTransaction: { description: contains(f.search.text) } },
            { lines: { some: { OR: [{ account: { code: f.search.text } }, { account: { name: contains(f.search.text) } }, { memo: contains(f.search.text) }] } } },
            ...(f.search.amount !== null ? [{ lines: { some: { OR: [{ debit: f.search.amount }, { credit: f.search.amount }] } } }] : []),
          ],
        }
      : {}),
  };
}

export type RegisterLine = { code: string; name: string; memo: string | null; debit: bigint; credit: bigint };
export type RegisterEntry = {
  id: string;
  date: Date;
  entity: string;
  kind: EntryKind;
  memo: string;
  source: string | null;
  /** The proposal it was approved from (lib/reports/entry-origin.ts), if any. */
  origin: string | null;
  postedBy: string;
  postedAt: Date;
  /** Persetujuan kedua: "Diajukan <maker> · Disetujui <approver>" when it came through a second approver. */
  approval?: string | null;
  /** The date of the journal that reversed this one (*Balik jurnal*), if any. */
  reversedOn: Date | null;
  lines: RegisterLine[];
};

const PAGE_SIZE = 50;

/**
 * Jurnal Umum: the journals of a scope and range in date order (then posting order), filtered by kind and search, each with its lines
 * (debits first) and its source. `count` and the totals cover the whole filter; `entries` is one page of `PAGE_SIZE` (or every entry
 * with `page: "all"`, for the Excel export). Read-only: derived from the journal tables at read time (accounting-rules 1).
 */
export async function journalRegister(db: Db, scope: Scope, f: RegisterFilter, page: number | "all" = 1) {
  const where = entryWhere(scope, f);
  const [count, totals, rows] = await Promise.all([
    db.journalEntry.count({ where }),
    db.journalLine.aggregate({ where: { entry: where }, _sum: { debit: true, credit: true } }),
    db.journalEntry.findMany({
      where,
      orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      ...(page === "all" ? {} : { skip: (Math.max(1, page) - 1) * PAGE_SIZE, take: PAGE_SIZE }),
      select: {
        id: true,
        date: true,
        memo: true,
        createdAt: true,
        reversesId: true,
        entity: { select: { shortName: true } },
        postedBy: { select: { name: true } },
        reversedBy: { select: { date: true } },
        lines: { select: { debit: true, credit: true, memo: true, account: { select: { code: true, name: true } } }, orderBy: { id: "asc" } },
        ...ENTRY_SOURCE_SELECT,
      },
    }),
  ]);
  const [origins, approvals] = await Promise.all([entryOrigins(db, rows.map((e) => e.id)), approvalLines(db, rows)]);
  const entries: RegisterEntry[] = rows.map((e) => ({
    id: e.id,
    date: e.date,
    entity: e.entity.shortName,
    kind: e.kind,
    memo: e.memo,
    source: entrySource(e),
    origin: origins.get(e.id) ?? null,
    postedBy: e.postedBy?.name ?? "Sistem",
    postedAt: e.createdAt,
    approval: approvals.get(e.id) ?? null,
    reversedOn: e.reversedBy?.date ?? null,
    lines: [...e.lines]
      .sort((a, b) => Number(b.debit > 0n) - Number(a.debit > 0n))
      .map((l) => ({ code: l.account.code, name: l.account.name, memo: l.memo, debit: l.debit, credit: l.credit })),
  }));
  return { count, debit: totals._sum.debit ?? 0n, credit: totals._sum.credit ?? 0n, entries, pageSize: PAGE_SIZE, pages: Math.max(1, Math.ceil(count / PAGE_SIZE)) };
}
