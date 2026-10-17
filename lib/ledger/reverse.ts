import type { Db, Tx } from "@/lib/db";
import { LedgerError, postJournal } from "@/lib/ledger/post";
import { formatDate } from "@/lib/format";
import { ACCOUNT_CODES } from "@/lib/coa/template";

/**
 * *Balik jurnal* (accounting-rules 3a): a manual adjustment is corrected by a new ADJUSTMENT that mirrors every line (debit ↔ credit,
 * same accounts and source accounts), dated by the accountant on or after the original, through postJournal() — so a
 * locked month refuses it. The original is never touched (rule 3). Only a manual adjustment qualifies: an entry a register, schedule, pack
 * stock count, close proposal or bank line owns is changed there, and an entry is reversed once (`reversesId` unique).
 */
/** The relations that own an entry (its scalar `scheduleId` / `reversesId` come with every include). */
export const REVERSAL_OWNERS = {
  reversedBy: { select: { id: true, date: true } },
  taxPosting: { select: { id: true } },
  leasePosting: { select: { id: true } },
  leaseCommenced: { select: { id: true } },
  leaseCancelled: { select: { id: true } },
  benefitPosting: { select: { id: true } },
  inventoryCounts: { select: { id: true } },
  assetDisposal: { select: { id: true } },
  assetsFrom: { select: { id: true } },
  schedulesFrom: { select: { id: true } },
  proposal: { select: { id: true } },
} as const;

type Owned = {
  kind: string;
  /** A journal from an imported file (a trial balance's Adjustment): changed by importing again, never reversed by hand. */
  ledgerImportId?: string | null;
  scheduleId: string | null;
  reversesId: string | null;
  reversedBy: { id: string; date: Date } | null;
  taxPosting: unknown;
  leasePosting: unknown;
  leaseCommenced: unknown;
  leaseCancelled: unknown;
  benefitPosting: unknown;
  inventoryCounts: unknown[];
  assetDisposal: unknown;
  assetsFrom: unknown[];
  schedulesFrom: unknown[];
  proposal: unknown;
  lines?: { currency: string | null; account: { code: string } }[];
};

/** Why an entry can't be reversed here (and where it is changed instead), or null. */
export function reversalBlocker(e: Owned): string | null {
  if (e.kind !== "ADJUSTMENT") return "Hanya jurnal penyesuaian yang dibalik di sini; mutasi bank diubah lewat Ubah akun, file impor lewat impor ulang.";
  if (e.ledgerImportId) return "Jurnal dari impor file (kolom Adjustment neraca saldo): ubah lewat impor ulang, atau hapus impornya.";
  if (e.reversedBy) return `Jurnal ini sudah dibalik per ${formatDate(e.reversedBy.date)}.`;
  if (e.reversesId) return "Ini jurnal pembalik; catat jurnal baru bila perlu.";
  if (e.scheduleId) return "Jurnal terjadwal: hentikan atau ubah jadwalnya di Jurnal Penyesuaian.";
  if (e.taxPosting) return "Jurnal dari Pajak Badan: ubah angkanya di sana, jurnal berikutnya mencatat selisihnya.";
  if (e.leasePosting || e.leaseCommenced || e.leaseCancelled) return "Jurnal dari daftar Sewa: ubah lewat halaman Sewa.";
  if (e.benefitPosting) return "Jurnal dari Imbalan Kerja: ubah valuasinya di sana.";
  // A recount keeps only its latest journal on the count row: every earlier stock-count journal is still the count's, found by 5190.
  if (e.inventoryCounts.length || e.lines?.some((l) => l.account.code === ACCOUNT_CODES.INVENTORY_CHANGE)) return "Jurnal persediaan: catat ulang hitungan di halaman Persediaan.";
  if (e.proposal) return "Jurnal dari usulan koreksi Tutup Buku: catat koreksi baru di Jurnal Penyesuaian bila perlu.";
  if (e.assetDisposal || e.assetsFrom.length || e.schedulesFrom.length) return "Jurnal ini dipakai daftar aset atau jadwal: ubah di Aset Tetap / Jurnal Penyesuaian.";
  if (e.lines?.some((l) => l.currency)) return "Jurnal valas atau revaluasi kurs: catat koreksinya sebagai jurnal baru dengan kursnya.";
  return null;
}

export async function loadReversible(db: Db | Tx, entryId: string) {
  return db.journalEntry.findUnique({ where: { id: entryId }, include: { ...REVERSAL_OWNERS, entity: { select: { clientId: true } }, lines: { include: { account: { select: { code: true } } } } } });
}

type ReverseInput = { clientId: string; entryId: string; date: Date; actorId?: string | null };

/** The entry to reverse, checked: the client's, reversible here (`reversalBlocker`), and the date on or after it. Nothing is written. */
export async function checkReversal(db: Db | Tx, input: Omit<ReverseInput, "actorId">) {
  const entry = await loadReversible(db, input.entryId);
  if (!entry || entry.entity.clientId !== input.clientId) throw new LedgerError("Jurnal tidak ditemukan.");
  const blocker = reversalBlocker(entry);
  if (blocker) throw new LedgerError(blocker);
  if (Number.isNaN(+input.date)) throw new LedgerError("Pilih tanggal jurnal pembalik.");
  if (+input.date < +entry.date) throw new LedgerError(`Tanggal pembalik tidak boleh sebelum jurnal aslinya (${formatDate(entry.date)}).`);
  return entry;
}

/** Posts the reversal on `tx`, every check made again on it; the approval of a waiting *Balik jurnal* (Persetujuan kedua) runs this too. */
export async function reverseEntryTx(tx: Tx, input: ReverseInput) {
  const entry = await checkReversal(tx, input);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reverse:${entry.id}`}, 0))::text`;
  if (await tx.journalEntry.findUnique({ where: { reversesId: entry.id }, select: { id: true } })) throw new LedgerError("Jurnal ini baru saja dibalik. Muat ulang halaman.");
  return postJournal(tx, { entityId: entry.entityId, date: input.date, kind: "ADJUSTMENT", memo: reversalMemo(entry), reversesId: entry.id, actorId: input.actorId, lines: mirrorLines(entry.lines) });
}

export async function reverseEntry(db: Db, input: ReverseInput) {
  await checkReversal(db, input); // refused before a transaction opens, as before
  return db.$transaction((tx) => reverseEntryTx(tx, input));
}

/** A reversal's memo: the original's, with its date. */
export const reversalMemo = (e: { memo: string; date: Date }) => `Pembalik: ${e.memo} (${formatDate(e.date)})`;

/** An entry's lines mirrored (debit ↔ credit), same accounts, memos and sources: the lines of its reversal. */
export const mirrorLines = (lines: { accountId: string; debit: bigint; credit: bigint; memo?: string | null; sourceAccountId?: string | null; sourceRef?: string | null }[]) =>
  lines.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit, memo: l.memo ?? undefined, sourceAccountId: l.sourceAccountId ?? null, sourceRef: l.sourceRef ?? null }));
