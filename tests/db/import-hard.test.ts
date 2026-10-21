import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import { removeLedgerImport, removeStatementImport } from "@/lib/imports/remove";
import { db, makeGroup, resetDb } from "../helpers";
import { importSourceAccounts, postImport, stageImport } from "@/lib/ledger-import/post";
import { acceptMappings, MappingError } from "@/lib/ledger-import/mapping";
import { incomeStatement, trialBalance } from "@/lib/reports/ledger";
import { cashFlow, equityChanges } from "@/lib/reports/statements";
import { importStatement } from "@/lib/import/pipeline";
import { runControls } from "@/lib/controls";
import { resolveOpeningFinding } from "@/lib/findings";
import { dateOnly } from "@/lib/format";
import { makePdf, table } from "../pdf-fixture";

/**
 * Moving an existing client's books in (ledger / Neraca / TB imports, mapping, Saldo Awal), tested hard (cycle
 * 2026-10-21-uji-keras-pajak-impor-tutup): every figure is computed by hand in the comments first, and its failures were fixed in the same
 * cycle. Amounts are whole Rupiah.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;

async function xlsx(rows: unknown[][], sheet = "GL"): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function stage(g: G, data: Buffer, opts: { fileName?: string; date?: Date; sheet?: string } = {}) {
  const st = await stageImport(db, { firmId: g.firm.id, clientId: g.client.id, fileName: opts.fileName ?? `f-${Math.random()}.xlsx`, data, entityId: g.pt.entity.id, date: opts.date, sheet: opts.sheet });
  if (st.status !== "STAGED") throw new Error("not staged");
  return st;
}
/** Maps every still-unmapped source account of the draft by its source code. */
async function mapBy(g: G, importId: string, map: Record<string, string>) {
  const src = await importSourceAccounts(db, importId);
  const todo = src.filter((s) => !s.accountId);
  for (const s of todo) if (!map[s.code]) throw new Error(`no mapping for ${s.code} ${s.name}`);
  if (todo.length) await acceptMappings(db, g.client.id, todo.map((s) => ({ sourceAccountId: s.id, accountCode: map[s.code], method: "MANUAL" as const })));
}
const scopeOf = (g: G) => ({ clientId: g.client.id, entityIds: [g.pt.entity.id] });
const tbAt = async (g: G, d: Date) => Object.fromEntries((await trialBalance(db, scopeOf(g), d)).filter((r) => r.net !== 0n).map((r) => [r.account.code, r.net]));
const blocks = (st: { checks: { severity: string; code: string }[] }) => st.checks.filter((c) => c.severity === "BLOCK").map((c) => c.code);
const admin = async (g: G) => db.firmMember.create({ data: { firmId: g.firm.id, userId: randomUUID(), email: `a-${randomUUID()}@example.test`, name: "Admin", role: "ADMIN" } });

const mandiri = (period: string, rows: [string, string, string, string][]) =>
  makePdf([
    [
      ...table(800, [[[40, "PT Bank Mandiri (Persero) Tbk"]], [[40, "Nomor Rekening : 2222222222"]], [[40, `Periode : ${period}`]]]),
      ...table(740, [[[40, "Tanggal"], [130, "Keterangan"], [360, "Debit"], [440, "Kredit"], [520, "Saldo"]], ...rows.map(([d, k, cr, saldo]) => [[40, d], [130, k], ...(cr ? [[430, cr] as [number, string]] : []), [cr ? 510 : 500, saldo]] as [number, string][])]),
    ],
  ]);
const mandiriAug = mandiri("01/08/2026 - 31/08/2026", [
  ["01/08/2026", "SALDO AWAL", "", "50.000.000,00"],
  ["04/08/2026", "TRANSFER DARI PT MITRA UNGGAS", "20.000.000,00", "70.000.000,00"],
  ["31/08/2026", "SALDO AKHIR", "", "70.000.000,00"],
]);

const MAP: Record<string, string> = { "1-100": "1110", "1-110": "1120", "3-100": "3100", "3-200": "3200", "4-100": "4100", "6-100": "6120", "6-200": "6190" };

