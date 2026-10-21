import type { Db, Tx } from "@/lib/db";
import { LedgerError } from "@/lib/ledger/post";
import { formatDate, formatPeriod, periodBounds } from "@/lib/format";
import { SOURCE_DIFFERENCE_MEMO } from "@/lib/ledger-import/post";
import { sourceSuspenseNet } from "@/lib/controls/suspense-net";
import { postProposal, proposalViews, saveProposal, type ProposalLine } from "@/lib/adjust/proposals";

/**
 * 1999 corrections (accounting-rules 15a / 20b): an accepted unbalanced ledger group left its difference on 1999. Each such line
 * gets a deterministic draft that reverses it on 1999 against a counter account — prefilled only when the same entry has exactly
 * one other line of that very amount — as long as 1999 still holds it (never reversed twice, e.g. after a manual fix). When no
 * single line fits what is left on 1999 (differences that offset each other, a partial fix), the entity gets one draft for the
 * remaining balance instead, so a FAIL always has a way out. Computed at read time; stored as a ProposedEntry only when posted.
 */

export const SUSPENSE_PREFIX = "suspense:";
/** Id of the remaining-balance correction: `net:<entityId>:<year>-<month>`. */
const NET = "net:";

export type SuspenseCorrection = {
  lineId: string;
  entity: { id: string; shortName: string; functionalCurrency: string };
  year: number;
  month: number;
  memo: string;
  reason: string;
  lines: ProposalLine[];
  /** The imported group it corrects (rule 15): the correction keeps its file and sheet!row. */
  origin: { ledgerImportId?: string; sourceRef?: string };
  /** Signed amount on 1999 (debit − credit) this correction takes off. */
  reverses: bigint;
  /** Proposal key: one per source line, or per remaining balance. */
  key: string;
  /**
   * The Saldo Awal date when the difference sits in an OPENING entry (an accepted unbalanced Neraca): the correction is then part of the
   * opening too, an OPENING entry on that date like a Temuan's resolution (lib/findings.ts), so the changes in equity open with it instead
   * of showing an in-year correction of Saldo Laba.
   */
  opening?: Date;
  refs: string[];
};

/** Reversing `own` moves the 1999 balance toward zero and never past it. */
const fits = (own: bigint, net: bigint) => (own > 0n ? net >= own : net <= own);

const reversal = (code: string, counter: string, signed: bigint): ProposalLine[] => {
  const amount = (signed < 0n ? -signed : signed).toString();
  return [
    { accountCode: code, debit: signed < 0n ? amount : "0", credit: signed > 0n ? amount : "0" },
    { accountCode: counter, debit: signed > 0n ? amount : "0", credit: signed < 0n ? amount : "0" },
  ];
};

const sourceLines = (db: Db, clientId: string, where: Record<string, unknown>) =>
  db.journalLine.findMany({
    where: { ...where, memo: SOURCE_DIFFERENCE_MEMO, account: { clientId, isSuspense: true }, entry: { ledgerImportId: { not: null } } },
    include: { account: true, entry: { include: { entity: true, lines: { include: { account: true } } } } },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });
type SourceLine = Awaited<ReturnType<typeof sourceLines>>[number];

function lineCorrection(l: SourceLine): SuspenseCorrection {
  const own = l.debit - l.credit;
  const amount = own < 0n ? -own : own;
  const same = l.entry.lines.filter((x) => x.id !== l.id && !x.account.isSuspense && (x.debit === amount || x.credit === amount));
  const counter = same.length === 1 ? same[0].account.code : "";
  const ref = l.entry.sourceRef ?? formatDate(l.date);
  const e = l.entry.entity;
  return {
    lineId: l.id,
    entity: { id: e.id, shortName: e.shortName, functionalCurrency: e.functionalCurrency },
    year: l.date.getUTCFullYear(),
    month: l.date.getUTCMonth() + 1,
    memo: `Koreksi selisih file sumber ${ref}`.slice(0, 120),
    origin: { ledgerImportId: l.entry.ledgerImportId ?? undefined, sourceRef: l.sourceRef ?? l.entry.sourceRef ?? undefined },
    reason: counter ? `Satu baris ${counter} di grup ${ref} bernilai sama dengan selisihnya: kemungkinan tercatat ganda atau pasangannya tidak ada di file` : `Pilih akun lawan untuk selisih grup ${ref}`,
    lines: reversal(l.account.code, counter, own),
    reverses: own,
    key: `SUSPENSE:${l.id}`,
    refs: [l.id],
    ...(l.entry.kind === "OPENING" ? { opening: l.entry.date } : {}),
  };
}

