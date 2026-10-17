import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { db, makeGroup, resetDb } from "../helpers";
import { AccrualFieldError, accrualProposals, DECIDED, dismissAccrual, NO_CREDIT, postAccrual } from "@/lib/adjust/accruals";
import { trialBalance } from "@/lib/reports/ledger";
import { runControls } from "@/lib/controls";
import { saveControlNote } from "@/lib/controls/ack";
import { journalRegister } from "@/lib/reports/journal-register";
import { accountLedger } from "@/lib/reports/account-ledger";
import { generalLedger } from "@/lib/reports/general-ledger";
import { entryOrigins } from "@/lib/reports/entry-origin";
import { isGenericKey } from "@/lib/import/normalize";
import { reviewTransaction } from "@/lib/review";
import { createInvoice, voidInvoice } from "@/lib/receivables/invoices";
import { createSchedule } from "@/lib/adjust/schedules";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { acceptCheck, importSourceAccounts, postImport, stageImport } from "@/lib/ledger-import/post";
import { acceptMappings, suggestMappings } from "@/lib/ledger-import/mapping";
import { dateOnly, periodBounds } from "@/lib/format";
import { ANDALAS, balances, BERSIH, jt, NOW, PLN, qaBooks, statement, TELKOM, type Row } from "../accrual-books";

// Usulan akrual (cycle 2026-10-18-usulan-akrual): proposals per counterparty, read from the books built through the real pipeline.
type G = Awaited<ReturnType<typeof makeGroup>>;

const august = (g: G, over: Partial<{ now: Date; entityIds: string[] }> = {}) => accrualProposals(db, g.client.id, 2026, 8, { now: NOW, ...over });
const cards = async (g: G, over?: Parameters<typeof august>[1]) => (await august(g, over)).map((p) => [p.counterparty, p.account.code, p.amount]);