describe("a second GL export over months already imported", () => {
  beforeEach(resetDb);

  /**
   * File A (Jan–Mar 2026): JU-01 Kas 1.000.000 / Modal; JU-02 Kas 500.000 / Penjualan; JU-03 Beban Sewa 200.000 / Kas.
   * File B is the client's re-export Jan–Apr (other bytes: a print line), the same three vouchers + JU-04 Kas 300.000 / Penjualan.
   * The books at 30 Apr hold each voucher once: Kas 1.000.000 + 500.000 − 200.000 + 300.000 = 1.600.000, Penjualan −800.000.
   * Doubling JU-01..03 would make Kas 2.900.000 and Penjualan −1.300.000.
   */
  it("stops the re-export with GL_OVERLAP naming the repeated vouchers; April alone posts and each voucher counts once", async () => {
    const g = await makeGroup();
    const H = ["Tanggal", "No. Bukti", "Kode Akun", "Nama Akun", "Keterangan", "Debit", "Kredit"];
    const rows = [
      ["10/01/2026", "JU-01", "1-100", "Kas", "Setoran modal", 1_000_000, 0],
      ["10/01/2026", "JU-01", "3-100", "Modal Disetor", "Setoran modal", 0, 1_000_000],
      ["15/02/2026", "JU-02", "1-100", "Kas", "Penjualan tunai", 500_000, 0],
      ["15/02/2026", "JU-02", "4-100", "Penjualan", "Penjualan tunai", 0, 500_000],
      ["20/03/2026", "JU-03", "6-100", "Beban Sewa", "Sewa Maret", 200_000, 0],
      ["20/03/2026", "JU-03", "1-100", "Kas", "Sewa Maret", 0, 200_000],
    ];
    const ju04 = [["10/04/2026", "JU-04", "1-100", "Kas", "Penjualan tunai", 300_000, 0], ["10/04/2026", "JU-04", "4-100", "Penjualan", "Penjualan tunai", 0, 300_000]];
    const a = await stage(g, await xlsx([["Buku Besar PT Uji"], H, ...rows]), { fileName: "gl-q1.xlsx" });
    await mapBy(g, a.importId, MAP);
    await postImport(db, g.client.id, a.importId);

    const b = await stage(g, await xlsx([["Buku Besar PT Uji"], ["Dicetak 05/05/2026"], H, ...rows, ...ju04]), { fileName: "gl-jan-apr.xlsx" });
    const overlap = b.checks.find((c) => c.code === "GL_OVERLAP")!;
    expect({ severity: overlap.severity, acceptable: overlap.acceptable, refs: overlap.refs.length }).toEqual({ severity: "BLOCK", acceptable: undefined, refs: 6 });
    expect(overlap.message).toBe("PT Uji: 3 jurnal di file ini sudah tercatat dari impor buku besar gl-q1.xlsx (bukti JU-01 10 Jan 2026, bukti JU-02 15 Feb 2026, bukti JU-03 20 Mar 2026). Angkanya akan terhitung dua kali. Impor file yang hanya berisi periode yang belum ada, atau hapus dulu impor lama itu bila file ini penggantinya.");
    await expect(postImport(db, g.client.id, b.importId)).rejects.toThrow(/masalah BLOCK/);

    const apr = await stage(g, await xlsx([["Buku Besar PT Uji"], H, ...ju04]), { fileName: "gl-apr.xlsx" });
    expect(blocks(apr)).toEqual([]);
    await postImport(db, g.client.id, apr.importId);
    const tb = await tbAt(g, dateOnly(2026, 4, 30));
    expect({ kas: tb["1110"], penjualan: tb["4100"] }).toEqual({ kas: 1_600_000n, penjualan: -800_000n });
  });
});

