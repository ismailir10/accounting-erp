import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { importStatement } from "@/lib/import/pipeline";
import { createInvoice } from "@/lib/receivables/invoices";
import { setCreditLimit } from "@/lib/receivables/credit-limit";
import { tagAdvance } from "@/lib/receivables/settle";
import { receivablesView } from "@/lib/receivables/view";
import { reviewTransaction } from "@/lib/review";
import { listEvents } from "@/lib/audit";
import { dateOnly } from "@/lib/format";

type G = Awaited<ReturnType<typeof makeGroup>>;

/** PT Uji's BCA Giro in August (invented): a customer pays 3 jt before any note is matched — their advance. */
const CSV = ["Tanggal;Keterangan;Debet;Kredit;Saldo", "20/08/2026;TRSF E-BANKING CR TOKO SEJAHTERA;0;3000000;103000000", ""].join("\n");

const sale = (g: G, entityId: string, number: string, dpp: string, direction: "SALES" | "PURCHASE" = "SALES") =>
  createInvoice(db, { clientId: g.client.id, entityId, direction, contactName: "Toko Sejahtera", number, issueDate: "2026-08-01", dueDate: "2026-08-15", dpp, counterCode: direction === "SALES" ? "4100" : "6190" });

const entities = async (g: G) => (await db.entity.findMany({ where: { clientId: g.client.id } })).map((e) => ({ id: e.id, shortName: e.shortName, functionalCurrency: e.functionalCurrency, kind: e.kind }));
const rowsOf = async (g: G, direction: "SALES" | "PURCHASE" = "SALES") =>
  (await receivablesView(db, g.client.id, direction, dateOnly(2026, 8, 31), await entities(g))).aging.map((a) => [a.entity, ...a.rows.map((r) => [r.contact, r.net, r.limit, r.over])]);

describe("batas kredit (cycle 2026-10-17-pengingat-piutang)", () => {
  beforeEach(resetDb);

  it("sets, changes and clears a limit, refusing zero, negatives, text and another client's contact, with a Riwayat event per change", async () => {
    const g = await makeGroup();
    const inv = await sale(g, g.pt.entity.id, "N-1", "1000000");
    const set = (limit: string, clientId = g.client.id) => setCreditLimit(db, { clientId, contactId: inv.contactId, limit });
    expect((await set(" 5.000.000 ")).creditLimit).toBe(5_000_000n);
    expect((await set("Rp 7.500.000")).creditLimit).toBe(7_500_000n);
    await expect(set("0")).rejects.toThrow("Batas kredit harus lebih dari nol. Kosongkan bila tidak ada batas.");
    await expect(set("-1.000")).rejects.toThrow("Batas kredit harus lebih dari nol.");
    await expect(set("abc")).rejects.toThrow('Nominal "abc" tidak bisa dibaca.');
    const other = await makeGroup();
    await expect(set("1.000", other.client.id)).rejects.toThrow("Pelanggan tidak ditemukan.");
    expect((await db.contact.findUniqueOrThrow({ where: { id: inv.contactId } })).creditLimit).toBe(7_500_000n); // refusals saved nothing
    // The same value again is no change.
    await set("7.500.000");
    expect((await set("")).creditLimit).toBeNull();

    const events = await listEvents(db, g.client.id, { kind: "CREDIT_LIMIT" });
    expect(events.map((e) => [e.label, e.subject, e.summary, e.before, e.after])).toEqual([
      ["Batas kredit", `contact:${inv.contactId}`, "Toko Sejahtera: Rp 7.500.000 → tanpa batas", { limit: "7500000" }, { limit: null }],
      ["Batas kredit", `contact:${inv.contactId}`, "Toko Sejahtera: Rp 5.000.000 → Rp 7.500.000", { limit: "5000000" }, { limit: "7500000" }],
      ["Batas kredit", `contact:${inv.contactId}`, "Toko Sejahtera: tanpa batas → Rp 5.000.000", { limit: null }, { limit: "5000000" }],
    ]);
    // The database refuses a limit of zero on its own too.
    await expect(db.contact.update({ where: { id: inv.contactId }, data: { creditLimit: 0n } })).rejects.toThrow(/Contact_creditLimit_check/);
  });

  it("marks a customer over the limit on net receivable (open − advance) per Rupiah company only, not at the limit, not on Utang", async () => {
    const g = await makeGroup();
    const inv = await sale(g, g.pt.entity.id, "N-1", "10000000");
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca.csv", data: Buffer.from(CSV), provider: null });
    const receipt = await db.bankTransaction.findFirstOrThrow({ where: { description: { contains: "TOKO SEJAHTERA" } } });
    await reviewTransaction(db, { bankTxId: receipt.id, accountCode: "1130", taxTag: null });
    await tagAdvance(db, { clientId: g.client.id, bankTransactionId: receipt.id, contactId: inv.contactId });
    // The owner keeps USD books and sells to the same customer.
    await db.entity.update({ where: { id: g.owner.entity.id }, data: { functionalCurrency: "USD" } });
    await sale(g, g.owner.entity.id, "U-1", "90000,00");
    await sale(g, g.pt.entity.id, "B-1", "20000000", "PURCHASE");

    expect(await rowsOf(g)).toEqual([["PT Uji", ["Toko Sejahtera", "7000000", null, false]], ["Andi", ["Toko Sejahtera", "9000000", null, false]]]);
    const limit = (v: string) => setCreditLimit(db, { clientId: g.client.id, contactId: inv.contactId, limit: v });
    await limit("6.999.999");
    expect(await rowsOf(g)).toEqual([["PT Uji", ["Toko Sejahtera", "7000000", "6999999", true]], ["Andi", ["Toko Sejahtera", "9000000", null, false]]]);
    await limit("7.000.000"); // exactly at the limit
    expect((await rowsOf(g))[0]).toEqual(["PT Uji", ["Toko Sejahtera", "7000000", "7000000", false]]);
    // A supplier with the same name is not a customer: no limit on Utang.
    expect(await rowsOf(g, "PURCHASE")).toEqual([["PT Uji", ["Toko Sejahtera", "20000000", null, false]]]);
    expect((await receivablesView(db, g.client.id, "SALES", dateOnly(2026, 8, 31), await entities(g))).aging[0].rows[0].contactId).toBe(inv.contactId);
  });
});

