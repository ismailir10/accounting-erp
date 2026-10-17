import { beforeEach, describe, expect, it } from "vitest";
import { extractText, getDocumentProxy } from "unpdf";
import { db, makeGroup, resetDb } from "../helpers";
import { importStatement } from "@/lib/import/pipeline";
import { createInvoice } from "@/lib/receivables/invoices";
import { tagAdvance } from "@/lib/receivables/settle";
import { receivablesView } from "@/lib/receivables/view";
import { customerReminders, paymentReminder, reminderItems } from "@/lib/receivables/reminder";
import { customerStatementPdf } from "@/lib/receivables/statement-pdf";
import { reviewTransaction } from "@/lib/review";
import { dateOnly } from "@/lib/format";

type G = Awaited<ReturnType<typeof makeGroup>>;

/** PT Uji's BCA Giro in August (invented): Toko Sejahtera pays 3 jt not matched to a note — their advance. */
const CSV = ["Tanggal;Keterangan;Debet;Kredit;Saldo", "20/08/2026;TRSF E-BANKING CR TOKO SEJAHTERA;0;3000000;103000000", ""].join("\n");

const sale = (g: G, entityId: string, contactName: string, number: string, issueDate: string, dueDate: string, dpp: string, more: Record<string, string> = {}) =>
  createInvoice(db, { clientId: g.client.id, entityId, direction: "SALES", contactName, number, issueDate, dueDate, dpp, counterCode: "4100", ...more });

const AUG = dateOnly(2026, 8, 31);
const OCT_17 = new Date("2026-10-17T03:00:00Z");

async function setup() {
  const g = await makeGroup();
  const n1 = await sale(g, g.pt.entity.id, "Toko Sejahtera", "N-1", "2026-07-01", "2026-08-01", "5000000"); // 30 days late at 31 Aug
  await sale(g, g.pt.entity.id, "Toko Sejahtera", "N-2", "2026-08-05", "2026-08-25", "1000000"); // 6 days
  await sale(g, g.pt.entity.id, "Toko Sejahtera", "N-3", "2026-08-20", "2026-09-15", "2000000"); // not due
  await sale(g, g.owner.entity.id, "Toko Sejahtera", "A-1", "2026-07-01", "2026-08-01", "700000"); // the owner's own sale
  // Withholds PPh 23 (2 % of DPP): the reminder asks for the cash, the tax comes as a bukti potong.
  await sale(g, g.pt.entity.id, "PT Mitra Jasa", "J-1", "2026-07-15", "2026-08-10", "10000000", { ppn: "1100000", whtKind: "PPH_23", whtRate: "2" });
  await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca.csv", data: Buffer.from(CSV), provider: null });
  const receipt = await db.bankTransaction.findFirstOrThrow({ where: { description: { contains: "TOKO SEJAHTERA" } } });
  await reviewTransaction(db, { bankTxId: receipt.id, accountCode: "1130", taxTag: null });
  await tagAdvance(db, { clientId: g.client.id, bankTransactionId: receipt.id, contactId: n1.contactId });
  return { g, toko: n1.contactId };
}