describe("a source system's year-end closing entry inside the GL", () => {
  beforeEach(resetDb);

  /**
   * Accurate/Zahir post a closing journal at the year end ("Jurnal Penutup"): Dr Penjualan 1.000.000 / Cr Beban 700.000 / Cr Laba Ditahan 300.000.
   * Buku folds the year's P&L into 3200 itself (TB, Neraca), so the export's closing entry must not post as a 2025 movement:
   *   Laba Rugi 2025 = Penjualan 1.000.000 − Beban Sewa 700.000 = 300.000.
   * Posted as written, every P&L account nets to zero on 31 Dec 2025 and Laba Rugi 2025 shows 0.
   */
  it("leaves the closing entry out with a REVIEW, so the 2025 Laba Rugi stays 300.000 and folds into Saldo Laba once", async () => {
    const g = await makeGroup();
    const file = await xlsx([
      ["Tanggal", "No. Bukti", "Kode Akun", "Nama Akun", "Keterangan", "Debit", "Kredit"],
      ["10/03/2025", "JU-01", "1-100", "Kas", "Penjualan", 1_000_000, 0],
      ["10/03/2025", "JU-01", "4-100", "Penjualan", "Penjualan", 0, 1_000_000],
      ["20/06/2025", "JU-02", "6-100", "Beban Sewa", "Sewa", 700_000, 0],
      ["20/06/2025", "JU-02", "1-100", "Kas", "Sewa", 0, 700_000],
      ["31/12/2025", "JP-2025", "4-100", "Penjualan", "Jurnal penutup tahun 2025", 1_000_000, 0],
      ["31/12/2025", "JP-2025", "6-100", "Beban Sewa", "Jurnal penutup tahun 2025", 0, 700_000],
      ["31/12/2025", "JP-2025", "3-200", "Laba Ditahan", "Jurnal penutup tahun 2025", 0, 300_000],
    ]);
    const st = await stage(g, file);
    expect(blocks(st)).toEqual([]);
    const closing = st.checks.find((c) => c.code === "CLOSING_ENTRY")!;
    expect({ severity: closing.severity, refs: closing.refs }).toEqual({ severity: "REVIEW", refs: ["GL!6", "GL!7", "GL!8"] });
    expect(closing.message).toContain("bukti JP-2025 31 Des 2025 menutup laba rugi ke 3-200 Laba Ditahan");
    expect(st.entries).toBe(2);
    await mapBy(g, st.importId, MAP);
    await postImport(db, g.client.id, st.importId);
    const pl = await incomeStatement(db, scopeOf(g), dateOnly(2025, 1, 1), dateOnly(2025, 12, 31));
    expect({ revenue: pl.totals.revenue, net: pl.totals.netProfit }).toEqual({ revenue: 1_000_000n, net: 300_000n });
    // The year end still rolls the result into Saldo Laba exactly once.
    expect((await tbAt(g, dateOnly(2026, 1, 31)))["3200"]).toBe(-300_000n);
  });

  /** A year-end journal moving income to equity that does not close (Penjualan credited further) is an ordinary journal. */
  it("posts a year-end journal that doesn't close the year's income and expense", async () => {
    const g = await makeGroup();
    const st = await stage(g, await xlsx([
      ["Tanggal", "No. Bukti", "Kode Akun", "Nama Akun", "Keterangan", "Debit", "Kredit"],
      ["10/03/2025", "JU-01", "1-100", "Kas", "Penjualan", 1_000_000, 0],
      ["10/03/2025", "JU-01", "4-100", "Penjualan", "Penjualan", 0, 1_000_000],
      ["31/12/2025", "JU-99", "3-100", "Modal Disetor", "Koreksi", 50_000, 0],
      ["31/12/2025", "JU-99", "4-100", "Penjualan", "Koreksi", 0, 50_000],
    ]));
    expect(st.checks.map((c) => c.code)).not.toContain("CLOSING_ENTRY");
    expect(st.entries).toBe(2);
  });
});

describe("income and expense in a Saldo Awal from a file", () => {
  beforeEach(resetDb);

  /**
   * Typed Saldo Awal refuses income/expense accounts (rule 5: a result earned before it sits on 3200), so the Laba Rugi and the changes in
   * equity of every period after it agree. A one-date Debit/Kredit file per 30 Jun 2026: Kas 1.000.000 | Modal 700.000, Penjualan 500.000
   * (credit), Beban Sewa 200.000 (debit) — balanced. Refused on the draft (the names say income and expense) and again when posting.
   */
  it("Neraca: income and expense lines are a BLOCK on the draft and refused when posting", async () => {
    const g = await makeGroup();
    const st = await stage(g, await xlsx([["Kode Akun", "Nama Akun", "Debit", "Kredit"], ["1-100", "Kas", 1_000_000, 0], ["3-100", "Modal Disetor", 0, 700_000], ["4-100", "Penjualan", 0, 500_000], ["6-100", "Beban Sewa", 200_000, 0]], "Neraca"), { date: dateOnly(2026, 6, 30) });
    expect(st.mode).toBe("NERACA");
    expect(blocks(st)).toEqual(["OPENING_PL"]);
    await mapBy(g, st.importId, MAP);
    await expect(postImport(db, g.client.id, st.importId)).rejects.toThrow(/laba rugi/i);
    expect(await db.journalEntry.count({ where: { entityId: g.pt.entity.id } })).toBe(0);
  });

  /**
   * TB "Saldo 30/06/2026 | Mutasi | Saldo 31/12/2026" (signed, debit +):
   *   Kas 1.000 | 500 | 1.500 · Modal −700 | 0 | −700 · Penjualan −500 | −800 | −1.300 · Beban Sewa 200 | 300 | 500.
   * The opening column carries the Jan–Jun result (300): its income and expense are refused, the movement column's are fine.
   */
  it("TB opening mid-year: the opening column's income and expense are a BLOCK and refused when posting", async () => {
    const g = await makeGroup();
    const st = await stage(g, await xlsx([["Kode Akun", "Nama Akun", "Saldo 30/06/2026", "Mutasi", "Saldo 31/12/2026"], ["1-100", "Kas", 1000, 500, 1500], ["3-100", "Modal Disetor", -700, 0, -700], ["4-100", "Penjualan", -500, -800, -1300], ["6-100", "Beban Sewa", 200, 300, 500]], "TB"));
    const block = st.checks.find((c) => c.code === "OPENING_PL")!;
    expect({ severity: block.severity, refs: block.refs }).toEqual({ severity: "BLOCK", refs: ["TB!C4", "TB!C5"] });
    expect(block.message).toMatch(/^4-100 Penjualan, 6-100 Beban Sewa adalah akun-akun laba rugi di saldo awal 30 Jun 2026\. Saldo awal berisi posisi neraca/);
    await mapBy(g, st.importId, MAP);
    await expect(postImport(db, g.client.id, st.importId)).rejects.toThrow(/laba rugi/i);
    expect(await db.journalEntry.count({ where: { entityId: g.pt.entity.id } })).toBe(0);
  });

  /** The mapping can change after staging: a Neraca line mapped to income only afterwards is refused when posting. */
  it("Neraca: a line mapped to income or expense after staging is refused when posting", async () => {
    const g = await makeGroup();
    const st = await stage(g, await xlsx([["Kode Akun", "Nama Akun", "Saldo"], ["Aset"], ["1-100", "Kas", 1_000_000], ["Ekuitas"], ["3-100", "Modal Disetor", 700_000], ["3-901", "Lain-lain", 300_000]], "Neraca"), { date: dateOnly(2026, 6, 30) });
    expect(blocks(st)).toEqual([]);
    await mapBy(g, st.importId, { ...MAP, "3-901": "4100" });
    await expect(postImport(db, g.client.id, st.importId)).rejects.toThrow("Akun sumber 3-901 Lain-lain dipetakan ke 4100 Penjualan, akun laba rugi, di saldo awal 30 Jun 2026. Saldo awal berisi posisi neraca");
  });
});

