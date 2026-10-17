import { beforeEach, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { askWorkspace, getWorkspaceOverview, resolveWorkspaceScope, workspaceQuestionIntent } from "@/lib/workspace";
import { postJournal } from "@/lib/ledger/post";
import { dateOnly } from "@/lib/format";
import { createIntake } from "@/lib/evidence/store";
import { approvalCounts } from "@/lib/approvals/queue";
import { createSchedule, postAllDue } from "@/lib/adjust/schedules";
import { addMember } from "../members";
import { checklistMonth } from "@/lib/checklist/view";
import { acceptDefault } from "@/lib/checklist/write";

beforeEach(resetDb);

async function sale(g: Awaited<ReturnType<typeof makeGroup>>, entityId: string, amount: bigint) {
  const bank = (await db.bankAccount.findFirstOrThrow({ where: { entityId } })).accountId;
  const revenue = await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code: "4100" } } });
  return db.$transaction(tx => postJournal(tx, { entityId, date: dateOnly(2026, 8, 12), kind: "ADJUSTMENT", memo: "Synthetic sale", lines: [{ accountId: bank, debit: amount }, { accountId: revenue.id, credit: amount }] }));
}

it("rejects foreign client/entity ids and resolves only the session firm's picker", async () => {
  const g = await makeGroup(), foreign = await makeGroup();
  for (const scope of [`client:${foreign.client.id}`, `entity:${foreign.pt.entity.id}`, "bad", "entity:"]) {
    await expect(resolveWorkspaceScope(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope, period: "2026-08" })).rejects.toThrow(/Cakupan/);
  }
  const scope = await resolveWorkspaceScope(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope: `entity:${g.pt.entity.id}`, period: "2026-08" });
  expect(scope.entityIds).toEqual([g.pt.entity.id]);
  expect(scope.clientIds).toEqual([g.client.id]);
  expect(scope.clients.map(c => c.id)).toEqual([g.client.id]);
});

it("derives exact per-company figures without mixing currencies or inventing data", async () => {
  const g = await makeGroup();
  await db.entity.update({ where: { id: g.owner.entity.id }, data: { functionalCurrency: "USD" } });
  await sale(g, g.pt.entity.id, 9_007_199_254_740_993n);
  await sale(g, g.owner.entity.id, 2500n);
  const data = await getWorkspaceOverview(db, { firmId: g.firm.id, clientIds: "ALL" }, { period: "2026-08" });
  expect(data.entities.find(e => e.id === g.pt.entity.id)).toMatchObject({ revenue: "9007199254740993", profit: "9007199254740993", cash: "9007199254740993", currency: "IDR", hasActivity: true });
  expect(data.entities.find(e => e.id === g.owner.entity.id)).toMatchObject({ revenue: "2500", currency: "USD" });
  const empty = await getWorkspaceOverview(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope: `entity:${g.pt.entity.id}`, period: "2026-09" });
  expect(empty.entities[0]).toMatchObject({ revenue: null, profit: null, hasActivity: false, hasBooks: true, cash: "9007199254740993" });
  expect(empty.clients[0].state).toBe("EMPTY");
  const before = await getWorkspaceOverview(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope: `entity:${g.pt.entity.id}`, period: "2026-07" });
  expect(before.entities[0]).toMatchObject({ cash: null, hasBooks: false });
});

