import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import { db, makeGroup, resetDb } from "../helpers";
import { acceptCheck, importSourceAccounts, postImport, stageImport } from "@/lib/ledger-import/post";
import { acceptMappings } from "@/lib/ledger-import/mapping";
import { incomeStatement, trialBalance } from "@/lib/reports/ledger";
import { equityChanges } from "@/lib/reports/statements";
import { postSuspenseCorrection, suspenseCorrections } from "@/lib/adjust/suspense";
import { removeLedgerImport } from "@/lib/imports/remove";
import { listEvents } from "@/lib/audit";
import { postOpening } from "@/lib/opening";
import { resolveOpeningFinding } from "@/lib/findings";
import { dateOnly } from "@/lib/format";

/**
 * Moving books in, tested hard (cycle 2026-10-21-uji-keras-pajak-impor-tutup), second batch: Saldo Awal from files against a GL's own
 * opening rows, a 1999 difference inside a Saldo Awal, and the cases that must hold. Its failures were fixed in the same cycle.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;

async function xlsx(sheets: Record<string, unknown[][]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function stage(g: G, data: Buffer, opts: { fileName?: string; date?: Date; sheet?: string } = {}) {
  const st = await stageImport(db, { firmId: g.firm.id, clientId: g.client.id, fileName: opts.fileName ?? `f-${Math.random()}.xlsx`, data, entityId: g.pt.entity.id, date: opts.date, sheet: opts.sheet });
  if (st.status !== "STAGED") throw new Error("not staged");
  return st;
}
async function mapBy(g: G, importId: string, map: Record<string, string>) {
  const todo = (await importSourceAccounts(db, importId)).filter((s) => !s.accountId);
  for (const s of todo) if (!map[s.code]) throw new Error(`no mapping for ${s.code} ${s.name}`);
  if (todo.length) await acceptMappings(db, g.client.id, todo.map((s) => ({ sourceAccountId: s.id, accountCode: map[s.code], method: "MANUAL" as const })));
}
async function acceptAll(importId: string, clientId: string) {
  for (const c of await db.importCheck.findMany({ where: { ledgerImportId: importId, severity: "BLOCK" } })) await acceptCheck(db, clientId, c.id);
}
const scopeOf = (g: G) => ({ clientId: g.client.id, entityIds: [g.pt.entity.id] });
const tbAt = async (g: G, d: Date) => Object.fromEntries((await trialBalance(db, scopeOf(g), d)).filter((r) => r.net !== 0n).map((r) => [r.account.code, r.net]));
const MAP: Record<string, string> = { "1-100": "1110", "1-101": "1110", "3-100": "3100", "3-200": "3200", "3-210": "3200", "4-100": "4100", "6-100": "6120", "2-100": "2110" };
const H = ["Tanggal", "No. Bukti", "Kode Akun", "Nama Akun", "Keterangan", "Debit", "Kredit"];

describe("Saldo Awal from a Neraca, then the GL's own opening rows", () => {
  beforeEach(resetDb);

  /**
   * The draft's NO_OPENING advice: "impor Neraca per <day before> sebagai Saldo Awal". The accountant imports the Neraca per 31 Dec 2025
   * (Kas 10.000.000 | Modal 7.000.000, Laba Ditahan 3.000.000), then the client's GL Jan 2026, whose export opens every account with a
   * "Saldo Awal" row dated 01/01/2026. Those rows are after the Saldo Awal date, so BEFORE_OPENING doesn't catch them: GL_OPENING_ROWS
   * does. Kas per 31 Jan 2026 must be 10.000.000 − 1.000.000 = 9.000.000 (and Modal 7.000.000), not 19.000.000 / 14.000.000.
   */
  it("stops on the file's opening rows (GL_OPENING_ROWS); accepted, they stay out and no balance counts twice", async () => {
    const g = await makeGroup();
    const neraca = await stage(g, await xlsx({ Neraca: [["Kode Akun", "Nama Akun", "Saldo"], ["Aset"], ["1-100", "Kas", 10_000_000], ["Ekuitas"], ["3-100", "Modal Disetor", 7_000_000], ["3-200", "Laba Ditahan", 3_000_000]] }), { date: dateOnly(2025, 12, 31) });
    await mapBy(g, neraca.importId, MAP);
    await postImport(db, g.client.id, neraca.importId);

    const gl = await stage(g, await xlsx({ GL: [
      H,
      ["01/01/2026", null, "1-100", "Kas", "Saldo Awal", 10_000_000, 0],
      ["01/01/2026", null, "3-100", "Modal Disetor", "Saldo Awal", 0, 7_000_000],
      ["01/01/2026", null, "3-200", "Laba Ditahan", "Saldo Awal", 0, 3_000_000],
      ["15/01/2026", "JU-001", "6-100", "Beban Sewa", "Sewa Januari", 1_000_000, 0],
      ["15/01/2026", "JU-001", "1-100", "Kas", "Sewa Januari", 0, 1_000_000],
    ] }));
    // The file's opening rows are named and stop the draft; accepting leaves them out, the rest of the file posts.
    const block = gl.checks.find((c) => c.code === "GL_OPENING_ROWS")!;
    expect({ severity: block.severity, acceptable: block.acceptable, refs: block.refs }).toEqual({ severity: "BLOCK", acceptable: true, refs: ["GL!2", "GL!3", "GL!4"] });
    expect(block.message).toContain("padahal PT Uji sudah punya Saldo Awal per 31 Des 2025");
    await mapBy(g, gl.importId, MAP);
    await expect(postImport(db, g.client.id, gl.importId)).rejects.toThrow(/masalah BLOCK/);
    await acceptAll(gl.importId, g.client.id);
    await postImport(db, g.client.id, gl.importId);
    const tb = await tbAt(g, dateOnly(2026, 1, 31));
    expect({ kas: tb["1110"], modal: tb["3100"] }).toEqual({ kas: 9_000_000n, modal: -7_000_000n });
  });
});

