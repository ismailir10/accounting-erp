import type { Tx, Db } from "@/lib/db";
import { closeLock } from "@/lib/adjust/schedules";
import { recordEvent } from "@/lib/audit";
import { importKindLabel } from "@/lib/ledger-import/code";
import { formatDate, formatPeriod } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/auth/permissions";
import { lockedAfter } from "@/lib/ledger/post";
import type { MemberRole } from "@/lib/generated/prisma/enums";

/**
 * Hapus impor (ADR 0013, use-case feedback UC-K4): an admin removes one posted import — a bank statement or a ledger/Neraca file — with
 * everything it put in the books, so the reports return to where they were and the file can be imported again. One transaction under the
 * client's close lock; refused while a closed month, an invoice settlement, a fixed asset or a schedule rests on it. The change log keeps
 * what was removed, why, who and when.
 */
export class RemoveImportError extends Error {}
export const REMOVE_REASON_MIN = 10;

type Actor = { id: string; role: MemberRole };

function checkActor(actor: Actor, reason: string) {
  if (!can(actor.role, "import.remove")) throw new RemoveImportError("Hanya admin kantor yang dapat menghapus impor.");
  const why = reason.trim();
  if (why.length < REMOVE_REASON_MIN) throw new RemoveImportError(`Tulis alasan menghapus impor ini (min. ${REMOVE_REASON_MIN} karakter), mis. "salah rekening" atau "file bulan yang sama dua kali".`);
  return why;
}

/** The journals an import produced, checked for what rests on them; their net per account for the log. */
async function entriesOf(tx: Tx, where: { bankTransactionId?: { in: string[] }; ledgerImportId?: string }, currency: (entityId: string) => string) {
  const entries = await tx.journalEntry.findMany({
    where,
    include: {
      period: { select: { year: true, month: true, status: true } },
      lines: { select: { id: true, debit: true, credit: true, entityId: true, account: { select: { code: true, name: true } } } },
      schedulesFrom: { select: { memo: true } },
      assetsFrom: { select: { name: true } },
      reversedBy: { select: { id: true } },
    },
  });
  const locked = [...new Set(entries.filter((e) => e.period.status === "LOCKED").map((e) => formatPeriod(e.period.year, e.period.month)))];
  if (locked.length) throw new RemoveImportError(`Bulan ${locked.join(", ")} sudah ditutup. Buka kembali dulu di Tutup Buku (tercatat dengan alasannya), lalu hapus impor ini.`);
  // A closed month after the import's journals would change too (accounting-rules 4).
  const earliest = entries.reduce<Date | null>((m, e) => (!m || +e.date < +m ? e.date : m), null);
  if (earliest) {
    const { clientId } = await tx.entity.findUniqueOrThrow({ where: { id: entries[0].entityId }, select: { clientId: true } });
    const later = await lockedAfter(tx, clientId, earliest.getUTCFullYear(), earliest.getUTCMonth() + 1);
    if (later) throw new RemoveImportError(`${formatPeriod(later.year, later.month)} sudah ditutup, dan menghapus jurnal dari impor ini yang bertanggal sebelumnya mengubah saldo bulan itu. Buka kembali dulu di Tutup Buku, lalu hapus impor ini.`);
  }
  const resting = [...entries.flatMap((e) => e.schedulesFrom.map((s) => `jadwal "${s.memo}"`)), ...entries.flatMap((e) => e.assetsFrom.map((a) => `aset tetap "${a.name}"`))];
  if (resting.length) throw new RemoveImportError(`Jurnal dari impor ini dipakai oleh ${resting.slice(0, 3).join(", ")}${resting.length > 3 ? ` dan ${resting.length - 3} lainnya` : ""}. Hapus atau hentikan itu dulu.`);
  if (entries.some((e) => e.reversedBy)) throw new RemoveImportError("Ada jurnal dari impor ini yang sudah dibalik. Hapus jurnal pembaliknya dulu.");
  const nets = new Map<string, bigint>();
  for (const e of entries) for (const l of e.lines) nets.set(`${l.account.code} ${l.account.name}`, (nets.get(`${l.account.code} ${l.account.name}`) ?? 0n) + l.debit - l.credit);
  const cur = entries[0] ? currency(entries[0].entityId) : "IDR";
  return {
    ids: entries.map((e) => e.id),
    openings: entries.filter((e) => e.kind === "OPENING").map((e) => ({ entityId: e.entityId, date: e.date })),
    dated: entries.map((e) => ({ entityId: e.entityId, date: e.date })),
    lineIds: entries.flatMap((e) => e.lines.map((l) => l.id)),
    // What the import put on each account (debit +), so the log says what its removal took off.
    nets: Object.fromEntries([...nets].filter(([, v]) => v !== 0n).map(([k, v]) => [k, formatMoney(v, cur)])),
  };
}

