import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { db, makeGroup, resetDb } from "../helpers";
import { makePdf, smbcCombinedPdf, table } from "../pdf-fixture";
import { checkFile } from "@/lib/inbox/check";
import { batchItems, confirmBatch, planBatch, unlockBatch } from "@/lib/inbox/plan";
import { DRAFT_DISCARDED, LEDGER_POSTED, STATEMENTS_REMOVED } from "@/lib/inbox/live";
import { removeStatementImport } from "@/lib/imports/remove";
import { processNext, STALE_CLAIM_MS } from "@/lib/inbox/process";
import { addBankAccount } from "@/lib/onboarding";
import { MockProvider } from "@/lib/ai/provider";
import { toBcaCsv } from "@/lib/demo/writers";

const SECRET = "inbox-process-test-secret-32-characters-long";
beforeEach(async () => {
  vi.stubEnv("SETTINGS_SECRET", SECRET);
  await resetDb();
});
afterEach(() => vi.unstubAllEnvs());

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
/** BCA Giro of PT Uji: each month opens where the last closed (1.000.000 + 500.000 − 200.000 per month). */
const bcaCsv = (month: number, accountNumber = "1111111111") =>
  Buffer.from(toBcaCsv({ bank: "BCA", accountNumber, holder: "PT Uji Sejahtera", year: 2026, month, opening: 1_000_000n + 300_000n * BigInt(month - 1), rows: [{ date: d(2026, month, 5), description: "SETORAN TUNAI", amount: 500_000n }, { date: d(2026, month, 9), description: "PEMBELIAN PAKAN", amount: -200_000n }] }));

const mandiriPdf = (month: number, password: string) => {
  const mm = String(month).padStart(2, "0");
  return makePdf(
    [
      [
        ...table(800, [[[40, "PT Bank Mandiri (Persero) Tbk"]], [[40, "Nomor Rekening : 2222222222"]], [[40, `Periode : 01/${mm}/2026 - 30/${mm}/2026`]]]),
        ...table(740, [
          [[40, "Tanggal"], [130, "Keterangan"], [360, "Debit"], [440, "Kredit"], [520, "Saldo"]],
          [[40, `01/${mm}/2026`], [130, "SALDO AWAL"], [510, "0,00"]],
          [[40, `04/${mm}/2026`], [130, "TRANSFER DARI PT MITRA UNGGAS"], [430, "20.000.000,00"], [510, "20.000.000,00"]],
        ]),
      ],
    ],
    { userPassword: password },
  );
};

async function ledgerXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("GL");
  for (const r of [
    ["Entity", "Entry Date", "Account Code", "Account Name", "Currency", "Debit", "Credit", "Notes"],
    ["PT Uji", d(2026, 1, 31), "10000", "Kas", "IDR", 1000, 0, ""],
    ["PT Uji", d(2026, 1, 31), "31001", "Modal Saham", "IDR", 0, 1000, ""],
  ])
    ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function setup() {
  const g = await makeGroup();
  const scope = { firmId: g.firm.id, clientId: g.client.id, batchId: "b1" };
  const check = (name: string, data: Buffer, password?: string) => checkFile(db, { ...scope, name, data, password, actorId: "m1" });
  const provider = new MockProvider();
  const next = () => processNext(db, { ...scope, actorId: null, provider });
  /** Processes until nothing is left; the file names in the order they were processed. */
  const drain = async () => {
    const done = [];
    for (let r = await next(); r.item; r = await next()) done.push(r);
    return done;
  };
  return { ...g, scope, check, provider, next, drain };
}

/** Every journal entry balances (the database refuses otherwise; this says which one). */
async function expectBalanced() {
  const lines = await db.journalLine.groupBy({ by: ["entryId"], _sum: { debit: true, credit: true } });
  expect(lines.length).toBeGreaterThan(0);
  for (const l of lines) expect(l._sum.debit).toBe(l._sum.credit);
}

