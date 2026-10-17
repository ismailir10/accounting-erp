import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "@/lib/csv";
import { bankCsv, bankCsvRows, bankSteps, CHECKED_FIRST, CSV_HEADER, DEMO_ANSWER, NO_MATCH, NOT_SENT, type BankFacts } from "@/lib/approvals/reasoning";

const bank = (over: Partial<BankFacts> = {}): BankFacts => ({
  kind: "bank",
  id: "tx1",
  line: { date: "2026-08-23", description: "TRSF E-BANKING CR 2308/FTSCY/WS9 PT KOPERASI PEGAWAI PEMDA BELANJA GROSIR", amount: "14300000", currency: "IDR", bank: "BCA Giro" },
  direction: "IN",
  stored: { code: "4100", name: "Penjualan", confidence: 0.83, taxTag: null, reason: "AI: Penjualan grosir" },
  sent: { client: "CV Sinar Retail (ritel minimarket)", counterparty: "PT KOPERASI PEGAWAI PEMDA BELANJA GROSIR", description: "TRSF E-BANKING CR 2308/FTSCY/WS9 PT KOPERASI PEGAWAI PEMDA BELANJA GROSIR", accounts: [{ code: "4100", name: "Penjualan" }, { code: "=1+1", name: "@SUM(A1)" }], withheld: ["1190", "1199"], coaVersion: 1 },
  answer: { code: "4100", name: "Penjualan", confidence: 0.83, taxTag: null, reason: "Penjualan grosir", model: "demo-seed", at: "2026-08-24T01:00:00.000Z" },
  replaced: null,
  capped: null,
  inChart: true,
  bulk: { ok: true },
  ...over,
});

/** Parse our own CSV back (quotes, doubled quotes, semicolons): enough to read the cells as Excel would. */
function parse(text: string): string[][] {
  const rows: string[][] = [];
  let cell = "", row: string[] = [], quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ";") { row.push(cell); cell = ""; }
    else if (c === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else cell += c;
  }
  return rows;
}

describe("the CSV writer", () => {
  it("writes Excel id-ID: BOM, semicolons, CRLF, quotes what needs quoting", () => {
    const text = toCsv(["A", "B"], [["satu;dua", 'kata "kutip"'], ["baris\nbaru", null]]);
    expect(text.startsWith("﻿A;B\r\n")).toBe(true);
    expect(text).toBe('﻿A;B\r\n"satu;dua";"kata ""kutip"""\r\n"baris\nbaru";\r\n');
  });

  it("neutralises a cell that would run as a formula, and keeps integers (minor units) as numbers", () => {
    expect(["=HYPERLINK(1)", "+62", "-Rp 8.400.000", "@SUM(A1)", "\tx", "\rx"].map(csvCell)).toEqual(["'=HYPERLINK(1)", "'+62", "'-Rp 8.400.000", "'@SUM(A1)", "'\tx", "\"'\rx\""]);
    expect([csvCell(-8_400_000n), csvCell("-8400000"), csvCell(14_300_000n), csvCell(0.83), csvCell("Rp 1")]).toEqual(["-8400000", "-8400000", "14300000", "0.83", "Rp 1"]);
  });
});

