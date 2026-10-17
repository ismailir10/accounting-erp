import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { journalWorkbook, ledgerFileName, ledgerWorkbook, rangeLabel, trialBalanceWorkbook } from "@/lib/reports/ledger-workbook";
import type { GlAccount } from "@/lib/reports/general-ledger";
import type { RegisterEntry } from "@/lib/reports/journal-register";
import type { TbMoveRow } from "@/lib/reports/ledger";
import { dateOnly } from "@/lib/format";

const meta = { firm: "KJA Uji", title: "PT Uji Sejahtera", draft: "bulan belum ditutup." };
const read = async (buf: Buffer) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.worksheets[0];
};
/** Every row as plain values; a formula cell as "=formula→result". */
const rows = (ws: ExcelJS.Worksheet) => {
  const out: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const vals = Array.from((r.values as unknown[]).slice(1), (v) => (v && typeof v === "object" && "formula" in (v as object) ? `=${(v as { formula: string }).formula}→${(v as { result: number }).result}` : v instanceof Date ? v.toISOString().slice(0, 10) : (v ?? null)));
    out.push(vals);
  });
  return out;
};
const acct = (code: string, name: string, normalBalance: "DEBIT" | "CREDIT") => ({ id: code, code, name, type: normalBalance === "DEBIT" ? ("ASET" as const) : ("EKUITAS" as const), normalBalance });

