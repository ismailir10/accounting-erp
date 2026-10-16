import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { detectTables, readSheets, readTable } from "@/lib/ledger-import/read";
import { planLedger, planNeraca, planTb, type EntityInfo } from "@/lib/ledger-import/check";
import type { LedgerRow, NeracaRow, NeracaTotal } from "@/lib/ledger-import/types";
import { dateOnly } from "@/lib/format";

/**
 * Independent reference for accounting-rules 6a (cycle 2026-10-12-single-rounding): every source amount, as written (≤ 6 decimals — the
 * documented precision of a spreadsheet number), is rounded ONCE, half-up (half away from zero), to the entity currency's minor unit; the
 * entry's residue is one 7190 line (rounded total − Σ rounded lines); an unbalanced source is an imbalance (1999 only if accepted).
 * The reference is plain BigInt arithmetic on the decimal text and shares no code with lib/money. Buku is driven through its real seam:
 * an Excel workbook → the reader → planLedger / planNeraca / planTb. Synthetic amounts only.
 */
const EXP: Record<string, number> = { IDR: 0, JPY: 0, SGD: 2, USD: 2 };

/** "75.4999" → 754999n at 10^6, signed. */
function micro(text: string): bigint {
  const neg = text.startsWith("-");
  const [i, f = ""] = text.replace("-", "").split(".");
  if (f.length > 6) throw new Error("beyond the documented precision");
  const v = BigInt(i + f.padEnd(6, "0"));
  return neg ? -v : v;
}
/** Half away from zero to 10^e minor units. */
function refRound(m: bigint, e: number): bigint {
  const unit = 10n ** BigInt(6 - e);
  const abs = m < 0n ? -m : m;
  const q = abs / unit + ((abs % unit) * 2n >= unit ? 1n : 0n);
  return m < 0n ? -q : q;
}
/** Reference journal: debit-positive source amounts → rounded lines, 7190 residue, imbalance (in minor units). */
function reference(amounts: string[], currency: string) {
  const e = EXP[currency];
  const lines = amounts.map((a) => refRound(micro(a), e));
  const total = refRound(amounts.reduce((s, a) => s + micro(a), 0n), e);
  return { lines, rounding: total - lines.reduce((s, l) => s + l, 0n), imbalance: total };
}

/** micro-units → decimal text, the form a source amount is written in. */
function text(m: bigint): string {
  const a = m < 0n ? -m : m;
  return `${m < 0n ? "-" : ""}${a / 1_000_000n}.${String(a % 1_000_000n).padStart(6, "0")}`;
}