it("snapshot answers retain original entity and period; citations point to matching books", async () => {
  const g = await makeGroup();
  await sale(g, g.pt.entity.id, 1500n);
  await sale(g, g.owner.entity.id, 100n);
  const input = { scope: `entity:${g.pt.entity.id}`, period: "2026-08", question: "Berapa laba bulan ini?" };
  const answer = await askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, input);
  input.scope = `entity:${g.owner.entity.id}`;
  input.period = "2026-09";
  expect(answer.scope).toMatchObject({ key: `entity:${g.pt.entity.id}`, period: "2026-08" });
  expect(answer.rows).toHaveLength(1);
  expect(answer.rows[0].label).toContain(g.pt.entity.name);
  expect(answer.rows[0].value).toContain("1.500");
  const source = new URL(answer.citations[0].href, "https://buku.example");
  expect(source.searchParams.get("entity")).toBe(g.pt.entity.id);
  expect(source.searchParams.get("period")).toBe("2026-08");
  const account = await askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope: `entity:${g.pt.entity.id}`, period: "2026-08", question: "Berapa saldo akun 4100?" });
  expect(account.rows[0].value).toContain("1.500 Kredit");
  expect(account.citations[0].href).toContain("/ledger/4100?");
  const close = await askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, { ...input, question: "Siap tutup buku?" });
  expect(close.text).toContain("seluruh grup/klien");
  expect(close.limitations.join(" ")).toContain("klien induk");
  const unsupported = await askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, { ...input, question: "Buat undangan baru" });
  expect(unsupported.text).toContain("belum didukung");
  expect(unsupported.rows).toEqual([]);
});

it("returns only confirmed entity/period source passages with inspectable version citations", async () => {
  const g = await makeGroup(), foreign = await makeGroup();
  async function evidence(firmId: string, clientId: string, entityId: string, name: string) {
    const intake = await createIntake(db, firmId, clientId);
    const document = await db.evidenceDocument.create({ data: { firmId, intakeId: intake.id, sourceKey: name, name, path: name, mimeType: "text/plain", status: "READY" } });
    const version = await db.evidenceVersion.create({ data: { firmId, documentId: document.id, hash: name, name, size: 2, data: Buffer.from("ok"), extracted: true } });
    await db.evidenceDocument.update({ where: { id: document.id }, data: { currentVersionId: version.id } });
    await db.evidencePassage.create({ data: { firmId, versionId: version.id, unitKey: "page1", locator: "Halaman 1", text: `${name}: persediaan 123.000 menurut laporan sumber` } });
    await db.evidenceSelection.create({ data: { firmId, intakeId: intake.id, versionId: version.id, unitKey: "page1", role: "REFERENCE", entityId, confirmed: true, periodStart: "2026-08-01", periodEnd: "2026-08-31" } });
    return version;
  }
  const included = await evidence(g.firm.id, g.client.id, g.pt.entity.id, "Laporan PT");
  await evidence(g.firm.id, g.client.id, g.owner.entity.id, "Laporan pemilik");
  await evidence(foreign.firm.id, foreign.client.id, foreign.pt.entity.id, "Laporan asing");
  const input = { scope: `entity:${g.pt.entity.id}`, period: "2026-08", question: "Cari dokumen persediaan" };
  const answer = await askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, input);
  expect(answer.rows).toHaveLength(1);
  expect(answer.rows[0].value).toContain("Laporan PT");
  expect(answer.text).toContain("belum merupakan saldo buku");
  expect(answer.citations[0].href).toContain(`/documents/source/${included.id}`);
  expect(answer.citations[0].href).toContain("at=Halaman+1");
  expect((await askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, { ...input, period: "2026-09" })).rows).toEqual([]);
  expect(await db.journalEntry.count()).toBe(0);
  expect(await db.aiUsage.count()).toBe(0);
});

it("includes undated company context with an explicit non-historical label", async () => {
  const g = await makeGroup(), intake = await createIntake(db, g.firm.id, g.client.id);
  const document = await db.evidenceDocument.create({ data: { firmId: g.firm.id, intakeId: intake.id, sourceKey: "profile", name: "Profil", path: "Profil", mimeType: "text/plain", status: "READY" } });
  const version = await db.evidenceVersion.create({ data: { firmId: g.firm.id, documentId: document.id, hash: "profile", name: "Profil", size: 2, data: Buffer.from("ok") } });
  await db.evidenceDocument.update({ where: { id: document.id }, data: { currentVersionId: version.id } });
  await db.evidenceFact.create({ data: { firmId: g.firm.id, intakeId: intake.id, versionId: version.id, unitKey: "profile", locator: "Halaman 1", key: "industry", value: "Distribusi pangan", status: "CONFIRMED" } });
  await db.evidenceSelection.create({ data: { firmId: g.firm.id, intakeId: intake.id, versionId: version.id, unitKey: "profile", role: "CONTEXT", entityId: g.pt.entity.id, confirmed: true } });
  const answer = await askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope: `entity:${g.pt.entity.id}`, period: "2026-08", question: "Apa profil perusahaan ini?" });
  expect(answer.rows[0].value).toContain("Distribusi pangan");
  expect(answer.scope.period).toBe("2026-08");
  expect(answer.limitations.join(" ")).toContain("bukan posisi historis");
  expect(answer.citations[0].href).toContain(`answer=${answer.id}`);
  expect(answer.citations[0].href).toContain("#cited-source");
  const empty = await getWorkspaceOverview(db, { firmId: g.firm.id, clientIds: "ALL" }, { period: "2026-08" });
  expect(empty.tasks.some(task => task.id === `setup:${g.client.id}` && task.href.includes("/import?"))).toBe(true);
});