describe("the sen-rounding residue of a Neraca Saldo Awal", () => {
  beforeEach(resetDb);

  /**
   * Neraca per 30 Jun 2026 in sen: Kas 500,40 + Piutang 500,40 = Modal 1.000,80. Whole Rupiah: 500 + 500 = 1.000 vs 1.001, so the entry
   * needs a 1 Rupiah residue. Saldo Awal is a balance-sheet position (rule 5): the residue goes to 3290 with a Temuan (debit 1), never to
   * 7190 (an expense) inside the OPENING entry, where it is a Laba Rugi flow of 2026 that the changes in equity leave out.
   */
  it("puts the residue on 3290 with a Temuan, no income or expense line in the OPENING entry", async () => {
    const g = await makeGroup();
    const st = await stage(g, await xlsx([["Kode Akun", "Nama Akun", "Saldo"], ["Aset"], ["1-100", "Kas", 500.4], ["1-200", "Piutang Usaha", 500.4], ["Ekuitas"], ["3-100", "Modal Disetor", 1000.8]], "Neraca"), { date: dateOnly(2026, 6, 30) });
    await mapBy(g, st.importId, { ...MAP, "1-200": "1130" });
    await postImport(db, g.client.id, st.importId);
    const opening = await db.journalEntry.findFirstOrThrow({ where: { entityId: g.pt.entity.id, kind: "OPENING" }, include: { lines: { include: { account: true } } } });
    expect(opening.lines.filter((l) => l.account.type === "PENDAPATAN" || l.account.type === "BEBAN").map((l) => [l.account.code, l.debit - l.credit])).toEqual([]);
    expect(opening.lines.filter((l) => l.account.code === "3290").map((l) => l.debit - l.credit)).toEqual([1n]);
    const finding = await db.finding.findFirstOrThrow({ where: { clientId: g.client.id } });
    expect({ kind: finding.kind, amount: finding.amount, date: finding.date, source: finding.sourceEntryId }).toEqual({ kind: "OPENING_DIFFERENCE", amount: 1n, date: dateOnly(2026, 6, 30), source: opening.id });
    expect(finding.question).toContain("membulatkan saldo file ke satuan mata uang menyisakan Rp 1");
    // The Temuan resolves like any opening difference: 3290 back to zero on the Saldo Awal date.
    await resolveOpeningFinding(db, { clientId: g.client.id, findingId: finding.id, accountCode: "3200", decision: "Pembulatan sen dari Neraca klien" });
    expect((await tbAt(g, dateOnly(2026, 6, 30)))["3290"]).toBeUndefined();
  });
});