describe("a bank line's steps", () => {
  it("lists the five steps: checked first, exactly what was sent, the demo answer, Buku's checks, not yet booked", () => {
    const s = bankSteps(bank());
    expect(s.map((x) => x.label)).toEqual(["Dicek dulu tanpa AI", "Dikirim ke AI", "Jawaban AI", "Diperiksa Buku", "Belum dicatat"]);
    expect(s[0].lines).toEqual([CHECKED_FIRST]);
    expect(s[1].lines).toEqual([
      'Klien: "CV Sinar Retail (ritel minimarket)"',
      "Arah: uang masuk",
      "Pihak lawan: PT KOPERASI PEGAWAI PEMDA BELANJA GROSIR",
      'Keterangan: "TRSF E-BANKING CR 2308/FTSCY/WS9 PT KOPERASI PEGAWAI PEMDA BELANJA GROSIR"',
      "Daftar akun: 2 akun, tanpa 1190 dan 1199",
    ]);
    expect(s[1].note).toBe(NOT_SENT);
    expect(s[2].lines).toEqual(['4100 Penjualan · keyakinan 83% · pajak – · "Penjualan grosir"', DEMO_ANSWER]);
    expect(s[3].checks).toEqual([{ ok: true, text: "Kode 4100 ada di bagan akun klien." }, { ok: true, text: "Boleh disetujui massal." }]);
    expect(s[4].lines).toEqual(["Baris ini tetap di 1999 sampai Anda menyetujuinya."]);
  });

  it("names a real model and its date, a tax tag, a capped confidence, an account gone from the chart and each bulk refusal", () => {
    const s = bankSteps(bank({ answer: { ...bank().answer!, model: "glm-5.3", taxTag: "PPN_KELUARAN" }, capped: "piutang usaha", inChart: false, bulk: { ok: false, why: "hints" } }));
    expect(s[2].lines).toEqual(['4100 Penjualan · keyakinan 83% · pajak PPN Keluaran · "Penjualan grosir"', "glm-5.3, 24 Agu 2026"]);
    expect(s[3].checks).toEqual([
      { ok: false, text: "Kode 4100 tidak ada di bagan akun klien." },
      { ok: false, text: "Keyakinan dibatasi 55%: belum ada piutang usaha tercatat untuk entitas ini." },
      { ok: false, text: "Tidak ikut setujui massal: ada catatan akuntan di atas." },
    ]);
    expect(bankSteps(bank({ bulk: { ok: false, why: "low" } }))[3].checks!.at(-1)!.text).toBe("Tidak ikut setujui massal: keyakinan di bawah 80%.");
  });

  it("without a matched answer: says so, sends nothing it can't prove, shows the stored suggestion without a model", () => {
    const s = bankSteps(bank({ sent: null, answer: null, stored: { code: "6160", name: "Beban Perlengkapan Kantor", confidence: 0.74, taxTag: null, reason: "AI: Perlengkapan toko" } }));
    expect(s[1].lines).toEqual([NO_MATCH]);
    expect(s[2].lines).toEqual(['6160 Beban Perlengkapan Kantor · keyakinan 74% · pajak – · "Perlengkapan toko"']);
  });
});

describe("a bank line's CSV", () => {
  it("holds the panel's values; the amount only in a tidak dikirim row, as text and as an integer; no cell runs as a formula", () => {
    const rows = parse(bankCsv(bank({ line: { ...bank().line, amount: "-8400000" } })).replace(/^﻿/, ""));
    expect(rows[0]).toEqual(CSV_HEADER);
    const at = (part: string, item: string) => rows.filter((r) => r[0] === part && r[1] === item);
    expect(at("Dikirim ke AI", "Klien")[0][2]).toBe("CV Sinar Retail (ritel minimarket)");
    expect(at("Dikirim ke AI", "Arah")[0][2]).toBe("IN");
    expect(at("Dikirim ke AI", "Akun ditawarkan").map((r) => [r[7], r[2]])).toEqual([["4100", "Penjualan"], ["'=1+1", "'@SUM(A1)"]]);
    expect(at("Jawaban AI", "Akun")[0].slice(7, 8)).toEqual(["4100"]);
    expect(at("Jawaban AI", "Model")[0][2]).toBe("demo-seed");
    expect(at("Diperiksa Buku", "Lolos").map((r) => r[2])).toEqual(["Kode 4100 ada di bagan akun klien.", "Boleh disetujui massal."]);
    const amount = rows.filter((r) => r.slice(3, 7).some(Boolean) && r[0] !== "Bagian");
    expect(amount).toEqual([["Tidak dikirim", "Nominal", "tidak dikirim", "2026-08-23", "'-Rp 8.400.000", "-8400000", "IDR", "", "", "", "Mutasi BCA Giro"]]);
    for (const r of rows) for (const c of r) expect(/^[=+@\t\r]/.test(c) || (/^-/.test(c) && !/^-\d+$/.test(c))).toBe(false);
  });

  it("without a match: no values sent, the stored suggestion as the answer", () => {
    const rows = bankCsvRows(bank({ sent: null, answer: null }));
    expect(rows.filter((r) => r[0] === "Dikirim ke AI").map((r) => r[2])).toEqual([NO_MATCH]);
    expect(rows.filter((r) => r[0] === "Jawaban AI").map((r) => r[1])).toEqual(["Akun", "Keyakinan", "Pajak", "Alasan"]);
  });
});
