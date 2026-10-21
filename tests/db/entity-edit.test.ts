import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { importStatement } from "@/lib/import/pipeline";
import { postOpening } from "@/lib/opening";
import { runControls } from "@/lib/controls";
import { incomeStatement, trialBalance } from "@/lib/reports/ledger";
import { addBankAccount, addEntity, OnboardingError } from "@/lib/onboarding";
import { createClient, createFirm } from "@/lib/setup";
import { blockedReason, clientUsage, EntityEditError, numberLocked, removeBankAccount, removeEntity, renameEntity, updateBankAccount } from "@/lib/clients/entities";
import { dateOnly } from "@/lib/format";

type G = Awaited<ReturnType<typeof makeGroup>>;
const csv = (...rows: string[]) => Buffer.from(["Tanggal;Keterangan;Debet;Kredit;Saldo", ...rows, ""].join("\n"));
const ids = (g: G) => ({ firmId: g.firm.id, clientId: g.client.id });
const fieldsOf = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as OnboardingError).fields;
const messageOf = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as Error).message;
const bankUsage = async (g: G, id: string) => (await clientUsage(db, g.client.id)).banks.get(id)!;
const entityUsage = async (g: G, id: string) => (await clientUsage(db, g.client.id)).entities.get(id)!;
const labels = (u: { label: string }[]) => u.map((x) => x.label);

/** A client with real books: PT (BCA + Mandiri) with Saldo Awal and an August BCA statement; the owner (BRI) with an August statement. */
async function booked() {
  const g = await makeGroup();
  await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 7, 31), lines: [{ accountCode: "1101", debit: "100000000", credit: "0" }, { accountCode: "3100", debit: "0", credit: "100000000" }] });
  await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca-agu.csv", data: csv("05/08/2026;TRSF CR TOKO MAJU;0;5000000;105000000", "20/08/2026;BIAYA ADMINISTRASI;15000;0;104985000"), provider: null });
  await importStatement(db, { bankAccountId: g.owner.banks[0].id, fileName: "bri-agu.csv", data: csv("10/08/2026;SETORAN;0;2000000;2000000"), provider: null });
  return g;
}

/** Everything an accountant would sign: trial balance and Laba Rugi by account code, control statuses, journal totals, row counts. */
async function snapshot(g: G) {
  const scope = { clientId: g.client.id, entityIds: [g.pt.entity.id, g.owner.entity.id] };
  const tb = await trialBalance(db, scope, dateOnly(2026, 8, 31));
  const is = await incomeStatement(db, scope, dateOnly(2026, 8, 1), dateOnly(2026, 8, 31));
  const controls = await runControls(db, g.client.id, 2026, 8);
  const lines = await db.journalLine.aggregate({ _sum: { debit: true, credit: true }, _count: true });
  return {
    tb: tb.filter((r) => r.net !== 0n).map((r) => `${r.account.code}:${r.net}`).sort(), // a removed empty account had a zero row
    revenue: String(is.totals.revenue),
    netProfit: String(is.totals.netProfit),
    controls: controls.map((c) => `${c.key}:${c.status}`).sort(), // the list's order is not part of the books
    debit: String(lines._sum.debit),
    credit: String(lines._sum.credit),
    counts: [await db.journalEntry.count(), lines._count, await db.bankTransaction.count(), await db.statementImport.count(), await db.entity.count(), await db.bankAccount.count(), await db.account.count()],
  };
}