it("answers who was paid: bank lines by counterparty in the month, totals, accounts and ledger links", async () => {
  const g = await makeGroup();
  const bank = g.pt.banks[0];
  const imp = await db.statementImport.create({ data: { firmId: g.firm.id, bankAccountId: bank.id, fileName: "bca.pdf", format: "BCA", periodStart: dateOnly(2026, 6, 1), periodEnd: dateOnly(2026, 6, 30), openingBalance: 0n, closingBalance: 0n, rowCount: 3, continuityOk: true } });
  const line = (hash: string, day: number, description: string, amount: bigint, status: "REVIEWED" | "NEEDS_REVIEW", accountCode: string) =>
    db.bankTransaction.create({ data: { firmId: g.firm.id, entityId: g.pt.entity.id, bankAccountId: bank.id, importId: imp.id, date: dateOnly(2026, 6, day), description, merchantKey: "X", direction: amount < 0n ? "OUT" : "IN", amount, rowNumber: day, rawRow: "synthetic", hash, status, method: "MANUAL", confidence: 1, reason: "uji", accountCode, suggestedCode: "6190" } });
  await line("a", 3, "BI-FAST DB BIF TRANSFER KE 002 ALFI YANDRA KBB", -105_000_000n, "REVIEWED", "1190");
  await line("b", 10, "BI-FAST DB BIF TRANSFER KE 002 ALFI YANDRA KBB", -210_000_000n, "REVIEWED", "1190");
  await line("c", 25, "TRSF E-BANKING DB 2506/FTSCY/WS95051 152000000.00 Belifi ALFI YANDRA", -152_000_000n, "NEEDS_REVIEW", "1999");
  await line("d", 7, "TRSF E-BANKING CR bayar nota DINA PUSPITA", 70_475_000n, "REVIEWED", "4100");
  const a = await askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope: `client:${g.client.id}`, period: "2026-06", question: "Berapa total transfer BCA PT ke ALFI YANDRA bulan Juni dan dicatat ke akun apa?" });
  expect(a.text).toBe('3 mutasi bank dengan "ALFI YANDRA" pada Juni 2026. Per akun: 1190 (2×): keluar Rp 315.000.000; 1999 (1×): keluar Rp 152.000.000.');
  expect(a.rows).toHaveLength(3);
  expect(a.rows[2].value).toBe("Keluar Rp 152.000.000 → menunggu review (usulan 6190)");
  expect(a.citations.map((c) => c.href.split("?")[0])).toEqual([`/clients/${g.client.id}/ledger/1190`, `/clients/${g.client.id}/ledger/1999`]);
  const none = await askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope: `client:${g.client.id}`, period: "2026-07", question: "transfer ke ALFI YANDRA" });
  expect(none.text).toBe('Tidak ada mutasi bank dengan "ALFI YANDRA" pada Juli 2026 di cakupan ini.');
});

