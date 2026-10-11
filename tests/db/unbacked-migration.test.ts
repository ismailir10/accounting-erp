import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction } from "@/lib/review";

const sql = readFileSync("prisma/migrations/20261011130000_unbacked_trade_replace/migration.sql", "utf8");
const OLD_IN = "Pelunasan piutang usaha · Belum ada piutang usaha tercatat untuk entitas ini: periksa apakah ini penjualan tunai.";
const OLD_OUT = "Pembayaran utang usaha · Belum ada utang usaha tercatat untuk entitas ini: periksa apakah ini beban atau pembelian langsung.";

const file = Buffer.from(
  [
    "Tanggal;Keterangan;Debet;Kredit;Saldo",
    "01/08/2026;SALDO AWAL;;;10.000.000",
    "05/08/2026;TRSF MASUK PT PELANGGAN SETIA;;5.000.000;15.000.000",
    "06/08/2026;TRSF MASUK PT PELANGGAN LAMA;;1.000.000;16.000.000",
    "07/08/2026;TRSF KELUAR CV PEMASOK ABADI;2.000.000;;14.000.000",
    "",
  ].join("\n"),
);

describe("data migration: replace unbacked trade suggestions already in Review", () => {
  beforeEach(resetDb);

  it("rewrites old-style waiting lines, leaves accepted and unrelated lines alone, and is idempotent", async () => {
    const g = await makeGroup();
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "agu.csv", data: file, provider: null });
    const lines = await db.bankTransaction.findMany({ where: { bankAccountId: g.pt.banks[0].id }, orderBy: { rowNumber: "asc" } });
    const [setia, lama, pemasok] = lines;
    // the state production holds: AI, the receivable/payable kept at 55%, the old appended reason
    const old = (id: string, suggestedCode: string, reason: string) =>
      db.bankTransaction.update({ where: { id }, data: { method: "AI", suggestedCode, confidence: 0.55, reason, taxTag: "PPN_KELUARAN" } });
    await old(setia.id, "1130", OLD_IN);
    await old(lama.id, "1130", OLD_IN);
    await old(pemasok.id, "2110", OLD_OUT);
    await reviewTransaction(db, { bankTxId: lama.id, accountCode: "1130", taxTag: null }); // the accountant accepted this one

    await db.$executeRawUnsafe(sql);

    const after = new Map((await db.bankTransaction.findMany({ where: { bankAccountId: g.pt.banks[0].id } })).map((t) => [t.id, t]));
    expect(after.get(setia.id)).toMatchObject({ status: "NEEDS_REVIEW", method: "AI", suggestedCode: "4100", confidence: 0.55, taxTag: null });
    expect(after.get(setia.id)!.reason).toBe("AI mengusulkan 1130 Piutang Usaha, tetapi tidak ada piutang usaha tercatat untuk entitas ini: dianggap penjualan tunai (4100 Penjualan).");
    expect(after.get(pemasok.id)).toMatchObject({ suggestedCode: "6190", taxTag: null });
    expect(after.get(pemasok.id)!.reason).toMatch(/^AI mengusulkan 2110 .*dianggap beban atau pembelian langsung \(6190 /);
    expect(after.get(lama.id)).toMatchObject({ status: "REVIEWED", suggestedCode: "1130" }); // accepted: untouched

    await db.$executeRawUnsafe(sql); // idempotent: the new reason no longer matches
    const again = await db.bankTransaction.findMany({ where: { bankAccountId: g.pt.banks[0].id } });
    expect(again.map((t) => [t.id, t.suggestedCode, t.reason, t.status]).sort()).toEqual([...after.values()].map((t) => [t.id, t.suggestedCode, t.reason, t.status]).sort());
  });

  it("skips a line when the client's chart lacks the fallback account", async () => {
    const g = await makeGroup();
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "agu.csv", data: file, provider: null });
    const [setia] = await db.bankTransaction.findMany({ where: { bankAccountId: g.pt.banks[0].id }, orderBy: { rowNumber: "asc" } });
    await db.bankTransaction.update({ where: { id: setia.id }, data: { method: "AI", suggestedCode: "1130", confidence: 0.55, reason: OLD_IN } });
    await db.account.update({ where: { clientId_code: { clientId: g.client.id, code: "4100" } }, data: { code: "4199" } });
    await db.$executeRawUnsafe(sql);
    expect(await db.bankTransaction.findUniqueOrThrow({ where: { id: setia.id } })).toMatchObject({ suggestedCode: "1130", reason: OLD_IN });
  });
});
