import ExcelJS from "exceljs";
import type { Db } from "@/lib/db";
import type { TaxPack } from "@/lib/tax/pack";
import { categoryByKey } from "@/lib/tax/categories";
import { COA_TEMPLATE } from "@/lib/coa/template";
import { formatDate, formatDateTime, formatPeriod } from "@/lib/format";

/**
 * The tax pack as an Excel kertas kerja (accounting-rules 5d): built from the same pack the page shows — never a second computation —
 * for the partner's review or the client's file. Amounts are whole Rupiah as Excel numbers (text beyond 2^53, which no IDR amount reaches).
 */
const NUM = '#,##0;(#,##0);"–"';
const KIND = { PERMANENT: "Beda tetap", TEMPORARY: "Beda waktu" } as const;
const CREDIT = { PPH_25: "PPh 25", PPH_22: "PPh 22", PPH_23: "PPh 23", PPH_24: "PPh 24", OTHER: "Lainnya" } as const;

const n = (v: bigint) => (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString());

export async function taxWorkpaper(db: Db, pack: TaxPack, meta: { firm: string; client: string; npwp: string | null }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.firm;
  const header = (ws: ExcelJS.Worksheet, title: string) => {
    ws.addRow([title]).font = { bold: true, size: 13 };
    ws.addRow([`${meta.client} · ${pack.entity.name}${meta.npwp ? ` · NPWP ${meta.npwp}` : ""}`]);
    ws.addRow([`Tahun pajak ${pack.year}, s.d. ${formatPeriod(pack.year, pack.month)} · ${pack.regime === "FINAL_UMKM" ? "PP 55/2022 final 0,5%" : "Pasal 17 & 31E"} · estimasi, bukan SPT`]);
    ws.addRow([`${meta.firm} · dibuat ${formatDateTime(new Date())}`]).font = { italic: true, color: { argb: "FF4B5768" } };
    ws.addRow([]);
  };
  const table = (ws: ExcelJS.Worksheet, head: string[], rows: (string | number | null)[][], money: number[], widths: number[]) => {
    const h = ws.addRow(head);
    h.font = { bold: true };
    h.eachCell((c) => (c.border = { bottom: { style: "thin" } }));
    for (const r of rows) ws.addRow(r);
    widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
    for (const i of money) ws.getColumn(i).numFmt = NUM;
  };

  // 1. Rekonsiliasi Fiskal — the statement, line by line.
  const rec = wb.addWorksheet("Rekonsiliasi Fiskal");
  header(rec, `Rekonsiliasi fiskal PPh badan ${pack.year}`);
  const lines: (string | number | null)[][] = [];
  const add = (label: string, v: bigint | null, source = "") => lines.push([label, v === null ? null : n(v), source]);
  if (pack.regime === "FINAL_UMKM") {
    add("Peredaran bruto (pendapatan usaha)", pack.turnover, "Laba Rugi");
    add("PPh final 0,5% (PP 55/2022)", pack.tax.due);
    if (pack.finalWithheld > 0n) {
      add("  Dipotong pelanggan (PPh 4(2), sudah di 8200)", -pack.finalWithheld, "Rekening koran");
      add("PPh final disetor sendiri", pack.tax.due > pack.finalWithheld ? pack.tax.due - pack.finalWithheld : 0n);
    }
  } else {
    add("Laba sebelum pajak (komersial)", pack.profitBeforeTax, "Laba Rugi");
    for (const c of pack.corrections.filter((x) => x.direction === "POSITIVE")) add(`  (+) ${c.label}`, c.amount, source(c));
    for (const c of pack.corrections.filter((x) => x.direction === "NEGATIVE")) add(`  (−) ${c.label}`, -c.amount, source(c));
    add("Laba (rugi) fiskal", pack.fiscalProfit);
    if (pack.compensation > 0n) add("Kompensasi kerugian", -pack.compensation, "Kompensasi Kerugian");
    add("Penghasilan kena pajak (dibulatkan ke bawah ribuan)", pack.tax.pkp);
    add("Peredaran bruto (pendapatan usaha)", pack.turnover, "Laba Rugi");
    if (pack.months < 12) add(`Peredaran bruto disetahunkan (× 12 ÷ ${pack.months} bulan), dasar Pasal 31E`, pack.tax.annualTurnover);
    if (pack.tax.facilityPkp > 0n) add(`PKP fasilitas Pasal 31E ${pack.tax.facilityPkp.toLocaleString("id-ID")} × 11%`, pack.tax.facilityTax);
    if (pack.tax.regularPkp > 0n) add(`PKP lainnya ${pack.tax.regularPkp.toLocaleString("id-ID")} × 22%`, pack.tax.regularTax);
    add("PPh badan terutang", pack.tax.due);
    for (const c of pack.credits) add(`  Kredit ${CREDIT[c.type]} ${formatDate(c.date)}`, -c.amount, "Kredit Pajak");
    if (pack.settlement) {
      add(pack.settlement.balance >= 0n ? "PPh Pasal 29 kurang bayar" : "PPh Pasal 28A lebih bayar", pack.settlement.balance < 0n ? -pack.settlement.balance : pack.settlement.balance);
      add(pack.months < 12 ? "Angsuran PPh 25 tahun berikutnya per bulan (proyeksi setahun)" : "Angsuran PPh 25 tahun berikutnya per bulan", pack.settlement.nextInstalment);
    }
  }
  table(rec, ["Uraian", "Jumlah (Rp)", "Sumber"], lines, [2], [62, 20, 26]);

  // 2. Koreksi Fiskal — each correction with where it comes from.
  const kor = wb.addWorksheet("Koreksi Fiskal");
  header(kor, "Koreksi fiskal");
  const corrections = pack.regime === "FINAL_UMKM" ? [] : pack.corrections;
  const manual = await db.fiscalCorrection.findMany({ where: { id: { in: corrections.flatMap((c) => (c.source.type === "MANUAL" ? [c.source.id] : [])) } }, select: { id: true, category: true, percent: true, suggestion: true } });
  table(
    kor,
    ["Keterangan", "Kategori", "Jenis", "Arah", "%", "Akun", "Sumber", "Jumlah (Rp)"],
    corrections.map((c) => {
      const m = c.source.type === "MANUAL" ? manual.find((x) => x.id === (c.source as { id: string }).id) : undefined;
      const code = c.source.type === "ACCOUNT" ? c.source.code : c.source.type === "MANUAL" ? c.source.code : null;
      return [c.label, categoryByKey(m?.category)?.label ?? (c.source.type === "ASSETS" ? "Penyusutan" : c.source.type === "LEASES" ? "Sewa (PSAK 116)" : c.source.type === "ACCOUNT" ? "Penghasilan PPh final" : "Manual"), KIND[c.kind], c.direction === "POSITIVE" ? "Positif" : "Negatif", m?.suggestion ? m.percent : null, code, source(c), n(c.amount)];
    }),
    [8],
    [50, 34, 12, 10, 6, 10, 22, 18],
  );

  // 3. Laba Rugi — the accounts behind profit before tax.
  const pl = wb.addWorksheet("Laba Rugi");
  header(pl, `Laba rugi ${pack.year} s.d. ${formatPeriod(pack.year, pack.month)}`);
  table(pl, ["Kode", "Akun", "Pos", "Jumlah (Rp)"], [...pack.profitAndLoss.map((r) => [r.code, r.name, r.section, n(r.amount)]), [null, "Laba sebelum pajak", null, n(pack.profitBeforeTax)]], [4], [10, 40, 30, 18]);

  // 4. Kompensasi Kerugian.
  const loss = wb.addWorksheet("Kompensasi Kerugian");
  header(loss, "Kompensasi kerugian (UU PPh Pasal 6 ayat 2)");
  table(loss, ["Tahun asal", "Sisa awal tahun", "Dikompensasikan", "Sisa akhir", "Berlaku s.d.", "Status"], pack.losses.map((l) => [l.originYear, n(l.opening), n(l.used), n(l.remaining), l.expiresAfter, l.expired ? "Kedaluwarsa" : "Berlaku"]), [2, 3, 4], [12, 18, 18, 18, 12, 14]);

  // 5. Kredit Pajak.
  const cr = wb.addWorksheet("Kredit Pajak");
  header(cr, "Kredit pajak");
  // Each PPh 25 credit found in the statement names its source row (file and row), so a duplicate or generic description stays traceable.
  const bankIds = pack.credits.flatMap((c) => (c.source.type === "BANK" ? [c.source.bankTransactionId] : []));
  const bankRows = new Map((await db.bankTransaction.findMany({ where: { id: { in: bankIds } }, select: { id: true, rowNumber: true, sourceSheet: true, import: { select: { fileName: true } } } })).map((t) => [t.id, `${t.import.fileName}${t.sourceSheet ? ` · ${t.sourceSheet}` : ""} baris ${t.rowNumber}`]));
  table(
    cr,
    ["Jenis", "Tanggal", "Keterangan / bukti potong", "Akun", "Sumber", "Jumlah (Rp)", "Masa pajak"],
    // Masa pajak: the month a PPh 25 instalment is for (December paid in January still belongs to December); a line without one counts by its date.
    pack.credits.map((c) => [CREDIT[c.type], formatDate(c.date), c.label, c.accountCode, c.source.type === "BANK" ? (bankRows.get(c.source.bankTransactionId) ?? "Rekening koran") : "Bukti potong (diisi akuntan)", n(c.amount), c.masa ? formatPeriod(c.masa.getUTCFullYear(), c.masa.getUTCMonth() + 1) : c.type === "PPH_25" ? "Menurut tanggal bayar" : null]),
    [6],
    [10, 14, 50, 10, 40, 18, 22],
  );

  // 6. Pajak Tangguhan.
  const dt = wb.addWorksheet("Pajak Tangguhan");
  header(dt, "Pajak tangguhan: aset tetap, cadangan kerugian piutang, sewa dan imbalan kerja");
  const d = pack.deferred;
  table(
    dt,
    ["Uraian", "Jumlah (Rp)", "Sumber"],
    d
      ? [
          ["Aset tetap (nilai fiskal − nilai buku)", n(d.assets), "Aset Tetap"],
          ["Cadangan kerugian penurunan nilai piutang", n(d.allowance), "Buku besar 1135"],
          ["Sewa PSAK 116 (sewa fiskal dibayar di muka − (hak guna − liabilitas sewa))", n(d.leases), "Daftar Sewa"],
          ["Liabilitas imbalan kerja (PSAK 219)", n(d.employeeBenefits), "Buku besar 2310"],
          ["Beda temporer", n(d.temporaryDifference), null],
          [d.amount >= 0n ? "Aset pajak tangguhan (22%)" : "Liabilitas pajak tangguhan (22%)", n(d.amount < 0n ? -d.amount : d.amount), null],
          ["  bagian atas pengukuran kembali imbalan kerja (ke 3920, bukan 8110)", n(d.oci), "Buku besar 3920"],
        ]
      : [["Tidak ada beda temporer", null, null]],
    [2],
    [50, 18, 20],
  );

  // 7. Jurnal — postings made and the difference still proposed.
  const j = wb.addWorksheet("Jurnal");
  header(j, "Jurnal pajak");
  // As of the selected month: a posting dated later belongs to that later position (the pack proposes nothing for its kind here).
  const postings = await db.taxPosting.findMany({ where: { taxYear: { entityId: pack.entity.id, year: pack.year }, entry: { date: { lte: pack.through } } }, include: { entry: { include: { lines: { include: { account: true } } } } }, orderBy: { createdAt: "asc" } });
  const names = new Map((await db.account.findMany({ where: { clientId: (await db.entity.findUniqueOrThrow({ where: { id: pack.entity.id } })).clientId } })).map((a) => [a.code, a.name]));
  const nameOf = (code: string) => names.get(code) ?? COA_TEMPLATE.find((a) => a.code === code)?.name ?? code;
  const rows: (string | number | null)[][] = [];
  for (const p of postings) for (const l of p.entry.lines) rows.push(["Dicatat", formatDate(p.entry.date), p.entry.memo, `${l.account.code} ${l.account.name}`, l.debit ? n(l.debit) : null, l.credit ? n(l.credit) : null]);
  for (const kind of ["CURRENT", "DEFERRED"] as const) {
    const later = pack.laterPosting[kind];
    if (later) rows.push(["Dicatat sesudah periode ini", formatDate(later), `${kind === "CURRENT" ? "Pajak kini" : "Pajak tangguhan"}: posisinya dibukukan per tanggal itu`, null, null, null]);
  }
  for (const kind of ["CURRENT", "DEFERRED"] as const) for (const l of pack.proposals[kind]) rows.push(["Usulan (belum dicatat)", formatDate(pack.through), kind === "CURRENT" ? "Pajak kini" : "Pajak tangguhan", `${l.code} ${nameOf(l.code)}`, l.amount > 0n ? n(l.amount) : null, l.amount < 0n ? n(-l.amount) : null]);
  table(j, ["Status", "Tanggal", "Keterangan", "Akun", "Debit", "Kredit"], rows, [5, 6], [22, 12, 44, 36, 16, 16]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function source(c: TaxPack["corrections"][number]) {
  return c.source.type === "ASSETS" ? "Aset Tetap" : c.source.type === "LEASES" ? "Daftar Sewa" : c.source.type === "ACCOUNT" ? `Buku besar ${c.source.code}` : c.source.code ? `Buku besar ${c.source.code}` : "Diisi akuntan";
}