describe("Unggah: book the drop file by file", () => {
  it("books bank files oldest period first, then stages the ledger as a draft, without asking the AI", async () => {
    const g = await setup();
    await g.check("gl.xlsx", await ledgerXlsx());
    await g.check("bca-feb.csv", bcaCsv(2));
    await g.check("bca-jan.csv", bcaCsv(1));
    await g.check("catatan.md", Buffer.from("# Catatan\n"));

    const first = await g.next();
    expect(first.item).toMatchObject({ fileName: "bca-jan.csv", status: "BOOKED", message: "Dibukukan ke BCA ·1111 · Januari 2026 · 2 baris" });
    expect(first.remaining).toBe(2);
    const rest = await g.drain();
    expect(rest.map((r) => [r.item!.fileName, r.item!.status])).toEqual([["bca-feb.csv", "BOOKED"], ["gl.xlsx", "DRAFT"]]);
    expect(rest[1].item).toMatchObject({ message: "Draf buku besar siap dipetakan." });
    expect(rest.at(-1)!.remaining).toBe(0);

    const imports = await db.statementImport.findMany({ orderBy: { periodStart: "asc" } });
    expect(imports.map((i) => i.id)).toEqual([first.item!.statementImportIds[0], rest[0].item!.statementImportIds[0]]);
    expect(imports.every((i) => i.evidenceVersionId)).toBe(true);
    const ledger = await db.ledgerImport.findUniqueOrThrow({ where: { id: rest[1].item!.ledgerImportId! } });
    expect(ledger).toMatchObject({ status: "DRAFT", clientId: g.client.id });
    await expectBalanced();
    // The rule books PAKAN; the deposit waits in Review on a simple guess for the background run — no AI call inside the drop.
    expect(g.provider.calls).toBe(0);
    expect(await db.bankTransaction.count({ where: { status: "NEEDS_REVIEW", method: "HEURISTIC" } })).toBe(2);
    expect(await db.bankTransaction.count({ where: { method: "RULE" } })).toBe(2);
    // The note was never booked; nothing else is left.
    const plan = await planBatch(db, g.scope);
    expect(plan.items.find((i) => i.fileName === "catatan.md")?.status).toBe("KEPT");
    expect(await g.next()).toEqual({ item: null, remaining: 0 });
  });

  it("books every section of a combined file that has a rekening, the new ones after the card", async () => {
    const g = await setup();
    await addBankAccount(db, g.firm.id, g.client.id, g.pt.entity.id, { bank: "SMBC", number: "90022152088", label: "" });
    await g.check("smbc-mei.pdf", smbcCombinedPdf());
    // Waits for the new rekening: nothing to process yet.
    expect(await g.next()).toEqual({ item: null, remaining: 0 });

    const { plan, errors } = await confirmBatch(db, { ...g.scope, accounts: [{ bank: "SMBC", number: "05243002879", target: { entityId: g.pt.entity.id } }], numberless: [] });
    expect(errors).toEqual([]);
    expect(plan.ready).toBe(true);
    const { item } = await g.next();
    expect(item!.status).toBe("BOOKED");
    expect(item!.statementImportIds).toHaveLength(2);
    expect(item!.message).toBe("Dibukukan ke SMBC ·2088 · Mei 2026 · 2 baris\nDibukukan ke SMBC ·2879 · Mei 2026 · 2 baris\nSMBC ·4251 (JPY): rekening valas belum bisa dibukukan");
    const accounts = await db.statementImport.findMany({ select: { bankAccount: { select: { number: true, isOverdraft: true } } } });
    expect(accounts.map((a) => a.bankAccount).sort((a, b) => a.number.localeCompare(b.number))).toEqual([{ number: "05243002879", isOverdraft: true }, { number: "90022152088", isOverdraft: false }]);
    await expectBalanced();
  });

  it("gives a failing file its own reason and still books the next one", async () => {
    const g = await setup();
    await db.period.create({ data: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 1, status: "LOCKED" } });
    await g.check("bca-jan.csv", bcaCsv(1));
    await g.check("bca-feb.csv", bcaCsv(2));
    const done = await g.drain();
    expect(done.map((r) => [r.item!.fileName, r.item!.status])).toEqual([["bca-jan.csv", "FAILED"], ["bca-feb.csv", "BOOKED"]]);
    expect(done[0].item!.message).toBe("Periode Januari 2026 sudah ditutup. Buka periode dulu atau pilih file lain.");
    expect(done[0].item!.statementImportIds).toEqual([]);
    expect(await db.statementImport.count()).toBe(1);
  });

  it("books a locked PDF with the client's keyring and a numberless file into the chosen rekening", async () => {
    const g = await setup();
    await g.check("mandiri-agu.pdf", mandiriPdf(8, "rahasia"));
    const generic = await g.check("mutasi.csv", Buffer.from(["Tanggal,Keterangan,Debit,Kredit,Saldo", "01/07/2026,SALDO AWAL,,,1000000", "06/07/2026,SETORAN,,500000,1500000"].join("\n")));
    let plan = await unlockBatch(db, { ...g.scope, password: "rahasia", actorId: "m1" });
    expect(plan.numberless.map((n) => n.itemId)).toEqual([generic.id]);
    plan = (await confirmBatch(db, { ...g.scope, accounts: [], numberless: [{ itemId: generic.id, bankAccountId: g.owner.banks[0].id }] })).plan;
    expect(plan.ready).toBe(true);

    const done = await g.drain();
    expect(done.map((r) => [r.item!.fileName, r.item!.status, r.item!.message])).toEqual([
      ["mutasi.csv", "BOOKED", "Dibukukan ke BRI ·3333 · Juli 2026 · 1 baris"],
      ["mandiri-agu.pdf", "BOOKED", "Dibukukan ke Mandiri ·2222 · Agustus 2026 · 1 baris"],
    ]);
    const imports = await db.statementImport.findMany({ select: { bankAccountId: true } });
    expect(imports.map((i) => i.bankAccountId).sort()).toEqual([g.owner.banks[0].id, g.pt.banks[1].id].sort());
    await expectBalanced();
  });

  it("books a locked PDF with the drop's password when the server can't keep it (no SETTINGS_SECRET)", async () => {
    vi.stubEnv("SETTINGS_SECRET", "");
    const g = await setup();
    await g.check("mandiri-agu.pdf", mandiriPdf(8, "rahasia"));
    const plan = await unlockBatch(db, { ...g.scope, password: "rahasia", actorId: "m1" });
    expect(plan.needsPassword).toEqual([]);
    expect(await db.clientPdfPassword.count()).toBe(0);
    // The page offers the passwords that opened this drop's files with every booking call.
    const r = await processNext(db, { ...g.scope, actorId: null, provider: g.provider, passwords: ["salah", "rahasia"] });
    expect([r.item!.status, r.item!.message]).toEqual(["BOOKED", "Dibukukan ke Mandiri ·2222 · Agustus 2026 · 1 baris"]);
    await expectBalanced();
  });

  it("lines follow the books: a removed import or discarded draft is a kept document again, a posted draft is booked", async () => {
    const g = await setup();
    await g.check("gl.xlsx", await ledgerXlsx());
    await g.check("bca-jan.csv", bcaCsv(1));
    const [bank, ledger] = await g.drain();
    const admin = await db.firmMember.create({ data: { firmId: g.firm.id, userId: crypto.randomUUID(), email: `admin-${crypto.randomUUID()}@example.test`, name: "Admin Uji", role: "ADMIN" } });
    await removeStatementImport(db, { clientId: g.client.id, importId: bank.item!.statementImportIds[0], reason: "File salah rekening", actor: { id: admin.id, role: "ADMIN" } });
    await db.ledgerImport.update({ where: { id: ledger.item!.ledgerImportId! }, data: { status: "POSTED" } });
    const status = async () => Object.fromEntries((await batchItems(db, g.scope)).items.map((i) => [i.fileName, [i.status, i.message]]));
    expect(await status()).toEqual({ "bca-jan.csv": ["KEPT", STATEMENTS_REMOVED], "gl.xlsx": ["BOOKED", LEDGER_POSTED] });

    await db.ledgerImport.update({ where: { id: ledger.item!.ledgerImportId! }, data: { status: "DRAFT" } });
    await db.ledgerImport.delete({ where: { id: ledger.item!.ledgerImportId! } });
    expect((await status())["gl.xlsx"]).toEqual(["KEPT", DRAFT_DISCARDED]);
    // The plan reads the same: nothing to book again, nothing to ask.
    expect((await planBatch(db, g.scope)).items.map((i) => i.status).sort()).toEqual(["KEPT", "KEPT"]);
  });

  it("says when a file was already booked and when its balance has a gap", async () => {
    const g = await setup();
    await g.check("bca-jan.csv", bcaCsv(1));
    await g.drain();
    const gap = Buffer.from(toBcaCsv({ bank: "BCA", accountNumber: "1111111111", holder: "PT Uji", year: 2026, month: 3, opening: 1_000_000n, rows: [{ date: d(2026, 3, 5), description: "SETORAN", amount: 500_000n }] }).replace("1,500,000.00", "1,400,000.00"));
    await checkFile(db, { ...g.scope, batchId: "b2", name: "bca-jan.csv", data: bcaCsv(1) });
    await checkFile(db, { ...g.scope, batchId: "b2", name: "bca-mar.csv", data: gap });
    const again = await processNext(db, { ...g.scope, batchId: "b2", provider: null });
    expect(again.item).toMatchObject({ status: "BOOKED", message: "Sudah dibukukan sebelumnya ke BCA ·1111 · Januari 2026 (2 baris sama, dilewati)" });
    const gapped = await processNext(db, { ...g.scope, batchId: "b2", provider: null });
    expect(gapped.item?.message).toMatch(/ada celah saldo$/);
  });
});