describe("rename a company or owner", () => {
  beforeEach(resetDb);

  it("changes name, short name and NPWP, renames the bank GL accounts built from them, and says so in Riwayat", async () => {
    const g = await booked();
    await renameEntity(db, { ...ids(g), entityId: g.pt.entity.id, name: "PT Uji Makmur Abadi", shortName: "PT UMA", npwp: "012345678015000" });
    expect(await db.entity.findUniqueOrThrow({ where: { id: g.pt.entity.id } })).toMatchObject({ name: "PT Uji Makmur Abadi", shortName: "PT UMA", npwp: "01.234.567.8-015.000", kind: "PT", functionalCurrency: "IDR" });
    const names = (await db.bankAccount.findMany({ where: { entityId: g.pt.entity.id }, include: { account: true }, orderBy: { number: "asc" } })).map((b) => b.account.name);
    expect(names).toEqual(["BCA Giro (PT UMA)", "Mandiri Giro (PT UMA)"]);
    const event = await db.auditEvent.findFirstOrThrow({ where: { clientId: g.client.id, kind: "COMPANY_BANK" } });
    expect(event).toMatchObject({ entityId: g.pt.entity.id, subject: `entity:${g.pt.entity.id}`, summary: "Data PT Uji Sejahtera diubah menjadi PT Uji Makmur Abadi", before: { name: "PT Uji Sejahtera", shortName: "PT Uji", npwp: "" }, after: { name: "PT Uji Makmur Abadi", shortName: "PT UMA", npwp: "01.234.567.8-015.000" } });
    // Blank short name = the name; blank NPWP clears it; the owner is untouched.
    await renameEntity(db, { ...ids(g), entityId: g.pt.entity.id, name: "PT Uji Makmur", shortName: " ", npwp: "" });
    expect(await db.entity.findUniqueOrThrow({ where: { id: g.pt.entity.id } })).toMatchObject({ shortName: "PT Uji Makmur", npwp: null });
    expect(await db.entity.findUniqueOrThrow({ where: { id: g.owner.entity.id } })).toMatchObject({ name: "Andi Wijaya", shortName: "Andi" });
  });

  it("saving the same values writes nothing (no Riwayat line for a no-op)", async () => {
    const g = await makeGroup();
    await renameEntity(db, { ...ids(g), entityId: g.pt.entity.id, name: "PT Uji Sejahtera", shortName: "PT Uji", npwp: "" });
    await updateBankAccount(db, { ...ids(g), bankAccountId: g.pt.banks[0].id, label: "BCA Giro", bank: "BCA", number: "1111111111" });
    expect(await db.auditEvent.count()).toBe(0);
  });

  it("moves no figure: trial balance, Laba Rugi, control results and every row count are identical, also in a locked month", async () => {
    const g = await booked();
    await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 8 } }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 8, status: "LOCKED", lockedAt: new Date() }, update: { status: "LOCKED", lockedAt: new Date() } });
    const before = await snapshot(g);
    await renameEntity(db, { ...ids(g), entityId: g.pt.entity.id, name: "PT Nama Baru", shortName: "PT Baru", npwp: "" });
    await renameEntity(db, { ...ids(g), entityId: g.owner.entity.id, name: "Andi Wijaya S.E.", shortName: "Andi W", npwp: "" });
    await updateBankAccount(db, { ...ids(g), bankAccountId: g.pt.banks[0].id, label: "BCA Operasional", bank: "BCA", number: "1111111111" });
    expect(await snapshot(g)).toEqual(before);
    expect((await db.period.findFirstOrThrow({ where: { clientId: g.client.id, year: 2026, month: 8 } })).status).toBe("LOCKED");
  });

  it("says what to fix: empty or long names, a bad NPWP, a short name another company already has (any letter case)", async () => {
    const g = await makeGroup();
    const rename = (over: Partial<Parameters<typeof renameEntity>[1]>) => renameEntity(db, { ...ids(g), entityId: g.pt.entity.id, name: "PT Uji", shortName: "PT Uji", npwp: "", ...over });
    expect(await fieldsOf(rename({ name: "  " }))).toEqual({ name: "Isi nama badan usaha." });
    expect(await fieldsOf(rename({ name: "x".repeat(121) }))).toEqual({ name: "Nama maksimal 120 karakter." });
    expect(await fieldsOf(rename({ npwp: "123" }))).toEqual({ npwp: "NPWP berisi 15 atau 16 angka, boleh dengan titik dan strip." });
    expect(await fieldsOf(rename({ shortName: "andi" }))).toEqual({ shortName: "Nama singkat ini sudah dipakai perusahaan lain di klien ini." });
    expect(await fieldsOf(renameEntity(db, { ...ids(g), entityId: g.owner.entity.id, name: " ", shortName: "", npwp: "" }))).toEqual({ name: "Isi nama pemilik." });
    // Keeping its own short name is not a clash.
    await rename({ name: "PT Uji Sejahtera Baru" });
    expect((await db.entity.findUniqueOrThrow({ where: { id: g.pt.entity.id } })).name).toBe("PT Uji Sejahtera Baru");
  });

  it("a foreign entity has no NPWP, whatever is sent", async () => {
    const g = await makeGroup();
    const e = await addEntity(db, g.firm.id, g.client.id, { name: "Holdco Pte Ltd", shortName: "Holdco", kind: "BADAN_USAHA_ASING", npwp: "", currency: "SGD", banks: [] });
    await renameEntity(db, { ...ids(g), entityId: e.id, name: "Holdco Pte Ltd", shortName: "Holdco", npwp: "01.234.567.8-015.000" });
    expect((await db.entity.findUniqueOrThrow({ where: { id: e.id } })).npwp).toBeNull();
  });

  it("adding an entity with a short name the client already has is refused too", async () => {
    const g = await makeGroup();
    expect(await fieldsOf(addEntity(db, g.firm.id, g.client.id, { name: "Andi Lain", shortName: "ANDI", kind: "PERORANGAN", npwp: "", banks: [] }))).toEqual({ "entity.shortName": "Nama singkat ini sudah dipakai perusahaan lain di klien ini." });
    expect(await db.entity.count({ where: { clientId: g.client.id } })).toBe(2);
  });
});

