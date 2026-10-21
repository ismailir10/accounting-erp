import type { Db } from "@/lib/db";
import { LedgerError, postJournal, type PostLine } from "@/lib/ledger/post";
import { installments, owed, type Installment } from "@/lib/adjust/schedules";
import { ACCOUNT_CODES, COA_TEMPLATE } from "@/lib/coa/template";
import { dateOnly, formatPeriod } from "@/lib/format";
import { formatMoney, parseMoney } from "@/lib/money";

/**
 * Disposal of a fixed asset (accounting-rules 5b): one ADJUSTMENT entry through postJournal() at the disposal date —
 * Dr accumulated depreciation to date, Dr the proceeds account, Cr the asset at cost, and the difference as a gain (Cr) or loss (Dr)
 * on 7300 Laba/Rugi Pelepasan Aset Tetap. The month of disposal is depreciated in full first; the schedule stops; the asset keeps
 * the entry (`disposalEntryId`). Proceeds never touch a bank account: the bank receipt is classified to the same proceeds account.
 */
export type DisposalInput = {
  clientId: string;
  assetId: string;
  /** YYYY-MM-DD */
  date: string;
  /** Major units of the entity's functional currency; "0" for a write-off. */
  proceeds: string;
  proceedsCode: string;
  /** Default 7300 (created on the first disposal when the client has no 7300). */
  gainLossCode?: string | null;
  actorId?: string | null;
};

const GAIN_LOSS_NAME = /pelepasan aset/i;