it("lists what to ask the client: bank lines still in Review up to the month, with their current guess", async () => {
  const g = await makeGroup();
  const bank = g.owner.banks[0];
  const imp = await db.statementImport.create({ data: { firmId: g.firm.id, bankAccountId: bank.id, fileName: "jenius.pdf", format: "SMBC", periodStart: dateOnly(2026, 5, 1), periodEnd: dateOnly(2026, 5, 31), openingBalance: 0n, closingBalance: 0n, rowCount: 3, continuityOk: true } });
  const line = (hash: string, day: number, description: string, amount: bigint, status: "REVIEWED" | "NEEDS_REVIEW", suggestedCode: string) =>
    db.bankTransaction.create({ data: { firmId: g.firm.id, entityId: g.owner.entity.id, bankAccountId: bank.id, importId: imp.id, date: dateOnly(2026, 5, day), description, merchantKey: "X", direction: amount < 0n ? "OUT" : "IN", amount, rowNumber: day, rawRow: "synthetic", hash, status, method: "HEURISTIC", confidence: 0.3, reason: "uji", accountCode: status === "REVIEWED" ? suggestedCode : null, suggestedCode } });
  await line("a", 18, "Cr BI fast Incoming - BI Fast Incoming", 250_000_000n, "NEEDS_REVIEW", "4910");
  await line("b", 19, "Db BI Fast Outgoing - BI Fast Outgoing", -105_000_000n, "NEEDS_REVIEW", "3300");
  await line("c", 20, "Bea Materai - Stamp Duty", -10_000n, "REVIEWED", "7100");
  const question = "Transaksi apa saja yang belum jelas dan perlu ditanyakan ke klien?";
  expect(workspaceQuestionIntent(question)).toBe("unclear");
  const a = await askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope: `client:${g.client.id}`, period: "2026-06", question });
  expect(a.text).toBe("2 transaksi belum jelas sampai Juni 2026 (masuk Rp 250.000.000, keluar Rp 105.000.000). Tanyakan ke klien dari siapa uang masuk dan untuk apa uang keluar, lalu pilih akunnya di Review.");
  expect(a.rows.map((r) => r.value)).toEqual(["Masuk Rp 250.000.000 · usulan 4910 Pendapatan Lain-lain", "Keluar Rp 105.000.000 · usulan 3300 Prive / Penarikan Pemilik"]);
  expect(a.citations.map((c) => c.href.split("?")[0])).toEqual([`/clients/${g.client.id}/review`]);
  const before = await askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope: `client:${g.client.id}`, period: "2026-04", question });
  expect(before.text).toBe("Tidak ada transaksi yang menunggu review sampai April 2026 di cakupan ini.");
});

it("a client still in setup gets one task naming the step: upload first, then Saldo Awal", async () => {
  const g = await makeGroup();
  const setupTasks = async () => (await getWorkspaceOverview(db, { firmId: g.firm.id, clientIds: "ALL" }, { period: "2026-08" })).tasks.filter(t => t.clientId === g.client.id);
  let tasks = await setupTasks();
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ title: "Mulai Grup Uji: unggah rekening koran" });
  expect(new URL(tasks[0].href, "https://buku.example").pathname).toBe(`/clients/${g.client.id}/import`);

  const bank = await db.bankAccount.findFirstOrThrow({ where: { entityId: g.pt.entity.id } });
  await db.statementImport.create({ data: { firmId: g.firm.id, bankAccountId: bank.id, fileName: "bca.csv", format: "BCA", periodStart: dateOnly(2026, 8, 1), periodEnd: dateOnly(2026, 8, 31), openingBalance: 100n, closingBalance: 100n, rowCount: 0, continuityOk: true } });
  tasks = await setupTasks();
  expect(tasks).toHaveLength(1);
  expect(tasks[0].title).toBe("Isi saldo awal PT Uji");
  expect(new URL(tasks[0].href, "https://buku.example").pathname).toBe(`/clients/${g.client.id}/opening`);
});