describe("a trial balance whose period crosses the financial year end", () => {
  beforeEach(resetDb);

  /**
   * Calendar-year client. TB "Saldo 30/06/2025 | Mutasi | Saldo 31/03/2026" exported from a system that closes the year:
   *   opening 30 Jun 2025: Kas 1.000, Modal −500, Laba Ditahan −100, Penjualan −600, Beban 200 (H1 2025 result 400)
   *   H2 2025: Penjualan −500, Beban +100, Kas +400 → 2025 result 800, closed into Laba Ditahan (−900)
   *   Q1 2026: Penjualan −300, Beban +50, Kas +250
   *   closing 31 Mar 2026: Kas 1.650, Modal −500, Laba Ditahan −900, Penjualan −300, Beban 50
   *   movement = closing − opening: Kas 650, Modal 0, Laba Ditahan −800, Penjualan +300, Beban −150.
   * Posting the movement as one journal on 31 Mar 2026 makes Penjualan +300 (a debit revenue) and 3200 −1.300: the Neraca Saldo could
   * never equal the file's closing column (accounting-rules 15a), so the draft stops with TB_YEAR_END.
   */
  it("is refused on the draft with TB_YEAR_END", async () => {
    const g = await makeGroup();
    const file = await xlsx([
      ["Kode Akun", "Nama Akun", "Saldo 30/06/2025", "Mutasi", "Saldo 31/03/2026"],
      ["1-100", "Kas", 1000, 650, 1650],
      ["3-100", "Modal Disetor", -500, 0, -500],
      ["3-200", "Laba Ditahan", -100, -800, -900],
      ["4-100", "Penjualan", -600, 300, -300],
      ["6-100", "Beban Sewa", 200, -150, 50],
    ], "TB");
    const st = await stage(g, file);
    const block = st.checks.find((c) => c.code === "TB_YEAR_END")!;
    expect(block.severity).toBe("BLOCK");
    expect(block.message).toBe("Neraca saldo ini mencakup 1 Jul 2025 – 31 Mar 2026, melewati akhir tahun buku 31 Des 2025. Mutasinya dicatat sebagai satu jurnal per 31 Mar 2026, sehingga laba rugi sebelum 1 Jan 2026 masuk tahun buku berikutnya dan Neraca Saldo per 31 Mar 2026 tidak sama dengan file. Impor neraca saldo dengan saldo awal per 31 Des 2025, atau buku besar untuk periode ini.");
  });

  /** A TB from the last year end (the usual export) stays fine. */
  it("takes a TB whose opening is the last financial year end", async () => {
    const g = await makeGroup();
    const st = await stage(g, await xlsx([["Kode Akun", "Nama Akun", "Saldo 31/12/2025", "Mutasi", "Saldo 31/03/2026"], ["1-100", "Kas", 1000, 250, 1250], ["3-100", "Modal Disetor", -1000, 0, -1000], ["4-100", "Penjualan", 0, -300, -300], ["6-100", "Beban Sewa", 0, 50, 50]], "TB"));
    expect(blocks(st)).toEqual([]);
  });
});

describe("Saldo Awal from a Neraca file and the first bank statement", () => {
  beforeEach(resetDb);

  /**
   * Neraca per 31 Jul 2026: Bank Mandiri Giro 50.000.000 | Utang Bank 30.000.000, Modal 20.000.000. The entity's Mandiri Giro account
   * (GL 1102) then gets August's statement: opening 50.000.000, +20.000.000 → closing 70.000.000 (the same statement the typed Saldo Awal
   * test reconciles). The recon for August is "Saldo bank = buku besar = Rp 70.000.000" only if the Neraca's bank balance opens 1102, so a
   * Saldo Awal source account may map to the entity's own bank GL account.
   */
  it("August's bank reconciliation of Mandiri Giro passes after a Neraca Saldo Awal, as after a typed one", async () => {
    const g = await makeGroup();
    const st = await stage(g, await xlsx([["Kode Akun", "Nama Akun", "Saldo"], ["Aset"], ["1-110", "Bank Mandiri Giro 2222222222", 50_000_000], ["Liabilitas"], ["2-210", "Utang Bank", 30_000_000], ["Ekuitas"], ["3-100", "Modal Disetor", 20_000_000]], "Neraca"), { date: dateOnly(2026, 7, 31) });
    const src = await importSourceAccounts(db, st.importId);
    const bank = src.find((s) => s.code === "1-110")!;
    // Another entity's bank account (the owner's BRI, 1103) is refused; the entity's own (1102) is taken.
    await expect(acceptMappings(db, g.client.id, [{ sourceAccountId: bank.id, accountCode: "1103", method: "MANUAL" }])).rejects.toThrow("1103 BRI Tabungan (Andi) adalah rekening bank entitas lain");
    await acceptMappings(db, g.client.id, [{ sourceAccountId: bank.id, accountCode: "1102", method: "MANUAL" }]);
    await mapBy(g, st.importId, { ...MAP, "2-210": "2210" });
    await postImport(db, g.client.id, st.importId);

    await importStatement(db, { bankAccountId: g.pt.banks[1].id, fileName: "mandiri-agu.pdf", data: mandiriAug, provider: null });
    const recon = (await runControls(db, g.client.id, 2026, 8)).find((c) => c.key === `bank:${g.pt.banks[1].id}`)!;
    expect({ status: recon.status, detail: recon.detail }).toEqual({ status: "PASS", detail: "Saldo bank = buku besar = Rp 70.000.000" });

    // A later GL using the same source account would move the bank from a file: refused when posting, with the way out.
    const gl = await stage(g, await xlsx([["Tanggal", "Kode Akun", "Nama Akun", "Debit", "Kredit"], ["10/09/2026", "1-110", "Bank Mandiri Giro 2222222222", 100, 0], ["10/09/2026", "3-100", "Modal Disetor", 0, 100]]));
    await expect(postImport(db, g.client.id, gl.importId)).rejects.toThrow("Akun sumber 1-110 Bank Mandiri Giro 2222222222 dipetakan ke 1102 Mandiri Giro (PT Uji), akun rekening bank");
  });
});

