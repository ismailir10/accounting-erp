import { describe, expect, it } from "vitest";
import { parseStatement, parseStatementSections } from "@/lib/import/parsers";
import { bcaHolderPdf, bniWondrPdf, brimoPdf, mandiriEstatementPdf, makePdf, smbcCombinedPdf, table } from "../pdf-fixture";
import { LAYOUTS } from "../bank-layouts";
import { parsePdf, PdfPasswordError, periodOf } from "@/lib/import/parsers/pdf";
import { assertSingleSide } from "@/lib/import/parsers/common";
import { SourceAmountError, SourceDateError } from "@/lib/import/types";
import { checkContinuity } from "@/lib/import/normalize";
import { BAL, TX, en, bniDirectCsv, bniDirectXlsx, bniMobileXlsx, xlsxBuffer, briInternetBankingCsv, cimbPdf, idn, mandiriLivinPdf, mandiriLivinXlsx, serialDateXlsx, cimbOctoCsv, expectAugust, p2, permataCsv, titleWithCommasSemicolonCsv, utf16TabCsv } from "../bank-fixture";

describe("routing: bank CSVs that borrow BCA's words", () => {
  it("reads a BRI internet-banking CSV titled 'Mutasi Rekening' with a 'Tanggal Transaksi' header", async () => {
    const st = await parseStatement("bri-ib.csv", briInternetBankingCsv());
    expectAugust(st);
    expect(st.accountNumber).toBe("000001000123509");
  });

  it("still reads the KlikBCA export as BCA", async () => {
    const csv = [
      "Informasi Rekening - Mutasi Rekening",
      "No. rekening : 0000012345",
      "Periode : 01/08/2026 - 31/08/2026",
      "",
      "Tanggal Transaksi,Keterangan,Cabang,Jumlah,,Saldo",
      `'02/08,"PEMBAYARAN LISTRIK PLN",'0000,"2,450,000.00",DB,"97,550,000.00"`,
      `"Saldo Awal : 100,000,000.00"`,
      `"Saldo Akhir : 97,550,000.00"`,
    ].join("\n");
    const st = await parseStatement("klikbca.csv", Buffer.from(csv));
    expect(st.format).toBe("BCA");
    expect(st.rows.map((r) => r.amount)).toEqual([-2_450_000n]);
  });

  it("falls back to the generic reader when the BCA reader can't read a file that looks like BCA's, keeping the BCA error if both fail", async () => {
    // Looks like KlikBCA (title + header) but carries no 'Periode' line: the BCA reader throws; the generic one can read it.
    const readable = ["Informasi Rekening - Mutasi Rekening", "Tanggal Transaksi,Keterangan,Cabang,Jumlah,Saldo", "01/08/2026,A,0000,100,1100", "02/08/2026,B,0000,-50,1050"].join("\n");
    const st = await parseStatement("x.csv", Buffer.from(readable));
    expect(st.rows.map((r) => r.amount)).toEqual([100n, -50n]);
    const unreadable = ["Informasi Rekening - Mutasi Rekening", "Tanggal Transaksi,Keterangan,Cabang,Foo", "01/08/2026,A,0000,B"].join("\n");
    await expect(parseStatement("x.csv", Buffer.from(unreadable))).rejects.toThrow(/Periode/);
  });
});

