import type { Db } from "@/lib/db";
import { checkTags } from "@/lib/dimensions";
import type { InvoiceDirection, WithholdingKind } from "@/lib/generated/prisma/enums";
import { LedgerError, postJournal, type PostLine } from "@/lib/ledger/post";
import { ACCOUNT_CODES } from "@/lib/coa/template";
import { dateOnly, formatDate, formatPeriod } from "@/lib/format";
import { closeLock } from "@/lib/adjust/schedules";
import { formatMoney, parseMoney, PPN_EFFECTIVE_PERCENT } from "@/lib/money";
import { recordEvent } from "@/lib/audit";
import { checkWithholding, withholdingFor } from "@/lib/tax/withholding";
import { assertAfterOpening } from "@/lib/ledger/opening-date";

/**
 * Receivable/payable subledger (accounting-rules 5c). An invoice is recorded by the accountant and posts its journal through
 * postJournal() (kind INVOICE): sales Dr receivable / Cr revenue + PPN Keluaran, purchases Dr expense or asset + PPN Masukan / Cr
 * payable. A Saldo Awal invoice posts nothing: the opening entry already holds its balance.
 */
export const DIRECTION_LABEL: Record<InvoiceDirection, string> = { SALES: "Piutang", PURCHASE: "Utang" };
export const DEFAULT_AR_AP: Record<InvoiceDirection, string> = { SALES: "1130", PURCHASE: "2110" };
const AR_AP_LINE: Record<InvoiceDirection, string> = { SALES: "PIUTANG_USAHA", PURCHASE: "UTANG_USAHA" };

export type InvoiceInput = {
  clientId: string;
  entityId: string;
  direction: InvoiceDirection;
  contactName: string;
  contactNpwp?: string | null;
  number: string;
  /** YYYY-MM-DD */
  issueDate: string;
  /** YYYY-MM-DD; default the issue date (due immediately). */
  dueDate?: string | null;
  description?: string;
  /** Major units of the entity's functional currency (rule 6). */
  dpp: string;
  ppn?: string | null;
  counterCode: string;
  arApCode?: string | null;
  /**
   * Tax the counterparty withholds from the payment (PPh 23, 22, 4(2); PPh 21 on a purchase): a percentage of the DPP or an amount
   * (major units; the amount wins). Expected only — the receivable/payable and the journal stay gross; it is booked when a settlement closes the invoice.
   */
  whtKind?: WithholdingKind | null;
  whtRate?: string | null;
  whtAmount?: string | null;
  /** An open item at the opening date: recorded without a journal. */
  opening?: boolean;
  /** Departemen & Proyek (lib/dimensions): on the revenue / expense (or asset) line only, never the receivable, payable or PPN line. */
  departmentId?: string | null;
  projectId?: string | null;
  actorId?: string | null;
};

/** PPN at the effective rate (rule 8), rounded half up — a prefill; the tax invoice's own amount wins. */
export function ppnFor(dpp: bigint): bigint {
  return (2n * dpp * PPN_EFFECTIVE_PERCENT + 100n) / 200n;
}