describe("edit a bank account", () => {
  beforeEach(resetDb);

  it("renames the label and its GL account; a blank label falls back to the default name", async () => {
    const g = await makeGroup();
    const ba = g.pt.banks[1]; // Mandiri Giro, 2222222222
    await updateBankAccount(db, { ...ids(g), bankAccountId: ba.id, label: "Mandiri Payroll", bank: "MANDIRI", number: "2222222222" });
    expect(await db.bankAccount.findUniqueOrThrow({ where: { id: ba.id }, include: { account: true } })).toMatchObject({ label: "Mandiri Payroll", account: { name: "Mandiri Payroll (PT Uji)" } });
    expect(await db.auditEvent.findFirstOrThrow({ where: { subject: `bankAccount:${ba.id}` } })).toMatchObject({ summary: "Rekening Mandiri Giro diubah menjadi Mandiri Payroll", before: { label: "Mandiri Giro" }, after: { label: "Mandiri Payroll" } });
    await updateBankAccount(db, { ...ids(g), bankAccountId: ba.id, label: " ", bank: "MANDIRI", number: "2222222222" });
    expect((await db.bankAccount.findUniqueOrThrow({ where: { id: ba.id } })).label).toBe("Mandiri ••2222");
  });

  it("changes bank and number while nothing was read for it, checking them like at creation", async () => {
    const g = await makeGroup();
    const ba = g.pt.banks[1];
    expect(await fieldsOf(updateBankAccount(db, { ...ids(g), bankAccountId: ba.id, label: "x", bank: "MANDIRI", number: "12" }))).toEqual({ "bank.number": "Nomor rekening berisi 6–20 angka." });
    // 3333333333 is the owner's BRI account.
    expect(await fieldsOf(updateBankAccount(db, { ...ids(g), bankAccountId: ba.id, label: "x", bank: "MANDIRI", number: "3333333333" }))).toEqual({ "bank.number": "Nomor ini sudah dipakai rekening lain di klien ini." });
    await updateBankAccount(db, { ...ids(g), bankAccountId: ba.id, label: "Mandiri Giro", bank: "BRI", number: "1400012345678" });
    expect(await db.bankAccount.findUniqueOrThrow({ where: { id: ba.id } })).toMatchObject({ bank: "BRI", number: "1400012345678", isOverdraft: false });
  });

  it("keeps the number once a statement was read (files are matched by it), but still changes name and bank", async () => {
    const g = await booked();
    const ba = g.pt.banks[0];
    expect(numberLocked(await bankUsage(g, ba.id))).toBe(true);
    expect(await fieldsOf(updateBankAccount(db, { ...ids(g), bankAccountId: ba.id, label: "BCA Giro", bank: "BCA", number: "9999999999" }))).toEqual({
      "bank.number": "Rekening koran rekening ini sudah dibaca, jadi nomornya tetap (file berikutnya dicocokkan dengan nomor ini). Ubah nama atau banknya saja, atau tambahkan rekening baru.",
    });
    expect((await db.bankAccount.findUniqueOrThrow({ where: { id: ba.id } })).number).toBe("1111111111");
    await updateBankAccount(db, { ...ids(g), bankAccountId: ba.id, label: "BCA Operasional", bank: "BCA", number: "1111111111" });
    expect((await db.bankAccount.findUniqueOrThrow({ where: { id: ba.id } })).label).toBe("BCA Operasional");
    // The next statement of the same account still imports (number unchanged).
    await importStatement(db, { bankAccountId: ba.id, fileName: "bca-sep.csv", data: csv("02/09/2026;TRSF CR TOKO;0;1000000;105985000"), provider: null });
  });

  it("an OCR draft read for the account locks the number too", async () => {
    const g = await makeGroup();
    const ba = g.pt.banks[1];
    await db.ocrDraft.create({ data: { firmId: g.firm.id, clientId: g.client.id, bankAccountId: ba.id, fileName: "scan.pdf", fileHash: "h", pages: 1, model: "m", header: {}, rows: [] } });
    expect(labels(await bankUsage(g, ba.id))).toEqual(["draf rekening koran hasil baca"]);
    expect(await fieldsOf(updateBankAccount(db, { ...ids(g), bankAccountId: ba.id, label: "Mandiri Giro", bank: "MANDIRI", number: "9999999999" }))).toHaveProperty(["bank.number"]);
  });

  it("an overdraft account stays an overdraft (its GL type depends on it)", async () => {
    const g = await makeGroup();
    const prk = await addBankAccount(db, g.firm.id, g.client.id, g.pt.entity.id, { bank: "MANDIRI", number: "6660001234", label: "PRK Mandiri", isOverdraft: true });
    await updateBankAccount(db, { ...ids(g), bankAccountId: prk.id, label: "PRK Modal Kerja", bank: "MANDIRI", number: "6660001234" });
    expect(await db.bankAccount.findUniqueOrThrow({ where: { id: prk.id }, include: { account: true } })).toMatchObject({ isOverdraft: true, account: { code: "2201", type: "LIABILITAS", name: "PRK Modal Kerja (PT Uji)" } });
  });
});