describe("text files: delimiter and encoding", () => {
  it("picks ';' from the table, not from a comma-laden title row above it", async () => {
    const st = await parseStatement("rekening.csv", titleWithCommasSemicolonCsv());
    expectAugust(st);
  });

  it("picks ';' when a title row without any delimiter comes first", async () => {
    const st = await parseStatement("cimb.csv", cimbOctoCsv("08"));
    expectAugust(st);
  });

  it("decodes a UTF-16 (BOM) tab-separated text export", async () => {
    const st = await parseStatement("unicode.txt", utf16TabCsv());
    expectAugust(st);
  });

  it("decodes UTF-16 big-endian with a BOM too", async () => {
    const le = utf16TabCsv().subarray(2);
    const be = Buffer.from(le);
    be.swap16();
    const st = await parseStatement("unicode.txt", Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
    expectAugust(st);
  });
});

describe("column headers as banks label them", () => {
  const dmy = (d: number) => `${p2(d)}/08/2026`;
  const csv = (header: string[], row: (t: (typeof TX)[number], i: number) => (string | number)[]) =>
    Buffer.from([header.join(","), ...TX.map((t, i) => row(t, i).join(","))].join("\n"));
  const debitCredit = (t: (typeof TX)[number]) => [t.amt < 0 ? Math.abs(t.amt) : 0, t.amt > 0 ? t.amt : 0];

  it("reads Permata's 'Posting Date / Eff Date / Transaction Desc'", async () => {
    expectAugust(await parseStatement("permata.csv", permataCsv()));
  });

  it.each([
    [["Post Date", "Transaction Description", "Debit (IDR)", "Credit (IDR)", "Balance (IDR)"]],
    [["Tgl. Transaksi", "Uraian", "Debet (Rp)", "Kredit (Rp)", "Saldo (Rp)"]],
    [["Tanggal", "Narasi", "Debet", "Kredit", "Saldo"]],
    [["Date", "Remarks", "Withdrawal", "Deposit", "Balance"]],
    [["Tanggal Transaksi", "Transaction Desc", "Uang Keluar", "Uang Masuk", "Saldo Akhir"]],
  ])("reads the header row %j", async (header) => {
    const st = await parseStatement("x.csv", csv(header, (t, i) => [dmy(t.d), `"${t.desc.join(" ")}"`, ...debitCredit(t), BAL[i]]));
    expectAugust(st);
  });

  it("reads 'Jumlah (IDR)' as one signed amount column", async () => {
    const st = await parseStatement("x.csv", csv(["Tanggal", "Keterangan", "Jumlah (IDR)", "Saldo (IDR)"], (t, i) => [dmy(t.d), `"${t.desc.join(" ")}"`, t.amt, BAL[i]]));
    expectAugust(st);
  });
});

describe("dates written with month names and Excel serials", () => {
  it("reads BNI Direct's 'Post Date' with a time and a two-digit year", async () => {
    expectAugust(await parseStatement("bni.csv", bniDirectCsv()));
  });

  it("reads CIMB OCTO's ';' CSV with dd-Mmm-yyyy dates", async () => {
    expectAugust(await parseStatement("cimb.csv", cimbOctoCsv()));
  });

  it("reads Mandiri Livin's Indonesian month names and a signed '+1.000,00' Nominal", async () => {
    expectAugust(await parseStatement("livin.xlsx", await mandiriLivinXlsx()));
  });

  it("reads date cells that hold Excel serial numbers", async () => {
    const st = await parseStatement("serial.xlsx", await serialDateXlsx());
    expect(st.rows.map((r) => r.date.toISOString().slice(0, 10))).toEqual(["2026-08-01", "2026-08-02"]);
    expect(st.rows.map((r) => r.amount)).toEqual([100n, -50n]);
    expect(checkContinuity(st).ok).toBe(true);
  });
});

describe("PDF statements: month-name dates, signed / Rp amounts", () => {
  it("reads CIMB's dd-Mmm-yyyy dates", async () => {
    expectAugust(await parseStatement("cimb.pdf", cimbPdf()));
  });

  it("reads 'dd Mmm yyyy' with Indonesian month names", async () => {
    expectAugust(await parseStatement("cimb.pdf", cimbPdf((d) => `${p2(d)} Agu 2026`)));
  });

  it("reads two-digit years and a header with 'Post Date / Transaction Desc / Debit (IDR)'", async () => {
    expectAugust(await parseStatement("cimb.pdf", cimbPdf((d) => `${p2(d)}-Aug-26`, ["Post Date", "Transaction Desc", "Debit (IDR)", "Credit (IDR)", "Balance (IDR)"])));
  });

  it("reads Livin's '+1.000.000' Nominal (a leading plus is a credit, never 0)", async () => {
    const st = await parseStatement("livin.pdf", mandiriLivinPdf());
    expectAugust(st);
    expect(st.format).toBe("MANDIRI");
  });

  it("reads an 'Rp' prefix before the amount", async () => {
    expectAugust(await parseStatement("livin.pdf", mandiriLivinPdf((a) => `${a > 0 ? "+" : "-"}Rp ${idn(a)}`)));
  });

  it("refuses an amount it can't read instead of posting the row as 0", async () => {
    const broken = mandiriLivinPdf((a) => (a === 45_678 ? "45.6x8,00" : (a > 0 ? "+" : "-") + idn(a)));
    await expect(parseStatement("livin.pdf", broken)).rejects.toThrow(/45\.6x8,00.*tidak bisa dibaca/);
  });
});

describe("a damaged amount on a continuation line", () => {
  it("is refused, not posted as 0", async () => {
    const head: [number, string][] = [[40, "Tanggal"], [110, "Keterangan"], [400, "Nominal"], [490, "Saldo"]];
    const pdf = makePdf([
      [
        ...table(800, ["Bank Mandiri Livin", "Nomor Rekening : 0000000123456", "Periode : 01/08/2026 - 31/08/2026"].map((l) => [[40, l]] as [number, string][])),
        ...table(740, [
          head,
          [[40, "01/08/2026"], [110, "SALDO AWAL"], [490, idn(100_000_000)]],
          [[40, "02/08/2026"], [110, "TRF KE BUDI"]],
          [[110, "lanjutan"], [400, "-1.2x0.000,00"], [490, idn(98_800_000)]],
        ]),
      ],
    ]);
    await expect(parseStatement("livin.pdf", pdf)).rejects.toThrow(/1\.2x0\.000,00.*tidak bisa dibaca/);
  });
});

describe("a separate D/K flag column beside an unsigned amount", () => {
  it("reads BNI Mobile's Tipe (DB/CR) column", async () => {
    expectAugust(await parseStatement("bni-mobile.xlsx", await bniMobileXlsx()));
  });

  it("reads BNI Direct's D/K column (with dd-Mmm-yy dates and a SALDO AWAL row)", async () => {
    const st = await parseStatement("bni-direct.xlsx", await bniDirectXlsx());
    expectAugust(st);
    expect(st.notes?.join(" ")).toMatch(/D\/K/);
  });

  it.each([
    ["Debet", "Kredit"],
    ["DR", "CR"],
    ["d", "k"],
  ])("reads %s / %s as out / in", async (out, into) => {
    const rows = TX.map((t, i) => [`${p2(t.d)}/08/2026`, t.desc.join(" "), Math.abs(t.amt), t.amt < 0 ? out : into, BAL[i]]);
    const st = await parseStatement("x.xlsx", await xlsxBuffer("S", [["Tanggal", "Keterangan", "Nominal", "Jenis", "Saldo"], ...rows]));
    expectAugust(st);
  });

  it("refuses a row whose flag is missing rather than guessing its side", async () => {
    const rows = TX.map((t, i) => [`${p2(t.d)}/08/2026`, t.desc.join(" "), Math.abs(t.amt), i === 1 ? "" : t.amt < 0 ? "DB" : "CR", BAL[i]]);
    await expect(parseStatement("x.xlsx", await xlsxBuffer("S", [["Tanggal", "Keterangan", "Jumlah", "Tipe", "Saldo"], ...rows]))).rejects.toThrow(/D\/K.*baris 3/);
  });

  it("leaves a signed amount column with a text column of other values alone", async () => {
    const rows = TX.map((t, i) => [`${p2(t.d)}/08/2026`, t.desc.join(" "), t.amt, i % 2 ? "QRIS" : "TRANSFER", BAL[i]]);
    expectAugust(await parseStatement("x.xlsx", await xlsxBuffer("S", [["Tanggal", "Keterangan", "Jumlah", "Kanal", "Saldo"], ...rows])));
  });
});

describe("sen are never rounded silently; a BRI file without balances still reads", () => {
  it("notes a spreadsheet amount with sen, keeping whole Rupiah", async () => {
    const buf = await xlsxBuffer("S", [
      ["Tanggal", "Keterangan", "Debet", "Kredit", "Saldo"],
      ["01/08/2026", "SALDO AWAL", "", "", "1000.50"],
      ["02/08/2026", "A", 0, 100.49, 1100.99],
    ]);
    const st = await parseStatement("sen.xlsx", buf);
    expect(st.rows.map((r) => r.amount)).toEqual([100n]);
    expect(st.openingBalance).toBe(1001n);
    expect(st.notes?.join(" ")).toMatch(/3 nilai berisi sen.*baris 3: "100\.49"/);
  });

  it("notes an Indonesian '1.500.000,50' in a CSV, and stays quiet for ',00'", async () => {
    const csv = (amount: string) => Buffer.from(["Tanggal;Keterangan;Debet;Kredit;Saldo", `01/08/2026;A;0,00;${amount};2.500.000,00`, "02/08/2026;B;500.000,00;0,00;2.000.000,00"].join("\n"));
    const st = await parseStatement("x.csv", csv("1.500.000,50"));
    expect(st.notes?.join(" ")).toMatch(/1\.500\.000,50/);
    const quiet = await parseStatement("x.csv", csv("1.500.000,00"));
    expect((quiet.notes ?? []).join(" ")).not.toMatch(/sen/);
  });

  it("notes sen in BRI and BCA CSVs and in PDF rows", async () => {
    const bri = `NOREK;3333\nTGL_TRAN;DESK_TRAN;MUTASI_DEBET;MUTASI_KREDIT;SALDO_AKHIR_MUTASI\n2026-08-02;X;0.00;5000.50;15000.00\n`;
    expect((await parseStatement("bri.csv", Buffer.from(bri))).notes?.join(" ")).toMatch(/5000\.50/);
    const bca = ["Informasi Rekening - Mutasi Rekening", "No. rekening : 1", "Periode : 01/08/2026 - 31/08/2026", "", "Tanggal Transaksi,Keterangan,Cabang,Jumlah,,Saldo", `'02/08,"A",'0000,"2,450.75",DB,"97,549.25"`, `"Saldo Awal : 100,000.00"`].join("\n");
    expect((await parseStatement("bca.csv", Buffer.from(bca))).notes?.join(" ")).toMatch(/2,450\.75/);
    const pdf = await parseStatement("livin.pdf", mandiriLivinPdf((a) => (a > 0 ? "+" : "-") + idn(a).replace(",00", a === 45_678 ? ",50" : ",00")));
    expect(pdf.notes?.join(" ")).toMatch(/45\.678,50/);
  });

  it("reads a BRI TGL_TRAN CSV whose balance column is empty, saying the opening is unknown", async () => {
    const bri = `NOREK;3333\nTGL_TRAN;DESK_TRAN;MUTASI_DEBET;MUTASI_KREDIT;SALDO_AKHIR_MUTASI\n2026-08-02;X;0.00;5000.00;\n2026-08-03;Y;1000.00;0.00;\n`;
    const st = await parseStatement("bri.csv", Buffer.from(bri));
    expect(st.format).toBe("BRI");
    expect(st.rows.map((r) => r.amount)).toEqual([5000n, -1000n]);
    expect(st.openingBalance).toBe(0n);
    expect(st.closingBalance).toBe(4000n);
    expect(st.notes?.join(" ")).toMatch(/saldo.*kosong/i);
  });

  it("derives a BRI opening from the first balance that is printed", async () => {
    const bri = `NOREK;3333\nTGL_TRAN;DESK_TRAN;MUTASI_DEBET;MUTASI_KREDIT;SALDO_AKHIR_MUTASI\n2026-08-02;X;0.00;5000.00;\n2026-08-03;Y;1000.00;0.00;14000.00\n`;
    const st = await parseStatement("bri.csv", Buffer.from(bri));
    expect(st.openingBalance).toBe(10_000n);
    expect(checkContinuity(st).ok).toBe(true);
  });
});

describe("the bank is tagged from the statement's own words, not its transactions or names", () => {
  const csv = (...preamble: string[]) => Buffer.from([...preamble, "Tanggal,Keterangan,Debet,Kredit,Saldo", "01/08/2026,A,0,100,1100", "02/08/2026,B,50,0,1050"].join("\n"));

  it.each([
    [["Bank Mandiri - Livin' by Mandiri", "Rekening: 0000000123456"], "MANDIRI"],
    [["Mandiri Online - Mutasi Rekening"], "MANDIRI"],
    [["Bank Rakyat Indonesia", "Laporan Mutasi Rekening"], "BRI"],
    [["BRImo - Mutasi Rekening"], "BRI"],
    [["Informasi Rekening BCA"], "BCA"],
    [["PT Bank SMBC Indonesia Tbk"], "SMBC"],
    [["Laporan Mutasi Rekening", "Nama : PT SINAR MANDIRI ABADI"], "GENERIC"],
    [["CIMB Niaga - Rekening Koran"], "CIMB"],
    [["Laporan Mutasi Rekening", "Nama : PT PERMATA HIJAU"], "GENERIC"],
  ] as const)("CSV preamble %j → %s", async (preamble, format) => {
    expect((await parseStatement("x.csv", csv(...preamble))).format).toBe(format);
  });

  it("tags a workbook the same way", async () => {
    const buf = await xlsxBuffer("S", [["Bank Mandiri"], ["Tanggal", "Keterangan", "Debet", "Kredit", "Saldo"], ["01/08/2026", "TRSF KE BCA", 0, 100, 1100], ["02/08/2026", "B", 50, 0, 1050]]);
    expect((await parseStatement("x.xlsx", buf)).format).toBe("MANDIRI");
  });

  it("does not take a transaction's words for the bank: rows mentioning another bank stay GENERIC", async () => {
    const rows = [["Tanggal", "Keterangan", "Debet", "Kredit", "Saldo"], ["01/08/2026", "TRSF KE BANK MANDIRI", 0, 100, 1100], ["02/08/2026", "B", 50, 0, 1050]];
    expect((await parseStatement("x.xlsx", await xlsxBuffer("S", rows))).format).toBe("GENERIC");
  });

  it("detects a multi-account PDF's bank from its preamble, not from a transaction that names another bank", async () => {
    const head: [number, string][] = [[40, "Tanggal"], [110, "Keterangan"], [360, "Debit"], [440, "Kredit"], [520, "Saldo"]];
    const pdf = makePdf([
      [
        ...table(800, [[[40, "PT Bank Mandiri (Persero) Tbk"]], [[40, "Periode : 01/08/2026 - 31/08/2026"]]]),
        ...table(740, [
          [[25, "Aktivitas Rekening / Account Activities - Giro Utama (IDR) 1370098765432"]],
          head,
          [[40, "01/08/2026"], [110, "Saldo Awal"], [520, "1.000,00"]],
          [[40, "02/08/2026"], [110, "TRSF KE JENIUS BANK SMBC"], [440, "500,00"], [520, "1.500,00"]],
        ]),
      ],
    ]);
    const [st] = await parseStatementSections("x.pdf", pdf);
    expect(st.format).toBe("MANDIRI");
  });
});

describe("amounts that carry their direction", () => {
  const rows = (cell: (amt: number) => string, balance: (b: number) => string = (b) => en(b)) =>
    Buffer.from(["Tanggal,Keterangan,Jumlah,Saldo", ...TX.map((t, i) => `${p2(t.d)}/08/2026,${q(t.desc[0])},${q(cell(t.amt))},${q(balance(BAL[i]))}`)].join("\n"));
  const q = (s: string) => `"${s}"`;

  it.each([
    ["CR / DB suffix", (a: number) => `${en(a)} ${a < 0 ? "DB" : "CR"}`],
    ["D suffix on debits only (Mandiri savings)", (a: number) => `${en(a)}${a < 0 ? " D" : ""}`],
    ["Db. / Cr. with a dot", (a: number) => `${idn(a)} ${a < 0 ? "Db." : "Cr."}`],
    ["K / D (BNI)", (a: number) => `${idn(a)} ${a < 0 ? "D" : "K"}`],
    ["trailing minus", (a: number) => `${idn(a)}${a < 0 ? "-" : ""}`],
  ])("%s", async (_name, cell) => {
    const st = await parseStatement("x.csv", rows(cell));
    expectAugust(st);
  });

  it("says the direction was read from the amount's marker", async () => {
    const st = await parseStatement("x.csv", rows((a) => `${en(a)} ${a < 0 ? "DB" : "CR"}`));
    expect(st.notes?.some((n) => n.includes("Arah uang dibaca dari tanda"))).toBe(true);
  });

  it("reads a balance marked DB as overdrawn (below zero)", async () => {
    const csv = ["Tanggal,Keterangan,Jumlah,Saldo", `01/08/2026,"TARIK",${q("1,500.00 DB")},${q("500.00 DB")}`, `02/08/2026,"SETOR",${q("2,000.00 CR")},${q("1,500.00 CR")}`].join("\n");
    const st = await parseStatement("x.csv", Buffer.from(csv));
    expect(st.rows.map((r) => [r.amount, r.balance])).toEqual([[-1500n, -500n], [2000n, 1500n]]);
    expect(st.openingBalance).toBe(1000n);
  });

  it("reads a Db./Cr. flag column", async () => {
    const csv = ["Tanggal,Keterangan,Jumlah,Tipe,Saldo", ...TX.map((t, i) => `${p2(t.d)}/08/2026,${q(t.desc[0])},${q(en(t.amt))},${t.amt < 0 ? "Db." : "Cr."},${q(en(BAL[i]))}`)].join("\n");
    expectAugust(await parseStatement("x.csv", Buffer.from(csv)));
  });
});

describe("pockets and amounts read from the balance", () => {
  it("reads each Jago pocket as its own statement, with its own number", async () => {
    const jago = LAYOUTS.find((l) => l.bank === "JAGO")!;
    const sections = await parseStatementSections(jago.file, await jago.build());
    expect(sections.map((s) => [s.accountNumber, s.section?.label, s.rows.length])).toEqual([
      ["100200300400", "Kantong Utama", 5],
      ["100200300411", "Kantong Operasional", 5],
    ]);
  });

  it("reads an unsigned amount as money out when the balance went down, also on the first row", async () => {
    const head: [number, string][] = [[40, "TANGGAL TRANSAKSI"], [140, "DESKRIPSI"], [400, "JUMLAH"], [495, "SALDO"]];
    const pdf = makePdf([
      [
        ...table(800, [[[40, "PT Bank Seabank Indonesia"]], [[40, "PERIODE: 01 AUG 2026 - 31 AUG 2026"]]]),
        ...table(760, [head, [[40, "01 AUG"], [140, "SALDO AWAL"], [480, "1.000.000"]], [[40, "02 AUG"], [140, "QRIS TOKO"], [400, "250.000"], [480, "750.000"]], [[40, "03 AUG"], [140, "TRANSFER MASUK"], [400, "100.000"], [480, "850.000"]]]),
      ],
    ]);
    const st = await parseStatement("seabank.pdf", pdf);
    expect(st.rows.map((r) => r.amount)).toEqual([-250_000n, 100_000n]);
    expect(st.openingBalance).toBe(1_000_000n);
  });
});

describe("two-column zero sides and BRImo financial reports", () => {
  it.each(["0", "0.00", "0,00"])("accepts an exactly zero side %s beside a nonzero side", (zero) => {
    expect(() => assertSingleSide(zero, "100", 1)).not.toThrow();
    expect(() => assertSingleSide("100", zero, 1)).not.toThrow();
    expect(() => assertSingleSide(zero, zero, 1)).not.toThrow();
  });
  it.each([["100", "200"], ["0.40", "0.40"]])("still refuses two nonzero sides %s and %s, before rounding", (debit, credit) => {
    expect(() => assertSingleSide(debit, credit, 21)).toThrow(SourceAmountError);
    expect(() => assertSingleSide(debit, credit, 21)).toThrow(/Baris 21: Debet dan Kredit sama-sama berisi nominal/);
  });
  it.each([["100", "0.00", -100n, "900"], ["0.00", "100", 100n, "1100"], ["0.00", "0.00", 0n, "1000"]])("reads separate-line debit %s and credit %s without treating zero as the populated side", async (debit, credit, amount, balance) => {
    const file = makePdf([[
      ...table(800, [[[40, "BRI"]], [[40, "Saldo Awal: 1000"]]]),
      ...table(730, [
        [[40, "Tanggal"], [130, "Keterangan"], [330, "Debit"], [410, "Credit"], [510, "Balance"]],
        [[40, "13/08/2026"], [130, "Transfer sintetis"]],
        [[330, debit as string], [410, credit as string], [510, balance as string]],
      ]),
    ]]);
    const st = await parsePdf(file);
    expect(st.rows).toHaveLength(1);
    expect(st.rows[0].amount).toBe(amount);
  });
  it("reads the synthetic five-page BRImo report", async () => {
    const layout = LAYOUTS.find((l) => l.file === "bri-brimo.pdf")!;
    const sections = await parseStatementSections(layout.file, await layout.build());
    expect(sections[0].format).toBe("BRI");
    layout.check!(sections);
  });
  it("refuses a BRImo row whose debit and credit are both nonzero", async () => {
    await expect(parseStatement("brimo.pdf", brimoPdf({ credit: "100.00" }))).rejects.toThrow(SourceAmountError);
    await expect(parseStatement("brimo.pdf", brimoPdf({ credit: "100.00" }))).rejects.toThrow(/Debet dan Kredit sama-sama berisi nominal/);
  });
  it("preserves independently printed closing evidence when it contradicts the last movement", async () => {
    const st = await parseStatement("brimo.pdf", brimoPdf({ closing: "48,400,000.00" }));
    expect(st.closingBalance).toBe(48_400_000n);
    expect(st.provenance?.closing).toBe("PRINTED");
    expect(checkContinuity(st).ok).toBe(false);
  });
  it("keeps the existing whole-Rupiah rounding and reports sen", async () => {
    const st = await parseStatement("brimo.pdf", brimoPdf({ debit: "5,000,000.40" }));
    expect(st.rows[0].amount).toBe(-5_000_000n);
    expect(st.notes?.join(" ")).toMatch(/sen|dibulatkan/i);
    expect(checkContinuity(st).ok).toBe(true);
  });
  it.each([{ opening: "58,40x,000.00" }, { closing: "47,40x,000.00" }, { totalDebit: "120,00x,000.00" }, { totalCredit: "110,00x,000.00" }, { opening: "unreadable", closing: "unreadable", totalDebit: "unreadable", totalCredit: "unreadable" }])("refuses malformed printed summary evidence %j", async (opts) => {
    await expect(parseStatement("brimo.pdf", brimoPdf(opts))).rejects.toThrow(SourceAmountError);
  });
  it("declares a two-digit-year period range only under BRImo's title, where it is day first", () => {
    expect(periodOf("LAPORAN TRANSAKSI FINANSIAL\nPeriode Transaksi : 01/01/26 - 31/01/26")).toEqual({ start: new Date(Date.UTC(2026, 0, 1)), end: new Date(Date.UTC(2026, 0, 31)) });
    // Could be 1 Feb – 3 Apr or 2 Jan – 4 Mar: another layout leaves the period to its rows.
    expect(periodOf("Statement\nPeriod 01/02/26 - 03/04/26")).toBeNull();
  });
  it("reads BRImo summary values printed atop the next page when the labels end a page", async () => {
    const st = await parseStatement("brimo.pdf", brimoPdf({ summarySplit: true }));
    expect(st.format).toBe("BRI");
    expect(st.rows).toHaveLength(6);
    expect(st.openingBalance).toBe(57_400_000n);
    expect(st.closingBalance).toBe(47_400_000n);
    expect(st.provenance).toMatchObject({ opening: "PRINTED", closing: "PRINTED" });
    expect(checkContinuity(st).ok).toBe(true);
  });
  it.each([{ opening: "58,40x,000.00" }, { closing: "unreadable" }])("still refuses malformed summary values across a page break %j", async (opts) => {
    await expect(parseStatement("brimo.pdf", brimoPdf({ ...opts, summarySplit: true }))).rejects.toThrow(SourceAmountError);
  });
  it("refuses BRImo summary labels with no values on the same or the next page", async () => {
    const pdf = makePdf([table(800, [
      [[30, "LAPORAN TRANSAKSI FINANSIAL"]],
      [[30, "Nama Produk"], [170, ": Britama-IDR"]],
      [[30, "Periode Transaksi"], [170, ": 01/01/26 - 31/01/26"]],
      [[20, "Tanggal Transaksi"], [130, "Uraian Transaksi"], [330, "Teller"], [380, "Debet"], [450, "Kredit"], [530, "Saldo"]],
      [[20, "01/01/26 09:35:08"], [130, "Transfer Ke Andi via BRImo"], [330, "8888018"], [375, "5,000,000.00"], [445, "0.00"], [520, "52,400,000.00"]],
      [[30, "Saldo Awal"], [160, "Total Transaksi Debet"], [310, "Total Transaksi Kredit"], [460, "Saldo Akhir"]],
      [[30, "Opening Balance"], [160, "Total Debit Transaction"], [310, "Total Credit Transaction"], [460, "Closing Balance"]],
      [[30, "ABC1234_synthetic_e-"], [350, "Created By BRIMO"]],
      [[30, "2026010100000001"]],
    ])]);
    await expect(parseStatement("brimo.pdf", pdf)).rejects.toThrow(/ringkasan BRImo tidak lengkap/);
  });
  it("preserves independently printed opening evidence when it contradicts the first movement", async () => {
    const st = await parseStatement("brimo.pdf", brimoPdf({ opening: "58,400,000.00" }));
    expect(st.openingBalance).toBe(58_400_000n);
    expect(st.provenance?.opening).toBe("PRINTED");
    expect(checkContinuity(st).ok).toBe(false);
  });
});

describe("address/product-only password statement layouts", () => {
  it.each(["mandiri-estatement-password.pdf", "bni-wondr-password.pdf"])("reads %s with the correct password", async (file) => {
    const layout = LAYOUTS.find((l) => l.file === file)!;
    const sections = await parseStatementSections(file, await layout.build(), { password: layout.password });
    expect(sections[0].format).toBe(layout.bank);
    layout.check!(sections);
  });
  it.each([mandiriEstatementPdf, bniWondrPdf])("requests a password and refuses a wrong password", async (build) => {
    const file = build();
    await expect(parseStatement("statement.pdf", file)).rejects.toMatchObject({ reason: "needed" });
    await expect(parseStatement("statement.pdf", file, { password: "wrong" })).rejects.toBeInstanceOf(PdfPasswordError);
    await expect(parseStatement("statement.pdf", file, { password: "wrong" })).rejects.toMatchObject({ reason: "wrong" });
  });
  it.each(["TAPLUS - 8311100000", "TAPLUS BISNIS - 8311100000", "TAPLUS MUDA - 8311100000", "BNI Taplus - 8311100000", "Giro BNI - 8311100000"])("reads only the account number in the product header %s", async (productCell) => {
    const st = await parseStatement("statement.pdf", bniWondrPdf({ productCell }), { password: "synthetic-password" });
    expect(st.format).toBe("BNI");
    expect(st.accountNumber).toBe("8311100000");
  });
  it("reads the right-hand product cell when the holder also starts with a product word", async () => {
    const st = await parseStatement("statement.pdf", bniWondrPdf({ holder: "TAPLUS CONTOH" }), { password: "synthetic-password" });
    expect(st.accountNumber).toBe("8311100000");
  });
  it.each(["TAPLUS BISNIS", "TAPLUS BISNIS - 831110000", "TAPLUS BISNIS - 83111000001", "TAPLUS BISNIS 8311100000", "TAPLUS BISNIS-8311100000", "UNRELATED PRODUCT - 8311100000"])("does not guess an account from malformed/absent product number %s", async (productCell) => {
    const st = await parseStatement("statement.pdf", bniWondrPdf({ productCell }), { password: "synthetic-password" });
    expect(st.accountNumber).toBeNull();
    if (productCell !== "UNRELATED PRODUCT - 8311100000") expect(st.format).toBe("BNI");
  });
  it.each([
    { holder: "PT REKENING CONTOH", productCell: "TAPLUS BISNIS-8311100000" },
    { title: "Laporan Mutasi Rekening 9876543210", productCell: "TAPLUS BISNIS" },
  ])("never falls back to arbitrary holder/title digits in a product layout %j", async (opts) => {
    const st = await parseStatement("statement.pdf", bniWondrPdf(opts), { password: "synthetic-password" });
    expect(st.accountNumber).toBeNull();
  });
  it("keeps Mandiri's existing rows and metadata when only detection evidence changes", async () => {
    const read = (opts = {}) => parseStatement("statement.pdf", mandiriEstatementPdf(opts), { password: "synthetic-password" });
    const { format: branded, holder: brandedHolder, ...source } = await read();
    const { format: generic, holder: genericHolder, ...unchanged } = await read({ product: "Unbranded savings", bankAddress: "Jalan Contoh 1" });
    expect(branded).toBe("MANDIRI");
    expect(brandedHolder).toBe("BUDI CONTOH");
    expect(genericHolder).toBeUndefined();
    expect(generic).toBe("GENERIC");
    expect(unchanged).toEqual(source);
  });
  it("refuses an impossible declared shared-month period", async () => {
    await expect(parseStatement("statement.pdf", bniWondrPdf({ period: "Periode: 1 - 31 Februari 2026" }), { password: "synthetic-password" })).rejects.toThrow(SourceDateError);
  });
  it("does not use transaction or footer bank names for either layout", async () => {
    const mandiri = await parseStatement("statement.pdf", mandiriEstatementPdf({ product: "Unbranded savings", bankAddress: "Jalan Contoh 1" }), { password: "synthetic-password" });
    expect(mandiri.format).toBe("GENERIC");
    const bni = await parseStatement("statement.pdf", bniWondrPdf({ productCell: "UNRELATED PRODUCT - 8311100000", transactionDescription: "TAPLUS BISNIS - 8311100000 TRANSFER KE BANK MANDIRI" }), { password: "synthetic-password" });
    expect(bni.format).toBe("GENERIC");
    expect(bni.accountNumber).toBeNull();
  });
});

describe("printed account holders belong to headers only", () => {
  it.each([false, true])("reads BCA's labelled or known header position (labelled=%s)", async (labelled) => {
    const st = await parseStatement("statement.pdf", bcaHolderPdf({ labelled, holder: "  PT CONTOH FIKTIF  " }));
    expect(st.holder).toBe("PT CONTOH FIKTIF");
  });
  it("reads BRImo's holder at the left of its period field", async () => {
    expect((await parseStatement("statement.pdf", brimoPdf())).holder).toBe("BUDI CONTOH");
  });
  it.each(["Britama-IDR", "BRI", "JL CONTOH NO 1", "Alamat: JL CONTOH NO 1"])("never substitutes product/bank/address text %s for a BRImo holder", async (holder) => {
    expect((await parseStatement("statement.pdf", brimoPdf({ holder }))).holder).toBeUndefined();
  });
  it("reads Mandiri's labelled holder without the period or branch metadata", async () => {
    expect((await parseStatement("statement.pdf", mandiriEstatementPdf(), { password: "synthetic-password" })).holder).toBe("BUDI CONTOH");
  });
  it("reads BNI's holder even when it starts with a product name", async () => {
    expect((await parseStatement("statement.pdf", bniWondrPdf({ holder: "TAPLUS CONTOH" }), { password: "synthetic-password" })).holder).toBe("TAPLUS CONTOH");
  });
  it.each(["BCA", "REKENING TAHAPAN", "JL CONTOH NO 1", "JL. CONTOH NO 1", "Alamat: JL CONTOH NO 1", "PT Bank Central Asia Tbk"])("never substitutes bank/product/address text %s for a BCA holder", async (candidate) => {
    expect((await parseStatement("statement.pdf", bcaHolderPdf({ candidate }))).holder).toBeUndefined();
  });
  it.each([
    ["bca", () => bcaHolderPdf({ holder: null })],
    ["brimo", () => brimoPdf({ holder: null })],
    ["mandiri", () => mandiriEstatementPdf({ holder: null })],
    ["bni", () => bniWondrPdf({ holder: null })],
  ] as const)("leaves an absent %s holder undefined", async (_layout, build) => {
    expect((await parseStatement("statement.pdf", build(), { password: "synthetic-password" })).holder).toBeUndefined();
  });
  it("keeps BNI's right-hand account number when the holder cell is absent", async () => {
    const st = await parseStatement("statement.pdf", bniWondrPdf({ holder: null }), { password: "synthetic-password" });
    expect(st.accountNumber).toBe("8311100000");
    expect(st.holder).toBeUndefined();
  });
  it("leaves unsupported layouts undefined even when their header has a name", async () => {
    expect((await parseStatement("statement.pdf", bcaHolderPdf({ labelled: true, bank: "Bank Danamon" }))).holder).toBeUndefined();
  });
  it("does not read a transaction's labelled name when the header has none", async () => {
    expect((await parseStatement("statement.pdf", bcaHolderPdf({ holder: null }))).holder).toBeUndefined();
  });
  it("propagates the SMBC document holder, including a disabled foreign-currency section", async () => {
    const sections = await parseStatementSections("statement.pdf", smbcCombinedPdf({ holder: "PT INDUK CONTOH" }));
    expect(sections.map((st) => st.holder)).toEqual(["PT INDUK CONTOH", "PT INDUK CONTOH", "PT INDUK CONTOH"]);
    expect(sections[2].error).toMatch(/JPY/);
  });
  it("reads SMBC's recipient immediately below its standalone label", async () => {
    const sections = await parseStatementSections("statement.pdf", smbcCombinedPdf({ holder: "PT INDUK CONTOH", holderNextLine: true }));
    expect(sections.map((st) => st.holder)).toEqual(["PT INDUK CONTOH", "PT INDUK CONTOH", "PT INDUK CONTOH"]);
  });
  it("keeps SMBC section holders isolated and overrides the shared header per section", async () => {
    const sections = await parseStatementSections("statement.pdf", smbcCombinedPdf({ holder: "PT INDUK CONTOH", sectionHolders: ["PT REKENING SATU", undefined, "PT REKENING JPY"] }));
    expect(sections.map((st) => st.holder)).toEqual(["PT REKENING SATU", "PT INDUK CONTOH", "PT REKENING JPY"]);
  });
  it("never inherits another SMBC section's holder or the bank's own name", async () => {
    const sections = await parseStatementSections("statement.pdf", smbcCombinedPdf({ sectionHolders: ["PT REKENING SATU"] }));
    expect(sections.map((st) => st.holder)).toEqual(["PT REKENING SATU", undefined, undefined]);
  });
});