describe("accrual proposals", () => {
  beforeEach(resetDb);

  it("proposes a recurring payee missing from an ended, covered month: Dr the account / Cr 2150, the median, the rationale and refs to every history row", async () => {
    const { g } = await qaBooks();
    const found = await august(g);
    // Telkom is missing while PLN, on the same account, paid; Andalas recurs 3 of 4 months.
    expect(found.map((p) => [p.counterparty, p.account.code, p.amount, `${p.medianMonth.year}-${p.medianMonth.month}`])).toEqual([
      [TELKOM, "6130", jt(0.5), "2026-7"],
      [ANDALAS, "6170", jt(7.5), "2026-7"],
      [BERSIH, "6190", jt(4.2), "2026-7"],
    ]);
    const bersih = found[2];
    expect(bersih).toMatchObject({
      key: `ACCRUAL:${g.pt.entity.id}:2026-08:6190:bank:${BERSIH}`,
      bucket: { kind: "bank", merchantKey: BERSIH },
      credit: { code: "2150" },
      memo: `Akrual ${BERSIH} Agu 2026`,
      date: dateOnly(2026, 8, 31),
      reversalDate: dateOnly(2026, 9, 1),
      banks: ["BCA Giro"],
      warning: null,
      blocked: null,
    });
    expect(bersih.rationale).toBe(
      `${BERSIH} dibayar ke 6190 Beban Umum Lain-lain pada Apr, Mei, Jun dan Jul 2026 (Rp 4.200.000 – Rp 4.350.000). Agustus belum ada sampai 31 Agu 2026, dan rekening koran BCA Giro sudah lengkap sampai tanggal itu. Usulan: Rp 4.200.000, nilai tengah riwayat (Jul 2026).`,
    );
    expect(bersih.history.map((h) => [h.month, h.amount])).toEqual([[4, jt(4.2)], [5, jt(4.2)], [6, jt(4.35)], [7, jt(4.2)]]);
    // Each ref is a journal line that drills to its bank row (rule 15).
    expect(bersih.refs).toHaveLength(4);
    for (const ref of bersih.refs) {
      const line = await db.journalLine.findUniqueOrThrow({ where: { id: ref.slice(3) }, include: { account: true, entry: { include: { bankTransaction: true } } } });
      expect([ref.startsWith("jl:"), line.account.code, line.entry.bankTransaction?.description, (line.entry.bankTransaction?.rowNumber ?? 0) > 0]).toEqual([true, "6190", BERSIH, true]);
    }
    expect(bersih.history[3].lines[0]).toMatchObject({ text: BERSIH, source: expect.stringMatching(/^BCA Giro baris \d+$/), amount: jt(4.2) });
    // Andalas: May was filed by the accountant (a RECLASS out of 1999), June and July by Memory; all three count.
    const andalas = found[1];
    expect(andalas.history.map((h) => h.amount)).toEqual([0n, jt(7.5), jt(7.5), jt(7.5)]);
    expect(andalas.rationale).toContain("pada Mei, Jun dan Jul 2026 (Rp 7.500.000 tiap bulan)");
    // Scoped to a company: the owner has none.
    expect(await august(g, { entityIds: [g.owner.entity.id] })).toEqual([]);
  });

  it("no card for 2 of 4 months, a refund month, a month outside the 25 % band (exactly 25 % qualifies) or below materiality", async () => {
    const { g, bca } = await qaBooks({
      august: [[12, PLN, jt(2.4)]],
    });
    // Extra payees, imported as a second BCA statement per month would overlap: add them on Mandiri, covered every month too.
    const mandiri = g.pt.banks[1].id;
    await db.rule.createMany({ data: ["DUA BULAN", "PAS BATAS", "LEWAT BATAS", "KECIL SEKALI", "REFUND JASA"].map((p) => ({ pattern: p, direction: "OUT" as const, accountCode: "6160", firmId: g.firm.id, clientId: g.client.id, priority: 40 })) });
    const plan: Record<number, Row[]> = {
      4: [[3, "CV PAS BATAS", jt(1)], [4, "CV LEWAT BATAS", jt(1)], [5, "CV KECIL SEKALI", 100_000n], [6, "CV REFUND JASA", jt(2)]],
      5: [[3, "CV PAS BATAS", jt(1)], [4, "CV LEWAT BATAS", jt(1)], [5, "CV KECIL SEKALI", 100_000n], [6, "CV REFUND JASA", jt(2)]],
      6: [[2, "CV DUA BULAN", jt(3)], [3, "CV PAS BATAS", jt(1)], [4, "CV LEWAT BATAS", jt(1)], [5, "CV KECIL SEKALI", 100_000n], [6, "CV REFUND JASA", jt(2)]],
      7: [[2, "CV DUA BULAN", jt(3)], [3, "CV PAS BATAS", jt(1.25)], [4, "CV LEWAT BATAS", 1_250_001n], [5, "CV KECIL SEKALI", 100_000n], [6, "CV REFUND JASA", jt(2)], [7, "CV REFUND JASA", -jt(2.5)]],
      8: [[1, "BIAYA LAIN", 1000n]],
    };
    for (const m of [4, 5, 6, 7, 8]) await statement(mandiri, 2026, m, plan[m]);
    // The refund came in: filed back to the expense, it makes July negative for that payee.
    const refund = await db.bankTransaction.findFirstOrThrow({ where: { description: "CV REFUND JASA", direction: "IN" } });
    await reviewTransaction(db, { bankTxId: refund.id, accountCode: "6160", taxTag: null });
    void bca;
    const names = (await august(g)).map((p) => p.counterparty);
    expect(names).toContain("CV PAS BATAS"); // 1,25 jt against a median of 1 jt: exactly 25 %
    for (const no of ["CV DUA BULAN", "CV LEWAT BATAS", "CV KECIL SEKALI", "CV REFUND JASA"]) expect(names).not.toContain(no);
  });

  it("no card for a generic key, or on HPP, tax, 7190, 7200 or 7300", async () => {
    const { g } = await qaBooks();
    const mandiri = g.pt.banks[1].id;
    const rows: Row[] = [[2, "BI FAST OUTGOING 0108/FTSCY/WS95051", jt(3)], [3, "PT PAKAN JAYA", jt(11.1)], [4, "PT LELANG ASET", jt(3)], [5, "KANTOR PAJAK PRATAMA", jt(3)], [6, "CV BULAT", jt(3)], [7, "BANK KURS", jt(3)]];
    for (const m of [4, 5, 6, 7]) await statement(mandiri, 2026, m, rows);
    await statement(mandiri, 2026, 8, [[1, "BIAYA LAIN", 1000n]]);
    const to: Record<string, string> = { "BI FAST": "6190", "LELANG": "7300", "PAJAK PRATAMA": "8200", "BULAT": "7190", "KURS": "7200" };
    for (const t of await db.bankTransaction.findMany({ where: { bankAccountId: mandiri, status: "NEEDS_REVIEW" } })) {
      const code = Object.entries(to).find(([w]) => t.description.includes(w))?.[1];
      if (code) await reviewTransaction(db, { bankTxId: t.id, accountCode: code, taxTag: null });
    }
    // PAKAN posts by the group's rule to 5100 (HPP); the rest were filed by hand above.
    const count = (code: string) => db.journalLine.count({ where: { entityId: g.pt.entity.id, account: { code }, debit: { gt: 0n } } });
    expect(await Promise.all(["5100", "7300", "8200", "7190", "7200"].map(count))).toEqual([4, 4, 4, 4, 4]);
    const fast = await db.bankTransaction.findMany({ where: { description: { startsWith: "BI FAST" }, accountCode: "6190" } });
    expect([fast.length, fast.every((t) => isGenericKey(t.merchantKey))]).toEqual([4, true]);
    expect((await august(g)).map((p) => p.account.code).sort()).toEqual(["6130", "6170", "6190"]);
  });

  it("no card before the month has ended (Asia/Jakarta), when a bank account of the history isn't covered through its last day, or in a locked month", async () => {
    const { g } = await qaBooks();
    // 31 Aug 23.59 WIB: not ended; 1 Sep 00.00 WIB (31 Aug 17.00 UTC): ended.
    expect(await cards(g, { now: new Date("2026-08-31T16:59:00Z") })).toEqual([]);
    expect(await cards(g, { now: new Date("2026-08-31T17:00:00Z") })).toHaveLength(3);
    // A locked month has nothing to approve.
    await db.period.update({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 8 } }, data: { status: "LOCKED" } });
    expect(await august(g)).toEqual([]);
  });

  it("a statement ending 25 Aug is no missing vendor: no card; nor when the payee was also paid from an account without August", async () => {
    balances.clear();
    const g = await makeGroup();
    await db.rule.create({ data: { pattern: "BERSIH PRIMA", direction: "OUT", accountCode: "6190", firmId: g.firm.id, clientId: g.client.id } });
    const [bca, mandiri] = [g.pt.banks[0].id, g.pt.banks[1].id];
    for (const m of [4, 5, 6, 7]) await statement(bca, 2026, m, [[10, BERSIH, jt(4.2)]]);
    await statement(bca, 2026, 8, [[5, "BIAYA LAIN", 1000n]], 25);
    expect(await august(g)).toEqual([]);
    // The rest of August arrives: the card appears.
    await statement(bca, 2026, 8, [[27, "BIAYA LAIN", 1000n]], 31, 26);
    expect(await cards(g)).toEqual([[BERSIH, "6190", jt(4.2)]]);
    // The same payee paid once from Mandiri, which has no August statement: no card until it does.
    await statement(mandiri, 2026, 4, [[11, BERSIH, 1n]]);
    expect(await august(g)).toEqual([]);
  });

  it("the card vanishes when the payee's August line is imported, posted or still in Review", async () => {
    const { g, bca } = await qaBooks();
    expect((await august(g)).map((p) => p.counterparty)).toContain(BERSIH);
    // A late line held in Review (the firm's dial sends rule matches to Review): it has arrived all the same.
    await db.firm.update({ where: { id: g.firm.id }, data: { autoPostRules: false } });
    await statement(bca, 2026, 8, [[30, BERSIH, jt(4.2)]], 31, 30);
    const late = await db.bankTransaction.findFirstOrThrow({ where: { description: BERSIH, date: dateOnly(2026, 8, 30) } });
    expect(late.status).toBe("NEEDS_REVIEW");
    expect((await august(g)).map((p) => p.counterparty)).toEqual([TELKOM, ANDALAS]);
    // Posted: still gone.
    await reviewTransaction(db, { bankTxId: late.id, accountCode: "6190", taxTag: null });
    expect((await august(g)).map((p) => p.counterparty)).toEqual([TELKOM, ANDALAS]);
  });

  it("a supplier bucket from purchase invoices: proposed while missing, gone once an August invoice or a matched bank line arrives", async () => {
    const g = await makeGroup();
    const pt = g.pt.entity.id;
    const bill = (m: number, number: string, dpp = "6.000.000") => createInvoice(db, { clientId: g.client.id, entityId: pt, direction: "PURCHASE", contactName: "CV Andalas Konsultan", number, issueDate: `2026-${String(m).padStart(2, "0")}-25`, dpp, counterCode: "6170" });
    for (const m of [4, 5, 6, 7]) await bill(m, `ADL-${m}`);
    // A voided bill never counts (June would double and leave the band).
    const voided = await bill(6, "ADL-6B");
    await voidInvoice(db, { clientId: g.client.id, invoiceId: voided.id, reason: "dokumen ganda dari pemasok" });
    const found = await august(g);
    expect(found.map((p) => [p.bucket.kind, p.counterparty, p.account.code, p.amount])).toEqual([["contact", "CV Andalas Konsultan", "6170", jt(6)]]);
    expect(found[0].rationale).toBe(
      "Tagihan CV Andalas Konsultan dicatat ke 6170 Beban Jasa Profesional pada Apr, Mei, Jun dan Jul 2026 (Rp 6.000.000 tiap bulan). Agustus belum ada tagihan atau pembayarannya sampai 31 Agu 2026. Usulan: Rp 6.000.000, nilai tengah riwayat (Jul 2026).",
    );
    expect(found[0].history[3].lines[0]).toMatchObject({ text: "ADL-7 · CV Andalas Konsultan", source: "Tagihan pembelian ADL-7" });
    // A bank line matched to the contact in August (a payment of an earlier bill) has arrived.
    balances.clear();
    await statement(g.pt.banks[0].id, 2026, 8, [[28, "TRSF DB CV ANDALAS", jt(6)]]);
    const paid = await db.bankTransaction.findFirstOrThrow({ where: { description: "TRSF DB CV ANDALAS" } });
    await db.bankTransaction.update({ where: { id: paid.id }, data: { contactId: found[0].bucket.kind === "contact" ? found[0].bucket.contactId : null } });
    expect(await august(g)).toEqual([]);
    await db.bankTransaction.update({ where: { id: paid.id }, data: { contactId: null } });
    expect(await august(g)).toHaveLength(1);
    // An August bill: gone.
    await bill(8, "ADL-8");
    expect(await august(g)).toEqual([]);
  });

  it("a ledger-fed company gets the per-account proposal under the same rule, only once its August ledger is imported; a manual accrual hides it", async () => {
    const g = await makeGroup();
    const gl = async (name: string, rows: [Date, string, string, number, number][]) => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("GL");
      ws.addRow(["Entity", "Entry Date", "Account Code", "Account Name", "Description", "Debit", "Credit"]);
      for (const [date, code, accName, dr, cr] of rows) ws.addRow(["PT Uji", date, code, accName, `${accName} ${date.toISOString().slice(0, 7)}`, dr, cr]);
      const st = await stageImport(db, { firmId: g.firm.id, clientId: g.client.id, fileName: name, data: Buffer.from(await wb.xlsx.writeBuffer()) });
      if (st.status !== "STAGED") throw new Error(`not staged: ${JSON.stringify(st)}`);
      for (const c of await db.importCheck.findMany({ where: { ledgerImportId: st.importId, severity: "BLOCK" } })) await acceptCheck(db, g.client.id, c.id);
      await suggestMappings(db, { firmId: g.firm.id, clientId: g.client.id, provider: null, useAi: false });
      const src = await importSourceAccounts(db, st.importId);
      await acceptMappings(db, g.client.id, src.map((s) => ({ sourceAccountId: s.id, accountCode: s.suggestedCode!, method: s.suggestedBy! })));
      await postImport(db, g.client.id, st.importId);
    };
    const rent = (m: number, amount: number): [Date, string, string, number, number][] => [
      [new Date(Date.UTC(2026, m - 1, 25)), "6120", "Beban Sewa", amount, 0],
      [new Date(Date.UTC(2026, m - 1, 25)), "2110", "Utang Usaha", 0, amount],
    ];
    const sales = (m: number): [Date, string, string, number, number][] => [
      [new Date(Date.UTC(2026, m - 1, 10)), "1130", "Piutang Usaha", 20_000_000, 0],
      [new Date(Date.UTC(2026, m - 1, 10)), "4100", "Penjualan", 0, 20_000_000],
    ];
    await gl("gl-apr-jul.xlsx", [4, 5, 6, 7].flatMap((m) => [...rent(m, 3_000_000), ...sales(m)]));
    // August's ledger isn't imported yet: the month isn't complete.
    expect(await august(g)).toEqual([]);
    await gl("gl-agu.xlsx", sales(8));
    const found = await august(g);
    expect(found.map((p) => [p.bucket.kind, p.counterparty, p.account.code, p.amount, p.memo])).toEqual([["ledger", "6120 Beban Sewa", "6120", jt(3), "Akrual 6120 Beban Sewa Agu 2026"]]);
    expect(found[0].rationale).toContain("6120 Beban Sewa tercatat di buku besar yang diimpor pada Apr, Mei, Jun dan Jul 2026 (Rp 3.000.000 tiap bulan)");
    expect(found[0].history[3].lines[0].source).toMatch(/^gl-apr-jul\.xlsx GL!\d+/);
    // The accountant accrued it by hand: the account is the bucket, so it is hidden.
    await postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 8, 31), memo: "Akrual sewa Agustus", lines: [{ accountCode: "6120", debit: "3.000.000", credit: "" }, { accountCode: "2150", debit: "", credit: "3.000.000" }], reverseNextMonth: true });
    expect(await august(g)).toEqual([]);
  });

  it("a manual accrual on the account puts a warning on a payee card (it stays); an ACCRUAL schedule does the same", async () => {
    const { g } = await qaBooks();
    await postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 8, 31), memo: "Akrual kebersihan Agustus", lines: [{ accountCode: "6190", debit: "4.000.000", credit: "" }, { accountCode: "2150", debit: "", credit: "4.000.000" }], reverseNextMonth: true });
    await createSchedule(db, { clientId: g.client.id, entityId: g.pt.entity.id, kind: "ACCRUAL", memo: "Akrual internet Agustus", debitCode: "6130", creditCode: "2150", amount: "500.000", months: 1, startYear: 2026, startMonth: 8 });
    const found = await august(g);
    // Warned cards lead (problems first).
    expect(found.map((p) => [p.counterparty, p.warning])).toEqual([
      [TELKOM, `Sudah ada akrual 6130 bulan ini: “Akrual internet Agustus” Rp 500.000. Pastikan bukan untuk ${TELKOM} sebelum menyetujui.`],
      [BERSIH, `Sudah ada akrual 6190 bulan ini: “Akrual kebersihan Agustus” Rp 4.000.000. Pastikan bukan untuk ${BERSIH} sebelum menyetujui.`],
      [ANDALAS, null],
    ]);
  });

  it("a locked next month blocks the card first; a chart without 2150 leaves the credit to the accountant", async () => {
    const { g } = await qaBooks();
    await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 9 } }, update: { status: "LOCKED" }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 9, status: "LOCKED" } });
    expect((await august(g)).map((p) => p.blocked)).toEqual(Array(3).fill("1 Sep 2026 sudah dikunci, jadi pembaliknya tidak bisa dicatat."));
    await db.period.update({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 9 } }, data: { status: "OPEN" } });
    await db.account.delete({ where: { clientId_code: { clientId: g.client.id, code: "2150" } } });
    const found = await august(g);
    expect(found.map((p) => [p.credit, p.blocked])).toEqual(Array(3).fill([null, null]));
    expect(NO_CREDIT).toBe("Pilih akun kredit (liabilitas): bagan akun klien tidak punya 2150.");
  });
});

