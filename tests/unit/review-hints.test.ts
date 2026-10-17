import { describe, expect, it } from "vitest";
import { accountantHints, bulkAcceptable } from "@/lib/classify/hints";

const acc = (code: string, name: string, group: string) => ({ code, name, group });
const base = { wht: "none", entityKind: "PT" };

describe("accountant hints in Review", () => {
  it("reminds that a customer's down payment is not revenue yet", () => {
    const h = accountantHints({ ...base, description: "TRANSFER DARI CV PETERNAKAN BERKAH JAYA DP AYAM", amount: 60_000_000n, account: acc("4100", "Penjualan", "Pendapatan · Pendapatan usaha") });
    expect(h.map((x) => x.key)).toEqual(["dp"]);
    expect(h[0].apply).toEqual({ code: "2160" });
    expect(accountantHints({ ...base, description: "TRANSFER DARI CV PETERNAKAN BERKAH JAYA DP AYAM", amount: 60_000_000n, account: acc("2160", "Pendapatan Diterima di Muka", "Liabilitas · Utang lain-lain") })).toEqual([]);
  });

  it("flags a large machine bought as an expense, not a small one", () => {
    const line = { ...base, description: "TRSF PT AGRO TEKNIK MANDIRI MESIN PAKAN OTOMATIS", account: acc("5100", "Pembelian Bahan", "Beban · Beban pokok pendapatan") };
    expect(accountantHints({ ...line, amount: -185_000_000n }).map((x) => x.key)).toEqual(["capex"]);
    expect(accountantHints({ ...line, amount: -185_000_000n })[0].text).toMatch(/Pembelian mesin biasanya aset tetap/);
    expect(accountantHints({ ...line, amount: -450_000n })).toEqual([]);
  });

  it("asks a company about PPh 23 on services and PPh 4(2) on building rent, never an individual or once chosen", () => {
    const svc = { ...base, description: "TRSF KANTOR KONSULTAN PAJAK HARAPAN", amount: -15_000_000n, account: acc("6170", "Beban Jasa Profesional", "Beban · Beban umum & administrasi") };
    expect(accountantHints(svc)[0]).toMatchObject({ key: "svc23", apply: { wht: "PPH_23", rate: "2" } });
    expect(accountantHints({ ...svc, wht: "PPH_23" })).toEqual([]);
    expect(accountantHints({ ...svc, entityKind: "PERORANGAN" })).toEqual([]);
    const rent = { ...base, description: "SEWA RUKO SEPTEMBER", amount: -45_000_000n, account: acc("6120", "Beban Sewa", "Beban · Beban umum & administrasi") };
    expect(accountantHints(rent)[0]).toMatchObject({ key: "rent42", apply: { wht: "PPH_4_2", rate: "10" } });
    expect(accountantHints({ ...rent, description: "SEWA MOBIL OPERASIONAL" })[0].key).toBe("rent23");
    expect(accountantHints({ ...svc, amount: 15_000_000n })).toEqual([]);
  });
});

describe("bulk acceptance (Review's Terima N yakin, Kotak's Setujui N usulan yakin)", () => {
  const sale = acc("4100", "Penjualan", "Pendapatan · Pendapatan usaha");
  const line = { method: "AI", confidence: 0.92, suggestedCode: "4100", description: "TRSF CR PT MITRA UNGGAS", amount: 11_000_000n, entityKind: "PT" };
  it("takes only a sure AI suggestion with an account and no open hint", () => {
    expect(bulkAcceptable(line, sale)).toBe(true);
    expect(bulkAcceptable({ ...line, confidence: 0.8 }, sale)).toBe(true);
    expect(bulkAcceptable({ ...line, confidence: 0.79 }, sale)).toBe(false);
    for (const method of ["HEURISTIC", "RULE", "MEMORY", "TRANSFER"]) expect(bulkAcceptable({ ...line, method }, sale)).toBe(false);
    expect(bulkAcceptable({ ...line, suggestedCode: null }, null)).toBe(false);
    // A down payment received is not revenue yet: the hint holds it back.
    expect(bulkAcceptable({ ...line, description: "TRSF CR PT MITRA UNGGAS DP AYAM" }, sale)).toBe(false);
  });
});