describe("remove a bank account", () => {
  beforeEach(resetDb);

  it("removes an unused one with its GL account, writes Riwayat, and frees the code for the next", async () => {
    const g = await booked();
    const mandiri = g.pt.banks[1]; // 1102, never used
    const before = await snapshot(g);
    expect(await bankUsage(g, mandiri.id)).toEqual([]);
    await removeBankAccount(db, { ...ids(g), bankAccountId: mandiri.id, actorId: null });
    expect(await db.bankAccount.findUnique({ where: { id: mandiri.id } })).toBeNull();
    expect(await db.account.findFirst({ where: { clientId: g.client.id, code: "1102" } })).toBeNull();
    expect(await db.auditEvent.findFirstOrThrow({ where: { subject: `bankAccount:${mandiri.id}` } })).toMatchObject({ summary: "Rekening Mandiri Giro dihapus", before: { label: "Mandiri Giro", bank: "MANDIRI", number: "2222222222" } });
    const after = await snapshot(g);
    expect({ ...after, counts: undefined, controls: undefined }).toEqual({ ...before, counts: undefined, controls: undefined });
    expect(after.counts).toEqual([...before.counts.slice(0, 5), before.counts[5] - 1, before.counts[6] - 1]);
    const again = await addBankAccount(db, g.firm.id, g.client.id, g.pt.entity.id, { bank: "MANDIRI", number: "4444444444", label: "", isOverdraft: false });
    expect((await db.account.findUniqueOrThrow({ where: { id: again.accountId } })).code).toBe("1102");
  });

  it("refuses one with statements, bank rows or journal lines, names what is there, and changes nothing", async () => {
    const g = await booked();
    const before = await snapshot(g);
    const bca = g.pt.banks[0];
    expect(labels(await bankUsage(g, bca.id))).toEqual(expect.arrayContaining(["impor rekening koran", "mutasi bank", "baris jurnal"]));
    const message = await messageOf(removeBankAccount(db, { ...ids(g), bankAccountId: bca.id }));
    expect(message).toMatch(/^Sudah ada 1 impor rekening koran, 2 mutasi bank, \d+ baris jurnal/);
    expect(message).toContain("Rekening yang sudah dipakai tidak bisa dihapus.");
    expect(await snapshot(g)).toEqual(before);
    expect(await db.auditEvent.count()).toBe(0);
  });

  it("refuses one whose GL account a running Jurnal berulang names (it holds no line yet; removed, it would post to the next 1102)", async () => {
    const g = await makeGroup();
    const t = await db.recurringJournal.create({
      data: { firmId: g.firm.id, clientId: g.client.id, entityId: g.pt.entity.id, memo: "Transfer bulanan", day: 1, startYear: 2026, startMonth: 8, lines: [{ accountCode: "1102", debit: "1000000", credit: "0" }, { accountCode: "1110", debit: "0", credit: "1000000" }] },
    });
    await expect(removeBankAccount(db, { ...ids(g), bankAccountId: g.pt.banks[1].id })).rejects.toThrow(/1 jurnal berulang berjalan/);
    expect(await db.bankAccount.count()).toBe(3);
    await db.recurringJournal.update({ where: { id: t.id }, data: { stoppedAt: new Date() } });
    await removeBankAccount(db, { ...ids(g), bankAccountId: g.pt.banks[1].id });
    expect(await db.bankAccount.count()).toBe(2);
  });

  it("refuses one whose GL account only has a Saldo Awal line (no statement yet)", async () => {
    const g = await makeGroup();
    await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 7, 31), lines: [{ accountCode: "1102", debit: "5000000", credit: "0" }, { accountCode: "3100", debit: "0", credit: "5000000" }] });
    expect(labels(await bankUsage(g, g.pt.banks[1].id))).toEqual(["baris jurnal"]);
    await expect(removeBankAccount(db, { ...ids(g), bankAccountId: g.pt.banks[1].id })).rejects.toThrow(/^Sudah ada 1 baris jurnal\./);
    expect(await db.bankAccount.count()).toBe(3);
  });

  it("refuses one that bank rows, a client rule or a remembered choice file to (its code would point at the next account added)", async () => {
    const g = await makeGroup();
    await importStatement(db, { bankAccountId: g.owner.banks[0].id, fileName: "bri.csv", data: csv("10/08/2026;SETORAN;0;2000000;2000000"), provider: null });
    await db.bankTransaction.updateMany({ where: { entityId: g.owner.entity.id }, data: { suggestedCode: "1102" } });
    await db.rule.create({ data: { firmId: g.firm.id, clientId: g.client.id, pattern: "PINDAH DANA", accountCode: "1102" } });
    await db.memory.create({ data: { clientId: g.client.id, merchantKey: "PINDAH DANA", direction: "OUT", accountCode: "1102" } });
    expect(labels(await bankUsage(g, g.pt.banks[1].id))).toEqual(["mutasi yang diklasifikasikan ke akun ini", "aturan klasifikasi ke akun ini", "pilihan yang diingat ke akun ini"]);
    await expect(removeBankAccount(db, { ...ids(g), bankAccountId: g.pt.banks[1].id })).rejects.toBeInstanceOf(EntityEditError);
    expect(await db.bankAccount.count()).toBe(3);
  });

  it("refuses one that a ledger-import mapping or a schedule uses as its account", async () => {
    const g = await makeGroup();
    const ba = g.pt.banks[1];
    const gl = (await db.bankAccount.findUniqueOrThrow({ where: { id: ba.id } })).accountId;
    const other = (await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code: "2110" } })).id;
    await db.sourceAccount.create({ data: { firmId: g.firm.id, clientId: g.client.id, entityId: g.pt.entity.id, code: "1-1000", name: "Kas Bank", accountId: gl } });
    await db.adjustmentSchedule.create({ data: { firmId: g.firm.id, clientId: g.client.id, entityId: g.pt.entity.id, kind: "AMORTIZATION", memo: "Sewa", debitAccountId: gl, creditAccountId: other, amount: 1200n, months: 12, startYear: 2026, startMonth: 9 } });
    expect(labels(await bankUsage(g, ba.id))).toEqual(["pemetaan akun dari impor buku besar", "jadwal penyesuaian"]);
    await expect(removeBankAccount(db, { ...ids(g), bankAccountId: ba.id })).rejects.toThrow("Sudah ada 1 pemetaan akun dari impor buku besar, 1 jadwal penyesuaian.");
    expect(await db.bankAccount.count()).toBe(3);
  });

  it("if data lands between the check and the delete, the foreign keys stop it and it says so (nothing is cascaded)", async () => {
    const g = await booked(); // the BCA account has statements, rows and journal lines
    const before = await snapshot(g);
    // A transaction whose usage query reads "empty", as it would a moment before a concurrent import committed.
    const blind = (tx: object) => new Proxy(tx, { get: (t, k) => (k === "$queryRaw" ? async () => [] : Reflect.get(t, k)) });
    const racing = new Proxy(db, {
      get: (target, key) => (key === "$transaction" ? (fn: (tx: unknown) => unknown, opts?: object) => (target.$transaction as (f: unknown, o?: object) => unknown)((tx: object) => fn(blind(tx)), opts) : Reflect.get(target, key)),
    });
    await expect(removeBankAccount(racing as typeof db, { ...ids(g), bankAccountId: g.pt.banks[0].id })).rejects.toThrow("Rekening ini baru saja dipakai (ada data yang masuk saat dihapus), jadi tidak dihapus. Muat ulang halaman.");
    expect(await snapshot(g)).toEqual(before);
    expect(await db.auditEvent.count()).toBe(0);
  });
});

