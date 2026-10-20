import type { Db, Tx } from "@/lib/db";
import { LedgerError } from "@/lib/ledger/post";
import { reviewTransactionTx, setWithholdingTx } from "@/lib/review";
import type { WithholdingKind } from "@/lib/generated/prisma/enums";
import { checkWithholding, WITHHOLDING_LABEL } from "@/lib/tax/withholding";
import { formatPeriod } from "@/lib/format";
import { formatMoney, parseMoney } from "@/lib/money";
import { recordEvent } from "@/lib/audit";
import { openingDates, subledgerFrom } from "@/lib/receivables/aging";

/**
 * Settlements (accounting-rules 5c): a bank line settles (part of) an invoice. The bank line already moved the GL when it was
 * classified to the invoice's receivable/payable account, so a settlement is a subledger link only — no journal. Σ per invoice ≤
 * its total and Σ per bank line ≤ its amount, checked under row locks. A line not on that account yet is first reclassified through
 * the reviewer's writer (rule 3: RECLASS of the difference + Memory) in the same transaction.
 */

type SettleInput = {
  clientId: string;
  invoiceId: string;
  bankTransactionId: string;
  /** Major units of cash from the bank line; default the most both can take. */
  amount?: string | null;
  /**
   * Major units of the invoice paid as withheld tax (not cash). Default: the shortfall when this settlement closes the invoice and the
   * shortfall is within the invoice's expected withholding; else none. "0" = paid in full, nothing withheld.
   */
  withheld?: string | null;
  /** The tax, when the invoice doesn't name one. */
  whtKind?: WithholdingKind | null;
  /** Internal callers (FIFO) pass minor units directly: no round trip through a typed amount. */
  cashMinor?: bigint;
  withheldMinor?: bigint;
  actorId?: string | null;
};

const abs = (v: bigint) => (v < 0n ? -v : v);
/** Cash a bank line has already given to invoices: what they cleared less what was tax. */
const cashUsed = (xs: { amount: bigint; withheld: bigint }[]) => xs.reduce((s, x) => s + x.amount - x.withheld, 0n);
const monthKey = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth() + 1;

async function lockedMonths(db: Db | Tx, clientId: string) {
  return new Set((await db.period.findMany({ where: { clientId, status: "LOCKED" }, select: { year: true, month: true } })).map((p) => p.year * 12 + p.month));
}

/**
 * A closed month's line may still settle a document entering the subledger after every closed month when it is already that contact's
 * money (their advance, UC-B5): a December advance applied to a January invoice. Every closed month's aging and proof read the same
 * either way, since the document is in none of them. Withholding is the exception (its tax leg posts in the line's month), checked by
 * the caller.
 */
async function appliesAfterClose(db: Db | Tx, line: { contactId: string | null }, invoice: { contactId: string; entityId: string; issueDate: Date; opening: boolean }, locked: Set<number>) {
  if (!line.contactId || line.contactId !== invoice.contactId || !locked.size) return false;
  const from = subledgerFrom(invoice, await openingDates(db, [invoice.entityId]));
  return monthKey(from) > Math.max(...locked);
}
const closedMessage = (d: Date) => `${formatPeriod(d.getUTCFullYear(), d.getUTCMonth() + 1)} sudah ditutup. Buka periode dulu untuk mencocokkan mutasi ini.`;

