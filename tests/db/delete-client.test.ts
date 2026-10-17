import { beforeEach, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { makePdf, table } from "../pdf-fixture";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction } from "@/lib/review";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { createClient } from "@/lib/setup";
import { deleteClient, DeleteClientError } from "@/lib/clients/delete";
import { dateOnly } from "@/lib/format";
import { postJournal } from "@/lib/ledger/post";

beforeEach(resetDb);

const statement = makePdf([
  [
    ...table(800, [[[40, "PT Bank Mandiri (Persero) Tbk"]], [[40, "Nomor Rekening : 2222222222"]], [[40, "Periode : 01/08/2026 - 31/08/2026"]]]),
    ...table(740, [
      [[40, "Tanggal"], [130, "Keterangan"], [360, "Debit"], [440, "Kredit"], [520, "Saldo"]],
      [[40, "01/08/2026"], [130, "SALDO AWAL"], [500, "0,00"]],
      [[40, "04/08/2026"], [130, "TRSF KE TOKO ABC"], [360, "1.000.000,00"], [510, "-1.000.000,00"]],
    ]),
  ],
]);

it("deletes one client's books completely and nothing of another client", async () => {
  const g = await makeGroup();
  const other = await db.$transaction((tx) => createClient(tx, g.firm.id, { name: "Klien Lain", industry: "", entities: [{ name: "PT Lain", shortName: "Lain", kind: "PT", banks: [{ bank: "BCA", number: "9999999999", label: "BCA" }] }] }));
  await importStatement(db, { bankAccountId: g.pt.banks[1].id, fileName: "mandiri.pdf", data: statement, provider: null });
  const tx = await db.bankTransaction.findFirstOrThrow({ where: { entityId: g.pt.entity.id } });
  await reviewTransaction(db, { bankTxId: tx.id, accountCode: "6190", taxTag: null });
  await postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 8, 31), memo: "Akrual", lines: [{ accountCode: "6190", debit: "500", credit: "" }, { accountCode: "2150", debit: "", credit: "500" }] });
  const otherAccounts = await db.account.count({ where: { clientId: other.client.id } });
  // Instruksi kantor: the client's own instruction and its rule go; a *Semua klien* one and its rule stay.
  const own = await db.instruction.create({ data: { firmId: g.firm.id, clientId: g.client.id, sentence: "BIAYA ADM selalu 6190", kind: "ACCOUNT", origin: "PARSER", pattern: "BIAYA ADM", direction: "OUT", accountCode: "6190" } });
  await db.rule.create({ data: { firmId: g.firm.id, clientId: g.client.id, pattern: "BIAYA ADM", direction: "OUT", accountCode: "6190", priority: 5, source: "INSTRUKSI", instructionId: own.id } });
  const firmWide = await db.instruction.create({ data: { firmId: g.firm.id, sentence: "PT MAJU JAYA selalu 6190", kind: "ACCOUNT", origin: "PARSER", pattern: "PT MAJU JAYA", direction: "OUT", accountCode: "6190" } });
  await db.rule.create({ data: { firmId: g.firm.id, pattern: "PT MAJU JAYA", direction: "OUT", accountCode: "6190", priority: 5, source: "INSTRUKSI", instructionId: firmWide.id } });
  await db.instruction.create({ data: { firmId: g.firm.id, clientId: g.client.id, sentence: "tandai pengeluaran > Rp10 jt", kind: "FLAG", origin: "PARSER", direction: "OUT", minAmount: 10_000_000n } });

  await expect(deleteClient(db, { firmId: g.firm.id, clientId: g.client.id, confirmName: "grup uji" })).rejects.toBeInstanceOf(DeleteClientError);
  await expect(deleteClient(db, { firmId: "another-firm", clientId: g.client.id, confirmName: "Grup Uji" })).rejects.toThrow("Klien tidak ditemukan.");
  expect(await db.journalEntry.count({ where: { entity: { clientId: g.client.id } } })).toBeGreaterThan(0);

  expect(await deleteClient(db, { firmId: g.firm.id, clientId: g.client.id, confirmName: " Grup Uji " })).toEqual({ name: "Grup Uji", entities: 2 });
  expect(await db.client.count({ where: { id: g.client.id } })).toBe(0);
  expect(await db.entity.count()).toBe(1); // the other client's
  expect(await db.bankAccount.count()).toBe(1);
  for (const n of [ db.journalEntry.count(), db.journalLine.count(), db.bankTransaction.count(), db.statementImport.count(), db.memory.count(), db.period.count()]) {
    expect(await n).toBe(0); // the other client has no books yet
  }
  expect(await db.account.count({ where: { clientId: g.client.id } })).toBe(0);
  expect(await db.account.count({ where: { clientId: other.client.id } })).toBe(otherAccounts);
  expect(await db.client.count({ where: { id: other.client.id } })).toBe(1);
  expect(await db.instruction.findMany({ select: { id: true } })).toEqual([{ id: firmWide.id }]);
  expect(await db.rule.count({ where: { instructionId: { not: null } } })).toBe(1);
});

it("deletes a schedule made from a journal line and its posted installments (they point at each other)", async () => {
  const g = await makeGroup();
  const id = async (code: string) => (await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code } })).id;
  const [prepaid, bank, expense] = [await id("1170"), await id("1101"), await id("6120")];
  const source = await db.$transaction((tx) => postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, 7, 1), kind: "ADJUSTMENT", memo: "Sewa dibayar di muka", lines: [{ accountId: prepaid, debit: 12_000n }, { accountId: bank, credit: 12_000n }] }));
  const schedule = await db.adjustmentSchedule.create({ data: { firmId: g.firm.id, clientId: g.client.id, entityId: g.pt.entity.id, kind: "AMORTIZATION", memo: "Amortisasi sewa", debitAccountId: expense, creditAccountId: prepaid, amount: 12_000n, months: 12, startYear: 2026, startMonth: 7, sourceEntryId: source.id, sourceAccountId: prepaid } });
  await db.$transaction((tx) => postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, 7, 31), kind: "ADJUSTMENT", memo: "Amortisasi sewa 1/12", scheduleId: schedule.id, installment: 1, lines: [{ accountId: expense, debit: 1_000n }, { accountId: prepaid, credit: 1_000n }] }));
  await deleteClient(db, { firmId: g.firm.id, clientId: g.client.id, confirmName: "Grup Uji" });
  expect([await db.adjustmentSchedule.count(), await db.journalEntry.count(), await db.client.count()]).toEqual([0, 0, 0]);
});
