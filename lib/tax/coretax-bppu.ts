import type { Db } from "@/lib/db";
import { periodBounds } from "@/lib/format";
import { formatRupiah } from "@/lib/money";
import { packApplies } from "@/lib/tax/pack";
import { BupotError, bupotRecon } from "@/lib/tax/bupot";
import { companyIdentity } from "@/lib/tax/coretax-faktur";
import { headOfficeNitku, NIK, NITKU, npwp16 } from "@/lib/tax/coretax-codes";
import { exactDpp, FAKTUR_NUMBER, isDocumentType, isSlipKind, kopKind, pphOf, rateLabel, SLIP_KIND_LABEL, SLIP_KINDS, taxTies, type DocumentType, type SlipKind } from "@/lib/tax/bppu-codes";
import { bppuXml, type BppuCompany, type BppuXmlRow } from "@/lib/tax/coretax-bppu-xml";

/**
 * *Dipotong oleh perusahaan* as Coretax's BPPU import (cycle docs/cycles/2026-10-17-bppu-files.md): every outgoing bank line of the masa
 * (bank date, rule 5h) the company withheld PPh 23, 4(2) or 22 from, one slip each — *Siap*, *Diblokir* (every reason, each with where it is
 * fixed) or *Sudah ada di Coretax* (matched to a counted *dibuat* slip in this masa's recon, I5d). Read at request time; only the slip
 * detail the accountant typed is stored. Incoming lines (the customer's slip) and PPh 21 (e-Bupot 21/26) are never candidates.
 * Buku prepares the file and never files it (ADR 0014).
 */
export type BppuReasonCode =
  | "COMPANY_NPWP"
  | "COMPANY_NITKU"
  | "IN_REVIEW"
  | "NO_RECIPIENT"
  | "NO_RECIPIENT_ID"
  | "BAD_NPWP"
  | "BAD_NIK"
  | "BAD_NITKU"
  | "NO_KOP"
  | "KOP_KIND"
  | "NO_DPP"
  | "TAX_DIFF"
  | "NO_DOCUMENT"
  | "BAD_FAKTUR_NUMBER";
/** Where a reason is fixed: Review (the line), the slip sheet, the recipient's identity sheet, or the company's settings. */
export type BppuFix = "REVIEW" | "SLIP" | "RECIPIENT" | "COMPANY";
export type BppuReason = { code: BppuReasonCode; text: string; fix: BppuFix };
export type BppuStatus = "BLOCKED" | "READY" | "IN_CORETAX";

export type BppuRecipient = { id: string; name: string; npwp: string | null; nik: string | null; nitku: string | null; address: string | null; email: string | null };
export type BppuRow = {
  bankTransactionId: string;
  date: Date;
  description: string;
  kind: SlipKind;
  /** Paid + withheld. */
  gross: bigint;
  withheld: bigint;
  inReview: boolean;
  /** The line's own contact (`fromLine`), else the one named on the slip. */
  recipient: (BppuRecipient & { fromLine: boolean }) | null;
  /** The slip as it would be written: what was saved, else the prefill. */
  kop: string | null;
  rate: number | null;
  dpp: bigint | null;
  documentType: DocumentType | null;
  documentNumber: string | null;
  documentDate: Date | null;
  /** Where unsaved values came from: the settled purchase invoice, withheld ÷ rate, the contact's last slip. */
  prefill: { dpp: "INVOICE" | "DIVISION" | null; kop: boolean; document: "INVOICE" | "LAST" | null };
  /** Whether a slip row was saved for the line. */
  saved: boolean;
  status: BppuStatus;
  reasons: BppuReason[];
  /** The Coretax slip number it was matched to. */
  coretaxNumber: string | null;
  xml: BppuXmlRow | null;
};
export type BppuDraft = {
  entity: { id: string; name: string; shortName: string };
  year: number;
  month: number;
  company: BppuCompany | null;
  /** Blocks the whole file (the company's NPWP or NITKU). */
  companyReasons: BppuReason[];
  rows: BppuRow[];
  counts: { ready: number; blocked: number; inCoretax: number };
};

const ORDER: Record<BppuStatus, number> = { BLOCKED: 0, READY: 1, IN_CORETAX: 2 };
const kindLabel = (k: string) => (isSlipKind(k) ? SLIP_KIND_LABEL[k] : k === "PPH_26" ? "PPh 26" : "bukan Unifikasi");