describe("a GL file's own opening rows", () => {
  beforeEach(resetDb);

  /**
   * Accurate / Jurnal ledgers print each account's "Saldo Awal" on the period's first day. File: 01/01/2026 Saldo Awal Kas 10.000.000 /
   * Modal 7.000.000 / Laba Ditahan 3.000.000; 15/01/2026 JU-001 Beban Sewa 1.000.000 / Kas. Without a Saldo Awal yet, those rows are the
   * entity's Saldo Awal per 31 Dec 2025.
   * Perubahan Ekuitas per 31 Jan 2026: opening 10.000.000 (Modal 7.000.000 + Saldo laba 3.000.000), capital paid in 0, profit −1.000.000,
   * closing 9.000.000. Arus Kas: opening cash 10.000.000, financing 0. Posted as an ordinary 1 Jan movement, the statements say the owners
   * paid in 7.000.000 in January and the opening cash was 0.
   */
  it("posts them as Saldo Awal the day before, so Perubahan Ekuitas and Arus Kas open with them", async () => {
    const g = await makeGroup();
    const st = await stage(g, await xlsx([
      ["Tanggal", "No. Bukti", "Kode Akun", "Nama Akun", "Keterangan", "Debit", "Kredit"],
      ["01/01/2026", null, "1-100", "Kas", "Saldo Awal", 10_000_000, 0],
      ["01/01/2026", null, "3-100", "Modal Disetor", "Saldo Awal", 0, 7_000_000],
      ["01/01/2026", null, "3-200", "Laba Ditahan", "Saldo Awal", 0, 3_000_000],
      ["15/01/2026", "JU-001", "6-100", "Beban Sewa", "Sewa Januari", 1_000_000, 0],
      ["15/01/2026", "JU-001", "1-100", "Kas", "Sewa Januari", 0, 1_000_000],
    ]));
    expect(blocks(st)).toEqual([]);
    expect(st.checks.find((c) => c.code === "GL_OPENING")?.message).toBe("PT Uji: 3 baris saldo awal di file (1 Jan 2026) dicatat sebagai Saldo Awal per 31 Des 2025.");
    expect(st.checks.map((c) => c.code)).not.toContain("NO_OPENING");
    await mapBy(g, st.importId, MAP);
    await postImport(db, g.client.id, st.importId);
    const opening = await db.journalEntry.findFirstOrThrow({ where: { entityId: g.pt.entity.id, kind: "OPENING" } });
    expect({ date: opening.date, sourceRef: opening.sourceRef }).toEqual({ date: dateOnly(2025, 12, 31), sourceRef: "GL!2-4" });
    const imp = await db.ledgerImport.findUniqueOrThrow({ where: { id: st.importId } });
    expect(imp.periodStart).toEqual(dateOnly(2026, 1, 15));
    const eq = await equityChanges(db, scopeOf(g), dateOnly(2026, 1, 31));
    expect({ opening: eq.totals.opening, capital: eq.totals.capital, profit: eq.totals.profit, closing: eq.totals.closing }).toEqual({ opening: 10_000_000n, capital: 0n, profit: -1_000_000n, closing: 9_000_000n });
    const cf = await cashFlow(db, scopeOf(g), dateOnly(2026, 1, 31));
    expect({ openingCash: cf.openingCash, financing: cf.totals.FINANCING }).toEqual({ openingCash: 10_000_000n, financing: 0n });
  });

  /** A voucher memo that merely mentions "saldo awal" is an ordinary journal. */
  it("reads only voucher-less rows on the first date whose description is the opening phrase", async () => {
    const g = await makeGroup();
    const st = await stage(g, await xlsx([
      ["Tanggal", "No. Bukti", "Kode Akun", "Nama Akun", "Keterangan", "Debit", "Kredit"],
      ["01/01/2026", "JU-000", "1-100", "Kas", "Saldo Awal", 500, 0],
      ["01/01/2026", "JU-000", "3-100", "Modal Disetor", "Saldo Awal", 0, 500],
      ["15/01/2026", null, "1-100", "Kas", "Saldo Awal", 100, 0],
      ["15/01/2026", null, "3-100", "Modal Disetor", "Saldo Awal", 0, 100],
    ]));
    expect(st.checks.map((c) => c.code)).not.toContain("GL_OPENING");
    await mapBy(g, st.importId, MAP);
    await postImport(db, g.client.id, st.importId);
    expect(await db.journalEntry.count({ where: { entityId: g.pt.entity.id, kind: "OPENING" } })).toBe(0);
  });
});

