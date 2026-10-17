import type { Db } from "@/lib/db";
import { periodBounds } from "@/lib/format";
import { formatRupiah } from "@/lib/money";
import { packApplies } from "@/lib/tax/pack";
import { FakturError, fakturRecon } from "@/lib/tax/faktur";
import { DEFAULT_ITEM_CODE, headOfficeNitku, isItemKind, isUnit, NIK, NITKU, npwp16, type ItemKind } from "@/lib/tax/coretax-codes";
import { fakturAmounts, fakturParts, fakturXml, type FakturAmounts, type FakturSeller, type FakturXmlRow } from "@/lib/tax/coretax-faktur-xml";

/**
 * *Faktur keluaran untuk Coretax* (cycle docs/cycles/2026-10-17-coretax-files.md): the masa's sales invoices with PPN as candidates for
 * Coretax's XML import, each *Siap*, *Diblokir* (every reason, each fixed where it says) or *Sudah ada di Coretax*. Read at request time;
 * nothing is stored but the accountant's identity and item entries. Buku prepares the file and never files it (ADR 0014).
 *
 * Candidates: SALES, not voided, not a Saldo Awal item, issued in the masa, PPN above 0, of a Rupiah PT/CV. An invoice is already in
 * Coretax when the masa's ekualisasi matched it to a counted faktur keluaran (I5c), or when it was booked from one (I5e: same number).
 * Bank lines with an estimated PPN split (accounting-rules 8) have no buyer and no faktur-grade DPP: they are listed apart, never exported.
 */
export type ReasonCode = "COMPANY_NPWP" | "COMPANY_NITKU" | "NO_BUYER_ID" | "BAD_NPWP" | "BAD_NIK" | "NIK_NO_ADDRESS" | "BAD_NITKU" | "NO_ITEM" | "PPN_FORMULA";
/** Where a reason is fixed: the buyer sheet, the item form, the invoice itself, or the company's settings. */
export type Fix = "BUYER" | "ITEM" | "INVOICE" | "COMPANY";
export type Reason = { code: ReasonCode; text: string; fix: Fix };
export type DraftStatus = "BLOCKED" | "READY" | "IN_CORETAX";

export type DraftRow = {
  invoiceId: string;
  number: string;
  date: Date;
  description: string;
  dpp: bigint;
  ppn: bigint;
  contact: { id: string; name: string; npwp: string | null; nik: string | null; nitku: string | null; address: string | null; email: string | null };
  /** The faktur item: the invoice's own, else the kind, code and unit of the contact's last invoice that had one (`prefilled`). */
  item: { kind: ItemKind | null; code: string; unit: string | null; name: string; prefilled: boolean };
  amounts: FakturAmounts;
  status: DraftStatus;
  reasons: Reason[];
  /** The Coretax faktur number it was matched to or booked from. */
  coretaxNumber: string | null;
  xml: FakturXmlRow | null;
};
export type FakturDraft = {
  entity: { id: string; name: string; shortName: string };
  year: number;
  month: number;
  seller: FakturSeller | null;
  /** Blocks the whole file (the company's NPWP or NITKU). */
  companyReasons: Reason[];
  rows: DraftRow[];
  counts: { ready: number; blocked: number; inCoretax: number };
  /** Bank lines whose PPN keluaran was split by a rule, with no faktur in Coretax and no invoice: record them as sales invoices first. */
  bankPpn: { key: string; date: Date; label: string; ppn: bigint }[];
};

const ORDER: Record<DraftStatus, number> = { BLOCKED: 0, READY: 1, IN_CORETAX: 2 };

function sellerOf(e: { npwp: string | null; nitku: string | null }): { seller: FakturSeller | null; reasons: Reason[] } {
  const tin = npwp16(e.npwp);
  if (!tin) {
    const text = e.npwp ? `NPWP perusahaan (${e.npwp}) bukan 15 atau 16 angka.` : "NPWP perusahaan belum diisi, jadi faktur tidak bisa dibuat.";
    return { seller: null, reasons: [{ code: "COMPANY_NPWP", text, fix: "COMPANY" }] };
  }
  const idtku = e.nitku ?? headOfficeNitku(tin);
  if (!NITKU.test(idtku) || !idtku.startsWith(tin)) return { seller: null, reasons: [{ code: "COMPANY_NITKU", text: `NITKU perusahaan (${idtku}) harus 22 angka diawali NPWP-nya.`, fix: "COMPANY" }] };
  return { seller: { tin, idtku }, reasons: [] };
}

