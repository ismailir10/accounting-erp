import type { Db } from "@/lib/db";
import { formatDate, formatPeriod, periodBounds } from "@/lib/format";
import { fiscalEndMonth, financialYear } from "@/lib/fiscal";
import { balanceSheet, incomeStatement, trialBalance } from "@/lib/reports/ledger";
import { addStatementSheets, newWorkbook, n, type WorkbookMeta } from "@/lib/reports/workbook";
import { receiptsRatio, receiptsVsRevenue, sourceTrail } from "@/lib/reports/credit";
import { agingByContact, BUCKETS, BUCKET_LABEL, invoicesAt, subledgerVsLedger } from "@/lib/receivables/aging";
import { assetRegister } from "@/lib/assets/register";

/**
 * Paket Kredit Bank (I4a, ADR 0014): one workbook per company and month for a credit application — Ringkasan, the statement set (the
 * same sheets as *Unduh Excel*, never a second computation), Mutasi vs Omzet, Umur Piutang / Utang, Aset Tetap and Jejak Sumber.
 * Read-only. The caller checks the company is the firm's and keeps IDR books.
 */
export async function creditPackWorkbook(db: Db, input: { clientId: string; entityId: string; year: number; month: number; meta: WorkbookMeta }): Promise<Buffer> {
  const { clientId, entityId, year, month } = input;
  const scope = { clientId, entityIds: [entityId] };
  const end = periodBounds(year, month).end;
  const fy = financialYear(await fiscalEndMonth(db, clientId), year, month);
  const [pl, bs, tb, receipts, receivables, payables, assets, trail] = await Promise.all([
    incomeStatement(db, scope, fy.start, end),
    balanceSheet(db, scope, end),
    trialBalance(db, scope, end),
    receiptsVsRevenue(db, { clientId, entityId, year, month }),
    invoicesAt(db, clientId, "SALES", end, [entityId]),
    invoicesAt(db, clientId, "PURCHASE", end, [entityId]),
    assetRegister(db, clientId, year, month, [entityId]),
    sourceTrail(db, { clientId, entityId, year, month }),
  ]);
  const cash = tb.filter((r) => r.account.fsLine === "KAS_SETARA_KAS" && r.account.type === "ASET").reduce((s, r) => s + r.net, 0n);
  const book = newWorkbook(input.meta);
  const { sheet, head } = book;
  const asOf = `Per ${formatDate(end)}`;

  // 1. Ringkasan — first, so the analyst opens on it.
  const sum = sheet("Ringkasan", "Paket Kredit Bank", `${formatPeriod(year, month)} · ${input.meta.draft ? "draf" : "final (bulan sudah ditutup)"}`, [56, 22]);
  head(sum, ["Angka utama dari buku besar", "Rupiah"]);
  for (const [label, value] of [
    [`Pendapatan ${formatDate(fy.start)} – ${formatDate(end)}`, pl.totals.revenue],
    [`Laba bersih ${formatDate(fy.start)} – ${formatDate(end)}`, pl.totals.netProfit],
    [`Kas & bank ${asOf.toLowerCase()}`, cash],
    [`Total aset ${asOf.toLowerCase()}`, bs.totals.assets],
    [`Total liabilitas ${asOf.toLowerCase()}`, bs.totals.liabilities],
    [`Ekuitas ${asOf.toLowerCase()}`, bs.totals.equity],
  ] as const)
    sum.addRow([label, n(value)]);
  sum.addRow([]);
  for (const line of [
    "Isi paket: laporan keuangan (lembar berikutnya), Mutasi vs Omzet 12 bulan, Umur Piutang, Umur Utang, Aset Tetap, Jejak Sumber.",
    "Rasio keuangan dihitung sendiri oleh analis bank dari laporan keuangan; paket ini menyediakan angka dan sumbernya.",
    "Setiap angka berasal dari jurnal di Buku dan dapat ditelusuri ke baris rekening koran atau file sumbernya (lihat Jejak Sumber).",
  ])
    sum.addRow([line]).alignment = { wrapText: true };

  // 2. The statement set, unchanged.
  await addStatementSheets(db, book, scope, year, month);

  // 3. Mutasi vs Omzet.
  const mv = sheet("Mutasi vs Omzet", "Uang masuk di rekening bank dibandingkan pendapatan", `12 bulan sampai ${formatPeriod(year, month)}`, [16, 18, 18, 18, 18, 18, 18, 18, 12]);
  head(mv, ["Bulan", "Uang masuk", "Transfer antar rekening", "Pinjaman & modal", "Penjualan aset tetap", "Belum diklasifikasi", "Penerimaan usaha", "Pendapatan (Laba Rugi)", "Rasio"]);
  if (!receipts.length) mv.addRow(["Belum ada mutasi bank untuk perusahaan ini."]);
  for (const m of receipts) {
    const ratio = receiptsRatio(m);
    const r = mv.addRow([formatPeriod(m.year, m.month), n(m.moneyIn), n(-m.transfers), n(-m.financing), n(-m.disposals), n(-m.unclassified), n(m.operating), n(m.revenue), ratio === null ? "–" : Number(ratio) / 1000]);
    r.getCell(9).numFmt = "0.00";
  }
  mv.addRow([]);
  for (const line of [
    "Penerimaan usaha = uang masuk − transfer antar rekening sendiri (1199/1190) − pinjaman & modal (akun liabilitas/ekuitas) − hasil penjualan aset tetap − yang belum diklasifikasi.",
    "Penerimaan memuat PPN dan pelunasan penjualan bulan sebelumnya, jadi rasio sekitar 1,00–1,15 wajar untuk PKP. Selisih besar perlu penjelasan.",
  ])
    mv.addRow([line]);

  // 4. Umur Piutang / Umur Utang.
  for (const [name, title, items, direction] of [["Umur Piutang", "Umur piutang usaha", receivables, "SALES"], ["Umur Utang", "Umur utang usaha", payables, "PURCHASE"]] as const) {
    const ws = sheet(name, title, asOf, [40, 16, 16, 16, 16, 16, 18]);
    const rows = agingByContact(items);
    head(ws, ["Kontak", ...BUCKETS.map((b) => BUCKET_LABEL[b]), "Total"]);
    if (!rows.length) ws.addRow([`Tidak ada ${name === "Umur Piutang" ? "piutang" : "utang"} terbuka yang dicatat per faktur di Buku.`]);
    for (const r of rows) ws.addRow([r.contact.name, ...BUCKETS.map((b) => n(r.buckets[b])), n(r.total)]);
    if (rows.length) {
      // The Neraca's line nets what contacts paid ahead (and cash on the account not yet given to a document): the total ties to it.
      const [proof] = await subledgerVsLedger(db, clientId, direction, end, [entityId]);
      const advanceLabel = direction === "SALES" ? "Dikurangi uang muka / kelebihan bayar pelanggan" : "Dikurangi uang muka ke pemasok";
      if (proof?.advances) ws.addRow([advanceLabel, ...BUCKETS.map(() => null), n(-proof.advances)]);
      if (proof?.unallocated) ws.addRow(["Dikurangi mutasi yang belum dicocokkan ke faktur", ...BUCKETS.map(() => null), n(-proof.unallocated)]);
      const total = rows.reduce((s, r) => s + r.total, 0n) - (proof?.advances ?? 0n) - (proof?.unallocated ?? 0n);
      ws.addRow(["Total", ...BUCKETS.map((b) => n(rows.reduce((s, r) => s + r.buckets[b], 0n))), n(total)]).font = { bold: true };
    }
  }

  // 5. Aset Tetap.
  const at = sheet("Aset Tetap", "Daftar aset tetap", asOf, [40, 14, 18, 18, 18]);
  head(at, ["Aset", "Diperoleh", "Harga perolehan", "Akumulasi penyusutan", "Nilai buku"]);
  // Held at the pack's month end: an asset sold after it was still on that Neraca.
  const live = assets.filter((a) => !a.disposedOn || +a.disposedOn > +end);
  if (!live.length) at.addRow(["Tidak ada aset tetap di register Buku."]);
  for (const a of live) {
    const r = at.addRow([a.name, formatDate(a.acquiredOn), n(a.cost), n(a.accumulated), n(a.bookValue)]);
    r.getCell(2).numFmt = "@";
  }

  // 6. Jejak Sumber.
  const js = sheet("Jejak Sumber", "Asal setiap angka", `${asOf} · jumlah baris jurnal per sumber`, [14, 40, 18, 14, 14, 14, 18]);
  head(js, ["Kode", "Akun", "Saldo", "Rekening koran", "File buku besar", "Saldo awal", "Penyesuaian & lainnya"]);
  for (const r of trail) {
    const row = js.addRow([r.code, r.name, n(r.balance), r.bank, r.ledger, r.opening, r.other]);
    for (const c of [4, 5, 6, 7]) row.getCell(c).numFmt = "0";
  }
  js.addRow([]);
  js.addRow(["Di Buku setiap baris jurnal menyimpan sumbernya: baris rekening koran, sel file buku besar (sheet!baris), Saldo Awal, atau jurnal penyesuaian bertanda pembuatnya."]);

  return Buffer.from(await book.wb.xlsx.writeBuffer());
}
