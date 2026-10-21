import { recordEvent } from "@/lib/audit";
import type { Db, Tx } from "@/lib/db";
import type { FindingKind } from "@/lib/generated/prisma/enums";
import { postJournal } from "@/lib/ledger/post";
import { closeLock } from "@/lib/adjust/schedules";
import { ACCOUNT_CODES } from "@/lib/coa/template";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";

/**
 * Temuan (ADR 0012): a difference Buku does not plug. It is opened by the posting that finds it, in the same transaction, and resolved
 * once by the accountant's written decision. The close controls read the GL (3290 for an opening difference), never this row's status.
 */
export class FindingError extends Error {}

export const DECISION_MIN = 10;
export const findingLabel = (n: number) => `T-${String(n).padStart(3, "0")}`;

/** Numbers are per client and never reused: the next one is taken under a per-client lock. */
export async function openFinding(
  tx: Tx,
  input: { clientId: string; entityId: string; kind: FindingKind; date: Date; amount: bigint; question: string; sourceEntryId?: string | null; actorId?: string | null },
) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`finding:${input.clientId}`}, 0))::text`;
  const { firmId } = await tx.client.findUniqueOrThrow({ where: { id: input.clientId }, select: { firmId: true } });
  const last = await tx.finding.aggregate({ where: { clientId: input.clientId }, _max: { number: true } });
  return tx.finding.create({
    data: {
      firmId,
      clientId: input.clientId,
      entityId: input.entityId,
      number: (last._max.number ?? 0) + 1,
      kind: input.kind,
      date: input.date,
      amount: input.amount,
      question: input.question,
      sourceEntryId: input.sourceEntryId ?? null,
      openedById: input.actorId ?? null,
    },
  });
}

/**
 * The question an opening difference asks. `amount` is signed as it sits on 3290: a credit (negative) means the assets typed exceed
 * liabilities and equity, a debit the other way round.
 */
export function openingQuestion(entity: string, date: Date, amount: bigint, currency: string) {
  const abs = formatMoney(amount < 0n ? -amount : amount, currency);
  const side = amount < 0n ? `aset yang diisi lebih besar ${abs} dari liabilitas + ekuitas` : `liabilitas + ekuitas yang diisi lebih besar ${abs} dari aset`;
  return `Saldo awal ${entity} per ${formatDate(date)} tidak seimbang: ${side}. Dari mana selisih ini? Kas di luar bank, piutang atau utang yang belum tercatat, modal, atau saldo laba? Tulis keputusannya dan pilih akunnya.`;
}

/**
 * The question a Saldo Awal file's rounding residue asks (rule 6a rounds each balance once; what is left can't go on 7190, an expense,
 * inside a balance-sheet position). `amount` is signed as it sits on 3290, like `openingQuestion`.
 */
export function roundingQuestion(entity: string, date: Date, amount: bigint, currency: string, file: string) {
  const abs = formatMoney(amount < 0n ? -amount : amount, currency);
  return `Saldo awal ${entity} per ${formatDate(date)} dari ${file}: membulatkan saldo file ke satuan mata uang menyisakan ${abs}. Tulis keputusannya dan pilih akunnya (biasanya Saldo Laba).`;
}

/** The entity's balance on 3290 over all dates (debit +). */
async function openingDifference(db: Db | Tx, entityId: string, accountId: string) {
  const s = await db.journalLine.aggregate({ where: { entityId, accountId }, _sum: { debit: true, credit: true } });
  return (s._sum.debit ?? 0n) - (s._sum.credit ?? 0n);
}

/**
 * Resolves an opening-difference Temuan: the decision is written, and one OPENING entry dated the Saldo Awal date moves the entity's
 * whole 3290 balance to the decided account (nothing is posted when another journal already cleared it). Once only.
 */
export async function resolveOpeningFinding(db: Db, input: { clientId: string; findingId: string; accountCode: string; decision: string; actorId?: string | null }) {
  const decision = input.decision.trim();
  if (decision.length < DECISION_MIN) throw new FindingError(`Tulis keputusannya (min. ${DECISION_MIN} karakter): dari mana selisih ini dan siapa yang mengonfirmasi.`);
  return db.$transaction(async (tx) => {
    await closeLock(tx, input.clientId);
    const f = await tx.finding.findFirst({ where: { id: input.findingId, clientId: input.clientId }, include: { entity: true } });
    if (!f) throw new FindingError("Temuan tidak ditemukan.");
    if (f.status !== "OPEN") throw new FindingError(`${findingLabel(f.number)} sudah diselesaikan.`);
    if (f.kind !== "OPENING_DIFFERENCE") throw new FindingError("Temuan ini diselesaikan di tempat lain.");
    const accounts = await tx.account.findMany({ where: { clientId: input.clientId, code: { in: [input.accountCode, ACCOUNT_CODES.OPENING_DIFFERENCE] } } });
    const target = accounts.find((a) => a.code === input.accountCode);
    const diff = accounts.find((a) => a.code === ACCOUNT_CODES.OPENING_DIFFERENCE);
    if (!target || !diff || target.id === diff.id) throw new FindingError("Pilih akun tujuan selisih.");
    if (target.isBank) throw new FindingError("Saldo rekening bank datang dari rekening koran. Kalau kasnya ada di luar bank, pilih Kas Kecil.");
    if (target.isSuspense || target.isClearing) throw new FindingError(`Pilih akun yang menjelaskan selisihnya, bukan ${target.code} ${target.name}.`);
    if (target.type === "PENDAPATAN" || target.type === "BEBAN") throw new FindingError("Saldo awal tidak berisi laba rugi: pilih akun neraca (aset, liabilitas atau ekuitas).");

    const balance = await openingDifference(tx, f.entityId, diff.id);
    let entryId: string | null = null;
    if (balance !== 0n) {
      const memo = `Penyelesaian ${findingLabel(f.number)}: ${decision}`;
      const entry = await postJournal(tx, {
        entityId: f.entityId,
        date: f.date,
        kind: "OPENING",
        memo,
        actorId: input.actorId,
        lines: balance > 0n
          ? [{ accountId: target.id, debit: balance, memo }, { accountId: diff.id, credit: balance, memo }]
          : [{ accountId: diff.id, debit: -balance, memo }, { accountId: target.id, credit: -balance, memo }],
      });
      entryId = entry.id;
    }
    await recordEvent(tx, {
      clientId: input.clientId,
      entityId: f.entityId,
      kind: "FINDING_RESOLVED",
      subject: `finding:${f.id}`,
      summary: `${findingLabel(f.number)} diselesaikan ke ${target.code} ${target.name}: ${decision}`,
      before: { status: "OPEN", difference: f.amount.toString() },
      after: { status: "RESOLVED", accountCode: target.code, moved: balance.toString(), decision },
      actorId: input.actorId,
    });
    return tx.finding.update({
      where: { id: f.id },
      data: { status: "RESOLVED", resolution: decision, resolvedEntryId: entryId, resolvedById: input.actorId ?? null, resolvedAt: new Date() },
    });
  });
}

export type FindingView = {
  id: string;
  kind: FindingKind;
  label: string;
  entity: string;
  currency: string;
  date: Date;
  amount: bigint;
  question: string;
  status: "OPEN" | "RESOLVED";
  openedBy: string | null;
  createdAt: Date;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  /** The account the resolution moved the difference to. */
  resolvedTo: string | null;
};

/** Every Temuan of the client (open first, then by number), optionally only those of some entities. */
export async function listFindings(db: Db, clientId: string, entityIds?: string[]): Promise<FindingView[]> {
  const rows = await db.finding.findMany({
    where: { clientId, ...(entityIds ? { entityId: { in: entityIds } } : {}) },
    include: {
      entity: { select: { shortName: true, functionalCurrency: true } },
      openedBy: { select: { name: true } },
      resolvedBy: { select: { name: true } },
      resolvedEntry: { include: { lines: { include: { account: { select: { code: true, name: true } } } } } },
    },
    orderBy: [{ status: "asc" }, { number: "asc" }],
  });
  return rows.map((f) => {
    // Only an opening difference moves to an account; a subledger difference is explained, nothing posted.
    const to = f.kind === "OPENING_DIFFERENCE" ? f.resolvedEntry?.lines.find((l) => l.account.code !== ACCOUNT_CODES.OPENING_DIFFERENCE)?.account : undefined;
    return {
      id: f.id,
      kind: f.kind,
      label: findingLabel(f.number),
      entity: f.entity.shortName,
      currency: f.entity.functionalCurrency,
      date: f.date,
      amount: f.amount,
      question: f.question,
      status: f.status,
      openedBy: f.openedBy?.name ?? null,
      createdAt: f.createdAt,
      resolution: f.resolution,
      resolvedBy: f.resolvedBy?.name ?? null,
      resolvedAt: f.resolvedAt,
      resolvedTo: to ? `${to.code} ${to.name}` : null,
    };
  });
}