/** Every reason a row can't go into the file yet, and its buyer when it can. */
function check(row: Pick<DraftRow, "contact" | "item" | "ppn" | "amounts">): { reasons: Reason[]; buyer: FakturXmlRow["buyer"] | null } {
  const reasons: Reason[] = [];
  const c = row.contact;
  let buyer: FakturXmlRow["buyer"] | null = null;
  if (c.npwp) {
    const tin = npwp16(c.npwp);
    if (!tin) reasons.push({ code: "BAD_NPWP", text: `NPWP pembeli (${c.npwp}) bukan 15 atau 16 angka.`, fix: "BUYER" });
    else {
      const idtku = c.nitku ?? headOfficeNitku(tin);
      if (!NITKU.test(idtku)) reasons.push({ code: "BAD_NITKU", text: "NITKU pembeli harus 22 angka.", fix: "BUYER" });
      else buyer = { document: "TIN", tin, idtku, name: c.name, address: c.address ?? "", email: c.email ?? "" };
    }
  } else if (c.nik) {
    if (!NIK.test(c.nik)) reasons.push({ code: "BAD_NIK", text: "NIK pembeli harus 16 angka.", fix: "BUYER" });
    if (!c.address) reasons.push({ code: "NIK_NO_ADDRESS", text: "Pembeli dengan NIK perlu alamat.", fix: "BUYER" });
    if (!reasons.length) buyer = { document: "National ID", nik: c.nik, name: c.name, address: c.address!, email: c.email ?? "" };
  } else reasons.push({ code: "NO_BUYER_ID", text: "NPWP atau NIK pembeli belum diisi.", fix: "BUYER" });
  if (!row.item.kind || !row.item.unit) reasons.push({ code: "NO_ITEM", text: "Barang/jasa dan satuannya belum diatur.", fix: "ITEM" });
  const diff = row.amounts.vatSen - row.ppn * 100n;
  if (diff <= -100n || diff >= 100n) {
    const formula = (row.amounts.vatSen + 50n) / 100n;
    reasons.push({
      code: "PPN_FORMULA",
      text: `PPN ${formatRupiah(row.ppn)} tidak sama dengan 12% × 11/12 × DPP (${formatRupiah(formula)}). Perbaiki fakturnya (keluarkan, lalu catat ulang); kode transaksi selain 04 (mis. barang mewah, pemungut) belum didukung, buat fakturnya langsung di Coretax.`,
      fix: "INVOICE",
    });
  }
  return { reasons, buyer: reasons.length ? null : buyer };
}

