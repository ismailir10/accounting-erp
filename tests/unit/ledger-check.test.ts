import { describe, expect, it } from "vitest";
import { planLedger, planNeraca, rangeRef, type EntityInfo } from "@/lib/ledger-import/check";
import type { LedgerRow, NeracaRow } from "@/lib/ledger-import/types";
import { dateOnly } from "@/lib/format";

let n = 4;
function row(p: Partial<LedgerRow> & { code: string; debit?: bigint; credit?: bigint }): LedgerRow {
  const r = n++;
  return { ref: `GL!${r}`, row: r, date: dateOnly(2023, 3, 31), entity: "CSP", name: p.code, debit: 0n, credit: 0n, currency: null, rate: null, description: "", voucher: null, errors: [], ...p };
}
const ENT = new Map<string, EntityInfo>([
  ["CSP", { entityId: "e1", name: "PT CSP", currency: "IDR" }],
  ["HOLDCO", { entityId: "e2", name: "Chickin Pte Ltd", currency: "SGD" }],
]);

describe("planLedger", () => {
  it("groups by entity+date, rounds sen to Rupiah with a 7190 residue", () => {
    const p = planLedger(
      [row({ code: "1", debit: 50n }), row({ code: "2", debit: 50n }), row({ code: "3", debit: 50n }), row({ code: "4", credit: 150n })],
      { entities: ENT, currencyMode: "FUNCTIONAL" },
    );
    expect(p.entries).toHaveLength(1);
    expect(p.entries[0].lines.map((l) => l.amount)).toEqual([1n, 1n, 1n, -2n]);
    expect(p.entries[0].rounding).toBe(-1n);
    expect(p.entries[0].imbalance).toBe(0n);
    expect(p.checks.filter((c) => c.severity === "BLOCK")).toEqual([]);
    expect(p.checks.find((c) => c.code === "STATS")?.message).toMatch(/pembulatan ke 7190 total Rp 1 di 1 jurnal/);
  });

  it("blocks an unbalanced group (CSP −Rp 5.000.000 pattern) but lets it be accepted", () => {
    const p = planLedger(
      [row({ code: "11141", debit: 100_000_000_00n }), row({ code: "21001", credit: 100_500_000_00n })],
      { entities: ENT, currencyMode: "FUNCTIONAL" },
    );
    const c = p.checks.find((x) => x.code === "UNBALANCED")!;
    expect(c).toMatchObject({ severity: "BLOCK", acceptable: true, amount: -500_000n });
    expect(c.message).toMatch(/selisih -Rp 500.000/);
  });

  it("blocks unreadable rows (#VALUE!) and unknown entities", () => {
    const p = planLedger(
      [row({ code: "31009", errors: ["debit bukan angka: #VALUE!"] }), row({ code: "1", entity: "XYZ", debit: 1n })],
      { entities: ENT, currencyMode: "FUNCTIONAL" },
    );
    expect(p.checks.filter((c) => c.severity === "BLOCK").map((c) => c.code).sort()).toEqual(["ROW_ERROR", "UNKNOWN_ENTITY"]);
    expect(p.checks.find((c) => c.code === "ROW_ERROR")?.message).toMatch(/#VALUE!/);
  });

  it("an entity the client doesn't have says how to add it, not to fix the file", () => {
    const p = planLedger([row({ code: "1", entity: "SKP", debit: 1n }), row({ code: "2", entity: "", credit: 1n })], { entities: ENT, currencyMode: "FUNCTIONAL" });
    const unknown = p.checks.filter((c) => c.code === "UNKNOWN_ENTITY");
    expect(unknown.find((c) => c.entityKey === "SKP")?.message).toBe('Entitas "SKP" belum dipasangkan ke perusahaan klien (1 baris). Tambahkan perusahaan dengan nama singkat "SKP" di Pengaturan klien, lalu unggah ulang file ini.');
    expect(unknown.find((c) => c.entityKey === "")?.message).toMatch(/tanpa entitas.*pilih perusahaan/i);
  });

  it("flags a reused code and a receivable with a credit balance", () => {
    const p = planLedger(
      [
        row({ code: "21001", name: "Income Tax Payable - Art 21", credit: 100n, date: dateOnly(2023, 12, 31) }),
        row({ code: "9", name: "Kas", debit: 100n, date: dateOnly(2023, 12, 31) }),
        row({ code: "21001", name: "Smartfarm Payable", credit: 100n, date: dateOnly(2024, 12, 31) }),
        row({ code: "12311", name: "Piutang Lain-lain - Chickin Pte Ltd", credit: 920_840_000_000n, date: dateOnly(2024, 12, 31) }),
        row({ code: "9", name: "Kas", debit: 920_840_000_100n, date: dateOnly(2024, 12, 31) }),
      ],
      { entities: ENT, currencyMode: "FUNCTIONAL" },
    );
    expect(p.checks.find((c) => c.code === "CODE_RENAMED")?.message).toMatch(/"Income Tax Payable - Art 21" → "Smartfarm Payable"/);
    expect(p.accounts.get("CSP|21001")?.name).toBe("Smartfarm Payable");
    expect(p.checks.find((c) => c.code === "SIGN_AGAINST_TYPE")?.message).toMatch(/12311 Piutang Lain-lain.*2024 di file kredit Rp 9.208.400.000/);
  });

  it("FUNCTIONAL mode: posts amounts as-is and flags USD/SGD same-number groups and an IDR row in an SGD ledger", () => {
    const d = dateOnly(2023, 1, 3);
    const p = planLedger(
      [
        row({ entity: "HOLDCO", date: d, code: "10001", name: "Bank OCBC USD", currency: "USD", rate: "1.31", debit: 15_000_000n }),
        row({ entity: "HOLDCO", date: d, code: "20000", name: "Long Term Loan Payable", currency: "SGD", credit: 15_000_000n }),
        row({ entity: "HOLDCO", date: dateOnly(2023, 6, 30), code: "11002", name: "Loan to Subsidiary", currency: "IDR", debit: 117_459_335_600n }),
        row({ entity: "HOLDCO", date: dateOnly(2023, 6, 30), code: "12000", name: "Investment on Subsidiary", currency: "IDR", credit: 117_459_335_600n }),
      ],
      { entities: ENT, currencyMode: "FUNCTIONAL" },
    );
    expect(p.entries[0].lines.map((l) => [l.amount, l.fx])).toEqual([
      [15_000_000n, null],
      [-15_000_000n, null],
    ]);
    expect(p.checks.filter((c) => c.code === "FX_SAME_NUMBER")).toHaveLength(1);
    const noRate = p.checks.filter((c) => c.code === "FX_NO_RATE").map((c) => c.message);
    expect(noRate.find((m) => m.includes("IDR"))).toMatch(/2 baris IDR di buku SGD Chickin Pte Ltd dicatat apa adanya tanpa kurs \(total 2\.349\.186\.712,00/);
    expect(noRate.find((m) => m.includes("USD"))).toMatch(/1 baris USD/);
  });

  it("CONVERT mode: a group that balances in its source currency posts its conversion residue to 7190", () => {
    // 10,01 + 10,01 = 20,02 USD at 1,3669 → S$13,68 + 13,68 vs 27,37: one minor unit left over by rounding.
    const p = planLedger(
      [row({ entity: "HOLDCO", code: "11000", debit: 1001n, currency: "USD", rate: "1.3669" }), row({ entity: "HOLDCO", code: "11001", debit: 1001n, currency: "USD", rate: "1.3669" }), row({ entity: "HOLDCO", code: "20000", credit: 2002n, currency: "USD", rate: "1.3669" })],
      { entities: ENT, currencyMode: "CONVERT" },
    );
    expect(p.entries[0].lines.map((l) => l.amount)).toEqual([1368n, 1368n, -2737n]);
    expect(p.entries[0]).toMatchObject({ imbalance: 0n, rounding: 1n, fxRounding: true });
    expect(p.checks.filter((c) => c.severity === "BLOCK")).toEqual([]);
  });

  it("CONVERT mode: a group balanced only in raw numbers across currencies stays blocked", () => {
    const p = planLedger(
      [row({ entity: "HOLDCO", code: "10001", debit: 15_000_000n, currency: "USD", rate: "1.31" }), row({ entity: "HOLDCO", code: "20000", credit: 15_000_000n, currency: "SGD" })],
      { entities: ENT, currencyMode: "CONVERT" },
    );
    expect(p.entries[0]).toMatchObject({ imbalance: 4_650_000n, rounding: 0n });
    expect(p.entries[0].fxRounding).toBeUndefined();
    expect(p.checks.find((c) => c.code === "UNBALANCED")?.message).toMatch(/selisih S\$ 46\.500,00/);
  });

  it("CONVERT mode: converts with the row rate, else the rate table, else blocks", () => {
    const d = dateOnly(2023, 1, 3);
    const rows = [
      row({ entity: "HOLDCO", date: d, code: "10001", name: "Bank USD", currency: "USD", rate: "1.31", debit: 15_000_000n }),
      row({ entity: "HOLDCO", date: d, code: "20000", name: "Loan", currency: "SGD", credit: 19_650_000n }),
      row({ entity: "HOLDCO", date: dateOnly(2023, 2, 1), code: "10001", name: "Bank USD", currency: "USD", debit: 100n }),
      row({ entity: "HOLDCO", date: dateOnly(2023, 2, 1), code: "41000", name: "Bank charge", currency: "SGD", credit: 134n }),
    ];
    const withTable = planLedger(rows, { entities: ENT, currencyMode: "CONVERT", rateFor: (c, f) => (c === "USD" && f === "SGD" ? "1.34" : null) });
    expect(withTable.checks.filter((c) => c.severity === "BLOCK")).toEqual([]);
    expect(withTable.entries[0].lines[0]).toMatchObject({ amount: 19_650_000n, fx: { currency: "USD", amount: 15_000_000n, rate: "1.31" } });
    expect(withTable.entries[1].lines[0]).toMatchObject({ amount: 134n, fx: { rate: "1.34" } });
    const noTable = planLedger(rows, { entities: ENT, currencyMode: "CONVERT" });
    expect(noTable.checks.find((c) => c.code === "MISSING_RATE")?.message).toMatch(/Kurs USD tanggal 1 Feb 2023/);
    expect(noTable.entries).toHaveLength(1);
  });

  it("uses the voucher column when present", () => {
    const p = planLedger(
      [row({ code: "1", voucher: "JV-1", debit: 100n }), row({ code: "2", voucher: "JV-1", credit: 100n }), row({ code: "1", voucher: "JV-2", debit: 5n }), row({ code: "2", voucher: "JV-2", credit: 5n })],
      { entities: ENT, currencyMode: "FUNCTIONAL" },
    );
    expect(p.entries.map((e) => e.memo)).toEqual(["Impor bukti JV-1", "Impor bukti JV-2"]);
  });
});

describe("planNeraca", () => {
  const nr = (code: string, amount: bigint, typeHint: NeracaRow["typeHint"]): NeracaRow => ({ ref: `N!${n++}`, row: n, code, name: code, amount, typeHint, termHint: null, coded: true, errors: [] });
  it("builds one opening entry, checks file totals, rounds with 7190", () => {
    const p = planNeraca(
      [nr("1-1000", 100_060n, "ASET"), nr("2-2000", -40_000n, "LIABILITAS"), nr("3-3000", -60_060n, "EKUITAS")],
      [
        { ref: "N!90", label: "Total Assets", amount: 100_060n, kind: "ASSETS" },
        { ref: "N!91", label: "Total Liability & Equity", amount: 100_000n, kind: "LIAB_EQUITY" },
      ],
      { entityKey: "", entity: { entityId: "e", name: "PT Goers", currency: "IDR" }, date: dateOnly(2026, 5, 31), sheet: "N" },
    );
    expect(p.entries[0].lines.map((l) => l.amount)).toEqual([1001n, -400n, -601n]);
    expect(p.entries[0].rounding).toBe(0n);
    expect(p.checks.map((c) => c.code)).toEqual(["TOTAL_OK", "TOTAL_MISMATCH", "STATS"]);
  });
});

describe("rangeRef", () => {
  it("compresses consecutive rows", () => {
    expect(rangeRef(["S!5", "S!6", "S!7", "S!10", "S!12", "S!13"])).toBe("S!5-7,10,12-13");
  });
});