describe("mapping to system accounts", () => {
  beforeEach(resetDb);

  /** 3290 is written only by a Saldo Awal difference with its Temuan (typed Saldo Awal refuses a 3290 line); 3900 and 7190 only by Buku. */
  it("refuses mapping a source account to 3290 Selisih Saldo Awal, 3900 or 7190, and never suggests them", async () => {
    const g = await makeGroup();
    const st = await stage(g, await xlsx([["Tanggal", "Kode Akun", "Nama Akun", "Debit", "Kredit"], ["15/01/2026", "1-100", "Kas", 100, 0], ["15/01/2026", "3-900", "Selisih Saldo Awal", 0, 100], ["15/01/2026", "7-190", "Selisih Pembulatan", 0, 0]]));
    const src = await importSourceAccounts(db, st.importId);
    const odd = src.find((s) => s.code === "3-900")!;
    for (const code of ["3290", "3900", "7190"]) {
      await expect(acceptMappings(db, g.client.id, [{ sourceAccountId: odd.id, accountCode: code, method: "MANUAL" }])).rejects.toThrow(MappingError);
    }
    // A new account named like a system one is a new account, never the system code.
    await acceptMappings(db, g.client.id, [{ sourceAccountId: odd.id, newAccount: { fsLine: "SALDO_LABA", name: "Selisih Saldo Awal" }, method: "MANUAL" }]);
    expect((await db.sourceAccount.findUniqueOrThrow({ where: { id: odd.id }, include: { account: true } })).account?.code).not.toBe("3290");
    expect(src.map((s) => s.suggestedCode).filter((c) => ["3290", "3900", "7190"].includes(c ?? ""))).toEqual([]);
  });

  it("refuses mapping a GL source account to a statement-tied bank GL account (1101)", async () => {
    const g = await makeGroup();
    const st = await stage(g, await xlsx([["Tanggal", "Kode Akun", "Nama Akun", "Debit", "Kredit"], ["15/01/2026", "1-110", "Bank BCA", 100, 0], ["15/01/2026", "3-100", "Modal Disetor", 0, 100]]));
    const src = await importSourceAccounts(db, st.importId);
    await expect(acceptMappings(db, g.client.id, [{ sourceAccountId: src.find((s) => s.code === "1-110")!.id, accountCode: "1101", method: "MANUAL" }])).rejects.toThrow(MappingError);
    // The rule suggestion for a bank name is the ledger-only bank account.
    expect(src.find((s) => s.code === "1-110")!.suggestedCode).toBe("1120");
  });
});

