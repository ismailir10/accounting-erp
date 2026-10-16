import { beforeEach, describe, expect, it } from "vitest";
import { db, resetDb } from "../helpers";
import { jeniusEstatementPdf, type JeniusRow } from "../pdf-fixture";
import { createFirm } from "@/lib/setup";
import { addClient } from "@/lib/onboarding";
import { importStatement } from "@/lib/import/pipeline";
import { AccountMismatchError } from "@/lib/import/types";
import { postOpening } from "@/lib/opening";
import { runControls } from "@/lib/controls";
import { dateOnly } from "@/lib/format";

/** Two fictional months of a Jenius e-Statement (2025 layout): no balance column, printed Previous and Ending Balance. */
const AUG: JeniusRow[] = [
  { date: "01 Aug 2026", details: ["Transfer dari NASABAH FIKTIF"], amount: 2_500_000 },
  { date: "03 Aug 2026", details: ["Biaya Admin"], amount: -2_500, type: "" },
  { date: "03 Aug 2026", details: ["Biaya Admin"], amount: -2_500, type: "" },
  { date: "20 Aug 2026", details: ["Transfer ke REKENING FIKTIF", "REF - 88123456"], amount: -1_000_000 },
];
const SEP: JeniusRow[] = [
  { date: "02 Sep 2026", details: ["Pembayaran QRIS Toko Fiktif"], amount: -125_000, note: "Makan 4821" },
  { date: "30 Sep 2026", details: ["Bunga"], amount: 1_234 },
];
const OPEN = 10_000_000;
const AUG_END = AUG.reduce((t, r) => t + r.amount, OPEN);
const SEP_END = SEP.reduce((t, r) => t + r.amount, AUG_END);
const aug = jeniusEstatementPdf({ rows: AUG, opening: OPEN });
const sep = jeniusEstatementPdf({ rows: SEP, opening: AUG_END, period: "September 2026", asOf: "30 September 2026" });

async function setup() {
  const firm = await db.$transaction((tx) => createFirm(tx, "KJA Fiktif"));
  const client = await addClient(db, firm.id, {
    name: "Nasabah Fiktif",
    industry: "",
    entities: [{ name: "Nasabah Fiktif", shortName: "Fiktif", kind: "PERORANGAN", npwp: "", banks: [{ bank: "SMBC", number: "90012345678", label: "Jenius" }, { bank: "SMBC", number: "90099999999", label: "Jenius lain" }] }],
  });
  const banks = await db.bankAccount.findMany({ where: { entity: { clientId: client.id } }, include: { account: true }, orderBy: { number: "asc" } });
  return { client, jenius: banks[0], other: banks[1] };
}

const glBalance = async (accountId: string) => {
  const s = await db.journalLine.aggregate({ where: { accountId }, _sum: { debit: true, credit: true } });
  return (s._sum.debit ?? 0n) - (s._sum.credit ?? 0n);
};

describe("Jenius e-Statement (2025 layout) through the import pipeline", () => {
  beforeEach(resetDb);

  it("imports two months that chain, reconciles them, and books nothing twice", async () => {
    const { client, jenius } = await setup();
    await postOpening(db, { clientId: client.id, entityId: jenius.entityId, date: dateOnly(2026, 7, 31), lines: [{ accountCode: jenius.account.code, debit: String(OPEN), credit: "" }, { accountCode: "3200", debit: "", credit: String(OPEN) }] });

    const a = await importStatement(db, { bankAccountId: jenius.id, fileName: "jenius-agustus.pdf", data: aug, provider: null });
    expect(a).toMatchObject({ rows: AUG.length, duplicates: 0, continuityOk: true, fileBank: "SMBC" });
    expect(a.ai.calls).toBe(0);
    const s = await importStatement(db, { bankAccountId: jenius.id, fileName: "jenius-september.pdf", data: sep, provider: null });
    expect(s).toMatchObject({ rows: SEP.length, duplicates: 0, continuityOk: true });

    // Every row once, with its sign; the bank GL equals the printed ending balance.
    const txs = await db.bankTransaction.findMany({ where: { bankAccountId: jenius.id }, orderBy: [{ date: "asc" }, { rowNumber: "asc" }] });
    expect(txs.map((t) => [t.date.toISOString().slice(0, 10), t.amount, t.direction])).toEqual(
      [...AUG, ...SEP].map((r) => [`2026-${r.date.includes("Aug") ? "08" : "09"}-${r.date.slice(0, 2)}`, BigInt(r.amount), r.amount > 0 ? "IN" : "OUT"]),
    );
    expect(await glBalance(jenius.accountId)).toBe(BigInt(SEP_END));
    // The printed balances prove each month: reconciliation and completeness pass.
    for (const [y, m] of [[2026, 8], [2026, 9]]) {
      const controls = await runControls(db, client.id, y, m);
      const status = (title: string) => controls.find((c) => c.title === title)?.status;
      expect([status("Rekonsiliasi Jenius"), status("Kelengkapan mutasi Jenius")], `${y}-${m}`).toEqual(["PASS", "PASS"]);
    }

    // The same file again, and the same month reissued in the other variant (other bytes, same rows): nothing new is written.
    const before = [await db.bankTransaction.count(), await db.journalEntry.count()];
    const again = await importStatement(db, { bankAccountId: jenius.id, fileName: "jenius-agustus.pdf", data: aug, provider: null });
    expect([again.duplicates, again.rows]).toEqual([AUG.length, AUG.length]);
    // A reissue in other bytes: with no running balance nothing proves its rows are the ones on file (same date and amount alone
    // never does, accounting-rules 12), so the whole file is refused and nothing is written, never half-imported.
    const reissued = jeniusEstatementPdf({ rows: AUG, opening: OPEN, inline: true });
    expect(reissued.equals(aug)).toBe(false);
    await expect(importStatement(db, { bankAccountId: jenius.id, fileName: "jenius-agustus-ulang.pdf", data: reissued, provider: null })).rejects.toThrow(/saldo tidak membuktikan identitasnya/);
    expect([await db.bankTransaction.count(), await db.journalEntry.count()]).toEqual(before);
    expect(await glBalance(jenius.accountId)).toBe(BigInt(SEP_END));
  });

  it("refuses a statement into another account: the printed account number is checked", async () => {
    const { other } = await setup();
    await expect(importStatement(db, { bankAccountId: other.id, fileName: "jenius-agustus.pdf", data: aug, provider: null })).rejects.toBeInstanceOf(AccountMismatchError);
    expect(await db.bankTransaction.count()).toBe(0);
  });
});