export async function fakturKeluaranDraft(db: Db, input: { clientId: string; entityId: string; year: number; month: number }): Promise<FakturDraft> {
  const { year, month } = input;
  const e = await db.entity.findFirst({ where: { id: input.entityId, clientId: input.clientId }, select: { id: true, name: true, shortName: true, kind: true, functionalCurrency: true, npwp: true, nitku: true } });
  if (!e) throw new FakturError("Perusahaan tidak ditemukan di klien ini.");
  if (!packApplies(e)) throw new FakturError("Faktur Coretax hanya untuk badan usaha (PT/CV) dengan pembukuan Rupiah.");
  const { start, end } = periodBounds(year, month);
  const invoices = await db.invoice.findMany({
    where: { clientId: input.clientId, entityId: e.id, direction: "SALES", voidedAt: null, opening: false, issueDate: { gte: start, lte: end }, ppn: { gt: 0n } },
    include: { contact: { select: { id: true, name: true, npwp: true, nik: true, nitku: true, address: true, email: true } } },
    orderBy: [{ issueDate: "asc" }, { number: "asc" }],
  });

  // Already in Coretax: matched in this masa's ekualisasi, or booked from a Coretax faktur (I5e keeps its number).
  const recon = await fakturRecon(db, { clientId: input.clientId, entityId: e.id, year, month });
  const keluaran = recon.directions.find((d) => d.direction === "KELUARAN")!;
  const inCoretax = new Map<string, string>();
  for (const m of keluaran.matched) if (m.book.invoiceId) inCoretax.set(m.book.invoiceId, m.faktur.number);
  const booked = await db.coretaxFaktur.findMany({ where: { entityId: e.id, direction: "KELUARAN", number: { in: invoices.map((i) => i.number) } }, select: { number: true } });
  const bookedNumbers = new Set(booked.map((f) => f.number));

  // Next month prefills from the contact's last invoice that had its item set.
  const missing = [...new Set(invoices.filter((i) => !isItemKind(i.fakturItemKind) || !isUnit(i.fakturUnit)).map((i) => i.contactId))];
  const last = missing.length
    ? await db.invoice.findMany({
        where: { clientId: input.clientId, direction: "SALES", voidedAt: null, contactId: { in: missing }, fakturItemKind: { not: null }, fakturUnit: { not: null } },
        orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
        distinct: ["contactId"],
        select: { contactId: true, fakturItemKind: true, fakturItemCode: true, fakturUnit: true },
      })
    : [];
  const lastBy = new Map(last.map((l) => [l.contactId, l]));

  const { seller, reasons: companyReasons } = sellerOf(e);
  const rows: DraftRow[] = invoices.map((inv) => {
    const own = isItemKind(inv.fakturItemKind) && isUnit(inv.fakturUnit);
    const prev = own ? null : lastBy.get(inv.contactId);
    const src = own ? inv : prev;
    const item = {
      kind: src && isItemKind(src.fakturItemKind) ? src.fakturItemKind : null,
      code: src?.fakturItemCode ?? DEFAULT_ITEM_CODE,
      unit: src && isUnit(src.fakturUnit) ? src.fakturUnit : null,
      name: inv.fakturItemName ?? inv.description,
      prefilled: !own && !!prev,
    };
    const base = { invoiceId: inv.id, number: inv.number, date: inv.issueDate, description: inv.description, dpp: inv.dpp, ppn: inv.ppn, contact: inv.contact, item, amounts: fakturAmounts(inv.dpp) };
    const coretaxNumber = inCoretax.get(inv.id) ?? (bookedNumbers.has(inv.number) ? inv.number : null);
    if (coretaxNumber) return { ...base, status: "IN_CORETAX", reasons: [], coretaxNumber, xml: null };
    const { reasons, buyer } = check(base);
    const xml: FakturXmlRow | null = buyer && item.kind && item.unit ? { date: inv.issueDate, ref: inv.number, buyer, item: { opt: item.kind, code: item.code, name: item.name, unit: item.unit }, dpp: inv.dpp } : null;
    return { ...base, status: reasons.length ? "BLOCKED" : "READY", reasons, coretaxNumber: null, xml };
  });
  rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || +a.date - +b.date || a.number.localeCompare(b.number));

  return {
    entity: { id: e.id, name: e.name, shortName: e.shortName },
    year,
    month,
    seller,
    companyReasons,
    rows,
    counts: { ready: rows.filter((r) => r.status === "READY").length, blocked: rows.filter((r) => r.status === "BLOCKED").length, inCoretax: rows.filter((r) => r.status === "IN_CORETAX").length },
    bankPpn: keluaran.unmatchedBook.filter((b) => b.kind === "BANK").map((b) => ({ key: b.key, date: b.date, label: b.label, ppn: b.ppn })),
  };
}

/** The XML files of the *Siap* rows, 1,000 per file; none while the company itself blocks the file. */
export function fakturKeluaranFiles(draft: FakturDraft): { rows: number; xml: string }[] {
  if (!draft.seller || draft.companyReasons.length) return [];
  const ready = draft.rows.flatMap((r) => (r.status === "READY" && r.xml ? [r.xml] : []));
  const parts = fakturParts(ready);
  return parts.map((p, i) => ({ rows: p.length, xml: fakturXml(draft.seller!, p, { index: i + 1, of: parts.length }) }));
}