it("ranks what blocks the books first and names the client on a review task", async () => {
  const g = await makeGroup();
  // Past setup: both entities have their Saldo Awal at 31 July.
  for (const e of [g.pt.entity.id, g.owner.entity.id]) {
    const cash = await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code: "1110" } } });
    const equity = await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code: "3100" } } });
    await db.$transaction(tx => postJournal(tx, { entityId: e, date: dateOnly(2026, 7, 31), kind: "OPENING", memo: "Saldo awal", lines: [{ accountId: cash.id, debit: 5n }, { accountId: equity.id, credit: 5n }] }));
  }
  await sale(g, g.pt.entity.id, 1000n);
  const bank = g.pt.banks[0];
  const imp = await db.statementImport.create({ data: { firmId: g.firm.id, bankAccountId: bank.id, fileName: "bca.csv", format: "BCA", periodStart: dateOnly(2026, 8, 1), periodEnd: dateOnly(2026, 8, 31), openingBalance: 0n, closingBalance: 0n, rowCount: 1, continuityOk: true } });
  await db.bankTransaction.create({ data: { firmId: g.firm.id, entityId: g.pt.entity.id, bankAccountId: bank.id, importId: imp.id, date: dateOnly(2026, 8, 5), description: "TOKO", merchantKey: "TOKO", direction: "OUT", amount: -10n, rowNumber: 1, rawRow: "synthetic", hash: "h1", status: "NEEDS_REVIEW", method: "AI", confidence: 0.8, reason: "contoh", suggestedCode: "6190" } });
  const { tasks } = await getWorkspaceOverview(db, { firmId: g.firm.id, clientIds: "ALL" }, { period: "2026-08" });
  const at = (prefix: string) => tasks.findIndex(t => t.id.startsWith(prefix));
  // Mandiri and the owner's BRI have no August statement: that comes before reviewing what was imported.
  expect(at("statement:")).toBeGreaterThanOrEqual(0);
  expect(at("statement:")).toBeLessThan(at("review:"));
  expect(tasks[at("review:")].detail).toBe("Grup Uji · PT Uji Sejahtera · sampai Agustus 2026");
});

it("labels answers of a month not yet closed as preliminary, names the clients still open, and drops the label once closed (UC-X5)", async () => {
  const g = await makeGroup();
  await sale(g, g.pt.entity.id, 1500n);
  const ask = (period: string) => askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope: `client:${g.client.id}`, period, question: "Berapa laba bulan ini?" });
  expect((await ask("2026-08")).preliminary).toBe("Sementara: Agustus 2026 belum ditutup. Angka bisa berubah sampai buku ditutup.");
  await db.period.update({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 8 } }, data: { status: "LOCKED" } });
  expect((await ask("2026-08")).preliminary).toBeNull();
  // Documents are not the books: no period label on them.
  expect((await askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope: `client:${g.client.id}`, period: "2026-09", question: "Dokumen apa yang tersedia?" })).preliminary).toBeNull();
});

it("refuses to change data and says where it is done instead", async () => {
  const g = await makeGroup();
  for (const question of ["Tolong ubah akun transaksi PLN ke 6100", "Hapus impor bulan Juni", "Catat jurnal penyusutan Agustus"]) {
    const answer = await askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope: `client:${g.client.id}`, period: "2026-08", question });
    expect(answer.text).toMatch(/^Tanya Buku hanya membaca buku, tidak mengubahnya\./);
    expect(answer.rows).toHaveLength(0);
  }
});

it("papan kantor: Sumber counts this month's gaps; Terkirim is the first report out after the lock (I5a)", async () => {
  const g = await makeGroup();
  const bca = g.pt.banks[0];
  const stmt = (m: number, opening: bigint, closing: bigint) =>
    db.statementImport.create({ data: { firmId: g.firm.id, bankAccountId: bca.id, fileName: `bca-${m}.csv`, format: "BCA", periodStart: dateOnly(2026, m, 1), periodEnd: dateOnly(2026, m + 1, 0), openingBalance: opening, closingBalance: closing, rowCount: 1, continuityOk: true } });
  await stmt(7, 0n, 100n);
  const july = (await getWorkspaceOverview(db, { firmId: g.firm.id, clientIds: "ALL" }, { period: "2026-07" })).clients[0];
  expect(july.sumber).toEqual({ rows: 1, gaps: 0 });
  expect(july.sentAt).toBeNull();
  const august = (await getWorkspaceOverview(db, { firmId: g.firm.id, clientIds: "ALL" }, { period: "2026-08" })).clients[0];
  expect(august.sumber).toEqual({ rows: 1, gaps: 1 }); // August statement not imported yet

  const lockedAt = new Date(Date.now() - 60_000);
  await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 7 } }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 7, status: "LOCKED", lockedAt }, update: { status: "LOCKED", lockedAt } });
  const event = (at: Date) => db.auditEvent.create({ data: { firmId: g.firm.id, clientId: g.client.id, kind: "REPORT_EXPORT", subject: "period:2026-07", summary: "x", createdAt: at } });
  await event(new Date(+lockedAt - 1000)); // a draft before the lock doesn't count
  expect((await getWorkspaceOverview(db, { firmId: g.firm.id, clientIds: "ALL" }, { period: "2026-07" })).clients[0].sentAt).toBeNull();
  const after = await event(new Date(+lockedAt + 1000));
  expect((await getWorkspaceOverview(db, { firmId: g.firm.id, clientIds: "ALL" }, { period: "2026-07" })).clients[0].sentAt).toEqual(after.createdAt);
});

