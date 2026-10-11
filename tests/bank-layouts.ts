import { expect } from "vitest";
import type { BankCode } from "@/lib/generated/prisma/enums";
import type { ParsedStatement } from "@/lib/import/types";
import { checkContinuity } from "@/lib/import/normalize";
import { BAL, CLOSE, MON_EN, OPEN, TX, bniDirectCsv, bniDirectXlsx, cimbOctoCsv, cimbPdf, en, idn, mandiriLivinXlsx, p2, permataCsv, xlsxBuffer } from "./bank-fixture";
import { bniWondrPdf, brimoPdf, mandiriEstatementPdf, makePdf, smbcCombinedPdf, table, type PdfText } from "./pdf-fixture";

/**
 * One synthetic file per bank export Buku claims to read (`lib/banks.ts` formats), each holding the same five August 2026
 * transactions of a made-up company (`tests/bank-fixture.ts`), laid out as that bank documents it. `tests/unit/bank-layouts.test.ts`
 * reads every one (same rows, signs, dates, opening/closing, continuous balance, tagged with the bank) and
 * `tests/unit/bank-coverage.test.ts` fails when a bank lists a format with no layout here. Names and numbers are fake.
 */
export type Layout = {
  bank: BankCode;
  /** The `BankFormat.label` in `lib/banks.ts` this file stands for. */
  format: string;
  file: string;
  build: () => Buffer | Promise<Buffer>;
  password?: string;
  /** The description starts with a counterparty column (Jago's Sumber/Tujuan) rather than the bank's transaction text. */
  counterpartyFirst?: boolean;
  /** A file that isn't the five August rows (a real layout reproduced as it was): its own check instead of `expectAugust`. */
  check?: (sections: ParsedStatement[]) => void;
};

const q = (s: string) => `"${s}"`;
const text = (t: (typeof TX)[number]) => t.desc.join(" ");
const abs = (v: number) => Math.abs(v);
/** 1234567 → "1234567.00" (no thousands separator). */
const plain = (v: number) => `${abs(v)}.00`;

type Cells = [number, string][];
/** One page: heading lines at the top, then the column header, the rows and the footer lines, 12 pt apart. */
const pdfPage = (heading: string[], head: Cells, rows: Cells[], footer: string[] = []): Buffer =>
  makePdf([[...table(800, heading.map((l) => [[40, l]] as Cells)), ...table(800 - 12 * (heading.length + 1), [head, ...rows, ...footer.map((l) => [[40, l]] as Cells)])]]);
/** A transaction's first description line, then the rest on the lines below it (as banks wrap long descriptions). */
const wrapped = (t: (typeof TX)[number], x: number, first: Cells): Cells[] => [first, ...t.desc.slice(1).map((d) => [[x, d]] as Cells)];
const total = (sign: 1 | -1) => TX.filter((t) => Math.sign(t.amt) === sign).reduce((s, t) => s + Math.abs(t.amt), 0);
const ID_MON = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

/** "55500000,00" — SWIFT amounts: no thousands separator, comma decimals. */
const swift = (v: number) => `${Math.abs(v)},00`;
const yymmdd = (d: number, m = 8) => `26${p2(m)}${p2(d)}`;
/**
 * An MT940 file of the five August rows. `daily`: one statement per booking day (60F/62F each day, as banks send them by SFTP);
 * `bicIn`: the BIC in the SWIFT header blocks, or in front of the account in `:25:`.
 */
export function mt940(bic: string, account: string, opts: { daily?: boolean; bicIn?: "header" | "account" } = {}): Buffer {
  const header = opts.bicIn === "account" ? "" : `{1:F01${bic}AXXX0000000000}{2:O9401200260901${bic}XXXX00000000002609011200N}{4:\n`;
  const acct = opts.bicIn === "account" ? `${bic}/${account}` : account;
  const days = opts.daily ? [...new Set(TX.map((t) => t.d))] : [0];
  let balance = OPEN;
  let prevDate = yymmdd(31, 7);
  const blocks = days.map((day, k) => {
    const txs = TX.filter((t) => !opts.daily || t.d === day);
    const open = `:60${k === 0 ? "F" : "M"}:C${prevDate}IDR${swift(balance)}`;
    const lines = txs.flatMap((t) => {
      balance += t.amt;
      return [`:61:${yymmdd(t.d)}08${p2(t.d)}${t.amt < 0 ? "D" : "C"}${swift(t.amt)}NTRFNONREF//FT26${p2(t.d)}${String(Math.abs(t.amt)).slice(0, 4)}`, `:86:${t.desc[0]}`, ...t.desc.slice(1)];
    });
    const closeDate = opts.daily ? yymmdd(day) : yymmdd(31);
    prevDate = closeDate;
    return [`:20:STMT${closeDate}`, `:25:${acct}`, `:28C:${String(k + 1).padStart(5, "0")}/001`, open, ...lines, `:62${k === days.length - 1 ? "F" : "M"}:C${closeDate}IDR${swift(balance)}`, `:64:C${closeDate}IDR${swift(balance)}`].join("\n");
  });
  return Buffer.from(header + blocks.join("\n-}\n") + (header ? "\n-}" : ""));
}

