import type { Db } from "@/lib/db";
import { recordEvent } from "@/lib/audit";
import { normalizeNpwp, OnboardingError } from "@/lib/onboarding";
import { LedgerError } from "@/lib/ledger/post";
import { DEFAULT_ITEM_CODE, digitsOnly, EMAIL, isItemKind, isUnit, ITEM_CODE, ITEM_KIND_LABEL, NIK, npwp16, readNitku, unitLabel } from "@/lib/tax/coretax-codes";

/**
 * What a sales invoice needs to become a Coretax faktur keluaran (cycle docs/cycles/2026-10-17-coretax-files.md), entered once and reused:
 * the buyer's tax identity on the contact, and the one faktur item on the invoice. Neither moves a figure. NIK, address and email are
 * personal data (UU PDP): they go into the faktur file only, never to a model, and the history names the fields changed, never their values.
 */

export const ADDRESS_MAX = 300;
export const EMAIL_MAX = 120;
export const ITEM_NAME_MAX = 200;

export type ContactTaxIdentityInput = { clientId: string; contactId: string; npwp: string; nik: string; nitku: string; address: string; email: string; actorId?: string | null };

const FIELD_LABEL = { npwp: "NPWP", nik: "NIK", nitku: "NITKU", address: "alamat", email: "email" } as const;
type Field = keyof typeof FIELD_LABEL;

/** Sets the buyer's NPWP / NIK / NITKU / address / email; an empty field clears it. NITKU equal to the head office default is stored as null. */
export async function setContactTaxIdentity(db: Db, input: ContactTaxIdentityInput) {
  const contact = await db.contact.findFirst({ where: { id: input.contactId, clientId: input.clientId } });
  if (!contact) throw new LedgerError("Pelanggan tidak ditemukan.");
  const fields: Record<string, string> = {};
  const npwp = normalizeNpwp(input.npwp ?? "");
  if (npwp === null) fields.npwp = "NPWP berisi 15 atau 16 angka, boleh dengan titik dan strip.";
  const nik = digitsOnly(input.nik);
  if (nik === null || (nik && !NIK.test(nik))) fields.nik = "NIK berisi 16 angka.";
  const nitku = fields.npwp ? null : readNitku(input.nitku, npwp ? npwp16(npwp) : null, "pembeli");
  if (nitku && !nitku.ok) fields.nitku = nitku.error;
  const address = (input.address ?? "").trim().replace(/\s+/g, " ");
  if (address.length > ADDRESS_MAX) fields.address = `Alamat paling panjang ${ADDRESS_MAX} karakter.`;
  const email = (input.email ?? "").trim();
  if (email && (email.length > EMAIL_MAX || !EMAIL.test(email))) fields.email = "Email tidak valid, mis. keuangan@pelanggan.co.id.";
  if (Object.keys(fields).length) throw new OnboardingError(fields);

  const next: Record<Field, string | null> = {
    npwp: npwp || null,
    nik: nik || null,
    nitku: nitku?.ok ? nitku.nitku : null,
    address: address || null,
    email: email || null,
  };
  const changed = (Object.keys(next) as Field[]).filter((f) => (contact[f] ?? null) !== next[f]);
  if (!changed.length) return contact;
  return db.$transaction(async (tx) => {
    const updated = await tx.contact.update({ where: { id: contact.id }, data: next });
    await recordEvent(tx, {
      clientId: input.clientId,
      kind: "FAKTUR",
      subject: `contact:${contact.id}`,
      summary: `Identitas pajak ${contact.name} diubah: ${changed.map((f) => FIELD_LABEL[f]).join(", ")}`,
      // Personal data stays out of the history: only which fields changed.
      after: { changed },
      actorId: input.actorId,
    });
    return updated;
  });
}

export type FakturItemInput = { clientId: string; invoiceIds: string[]; kind: string; code?: string | null; unit: string; /** undefined keeps each invoice's name; "" returns it to the description. */ name?: string | null; actorId?: string | null };

/** Sets the one faktur item (Barang/Jasa, Kode, Satuan, and optionally the name) on one or more sales invoices of one company. */
export async function setInvoiceFakturItem(db: Db, input: FakturItemInput) {
  const ids = [...new Set(input.invoiceIds ?? [])];
  if (!ids.length) throw new LedgerError("Pilih faktur yang diatur.");
  if (!isItemKind(input.kind)) throw new LedgerError("Pilih Barang atau Jasa.");
  const code = (input.code ?? "").trim() || DEFAULT_ITEM_CODE;
  if (!ITEM_CODE.test(code)) throw new LedgerError(`Kode barang/jasa berisi 6 angka; pakai ${DEFAULT_ITEM_CODE} bila tidak ada kode yang cocok.`);
  if (!isUnit(input.unit)) throw new LedgerError("Pilih satuan dari daftar DJP.");
  const name = input.name === undefined || input.name === null ? undefined : input.name.trim().replace(/\s+/g, " ");
  if (name && name.length > ITEM_NAME_MAX) throw new LedgerError(`Nama barang/jasa paling panjang ${ITEM_NAME_MAX} karakter.`);

  const invoices = await db.invoice.findMany({ where: { id: { in: ids }, clientId: input.clientId }, select: { id: true, entityId: true, direction: true, number: true, voidedAt: true, opening: true } });
  if (invoices.length !== ids.length) throw new LedgerError("Faktur tidak ditemukan di klien ini.");
  const wrong = invoices.find((i) => i.direction !== "SALES" || i.voidedAt || i.opening);
  if (wrong) throw new LedgerError(`Faktur ${wrong.number} bukan faktur penjualan aktif: barang/jasa hanya diatur untuk faktur keluaran.`);
  const entityIds = new Set(invoices.map((i) => i.entityId));
  if (entityIds.size !== 1) throw new LedgerError("Atur barang/jasa per perusahaan.");
  const [entityId] = entityIds;

  return db.$transaction(async (tx) => {
    const { count } = await tx.invoice.updateMany({
      where: { id: { in: ids }, clientId: input.clientId },
      data: { fakturItemKind: input.kind, fakturItemCode: code, fakturUnit: input.unit, ...(name === undefined ? {} : { fakturItemName: name || null }) },
    });
    const one = invoices.length === 1 ? invoices[0] : null;
    await recordEvent(tx, {
      clientId: input.clientId,
      entityId,
      kind: "FAKTUR",
      subject: one ? `invoice:${one.id}` : `faktur-item:${entityId}`,
      summary: `Barang/jasa faktur ${one ? one.number : `untuk ${count} faktur`}: ${ITEM_KIND_LABEL[input.kind as "A" | "B"]} ${code}, satuan ${unitLabel(input.unit)}${name ? `, ${name}` : ""}`,
      after: { invoices: invoices.map((i) => i.number), kind: input.kind, code, unit: input.unit, ...(name === undefined ? {} : { name }) },
      actorId: input.actorId,
    });
    return count;
  });
}