/** The recipient as Coretax writes it: NPWP16 with its NITKU (default + 000000), else the NIK with NIK + 000000 (DJP's sample). */
function recipientId(c: BppuRecipient): { id: { tin: string; idtku: string } | null; reasons: BppuReason[] } {
  if (c.npwp) {
    const tin = npwp16(c.npwp);
    if (!tin) return { id: null, reasons: [{ code: "BAD_NPWP", text: `NPWP penerima (${c.npwp}) bukan 15 atau 16 angka.`, fix: "RECIPIENT" }] };
    const idtku = c.nitku ?? headOfficeNitku(tin);
    if (!NITKU.test(idtku) || !idtku.startsWith(tin)) return { id: null, reasons: [{ code: "BAD_NITKU", text: "NITKU penerima harus 22 angka diawali NPWP-nya.", fix: "RECIPIENT" }] };
    return { id: { tin, idtku }, reasons: [] };
  }
  if (c.nik) {
    if (!NIK.test(c.nik)) return { id: null, reasons: [{ code: "BAD_NIK", text: "NIK penerima harus 16 angka.", fix: "RECIPIENT" }] };
    return { id: { tin: c.nik, idtku: headOfficeNitku(c.nik) }, reasons: [] };
  }
  return { id: null, reasons: [{ code: "NO_RECIPIENT_ID", text: `NPWP atau NIK ${c.name} belum diisi.`, fix: "RECIPIENT" }] };
}

/** Every reason a row can't go into the file yet. */
function check(r: Omit<BppuRow, "status" | "reasons" | "coretaxNumber" | "xml">): BppuReason[] {
  const reasons: BppuReason[] = [];
  if (r.inReview) reasons.push({ code: "IN_REVIEW", text: "Mutasi ini masih di Review: putuskan dulu akun dan potongannya.", fix: "REVIEW" });
  if (!r.recipient) reasons.push({ code: "NO_RECIPIENT", text: "Penerima belum dipilih.", fix: "SLIP" });
  else reasons.push(...recipientId(r.recipient).reasons);
  if (!r.kop || r.rate === null) reasons.push({ code: "NO_KOP", text: "Kode objek pajak belum dipilih.", fix: "SLIP" });
  else {
    const k = kopKind(r.kop);
    if (k !== r.kind) reasons.push({ code: "KOP_KIND", text: `Kode ${r.kop} adalah ${k ? kindLabel(k) : "kode di luar Unifikasi"}, mutasi mencatat ${SLIP_KIND_LABEL[r.kind]}. Pilih kode ${SLIP_KIND_LABEL[r.kind]}, atau ubah jenis potongannya di Review.`, fix: "SLIP" });
  }
  if (r.dpp === null) reasons.push({ code: "NO_DPP", text: "DPP belum diisi.", fix: "SLIP" });
  else if (r.rate !== null && !taxTies(r.dpp, r.rate, r.withheld)) {
    reasons.push({
      code: "TAX_DIFF",
      text: `${rateLabel(r.rate)} × DPP ${formatRupiah(r.dpp)} = ${formatRupiah(pphOf(r.dpp, r.rate))}, buku mencatat PPh ${formatRupiah(r.withheld)}. Perbaiki DPP di bukti potong, atau jumlah potongannya di Review.`,
      fix: "SLIP",
    });
  }
  if (!r.documentType || !r.documentNumber || !r.documentDate) reasons.push({ code: "NO_DOCUMENT", text: "Dokumen referensi belum diisi.", fix: "SLIP" });
  else if (r.documentType === "TaxInvoice" && !FAKTUR_NUMBER.test(r.documentNumber)) reasons.push({ code: "BAD_FAKTUR_NUMBER", text: `Nomor faktur pajak (${r.documentNumber}) harus 16 atau 17 angka.`, fix: "SLIP" });
  return reasons;
}

const CONTACT = { select: { id: true, name: true, npwp: true, nik: true, nitku: true, address: true, email: true } } as const;

