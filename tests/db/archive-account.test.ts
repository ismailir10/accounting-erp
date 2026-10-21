import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { archiveAccount, createAccount, unarchiveAccount } from "@/lib/coa/manage";
import { importStatement } from "@/lib/import/pipeline";
import { classifiableOptions } from "@/lib/coa/options";
import { isClassifiable } from "@/lib/coa/template";
import { listEvents } from "@/lib/audit";
import { dateOnly } from "@/lib/format";

/** Arsip akun (cycle 2026-10-20-lampiran-arsip): an account the client stopped using leaves the pickers, the classifier and the ledger. */
describe("arsip akun", () => {
  beforeEach(resetDb);

  const lock = (g: Awaited<ReturnType<typeof makeGroup>>, year: number, month: number) =>
    db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year, month } }, create: { firmId: g.firm.id, clientId: g.client.id, year, month, status: "LOCKED" }, update: { status: "LOCKED" } });
  const account = (g: Awaited<ReturnType<typeof makeGroup>>, code: string) => db.account.findFirstOrThrow({ where: { clientId: g.client.id, code } });
  const pay = (g: Awaited<ReturnType<typeof makeGroup>>, code: string, month: number) =>
    postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, month, 10), memo: "Sewa gudang", lines: [{ accountCode: code, debit: "1.000.000", credit: "" }, { accountCode: "1110", debit: "", credit: "1.000.000" }] });

  it("archives an expense account used only in closed months; it leaves the pickers and the ledger refuses it until reactivated", async () => {
    const g = await makeGroup();
    const a = await createAccount(db, { clientId: g.client.id, fsLine: "BEBAN_UMUM_ADM", name: "Beban Sewa Gudang Lama" });
    await pay(g, a.code, 7);
    await expect(archiveAccount(db, { clientId: g.client.id, accountId: a.id })).rejects.toThrow("masih dipakai di bulan yang belum ditutup (7/2026)");
    await lock(g, 2026, 7);
    await archiveAccount(db, { clientId: g.client.id, accountId: a.id });
    const archived = await account(g, a.code);
    expect(archived.archivedAt).not.toBeNull();
    expect(isClassifiable(archived)).toBe(false);
    expect(classifiableOptions([archived]).length).toBe(0);
    await expect(pay(g, a.code, 8)).rejects.toThrow(`Akun ${a.code} Beban Sewa Gudang Lama sudah diarsipkan. Aktifkan lagi di Bagan akun untuk memakainya.`);
    await unarchiveAccount(db, { clientId: g.client.id, accountId: a.id });
    await pay(g, a.code, 8);
    expect((await listEvents(db, g.client.id, { kind: "ACCOUNT" })).map((e) => e.summary)).toEqual(expect.arrayContaining([`Akun ${a.code} Beban Sewa Gudang Lama diarsipkan`, `Akun ${a.code} Beban Sewa Gudang Lama diaktifkan lagi`]));
  });

  it("refuses system, bank and guess accounts, a balance-sheet account with a balance, and one a running schedule uses", async () => {
    const g = await makeGroup();
    const refuse = async (code: string, message: string | RegExp) => expect(archiveAccount(db, { clientId: g.client.id, accountId: (await account(g, code)).id })).rejects.toThrow(message);
    await refuse("3200", "Akun sistem");
    await refuse("1101", "Akun bank");
    await refuse("6190", "tebakan bawaan");
    const deposit = await createAccount(db, { clientId: g.client.id, fsLine: "PIUTANG_LAIN", name: "Jaminan Sewa" });
    await postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 7, 1), memo: "Jaminan", lines: [{ accountCode: deposit.code, debit: "5.000.000", credit: "" }, { accountCode: "1110", debit: "", credit: "5.000.000" }] });
    await lock(g, 2026, 7);
    await refuse(deposit.code, "masih bersaldo");
    expect((await account(g, deposit.code)).archivedAt).toBeNull();
  });

  it("a rule pointing at an archived account no longer classifies: the line waits in Review", async () => {
    const g = await makeGroup(); // its rule: PAKAN → 5100
    await archiveAccount(db, { clientId: g.client.id, accountId: (await account(g, "5100")).id });
    const csv = ["Tanggal;Keterangan;Debet;Kredit;Saldo", "01/08/2026;SALDO AWAL;;;10.000.000,00", "03/08/2026;BELI PAKAN AYAM;1.000.000,00;0,00;9.000.000,00", ""].join("\n");
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "agustus.csv", data: Buffer.from(csv), provider: null });
    const line = await db.bankTransaction.findFirstOrThrow({ where: { description: { contains: "PAKAN" } } });
    expect(line.method).not.toBe("RULE");
    expect(line.accountCode).not.toBe("5100");
    expect(await db.journalLine.count({ where: { account: { code: "5100" } } })).toBe(0);
  });
});