describe("pengingat tagihan and surat tagihan (cycle 2026-10-17-pengingat-piutang)", () => {
  beforeEach(resetDb);

  it("lists only that company's overdue invoices for the customer, summing to the aging row's overdue part, with the advance", async () => {
    const { g, toko } = await setup();
    const { asOf, customers } = await customerReminders(db, g.client.id, [g.pt.entity.id, g.owner.entity.id], AUG, OCT_17);
    expect(asOf).toEqual(AUG);
    const mine = customers.find((c) => c.entityId === g.pt.entity.id && c.contact.id === toko)!;
    expect(mine.overdue.map((l) => [l.number, l.amount, l.daysPastDue])).toEqual([["N-1", 5_000_000n, 30], ["N-2", 1_000_000n, 6]]);
    expect(mine.open.map((i) => i.number)).toEqual(["N-1", "N-2", "N-3"]);
    expect(mine.advance).toBe(3_000_000n);
    // The overdue part of the aging row (every bucket but Belum jatuh tempo) is the reminder's sum.
    const view = await receivablesView(db, g.client.id, "SALES", AUG, [g.pt.entity, g.owner.entity].map((e) => ({ id: e.id, shortName: e.shortName, functionalCurrency: e.functionalCurrency, kind: e.kind })));
    const row = view.aging.find((a) => a.entityId === g.pt.entity.id)!.rows.find((r) => r.contactId === toko)!;
    expect(BigInt(row.total) - BigInt(row.buckets.CURRENT)).toBe(mine.overdue.reduce((t, l) => t + l.amount, 0n));
    // The owner's sale to the same customer is the owner's reminder, not PT Uji's.
    expect(customers.find((c) => c.entityId === g.owner.entity.id && c.contact.id === toko)!.overdue.map((l) => l.number)).toEqual(["A-1"]);
    // Tax the customer withholds is left out: 11,1 jt − 200 rb PPh 23.
    expect(customers.find((c) => c.contact.name === "PT Mitra Jasa")!.overdue.map((l) => [l.number, l.amount])).toEqual([["J-1", 10_900_000n]]);

    const text = paymentReminder({ company: g.pt.entity.name, customer: mine.contact.name, asOf, currency: "IDR", overdue: mine.overdue, advance: mine.advance })!;
    expect(text).toContain("1. N-1 (tgl. 1 Jul 2026, jatuh tempo 1 Agu 2026): Rp 5.000.000, terlambat 30 hari");
    expect(text).toContain("Jumlah: Rp 6.000.000");
    expect(text).toContain("Kami juga mencatat pembayaran Rp 3.000.000");
    expect(text).not.toContain("N-3");
    expect(text.endsWith(`Hormat kami,\n${g.pt.entity.name}`)).toBe(true);
  });

  it("dates a running month's reminder today and leaves an invoice due later this month out", async () => {
    const g = await makeGroup();
    const later = await sale(g, g.pt.entity.id, "PT Baru", "B-1", "2026-10-01", "2026-10-25", "4000000");
    await sale(g, g.pt.entity.id, "PT Baru", "B-0", "2026-10-01", "2026-10-10", "1000000");
    const items = (await reminderItems(db, g.client.id, g.pt.entity.id, later.contactId, dateOnly(2026, 10, 31), OCT_17))!;
    expect(items.asOf).toEqual(dateOnly(2026, 10, 17));
    expect(items.overdue.map((l) => [l.number, l.daysPastDue])).toEqual([["B-0", 7]]);
    expect(items.open.map((i) => i.number)).toEqual(["B-0", "B-1"]);
    // At September's end neither is issued yet: an empty statement, and no reminder.
    const sept = (await reminderItems(db, g.client.id, g.pt.entity.id, later.contactId, dateOnly(2026, 9, 30), OCT_17))!;
    expect(sept.open).toEqual([]);
    expect(paymentReminder({ company: "PT Uji", customer: "PT Baru", asOf: sept.asOf, currency: "IDR", overdue: sept.overdue, advance: sept.advance })).toBeNull();
    // An unknown customer, or another client's, is not found.
    expect(await reminderItems(db, g.client.id, g.pt.entity.id, "nope", dateOnly(2026, 10, 31), OCT_17)).toBeNull();
    const other = await makeGroup();
    expect(await reminderItems(db, other.client.id, other.pt.entity.id, later.contactId, dateOnly(2026, 10, 31), OCT_17)).toBeNull();
  });

  it("prints the statement: company and NPWP, every open invoice with days late, total, advance and the aging summary, no firm", async () => {
    const { g, toko } = await setup();
    const items = (await reminderItems(db, g.client.id, g.pt.entity.id, toko, AUG, OCT_17))!;
    const buf = await customerStatementPdf({ company: { name: g.pt.entity.name, npwp: "01.234.567.8-901.000" }, customer: items.contact.name, asOf: items.asOf, currency: "IDR", open: items.open, advance: items.advance });
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true });
    for (const s of ["PT Uji Sejahtera", "NPWP 01.234.567.8-901.000", "Surat Tagihan", "Kepada Yth. Toko Sejahtera", "Per 31 Agustus 2026", "N-1", "N-2", "N-3", "30 hari", "6 hari", "Uang muka belum dialokasikan", "Sisa setelah uang muka", "Belum jatuh tempo", "1–30 hari", "> 90 hari", "Halaman 1 dari 1"]) expect(text, s).toContain(s);
    // Its total is the row's open amount: 5 + 1 + 2 jt; less the 3 jt advance = 5 jt.
    expect(text).toContain("8.000.000");
    expect(text).toContain("(3.000.000)");
    expect(text).toContain("5.000.000");
    expect(text).not.toContain("A-1");
    expect(text).not.toContain("J-1");
    expect(text).not.toContain("KJA Uji");
    expect(text).not.toContain("DRAF");
  });
});