export async function bppuDraft(db: Db, input: { clientId: string; entityId: string; year: number; month: number }): Promise<BppuDraft> {
  const { year, month } = input;
  const e = await db.entity.findFirst({ where: { id: input.entityId, clientId: input.clientId }, select: { id: true, name: true, shortName: true, kind: true, functionalCurrency: true, npwp: true, nitku: true } });
  if (!e) throw new BupotError("Perusahaan tidak ditemukan di klien ini.");
  if (!packApplies(e)) throw new BupotError("Bukti potong Coretax hanya untuk badan usaha (PT/CV) dengan pembukuan Rupiah.");
  const { start, end } = periodBounds(year, month);
  const lines = await db.bankTransaction.findMany({
    where: { entityId: e.id, direction: "OUT", date: { gte: start, lte: end }, whtKind: { in: SLIP_KINDS }, whtAmount: { gt: 0n } },
    include: {
      contact: CONTACT,
      slip: { include: { contact: CONTACT } },
      settlements: { where: { withheld: { gt: 0n } }, select: { invoice: { select: { direction: true, number: true, issueDate: true, dpp: true, voidedAt: true } } } },
    },
    orderBy: [{ date: "asc" }, { rowNumber: "asc" }],
  });

  // Already in Coretax: matched to a counted *dibuat* slip in this masa's recon (a re-import after the upload closes the round trip).
  const recon = await bupotRecon(db, { clientId: input.clientId, entityId: e.id, year, month });
  const inCoretax = new Map(recon.directions.find((d) => d.direction === "DIBUAT")!.matched.map((m) => [m.book.id, m.slip.number]));

  // Next month prefills the KOP and document type from the same recipient's last slip (never the DPP).
  const recipientIds = [...new Set(lines.map((l) => l.contactId ?? l.slip?.contactId).filter((id): id is string => !!id))];
  const previous = recipientIds.length
    ? await db.withholdingSlip.findMany({
        where: { clientId: input.clientId, kop: { not: null }, OR: [{ contactId: { in: recipientIds } }, { contactId: null, bankTransaction: { contactId: { in: recipientIds } } }] },
        select: { bankTransactionId: true, contactId: true, kop: true, rate: true, documentType: true, bankTransaction: { select: { contactId: true } } },
        orderBy: [{ bankTransaction: { date: "desc" } }, { updatedAt: "desc" }],
      })
    : [];

  const { id: company, reasons: companyReasons } = companyIdentity(e, "bukti potong");
  const rows: BppuRow[] = lines.map((l) => {
    const kind = l.whtKind as SlipKind;
    const s = l.slip;
    const contact = l.contact ?? s?.contact ?? null;
    const recipient = contact ? { ...contact, fromLine: !!l.contact } : null;
    const last = contact ? previous.find((p) => p.bankTransactionId !== l.id && (p.contactId ?? p.bankTransaction.contactId) === contact.id && kopKind(p.kop!) === kind) : undefined;
    const kop = s?.kop ?? last?.kop ?? null;
    const rate = s?.kop ? s.rate : (last?.rate ?? null);
    // The one purchase invoice this payment settled with tax withheld.
    const invoices = l.settlements.map((x) => x.invoice).filter((i) => i.direction === "PURCHASE" && !i.voidedAt);
    const invoice = invoices.length === 1 ? invoices[0] : null;
    // DPP: the invoice's when it holds at the rate; else withheld ÷ rate when exact, never on a line whose PPN was split (its DPP is the
    // accountant's to state: a whole-Rupiah division at 2 % always succeeds and would hide it); else empty.
    let dpp = s?.dpp ?? null;
    let dppFrom: BppuRow["prefill"]["dpp"] = null;
    if (dpp === null && invoice && (rate === null || taxTies(invoice.dpp, rate, l.whtAmount))) [dpp, dppFrom] = [invoice.dpp, "INVOICE"];
    else if (dpp === null && rate !== null && l.taxTag !== "PPN_MASUKAN" && l.taxTag !== "PPN_KELUARAN") {
      dpp = exactDpp(l.whtAmount, rate);
      dppFrom = dpp === null ? null : "DIVISION";
    }
    const savedType = isDocumentType(s?.documentType) ? s.documentType : null;
    const documentType = savedType ?? (invoice ? "CommercialInvoice" : isDocumentType(last?.documentType) ? last.documentType : null);
    const documentFrom = savedType ? null : invoice ? "INVOICE" : documentType ? "LAST" : null;
    const base = {
      bankTransactionId: l.id,
      date: l.date,
      description: l.description,
      kind,
      gross: -l.amount + l.whtAmount,
      withheld: l.whtAmount,
      inReview: l.status === "NEEDS_REVIEW",
      recipient,
      kop,
      rate,
      dpp,
      documentType,
      documentNumber: s?.documentNumber ?? (invoice ? invoice.number : null),
      documentDate: s?.documentDate ?? (invoice ? invoice.issueDate : null),
      prefill: { dpp: dppFrom, kop: !s?.kop && !!last, document: documentFrom as BppuRow["prefill"]["document"] },
      saved: !!s,
    };
    const coretaxNumber = inCoretax.get(l.id) ?? null;
    if (coretaxNumber) return { ...base, status: "IN_CORETAX", reasons: [], coretaxNumber, xml: null };
    const reasons = check(base);
    const id = recipient ? recipientId(recipient).id : null;
    const xml: BppuXmlRow | null =
      reasons.length || !id
        ? null
        : { year, month, counterpartTin: id.tin, counterpartIdtku: id.idtku, kop: kop!, dpp: dpp!, rate: rate!, withheld: l.whtAmount, document: documentType!, documentNumber: base.documentNumber!, documentDate: base.documentDate!, withholdingDate: l.date };
    return { ...base, status: xml ? "READY" : "BLOCKED", reasons, coretaxNumber: null, xml };
  });
  rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || +a.date - +b.date);

  return {
    entity: { id: e.id, name: e.name, shortName: e.shortName },
    year,
    month,
    company,
    companyReasons,
    rows,
    counts: { ready: rows.filter((r) => r.status === "READY").length, blocked: rows.filter((r) => r.status === "BLOCKED").length, inCoretax: rows.filter((r) => r.status === "IN_CORETAX").length },
  };
}

/** The XML of the *Siap* rows; none while the company itself blocks the file or nothing is ready. */
export function bppuFile(draft: BppuDraft): { rows: number; xml: string } | null {
  const ready = draft.rows.flatMap((r) => (r.status === "READY" && r.xml ? [r.xml] : []));
  if (!draft.company || draft.companyReasons.length || !ready.length) return null;
  return { rows: ready.length, xml: bppuXml(draft.company, ready) };
}