describe("deciding an accrual proposal", () => {
  beforeEach(resetDb);

  const decide = (g: G, key: string, edit?: Parameters<typeof postAccrual>[1]["edit"]) => postAccrual(db, { firmId: g.firm.id, clientId: g.client.id, key, edit, now: NOW });
  const dismiss = (g: G, key: string) => dismissAccrual(db, { firmId: g.firm.id, clientId: g.client.id, key, now: NOW });
  /** Net (debit − credit) of an account in the PT's trial balance at a month's end. */
  const tb = async (g: G, month: number, code: string) => (await trialBalance(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, periodBounds(2026, month).end)).find((r) => r.account.code === code)?.net ?? 0n;
  const adjustments = (g: G) => db.journalEntry.count({ where: { entityId: g.pt.entity.id, kind: "ADJUSTMENT" } });

  it("Setujui posts one ADJUSTMENT on the month's last day and its mirror on the 1st of the next, stores it POSTED with its entry, and the card leaves", async () => {
    const { g } = await qaBooks();
    const bersih = (await august(g)).find((p) => p.counterparty === BERSIH)!;
    const before = { expense: await tb(g, 8, "6190"), accrued: await tb(g, 8, "2150"), sep: await tb(g, 9, "2150") };
    const entry = await decide(g, bersih.key);
    const lines = (id: string) => db.journalLine.findMany({ where: { entryId: id }, include: { account: true }, orderBy: { debit: "desc" } }).then((ls) => ls.map((l) => [l.account.code, l.debit, l.credit, l.memo]));
    expect([entry.kind, entry.date, entry.memo]).toEqual(["ADJUSTMENT", dateOnly(2026, 8, 31), `Akrual ${BERSIH} Agu 2026`]);
    expect(await lines(entry.id)).toEqual([["6190", jt(4.2), 0n, BERSIH], ["2150", 0n, jt(4.2), BERSIH]]);
    const reversal = await db.journalEntry.findUniqueOrThrow({ where: { reversesId: entry.id } });
    expect([reversal.kind, reversal.date, reversal.memo]).toEqual(["ADJUSTMENT", dateOnly(2026, 9, 1), `Pembalik: Akrual ${BERSIH} Agu 2026 (31 Agu 2026)`]);
    expect(await lines(reversal.id)).toEqual([["2150", jt(4.2), 0n, BERSIH], ["6190", 0n, jt(4.2), BERSIH]]);
    const stored = await db.proposedEntry.findUniqueOrThrow({ where: { key: bersih.key } });
    expect(stored).toMatchObject({ source: "ACCRUAL", status: "POSTED", entryId: entry.id, year: 2026, month: 8, memo: bersih.memo, reason: bersih.rationale, refs: bersih.refs, lines: [{ accountCode: "6190", debit: "4200000", credit: "0" }, { accountCode: "2150", debit: "0", credit: "4200000" }] });
    expect((await august(g)).map((p) => p.counterparty)).toEqual([TELKOM, ANDALAS]);
    // Trial balance: August's expense and 2150 up by the amount; September back.
    expect([await tb(g, 8, "6190") - before.expense, await tb(g, 8, "2150") - before.accrued, await tb(g, 9, "2150") - before.sep]).toEqual([jt(4.2), -jt(4.2), 0n]);
    // Jurnal Umum, the Buku Besar drawer and the Excel source column name where it came from.
    const august31 = periodBounds(2026, 8);
    const register = (await journalRegister(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, { ...august31, kinds: null, search: null }, "all")).entries;
    expect(register.find((e) => e.id === entry.id)!.origin).toBe(`Usulan akrual (riwayat ${BERSIH})`);
    const expense = await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code: "6190" } } });
    const { rows } = await accountLedger(db, { accountId: expense.id, entityIds: [g.pt.entity.id], ...august31, normalBalance: "DEBIT" });
    expect(rows.filter((r) => r.origin).map((r) => r.origin)).toEqual([`Usulan akrual (riwayat ${BERSIH})`]);
    const [gl] = await generalLedger(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, august31.start, august31.end, { accountCode: "2150" });
    expect(gl.lines.map((l) => l.source)).toEqual([expect.stringContaining(`Usulan akrual (riwayat ${BERSIH})`)]);
  });

  it("Ubah posts the typed amount and accounts; 0, a bank, clearing or 1999 account and a non-liability credit are refused with a field message", async () => {
    const { g } = await qaBooks();
    const [telkom, andalas] = await august(g);
    const refused = async (edit: Parameters<typeof decide>[2], field: string, message: string) => {
      const e = await decide(g, andalas.key, edit).catch((x) => x);
      expect([e instanceof AccrualFieldError, e.field, e.message]).toEqual([true, field, message]);
    };
    await refused({ amount: "0" }, "amount", "Nominal harus lebih dari nol.");
    await refused({ amount: "abc" }, "amount", expect.stringContaining("tidak bisa dibaca"));
    const bank = (await db.bankAccount.findUniqueOrThrow({ where: { id: g.pt.banks[0].id }, include: { account: true } })).account.code;
    for (const code of [bank, "1199", "1190", "1999"]) await refused({ debitCode: code }, "debit", "Akun debit tidak boleh akun bank, kliring (1190/1199) atau 1999.");
    for (const code of [bank, "6120", "1170"]) await refused({ creditCode: code }, "credit", "Akun kredit harus akun liabilitas, bukan bank, kliring (1190/1199) atau 1999.");
    await refused({ creditCode: "9999" }, "credit", "Akun 9999 tidak ada di bagan akun klien.");
    expect(await adjustments(g)).toBe(0);
    // Telkom: Rp 450.000 instead of Rp 500.000, credit 2150 kept.
    const entry = await decide(g, telkom.key, { amount: "450.000", creditCode: "2150" });
    expect((await db.journalLine.findMany({ where: { entryId: entry.id }, include: { account: true }, orderBy: { debit: "desc" } })).map((l) => [l.account.code, l.debit, l.credit])).toEqual([["6130", 450_000n, 0n], ["2150", 0n, 450_000n]]);
    // The proposal keeps Buku's lines; the origin says what changed.
    expect((await db.proposedEntry.findUniqueOrThrow({ where: { key: telkom.key } })).lines).toEqual([{ accountCode: "6130", debit: "500000", credit: "0" }, { accountCode: "2150", debit: "0", credit: "500000" }]);
    expect((await entryOrigins(db, [entry.id])).get(entry.id)).toBe(`Usulan akrual (riwayat ${TELKOM}) diubah dari Rp 500.000`);
    // Other accounts post as typed: Andalas on 6160 against 2120.
    const other = await decide(g, andalas.key, { debitCode: "6160", creditCode: "2120" });
    expect((await db.journalLine.findMany({ where: { entryId: other.id }, include: { account: true }, orderBy: { debit: "desc" } })).map((l) => [l.account.code, l.debit])).toEqual([["6160", jt(7.5)], ["2120", 0n]]);
    expect((await entryOrigins(db, [other.id])).get(other.id)).toBe(`Usulan akrual (riwayat ${ANDALAS})`);
  });

  it("Tolak stores the decision: gone for the month, back next month while the vendor is still missing", async () => {
    const { g, bca } = await qaBooks();
    const andalas = (await august(g)).find((p) => p.counterparty === ANDALAS)!;
    await dismiss(g, andalas.key);
    expect(await db.proposedEntry.findUniqueOrThrow({ where: { key: andalas.key } })).toMatchObject({ source: "ACCRUAL", status: "DISMISSED", entryId: null });
    expect((await august(g)).map((p) => p.counterparty)).toEqual([TELKOM, BERSIH]);
    await expect(dismiss(g, andalas.key)).rejects.toThrow(DECIDED);
    await expect(decide(g, andalas.key)).rejects.toThrow(DECIDED);
    // September's statement without Andalas: it is proposed again for September (May–July against an empty August).
    await statement(bca, 2026, 9, [[10, BERSIH, jt(4.2)], [12, PLN, jt(2.3)], [14, TELKOM, jt(0.5)]]);
    const september = await accrualProposals(db, g.client.id, 2026, 9, { now: NOW });
    expect(september.map((p) => [p.counterparty, p.amount])).toEqual([[ANDALAS, jt(7.5)]]);
  });

  it("refuses, posting nothing, when the payment arrived meanwhile, when already decided, or when the next month is locked", async () => {
    const { g, bca } = await qaBooks();
    const [telkom, andalas, bersih] = await august(g);
    // The payment arrives between the page and the click.
    await statement(bca, 2026, 8, [[30, BERSIH, jt(4.2)]], 31, 30);
    await expect(decide(g, bersih.key)).rejects.toThrow(`Pembayaran ${BERSIH} 30 Agu 2026 sudah masuk; usulan ini tidak berlaku lagi.`);
    await expect(dismiss(g, bersih.key)).rejects.toThrow(`Pembayaran ${BERSIH} 30 Agu 2026 sudah masuk; usulan ini tidak berlaku lagi.`);
    // Decided twice.
    await decide(g, telkom.key);
    await expect(decide(g, telkom.key)).rejects.toThrow(DECIDED);
    expect(await adjustments(g)).toBe(2);
    // September locked: the card says so first, and the click posts nothing.
    await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 9 } }, update: { status: "LOCKED" }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 9, status: "LOCKED" } });
    expect((await august(g)).find((p) => p.key === andalas.key)!.blocked).toBe("1 Sep 2026 sudah dikunci, jadi pembaliknya tidak bisa dicatat.");
    await expect(decide(g, andalas.key)).rejects.toThrow("1 Sep 2026 sudah dikunci, jadi pembaliknya tidak bisa dicatat.");
    expect(await adjustments(g)).toBe(2);
    expect(await db.proposedEntry.count({ where: { key: andalas.key } })).toBe(0);
    // A key of another client, or one that was never proposed, posts nothing either.
    const other = await makeGroup();
    await expect(postAccrual(db, { firmId: other.firm.id, clientId: other.client.id, key: andalas.key, now: NOW })).rejects.toThrow("Usulan akrual ini tidak berlaku lagi. Muat ulang halaman.");
    await expect(decide(g, `ACCRUAL:${g.pt.entity.id}:2026-08:6120:bank:SIAPA SAJA`)).rejects.toThrow("Usulan akrual ini tidak berlaku lagi. Muat ulang halaman.");
  });

  it("a payment after approval raises the REVIEW control with both rows; Salin of the reversal with Balik otomatis cancels the accrual", async () => {
    const { g, bca } = await qaBooks();
    const bersih = (await august(g)).find((p) => p.counterparty === BERSIH)!;
    const entry = await decide(g, bersih.key);
    const reversal = await db.journalEntry.findUniqueOrThrow({ where: { reversesId: entry.id }, include: { lines: { include: { account: true } } } });
    const stored = await db.proposedEntry.findUniqueOrThrow({ where: { key: bersih.key } });
    const control = async () => (await runControls(db, g.client.id, 2026, 8)).find((c) => c.key === `accrual-paid:${stored.id}`);
    expect(await control()).toBeUndefined();
    // A late statement brings the 30 Aug payment: the expense is now there twice.
    await statement(bca, 2026, 8, [[30, BERSIH, jt(4.2)]], 31, 30);
    expect(await control()).toMatchObject({
      title: "Akrual dan pembayaran di bulan yang sama",
      scope: "PT Uji",
      status: "REVIEW",
      detail: `Akrual 31 Agu 2026 “Akrual ${BERSIH} Agu 2026” Rp 4.200.000 dan ${BERSIH} 30 Agu 2026 Rp 4.200.000: beban ${BERSIH} tercatat dua kali. Salin jurnal pembalik akrualnya ke Agustus 2026 dengan Balik otomatis, lalu tulis catatan.`,
      href: `/clients/${g.client.id}/journals/new?period=2026-08&salin=${reversal.id}`,
    });
    expect(await tb(g, 8, "6190") - (await tb(g, 7, "6190"))).toBe(jt(8.4)); // August: the payment and the accrual
    // The way out the control names: the reversal's lines copied into August with Balik otomatis.
    const copy = reversal.lines.sort((a, b) => Number(b.debit - a.debit)).map((l) => ({ accountCode: l.account.code, debit: l.debit ? "4.200.000" : "", credit: l.credit ? "4.200.000" : "" }));
    await postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 8, 31), memo: reversal.memo, lines: copy, reverseNextMonth: true });
    expect([await tb(g, 8, "6190") - (await tb(g, 7, "6190")), await tb(g, 8, "2150"), await tb(g, 9, "2150")]).toEqual([jt(4.2), 0n, 0n]);
    // Still a REVIEW until a note acknowledges it, never a FAIL.
    const flagged = (await control())!;
    const period = await db.period.findUniqueOrThrow({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 8 } } });
    await saveControlNote(db, { clientId: g.client.id, periodId: period.id, year: 2026, month: 8, controlKey: flagged.key, note: "Akrual dibatalkan dengan salinan pembaliknya", detail: flagged.detail });
    expect(await control()).toMatchObject({ status: "REVIEW", ack: "Akrual dibatalkan dengan salinan pembaliknya" });
  });

  it("a payee card with a manual-accrual warning still approves; a chart without 2150 needs a liability picked", async () => {
    const { g } = await qaBooks();
    await postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 8, 31), memo: "Akrual kebersihan Agustus", lines: [{ accountCode: "6190", debit: "4.000.000", credit: "" }, { accountCode: "2150", debit: "", credit: "4.000.000" }] });
    const warned = (await august(g)).find((p) => p.warning)!;
    expect(warned.counterparty).toBe(BERSIH);
    await decide(g, warned.key);
    expect(await db.proposedEntry.findUniqueOrThrow({ where: { key: warned.key } })).toMatchObject({ status: "POSTED" });
    // Another chart without 2150: *Setujui* waits for a liability, then posts against it.
    await resetDb();
    const { g: g2 } = await qaBooks();
    await db.account.delete({ where: { clientId_code: { clientId: g2.client.id, code: "2150" } } });
    const [telkom] = await august(g2);
    const e = await decide(g2, telkom.key).catch((x) => x);
    expect([e instanceof AccrualFieldError, e.field, e.message]).toEqual([true, "credit", NO_CREDIT]);
    const entry = await decide(g2, telkom.key, { creditCode: "2120" });
    expect((await db.journalLine.findMany({ where: { entryId: entry.id, credit: { gt: 0n } }, include: { account: true } })).map((l) => l.account.code)).toEqual(["2120"]);
  });
});