describe("remove a company or owner", () => {
  beforeEach(resetDb);

  it("removes an empty one with its empty bank accounts and their GL accounts, leaving the other books untouched", async () => {
    const g = await makeGroup();
    const extra = await addEntity(db, g.firm.id, g.client.id, { name: "CV Salah Input", shortName: "CV Salah", kind: "CV", npwp: "", banks: [{ bank: "BCA", number: "8888888888", label: "", isOverdraft: false }] });
    const glBefore = await db.account.count({ where: { clientId: g.client.id } });
    expect(await entityUsage(g, extra.id)).toEqual([]);
    expect(await removeEntity(db, { ...ids(g), entityId: extra.id })).toEqual({ name: "CV Salah Input", bankAccounts: 1 });
    expect(await db.entity.findUnique({ where: { id: extra.id } })).toBeNull();
    expect(await db.bankAccount.count({ where: { number: "8888888888" } })).toBe(0);
    // Its bank's GL account and its own intercompany account (unused) go with it.
    expect(await db.account.count({ where: { clientId: g.client.id } })).toBe(glBefore - 2);
    expect(await db.entity.count({ where: { clientId: g.client.id } })).toBe(2);
    expect(await db.auditEvent.findFirstOrThrow({ where: { subject: `entity:${extra.id}` } })).toMatchObject({ summary: "CV Salah Input dihapus beserta 1 rekening kosong", entityId: extra.id });
  });

  it("also clears the control notes it had, and nothing else", async () => {
    const g = await makeGroup();
    const extra = await addEntity(db, g.firm.id, g.client.id, { name: "CV Kosong", shortName: "CV K", kind: "CV", npwp: "", banks: [] });
    const period = await db.period.create({ data: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 8 } });
    await db.controlAck.createMany({ data: [{ periodId: period.id, controlKey: `sanity:${extra.id}`, note: "cek" }, { periodId: period.id, controlKey: `sanity:${g.pt.entity.id}`, note: "cek" }] });
    await removeEntity(db, { ...ids(g), entityId: extra.id });
    expect((await db.controlAck.findMany()).map((a) => a.controlKey)).toEqual([`sanity:${g.pt.entity.id}`]);
  });

  it("a note on a control in a month already closed keeps it: the close record stays whole", async () => {
    const g = await makeGroup();
    const extra = await addEntity(db, g.firm.id, g.client.id, { name: "CV Tutup", shortName: "CV T", kind: "CV", npwp: "", banks: [{ bank: "BCA", number: "8888888888", label: "", isOverdraft: false }] });
    const bank = await db.bankAccount.findFirstOrThrow({ where: { entityId: extra.id } });
    const july = await db.period.create({ data: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 7, status: "LOCKED", lockedAt: new Date() } });
    await db.controlAck.create({ data: { periodId: july.id, controlKey: `continuity:${bank.id}`, note: "Rekening belum aktif" } });
    expect(labels(await bankUsage(g, bank.id))).toEqual(["catatan kontrol di bulan yang sudah ditutup"]);
    await expect(removeBankAccount(db, { ...ids(g), bankAccountId: bank.id })).rejects.toThrow("Sudah ada 1 catatan kontrol di bulan yang sudah ditutup.");
    await expect(removeEntity(db, { ...ids(g), entityId: extra.id })).rejects.toThrow(/catatan kontrol di bulan yang sudah ditutup/);
    expect(await db.controlAck.count()).toBe(1);
  });

  it("refuses one with posted entries — even only a Saldo Awal — and lists what is there; nothing changes", async () => {
    const g = await booked();
    const before = await snapshot(g);
    const message = await messageOf(removeEntity(db, { ...ids(g), entityId: g.pt.entity.id }));
    expect(message).toMatch(/^Sudah ada \d+ jurnal \(termasuk saldo awal\), 2 mutasi bank, 1 impor rekening koran\./);
    expect(message).toContain("koreksi lewat Jurnal Penyesuaian");
    // The owner has bank rows but no journal of its own.
    expect(await messageOf(removeEntity(db, { ...ids(g), entityId: g.owner.entity.id }))).toMatch(/1 mutasi bank/);
    expect(await snapshot(g)).toEqual(before);
  });

  it("refuses one only a Saldo Awal points to", async () => {
    const g = await makeGroup();
    await postOpening(db, { clientId: g.client.id, entityId: g.owner.entity.id, date: dateOnly(2026, 7, 31), lines: [{ accountCode: "1103", debit: "1000000", credit: "0" }, { accountCode: "3100", debit: "0", credit: "1000000" }] });
    expect((await entityUsage(g, g.owner.entity.id))[0]).toEqual({ label: "jurnal (termasuk saldo awal)", n: 1 });
    await expect(removeEntity(db, { ...ids(g), entityId: g.owner.entity.id })).rejects.toThrow(/jurnal \(termasuk saldo awal\)/);
  });

  it("refuses one with a register, a tax record or a report note, however empty its books are", async () => {
    const g = await makeGroup();
    const extra = await addEntity(db, g.firm.id, g.client.id, { name: "CV Pajak", shortName: "CV P", kind: "CV", npwp: "", banks: [] });
    await db.taxYear.create({ data: { firmId: g.firm.id, clientId: g.client.id, entityId: g.owner.entity.id, year: 2026 } });
    await db.reportComment.create({ data: { firmId: g.firm.id, clientId: g.client.id, entityId: extra.id, year: 2026, month: 8, text: "Catatan", source: "ACCOUNTANT", facts: {} } });
    await db.taxInstalment.create({ data: { firmId: g.firm.id, clientId: g.client.id, entityId: extra.id, from: dateOnly(2026, 1, 1), amount: 100n } });
    expect(blockedReason("entity", await entityUsage(g, g.owner.entity.id))).toMatch(/^Sudah ada 1 tahun pajak\./);
    expect(blockedReason("entity", await entityUsage(g, extra.id))).toMatch(/^Sudah ada 1 catatan laporan, 1 angsuran PPh 25\./);
    await expect(removeEntity(db, { ...ids(g), entityId: g.owner.entity.id })).rejects.toThrow(/tahun pajak/);
    await expect(removeEntity(db, { ...ids(g), entityId: extra.id })).rejects.toThrow(/catatan laporan/);
    expect(await db.entity.count()).toBe(3);
  });

  it("refuses one a draft ledger import is mapped to (posting it would need that company)", async () => {
    const g = await makeGroup();
    const extra = await addEntity(db, g.firm.id, g.client.id, { name: "CV Draf", shortName: "CV D", kind: "CV", npwp: "", banks: [] });
    await db.ledgerImport.create({ data: { firmId: g.firm.id, clientId: g.client.id, fileName: "gl.xlsx", fileHash: "h", sheetName: "GL", mode: "LEDGER", periodStart: dateOnly(2026, 1, 1), periodEnd: dateOnly(2026, 1, 31), rowCount: 1, data: { entities: { "": extra.id } } } });
    expect(labels(await entityUsage(g, extra.id))).toEqual(["draf impor buku besar"]);
    await expect(removeEntity(db, { ...ids(g), entityId: extra.id })).rejects.toThrow("Sudah ada 1 draf impor buku besar.");
  });

  it("refuses one whose empty-looking bank account is used elsewhere (a rule filing to its code)", async () => {
    const g = await makeGroup();
    const extra = await addEntity(db, g.firm.id, g.client.id, { name: "CV Rekening", shortName: "CV R", kind: "CV", npwp: "", banks: [{ bank: "BCA", number: "8888888888", label: "", isOverdraft: false }] });
    const code = (await db.bankAccount.findFirstOrThrow({ where: { entityId: extra.id }, include: { account: true } })).account.code;
    await db.rule.create({ data: { firmId: g.firm.id, clientId: g.client.id, pattern: "SETOR", accountCode: code } });
    await expect(removeEntity(db, { ...ids(g), entityId: extra.id })).rejects.toThrow("Sudah ada 1 aturan klasifikasi ke akun ini.");
  });

  it("never removes the client's last entity", async () => {
    const f = await db.$transaction((tx) => createFirm(tx, "KJA Satu"));
    const one = await db.$transaction((tx) => createClient(tx, f.id, { name: "Klien Satu", industry: "jasa", entities: [{ name: "PT Satu", shortName: "PT Satu", kind: "PT", banks: [] }] }));
    await expect(removeEntity(db, { firmId: f.id, clientId: one.client.id, entityId: one.entities[0].entity.id })).rejects.toThrow("Klien harus punya minimal satu perusahaan atau pemilik.");
    expect(await db.entity.count({ where: { clientId: one.client.id } })).toBe(1);
  });
});