describe("an unbalanced Neraca accepted as Saldo Awal, then its 1999 correction", () => {
  beforeEach(resetDb);

  /**
   * Neraca per 31 May 2026: Kas 1.000.000 | Modal 900.000 → 100.000 short; accepted, the difference sits on 1999 (credit 100.000) inside the
   * OPENING entry. The accountant decides it is Saldo Laba and posts the offered correction (1999 Dr / 3200 Cr 100.000).
   * A typed Saldo Awal with the same numbers puts the difference on 3290 + Temuan, resolved by an OPENING entry on the Saldo Awal date, so
   * Perubahan Ekuitas 2026 opens at 1.000.000 with no in-year "koreksi saldo laba". The same decision through the file route should give the
   * same statement: opening 1.000.000, retained-row 0, closing 1.000.000. So the correction of a 1999 line inside a Saldo Awal is itself an
   * OPENING entry on that date, and like a Temuan it can't move the difference to income or expense.
   */
  it("posts the correction as an OPENING entry on the Saldo Awal date: Perubahan Ekuitas 2026 opens at 1.000.000 either route", async () => {
    const g = await makeGroup();
    const st = await stage(g, await xlsx({ Neraca: [["Kode Akun", "Nama Akun", "Saldo"], ["Aset"], ["1-100", "Kas", 1_000_000], ["Ekuitas"], ["3-100", "Modal Disetor", 900_000]] }), { date: dateOnly(2026, 5, 31) });
    const unbalanced = st.checks.find((c) => c.code === "UNBALANCED");
    expect(unbalanced?.amount).toBe(100_000n);
    await acceptAll(st.importId, g.client.id);
    await mapBy(g, st.importId, MAP);
    await postImport(db, g.client.id, st.importId);

    const [c] = await suspenseCorrections(db, g.client.id, 2026, 5);
    expect(c.lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([["1999", "100000", "0"], ["", "0", "100000"]]);
    await expect(postSuspenseCorrection(db, { firmId: g.firm.id, clientId: g.client.id, lineId: c.lineId, accounts: ["1999", "4100"] })).rejects.toThrow("Saldo awal tidak berisi laba rugi");
    const entry = await postSuspenseCorrection(db, { firmId: g.firm.id, clientId: g.client.id, lineId: c.lineId, accounts: ["1999", "3200"] });
    const posted = await db.journalEntry.findUniqueOrThrow({ where: { id: entry.id } });
    // The decision is part of the Saldo Awal: an OPENING entry on its date, like a Temuan's resolution.
    expect({ kind: posted.kind, date: posted.date }).toEqual({ kind: "OPENING", date: dateOnly(2026, 5, 31) });

    const eq = await equityChanges(db, scopeOf(g), dateOnly(2026, 12, 31));
    expect({ opening: eq.totals.opening, retained: eq.totals.retained, closing: eq.totals.closing }).toEqual({ opening: 1_000_000n, retained: 0n, closing: 1_000_000n });
  });

  it("(reference) the typed Saldo Awal route gives opening 1.000.000 and no in-year correction", async () => {
    const g = await makeGroup();
    const res = await postOpening(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 5, 31), lines: [{ accountCode: "1110", debit: "1000000", credit: "" }, { accountCode: "3100", debit: "", credit: "900000" }] });
    await resolveOpeningFinding(db, { clientId: g.client.id, findingId: (await db.finding.findFirstOrThrow({ where: { clientId: g.client.id } })).id, decision: "Laba tahun lalu belum dicatat di Neraca klien", accountCode: "3200" });
    expect(res.finding?.amount).toBe(-100_000n);
    const eq = await equityChanges(db, scopeOf(g), dateOnly(2026, 12, 31));
    expect({ opening: eq.totals.opening, retained: eq.totals.retained, closing: eq.totals.closing }).toEqual({ opening: 1_000_000n, retained: 0n, closing: 1_000_000n });
  });
});

