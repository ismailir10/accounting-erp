import type { Db } from "@/lib/db";
import { recordEvent } from "@/lib/audit";
import { LedgerError } from "@/lib/ledger/post";
import { dateOnly, formatDate } from "@/lib/format";
import { formatRupiah, parseMoney } from "@/lib/money";
import { packApplies } from "@/lib/tax/pack";
import { DOCUMENT_LABEL, DOCUMENT_NUMBER_MAX, isDocumentType, isSlipKind, KOP_CODE, listedKop, parseRate, rateLabel } from "@/lib/tax/bppu-codes";

/**
 * The bukti potong detail of one payment the company withheld PPh 23 / 4(2) / 22 from (cycle docs/cycles/2026-10-17-bppu-files.md): the
 * recipient when the line has none, the Kode Objek Pajak with its rate, the DPP and the reference document. Metadata only: it posts
 * nothing and never changes the line's `whtKind` / `whtAmount` (accounting-rules 5h), so it may be set in a locked month. Every field may
 * be left empty; the pre-flight (`bppuDraft`) names what is still missing. A KOP of another kind is stored and blocked there, not here.
 */
export type SlipInput = {
  clientId: string;
  bankTransactionId: string;
  /** The recipient when the line has no contact: one of the client's contacts, or a new name (upserted by name, as invoices do). */
  contactId?: string | null;
  contactName?: string | null;
  kop: string;
  /** Only for a code outside the list ("1,75"); a listed code takes DJP's rate. */
  rate?: string | null;
  /** Whole Rupiah, as typed. */
  dpp: string;
  documentType: string;
  documentNumber: string;
  /** YYYY-MM-DD */
  documentDate: string;
  actorId?: string | null;
};

const NAME_MAX = 120;

function parseDay(s: string): Date | null {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = dateOnly(Number(m[1]), Number(m[2]), Number(m[3]));
  return d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3]) ? d : null;
}

export async function setWithholdingSlip(db: Db, input: SlipInput) {
  const line = await db.bankTransaction.findUnique({ where: { id: input.bankTransactionId }, include: { contact: { select: { id: true, name: true } } } });
  const entity = line ? await db.entity.findFirst({ where: { id: line.entityId, clientId: input.clientId }, select: { id: true, firmId: true, kind: true, functionalCurrency: true } }) : null;
  if (!line || !entity) throw new LedgerError("Mutasi tidak ditemukan di klien ini.");
  if (!packApplies(entity) || line.direction !== "OUT" || !isSlipKind(line.whtKind) || line.whtAmount <= 0n) {
    throw new LedgerError("Bukti potong hanya untuk pembayaran badan usaha Rupiah yang dipotong PPh 23, 4(2) atau 22. Catat potongannya di Review dulu.");
  }

  // Recipient: the line's own contact wins; the slip names one only when the line has none (the line itself stays untagged).
  const pickedId = (input.contactId ?? "").trim();
  const name = (input.contactName ?? "").trim().replace(/\s+/g, " ");
  if (line.contact && ((pickedId && pickedId !== line.contact.id) || (name && name !== line.contact.name))) {
    throw new LedgerError(`Penerima mutasi ini sudah ${line.contact.name}; ubah lewat Piutang & Utang.`);
  }
  if (name.length > NAME_MAX) throw new LedgerError(`Nama penerima paling panjang ${NAME_MAX} karakter.`);
  let picked: { id: string; name: string } | null = null;
  if (!line.contact && pickedId) {
    picked = await db.contact.findFirst({ where: { id: pickedId, clientId: input.clientId }, select: { id: true, name: true } });
    if (!picked) throw new LedgerError("Penerima tidak ditemukan di klien ini.");
  }

  const kop = input.kop.trim();
  let rate: number | null = null;
  if (kop) {
    if (!KOP_CODE.test(kop)) throw new LedgerError("Kode objek pajak ditulis NN-NNN-NN, mis. 24-104-03.");
    rate = listedKop(kop)?.rate ?? parseRate(input.rate);
    if (rate === null) throw new LedgerError("Tarif berupa persen di atas 0 sampai 100, paling banyak 2 angka di belakang koma, mis. 1,75.");
  }
  const dpp = parseMoney(input.dpp ?? "", "IDR");
  if (dpp < 0n || (input.dpp.trim() && dpp === 0n)) throw new LedgerError("DPP harus lebih dari nol.");
  const documentType = input.documentType.trim();
  if (documentType && !isDocumentType(documentType)) throw new LedgerError("Pilih jenis dokumen referensi dari daftar.");
  const documentNumber = input.documentNumber.trim().replace(/\s+/g, " ");
  if (documentNumber.length > DOCUMENT_NUMBER_MAX) throw new LedgerError(`Nomor dokumen paling panjang ${DOCUMENT_NUMBER_MAX} karakter.`);
  const documentDate = input.documentDate.trim() ? parseDay(input.documentDate) : null;
  if (input.documentDate.trim() && !documentDate) throw new LedgerError("Tanggal dokumen tidak valid.");

  return db.$transaction(async (tx) => {
    const recipient = line.contact
      ? null
      : (picked ??
        (name
          ? await tx.contact.upsert({ where: { clientId_name: { clientId: input.clientId, name } }, update: {}, create: { firmId: entity.firmId, clientId: input.clientId, name }, select: { id: true, name: true } })
          : null));
    const data = {
      contactId: recipient?.id ?? null,
      kop: kop || null,
      rate,
      dpp: dpp > 0n ? dpp : null,
      documentType: documentType || null,
      documentNumber: documentNumber || null,
      documentDate,
      updatedById: input.actorId ?? null,
    };
    const slip = await tx.withholdingSlip.upsert({
      where: { bankTransactionId: line.id },
      update: data,
      create: { ...data, firmId: entity.firmId, clientId: input.clientId, entityId: entity.id, bankTransactionId: line.id },
    });
    const who = line.contact?.name ?? recipient?.name;
    const parts = [
      who ? `penerima ${who}` : "",
      kop ? `kode ${kop} (${rateLabel(rate!)})` : "",
      dpp > 0n ? `DPP ${formatRupiah(dpp)}` : "",
      documentType ? `${DOCUMENT_LABEL[documentType as keyof typeof DOCUMENT_LABEL].toLowerCase()} ${documentNumber}${documentDate ? ` (${formatDate(documentDate)})` : ""}`.trim() : "",
    ].filter(Boolean);
    await recordEvent(tx, {
      clientId: input.clientId,
      entityId: entity.id,
      kind: "BUKTI_POTONG",
      subject: `slip:${line.id}`,
      // Names, codes and amounts only: a recipient's NPWP or NIK never goes into the history.
      summary: `Bukti potong ${line.description} ${formatDate(line.date)}: ${parts.join(", ") || "dikosongkan"}`,
      after: { contact: who ?? null, kop: data.kop, rate, dpp: data.dpp?.toString() ?? null, documentType: data.documentType, documentNumber: data.documentNumber, documentDate: documentDate ? documentDate.toISOString().slice(0, 10) : null },
      actorId: input.actorId,
    });
    return slip;
  });
}
