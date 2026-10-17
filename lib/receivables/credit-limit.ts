import type { Db } from "@/lib/db";
import { LedgerError } from "@/lib/ledger/post";
import { formatRupiah, parseMoney } from "@/lib/money";
import { recordEvent } from "@/lib/audit";

/**
 * Batas kredit (cycle 2026-10-17-pengingat-piutang): a customer's credit limit in whole Rupiah, optional, on the contact. The Piutang aging
 * compares it per IDR company with the customer's net receivable (open − advance) and marks *Lewat batas kredit* above it. Metadata only:
 * nothing is posted, no close control, no block on invoice entry. Every change is a Riwayat event with the amounts before and after.
 */
export async function setCreditLimit(db: Db, input: { clientId: string; contactId: string; limit: string | null; actorId?: string | null }) {
  const text = (input.limit ?? "").trim();
  const limit = text ? parseMoney(text, "IDR") : null;
  if (limit !== null && limit <= 0n) throw new LedgerError("Batas kredit harus lebih dari nol. Kosongkan bila tidak ada batas.");
  return db.$transaction(async (tx) => {
    const contact = await tx.contact.findFirst({ where: { id: input.contactId, clientId: input.clientId } });
    if (!contact) throw new LedgerError("Pelanggan tidak ditemukan.");
    if (contact.creditLimit === limit) return contact;
    const updated = await tx.contact.update({ where: { id: contact.id }, data: { creditLimit: limit } });
    const shown = (v: bigint | null) => (v === null ? "tanpa batas" : formatRupiah(v));
    await recordEvent(tx, {
      clientId: input.clientId,
      kind: "CREDIT_LIMIT",
      subject: `contact:${contact.id}`,
      summary: `${contact.name}: ${shown(contact.creditLimit)} → ${shown(limit)}`,
      before: { limit: contact.creditLimit?.toString() ?? null },
      after: { limit: limit?.toString() ?? null },
      actorId: input.actorId,
    });
    return updated;
  });
}
