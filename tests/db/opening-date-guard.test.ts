import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { postOpening } from "@/lib/opening";
import { createInvoice } from "@/lib/receivables/invoices";
import { dateOnly } from "@/lib/format";

/**
 * Saldo Awal already holds every balance up to its date, Saldo Laba included: an entry typed by hand on or before that date would count
 * those months twice (found by the end-to-end accounting cycle walk, 2026-10-20).
 */
describe("nothing typed by hand lands inside Saldo Awal", () => {
  beforeEach(resetDb);

  const opening = (g: Awaited<ReturnType<typeof makeGroup>>, date = dateOnly(2025, 10, 31)) =>
    postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date, lines: [{ accountCode: "1110", debit: "5.000.000", credit: "" }, { accountCode: "3100", debit: "", credit: "5.000.000" }] });
  const atk = (g: Awaited<ReturnType<typeof makeGroup>>, date: Date) =>
    postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date, memo: "ATK", lines: [{ accountCode: "6160", debit: "500.000", credit: "" }, { accountCode: "1110", debit: "", credit: "500.000" }] });

  it("Jurnal Penyesuaian on or before the Saldo Awal date is refused; the day after posts", async () => {
    const g = await makeGroup();
    await opening(g);
    await expect(atk(g, dateOnly(2025, 10, 15))).rejects.toThrow("saldo PT Uji sampai 31 Okt 2025 sudah tercatat di Saldo Awal");
    await expect(atk(g, dateOnly(2025, 10, 31))).rejects.toThrow("Saldo Awal");
    expect(await db.journalEntry.count({ where: { kind: "ADJUSTMENT" } })).toBe(0);
    await atk(g, dateOnly(2025, 11, 1));
    expect(await db.journalEntry.count({ where: { kind: "ADJUSTMENT" } })).toBe(1);
  });

  it("an invoice before Saldo Awal must be a Saldo Awal item, not a new sale", async () => {
    const g = await makeGroup();
    await opening(g);
    const sale = { clientId: g.client.id, entityId: g.pt.entity.id, direction: "SALES" as const, contactName: "PT Pelanggan", number: "INV-1", issueDate: "2025-10-20", dpp: "1.000.000", counterCode: "4100" };
    await expect(createInvoice(db, sale)).rejects.toThrow("centang “Faktur saldo awal”");
    await createInvoice(db, { ...sale, opening: true });
    await createInvoice(db, { ...sale, number: "INV-2", issueDate: "2025-11-02" });
    expect(await db.invoice.count()).toBe(2);
  });

  it("Saldo Awal can't be dated on or after a journal already typed; an entity without Saldo Awal posts any date", async () => {
    const g = await makeGroup();
    await atk(g, dateOnly(2025, 11, 5));
    await expect(opening(g, dateOnly(2025, 11, 30))).rejects.toThrow("sebelum jurnal pertama entitas ini (5 Nov 2025: ATK)");
    await opening(g, dateOnly(2025, 10, 31));
  });
});