describe("cases that must hold", () => {
  beforeEach(resetDb);

  /**
   * CSV (semicolon) GL, Indonesian numbers: thousands with dots, decimal comma, a negative in parentheses, an ISO date beside d/m dates, a
   * Total row. Rows:
   *   05/01 JU-01 Kas Dr 1.500.000,00 / Modal Cr 1.500.000,00
   *   10/01 JU-02 Beban Sewa Dr (250.000) → posts as Cr 250.000 (REVIEW) / Kas Dr 250.000
   *   2026-01-20 JU-03 Beban Sewa Dr 400.000 / Kas Cr 400.000
   *   25/01 JU-04 Kas Dr 100.000 / Penjualan Cr 100.000
   *   Total as written: Dr 1.500.000 − 250.000 + 250.000 + 400.000 + 100.000 = 2.000.000; Cr 1.500.000 + 400.000 + 100.000 = 2.000.000.
   * TB 31 Jan: Kas 1.500.000 + 250.000 − 400.000 + 100.000 = 1.450.000; Modal −1.500.000; Beban Sewa 150.000; Penjualan −100.000.
   */
  it("reads separators, parentheses, two date formats and a Total row, and every line drills to its CSV row", async () => {
    const g = await makeGroup();
    const file = Buffer.from([
      "Tanggal;No. Bukti;Kode Akun;Nama Akun;Keterangan;Debit;Kredit",
      "05/01/2026;JU-01;1-100;Kas;Setoran modal;1.500.000,00;",
      "05/01/2026;JU-01;3-100;Modal Disetor;Setoran modal;;1.500.000,00",
      "10/01/2026;JU-02;6-100;Beban Sewa;Koreksi sewa;(250.000);",
      "10/01/2026;JU-02;1-100;Kas;Koreksi sewa;250.000;",
      "2026-01-20;JU-03;6-100;Beban Sewa;Sewa;400.000;",
      "2026-01-20;JU-03;1-100;Kas;Sewa;;400.000",
      "25/01/2026;JU-04;1-100;Kas;Penjualan tunai;100.000;",
      "25/01/2026;JU-04;4-100;Penjualan;Penjualan tunai;;100.000",
      ";;;Total;;2.000.000,00;2.000.000,00",
      "",
    ].join("\n"));
    const st = await stage(g, file, { fileName: "gl.csv" });
    expect(st.entries).toBe(4);
    expect(st.checks.filter((c) => c.severity === "BLOCK")).toEqual([]);
    expect(st.checks.map((c) => c.code)).toEqual(expect.arrayContaining(["NEGATIVE_AMOUNT", "TOTAL_OK"]));
    await mapBy(g, st.importId, MAP);
    await postImport(db, g.client.id, st.importId);
    expect(await tbAt(g, dateOnly(2026, 1, 31))).toEqual({ "1110": 1_450_000n, "3100": -1_500_000n, "4100": -100_000n, "6120": 150_000n });
    const jan20 = await db.journalEntry.findFirstOrThrow({ where: { ledgerImportId: st.importId, date: dateOnly(2026, 1, 20) }, include: { lines: { include: { account: true, sourceAccount: true } } } });
    expect(jan20.sourceRef).toBe("CSV!6-7");
    expect(jan20.lines.map((l) => [l.account.code, l.sourceAccount?.code, l.sourceRef, l.debit, l.credit]).sort()).toEqual([["1110", "1-100", "CSV!7", 0n, 400_000n], ["6120", "6-100", "CSV!6", 400_000n, 0n]]);
  });

  /** GL Dec 2025 – Jan 2026 for a calendar-year client: Dec 15 Kas 1.000 / Penjualan; Jan 15 Beban 300 / Kas. TB 31 Jan 2026: 3200 −1.000 (folded), no 4100; Laba Rugi Jan −300. */
  it("a GL crossing the year end folds last year's result into Saldo Laba", async () => {
    const g = await makeGroup();
    const st = await stage(g, await xlsx({ GL: [H, ["15/12/2025", "A", "1-100", "Kas", "", 1000, 0], ["15/12/2025", "A", "4-100", "Penjualan", "", 0, 1000], ["15/01/2026", "B", "6-100", "Beban Sewa", "", 300, 0], ["15/01/2026", "B", "1-100", "Kas", "", 0, 300]] }));
    await mapBy(g, st.importId, MAP);
    await postImport(db, g.client.id, st.importId);
    expect(await tbAt(g, dateOnly(2026, 1, 31))).toEqual({ "1110": 700n, "3200": -1000n, "6120": 300n });
    expect((await incomeStatement(db, scopeOf(g), dateOnly(2026, 1, 1), dateOnly(2026, 1, 31))).totals.netProfit).toBe(-300n);
  });

  /** A voucher split over two sheets: sheet A holds JU-01's debit (Kas 1.000), sheet B its credit (Modal 1.000). Each sheet is unbalanced, accepted; 1999 nets to 0, no correction left. */
  it("a voucher split across two sheets nets on 1999 once both are in", async () => {
    const g = await makeGroup();
    const file = await xlsx({ A: [H, ["10/01/2026", "JU-01", "1-100", "Kas", "", 1000, 0]], B: [H, ["10/01/2026", "JU-01", "3-100", "Modal Disetor", "", 0, 1000]] });
    for (const sheet of ["A", "B"]) {
      const st = await stage(g, file, { sheet });
      await acceptAll(st.importId, g.client.id);
      await mapBy(g, st.importId, MAP);
      await postImport(db, g.client.id, st.importId);
    }
    expect(await tbAt(g, dateOnly(2026, 1, 31))).toEqual({ "1110": 1000n, "3100": -1000n });
    expect(await suspenseCorrections(db, g.client.id, 2026, 1)).toEqual([]);
  });

  /** A remap after posting moves nothing already posted (Riwayat says so); the next file follows the new mapping. Two source cash accounts share 1110 and keep their own source. */
  it("remap after posting, two sources on one account", async () => {
    const g = await makeGroup();
    const jan = await stage(g, await xlsx({ GL: [H, ["10/01/2026", "A", "6-100", "Beban Sewa", "", 100, 0], ["10/01/2026", "A", "1-100", "Kas Kecil", "", 0, 60], ["10/01/2026", "A", "1-101", "Kas Besar", "", 0, 40]] }));
    await mapBy(g, jan.importId, MAP);
    await postImport(db, g.client.id, jan.importId);
    const sewa = (await importSourceAccounts(db, jan.importId)).find((s) => s.code === "6-100")!;
    await acceptMappings(db, g.client.id, [{ sourceAccountId: sewa.id, accountCode: "6190", method: "MANUAL" }]);
    const feb = await stage(g, await xlsx({ GL: [H, ["10/02/2026", "B", "6-100", "Beban Sewa", "", 50, 0], ["10/02/2026", "B", "1-100", "Kas Kecil", "", 0, 50]] }));
    await postImport(db, g.client.id, feb.importId);
    expect(await tbAt(g, dateOnly(2026, 2, 28))).toEqual({ "1110": -150n, "6120": 100n, "6190": 50n });
    const kas = await db.journalLine.findMany({ where: { account: { code: "1110" }, entityId: g.pt.entity.id }, include: { sourceAccount: true }, orderBy: { sourceRef: "asc" } });
    expect(new Set(kas.map((l) => l.sourceAccount?.code))).toEqual(new Set(["1-100", "1-101"]));
    expect((await listEvents(db, g.client.id)).some((e) => e.kind === "MAPPING")).toBe(true);
  });

  /** Neraca per 31 Dec 2025 with Laba Ditahan and Laba Tahun Berjalan: both suggested to 3200; Perubahan Ekuitas 2026 opens at the Neraca's equity (7.000 + 2.000 + 1.000). */
  it("a year-end Neraca's retained and current-year earnings open Saldo Laba", async () => {
    const g = await makeGroup();
    const st = await stage(g, await xlsx({ Neraca: [["Kode Akun", "Nama Akun", "Saldo"], ["Aset"], ["1-100", "Kas", 10_000], ["Ekuitas"], ["3-100", "Modal Disetor", 7_000], ["3-200", "Laba Ditahan", 2_000], ["3-210", "Laba Tahun Berjalan", 1_000]] }), { date: dateOnly(2025, 12, 31) });
    const src = await importSourceAccounts(db, st.importId);
    expect(src.filter((s) => s.code.startsWith("3-2")).map((s) => s.suggestedCode)).toEqual(["3200", "3200"]);
    await mapBy(g, st.importId, MAP);
    await postImport(db, g.client.id, st.importId);
    const eq = await equityChanges(db, scopeOf(g), dateOnly(2026, 3, 31));
    expect({ opening: eq.totals.opening, closing: eq.totals.closing }).toEqual({ opening: 10_000n, closing: 10_000n });
  });

  /** Removing a GL import also removes its posted 1999 correction (it carries the import) and returns the books to zero; the file then stages again. */
  it("remove a GL import with a posted 1999 correction", async () => {
    const g = await makeGroup();
    const admin = await db.firmMember.create({ data: { firmId: g.firm.id, userId: randomUUID(), email: `a-${randomUUID()}@example.test`, name: "Admin", role: "ADMIN" } });
    const file = await xlsx({ GL: [H, ["10/01/2026", "A", "6-100", "Beban Sewa", "", 100, 0], ["10/01/2026", "A", "1-100", "Kas", "", 0, 90]] });
    const st = await stage(g, file, { fileName: "gl.xlsx" });
    await acceptAll(st.importId, g.client.id);
    await mapBy(g, st.importId, MAP);
    await postImport(db, g.client.id, st.importId);
    const [c] = await suspenseCorrections(db, g.client.id, 2026, 1);
    await postSuspenseCorrection(db, { firmId: g.firm.id, clientId: g.client.id, lineId: c.lineId, accounts: ["1999", "1110"] });
    expect(await tbAt(g, dateOnly(2026, 1, 31))).toEqual({ "1110": -100n, "6120": 100n });
    await removeLedgerImport(db, { clientId: g.client.id, importId: st.importId, reason: "Versi file salah, diganti", actor: { id: admin.id, role: "ADMIN" } });
    expect(await tbAt(g, dateOnly(2026, 1, 31))).toEqual({});
    expect((await stage(g, file, { fileName: "gl.xlsx" })).entries).toBe(1);
  });
});