async function load(tx: Tx, input: SettleInput) {
  // Lock both rows: two clicks settling the same invoice or the same receipt serialise here. The bank line first, everywhere
  // (settleFifo and unsettle lock it before any invoice), so two paths over the same line never wait on each other in reverse.
  await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE id = ${input.bankTransactionId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${input.invoiceId} FOR UPDATE`;
  const invoice = await tx.invoice.findFirst({ where: { id: input.invoiceId, clientId: input.clientId }, include: { arApAccount: true, entity: true, settlements: { select: { amount: true, withheld: true } } } });
  if (!invoice) throw new LedgerError("Faktur tidak ditemukan.");
  if (invoice.voidedAt) throw new LedgerError(`${invoice.direction === "SALES" ? "Faktur" : "Tagihan"} ${invoice.number} sudah dikeluarkan.`);
  const t = await tx.bankTransaction.findFirst({ where: { id: input.bankTransactionId, entityId: invoice.entityId }, include: { settlements: { select: { amount: true, withheld: true } }, contact: { select: { name: true } } } });
  if (!t) throw new LedgerError("Mutasi bank tidak ditemukan untuk entitas faktur ini.");
  // A split line moved the receivable/payable by one part only: settling its full amount would leave the subledger above the ledger.
  if (await tx.bankTxSplit.count({ where: { bankTransactionId: t.id } })) throw new LedgerError("Mutasi ini dipecah ke beberapa akun, jadi tidak bisa dicocokkan ke faktur. Gabungkan dulu ke satu akun di Buku Besar.");
  const sales = invoice.direction === "SALES";
  if (t.direction !== (sales ? "IN" : "OUT")) throw new LedgerError(sales ? "Pelunasan piutang harus uang masuk." : "Pembayaran utang harus uang keluar.");
  // A line tagged with another contact is their money (their advance, UC-B5): it can't pay this contact's document.
  if (t.contactId && t.contactId !== invoice.contactId) throw new LedgerError(`Mutasi ini milik ${t.contact?.name ?? "kontak lain"} (uang muka atau pelunasannya). Hapus tandanya dulu bila memang salah.`);
  const locked = await lockedMonths(tx, input.clientId);
  const closed = locked.has(monthKey(t.date));
  if (closed && !(await appliesAfterClose(tx, t, invoice, locked))) throw new LedgerError(closedMessage(t.date));
  return { invoice, t, closed };
}

async function settleTx(tx: Tx, input: SettleInput) {
  const { invoice, t, closed } = await load(tx, input);
  if (t.status === "NEEDS_REVIEW" || t.accountCode !== invoice.arApAccount.code) {
    throw new LedgerError(`Mutasi ini belum dicatat ke ${invoice.arApAccount.code} ${invoice.arApAccount.name}. Klasifikasikan dulu, atau pakai "Klasifikasikan lalu cocokkan".`);
  }
  const cur = invoice.entity.functionalCurrency;
  const open = invoice.total - invoice.settlements.reduce((s, x) => s + x.amount, 0n);
  const free = abs(t.amount) - cashUsed(t.settlements);
  if (open <= 0n) throw new LedgerError(`${invoice.number} sudah lunas.`);
  if (free <= 0n) throw new LedgerError("Mutasi ini sudah habis dicocokkan ke faktur lain.");
  const explicitWht = input.withheldMinor ?? (input.withheld?.trim() ? parseMoney(input.withheld, cur) : null);
  if (explicitWht !== null && explicitWht < 0n) throw new LedgerError("Pemotongan pajak tidak boleh negatif.");
  // Cash: what was asked, else the most both can take (less the expected withholding when that is what closes the invoice).
  const expected = invoice.whtAmount - invoice.settlements.reduce((s, x) => s + x.withheld, 0n);
  // Tax the accountant already recorded on the bank line by hand (Ubah akun) and no settlement has claimed yet: this settlement adopts it.
  const pool = t.whtAmount - t.settlements.reduce((s, x) => s + x.withheld, 0n);
  const expectedTax = pool > expected ? pool : expected;
  let cash: bigint;
  if (input.cashMinor !== undefined) cash = input.cashMinor;
  else if (input.amount?.trim()) cash = parseMoney(input.amount, cur);
  else if (explicitWht !== null) cash = open - explicitWht < free ? open - explicitWht : free;
  else cash = open < free ? open : free;
  if (cash <= 0n) throw new LedgerError("Nominal pencocokan harus lebih dari nol.");
  if (cash > free) throw new LedgerError(`Melebihi sisa mutasi yang belum dicocokkan (${formatMoney(free, cur)}).`);
  const shortfall = open - cash;
  const withheld = explicitWht ?? (shortfall > 0n && expectedTax > 0n && shortfall <= expectedTax ? shortfall : 0n);
  const amount = cash + withheld;
  if (closed && withheld > 0n) throw new LedgerError(`Pajak yang dipotong dicatat di bulan mutasinya, dan ${closedMessage(t.date)}`);
  if (amount > open) throw new LedgerError(`Melebihi sisa ${invoice.number} (${formatMoney(open, cur)}).`);
  const exists = await tx.invoiceSettlement.findUnique({ where: { invoiceId_bankTransactionId: { invoiceId: invoice.id, bankTransactionId: t.id } } });
  if (exists) throw new LedgerError("Mutasi ini sudah dicocokkan ke faktur ini. Hapus pencocokannya dulu untuk mengubah nominal.");
  const created = await tx.invoiceSettlement.create({ data: { firmId: invoice.firmId, invoiceId: invoice.id, bankTransactionId: t.id, amount, withheld, createdById: input.actorId ?? null } });
  // The line is now this contact's: what stays unmatched on it is their advance (UC-B5). A line already tagged keeps its contact.
  if (!t.contactId) await tx.bankTransaction.update({ where: { id: t.id }, data: { contactId: invoice.contactId } });
  if (withheld > 0n) {
    // The tax leg goes on the bank line's classification side (rule 3: a RECLASS of the difference), so the payable/receivable account
    // moves by the gross the invoice was cleared by.
    const kind = invoice.whtKind ?? input.whtKind ?? t.whtKind;
    if (!kind) throw new LedgerError("Pilih jenis pajak yang dipotong.");
    if (t.whtKind && t.whtKind !== kind) {
      throw new LedgerError(`Mutasi ini sudah mencatat pemotongan ${WITHHOLDING_LABEL[t.whtKind]}, sedangkan pencocokan ini ${WITHHOLDING_LABEL[kind]}. Samakan jenisnya (ubah pemotongan di mutasi) sebelum mencocokkan.`);
    }
    // Only what the line does not carry yet is added: a recorded tax is adopted, never booked twice.
    const missing = withheld - pool;
    if (missing > 0n) await setWithholdingTx(tx, t.id, checkWithholding({ kind, amount: t.whtAmount + missing }, t.direction), input.actorId);
  }
  return created;
}

export async function settle(db: Db, input: SettleInput) {
  return db.$transaction((tx) => settleTx(tx, input));
}

/** One click for a line still in review or on another account: classify it to the invoice's account (reviewer's writer), then settle. */
export async function settleWithReclass(db: Db, input: SettleInput) {
  return db.$transaction(async (tx) => {
    const { invoice, t, closed } = await load(tx, input);
    if (t.status === "NEEDS_REVIEW" || t.accountCode !== invoice.arApAccount.code) {
      if (closed) throw new LedgerError(closedMessage(t.date)); // reclassifying posts in the line's month
      // The reviewer's writer refuses to move a line away from invoices it already settles on another account (one line, one account).
      await reviewTransactionTx(tx, { bankTxId: t.id, accountCode: invoice.arApAccount.code, taxTag: null, actorId: input.actorId });
    }
    return settleTx(tx, input);
  });
}

/**
 * Cocokkan FIFO (UC-B5): one receipt (or payment) across the contact's open invoices of the entity, oldest due first (then issue date and
 * number), until the line's free amount or the invoices run out. Each allocation is an ordinary settlement (same locks and refusals).
 * An invoice expecting withholding closes at its net with its tax booked, as by hand; a part payment of it is cash only. What is left on
 * the line is the contact's advance. A line tagged with another contact is refused.
 */
export async function settleFifo(db: Db, input: { clientId: string; bankTransactionId: string; contactId: string; actorId?: string | null }) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE id = ${input.bankTransactionId} FOR UPDATE`;
    const t = await tx.bankTransaction.findFirst({ where: { id: input.bankTransactionId, bankAccount: { entity: { clientId: input.clientId } } }, include: { settlements: { select: { invoiceId: true, amount: true, withheld: true } }, contact: { select: { name: true } } } });
    if (!t) throw new LedgerError("Mutasi bank tidak ditemukan.");
    const contact = await tx.contact.findFirst({ where: { id: input.contactId, clientId: input.clientId } });
    if (!contact) throw new LedgerError("Pilih pelanggan atau pemasok.");
    if (t.contactId && t.contactId !== contact.id) throw new LedgerError(`Mutasi ini milik ${t.contact?.name ?? "kontak lain"} (uang muka atau pelunasannya). Hapus tandanya dulu bila memang salah.`);
    let free = abs(t.amount) - cashUsed(t.settlements);
    if (free <= 0n) throw new LedgerError("Mutasi ini sudah habis dicocokkan.");
    const direction = t.direction === "IN" ? "SALES" : "PURCHASE";
    const invoices = await tx.invoice.findMany({
      where: { clientId: input.clientId, entityId: t.entityId, contactId: contact.id, direction, voidedAt: null },
      include: { arApAccount: { select: { code: true } }, settlements: { select: { amount: true, withheld: true } } },
      orderBy: [{ dueDate: "asc" }, { issueDate: "asc" }, { number: "asc" }],
    });
    const open = invoices
      .map((i) => ({ i, open: i.total - i.settlements.reduce((u, x) => u + x.amount, 0n), tax: i.whtAmount - i.settlements.reduce((u, x) => u + x.withheld, 0n) }))
      .filter((x) => x.open > 0n && !t.settlements.some((s) => s.invoiceId === x.i.id));
    if (!open.length) throw new LedgerError(`Tidak ada ${direction === "SALES" ? "faktur" : "tagihan"} terbuka untuk ${contact.name} di entitas ini. Tandai mutasi ini sebagai uang muka ${contact.name} bila memang dibayar di muka.`);
    const codes = [...new Set(open.map((x) => x.i.arApAccount.code))];
    if (codes.length > 1) throw new LedgerError(`${direction === "SALES" ? "Faktur" : "Tagihan"} ${contact.name} memakai akun berbeda (${codes.join(", ")}). Cocokkan satu per satu.`);
    // A line still in Review or elsewhere goes to the invoices' account first, through the reviewer's writer (as "Klasifikasikan lalu cocokkan").
    if (t.status === "NEEDS_REVIEW" || t.accountCode !== codes[0]) await reviewTransactionTx(tx, { bankTxId: t.id, accountCode: codes[0], taxTag: null, actorId: input.actorId });
    const settled: { number: string; amount: bigint }[] = [];
    for (const x of open) {
      if (free <= 0n) break;
      // An invoice the counterparty withholds on is paid at its net: when the cash reaches it, the expected tax closes it as a manual
      // settlement would (the tax leg booked); a part payment is cash only and the tax stays expected.
      const tax = x.tax > 0n ? x.tax : 0n;
      const due = x.open - tax;
      if (due <= 0n) continue;
      const cash = free < due ? free : due;
      const withheld = cash === due ? tax : 0n;
      await settleTx(tx, { clientId: input.clientId, invoiceId: x.i.id, bankTransactionId: t.id, cashMinor: cash, withheldMinor: withheld, actorId: input.actorId });
      settled.push({ number: x.i.number, amount: cash + withheld });
      free -= cash;
    }
    await tx.bankTransaction.update({ where: { id: t.id }, data: { contactId: contact.id } });
    return { settled, rest: free, contact: contact.name };
  });
}