/** The entity's remaining 1999 source balance through the month, as one correction anchored on the month's latest source line. */
async function netCorrection(db: Db, clientId: string, entityId: string, year: number, month: number): Promise<SuspenseCorrection | null> {
  const { start, end } = periodBounds(year, month);
  const [anchor] = (await sourceLines(db, clientId, { entityId, date: { gte: start, lte: end } })).slice(-1);
  if (!anchor) return null;
  const net = await sourceSuspenseNet(db, entityId, end);
  if (net === 0n) return null;
  const e = anchor.entry.entity;
  return {
    lineId: `${NET}${entityId}:${year}-${month}`,
    entity: { id: e.id, shortName: e.shortName, functionalCurrency: e.functionalCurrency },
    year,
    month,
    memo: `Koreksi sisa selisih file sumber ${formatPeriod(year, month)}`.slice(0, 120),
    origin: { ledgerImportId: anchor.entry.ledgerImportId ?? undefined, sourceRef: anchor.sourceRef ?? anchor.entry.sourceRef ?? undefined },
    reason: "Selisih file sumber di 1999 saling mengimbangi atau sudah dikoreksi sebagian: pilih akun lawan untuk sisanya",
    lines: reversal(anchor.account.code, "", net),
    reverses: net,
    key: `SUSPENSE:${NET}${anchor.id}:${net}`,
    refs: [anchor.id],
  };
}

async function candidates(db: Db, clientId: string, where: { year: number; month: number } | { lineId: string }): Promise<SuspenseCorrection[]> {
  if ("lineId" in where && where.lineId.startsWith(NET)) {
    const m = /^net:([^:]+):(\d{4})-(\d{1,2})$/.exec(where.lineId);
    const c = m ? await netCorrection(db, clientId, m[1], Number(m[2]), Number(m[3])) : null;
    return c ? [c] : [];
  }
  const range = "lineId" in where ? { id: where.lineId } : (() => { const { start, end } = periodBounds(where.year, where.month); return { date: { gte: start, lte: end } }; })();
  const lines = await sourceLines(db, clientId, range);
  // Only a posted correction hides a line; an open draft (a post that failed, e.g. locked period) is reused on the next click.
  // A 1999 difference can't be waved away (the close FAILs until 1999 is cleared), so there is no dismissed state to hide.
  const decided = new Set((await db.proposedEntry.findMany({ where: { key: { in: lines.map((l) => `SUSPENSE:${l.id}`) }, status: "POSTED" }, select: { key: true } })).map((p) => p.key));
  const nets = new Map<string, bigint>();
  const netOf = async (l: SourceLine) => {
    const { end } = periodBounds(l.date.getUTCFullYear(), l.date.getUTCMonth() + 1);
    const k = `${l.entityId}|${+end}`;
    if (!nets.has(k)) nets.set(k, await sourceSuspenseNet(db, l.entityId, end));
    return nets.get(k)!;
  };
  const out: SuspenseCorrection[] = [];
  for (const l of lines) if (!decided.has(`SUSPENSE:${l.id}`) && fits(l.debit - l.credit, await netOf(l))) out.push(lineCorrection(l));
  if ("lineId" in where) return out;
  // An entity whose remaining 1999 balance no single line fits gets one correction for the rest.
  for (const entityId of new Set(lines.map((l) => l.entityId))) {
    if (out.some((c) => c.entity.id === entityId)) continue;
    const rest = await netCorrection(db, clientId, entityId, where.year, where.month);
    if (rest) out.push(rest);
  }
  return out;
}