function parseDay(s: string, what: string): Date {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m ? dateOnly(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  if (!d || d.getUTCMonth() + 1 !== Number(m![2])) throw new LedgerError(`${what} tidak valid.`);
  return d;
}

export async function createInvoice(db: Db, input: InvoiceInput) {
  const entity = await db.entity.findFirst({ where: { id: input.entityId, clientId: input.clientId } });
  if (!entity) throw new LedgerError("Pilih entitas.");
  const sales = input.direction === "SALES";
  if (!sales && input.direction !== "PURCHASE") throw new LedgerError("Pilih jenis: piutang atau utang.");
  const number = input.number.trim();
  const contactName = input.contactName.trim().replace(/\s+/g, " ");
  if (!number) throw new LedgerError("Isi nomor faktur.");
  if (!contactName) throw new LedgerError(sales ? "Isi nama pelanggan." : "Isi nama pemasok.");
  const issueDate = parseDay(input.issueDate, "Tanggal faktur");
  const dueDate = input.dueDate?.trim() ? parseDay(input.dueDate, "Tanggal jatuh tempo") : issueDate;
  if (+dueDate < +issueDate) throw new LedgerError("Jatuh tempo tidak boleh sebelum tanggal faktur.");
  const cur = entity.functionalCurrency;
  const dpp = parseMoney(input.dpp, cur);
  const ppn = input.ppn?.trim() ? parseMoney(input.ppn, cur) : 0n;
  if (dpp < 0n || ppn < 0n) throw new LedgerError("DPP dan PPN tidak boleh negatif.");
  const total = dpp + ppn;
  if (total <= 0n) throw new LedgerError("Nilai faktur harus lebih dari nol.");

  let whtKind: WithholdingKind | null = null;
  let whtAmount = 0n;
  if (input.whtRate?.trim() || input.whtAmount?.trim()) {
    if (!input.whtKind) throw new LedgerError("Pilih jenis pajak yang dipotong.");
    whtAmount = input.whtAmount?.trim() ? parseMoney(input.whtAmount, cur) : withholdingFor(dpp, input.whtRate!);
    if (whtAmount > dpp) throw new LedgerError("Pemotongan pajak melebihi DPP.");
    if (whtAmount > 0n) {
      checkWithholding({ kind: input.whtKind, amount: whtAmount }, sales ? "IN" : "OUT");
      whtKind = input.whtKind;
    }
  }

  const accounts = await db.account.findMany({ where: { clientId: input.clientId } });
  const byCode = (code: string) => accounts.find((a) => a.code === code);
  const arAp = byCode(input.arApCode?.trim() || DEFAULT_AR_AP[input.direction]);
  if (!arAp || arAp.fsLine !== AR_AP_LINE[input.direction] || arAp.normalBalance !== (sales ? "DEBIT" : "CREDIT")) throw new LedgerError(sales ? "Akun piutang harus akun Piutang Usaha." : "Akun utang harus akun Utang Usaha.");
  const counter = byCode(input.counterCode);
  const counterOk = counter && !counter.isBank && !counter.isSuspense && !counter.isClearing && !counter.isIntercompany && counter.id !== arAp.id && (sales ? counter.type === "PENDAPATAN" : counter.type === "BEBAN" || counter.type === "ASET");
  if (!counterOk) throw new LedgerError(sales ? "Pilih akun pendapatan untuk faktur penjualan." : "Pilih akun beban atau aset untuk tagihan pembelian (bukan akun bank).");
  const tags = await checkTags(db, input.clientId, input);
  const ppnAccount = ppn > 0n ? byCode(sales ? ACCOUNT_CODES.PPN_KELUARAN : ACCOUNT_CODES.PPN_MASUKAN) : null;
  if (ppn > 0n && !ppnAccount) throw new LedgerError(`Akun ${sales ? ACCOUNT_CODES.PPN_KELUARAN : ACCOUNT_CODES.PPN_MASUKAN} tidak ada di bagan akun klien.`);

  // A Saldo Awal item enters the subledger at the opening date; without a journal, postJournal's period check doesn't run, so the
  // month is checked here (under the close lock, inside the write below).
  let openingMonth: { year: number; month: number } | null = null;
  if (input.opening) {
    const opening = await db.journalEntry.findFirst({ where: { entityId: entity.id, kind: "OPENING" }, orderBy: { date: "asc" } });
    if (!opening) throw new LedgerError("Catat Saldo Awal entitas ini dulu; faktur saldo awal adalah rincian saldonya.");
    if (+issueDate > +opening.date) throw new LedgerError(`Faktur saldo awal harus bertanggal paling lambat ${formatDate(opening.date)} (tanggal Saldo Awal).`);
    openingMonth = { year: opening.date.getUTCFullYear(), month: opening.date.getUTCMonth() + 1 };
  } else {
    await assertAfterOpening(db, entity, issueDate, `, atau centang “${sales ? "Faktur" : "Tagihan"} saldo awal” bila sudah termasuk di Saldo Awal`);
  }

  const description = input.description?.trim() || (sales ? `Penjualan kepada ${contactName}` : `Pembelian dari ${contactName}`);
  try {
    return await db.$transaction(async (tx) => {
      if (openingMonth) {
        await closeLock(tx, input.clientId);
        // It stays in every later month's list, so any locked month from the opening on would change after the fact.
        const { year: y, month: m } = openingMonth;
        const locked = await tx.period.findFirst({ where: { clientId: input.clientId, status: "LOCKED", OR: [{ year: { gt: y } }, { year: y, month: { gte: m } }] }, orderBy: [{ year: "asc" }, { month: "asc" }] });
        if (locked) throw new LedgerError(`${formatPeriod(locked.year, locked.month)} sudah dikunci, dan rincian saldo awal mengubah daftar ${sales ? "piutang" : "utang"} bulan itu. Buka kunci bulan itu dulu.`);
      }
      const contact = await tx.contact.upsert({
        where: { clientId_name: { clientId: input.clientId, name: contactName } },
        update: input.contactNpwp?.trim() ? { npwp: input.contactNpwp.trim() } : {},
        create: { firmId: entity.firmId, clientId: input.clientId, name: contactName, npwp: input.contactNpwp?.trim() || null },
      });
      let entryId: string | null = null;
      if (!input.opening) {
        const lines: PostLine[] = sales
          ? [{ accountId: arAp.id, debit: total }, ...(dpp > 0n ? [{ accountId: counter!.id, credit: dpp, ...tags }] : []), ...(ppn > 0n ? [{ accountId: ppnAccount!.id, credit: ppn }] : [])]
          : [...(dpp > 0n ? [{ accountId: counter!.id, debit: dpp, ...tags }] : []), ...(ppn > 0n ? [{ accountId: ppnAccount!.id, debit: ppn }] : []), { accountId: arAp.id, credit: total }];
        const memo = `${sales ? "Faktur" : "Tagihan"} ${number} · ${contactName}`;
        entryId = (await postJournal(tx, { entityId: entity.id, date: issueDate, kind: "INVOICE", memo, lines, actorId: input.actorId })).id;
      }
      return tx.invoice.create({
        data: {
          firmId: entity.firmId,
          clientId: input.clientId,
          entityId: entity.id,
          contactId: contact.id,
          direction: input.direction,
          number,
          issueDate,
          dueDate,
          description,
          dpp,
          ppn,
          total,
          whtKind,
          whtAmount,
          counterAccountId: counter!.id,
          arApAccountId: arAp.id,
          opening: !!input.opening,
          entryId,
          ...tags,
          createdById: input.actorId ?? null,
        },
      });
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      const used = await db.invoice.findFirst({ where: { entityId: input.entityId, direction: input.direction, number }, select: { voidedAt: true } });
      throw new LedgerError(used?.voidedAt ? `Nomor ${number} dipakai ${sales ? "faktur" : "tagihan"} yang sudah dikeluarkan. Beri nomor lain, mis. ${number}-R.` : `Nomor ${number} sudah dipakai untuk ${sales ? "faktur" : "tagihan"} lain entitas ini.`);
    }
    throw e;
  }
}

export const VOID_MIN = 10;

/**
 * *Keluarkan dokumen* (UC-B5): a wrongly entered invoice or bill (a supplier's document entered as a sales note, a duplicate) leaves the
 * subledger. Its journal is reversed by a mirror entry through postJournal() dated on the original, so the month's figures drop it; a
 * locked month refuses. A Saldo Awal item posts nothing and is only marked (its opening month and later must be open, as for recording
 * it). The document stays, struck through with its reason, and the history keeps the decision. Refused while it has settlements.
 */
export async function voidInvoice(db: Db, input: { clientId: string; invoiceId: string; reason: string; actorId?: string | null }) {
  const reason = input.reason.trim().replace(/\s+/g, " ");
  if (reason.length < VOID_MIN) throw new LedgerError(`Tulis alasannya (min. ${VOID_MIN} karakter), mis. "dokumen pemasok, bukan nota penjualan".`);
  return db.$transaction(async (tx) => {
    await closeLock(tx, input.clientId);
    await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${input.invoiceId} FOR UPDATE`;
    const inv = await tx.invoice.findFirst({
      where: { id: input.invoiceId, clientId: input.clientId },
      include: { contact: true, entity: true, settlements: { select: { id: true } }, entry: { include: { lines: true, assetsFrom: { select: { name: true } }, schedulesFrom: { select: { id: true } } } } },
    });
    if (!inv) throw new LedgerError("Faktur tidak ditemukan.");
    const sales = inv.direction === "SALES";
    const doc = `${sales ? "Faktur" : "Tagihan"} ${inv.number}`;
    if (inv.voidedAt) throw new LedgerError(`${doc} sudah dikeluarkan.`);
    if (inv.settlements.length) throw new LedgerError(`${doc} sudah dicocokkan ke ${inv.settlements.length} mutasi bank. Hapus pencocokannya dulu, lalu keluarkan.`);
    // Its journal feeds a register: reversing it underneath would leave the asset or the schedule running on nothing.
    if (inv.entry?.assetsFrom.length) throw new LedgerError(`${doc} tercatat sebagai aset tetap (${inv.entry.assetsFrom.map((x) => x.name).join(", ")}). Hapus atau lepas asetnya dulu di Aset Tetap.`);
    if (inv.entry?.schedulesFrom.length) throw new LedgerError(`${doc} dipakai jadwal jurnal (amortisasi). Hentikan jadwalnya dulu di Jurnal Penyesuaian.`);
    let voidEntryId: string | null = null;
    if (inv.entry) {
      const { date } = inv.entry;
      const period = await tx.period.findUnique({ where: { clientId_year_month: { clientId: input.clientId, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 } } });
      if (period?.status === "LOCKED") throw new LedgerError(`${formatPeriod(period.year, period.month)} sudah dikunci, dan ${sales ? "faktur" : "tagihan"} ${inv.number} dibalik pada tanggal aslinya (${formatDate(date)}). Buka kunci bulan itu dulu.`);
      voidEntryId = (
        await postJournal(tx, {
          entityId: inv.entityId,
          date,
          kind: "INVOICE",
          memo: `Batal ${doc} · ${inv.contact.name}: ${reason}`,
          reversesId: inv.entry.id,
          actorId: input.actorId,
          lines: inv.entry.lines.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit, memo: l.memo ?? undefined, sourceAccountId: l.sourceAccountId, sourceRef: l.sourceRef, departmentId: l.departmentId, projectId: l.projectId })),
        })
      ).id;
    } else {
      // A Saldo Awal item sits in every list from the opening on: a locked month from there would change after the fact.
      const opening = await tx.journalEntry.findFirst({ where: { entityId: inv.entityId, kind: "OPENING" }, orderBy: { date: "asc" }, select: { date: true } });
      const from = opening?.date ?? inv.issueDate;
      const [y, m] = [from.getUTCFullYear(), from.getUTCMonth() + 1];
      const locked = await tx.period.findFirst({ where: { clientId: input.clientId, status: "LOCKED", OR: [{ year: { gt: y } }, { year: y, month: { gte: m } }] }, orderBy: [{ year: "asc" }, { month: "asc" }] });
      if (locked) throw new LedgerError(`${formatPeriod(locked.year, locked.month)} sudah dikunci, dan rincian saldo awal mengubah daftar ${sales ? "piutang" : "utang"} bulan itu. Buka kunci bulan itu dulu.`);
    }
    const voided = await tx.invoice.update({ where: { id: inv.id }, data: { voidedAt: new Date(), voidReason: reason, voidEntryId, voidedById: input.actorId ?? null } });
    await recordEvent(tx, {
      clientId: input.clientId,
      entityId: inv.entityId,
      kind: "DOCUMENT_VOID",
      subject: `invoice:${inv.id}`,
      summary: `${doc} · ${inv.contact.name} · ${formatMoney(inv.total, inv.entity.functionalCurrency)} dikeluarkan: ${reason}${inv.entry ? "" : " (saldo awal, tanpa jurnal)"}`,
      before: { status: "AKTIF", total: inv.total.toString() },
      after: { status: "DIKELUARKAN", reason, voidEntryId },
      actorId: input.actorId,
    });
    return voided;
  });
}