async function workbook(rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("GL");
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
/** One journal of debit-positive source amounts through the real reader and planner. Each amount is a number cell, as Excel stores it. */
async function throughBuku(amounts: string[], currency: string) {
  const header = ["Entitas", "Tanggal", "Kode Akun", "Nama Akun", "Debit", "Kredit"];
  const body = amounts.map((a, i) => {
    const n = Number(a);
    return ["UJI", new Date(Date.UTC(2026, 4, 31)), `1-${1000 + i}`, `Akun ${i}`, n > 0 ? n : 0, n < 0 ? -n : 0];
  });
  const sheets = await readSheets("gl.xlsx", await workbook([header, ...body]));
  const read = readTable(sheets, detectTables(sheets)[0]);
  const ent = new Map<string, EntityInfo>([["UJI", { entityId: "e", name: "PT Uji", currency }]]);
  const plan = planLedger(read.rows as LedgerRow[], { entities: ent, currencyMode: "FUNCTIONAL" });
  return { entry: plan.entries[0], checks: plan.checks };
}

describe("rounding seam vs an independent rule-6a reference", () => {
  it("the payable example: 100.51 = 75.4999 + 25.0101 posts 101 / 75 / 25 and credits 1 to 7190; no 1999", async () => {
    const src = ["100.51", "-75.4999", "-25.0101"];
    const ref = reference(src, "IDR");
    expect(ref).toEqual({ lines: [101n, -75n, -25n], rounding: -1n, imbalance: 0n }); // the expectation, from the source alone
    const { entry, checks } = await throughBuku(src, "IDR");
    expect(entry.lines.map((l) => l.amount)).toEqual(ref.lines); // the payable is 75, not 76 (old two-stage rounding)
    expect(entry.rounding).toBe(ref.rounding); // 7190 credit 1 — visible, not absorbed
    expect(entry.imbalance).toBe(0n);
    expect(checks.filter((c) => c.code === "UNBALANCED")).toEqual([]); // nothing for 1999
  });

  it("the same payable in a Neraca (presentation signs) through the reader and planNeraca", async () => {
    const ref = reference(["100.51", "-75.4999", "-25.0101"], "IDR");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("N");
    [["PT Uji"], ["Balance Sheet"], ["Date", null, "31/05/2026"], ["Assets"], ["1-1000", "Bank", 100.51], ["Total Assets", null, 100.51], ["Liability & Equity"], ["2-2000", "Accounts Payable", 75.4999], ["3-3000", "Share Capital", 25.0101], ["Total Liability & Equity", null, 100.51]].forEach((r) => ws.addRow(r));
    const sheets = await readSheets("neraca.xlsx", Buffer.from(await wb.xlsx.writeBuffer()));
    const read = readTable(sheets, detectTables(sheets)[0]);
    const p = planNeraca(read.rows as NeracaRow[], read.totals as NeracaTotal[], { entityKey: "", entity: { entityId: "e", name: "PT Uji", currency: "IDR" }, date: dateOnly(2026, 5, 31), sheet: "N" });
    expect(p.entries[0].lines.map((l) => l.amount)).toEqual(ref.lines);
    expect(p.entries[0].rounding).toBe(ref.rounding);
    expect(p.entries[0].imbalance).toBe(0n);
  });

  // Signed amounts at and around every half boundary, within 6 decimals; each journal is balanced in the source.
  const grid = ["0.5", "1.5", "2.5", "0.495", "0.4949", "0.4951", "0.4999", "0.5001", "0.505", "0.5049", "1.004999", "1.005", "75.4999", "1234.497123", "1234.502877", "99.995", "99.994999"];
  for (const currency of ["IDR", "JPY", "SGD", "USD"]) {
    for (const v of grid) {
      for (const sign of [1, -1]) {
        it(`${currency} ${sign < 0 ? "-" : ""}${v} matches the reference (line, 7190 residue, imbalance)`, async () => {
          const a = sign < 0 ? `-${v}` : v;
          // Balanced: the amount against an offset that is a whole multiple of the unit (no rounding of its own).
          const offset = sign < 0 ? "10" : "-10";
          const src = [a, offset, text(-(micro(a) + micro(offset)))];
          const ref = reference(src, currency);
          const { entry } = await throughBuku(src, currency);
          expect({ lines: entry.lines.map((l) => l.amount), rounding: entry.rounding, imbalance: entry.imbalance }).toEqual(ref);
        });
      }
    }
  }

  // The trial-balance (neraca saldo) path: same reference, same expectations.
  const TITLE = [["PT UJI"], ["TRIAL BALANCE"], ["Periode 1 Mei 2026 s.d. 31 Mei 2026"]];
  const drcr = (t: string) => (t.startsWith("-") ? [0, Number(t.slice(1))] : [Number(t), 0]);
  async function throughTb(rows: unknown[][], currency: string) {
    const sheets = await readSheets("tb.xlsx", await workbook(rows));
    const read = readTable(sheets, detectTables(sheets)[0]);
    if (read.mode !== "NERACA" || !read.tb || !read.date) throw new Error("not a TB");
    const p = planTb(read.tb, { entityKey: "", entity: { entityId: "e", name: "PT Uji", currency }, opening: read.tb.opening ?? read.date, closing: read.date });
    const of = (kind: string) => p.entries.find((e) => e.kind === kind);
    const shape = (e: (typeof p.entries)[number] | undefined) => e && { lines: e.lines.map((l) => l.amount), rounding: e.rounding, imbalance: e.imbalance };
    return { opening: shape(of("OPENING")), movement: shape(of("IMPORTED")), checks: p.checks };
  }

  it("TB: the payable example in a movement column posts 101 / 75 / 25 and Rp 1 on 7190", async () => {
    const src = ["100.51", "-75.4999", "-25.0101"];
    const ref = reference(src, "IDR");
    expect(ref).toEqual({ lines: [101n, -75n, -25n], rounding: -1n, imbalance: 0n });
    const rows = src.map((a, i) => [`${i + 1}-1000`, `Akun ${i}`, 0, 0, ...drcr(a), ...drcr(a)]);
    const { movement, checks } = await throughTb([...TITLE, ["COA", "Nama Akun", "Saldo Awal", null, "Mutasi", null, "Saldo Akhir", null], [null, null, "Dr", "Cr", "Dr", "Cr", "Dr", "Cr"], ...rows], "IDR");
    expect(movement).toEqual(ref);
    expect(checks.filter((c) => c.code === "UNBALANCED")).toEqual([]);
  });

  it("TB: a movement derived from opening and closing rounds the difference once", async () => {
    // Opening 100,51 = 75,4999 + 25,0101; closing 300,0049 = 150,2525 + 149,7524. Movement = closing − opening, per account.
    const open = ["100.51", "-75.4999", "-25.0101"];
    const close = ["300.0049", "-150.2525", "-149.7524"];
    const move = close.map((c, i) => text(micro(c) - micro(open[i])));
    const rows = open.map((o, i) => [`${i + 1}-1000`, `Akun ${i}`, ...drcr(o), ...drcr(close[i])]);
    const { opening, movement } = await throughTb([...TITLE, ["COA", "Nama Akun", "Saldo Awal", null, "Saldo Akhir", null], [null, null, "Dr", "Cr", "Dr", "Cr"], ...rows], "IDR");
    expect(opening).toEqual(reference(open, "IDR"));
    expect(movement).toEqual(reference(move, "IDR"));
  });

  it("TB: a presentation-signed balance column keeps the exact amount with its turned sign", async () => {
    const { opening, checks } = await throughTb(
      [...TITLE, ["Kode Akun", "Nama Akun", "Saldo Awal", "Debit", "Kredit", "Saldo Akhir"], ["Aset"], ["1-100", "Kas", 100.51, 0, 0, 100.51], ["Liabilitas"], ["2-100", "Utang Usaha", 75.4999, 0, 0, 75.4999], ["Ekuitas"], ["3-100", "Modal Disetor", 25.0101, 0, 0, 25.0101]],
      "IDR",
    );
    expect(checks.map((c) => c.code)).toContain("TB_PRESENTATION_SIGN");
    expect(opening).toEqual(reference(["100.51", "-75.4999", "-25.0101"], "IDR"));
  });

  for (const currency of ["IDR", "JPY", "SGD", "USD"]) {
    for (const v of grid) {
      for (const sign of [1, -1]) {
        it(`TB ${currency} ${sign < 0 ? "-" : ""}${v} matches the reference (movement column)`, async () => {
          const a = sign < 0 ? `-${v}` : v;
          const offset = sign < 0 ? "10" : "-10";
          const src = [a, offset, text(-(micro(a) + micro(offset)))];
          const rows = src.map((x, i) => [`${i + 1}-1000`, `Akun ${i}`, 0, 0, ...drcr(x), ...drcr(x)]);
          const { movement } = await throughTb([...TITLE, ["COA", "Nama Akun", "Saldo Awal", null, "Mutasi", null, "Saldo Akhir", null], [null, null, "Dr", "Cr", "Dr", "Cr", "Dr", "Cr"], ...rows], currency);
          expect(movement).toEqual(reference(src, currency));
        });
      }
    }
  }
});