export const suspenseCorrections = (db: Db, clientId: string, year: number, month: number) => candidates(db, clientId, { year, month });

async function one(db: Db, clientId: string, lineId: string) {
  const [c] = await candidates(db, clientId, { lineId });
  if (!c) throw new LedgerError("Selisih ini tidak ditemukan atau sudah diputuskan.");
  return c;
}

const store = (db: Db, firmId: string, clientId: string, c: SuspenseCorrection) =>
  saveProposal(db, { firmId, clientId, entityId: c.entity.id, year: c.year, month: c.month, source: "SUSPENSE", key: c.key, memo: c.memo, lines: c.lines, reason: c.reason, refs: c.refs });

/** The accountant's click: the 1999 line stays fixed, the counter account is theirs to choose. */
export async function postSuspenseCorrection(db: Db, input: { firmId: string; clientId: string; lineId: string; accounts: string[]; actorId?: string | null }) {
  const c = await one(db, input.clientId, input.lineId);
  if (input.accounts[0] !== c.lines[0].accountCode) throw new LedgerError("Baris 1999 tidak bisa diganti akunnya; pilih akun lawan saja.");
  if (!input.accounts[1]?.trim()) throw new LedgerError("Pilih akun untuk setiap baris.");
  if (input.accounts[1] === c.lines[0].accountCode) throw new LedgerError("Akun lawan tidak boleh 1999.");
  if (c.opening) {
    // A Saldo Awal holds balance-sheet positions only (rule 5), as when a Temuan is resolved.
    const counter = await db.account.findFirst({ where: { clientId: input.clientId, code: input.accounts[1].trim() }, select: { type: true } });
    if (counter?.type === "PENDAPATAN" || counter?.type === "BEBAN") throw new LedgerError("Saldo awal tidak berisi laba rugi: pilih akun neraca (aset, liabilitas atau ekuitas).");
  }
  const p = await store(db, input.firmId, input.clientId, c);
  // Re-checked inside the posting transaction: a correction (or manual fix) racing this can't reverse a difference twice.
  const residual = input.lineId.startsWith(NET);
  const guard = async (tx: Tx) => {
    const net = await sourceSuspenseNet(tx, c.entity.id, periodBounds(c.year, c.month).end);
    if (residual ? net !== c.reverses : !fits(c.reverses, net)) throw new LedgerError("Selisih di 1999 sudah berubah (sudah dikoreksi); muat ulang halaman.");
  };
  return postProposal(db, { clientId: input.clientId, proposalId: p.id, accounts: input.accounts, actorId: input.actorId, origin: c.origin, guard, ...(c.opening ? { entry: { kind: "OPENING" as const, date: c.opening } } : {}) });
}

/** A 1999 difference must be corrected before the close: its only correction can't be dismissed (there'd be no way to clear it). */
export const SUSPENSE_NOT_DISMISSABLE = "Selisih di 1999 harus dikoreksi sebelum tutup buku: pilih akun lawan lalu catat.";

/** Everything the *Usulan jurnal koreksi* card shows: stored drafts, then this period's undecided 1999 corrections. */
export async function correctionViews(db: Db, clientId: string, year: number, month: number) {
  const suspense = (await suspenseCorrections(db, clientId, year, month)).map((c) => ({ id: `${SUSPENSE_PREFIX}${c.lineId}`, memo: c.memo, reason: c.reason, source: "SUSPENSE" as const, entityId: c.entity.id, entity: c.entity.shortName, currency: c.entity.functionalCurrency, fixed: 0, lines: c.lines, blocked: null, rejected: null }));
  return [...(await proposalViews(db, clientId, year, month)), ...suspense];
}