/** Drafts and posted proposals that cite or came from what is removed: they describe books that no longer exist. */
async function dropProposals(tx: Tx, ids: { entryIds: string[]; lineIds: string[]; bankTxIds?: string[] }) {
  const where = {
    OR: [
      { entryId: { in: ids.entryIds } },
      { refs: { hasSome: [...ids.lineIds, ...(ids.bankTxIds ?? [])] } },
      ...(ids.bankTxIds?.length ? [{ bankTransactionId: { in: ids.bankTxIds } }] : []),
    ],
  };
  // Their second-approval requests (Persetujuan kedua) go with them, and so does an approved one whose entry is removed here.
  const dropped = (await tx.proposedEntry.findMany({ where, select: { id: true } })).map((p) => p.id);
  await tx.journalApproval.deleteMany({ where: { OR: [{ proposalId: { in: dropped } }, { entryId: { in: ids.entryIds } }] } });
  await tx.proposedEntry.deleteMany({ where });
}

/**
 * A Saldo Awal from a file is what fixed assets from before the books and opening invoices stand on (their amounts are already in that
 * opening entry). Removing it under them would leave a register and a subledger with no GL behind: they go first.
 */
/**
 * An opening bridge (rule 15a) took the books' movement up to its anchor date into Saldo Awal: removing journals from that span would
 * leave the Neraca at the anchor date no longer equal to its file, silently. The bridge goes first.
 */
async function refuseBridgeDependents(tx: Tx, dated: { entityId: string; date: Date }[], ownImportId?: string) {
  if (!dated.length) return;
  const bridges = await tx.journalEntry.findMany({
    where: { entityId: { in: [...new Set(dated.map((d) => d.entityId))] }, kind: "OPENING", ledgerImportId: { not: ownImportId ?? null }, lines: { some: { memo: { contains: "(opening bridge)" } } } },
    select: { entityId: true, ledgerImport: { select: { fileName: true, periodEnd: true } } },
  });
  for (const b of bridges) {
    if (!b.ledgerImport || !dated.some((d) => d.entityId === b.entityId && +d.date <= +b.ledgerImport!.periodEnd)) continue;
    throw new RemoveImportError(`Saldo awal entitas ini dibangun dari Neraca ${b.ledgerImport.fileName} per ${formatDate(b.ledgerImport.periodEnd)} dengan mutasi buku sampai tanggal itu, termasuk jurnal dari impor ini. Hapus dulu impor Neraca itu, lalu impor ulang setelah buku diperbaiki.`);
  }
}