it("puts a masa paid short on the task list as its own high-priority task, until it is paid", async () => {
  const g = await makeGroup();
  const id = async (code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code } } })).id;
  const bank = g.pt.banks[0].accountId;
  // Past setup: Saldo Awal at 30 June and an imported statement, as in the ranking test.
  for (const e of [g.pt.entity.id, g.owner.entity.id]) await db.$transaction(async (tx) => postJournal(tx, { entityId: e, date: dateOnly(2026, 6, 30), kind: "OPENING", memo: "Saldo awal", lines: [{ accountId: await id("1110"), debit: 50_000_000n }, { accountId: await id("3100"), credit: 50_000_000n }] }));
  await db.statementImport.create({ data: { firmId: g.firm.id, bankAccountId: g.pt.banks[0].id, fileName: "bca.csv", format: "BCA", periodStart: dateOnly(2026, 8, 1), periodEnd: dateOnly(2026, 8, 31), openingBalance: 0n, closingBalance: 0n, rowCount: 0, continuityOk: true } });
  await db.$transaction(async (tx) => postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, 7, 25), kind: "ADJUSTMENT", memo: "Gaji Juli", lines: [{ accountId: await id("6100"), debit: 10_000_000n }, { accountId: bank, credit: 9_800_000n }, { accountId: await id("2140"), credit: 200_000n }] }));
  const tax = async () => (await getWorkspaceOverview(db, { firmId: g.firm.id, clientIds: "ALL" }, { period: "2026-08" })).tasks.find((t) => t.id === `tax:masa:${g.pt.entity.id}`);
  expect(await tax()).toMatchObject({ title: "Periksa setoran pajak PT Uji", priority: "high", clientId: g.client.id });
  expect((await tax())!.detail).toMatch(/^Grup Uji · PPh 21: Masa Juli 2026: Rp 200\.000 dari Rp 200\.000 belum disetor sampai jatuh tempo 15 Agu 2026/);
  expect((await tax())!.href).toContain("/tax/masa?period=2026-08");
  await db.$transaction(async (tx) => postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, 8, 14), kind: "ADJUSTMENT", memo: "Setor PPh 21", lines: [{ accountId: await id("2140"), debit: 200_000n }, { accountId: bank, credit: 200_000n }] }));
  expect(await tax()).toBeUndefined();
});

it("answers a balance asked by name, a cleared account at Rp 0 rather than the cash balance", async () => {
  const g = await makeGroup();
  await sale(g, g.pt.entity.id, 1_500n);
  const scope = `entity:${g.pt.entity.id}`;
  const payable = await askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope, period: "2026-08", question: "Berapa utang usaha?" });
  expect(payable.rows.map(r => [r.label.split(" · ").at(-1), r.value])).toEqual([["2110 Utang Usaha", "Rp 0"]]);
  expect(payable.text).toContain("akun yang disebut");
});