/**
 * Tags a bank line as a contact's (its unmatched rest is their advance, or a refund to them), or clears the tag (null). Nothing is
 * posted, but the tag moves the month's subledger proof: refused in a locked month, under the line's lock, and kept in the history.
 */
export async function tagAdvance(db: Db, input: { clientId: string; bankTransactionId: string; contactId: string | null; actorId?: string | null }) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE id = ${input.bankTransactionId} FOR UPDATE`;
    const t = await tx.bankTransaction.findFirst({
      where: { id: input.bankTransactionId, bankAccount: { entity: { clientId: input.clientId } } },
      include: { contact: { select: { name: true } }, settlements: { select: { invoice: { select: { contactId: true, number: true } } } } },
    });
    if (!t) throw new LedgerError("Mutasi bank tidak ditemukan.");
    const contact = input.contactId ? await tx.contact.findFirst({ where: { id: input.contactId, clientId: input.clientId } }) : null;
    if (input.contactId && !contact) throw new LedgerError("Pilih pelanggan atau pemasok.");
    if (t.settlements.length && t.settlements.some((s) => s.invoice.contactId !== input.contactId)) {
      throw new LedgerError(`Mutasi ini sudah dicocokkan ke ${t.settlements.map((s) => s.invoice.number).join(", ")}; tandanya mengikuti pencocokan itu. Hapus pencocokannya dulu bila salah.`);
    }
    if ((await lockedMonths(tx, input.clientId)).has(monthKey(t.date))) throw new LedgerError(`${formatPeriod(t.date.getUTCFullYear(), t.date.getUTCMonth() + 1)} sudah ditutup. Buka periode dulu untuk mengubah tanda mutasi ini.`);
    const updated = await tx.bankTransaction.update({ where: { id: t.id }, data: { contactId: contact?.id ?? null } });
    await recordEvent(tx, {
      clientId: input.clientId,
      entityId: t.entityId,
      kind: "ADVANCE",
      subject: `bank-tx:${t.id}`,
      summary: `${t.description.slice(0, 70)}: ${contact ? `ditandai milik ${contact.name}` : `tanda ${t.contact?.name ?? ""} dihapus`}`.trim(),
      before: { contact: t.contact?.name ?? null },
      after: { contact: contact?.name ?? null },
      actorId: input.actorId,
    });
    return updated;
  });
}

export async function unsettle(db: Db, input: { clientId: string; settlementId: string }) {
  const s = await db.invoiceSettlement.findFirst({ where: { id: input.settlementId, invoice: { clientId: input.clientId } }, include: { invoice: true, bankTransaction: { select: { date: true, whtKind: true, whtAmount: true, contactId: true } } } });
  if (!s) throw new LedgerError("Pencocokan tidak ditemukan.");
  const locked = await lockedMonths(db, input.clientId);
  // An advance applied after the close (above) may be taken back the same way; one that booked tax may not.
  if (locked.has(monthKey(s.bankTransaction.date)) && (s.withheld > 0n || !(await appliesAfterClose(db, s.bankTransaction, s.invoice, locked)))) {
    throw new LedgerError("Periode mutasi ini sudah ditutup. Buka periode dulu untuk menghapus pencocokan.");
  }
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE id = ${s.bankTransactionId} FOR UPDATE`;
    await tx.invoiceSettlement.delete({ where: { id: s.id } });
    if (s.withheld > 0n) {
      const rest = (await tx.bankTransaction.findUniqueOrThrow({ where: { id: s.bankTransactionId }, select: { whtKind: true, whtAmount: true } }));
      const left = rest.whtAmount - s.withheld;
      await setWithholdingTx(tx, s.bankTransactionId, left > 0n && rest.whtKind ? { kind: rest.whtKind, amount: left } : null);
    }
  });
}