async function refuseOpeningDependents(tx: Tx, openings: { entityId: string; date: Date }[]) {
  if (!openings.length) return;
  const entityIds = [...new Set(openings.map((o) => o.entityId))];
  const latest = new Date(Math.max(...openings.map((o) => +o.date)));
  const [assets, invoices] = await Promise.all([
    tx.fixedAsset.findMany({ where: { entityId: { in: entityIds }, sourceEntryId: null, OR: [{ openingAccumulated: { gt: 0n } }, { acquiredOn: { lte: latest } }] }, select: { name: true }, orderBy: { name: "asc" } }),
    tx.invoice.findMany({ where: { entityId: { in: entityIds }, opening: true, voidedAt: null }, select: { number: true }, orderBy: { number: "asc" } }),
  ]);
  const resting = [...assets.map((a) => `aset tetap "${a.name}"`), ...invoices.map((i) => `faktur saldo awal ${i.number}`)];
  if (resting.length) throw new RemoveImportError(`Saldo Awal dari impor ini dipakai oleh ${resting.slice(0, 3).join(", ")}${resting.length > 3 ? ` dan ${resting.length - 3} lainnya` : ""}. Hapus itu dulu.`);
}

export async function removeStatementImport(db: Db, input: { clientId: string; importId: string; reason: string; actor: Actor }) {
  const why = checkActor(input.actor, input.reason);
  return db.$transaction(
    async (tx) => {
      await closeLock(tx, input.clientId);
      const imp = await tx.statementImport.findFirst({ where: { id: input.importId, bankAccount: { entity: { clientId: input.clientId } } }, include: { bankAccount: { include: { entity: true } } } });
      if (!imp) throw new RemoveImportError("Impor tidak ditemukan.");
      // Lock the import's lines first: a review (a new RECLASS) or another import linking a transfer half to one of them takes a key
      // share on the line, so it waits for this removal and then fails, instead of leaving a journal with no source behind.
      await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE "importId" = ${imp.id} FOR UPDATE`;
      const txs = await tx.bankTransaction.findMany({ where: { importId: imp.id }, include: { settlements: { select: { invoice: { select: { number: true } } } } } });
      const settled = [...new Set(txs.flatMap((t) => t.settlements.map((s) => s.invoice.number)))];
      if (settled.length) throw new RemoveImportError(`Mutasi di impor ini melunasi ${settled.slice(0, 3).join(", ")}${settled.length > 3 ? ` dan ${settled.length - 3} faktur lain` : ""}. Hapus pencocokannya dulu di Piutang & Utang.`);
      const txIds = txs.map((t) => t.id);
      const currency = imp.bankAccount.entity.functionalCurrency;
      const entries = await entriesOf(tx, { bankTransactionId: { in: txIds } }, () => currency);
      await refuseBridgeDependents(tx, entries.dated);

      // The other half of a transfer in another import stays where it is; the clearing control shows it open — which a closed month's
      // controls must not start doing after the fact.
      const halves = await tx.bankTransaction.findMany({ where: { matchedTxId: { in: txIds }, importId: { not: imp.id } }, select: { date: true } });
      const months = [...new Map(halves.map((h) => [`${h.date.getUTCFullYear()}-${h.date.getUTCMonth() + 1}`, { year: h.date.getUTCFullYear(), month: h.date.getUTCMonth() + 1 }])).values()];
      const closed = months.length ? await tx.period.findMany({ where: { clientId: input.clientId, status: "LOCKED", OR: months }, orderBy: [{ year: "asc" }, { month: "asc" }] }) : [];
      if (closed.length) throw new RemoveImportError(`Pasangan transfer dari impor ini ada di bulan ${closed.map((p) => formatPeriod(p.year, p.month)).join(", ")} yang sudah ditutup. Buka kembali dulu di Tutup Buku, lalu hapus impor ini.`);
      const partners = await tx.bankTransaction.updateMany({ where: { matchedTxId: { in: txIds }, importId: { not: imp.id } }, data: { matchedTxId: null } });
      await dropProposals(tx, { entryIds: entries.ids, lineIds: entries.lineIds, bankTxIds: txIds });
      await tx.journalEntry.deleteMany({ where: { bankTransactionId: { in: txIds } } }); // lines cascade
      await tx.bankTransaction.deleteMany({ where: { id: { in: txIds } } });
      await tx.evidenceSelection.updateMany({ where: { importId: imp.id }, data: { importId: null } });
      await tx.statementImport.delete({ where: { id: imp.id } });

      const moneyIn = txs.filter((t) => t.amount > 0n).reduce((s, t) => s + t.amount, 0n);
      const moneyOut = txs.filter((t) => t.amount < 0n).reduce((s, t) => s - t.amount, 0n);
      const label = `${imp.bankAccount.label} · ${imp.bankAccount.number}`;
      await recordEvent(tx, {
        clientId: input.clientId,
        entityId: imp.bankAccount.entityId,
        kind: "IMPORT_REMOVED",
        subject: `import:${imp.id}`,
        summary: `Impor ${imp.fileName} (${label}, ${formatDate(imp.periodStart)} – ${formatDate(imp.periodEnd)}) dihapus: ${txs.length} mutasi, ${entries.ids.length} jurnal. Alasan: ${why}`,
        before: {
          file: imp.fileName,
          account: label,
          entity: imp.bankAccount.entity.shortName,
          period: `${formatDate(imp.periodStart)} – ${formatDate(imp.periodEnd)}`,
          rows: txs.length,
          moneyIn: formatMoney(moneyIn, currency),
          moneyOut: formatMoney(moneyOut, currency),
          journals: entries.ids.length,
          nets: entries.nets,
          partnersUnlinked: partners.count,
        },
        after: { reason: why },
        actorId: input.actor.id,
      });
      return { rows: txs.length, journals: entries.ids.length, partnersUnlinked: partners.count };
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}

export async function removeLedgerImport(db: Db, input: { clientId: string; importId: string; reason: string; actor: Actor }) {
  const why = checkActor(input.actor, input.reason);
  return db.$transaction(
    async (tx) => {
      await closeLock(tx, input.clientId);
      const imp = await tx.ledgerImport.findFirst({ where: { id: input.importId, clientId: input.clientId } });
      if (!imp) throw new RemoveImportError("Impor tidak ditemukan.");
      await tx.$queryRaw`SELECT id FROM "LedgerImport" WHERE id = ${imp.id} FOR UPDATE`;
      if (imp.status !== "POSTED") throw new RemoveImportError("Draf belum dicatat: buang drafnya dari halaman impor.");
      const entities = await tx.entity.findMany({ where: { clientId: input.clientId }, select: { id: true, shortName: true, functionalCurrency: true } });
      const currency = (entityId: string) => entities.find((e) => e.id === entityId)?.functionalCurrency ?? "IDR";
      const entries = await entriesOf(tx, { ledgerImportId: imp.id }, currency);
      await refuseOpeningDependents(tx, entries.openings);
      await refuseBridgeDependents(tx, entries.dated, imp.id);
      await dropProposals(tx, { entryIds: entries.ids, lineIds: entries.lineIds });
      await tx.journalEntry.deleteMany({ where: { ledgerImportId: imp.id } });
      await tx.evidenceSelection.updateMany({ where: { importId: imp.id }, data: { importId: null } });
      await tx.ledgerImport.delete({ where: { id: imp.id } }); // checks cascade; source-account mappings stay for the next file

      await recordEvent(tx, {
        clientId: input.clientId,
        kind: "IMPORT_REMOVED",
        subject: `import:${imp.id}`,
        summary: `Impor ${importKindLabel(imp).replace(/^./, (c) => c.toLowerCase())} ${imp.fileName} · ${imp.sheetName} (${formatDate(imp.periodStart)} – ${formatDate(imp.periodEnd)}) dihapus: ${entries.ids.length} jurnal. Alasan: ${why}`,
        before: { file: imp.fileName, sheet: imp.sheetName, mode: imp.mode, period: `${formatDate(imp.periodStart)} – ${formatDate(imp.periodEnd)}`, rows: imp.rowCount, journals: entries.ids.length, nets: entries.nets },
        after: { reason: why },
        actorId: input.actor.id,
      });
      return { journals: entries.ids.length };
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}