export const LAYOUTS: Layout[] = [
  {
    bank: "BCA",
    format: "KlikBCA Bisnis (CSV)",
    file: "klikbca-bisnis-2026.csv",
    // Current export: every field quoted, full dates, the direction inside the amount cell, the summary after the rows.
    build: () =>
      Buffer.from(
        [
          q("Informasi Rekening - Mutasi Rekening"),
          q("No. rekening : 0000012345"),
          q("Nama : PT CONTOH FIKTIF"),
          q("Periode : 01/08/2026 - 31/08/2026"),
          q("Kode Mata Uang : Rp"),
          "",
          [q("Tanggal Transaksi"), q("Keterangan"), q("Cabang"), q("Jumlah"), q("Saldo")].join(","),
          ...TX.map((t, i) => [q(`${p2(t.d)}/08/2026`), q(`${text(t)}   `), q("0000"), q(`${en(t.amt)} ${t.amt < 0 ? "DB" : "CR"}`), q(en(BAL[i]))].join(",")),
          "",
          q(`Saldo Awal : ${en(OPEN)}`),
          [q(`Mutasi Debet : ${en(TX.filter((t) => t.amt < 0).reduce((s, t) => s - t.amt, 0))}`), q("3")].join(","),
          [q(`Mutasi Kredit : ${en(TX.filter((t) => t.amt > 0).reduce((s, t) => s + t.amt, 0))}`), q("2")].join(","),
          q(`Saldo Akhir : ${en(CLOSE)}`),
        ].join("\n"),
      ),
  },
  {
    bank: "BCA",
    format: "KlikBCA Individual (CSV)",
    file: "klikbca-individual.csv",
    // Unquoted descriptions with commas, `'dd/mm/yyyy`, plain amounts, CR/DB in the unlabeled column, `=` metadata and trailer.
    build: () =>
      Buffer.from(
        [
          "Account No.,=,'0000012345",
          "Name,=,PT CONTOH FIKTIF",
          "Currency,=,IDR",
          "",
          "Date,Description,Branch,Amount,,Balance",
          ...TX.map((t, i) => `'${p2(t.d)}/08/2026,${t.desc.join(", ")},0000,${plain(t.amt)},${t.amt < 0 ? "DB" : "CR"},${plain(BAL[i])}`),
          "",
          `Starting Balance,=,${plain(OPEN)}`,
          `Credit,=,${plain(TX.filter((t) => t.amt > 0).reduce((s, t) => s + t.amt, 0))}`,
          `Debet,=,${plain(TX.filter((t) => t.amt < 0).reduce((s, t) => s - t.amt, 0))}`,
          `Ending Balance,=,${plain(CLOSE)}`,
        ].join("\n"),
      ),
  },

  // ---- Mandiri ----
  { bank: "MANDIRI", format: "Livin' / MCM (Excel)", file: "mandiri-livin.xlsx", build: mandiriLivinXlsx },
  {
    bank: "MANDIRI",
    format: "Kopra / MCM (CSV)",
    file: "mandiri-kopra.csv",
    // MCM / Kopra account statement: Posting Date "01 Aug 2026 10:15:30", Remark, Reference, separate Debit / Credit, en numbers.
    build: () =>
      Buffer.from(
        [
          "Mandiri Cash Management - Account Statement",
          "Account No,1370000123456",
          "Account Name,PT CONTOH FIKTIF",
          "Period,01/08/2026 - 31/08/2026",
          "",
          "Posting Date,Remark,Reference No,Debit,Credit,Balance",
          ...TX.map((t, i) => `${q(`${p2(t.d)} Aug 2026 10:15:30`)},${q(text(t))},${q(`REF${7000 + i}`)},${q(t.amt < 0 ? en(t.amt) : "0.00")},${q(t.amt > 0 ? en(t.amt) : "0.00")},${q(en(BAL[i]))}`),
          `Opening Balance,${q(en(OPEN))}`,
          `Closing Balance,${q(en(CLOSE))}`,
        ].join("\n"),
      ),
  },
  // ---- BRI ----
  {
    bank: "BRI",
    format: "BRImo / CMS (CSV)",
    file: "bri-cms.csv",
    build: () =>
      Buffer.from(
        [
          "NOREK;000001000123509",
          "TGL_TRAN;DESK_TRAN;MUTASI_DEBET;MUTASI_KREDIT;SALDO_AKHIR_MUTASI",
          ...TX.map((t, i) => `2026-08-${p2(t.d)};${text(t)};${t.amt < 0 ? abs(t.amt) : 0};${t.amt > 0 ? t.amt : 0};${BAL[i]}`),
        ].join("\n"),
      ),
  },
  {
    bank: "BRI",
    format: "internet banking (CSV)",
    file: "bri-ib.csv",
    build: () =>
      Buffer.from(
        [
          "PT. BANK RAKYAT INDONESIA (PERSERO) Tbk.",
          "Laporan Mutasi Rekening",
          "No. Rekening : 0000-01-000123-50-9",
          "",
          "Tanggal Transaksi,Uraian Transaksi,Teller,Debet,Kredit,Saldo",
          ...TX.map((t, i) => `${p2(t.d)}/08/26,${q(text(t))},0000123,${q(t.amt < 0 ? idn(t.amt) : "0,00")},${q(t.amt > 0 ? idn(t.amt) : "0,00")},${q(idn(BAL[i]))}`),
        ].join("\n"),
      ),
  },
  {
    bank: "BRI",
    format: "QLola (Excel)",
    file: "bri-qlola.xlsx",
    // The header row is not at the top; dd-mm-yy dates; Uraian Transaksi; Debet / Kredit.
    build: () =>
      xlsxBuffer("Mutasi", [
        ["QLola by BRI"],
        ["Laporan Mutasi Rekening"],
        ["Nomor Rekening", "0000-01-000123-50-9"],
        ["Periode", "01/08/2026 - 31/08/2026"],
        [],
        ["No", "Tanggal Transaksi", "Uraian Transaksi", "Teller", "Debet", "Kredit", "Saldo"],
        ...TX.map((t, i) => [i + 1, `${p2(t.d)}-08-26`, text(t), "8888", t.amt < 0 ? abs(t.amt) : 0, t.amt > 0 ? t.amt : 0, BAL[i]]),
      ]),
  },
  // ---- BNI ----
  { bank: "BNI", format: "BNIDirect (CSV)", file: "bni-direct.csv", build: bniDirectCsv },
  { bank: "BNI", format: "BNIDirect (Excel)", file: "bni-direct.xlsx", build: bniDirectXlsx },
  {
    bank: "BNI",
    format: "BNI Mobile (Excel)",
    file: "bni-mobile.xlsx",
    build: () =>
      xlsxBuffer("Sheet1", [
        ["BNI Mobile Banking - Mutasi Rekening"],
        ["Tanggal", "Keterangan", "Tipe", "Jumlah", "Saldo"],
        ...TX.map((t, i) => [`${p2(t.d)}/08/2026`, text(t), t.amt < 0 ? "DB" : "CR", abs(t.amt), BAL[i]]),
      ]),
  },
  // ---- CIMB Niaga ----
  { bank: "CIMB", format: "OCTO / BizChannel (CSV)", file: "cimb-octo.csv", build: () => cimbOctoCsv(MON_EN[7]) },
  {
    bank: "CIMB",
    format: "OCTO (Excel)",
    file: "cimb-octo.xlsx",
    build: () =>
      xlsxBuffer("Sheet1", [
        ["PT Bank CIMB Niaga Tbk"],
        ["Nomor Rekening", "800123456789"],
        [],
        ["Tgl. Txn", "Tgl. Valuta", "Deskripsi", "No. Ref/Cek", "Debit", "Kredit", "Saldo"],
        ...TX.map((t, i) => [`${p2(t.d)}/08/2026`, `${p2(t.d)}/08/2026`, text(t), `${900 + i}`, t.amt < 0 ? en(t.amt) : "0.00", t.amt > 0 ? en(t.amt) : "0.00", en(BAL[i])]),
      ]),
  },
  // ---- Permata ----
  { bank: "PERMATA", format: "PermataNet (CSV)", file: "permata.csv", build: permataCsv },
  {
    bank: "PERMATA",
    format: "PermataNet (Excel)",
    file: "permata.xlsx",
    build: () =>
      xlsxBuffer("Sheet1", [
        ["PermataNet - Mutasi Rekening"],
        ["No. Rekening : 4100123456"],
        ["Tanggal Transaksi", "Tanggal Efektif", "Deskripsi", "Debit", "Kredit", "Saldo"],
        ...TX.map((t, i) => [`${p2(t.d)}/08/2026`, `${p2(t.d)}/08/2026`, text(t), t.amt < 0 ? abs(t.amt) : 0, t.amt > 0 ? t.amt : 0, BAL[i]]),
      ]),
  },
  // ---- Inferred layouts (no public sample): the bank's heading + a common table ----
  {
    bank: "DANAMON",
    format: "Danamon Cash Connect (CSV)",
    file: "danamon.csv",
    build: () =>
      Buffer.from(
        [
          "Danamon Cash Connect - Rekening Koran",
          "No. Rekening : 003600123456",
          "Tanggal,Keterangan,Debit,Kredit,Saldo",
          ...TX.map((t, i) => `${p2(t.d)}/08/2026,${q(text(t))},${q(t.amt < 0 ? en(t.amt) : "")},${q(t.amt > 0 ? en(t.amt) : "")},${q(en(BAL[i]))}`),
        ].join("\n"),
      ),
  },
  {
    bank: "OCBC",
    format: "OCBC Business / Velocity (CSV)",
    file: "ocbc.csv",
    build: () =>
      Buffer.from(
        [
          "OCBC Business - Account Statement",
          "Account Number,693800123456",
          "Transaction Date,Value Date,Description,Withdrawals,Deposits,Balance",
          ...TX.map((t, i) => `${p2(t.d)}/08/2026,${p2(t.d)}/08/2026,${q(text(t))},${q(t.amt < 0 ? en(t.amt) : "")},${q(t.amt > 0 ? en(t.amt) : "")},${q(en(BAL[i]))}`),
        ].join("\n"),
      ),
  },
  {
    bank: "PANIN",
    format: "Panin internet banking (Excel)",
    file: "panin.xlsx",
    build: () =>
      xlsxBuffer("Mutasi", [
        ["PaninBank Internet Banking"],
        ["No. Rekening : 1002003004"],
        ["Tgl Transaksi", "Keterangan", "Debet", "Kredit", "Saldo"],
        ["", "Saldo Awal", "", "", OPEN],
        ...TX.map((t, i) => [`${p2(t.d)}/08/2026`, text(t), t.amt < 0 ? abs(t.amt) : 0, t.amt > 0 ? t.amt : 0, BAL[i]]),
      ]),
  },
  {
    bank: "MEGA",
    format: "Mega internet banking (Excel)",
    file: "mega.xlsx",
    build: () =>
      xlsxBuffer("Sheet1", [
        ["PT Bank Mega Tbk"],
        ["Nomor Rekening : 010000123456"],
        ["Tanggal", "Uraian", "Mutasi Debet", "Mutasi Kredit", "Saldo"],
        ...TX.map((t, i) => [`${p2(t.d)}-${MON_EN[7]}-2026`, text(t), t.amt < 0 ? idn(t.amt) : "0,00", t.amt > 0 ? idn(t.amt) : "0,00", idn(BAL[i])]),
      ]),
  },
  {
    bank: "DKI",
    format: "CMS Bank DKI (CSV)",
    file: "dki.csv",
    build: () =>
      Buffer.from(
        [
          "PT Bank DKI - Cash Management System",
          "Nomor Rekening;10208001234",
          "Tanggal;Jam;Keterangan;Debet;Kredit;Saldo",
          ...TX.map((t, i) => `${p2(t.d)}/08/2026;10:15:30;${text(t)};${t.amt < 0 ? idn(t.amt) : "0,00"};${t.amt > 0 ? idn(t.amt) : "0,00"};${idn(BAL[i])}`),
        ].join("\n"),
      ),
  },
  {
    bank: "BJB",
    format: "bjb internet banking (Excel)",
    file: "bjb.xlsx",
    build: () =>
      xlsxBuffer("Sheet1", [
        ["bank bjb - Mutasi Rekening"],
        ["No. Rekening : 0012345678100"],
        ["Tanggal", "Keterangan", "Debet", "Kredit", "Saldo"],
        ...TX.map((t, i) => [`${p2(t.d)}/08/2026`, text(t), t.amt < 0 ? abs(t.amt) : 0, t.amt > 0 ? t.amt : 0, BAL[i]]),
      ]),
  },

  // ---- PDF ----
  {
    bank: "BCA",
    format: "e-statement Tahapan / Giro",
    file: "bca-estatement.pdf",
    // Year-less DD/MM, CBG column, one MUTASI column with DB/CR after it, SALDO AWAL row, the summary block at the end.
    build: () =>
      pdfPage(
        ["REKENING GIRO", "BCA", "NAMA : PT CONTOH FIKTIF", "NO. REKENING : 0000012345", "PERIODE : AGUSTUS 2026", "MATA UANG : IDR"],
        [[40, "TANGGAL"], [100, "KETERANGAN"], [330, "CBG"], [410, "MUTASI"], [510, "SALDO"]],
        [
          [[40, "01/08"], [100, "SALDO AWAL"], [490, en(OPEN)]],
          ...TX.flatMap((t, i) => wrapped(t, 100, [[40, `${p2(t.d)}/08`], [100, t.desc[0]], [330, "0998"], [390, en(t.amt)], [462, t.amt < 0 ? "DB" : "CR"], [490, en(BAL[i])]])),
        ],
        [`SALDO AWAL : ${en(OPEN)}`, `MUTASI CR : ${en(total(1))}`, `MUTASI DB : ${en(total(-1))}`, `SALDO AKHIR : ${en(CLOSE)}`],
      ),
  },
  {
    bank: "BCA",
    format: "KlikBCA mutasi rekening (cetak PDF)",
    file: "klikbca-mutasi.pdf",
    // The printed Mutasi Rekening page: full dates, a description line just above the amount line and the rest below it.
    build: () => {
      const texts: PdfText[] = [
        ...table(800, [[[40, "KlikBCA Bisnis - Mutasi Rekening"]], [[40, "No. Rekening : 0000012345"]], [[40, "Periode : 01/08/2026 - 31/08/2026"]]]),
        ...table(740, [[[40, "TGL"], [110, "KETERANGAN"], [330, "CABANG"], [410, "JUMLAH"], [510, "SALDO"]]]),
      ];
      TX.forEach((t, i) => {
        const y = 716 - i * 30;
        texts.push({ x: 110, y: y + 4, text: t.desc[0] });
        texts.push({ x: 40, y, text: `${p2(t.d)}/08/2026` }, { x: 330, y, text: "0000" }, { x: 390, y, text: `${en(t.amt)} ${t.amt < 0 ? "DB" : "CR"}` }, { x: 490, y, text: en(BAL[i]) });
        if (t.desc[1]) texts.push({ x: 110, y: y - 9, text: t.desc[1] });
      });
      texts.push({ x: 40, y: 540, text: `Saldo Awal : ${en(OPEN)}` }, { x: 40, y: 528, text: `Saldo Akhir : ${en(CLOSE)}` });
      return makePdf([texts]);
    },
  },
  {
    bank: "MANDIRI",
    format: "e-Statement (Livin')",
    file: "mandiri-livin-estatement.pdf",
    // New Livin' e-Statement: a row-number column, bilingual headers, "02 Agu 2026 10:15:30 WIB", signed Indonesian amounts.
    build: () =>
      pdfPage(
        ["e-Statement", "PT Bank Mandiri (Persero) Tbk", "Nomor Rekening 1370000123456", "Periode/Period : 01 Agu 2026 - 31 Agu 2026", `Saldo Awal/Initial Balance ${idn(OPEN)}`, `Saldo Akhir/Closing Balance ${idn(CLOSE)}`],
        [[40, "No"], [62, "Tanggal/Date"], [190, "Keterangan/Remarks"], [400, "Nominal/Amount"], [495, "Saldo/Balance"]],
        TX.flatMap((t, i) => wrapped(t, 190, [[40, String(i + 1)], [62, `${p2(t.d)} ${ID_MON[7]} 2026 10:15:30 WIB`], [190, t.desc[0]], [400, (t.amt < 0 ? "-" : "") + idn(t.amt)], [495, idn(BAL[i])]])),
      ),
  },
  {
    bank: "MANDIRI", format: "e-Statement (Livin')", file: "mandiri-estatement-password.pdf", build: mandiriEstatementPdf, password: "synthetic-password",
    check: (sections) => {
      expect(sections).toHaveLength(1);
      const st = sections[0];
      expect(st.holder).toBe("BUDI CONTOH");
      expect(st.accountNumber).toBe("1110001234567");
      expect(st.currency).toBe("IDR");
      expect(st.openingBalance).toBe(80_000_001n);
      expect(st.closingBalance).toBe(75_000_001n);
      expect(st.rows.map((r) => r.amount)).toEqual([-5_000_000n, 1_000_000n, -3_000_000n, 1_000_000n, -4_000_000n, 1_000_000n, -3_000_000n, 2_000_000n, 5_000_000n]);
      expect(st.rows[0].description).toBe("Transfer ke BANK MANDIRI ANDI CONTOH 1010000000001");
      expect(st.rows.every((r) => !/WIB|Disclaimer/.test(r.description))).toBe(true);
      expect(st.provenance).toEqual({ period: "DECLARED", opening: "PRINTED", closing: "PRINTED" });
      expect(checkContinuity(st).ok).toBe(true);
    },
  },
  {
    bank: "MANDIRI",
    format: "rekening koran tabungan",
    file: "mandiri-tabungan.pdf",
    // Older savings statement: transaction and posting dates (dd/mm), debits with a " D" suffix, en numbers, bilingual summary.
    build: () =>
      pdfPage(
        ["PT Bank Mandiri (Persero) Tbk", "Rekening Koran Tabungan / Savings Statement", "Nomor Rekening : 1370000123456", "Periode : 01/08/2026 - 31/08/2026"],
        [[40, "Tanggal"], [90, "Tgl. Valuta"], [150, "Keterangan"], [400, "Mutasi"], [500, "Saldo"]],
        TX.flatMap((t, i) => wrapped(t, 150, [[40, `${p2(t.d)}/08`], [90, `${p2(t.d)}/08`], [150, t.desc[0]], [400, `${en(t.amt)}${t.amt < 0 ? " D" : ""}`], [490, en(BAL[i])]])),
        [`Saldo Awal / Previous Balance : ${en(OPEN)}`, `Mutasi Kredit / Total of Credit Transactions : ${en(total(1))}`, `Mutasi Debit / Total of Debit Transactions : ${en(total(-1))}`, `Saldo Akhir / Current Balance : ${en(CLOSE)}`],
      ),
  },
  {
    bank: "MANDIRI",
    format: "MCM / Kopra account statement",
    file: "mandiri-mcm-statement.pdf",
    build: () =>
      pdfPage(
        ["Mandiri Cash Management", "Account Statement", "Account No : 1370000123456", "Period : 01/08/2026 - 31/08/2026", `Opening Balance ${en(OPEN)}`],
        [[40, "Posting Date"], [120, "Remark"], [300, "Reference No"], [375, "Debit"], [450, "Credit"], [525, "Balance"]],
        TX.flatMap((t, i) => wrapped(t, 120, [[40, `${p2(t.d)}/08/2026 10:15`], [120, t.desc[0]], [300, `REF${7000 + i}`], [360, t.amt < 0 ? en(t.amt) : "0.00"], [435, t.amt > 0 ? en(t.amt) : "0.00"], [505, en(BAL[i])]])),
        [`Closing Balance ${en(CLOSE)}`],
      ),
  },
  {
    bank: "BNI",
    format: "BNI account statement (korporat)",
    file: "bni-account-statement.pdf",
    // Posting / Effective Date, Branch and Journal before the description, one Amount with D/K, Balance.
    build: () =>
      pdfPage(
        ["ACCOUNT STATEMENT", "PT Bank Negara Indonesia (Persero) Tbk", "Account No : 0000001234", "Period : 01-Aug-2026 - 31-Aug-2026"],
        [[20, "Posting Date"], [78, "Effective Date"], [136, "Branch"], [176, "Journal"], [214, "Transaction Description"], [440, "Amount"], [488, "DB/CR"], [525, "Balance"]],
        TX.flatMap((t, i) => wrapped(t, 214, [[20, `${p2(t.d)}/08/2026`], [78, `${p2(t.d)}/08/2026`], [136, "0998"], [176, String(123456 + i)], [214, t.desc[0]], [438, en(t.amt)], [492, t.amt < 0 ? "D" : "K"], [507, en(BAL[i])]])),
      ),
  },
  {
    bank: "BNI",
    format: "e-statement tabungan",
    file: "bni-tabungan.pdf",
    // Older savings statement: dd-Mmm-yy, a Db./Cr. column beside the amount.
    build: () =>
      pdfPage(
        ["PT Bank Negara Indonesia (Persero) Tbk", "Histori Transaksi", "No. Rekening : 0000001234", "Periode : 01/08/2026 - 31/08/2026", `Saldo Awal : ${en(OPEN)}`],
        [[40, "Tanggal"], [110, "Uraian Transaksi"], [360, "Nominal"], [430, "Db/Cr"], [500, "Saldo"]],
        TX.flatMap((t, i) => wrapped(t, 110, [[40, `${p2(t.d)}-${MON_EN[7]}-26`], [110, t.desc[0]], [345, en(t.amt)], [432, t.amt < 0 ? "Db." : "Cr."], [485, en(BAL[i])]])),
        [`Saldo Akhir : ${en(CLOSE)}`],
      ),
  },
  {
    bank: "BNI",
    format: "wondr Laporan Mutasi Rekening",
    file: "bni-wondr.pdf",
    // wondr by BNI: "01 Aug 2026 08:14:47 WIB", signed whole-Rupiah amounts with comma thousands.
    build: () =>
      pdfPage(
        ["wondr by BNI", "Laporan Mutasi Rekening", "No. Rekening : 0000001234", "Periode: 01 Aug 2026 - 31 Aug 2026", `Saldo Awal ${Math.abs(OPEN).toLocaleString("en-US")}`],
        [[40, "Tanggal & Waktu"], [170, "Rincian Transaksi"], [400, "Nominal"], [500, "Saldo"]],
        TX.flatMap((t, i) => wrapped(t, 170, [[40, `${p2(t.d)} ${MON_EN[7]} 2026 08:14:47 WIB`], [170, t.desc[0]], [400, `${t.amt < 0 ? "-" : "+"}${Math.abs(t.amt).toLocaleString("en-US")}`], [490, BAL[i].toLocaleString("en-US")]])),
        [`Saldo Akhir ${CLOSE.toLocaleString("en-US")}`],
      ),
  },
  {
    bank: "BNI", format: "wondr Laporan Mutasi Rekening", file: "bni-wondr-password.pdf", build: bniWondrPdf, password: "synthetic-password",
    check: (sections) => {
      expect(sections).toHaveLength(1);
      const st = sections[0];
      expect(st.holder).toBe("BUDI CONTOH");
      expect(st.accountNumber).toBe("8311100000");
      expect(st.currency).toBe("IDR");
      expect(st.periodStart.toISOString().slice(0, 10)).toBe("2026-01-01");
      expect(st.periodEnd.toISOString().slice(0, 10)).toBe("2026-01-31");
      expect(st.provenance).toEqual({ period: "DECLARED", opening: "PRINTED", closing: "PRINTED" });
      expect(st.openingBalance).toBe(20_000_000n);
      expect(st.closingBalance).toBe(18_000_000n);
      expect(st.rows.map((r) => r.amount)).toEqual([1_000_000n, 1_000_000n, -2_000_000n, 1_000_000n, -5_000_000n, 2_000_000n]);
      expect(st.rows.every((r) => /^Lainnya TRANSFER/.test(r.description) && !/WIB|Informasi/.test(r.description))).toBe(true);
      expect(checkContinuity(st).ok).toBe(true);
    },
  },
  {
    bank: "BRI",
    format: "Rincian Rekening Koran",
    file: "bri-rincian.pdf",
    build: () =>
      pdfPage(
        ["Yth. Bapak/Ibu PT CONTOH FIKTIF", "Rincian Rekening Koran", "PT. BANK RAKYAT INDONESIA (PERSERO) Tbk.", "No. Rekening : 0000-01-000123-50-9", "Periode : 01/08/2026 - 31/08/2026", `Saldo Awal : ${idn(OPEN)}`],
        [[40, "Tanggal Transaksi"], [125, "Uraian Transaksi"], [330, "Teller"], [385, "Debet"], [455, "Kredit"], [525, "Saldo"]],
        TX.flatMap((t, i) => wrapped(t, 125, [[40, `${p2(t.d)}/08/26`], [125, t.desc[0]], [330, "8888"], [370, t.amt < 0 ? idn(t.amt) : "0,00"], [440, t.amt > 0 ? idn(t.amt) : "0,00"], [505, idn(BAL[i])]])),
        [`Total Mutasi Debet : ${idn(total(-1))}`, `Saldo Akhir : ${idn(CLOSE)}`],
      ),
  },
  {
    bank: "BRI",
    format: "BRImo Laporan Transaksi Finansial",
    file: "bri-brimo.pdf",
    build: brimoPdf,
    check: (sections) => {
      expect(sections).toHaveLength(1);
      const st = sections[0];
      expect(st.holder).toBe("BUDI CONTOH");
      expect(st.accountNumber).toBe("123401000012345");
      expect(st.currency).toBe("IDR");
      expect(st.periodStart.toISOString().slice(0, 10)).toBe("2026-01-01");
      expect(st.periodEnd.toISOString().slice(0, 10)).toBe("2026-01-31");
      expect(st.provenance).toEqual({ period: "DECLARED", opening: "PRINTED", closing: "PRINTED" });
      expect(st.openingBalance).toBe(57_400_000n);
      expect(st.closingBalance).toBe(47_400_000n);
      expect(st.rows.map((r) => r.amount)).toEqual([-5_000_000n, 185_000n, -1_469_322n, 99_815_000n, -113_530_678n, 10_000_000n]);
      expect(st.rows[2].description).toBe("Pembayaran Tagihan Kartu Kredit 5100xxxx001 via BRImo");
      expect(st.rows.every((r) => !/Created By|StatementBRImo|88880/.test(r.description))).toBe(true);
      expect(checkContinuity(st).ok).toBe(true);
    },
  },
  {
    bank: "BRI",
    format: "IBBIZ Laporan Transaksi Finansial",
    file: "bri-ibbiz.pdf",
    build: () =>
      pdfPage(
        ["BRI IBBIZ", "Laporan Transaksi Finansial", "No. Rekening : 000001000123509", "Periode : 01/08/2026 - 31/08/2026"],
        [[40, "Tanggal Transaksi"], [125, "Keterangan"], [330, "Teller"], [385, "Debet"], [455, "Kredit"], [525, "Saldo"]],
        TX.flatMap((t, i) => wrapped(t, 125, [[40, `${p2(t.d)}/08/26 10:15:30`], [125, t.desc[0]], [330, "8888"], [370, t.amt < 0 ? en(t.amt) : "0.00"], [440, t.amt > 0 ? en(t.amt) : "0.00"], [505, en(BAL[i])]])),
      ),
  },
  {
    bank: "BSI",
    format: "e-statement BSI",
    file: "bsi.pdf",
    // DD/MM dates (year from the period), debits printed "- 2,450,000.00" in the Debit column, a SALDO AWAL row.
    build: () =>
      pdfPage(
        ["PT Bank Syariah Indonesia Tbk", "Laporan Rekening", "No. Rekening : 7100123456", "Periode 01/08/2026 - 31/08/2026"],
        [[40, "Tanggal"], [100, "Keterangan"], [300, "No. Referensi"], [380, "Debit"], [455, "Kredit"], [525, "Saldo"]],
        [
          [[40, "01/08"], [100, "SALDO AWAL"], [505, en(OPEN)]],
          ...TX.flatMap((t, i) => wrapped(t, 100, [[40, `${p2(t.d)}/08`], [100, t.desc[0]], [300, `FT${7000 + i}`], [365, t.amt < 0 ? `- ${en(t.amt)}` : "0.00"], [440, t.amt > 0 ? en(t.amt) : "0.00"], [505, en(BAL[i])]])),
        ],
      ),
  },
  {
    bank: "BTN",
    format: "rekening koran BTN",
    file: "btn.pdf",
    build: () =>
      pdfPage(
        ["PT BANK TABUNGAN NEGARA (PERSERO) TBK", "REKENING KORAN", "Account : 0001234567890", `Last Bal : ${en(OPEN)}`],
        [[40, "TRANS DATE"], [100, "EFF DATE"], [160, "TRANS DESCRIPTION"], [380, "DEBIT"], [450, "CREDIT"], [525, "BALANCE"]],
        TX.flatMap((t, i) => wrapped(t, 160, [[40, `${p2(t.d)}/08/2026`], [100, `${p2(t.d)}/08/2026`], [160, t.desc[0]], [365, t.amt < 0 ? en(t.amt) : "0.00"], [435, t.amt > 0 ? en(t.amt) : "0.00"], [505, en(BAL[i])]])),
      ),
  },
  { bank: "CIMB", format: "e-statement CIMB Niaga", file: "cimb.pdf", build: () => cimbPdf() },
  {
    bank: "SINARMAS",
    format: "e-statement Sinarmas",
    file: "sinarmas.pdf",
    build: () =>
      pdfPage(
        ["PT Bank Sinarmas Tbk", "Rekening Koran", "No. Rekening : 0051234567", "Periode : 01/08/2026 - 31/08/2026"],
        [[40, "Tanggal"], [110, "Keterangan"], [360, "Debet"], [440, "Kredit"], [520, "Saldo"]],
        [[[40, "01/08/2026"], [110, "SALDO AWAL"], [500, idn(OPEN)]], ...TX.flatMap((t, i) => wrapped(t, 110, [[40, `${p2(t.d)}/08/2026`], [110, t.desc[0]], [345, t.amt < 0 ? idn(t.amt) : ""], [425, t.amt > 0 ? idn(t.amt) : ""], [500, idn(BAL[i])]]))],
      ),
  },
  {
    bank: "MANDIRI",
    format: "e-Statement (Livin')",
    file: "mandiri-livin-estatement-time-below.pdf",
    // The same e-Statement as extracted from some PDFs: the time on its own line under the date.
    build: () =>
      pdfPage(
        ["e-Statement", "PT Bank Mandiri (Persero) Tbk", "Nomor Rekening 1370000123456", "Periode/Period : 01 Agu 2026 - 31 Agu 2026", `Saldo Awal/Initial Balance ${idn(OPEN)}`],
        [[40, "No"], [62, "Tanggal/Date"], [190, "Keterangan/Remarks"], [400, "Nominal/Amount"], [495, "Saldo/Balance"]],
        TX.flatMap((t, i) => [
          [[40, String(i + 1)], [62, `${p2(t.d)} ${ID_MON[7]} 2026`], [190, t.desc[0]], [400, (t.amt < 0 ? "-" : "") + idn(t.amt)], [495, idn(BAL[i])]] as Cells,
          [[62, "10:15:30 WIB"], ...(t.desc[1] ? ([[190, t.desc[1]]] as Cells) : [])] as Cells,
        ]),
      ),
  },
  {
    bank: "BLU",
    format: "e-statement blu",
    file: "blu.pdf",
    // blu by BCA Digital: the amount and balance on the line after the date and description.
    build: () =>
      pdfPage(
        ["blu by BCA Digital", "Rekening Koran", "No. Rekening : 001234567890", "Periode : 01 Agu 2026 - 31 Agu 2026", `Saldo Awal ${idn(OPEN)}`],
        [[40, "Tanggal"], [110, "Keterangan"], [390, "Nominal"], [490, "Saldo"]],
        TX.flatMap((t, i) => [
          [[40, `${p2(t.d)}/08/2026`], [110, t.desc[0]]] as Cells,
          [...(t.desc[1] ? ([[110, t.desc[1]]] as Cells) : []), [390, `${t.amt < 0 ? "-" : "+"}${idn(t.amt)}`], [480, idn(BAL[i])]] as Cells,
        ]),
        [`Saldo Akhir ${idn(CLOSE)}`],
      ),
  },
  {
    bank: "JAGO",
    format: "e-statement Jago (per kantong)",
    file: "jago.pdf",
    counterpartyFirst: true,
    // One statement, two pockets, each with its own number and table: Tanggal & Waktu | Sumber/Tujuan | Rincian Transaksi | Catatan | Jumlah | Saldo.
    build: () => {
      const head: Cells = [[30, "Tanggal & Waktu"], [110, "Sumber/Tujuan"], [215, "Rincian Transaksi"], [380, "Catatan"], [425, "Jumlah"], [505, "Saldo"]];
      const pocket = (title: string): Cells[] => [
        [[30, title]],
        [[30, `Saldo Sebelumnya ${idn(OPEN)}`]],
        head,
        ...TX.map((t, i) => [[30, `${t.d} ${ID_MON[7]} 2026 10:15`], [110, t.desc[1] ?? "-"], [215, t.desc[0]], [380, `ID#${4100 + i}`], [425, `${t.amt < 0 ? "-" : "+"}${idn(t.amt)}`], [500, idn(BAL[i])]] as Cells),
        [[30, `Saldo Akhir ${idn(CLOSE)}`]],
      ];
      return makePdf([
        [...table(800, [[[30, "PT Bank Jago Tbk"]], [[30, "Laporan Rekening · Periode 01 Agu 2026 - 31 Agu 2026"]]]), ...table(760, [...pocket("Kantong Utama · 100200300400"), [], ...pocket("Kantong Operasional · 100200300411")])],
      ]);
    },
  },
  {
    bank: "SEABANK",
    format: "rekening koran SeaBank",
    file: "seabank.pdf",
    // "DD MON" with an English month and no year, whole Rupiah, one unsigned amount: the direction comes from the balance.
    build: () =>
      pdfPage(
        ["REKENING KORAN", "PT Bank Seabank Indonesia", "NO. REKENING SEABANK: 9000123456", "PERIODE: 01 AUG 2026 - 31 AUG 2026", "TABUNGAN - RINCIAN TRANSAKSI"],
        [[40, "TANGGAL TRANSAKSI"], [140, "DESKRIPSI"], [400, "JUMLAH"], [495, "SALDO"]],
        [[[40, "01 AUG"], [140, "SALDO AWAL"], [480, OPEN.toLocaleString("id-ID")]], ...TX.flatMap((t, i) => wrapped(t, 140, [[40, `${p2(t.d)} AUG`], [140, t.desc[0]], [400, Math.abs(t.amt).toLocaleString("id-ID")], [480, BAL[i].toLocaleString("id-ID")]]))],
        ["Ketentuan Umum"],
      ),
  },
  // ---- MT940: one SWIFT format, every bank that issues it ----
  { bank: "BCA", format: "MT940", file: "bca.mt940", build: () => mt940("CENAIDJA", "0000012345") },
  { bank: "MANDIRI", format: "MT940", file: "mandiri.sta", build: () => mt940("BMRIIDJA", "1370000123456", { daily: true }) },
  { bank: "BRI", format: "MT940", file: "bri-mt940.txt", build: () => mt940("BRINIDJA", "000001000123509", { daily: true, bicIn: "account" }) },
  { bank: "CIMB", format: "MT940", file: "cimb.940", build: () => mt940("BNIAIDJA", "800123456789") },
  { bank: "OCBC", format: "MT940", file: "ocbc.mt940", build: () => mt940("NISPIDJA", "693800123456", { bicIn: "account" }) },
  { bank: "MAYBANK", format: "MT940", file: "maybank.mt940", build: () => mt940("IBBKIDJA", "2000123456", { daily: true }) },
  { bank: "UOB", format: "MT940", file: "uob.mt940", build: () => mt940("BBIJIDJA", "3000123456") },
  { bank: "DBS", format: "MT940", file: "dbs.mt940", build: () => mt940("DBSBIDJA", "4000123456", { bicIn: "account" }) },
  { bank: "HSBC", format: "MT940", file: "hsbc.mt940", build: () => mt940("HSBCIDJA", "001123456069") },
  { bank: "CITI", format: "MT940", file: "citi.mt940", build: () => mt940("CITIIDJX", "0101234567", { daily: true }) },
  { bank: "JATIM", format: "MT940", file: "jatim.txt", build: () => mt940("PDJTIDJ1", "0011223344") },
  // ---- Reproduced from a real file (positions as printed), not the August rows ----
  {
    bank: "SMBC",
    format: "Laporan Konsolidasi Rekening (Touchbiz / Jenius)",
    file: "smbc-konsolidasi.pdf",
    build: smbcCombinedPdf,
    check: (sections) => {
      expect(sections.map((s) => [s.accountNumber, s.section?.currency])).toEqual([["90022152088", "IDR"], ["05243002879", "IDR"], ["90022164251", "JPY"]]);
      for (const s of sections) expect(checkContinuity(s).ok).toBe(true);
    },
  },
];