export type SettleCandidate = {
  bankTransactionId: string;
  date: Date;
  description: string;
  amount: bigint;
  /** Not settled yet (absolute). */
  free: bigint;
  /** Its unsettled amount equals the invoice's open amount. */
  exact: boolean;
  /** Its description names the contact or the invoice number. */
  named: boolean;
  /** Already on the invoice's receivable/payable account (else settling reclassifies it). */
  onAccount: boolean;
  /** This contact's unmatched money from earlier (an advance, UC-B5), offered first whatever its date. */
  advance: boolean;
};

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
/** Company-form words don't identify anyone ("PT", "CV" …); a name matches on its distinctive words. */
const FORMS = new Set(["PT", "CV", "TBK", "UD", "PD", "KOPERASI", "YAYASAN", "BAPAK", "IBU", "BPK"]);

/**
 * Bank lines that could settle an invoice: same entity, the invoice's direction, not fully settled, in an open month. Suggestions are
 * the ones whose unsettled amount equals the invoice's open amount, those naming the contact or the number first. Never applied.
 */
export async function settleCandidates(db: Db, clientId: string, invoiceId: string): Promise<SettleCandidate[]> {
  const invoice = await db.invoice.findFirst({ where: { id: invoiceId, clientId }, include: { contact: true, arApAccount: true, settlements: { select: { amount: true, withheld: true } } } });
  if (!invoice || invoice.voidedAt) return [];
  const open = invoice.total - invoice.settlements.reduce((s, x) => s + x.amount, 0n);
  // A customer that withholds pays the invoice less the tax: that amount is as exact as the open amount.
  const expectedTax = invoice.whtAmount - invoice.settlements.reduce((s, x) => s + x.withheld, 0n);
  const net = expectedTax > 0n ? open - expectedTax : open;
  if (open <= 0n) return [];
  const locked = await lockedMonths(db, clientId);
  const afterClose = await appliesAfterClose(db, { contactId: invoice.contactId }, invoice, locked);
  const lines = await db.bankTransaction.findMany({
    where: { entityId: invoice.entityId, direction: invoice.direction === "SALES" ? "IN" : "OUT", OR: [{ date: { gte: invoice.opening ? new Date(0) : invoice.issueDate } }, { contactId: invoice.contactId }] },
    include: { settlements: { select: { amount: true, withheld: true } } },
    orderBy: [{ date: "asc" }, { rowNumber: "asc" }],
  });
  const words = norm(invoice.contact.name).split(" ").filter((w) => w.length >= 3 && !FORMS.has(w));
  const number = norm(invoice.number);
  return lines
    .filter((t) => !locked.has(monthKey(t.date)) || (t.contactId === invoice.contactId && afterClose))
    .map((t) => {
      const free = abs(t.amount) - cashUsed(t.settlements);
      const text = ` ${norm(t.description)} `;
      const named = (words.length > 0 && words.every((w) => text.includes(` ${w} `))) || (number.length >= 3 && text.includes(` ${number} `));
      return { bankTransactionId: t.id, date: t.date, description: t.description, amount: t.amount, free, exact: free === open || free === net, named, onAccount: t.status !== "NEEDS_REVIEW" && t.accountCode === invoice.arApAccount.code, advance: t.contactId === invoice.contactId };
    })
    .filter((c) => c.free > 0n)
    .sort((a, b) => Number(b.advance) - Number(a.advance) || Number(b.exact && b.named) - Number(a.exact && a.named) || Number(b.exact) - Number(a.exact) || Number(b.named) - Number(a.named) || Number(b.onAccount) - Number(a.onAccount) || +a.date - +b.date);
}