describe("ledger workbooks", () => {
  it("Jurnal Umum: a header row per journal, its lines, and SUM totals that balance", async () => {
    const entries: RegisterEntry[] = [
      { id: "a", date: dateOnly(2026, 9, 3), entity: "PT Uji", kind: "ADJUSTMENT", memo: "Gaji September", source: null, origin: null, postedBy: "Sari", postedAt: new Date(), reversedOn: null, lines: [{ code: "6100", name: "Beban Gaji", memo: null, debit: 12_000_000n, credit: 0n }, { code: "1110", name: "Kas Kecil", memo: null, debit: 0n, credit: 12_000_000n }] },
      { id: "b", date: dateOnly(2026, 9, 5), entity: "PT Uji", kind: "BANK", memo: "TRSF CR MITRA", source: "BCA Giro · bca.csv, baris 2", origin: "Usulan AI 4100 (92 %) disetujui", postedBy: "Sistem", postedAt: new Date(), reversedOn: null, lines: [{ code: "1101", name: "Bank BCA", memo: null, debit: 4_250_000n, credit: 0n }, { code: "4100", name: "Penjualan", memo: null, debit: 0n, credit: 4_250_000n }] },
    ];
    const ws = await read(await journalWorkbook(meta, "September 2026", entries));
    const r = rows(ws);
    expect(r[0]).toEqual(["PT Uji Sejahtera"]);
    expect(r[1]).toEqual(["Jurnal Umum"]);
    expect(r.find((x) => x[0] === "2026-09-03")).toEqual(["2026-09-03", "Penyesuaian", "PT Uji", "Gaji September", null, null, null, null, "Dicatat oleh Sari"]);
    // The source column names the proposal the entry was approved from after its source row.
    expect(r.find((x) => x[8] === "BCA Giro · bca.csv, baris 2 · Usulan AI 4100 (92 %) disetujui")?.[1]).toBe("Mutasi bank");
    expect(r.at(-1)!.slice(3)).toEqual(["Jumlah (2 jurnal)", null, null, "=SUM(G9:G14)→16250000", "=SUM(H9:H14)→16250000"]);
  });

  it("Buku Besar: opening, running-balance formulas on the normal side, closing; prior-year profit named", async () => {
    const accounts: GlAccount[] = [
      { account: acct("1110", "Kas Kecil", "DEBIT"), opening: 640_000_000n, priorYearProfit: 0n, debit: 0n, credit: 15_500_000n, closing: 624_500_000n, lines: [
        { date: dateOnly(2026, 9, 3), entity: "PT Uji", kind: "ADJUSTMENT", memo: "Gaji", source: null, debit: 0n, credit: 12_000_000n, balance: 628_000_000n },
        { date: dateOnly(2026, 9, 20), entity: "PT Uji", kind: "ADJUSTMENT", memo: "Sewa", source: null, debit: 0n, credit: 3_500_000n, balance: 624_500_000n },
      ] },
      { account: acct("3200", "Saldo Laba", "CREDIT"), opening: 100_000_000n, priorYearProfit: 100_000_000n, debit: 0n, credit: 0n, closing: 100_000_000n, lines: [] },
    ];
    const r = rows(await read(await ledgerWorkbook(meta, "September 2026", accounts)));
    const i = r.findIndex((x) => x[0] === "1110 Kas Kecil");
    expect(r[i + 1]).toEqual([null, "Saldo awal", null, null, null, null, null, 640_000_000]);
    expect(r[i + 2].at(-1)).toBe(`=H${10}+F11-G11→628000000`);
    expect(r[i + 4].slice(1)).toEqual(["Saldo akhir", null, null, null, "=SUM(F11:F12)→undefined", "=SUM(G11:G12)→15500000", "=H12→624500000"]);
    const j = r.findIndex((x) => x[0] === "3200 Saldo Laba");
    expect(r[j + 1][1]).toBe("Saldo awal (termasuk laba rugi tahun-tahun lalu)");
    expect(r[j + 2].at(-1)).toMatch(/^=H\d+→100000000$/);
    // No movement: zero, never a SUM over its own closing row (Excel would call that circular).
    expect(r[j + 2].slice(1, 7)).toEqual(["Saldo akhir", null, null, null, 0, 0]);
  });

  it("Neraca Saldo: six columns with SUM totals, debit = credit", async () => {
    const a = (code: string, normal: "DEBIT" | "CREDIT") => ({ ...acct(code, code, normal), clientId: "c", fsLine: "X" }) as unknown as TbMoveRow["account"];
    const tb: TbMoveRow[] = [
      { account: a("1110", "DEBIT"), net: 624_500_000n, debit: 624_500_000n, credit: 0n, opening: 640_000_000n, periodDebit: 0n, periodCredit: 15_500_000n },
      { account: a("3100", "CREDIT"), net: -500_000_000n, debit: 0n, credit: 500_000_000n, opening: -500_000_000n, periodDebit: 0n, periodCredit: 0n },
      { account: a("4100", "CREDIT"), net: -140_000_000n, debit: 0n, credit: 140_000_000n, opening: -140_000_000n, periodDebit: 0n, periodCredit: 0n },
      { account: a("6100", "DEBIT"), net: 15_500_000n, debit: 15_500_000n, credit: 0n, opening: 0n, periodDebit: 15_500_000n, periodCredit: 0n },
      { account: a("9999", "DEBIT"), net: 0n, debit: 0n, credit: 0n, opening: 0n, periodDebit: 0n, periodCredit: 0n },
    ];
    const r = rows(await read(await trialBalanceWorkbook(meta, "September 2026", tb)));
    expect(r.some((x) => x[0] === "9999")).toBe(false);
    const total = r.at(-1)!;
    expect(total.slice(1)).toEqual(["Jumlah", "=SUM(C10:C13)→640000000", "=SUM(D10:D13)→640000000", "=SUM(E10:E13)→15500000", "=SUM(F10:F13)→15500000", "=SUM(G10:G13)→640000000", "=SUM(H10:H13)→640000000"]);
  });

  it("an empty export totals to zero instead of a circular SUM", async () => {
    const r = rows(await read(await journalWorkbook(meta, "September 2026", [])));
    expect(r.at(-1)!.slice(3)).toEqual(["Jumlah (0 jurnal)", null, null, 0, 0]);
  });

  it("names files and ranges", () => {
    expect(ledgerFileName("buku-besar", "PT Uji Sejahtera", "ytd", dateOnly(2026, 9, 30))).toBe("buku-besar-PT_Uji_Sejahtera-sd-September-2026.xlsx");
    expect(rangeLabel("month", dateOnly(2026, 9, 1), dateOnly(2026, 9, 30))).toBe("September 2026");
    expect(rangeLabel("ytd", dateOnly(2026, 2, 1), dateOnly(2026, 9, 30))).toBe("1 Februari 2026 – 30 September 2026");
  });
});