describe("concurrent writes (review of #153)", () => {
  beforeEach(resetDb);

  /** `db` whose next transaction first lets `meanwhile` commit on another connection: what a second member does a moment earlier. */
  const after = (meanwhile: () => Promise<unknown>) =>
    new Proxy(db, {
      get: (target, key) =>
        key === "$transaction" ? async (fn: unknown, opts?: object) => (await meanwhile(), (target.$transaction as (f: unknown, o?: object) => unknown)(fn, opts)) : Reflect.get(target, key),
    }) as typeof db;
  const orphans = () => db.account.count({ where: { isBank: true, bankAccounts: { none: {} } } });

  it("two admins removing the last two companies at once: one is removed, the client keeps the other", async () => {
    const g = await makeGroup();
    const results = await Promise.allSettled([removeEntity(db, { ...ids(g), entityId: g.pt.entity.id }), removeEntity(db, { ...ids(g), entityId: g.owner.entity.id })]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toContain("Klien harus punya minimal satu perusahaan atau pemilik.");
    expect(await db.entity.count({ where: { clientId: g.client.id } })).toBe(1);
    expect(await orphans()).toBe(0);
  });

  it("a rekening added while a company is being removed goes with it, GL account included — none is left behind", async () => {
    const g = await makeGroup();
    const extra = await addEntity(db, g.firm.id, g.client.id, { name: "CV Baru", shortName: "CV B", kind: "CV", npwp: "", banks: [] });
    const racing = after(() => addBankAccount(db, g.firm.id, g.client.id, extra.id, { bank: "BCA", number: "7777000011", label: "", isOverdraft: false }));
    expect(await removeEntity(racing, { ...ids(g), entityId: extra.id })).toEqual({ name: "CV Baru", bankAccounts: 1 });
    expect(await db.bankAccount.count({ where: { number: "7777000011" } })).toBe(0);
    expect(await orphans()).toBe(0);
  });

  it("a statement imported just before a number change keeps the number", async () => {
    const g = await makeGroup();
    const ba = g.pt.banks[1];
    const racing = after(() => importStatement(db, { bankAccountId: ba.id, fileName: "mandiri.csv", data: csv("05/08/2026;SETORAN;0;1000000;1000000"), provider: null }));
    expect(await fieldsOf(updateBankAccount(racing, { ...ids(g), bankAccountId: ba.id, label: "Mandiri Giro", bank: "MANDIRI", number: "9999999999" }))).toHaveProperty(["bank.number"]);
    expect((await db.bankAccount.findUniqueOrThrow({ where: { id: ba.id } })).number).toBe("2222222222");
  });
});

describe("tenant isolation", () => {
  beforeEach(resetDb);

  it("never renames, edits or removes another firm's (or another client's) companies and accounts", async () => {
    const g = await makeGroup(), other = await makeGroup();
    const before = await snapshot(other);
    const foreign = { entityId: other.pt.entity.id, bankAccountId: other.pt.banks[1].id };
    // Right ids, wrong client / firm.
    expect(await fieldsOf(renameEntity(db, { ...ids(g), entityId: foreign.entityId, name: "Diambil alih", shortName: "X", npwp: "" }))).toEqual({ entity: "Perusahaan tidak ditemukan di klien ini." });
    expect(await fieldsOf(updateBankAccount(db, { ...ids(g), bankAccountId: foreign.bankAccountId, label: "Diambil alih", bank: "BCA", number: "1111111111" }))).toEqual({ bankAccountId: "Rekening tidak ditemukan di klien ini." });
    await expect(removeBankAccount(db, { ...ids(g), bankAccountId: foreign.bankAccountId })).rejects.toThrow("Rekening tidak ditemukan di klien ini.");
    await expect(removeEntity(db, { ...ids(g), entityId: foreign.entityId })).rejects.toThrow("Perusahaan tidak ditemukan di klien ini.");
    // The firm of g with the client of other.
    await expect(removeEntity(db, { firmId: g.firm.id, clientId: other.client.id, entityId: foreign.entityId })).rejects.toThrow("Perusahaan tidak ditemukan di klien ini.");
    expect(await snapshot(other)).toEqual(before);
    expect((await db.entity.findUniqueOrThrow({ where: { id: foreign.entityId } })).name).toBe("PT Uji Sejahtera");
  });
});
