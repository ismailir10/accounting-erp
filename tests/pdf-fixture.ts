import { createHash } from "node:crypto";

/**
 * Minimal PDF writer for parser tests: pages of text placed at (x, y) in Helvetica, optionally encrypted
 * with a user password (standard security handler R2 / RC4-40, which pdf.js opens like any e-statement).
 * Real e-statements aren't committed (client data); these reproduce their layouts synthetically.
 */
export type PdfText = { x: number; y: number; text: string; size?: number };

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const PAD = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");
const md5 = (...parts: Buffer[]) => createHash("md5").update(Buffer.concat(parts)).digest();
const padPw = (pw: string) => Buffer.concat([Buffer.from(pw, "latin1"), PAD]).subarray(0, 32);

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

export function makePdf(pages: PdfText[][], opts: { userPassword?: string } = {}): Buffer {
  const id = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
  const P = -4;
  let fileKey: Buffer | null = null;
  let encryptDict = "";
  if (opts.userPassword !== undefined) {
    const O = rc4(md5(padPw(opts.userPassword)).subarray(0, 5), padPw(opts.userPassword));
    const p = Buffer.alloc(4);
    p.writeInt32LE(P);
    fileKey = md5(padPw(opts.userPassword), O, p, id).subarray(0, 5);
    const U = rc4(fileKey, PAD);
    encryptDict = `<< /Filter /Standard /V 1 /R 2 /O <${O.toString("hex")}> /U <${U.toString("hex")}> /P ${P} >>`;
  }
  const objKey = (num: number) => md5(fileKey!, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0])).subarray(0, 10);

  const objects: string[] = [];
  const add = (body: string) => objects.push(body); // object number = index + 1
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // Pages, filled once kids are known
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const texts of pages) {
    let stream: Buffer = Buffer.from(texts.map((t) => `BT /F1 ${t.size ?? 8} Tf 1 0 0 1 ${t.x} ${t.y} Tm (${esc(t.text)}) Tj ET`).join("\n"), "latin1");
    const num = objects.length + 1;
    if (fileKey) stream = rc4(objKey(num), stream);
    add(`<< /Length ${stream.length} >>\nstream\n${stream.toString("latin1")}\nendstream`);
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${num} 0 R >>`);
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  if (encryptDict) add(encryptDict);

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  const enc = encryptDict ? ` /Encrypt ${objects.length} 0 R` : "";
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${enc} /ID [<${id.toString("hex")}> <${id.toString("hex")}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Lay out rows as table lines: each row is [x, text][] at a y that steps down by `lead`. */
export function table(startY: number, rows: [number, string][][], lead = 12): PdfText[] {
  return rows.flatMap((cells, i) => cells.map(([x, text]) => ({ x, y: startY - i * lead, text })));
}

/** SMBC "Laporan Konsolidasi Rekening": several accounts in one PDF, each under its own section header. */
export function smbcCombinedPdf(opts: { holder?: string; holderNextLine?: boolean; sectionHolders?: (string | undefined)[] } = {}) {
  const header: [number, string][] = [[37, "Tanggal Transaksi"], [119, "Tanggal Pembukuan"], [246, "Keterangan"], [353, "Mutasi Debet"], [437, "Mutasi Kredit"], [531, "Saldo"]];
  return makePdf([
    [
      ...table(800, [[[32, opts.holder && !opts.holderNextLine ? `Kepada Yth: ${opts.holder}` : "Kepada Yth:"], [318, "Periode Laporan"], [398, ": 01 MEI 2026 - 31 MEI 2026"]], ...(opts.holder && opts.holderNextLine ? [[[32, opts.holder]] as [number, string][]] : []), [[32, "PT Bank SMBC Indonesia Tbk"]]]),
      ...table(740, [
        [[25, "Aktivitas Rekening / Account Activities – Jenius Main Account (IDR) 90022152088"]],
        ...(opts.sectionHolders?.[0] ? [[[32, `Nama Nasabah: ${opts.sectionHolders[0]}`]] as [number, string][]] : []),
        header,
        [[45, "01-05-2026"], [132, "01-05-2026"], [199, "Saldo Awal - Beginning Balance"], [531, "5,646,633.00"]],
        [[45, "18-05-2026"], [132, "18-05-2026"], [199, "Cr BI fast Incoming"], [436, "250,000,000.00"], [523, "255,646,633.00"]],
        [[45, "20-05-2026"], [132, "20-05-2026"], [199, "Transfer Keluar - Outgoing Transfer"], [359, "35,000,000.00"], [523, "220,646,633.00"]],
        [[45, "Total"], [235, "1 DEBIT 1 KREDIT"], [354, "35,000,000.00"], [436, "250,000,000.00"]],
      ]),
      ...table(560, [
        [[24, "Aktivitas Rekening / Account Activities - Pinjaman Rekening Koran BTB (IDR) 05243002879"]],
        ...(opts.sectionHolders?.[1] ? [[[32, `Nama Nasabah: ${opts.sectionHolders[1]}`]] as [number, string][]] : []),
        header,
        [[45, "01-05-2026"], [131, "01-05-2026"], [195, "Saldo Awal - Beginning Balance"], [517, "-3,598,843,911.00"]],
        [[44, "20-05-2026"], [130, "20-05-2026"], [195, "Transfer Masuk - Incoming Transfer"], [439, "35,000,000.00"], [517, "-3,563,843,911.00"]],
        [[45, "25-05-2026"], [131, "25-05-2026"], [195, "Bunga - Interest"], [362, "17,222,773.00"], [516, "-3,581,066,684.00"]],
      ]),
    ],
    [
      ...table(800, [
        [[24, "Aktivitas Rekening / Account Activities – JENIUS JPY ACCOUNT (JPY) 90022164251"]],
        ...(opts.sectionHolders?.[2] ? [[[32, `Nama Nasabah: ${opts.sectionHolders[2]}`]] as [number, string][]] : []),
        header,
        [[45, "01-05-2026"], [132, "01-05-2026"], [199, "Saldo Awal - Beginning Balance"], [531, "12,750.00"]],
      ]),
      { x: 180, y: 400, text: "Ini adalah akhir dari Laporan Konsolidasi Rekening Anda" },
    ],
  ]);
}

/**
 * SMBC giro section with a time deposit: the deposit's interest and its tax print on the same day, the tax row's description
 * centred on its amount line (one text line ~3 pt above, one below), then the "Detail Produk Deposito" table. Positions follow
 * the real e-statement (Mei 2026).
 */
export function smbcGiroDepositPdf() {
  const t = (x: number, y: number, text: string): PdfText => ({ x, y, text });
  return makePdf([
    [
      t(32, 800, "PT Bank SMBC Indonesia Tbk"),
      t(318, 788, "Periode Laporan"),
      t(398, 788, ": 01 MEI 2026 - 31 MEI 2026"),
      t(24, 740, "Aktivitas Rekening / Account Activities – GIRO KARYA (IDR) 05243002331"),
      t(37, 702, "Tanggal Transaksi"), t(119, 702, "Tanggal Pembukuan"), t(246, 702, "Keterangan"), t(353, 702, "Mutasi Debet"), t(437, 702, "Mutasi Kredit"), t(531, 702, "Saldo"),
      t(42, 680, "01-05-2026"), t(128, 680, "01-05-2026"), t(195, 680, "Saldo Awal - Beginning Balance"), t(529, 680, "649,569.00"),
      t(42, 663, "26-05-2026"), t(128, 663, "26-05-2026"), t(195, 663, "Bunga - Interest DEP0524DEP004097"), t(445, 663, "14,794,521.00"), t(526, 663, "15,444,090.00"),
      t(195, 645, "Pajak Bunga - Tax on Interest"),
      t(42, 642, "26-05-2026"), t(128, 642, "26-05-2026"), t(362, 642, "2,958,904.00"), t(529, 642, "12,485,186.00"),
      t(195, 636, "DEP0524DEP004097"),
      t(44, 624, "Total"), t(232, 624, "1 DEBIT 1 KREDIT"), t(363, 624, "2,958,904.00"), t(448, 624, "14,794,521.00"),
      t(39, 593, "Deposito / Time Deposit"),
      t(24, 565, "Detail Produk Deposito / Time Deposit Product Details"),
      t(36, 534, "No. Rekening"), t(107, 534, "Nama Produk"), t(168, 534, "Mata Uang Suku Bunga"), t(299, 534, "Tanggal Jatuh Tempo"), t(436, 534, "Saldo"),
      t(360, 495, "AUTO ROLL"),
      t(29, 487, "0524DEP004097"), t(98, 487, "Deposito Berjangka"), t(180, 487, "IDR"), t(221, 487, "5%"), t(266, 487, "12"), t(300, 487, "26-08-2026"), t(360, 487, "OVER"), t(424, 487, "3,600,000,000.00"), t(512, 487, "3,600,000,000.00"),
      t(360, 478, "PRINCIPAL"),
      t(34, 464, "Total in IDR"), t(511, 464, "3,600,000,000.00"),
    ],
  ]);
}

/** BRImo financial report: five pages, zero-filled sides, bilingual headers and the printed summary only on page five.
 * `summarySplit` ends page five with the summary labels and prints the values atop a sixth page, under its title. */
export function brimoPdf(opts: { debit?: string; credit?: string; opening?: string; closing?: string; totalDebit?: string; totalCredit?: string; holder?: string | null; summarySplit?: boolean; userPassword?: string } = {}): Buffer {
  const rows: [string, string, string, string, string][] = [
    ["01/01/26 09:35:08", "Transfer Ke Andi via BRImo", opts.debit ?? "5,000,000.00", opts.credit ?? "0.00", "52,400,000.00"],
    ["01/01/26 12:58:17", "Transfer Dari Sari via BRImo", "0.00", "185,000.00", "52,585,000.00"],
    ["01/01/26 22:04:24", "Pembayaran Tagihan Kartu Kredit 5100xxxx001 via", "1,469,322.00", "0.00", "51,115,678.00"],
    ["08/01/26 08:00:00", "Transfer Dari Pelanggan via BRImo", "0.00", "99,815,000.00", "150,930,678.00"],
    ["20/01/26 14:00:00", "Transfer Ke Pemasok via BRImo", "113,530,678.00", "0.00", "37,400,000.00"],
    ["31/01/26 10:00:00", "Transfer Dari Pelanggan via BRImo", "0.00", "10,000,000.00", "47,400,000.00"],
  ];
  const pageCount = opts.summarySplit ? 6 : 5;
  const title = (page: number): [number, string][][] => [
    [[30, "LAPORAN TRANSAKSI FINANSIAL"]],
    [[30, "STATEMENT OF FINANCIAL TRANSACTION"]],
    [[30, `Halaman ${page + 1} dari ${pageCount}`]], [[30, `Page ${page + 1} of ${pageCount}`]],
  ];
  const labels: [number, string][][] = [
    [[30, "Saldo Awal"], [160, "Total Transaksi Debet"], [310, "Total Transaksi Kredit"], [460, "Saldo Akhir"]],
    [[30, "Opening Balance"], [160, "Total Debit Transaction"], [310, "Total Credit Transaction"], [460, "Closing Balance"]],
  ];
  const values: [number, string][][] = [
    [[30, opts.opening ?? "57,400,000.00"], [160, opts.totalDebit ?? "120,000,000.00"], [310, opts.totalCredit ?? "110,000,000.00"], [460, opts.closing ?? "47,400,000.00"]],
    [[30, "Terbilang / In Words"]], [[30, "EMPAT PULUH TUJUH JUTA EMPAT RATUS RIBU RUPIAH"]],
  ];
  const footer: [number, string][][] = [
    [[30, "ABC1234_synthetic_e-"], [350, "Created By BRIMO"]],
    [[30, "StatementBRImo_12345_Jan2026_67890"]],
    [[30, "02/02/2026 10:00:00"]], [[30, "2026010100000001"]],
  ];
  const pages = [[0, 1], [2], [3], [4], [5]].map((indices, page) => {
    const header: [number, string][][] = [
      ...title(page),
      [[30, "Tanggal Laporan"], [170, ":"], [190, "02/02/26"]],
      [[30, "Kepada Yth. / To :"], [190, "Statement Date"]],
      [[30, opts.holder === null ? "" : opts.holder ?? "BUDI CONTOH"], [300, "Periode Transaksi"], [400, ":"], [420, "01/01/26 - 31/01/26"]],
      [[300, "Transaction Period"]],
      [[30, "JL CONTOH NO 1"]],
      [[30, "No. Rekening"], [170, ": 123401000012345"], [350, "Unit Kerja"], [420, ": KCP Contoh"]],
      [[30, "Account No"], [350, "Business Unit"]],
      [[30, "Nama Produk"], [170, ": Britama-IDR"], [350, "Alamat Unit Kerja"], [450, ": Jl. Contoh No.2"]],
      [[30, "Product Name"], [350, "Business Unit Address"]],
      [[30, "Valuta"], [170, ": IDR"]], [[30, "Currency"]],
      [[20, "Tanggal Transaksi"], [130, "Uraian Transaksi"], [330, "Teller"], [380, "Debet"], [450, "Kredit"], [530, "Saldo"]],
      [[20, "Transaction Date"], [130, "Transaction Description"], [330, "User ID"], [380, "Debit"], [450, "Credit"], [530, "Balance"]],
    ];
    const texts = table(800, header);
    let y = 580;
    for (const i of indices) {
      const [date, desc, debit, credit, balance] = rows[i];
      texts.push(...table(y, [[[20, date], [130, desc], [330, `88880${i + 1}8`], [375, debit], [445, credit], [520, balance]]]).map((t) => ({ ...t, size: 6 })));
      y -= 12;
      if (i === 2) { texts.push({ x: 130, y, text: "BRImo", size: 6 }); y -= 12; }
    }
    if (page === 4) {
      const summary = opts.summarySplit ? labels : [...labels, ...values];
      texts.push(...table(y, summary));
      y -= summary.length * 12;
    }
    // Close to the last row: footer text and its date must never become description or transactions.
    texts.push(...table(y, footer));
    return texts;
  });
  if (opts.summarySplit) pages.push(table(800, [...title(5), ...values, ...footer]));
  return makePdf(pages, { userPassword: opts.userPassword });
}

/** Password-protected Mandiri e-Statement with the address/product header and its split date/amount rows. */
export function mandiriEstatementPdf(opts: { product?: string; bankAddress?: string; holder?: string | null } = {}): Buffer {
  const amounts = [-5_000_000, 1_000_000, -3_000_000, 1_000_000, -4_000_000, 1_000_000, -3_000_000, 2_000_000, 5_000_000];
  const id = (value: number) => Math.abs(value).toLocaleString("de-DE") + ",00";
  let balance = 80_000_000;
  const pages = amounts.map((amount, page) => {
    balance += amount;
    const day = String(page + 1).padStart(2, "0");
    return [
      ...table(800, [
        [[30, "e-Statement"]],
        [[30, opts.bankAddress ?? "Menara Mandiri 1 Jalan Jenderal Sudirman Kav. 54-55, Jakarta 12190, Indonesia"]],
        [[30, "Nama/Name"], [105, ":"], [125, opts.holder === null ? "" : opts.holder ?? "BUDI CONTOH"], [280, "Periode/Period"], [355, ":"], [375, "01 Jan 2026 - 31 Jan 2026"], [535, `${page + 1} dari 9`]],
        [[535, `${page + 1} of 9`]],
        [[30, "Cabang/Branch"], [105, ":"], [125, "KCP Contoh"], [280, "Dicetak pada/Issued on :"], [420, "02 Feb 2026"]],
        [[30, opts.product ?? "Tabungan Mandiri"]],
        [[30, "Saldo Awal/Initial Balance"], [185, ":"], [205, "80.000.000,50"]],
        [[30, "Nomor Rekening/Account Number :"], [220, "1110001234567"], [330, "Dana Masuk/Incoming Transactions"], [525, "+ 10.000.000,00"]],
        [[30, "Mata Uang/Currency"], [185, ":"], [205, "IDR"]],
        [[330, "Dana Keluar/Outgoing Transactions"], [525, "- 15.000.000,00"]],
        [[30, "Saldo Akhir/Closing Balance"], [185, ":"], [205, "75.000.000,50"]],
        [[30, "No"], [60, "Tanggal"], [190, "Keterangan"], [400, "Nominal (IDR)"], [500, "Saldo (IDR)"]],
        [[30, "No"], [60, "Date"], [190, "Remarks"], [400, "Amount (IDR)"], [500, "Balance (IDR)"]],
      ]),
      { x: 190, y: 620, text: amount < 0 ? "Transfer ke BANK MANDIRI" : "Transfer dari BANK BCA" },
      { x: 60, y: 616, text: `${day} Jan 2026` },
      ...table(612, [[[30, String(page + 1)], [190, "ANDI CONTOH 1010000000001"], [400, (amount < 0 ? "-" : "+") + id(amount)], [500, id(balance).replace(/,00$/, ",50")]]]),
      { x: 60, y: 600, text: "21:41:32 WIB" },
      ...(page === 8 ? [{ x: 30, y: 60, text: "Disclaimer ... Bank Mandiri ... Livin' ..." }] : []),
    ];
  });
  return makePdf(pages, { userPassword: "synthetic-password" });
}

/** Password-protected wondr mutation report: holder/product cells, shared-month period and split amount/time rows. */
export function bniWondrPdf(opts: { productCell?: string; title?: string; holder?: string | null; period?: string; transactionDescription?: string } = {}): Buffer {
  const amounts = [1_000_000, 1_000_000, -2_000_000, 1_000_000, -5_000_000, 2_000_000];
  const comma = (value: number) => Math.abs(value).toLocaleString("en-US");
  let balance = 20_000_000;
  const pages = amounts.map((amount, page) => {
    balance += amount;
    return [
      ...table(800, [
        [[30, opts.title ?? "Laporan Mutasi Rekening"]],
        [[30, opts.period ?? "Periode: 1 - 31 Januari 2026"]],
        [[30, opts.holder === null ? "" : opts.holder ?? "BUDI CONTOH"], [360, opts.productCell ?? "TAPLUS BISNIS - 8311100000"]],
        [[30, "JL CONTOH NO 1"], [360, "Kantor Cabang: CONTOH • Mata Uang: IDR"]],
        [[30, "KOTA CONTOH"]],
        [[30, "Saldo Awal"], [160, "Total Pemasukan"], [310, "Total Pengeluaran"], [460, "Saldo Akhir"]],
        [[30, "20,000,000"], [160, "+5,000,000"], [310, "-7,000,000"], [460, "18,000,000"]],
        [[30, "Tanggal & Waktu"], [170, "Rincian Transaksi"], [400, "Nominal (IDR)"], [500, "Saldo (IDR)"]],
        ...(page === 0 ? [[[170, "Saldo Awal"], [500, "20,000,000"]] as [number, string][]] : []),
      ]),
      ...table(660, [
        [[30, `${String(page + 2).padStart(2, "0")} Jan 2026`], [170, "Lainnya"]],
        [[400, (amount < 0 ? "-" : "+") + comma(amount)], [500, comma(balance)]],
        [[30, "05:31:09 WIB"], [170, opts.transactionDescription ?? (amount < 0 ? "TRANSFER KE BANK MANDIRI 1234567890" : "TRANSFER DARI BANK BCA 1234567890")]],
      ]),
      ...(page === 5 ? table(600, [[[170, "Saldo Akhir"], [500, "18,000,000"]]]) : []),
      { x: 30, y: 60, text: "Informasi Lainnya ... BNI dapat ..." },
    ];
  });
  return makePdf(pages, { userPassword: "synthetic-password" });
}

/** BCA holder field: either labelled, or left of the account metadata on the same header row. */
export function bcaHolderPdf(opts: { holder?: string | null; labelled?: boolean; candidate?: string; bank?: string } = {}): Buffer {
  const holder = opts.holder === null ? "" : opts.holder ?? "PT CONTOH FIKTIF";
  return makePdf([[
    ...table(800, [
      [[30, opts.bank ?? "BCA"]], [[30, "REKENING TAHAPAN"]],
      ...(opts.labelled ? [[[30, "Nama Nasabah"], [140, ":"], [170, holder]] as [number, string][]] : []),
      [[30, opts.labelled ? "" : opts.candidate ?? holder], [350, "NO. REKENING : 0000012345"]],
      [[30, "PERIODE : JANUARI 2026"]], [[30, "Saldo Awal : 1,000.00"]],
    ]),
    ...table(700, [
      [[30, "Tanggal"], [130, "Keterangan"], [400, "Nominal"], [500, "Saldo"]],
      [[30, "13/01/2026"], [130, "Nama Nasabah: PT TRANSAKSI CONTOH"], [400, "100.00"], [500, "1,100.00"]],
    ]),
  ]]);
}

/** A row of the Jenius e-Statement below: date, the Details lines, an optional note and a signed whole-Rupiah amount. */
export type JeniusRow = { date: string; details: string[]; amount: number; time?: string; note?: string; type?: string };

/**
 * Jenius e-Statement, 2025 layout (FICTIONAL content). Built from structure metadata of real statements only — fixed public labels,
 * token shapes and positions rounded to 25 pt; no real value. Page 1 summarises the account (total balance, account number and
 * period, the account table with starting/incoming/outgoing/ending balances, the cards table); the transactions follow under an
 * English header (Date & Time · Details · Notes · Amount) and a sub-header, between a starting and an ending balance line. A row is
 * its date, details and signed amount, then the time and a second details line, sometimes a reference and the transaction type.
 * There is no running-balance column. `inline` is the second variant: columns shifted left, no separator in the account line, and
 * the transactions starting on page 1 under the summary.
 */
export function jeniusEstatementPdf(opts: {
  rows: JeniusRow[];
  opening: number;
  /** Printed ending balance; defaults to opening + Σ rows (pass another value to print a broken chain). */
  closing?: number;
  account?: string;
  period?: string;
  /** The day the total balance is printed for, e.g. "31 August 2026". */
  asOf?: string;
  inline?: boolean;
  openingLabel?: string;
  rowsPerPage?: number;
  userPassword?: string;
}): Buffer {
  const fmt = (v: number, signed = false) => `${signed ? (v < 0 ? "-" : "+") : v < 0 ? "-" : ""}${Math.abs(v).toLocaleString("en-US")}`;
  const closing = opts.closing ?? opts.rows.reduce((t, r) => t + r.amount, opts.opening);
  const incoming = opts.rows.filter((r) => r.amount > 0).reduce((t, r) => t + r.amount, 0);
  const outgoing = opts.rows.filter((r) => r.amount < 0).reduce((t, r) => t + r.amount, 0);
  const label = opts.openingLabel ?? "Previous Balance";
  const x = opts.inline
    ? { a: 25, sep: 0, cur: 150, start: 225, startV: 250, inc: 350, out: 450, end: 525, right: 550, date: 25, details: 100, notes: 275, amount: 550 }
    : { a: 50, sep: 100, cur: 200, start: 300, startV: 325, inc: 400, out: 450, end: 500, right: 525, date: 50, details: 125, notes: 300, amount: 530 };
  const pages: PdfText[][] = [];
  let page: PdfText[] = [];
  let y = 800;
  const line = (cells: [number, string][], lead = 12) => {
    for (const [cx, text] of cells) page.push({ x: cx, y, text });
    y -= lead;
  };
  const newPage = () => {
    pages.push(page);
    page = [];
    y = 800;
  };
  // Page 1: the summary.
  line([[x.a, "Account Overview"], [475, `Total Balance (${opts.asOf ?? "31 August 2026"})`]]);
  line([[x.a, "NASABAH FIKTIF CONTOH"], [x.right, fmt(closing)]], 20);
  line([[x.a, "Account Number"], ...(x.sep ? ([[x.sep, "–"]] as [number, string][]) : []), [opts.inline ? 550 : 525, "Period"]]);
  line([[x.a, opts.account ?? "90012345678"], ...(x.sep ? ([[x.sep, "–"]] as [number, string][]) : []), [500, opts.period ?? "August 2026"]], 20);
  line([[x.a, opts.inline ? "–" : "Currency"]], 20);
  line([[x.a, "Account"], [x.cur, "Currency"], [x.start, label], [x.inc, "Incoming"], [x.out, "Outgoing"], [x.end, "Ending Balance"]]);
  line([[x.a, "Active Balance"], [x.cur, "IDR"], [x.startV, fmt(opts.opening)], [x.inc - 25, incoming ? fmt(incoming, true) : "0"], [x.out, fmt(outgoing, true)], [x.right, fmt(closing)]]);
  line([[x.a, "Total in IDR"], [x.right, fmt(closing)]], 20);
  line([[x.a, "Cards"]]);
  line([[x.a, "Name"], [x.cur, "Card Number"], [x.start, label], [x.inc, "Incoming"], [x.out, "Outgoing"], [x.end, "Ending Balance"]]);
  line([[x.a, "Status"]]);
  line([[x.a, "–"], [x.cur, "**** **** **** 4321"], [375, "Uses Active Balance"]]);
  line([[x.a, "Total in IDR"], [550, "0"]], 24);
  const footer = () => {
    line([[100, "PT Bank SMBC Indonesia Tbk berizin dan diawasi oleh Otoritas Jasa Keuangan"], [400, "Layanan 1500 365"]]);
    line([[100, "Bank peserta penjaminan Lembaga Penjamin Simpanan (deposit insurance)"]]);
  };
  if (!opts.inline) {
    footer();
    newPage();
  }
  // The transaction table.
  const head = () => {
    line([[x.date, "Date & Time"], [x.details, "Details"], [x.notes, "Notes"], [x.amount - 5, "Amount"]]);
    line([[x.details, "Transaction Name | Category"], [x.notes, "Transaction Type"]], 14);
  };
  line([[x.a, "Active Balance IDR"], [300, "All Transactions In This Statement"], [475, "Incoming :"], [x.right, incoming ? fmt(incoming, true) : "0"]]);
  line([[x.a, "Opened 01 Jan 2020"], [300, "**** **** **** 4321"], [475, "Outgoing :"], [x.right, fmt(outgoing, true)]], 20);
  head();
  line([[x.details, label], [x.right, fmt(opts.opening)]], 14);
  const perPage = opts.rowsPerPage ?? 18;
  opts.rows.forEach((r, i) => {
    if (i > 0 && i % perPage === 0) {
      newPage();
      head();
    }
    line([[x.date, r.date], [x.details, r.details[0]], ...(r.note ? ([[x.notes, r.note]] as [number, string][]) : []), [x.amount, fmt(r.amount, true)]], 10);
    line([[x.date, r.time ?? "09:15"], [x.details, r.details[1] ?? `REF - ${String(7000000 + i)}`]], 10);
    if (r.type !== "") line([[x.details, `TX${String(100 + i)}A | ${r.amount > 0 ? "Transfer" : "Pembayaran"}`], [x.notes, r.type ?? (r.amount > 0 ? "CR Transfer Incoming" : "DB Payment Outgoing")]], 14);
    else y -= 4;
  });
  line([[x.details, "Ending Balance"], [x.right, fmt(closing)]], 24);
  line([[x.a, "Seluruh transaksi Jenius tercatat dalam e-Statement ini"]]);
  line([[x.a, "This e-Statement shows the transactions in your account in the period stated in it"]]);
  line([[x.a, "e-Statement ini diterbitkan oleh bank dan sah tanpa tanda tangan"]]);
  if (opts.inline) footer();
  pages.push(page);
  return makePdf(pages, opts.userPassword !== undefined ? { userPassword: opts.userPassword } : {});
}
