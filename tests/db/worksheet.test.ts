import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { postOpening } from "@/lib/opening";
import { createInvoice } from "@/lib/receivables/invoices";
import { neracaLajur } from "@/lib/reports/worksheet";
import { dateOnly } from "@/lib/format";

const K = 1_000n;

/** Neraca Lajur (cycle 2026-10-20-paritas-inti), figures computed by hand. */
describe("neraca lajur", () => {
  beforeEach(resetDb);

  async function books() {
    const g = await makeGroup();
    const base = { clientId: g.client.id, entityId: g.pt.entity.id };
    await postOpening(db, { ...base, date: dateOnly(2026, 7, 31), lines: [{ accountCode: "1101", debit: "10.000.000", credit: "" }, { accountCode: "3100", debit: "", credit: "10.000.000" }] });
    await createInvoice(db, { ...base, direction: "SALES", contactName: "PT A", number: "INV-1", issueDate: "2026-08-05", dpp: "1.000.000", ppn: "110.000", counterCode: "4100" });
    await postAdjustment(db, { ...base, date: dateOnly(2026, 8, 31), memo: "Penyusutan", lines: [{ accountCode: "6180", debit: "200.000", credit: "" }, { accountCode: "1219", debit: "", credit: "200.000" }] });
    await postAdjustment(db, { ...base, date: dateOnly(2026, 8, 31), memo: "Akrual listrik", reverseNextMonth: true, lines: [{ accountCode: "6130", debit: "300.000", credit: "" }, { accountCode: "2150", debit: "", credit: "300.000" }] });
    return { scope: { clientId: g.client.id, entityIds: [g.pt.entity.id] } };
  }

  it("August: before adjustments, the adjustments, after, Laba Rugi and Neraca, each pair balanced by the profit", async () => {
    const { scope } = await books();
    const w = await neracaLajur(db, scope, dateOnly(2026, 8, 1), dateOnly(2026, 8, 31));
    const row = (code: string) => {
      const l = w.lines.find((x) => x.account.code === code)!;
      return [l.unadjusted, l.adjDebit, l.adjCredit, l.adjusted, l.pl];
    };
    expect(row("1101")).toEqual([10_000n * K, 0n, 0n, 10_000n * K, false]);
    expect(row("1130")).toEqual([1_110n * K, 0n, 0n, 1_110n * K, false]);
    expect(row("1219")).toEqual([0n, 0n, 200n * K, -200n * K, false]);
    expect(row("2150")).toEqual([0n, 0n, 300n * K, -300n * K, false]);
    expect(row("4100")).toEqual([-1_000n * K, 0n, 0n, -1_000n * K, true]);
    expect(row("6130")).toEqual([0n, 300n * K, 0n, 300n * K, true]);
    expect(w.totals).toEqual({
      unadjusted: { debit: 11_110n * K, credit: 11_110n * K },
      adjustments: { debit: 500n * K, credit: 500n * K },
      adjusted: { debit: 11_610n * K, credit: 11_610n * K },
      pl: { debit: 500n * K, credit: 1_000n * K },
      bs: { debit: 11_110n * K, credit: 10_610n * K },
    });
    expect(w.profit).toBe(500n * K);
    expect(w.totals.bs.debit - w.totals.bs.credit).toBe(w.profit);
  });

  it("September: the accrual's reversal is an adjustment, so listrik shows before (300.000) and after (0)", async () => {
    const { scope } = await books();
    const w = await neracaLajur(db, scope, dateOnly(2026, 9, 1), dateOnly(2026, 9, 30));
    const l = w.lines.find((x) => x.account.code === "6130")!;
    expect([l.unadjusted, l.adjDebit, l.adjCredit, l.adjusted]).toEqual([300n * K, 0n, 300n * K, 0n]);
    // The year to date sees both the accrual and its reversal.
    const ytd = await neracaLajur(db, scope, dateOnly(2026, 1, 1), dateOnly(2026, 9, 30));
    const y = ytd.lines.find((x) => x.account.code === "6130")!;
    expect([y.unadjusted, y.adjDebit, y.adjCredit, y.adjusted]).toEqual([0n, 300n * K, 300n * K, 0n]);
    expect(ytd.profit).toBe(800n * K); // 1.000.000 − 200.000 depreciation; the accrual and its reversal cancel
  });
});
