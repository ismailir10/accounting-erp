import type { Db } from "@/lib/db";
import { invoicesAt, unmatchedLines, type OpenItem } from "@/lib/receivables/aging";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";

/**
 * Pengingat tagihan (cycle 2026-10-17-pengingat-piutang): per company and customer, the overdue sales invoices on the reminder date as a
 * message in the company's voice, and every open invoice for the statement (*Surat tagihan*). Derived only: Buku sends nothing and posts
 * nothing; the accountant copies the message or opens it in WhatsApp, and the client sends it.
 */
export const REMINDER_MAX_LINES = 15;

/**
 * The reminder's date: the month end, or today (WIB) while the month is still running, so an invoice due later this month never reads
 * as late.
 */
export function reminderDate(monthEnd: Date, now = new Date()): Date {
  const wib = new Date(now.getTime() + 7 * 3600_000);
  const today = new Date(Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), wib.getUTCDate()));
  return +today < +monthEnd ? today : monthEnd;
}

/** One overdue invoice as the reminder asks for it: what is left to pay in cash (tax the customer withholds is not asked for). */
export type ReminderLine = { number: string; issueDate: Date; dueDate: Date; amount: bigint; daysPastDue: number };

export type CustomerItems = {
  entityId: string;
  contact: { id: string; name: string };
  asOf: Date;
  /** Every open invoice at `asOf`, oldest due first (the statement). */
  open: OpenItem[];
  /** The overdue ones (the reminder). */
  overdue: ReminderLine[];
  /** Their unmatched cash on the receivable accounts (uang muka / kelebihan bayar), as on the aging. */
  advance: bigint;
};

const overdueLines = (open: OpenItem[]): ReminderLine[] =>
  open.flatMap((i) => {
    // The tax the customer still withholds is cleared by their bukti potong (Minta data), not by a payment.
    const amount = i.open - (i.whtExpected > 0n ? i.whtExpected : 0n);
    return i.daysPastDue > 0 && amount > 0n ? [{ number: i.number, issueDate: i.issueDate, dueDate: i.dueDate, amount, daysPastDue: i.daysPastDue }] : [];
  });

/** Per company and customer with an open sales invoice or an advance at the reminder date (min of the month end and today). */
export async function customerReminders(db: Db, clientId: string, entityIds: string[], monthEnd: Date, now = new Date()): Promise<{ asOf: Date; customers: CustomerItems[] }> {
  const asOf = reminderDate(monthEnd, now);
  const items = await invoicesAt(db, clientId, "SALES", asOf, entityIds);
  const byKey = new Map<string, CustomerItems>();
  const at = (entityId: string, contact: { id: string; name: string }) => {
    const key = `${entityId}:${contact.id}`;
    return byKey.get(key) ?? byKey.set(key, { entityId, contact, asOf, open: [], overdue: [], advance: 0n }).get(key)!;
  };
  for (const i of items) if (i.open > 0n) at(i.entityId, i.contact).open.push(i);
  // An advance as the aging reads it: tagged unmatched cash on the receivable accounts the company's invoices use.
  for (const entityId of [...new Set(items.map((i) => i.entityId))]) {
    const codes = [...new Set(items.filter((i) => i.entityId === entityId).map((i) => i.arApCode))].sort();
    for (const l of await unmatchedLines(db, entityId, "SALES", asOf, codes)) if (l.contact) at(entityId, l.contact).advance += l.amount;
  }
  const customers = [...byKey.values()];
  for (const c of customers) c.overdue = overdueLines(c.open);
  return { asOf, customers };
}

/** One customer of one company; null when the contact is not the client's. A customer with nothing open still gets an (empty) statement. */
export async function reminderItems(db: Db, clientId: string, entityId: string, contactId: string, monthEnd: Date, now = new Date()): Promise<CustomerItems | null> {
  const contact = await db.contact.findFirst({ where: { id: contactId, clientId }, select: { id: true, name: true } });
  if (!contact) return null;
  const { asOf, customers } = await customerReminders(db, clientId, [entityId], monthEnd, now);
  return customers.find((c) => c.contact.id === contact.id) ?? { entityId, contact, asOf, open: [], overdue: [], advance: 0n };
}

/**
 * The reminder text in the company's voice: "Yth. <pelanggan>", each overdue invoice (number, invoice date, due date, remaining amount,
 * days late; the oldest 15, the rest pointed to the statement), their sum, an advance line when they have unallocated cash, the
 * "ignore if paid after" sentence, and the company's name. Null when nothing is overdue.
 */
export function paymentReminder(input: { company: string; customer: string; asOf: Date; currency: string; overdue: ReminderLine[]; advance: bigint }): string | null {
  if (!input.overdue.length) return null;
  const money = (v: bigint) => formatMoney(v, input.currency);
  const date = formatDate(input.asOf);
  const shown = input.overdue.slice(0, REMINDER_MAX_LINES);
  const rest = input.overdue.slice(REMINDER_MAX_LINES);
  const sum = (xs: ReminderLine[]) => xs.reduce((t, l) => t + l.amount, 0n);
  return [
    `Yth. ${input.customer},`,
    "",
    `Menurut catatan kami per ${date}, ${input.overdue.length === 1 ? "faktur berikut sudah" : `${input.overdue.length} faktur berikut sudah`} lewat jatuh tempo:`,
    ...shown.map((l, i) => `${i + 1}. ${l.number} (tgl. ${formatDate(l.issueDate)}, jatuh tempo ${formatDate(l.dueDate)}): ${money(l.amount)}, terlambat ${l.daysPastDue} hari`),
    ...(rest.length ? [`… dan ${rest.length} faktur lain sebesar ${money(sum(rest))}; rinciannya ada di surat tagihan terlampir.`] : []),
    `Jumlah: ${money(sum(input.overdue))}`,
    ...(input.advance > 0n ? ["", `Kami juga mencatat pembayaran ${money(input.advance)} dari Bapak/Ibu yang belum dialokasikan ke faktur. Mohon informasikan faktur mana yang dibayar dengan dana tersebut.`] : []),
    "",
    `Mohon pembayarannya dapat segera dilakukan. Bila pembayaran sudah dilakukan setelah ${date}, mohon abaikan pesan ini.`,
    "",
    "Terima kasih.",
    "",
    "Hormat kami,",
    input.company,
  ].join("\n");
}