describe("GL rows inside an opening bridge's span", () => {
  beforeEach(resetDb);

  const map = { "10-100": "1110", "20-100": "2110", "40-100": "4100", "60-100": "6190", "1-100": "1110", "1-200": "1130", "2-100": "2110", "3-100": "3100", "3-200": "3200" };
  const GL = [
    ["Tanggal", "Kode Akun", "Nama Akun", "Debit", "Kredit"],
    ["15/02/2023", "10-100", "Kas", 100, 0], ["15/02/2023", "40-100", "Penjualan", 0, 100],
    ["10/06/2023", "60-100", "Beban Umum", 30, 0], ["10/06/2023", "10-100", "Kas", 0, 30],
    ["20/11/2023", "60-100", "Beban Umum", 20, 0], ["20/11/2023", "20-100", "Utang Usaha", 0, 20],
  ];
  const ANCHOR = [["Kode Akun", "Nama Akun", "Saldo"], ["Aset"], ["1-100", "Kas", 1070], ["1-200", "Piutang Usaha", 200], ["Liabilitas"], ["2-100", "Utang Usaha", 120], ["Ekuitas"], ["3-100", "Modal Disetor", 1000], ["3-200", "Saldo Laba", 150]];
  const DEC = [["Tanggal", "Kode Akun", "Nama Akun", "Debit", "Kredit"], ["10/12/2023", "60-100", "Beban Umum", 40, 0], ["10/12/2023", "10-100", "Kas", 0, 40]];
  async function bridged(g: G) {
    const gl = await stage(g, await xlsx(GL));
    await mapBy(g, gl.importId, map);
    await postImport(db, g.client.id, gl.importId);
    const anchor = await stage(g, await xlsx(ANCHOR, "S"), { date: dateOnly(2023, 12, 31) });
    await mapBy(g, anchor.importId, map);
    await postImport(db, g.client.id, anchor.importId);
    expect((await tbAt(g, dateOnly(2023, 12, 31)))["1110"]).toBe(1070n);
  }

  /**
   * GL Feb–Nov 2023 (15 Feb Kas 100 / Penjualan; 10 Jun Beban 30 / Kas; 20 Nov Beban 20 / Utang). Neraca anchor 31 Dec 2023: Kas 1.070,
   * Piutang 200 | Utang 120, Modal 1.000, Saldo Laba 150 → bridge Saldo Awal per 14 Feb 2023 so the Neraca at 31 Dec 2023 equals the file.
   * A later GL for December 2023 (10 Dec Beban 40 / Kas) lands inside the span the bridge already reversed: Kas at 31 Dec would become
   * 1.030 ≠ the anchor's 1.070. Like TB_COVERS, it stops with BRIDGE_COVERS.
   */
  it("stops a later GL inside the span with BRIDGE_COVERS, so the Neraca at the anchor date still equals the file", async () => {
    const g = await makeGroup();
    await bridged(g);
    const dec = await stage(g, await xlsx(DEC));
    const block = dec.checks.find((c) => c.code === "BRIDGE_COVERS")!;
    expect({ severity: block.severity, refs: block.refs }).toEqual({ severity: "BLOCK", refs: ["GL!2", "GL!3"] });
    expect(block.message).toContain("PT Uji: 1 jurnal bertanggal s.d. 31 Des 2023, periode yang saldo awalnya dibangun dari Neraca");
    await expect(postImport(db, g.client.id, dec.importId)).rejects.toThrow(/masalah BLOCK/);
    expect((await tbAt(g, dateOnly(2023, 12, 31)))["1110"]).toBe(1070n);
  });

  /** A draft staged before the bridge existed carries no BRIDGE_COVERS: posting checks again and refuses it. */
  it("refuses, when posting, a draft staged before the bridge was built", async () => {
    const g = await makeGroup();
    const gl = await stage(g, await xlsx(GL));
    await mapBy(g, gl.importId, map);
    await postImport(db, g.client.id, gl.importId);
    const dec = await stage(g, await xlsx(DEC));
    expect(blocks(dec)).toEqual([]);
    const anchor = await stage(g, await xlsx(ANCHOR, "S"), { date: dateOnly(2023, 12, 31) });
    await mapBy(g, anchor.importId, map);
    await postImport(db, g.client.id, anchor.importId);
    await expect(postImport(db, g.client.id, dec.importId)).rejects.toThrow(/periode yang saldo awalnya dibangun dari Neraca .* \(opening bridge\)\. Impor buku besar mulai 1 Jan 2024/);
  });

  /**
   * A statement posted after the bridge inside its span (Mandiri, 4 Dec 2023, +20.000.000) is not part of the bridge: removing it restores
   * the anchor, so it is allowed. The GL the bridge was built on still can't be removed under it.
   */
  it("removes an import posted after the bridge inside its span, and still refuses one the bridge took in", async () => {
    const g = await makeGroup();
    await bridged(g);
    const pdf = mandiri("01/12/2023 - 31/12/2023", [
      ["01/12/2023", "SALDO AWAL", "", "50.000.000,00"],
      ["04/12/2023", "TRANSFER DARI PT MITRA UNGGAS", "20.000.000,00", "70.000.000,00"],
      ["31/12/2023", "SALDO AKHIR", "", "70.000.000,00"],
    ]);
    const { importId } = await importStatement(db, { bankAccountId: g.pt.banks[1].id, fileName: "mandiri-des.pdf", data: pdf, provider: null });
    const actor = await admin(g);
    await removeStatementImport(db, { clientId: g.client.id, importId: importId!, reason: "Rekening koran sudah ada di Neraca", actor: { id: actor.id, role: "ADMIN" } });
    expect((await tbAt(g, dateOnly(2023, 12, 31)))["1110"]).toBe(1070n);
    const first = await db.ledgerImport.findFirstOrThrow({ where: { clientId: g.client.id, mode: "LEDGER" } });
    await expect(removeLedgerImport(db, { clientId: g.client.id, importId: first.id, reason: "Buku besar salah, diganti", actor: { id: actor.id, role: "ADMIN" } })).rejects.toThrow(/termasuk jurnal dari impor ini/);
  });
});