it("answers a related-party balance from the client's accounts that name the group's other entity, never an unused zero account", async () => {
  const g = await makeGroup();
  const id = async (code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code } } })).id;
  const bank = g.pt.banks[0].accountId;
  // Buku's own catch-all name (unused) and the client's accounts as an imported ledger names them.
  await db.account.create({ data: { firmId: g.firm.id, clientId: g.client.id, code: "212008", name: "Related Party Payable", type: "LIABILITAS", fsLine: "UTANG_LAIN", normalBalance: "CREDIT" } });
  const source = (code: string, name: string, accountId: string) => db.sourceAccount.create({ data: { firmId: g.firm.id, clientId: g.client.id, entityId: g.pt.entity.id, code, name, accountId } });
  const other = await source("21003", "Other Payable - Andi Wijaya", await id("2120"));
  const loan = await source("27003", "Long Term Non-Bank - Andi Wijaya", await id("2300"));
  const rawasari = await source("10005", "Bank BCA - A/C 579 - Rawasari", await id("1110"));
  await db.$transaction(async (tx) => postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, 8, 20), kind: "ADJUSTMENT", memo: "Pinjaman pemilik", lines: [
    { accountId: bank, debit: 8_000_000n }, { accountId: await id("1110"), debit: 2_000_000n, sourceAccountId: rawasari.id },
    { accountId: await id("2120"), credit: 7_000_000n, sourceAccountId: other.id }, { accountId: await id("2300"), credit: 3_000_000n, sourceAccountId: loan.id },
  ] }));
  const scope = `client:${g.client.id}`;

  const rp = await askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope, period: "2026-08", question: "Berapa utang PT Uji ke pihak berelasi (Andi Wijaya) per Agustus 2026?" });
  expect(rp.rows.map((r) => [r.label, r.value])).toEqual([
    ["PT Uji Sejahtera · 21003 Other Payable - Andi Wijaya (akun klien)", "Rp 7.000.000 Kredit"],
    ["PT Uji Sejahtera · 27003 Long Term Non-Bank - Andi Wijaya (akun klien)", "Rp 3.000.000 Kredit"],
  ]);
  expect(rp.text).toContain("pihak berelasi");

  // The entity named narrows a group scope; a client's own code and one distinctive word find the client's account.
  const code = await askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope, period: "2026-08", question: "Saldo akun 10005 PT Uji Sejahtera?" });
  expect(code.rows.map((r) => [r.label, r.value])).toEqual([["PT Uji Sejahtera · 10005 Bank BCA - A/C 579 - Rawasari (akun klien)", "Rp 2.000.000 Debit"]]);
  const word = await askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope, period: "2026-08", question: "Berapa saldo BCA Rawasari PT Uji per akhir Agustus 2026?" });
  expect(word.rows.map((r) => r.label)).toContain("PT Uji Sejahtera · 10005 Bank BCA - A/C 579 - Rawasari (akun klien)");
  expect(word.rows.every((r) => r.label.startsWith("PT Uji Sejahtera"))).toBe(true);

  // The month named in the question is the month answered.
  const later = await askWorkspace(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope, period: "2026-08", question: "Berapa laba PT Uji bulan Desember 2026?" });
  expect(later.scope.period).toBe("2026-12");
  expect(later.limitations.join(" ")).toContain("belum ada jurnal pada Desember 2026");
});

it("the firm board's Persetujuan cell counts the client's Kotak for the month, every company, and links there", async () => {
  const g = await makeGroup();
  const line = async (entity: typeof g.pt, hash: string, day: number) => {
    const bank = entity.banks[0];
    const imp = await db.statementImport.create({ data: { firmId: g.firm.id, bankAccountId: bank.id, fileName: `${hash}.csv`, format: "BCA", periodStart: dateOnly(2026, 8, 1), periodEnd: dateOnly(2026, 8, 31), openingBalance: 0n, closingBalance: 0n, rowCount: 1, continuityOk: true } });
    return db.bankTransaction.create({ data: { firmId: g.firm.id, entityId: entity.entity.id, bankAccountId: bank.id, importId: imp.id, date: dateOnly(2026, 8, day), description: `UJI ${hash}`, merchantKey: `UJI ${hash}`, direction: "OUT", amount: -10n, rowNumber: 1, rawRow: "synthetic", hash, status: "NEEDS_REVIEW", method: "HEURISTIC", confidence: 0.3, reason: "uji", suggestedCode: "6190" } });
  };
  await line(g.pt, "a", 3);
  await line(g.owner, "b", 4);
  await createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "DEPRECIATION", memo: "Penyusutan mesin", debitCode: "6180", creditCode: "1219", amount: "1.200.000", months: 12, startYear: 2026, startMonth: 8 });
  const counts = await approvalCounts(db, { clientId: g.client.id, year: 2026, month: 8 });
  expect(counts.total).toBe(3);
  // Scoped to one company, the board still counts the whole client (closing is a client operation), and the link opens all of it.
  for (const scope of [undefined, `entity:${g.pt.entity.id}`]) {
    const [row] = (await getWorkspaceOverview(db, { firmId: g.firm.id, clientIds: "ALL" }, { scope, period: "2026-08" })).clients;
    expect(row.approvals).toBe(counts.total);
    const href = new URL(row.approvalsHref, "https://buku.example");
    expect([href.pathname, href.searchParams.get("period"), href.searchParams.get("entity")]).toEqual([`/clients/${g.client.id}/approvals`, "2026-08", "combined"]);
  }
  await postAllDue(db, { clientId: g.client.id, year: 2026, month: 8 });
  expect((await getWorkspaceOverview(db, { firmId: g.firm.id, clientIds: "ALL" }, { period: "2026-08" })).clients[0].approvals).toBe(2);
});