describe("Unggah: one file, one taker", () => {
  it("two parallel calls on a two-file drop book each file once (same client, same new month)", async () => {
    const g = await setup();
    await g.check("bca-jan.csv", bcaCsv(1));
    await g.check("bri-jan.csv", Buffer.from(toBcaCsv({ bank: "BCA", accountNumber: "3333333333", holder: "Andi Wijaya", year: 2026, month: 1, opening: 0n, rows: [{ date: d(2026, 1, 7), description: "SETORAN", amount: 100_000n }] })));
    const [a, b] = await Promise.all([g.next(), g.next()]);
    expect([a.item?.status, b.item?.status]).toEqual(["BOOKED", "BOOKED"]);
    expect(a.item!.id).not.toBe(b.item!.id);
    // Only the call that finished last sees nothing left (a claimed file still counts).
    expect(Math.min(a.remaining, b.remaining)).toBe(0);
    expect(await db.statementImport.count()).toBe(2);
    expect(await g.next()).toEqual({ item: null, remaining: 0 });
    await expectBalanced();
  });

  it("leaves a claimed file alone, and takes it back once the claim is older than 10 minutes", async () => {
    const g = await setup();
    const item = await g.check("bca-jan.csv", bcaCsv(1));
    const claim = (ago: number) => db.$executeRaw`UPDATE "UploadItem" SET status = 'PROCESSING', "updatedAt" = ${new Date(Date.now() - ago)} WHERE id = ${item.id}`;
    await claim(60_000);
    expect(await g.next()).toEqual({ item: null, remaining: 1 });
    expect(await db.statementImport.count()).toBe(0);

    await claim(STALE_CLAIM_MS + 60_000);
    const { item: booked, remaining } = await g.next();
    expect(booked).toMatchObject({ id: item.id, status: "BOOKED" });
    expect(remaining).toBe(0);
  });

  it("an unexpected error still ends the file FAILED with the generic message, and the next file is booked", async () => {
    const g = await setup();
    await g.check("bca-jan.csv", bcaCsv(1));
    await g.check("bca-feb.csv", bcaCsv(2));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // The database fails once while the first file is being booked.
    let failures = 1;
    const flaky = new Proxy(db, {
      get(target, prop) {
        if (prop === "bankAccount" && failures > 0) {
          failures--;
          return { findMany: async () => Promise.reject(new Error("connection reset")) };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const first = await processNext(flaky, { ...g.scope, provider: null });
    expect(first.item).toMatchObject({ fileName: "bca-jan.csv", status: "FAILED", message: "Terjadi kesalahan tak terduga. Coba lagi." });
    expect(first.remaining).toBe(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect((await g.next()).item).toMatchObject({ fileName: "bca-feb.csv", status: "BOOKED" });
    expect(await db.uploadItem.count({ where: { status: "PROCESSING" } })).toBe(0);
  });
});