export async function disposeAsset(db: Db, input: DisposalInput) {
  const asset = await db.fixedAsset.findFirst({ where: { id: input.assetId, clientId: input.clientId }, include: { entity: true, schedule: { include: { entries: { select: { installment: true, date: true } } } } } });
  if (!asset) throw new LedgerError("Aset tidak ditemukan.");
  if (asset.disposalEntryId) throw new LedgerError(`${asset.name} sudah dilepas.`);
  const m = input.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = m ? dateOnly(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  if (!date || date.getUTCMonth() + 1 !== Number(m![2])) throw new LedgerError("Tanggal pelepasan tidak valid.");
  if (+date < +asset.acquiredOn) throw new LedgerError("Tanggal pelepasan sebelum tanggal perolehan.");
  const cur = asset.entity.functionalCurrency;
  const proceeds = parseMoney(input.proceeds.trim() || "0", cur);
  if (proceeds < 0n) throw new LedgerError("Hasil penjualan tidak boleh negatif.");

  const accounts = await db.account.findMany({ where: { clientId: input.clientId } });
  const byCode = (code: string) => accounts.find((a) => a.code === code);
  const proceedsAccount = byCode(input.proceedsCode);
  if (!proceedsAccount || proceedsAccount.isBank || proceedsAccount.isSuspense || proceedsAccount.isClearing || proceedsAccount.id === asset.assetAccountId || proceedsAccount.id === asset.accumulatedAccountId) {
    throw new LedgerError("Pilih akun penerimaan hasil pelepasan (bukan akun bank, 1999, kliring, atau akun aset ini). Penerimaan di bank diklasifikasikan ke akun yang sama.");
  }
  const gainLoss = input.gainLossCode ? byCode(input.gainLossCode) : byCode(ACCOUNT_CODES.DISPOSAL_GAIN_LOSS);
  if (input.gainLossCode) {
    if (!gainLoss || (gainLoss.type !== "PENDAPATAN" && gainLoss.type !== "BEBAN")) throw new LedgerError("Akun laba/rugi pelepasan harus akun pendapatan atau beban.");
  } else if (gainLoss && !GAIN_LOSS_NAME.test(gainLoss.name)) {
    throw new LedgerError(`Akun ${gainLoss.code} dipakai untuk "${gainLoss.name}". Pilih akun laba/rugi pelepasan aset.`);
  }

  const s = asset.schedule;
  const month = date.getUTCFullYear() * 12 + date.getUTCMonth() + 1;
  // An installment of a month closed without it (its control acknowledged) can never be posted; the register stops asking for it too, so
  // the disposal does: the gain or loss is reckoned from what was booked.
  const locked = new Set((await db.period.findMany({ where: { clientId: input.clientId, status: "LOCKED" }, select: { year: true, month: true } })).map((p) => p.year * 12 + p.month));
  const owing = (i: Installment, posted: (k: number) => boolean) =>
    !i.reversal && owed(s!.stoppedAt, i) && i.year * 12 + i.month <= month && !locked.has(i.year * 12 + i.month) && !posted(i.k);
  if (s) {
    const posted = new Set(s.entries.map((e) => e.installment));
    const missing = installments(s).filter((i) => owing(i, (k) => posted.has(k)));
    if (missing.length) throw new LedgerError(`Catat dulu penyusutan ${asset.name} sampai ${formatPeriod(missing.at(-1)!.year, missing.at(-1)!.month)} (${missing.length} angsuran) sebelum melepasnya.`);
    // Installments are dated the month's last day: one of a later month than the disposal can't stay.
    const monthOf = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth() + 1;
    if (s.entries.some((e) => e.installment !== null && e.installment <= s.months && monthOf(e.date) > month)) throw new LedgerError("Ada penyusutan yang sudah dicatat untuk bulan setelah pelepasan. Koreksi dulu jurnal itu.");
  }

  return db.$transaction(async (tx) => {
    // Serialise with a click posting an installment (it locks the schedule row too) and read the posted total inside the lock.
    if (s) await tx.$queryRaw`SELECT id FROM "AdjustmentSchedule" WHERE id = ${s.id} FOR UPDATE`;
    const entries = s ? await tx.journalEntry.findMany({ where: { scheduleId: s.id }, select: { installment: true, date: true, lines: { select: { accountId: true, credit: true, debit: true } } } }) : [];
    if (s && installments(s).some((i) => owing(i, (k) => entries.some((e) => e.installment === k)))) throw new LedgerError("Penyusutan berubah sementara itu. Muat ulang halaman lalu coba lagi.");
    const booked = entries
      .filter((e) => e.installment !== null && e.installment <= s!.months)
      .reduce((t, e) => t + e.lines.filter((l) => l.accountId === asset.accumulatedAccountId).reduce((u, l) => u + l.credit - l.debit, 0n), 0n);
    const accumulated = asset.openingAccumulated + booked;
    const bookValue = asset.cost - accumulated;
    const result = proceeds - bookValue;

    let gainLossId = gainLoss?.id ?? null;
    if (result !== 0n && !gainLossId) {
      const seed = COA_TEMPLATE.find((a) => a.code === ACCOUNT_CODES.DISPOSAL_GAIN_LOSS)!;
      gainLossId = (await tx.account.create({ data: { ...seed, firmId: asset.firmId, clientId: input.clientId } })).id;
    }
    const lines: PostLine[] = [];
    if (accumulated > 0n) lines.push({ accountId: asset.accumulatedAccountId!, debit: accumulated });
    if (proceeds > 0n) lines.push({ accountId: proceedsAccount.id, debit: proceeds });
    lines.push({ accountId: asset.assetAccountId, credit: asset.cost });
    // The gain or loss is the asset's department's and project's, as its depreciation was (its schedule's tags).
    const tags = { departmentId: s?.departmentId ?? null, projectId: s?.projectId ?? null };
    if (result > 0n) lines.push({ accountId: gainLossId!, credit: result, ...tags });
    if (result < 0n) lines.push({ accountId: gainLossId!, debit: -result, ...tags });
    const outcome = result > 0n ? `laba ${formatMoney(result, cur)}` : result < 0n ? `rugi ${formatMoney(-result, cur)}` : "tanpa laba/rugi";
    const entry = await postJournal(tx, { entityId: asset.entityId, date, kind: "ADJUSTMENT", memo: `Pelepasan aset: ${asset.name} (${outcome})`, lines, actorId: input.actorId });
    const done = await tx.fixedAsset.updateMany({ where: { id: asset.id, disposalEntryId: null }, data: { disposedOn: date, proceeds, disposalEntryId: entry.id } });
    if (done.count !== 1) throw new LedgerError(`${asset.name} sudah dilepas.`);
    if (s) await tx.adjustmentSchedule.updateMany({ where: { id: s.id, stoppedAt: null }, data: { stoppedAt: date } });
    return { entryId: entry.id, accumulated, bookValue, result };
  });
}