it("the board's Checklist cell and Beranda's late-task count are the checklist page's own rows (cycle 2026-10-17-checklist-tutup-buku)", async () => {
  const g = await makeGroup();
  const ALL = { firmId: g.firm.id, clientIds: "ALL" as const };
  const admin = await addMember(g.firm.id, "ADMIN", { name: "Budi" });
  const rina = await addMember(g.firm.id, "AKUNTAN", { name: "Rina", clients: [g.client.id] });
  const now = new Date("2026-09-11T02:00:00Z"); // 11 Sep 09.00 WIB: August's tanggal 5–10 tasks are late
  await sale(g, g.pt.entity.id, 1000n);
  let data = await getWorkspaceOverview(db, ALL, { period: "2026-08", now });
  expect(data.clients[0].checklist).toMatchObject({ hasTemplate: false, total: 0, overdue: 0 });
  expect(data.tasks.some((t) => t.id.startsWith("checklist:"))).toBe(false);

  await acceptDefault(db, { id: admin.id, role: admin.role }, { clientId: g.client.id, year: 2026, month: 8, assigneeId: rina.id, reviewerId: admin.id });
  const page = await checklistMonth(db, { clientId: g.client.id, year: 2026, month: 8, now });
  data = await getWorkspaceOverview(db, ALL, { period: "2026-08", now });
  const cell = data.clients[0].checklist;
  expect(cell).toMatchObject({ hasTemplate: true, total: page.counts.total, finished: page.counts.finished, overdue: page.counts.overdue, earliest: { year: 2026, month: 8 } });
  expect(cell.overdue).toBeGreaterThan(0);
  const href = new URL(cell.href, "https://buku.example");
  expect([href.pathname, href.searchParams.get("period")]).toEqual([`/clients/${g.client.id}/checklist`, "2026-08"]);
  const task = data.tasks.find((t) => t.id === `checklist:${g.client.id}`)!;
  expect(task).toMatchObject({ title: `Selesaikan ${page.counts.overdue} tugas checklist lewat tenggat`, detail: "Grup Uji · Agustus 2026 · menunggu Rina", href: cell.href, priority: "high" });
  // It ranks with missing statements and late taxes: before review and the other normal tasks.
  expect(data.tasks.findIndex((t) => t.id === task.id)).toBeLessThan(data.tasks.findIndex((t) => t.priority === "normal"));

  // Before the due dates nothing is late; on September's board August's late tasks still count and the link opens August.
  expect((await getWorkspaceOverview(db, ALL, { period: "2026-08", now: new Date("2026-09-04T00:00:00Z") })).clients[0].checklist.overdue).toBe(0);
  const sep = await getWorkspaceOverview(db, ALL, { period: "2026-09", now });
  expect(sep.clients[0].checklist).toMatchObject({ earliest: { year: 2026, month: 8 }, overdue: page.counts.overdue });
  expect(new URL(sep.clients[0].checklist.href, "https://buku.example").searchParams.get("period")).toBe("2026-08");
});
