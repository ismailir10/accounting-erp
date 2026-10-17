import PDFDocument from "pdfkit";
import { formatDate, formatDateLong } from "@/lib/format";
import { currencyName } from "@/lib/fx/currency";
import { A4, amountIn, INK, M, MUTED, REVIEW, RULE, winAnsi } from "@/lib/reports/pdf";
import { BUCKETS, BUCKET_LABEL, type OpenItem } from "@/lib/receivables/aging";

/**
 * Surat tagihan (statement of account, cycle 2026-10-17-pengingat-piutang): one company's open sales invoices to one customer at the
 * reminder date — the company's name and NPWP, the customer, every open invoice (overdue ones with their days late; total, paid,
 * remaining), the total, the advance not allocated yet, and a one-row aging summary. It is the client's document to its customer: no firm
 * name, no DRAF mark, and downloading it is not a *Laporan diunduh* event.
 */
export type StatementInput = {
  company: { name: string; npwp: string | null };
  customer: string;
  asOf: Date;
  currency: string;
  open: OpenItem[];
  advance: bigint;
};

const COLUMNS = [
  { label: "No. faktur", share: 0.19, right: false },
  { label: "Tanggal", share: 0.13, right: false },
  { label: "Jatuh tempo", share: 0.13, right: false },
  { label: "Terlambat", share: 0.1, right: true },
  { label: "Jumlah", share: 0.15, right: true },
  { label: "Dibayar", share: 0.15, right: true },
  { label: "Sisa", share: 0.15, right: true },
] as const;

export function customerStatementPdf(input: StatementInput): Promise<Buffer> {
  const company = winAnsi(input.company.name);
  const customer = winAnsi(input.customer);
  const asOf = formatDateLong(input.asOf);
  const doc = new PDFDocument({ size: "A4", margins: M, bufferPages: true, info: { Title: `Surat tagihan ${customer} ${asOf}`, Author: company, Creator: "Buku" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  const width = A4.width - M.left - M.right;
  const bottom = A4.height - M.bottom;
  const amount = amountIn(input.currency);
  const rule = () => {
    doc.moveTo(M.left, doc.y).lineTo(A4.width - M.right, doc.y).strokeColor(RULE).lineWidth(0.5).stroke();
    doc.y += 3;
  };

  doc.font("Helvetica-Bold").fontSize(12).fillColor(INK).text(company, M.left, M.top, { width });
  if (input.company.npwp) doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(winAnsi(`NPWP ${input.company.npwp}`), { width });
  doc.moveDown(1.4);
  doc.font("Helvetica-Bold").fontSize(16).fillColor(INK).text("Surat Tagihan", { width });
  doc.moveDown(0.4);
  doc.font("Helvetica").fontSize(10).text(`Kepada Yth. ${customer}`, { width });
  doc.fontSize(9).fillColor(MUTED).text(`Per ${asOf} · dinyatakan dalam ${currencyName(input.currency)}`, { width });
  doc.moveDown(1.2);

  // The invoice table; a table that runs onto a new page repeats its header there.
  const x = (i: number) => M.left + COLUMNS.slice(0, i).reduce((t, c) => t + c.share * width, 0);
  // A summary line's label spans the four text columns.
  const cellWidth = (i: number, wide?: boolean) => (wide && i === 0 ? x(4) : x(i + 1)) - x(i) - 4;
  const line = (cells: string[], opts: { bold?: boolean; head?: boolean; late?: boolean; wide?: boolean } = {}) => {
    doc.font(opts.bold || opts.head ? "Helvetica-Bold" : "Helvetica").fontSize(8.5);
    const h = Math.max(...cells.map((c, i) => doc.heightOfString(c || " ", { width: cellWidth(i, opts.wide) }))) + 4;
    if (!opts.head && doc.y + h > bottom) {
      doc.addPage();
      header();
      doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5);
    }
    const y = doc.y;
    cells.forEach((c, i) => {
      if (opts.wide && i > 0 && i < 4) return;
      doc.fillColor(i === 3 && opts.late ? REVIEW : INK).text(c, x(i), y, { width: cellWidth(i, opts.wide), align: COLUMNS[i].right ? "right" : "left" });
    });
    doc.y = y + h;
  };
  const header = () => {
    line(COLUMNS.map((c) => c.label), { head: true });
    rule();
  };
  header();
  const sum = (f: (i: OpenItem) => bigint) => input.open.reduce((t, i) => t + f(i), 0n);
  for (const i of input.open) {
    line([winAnsi(i.number), formatDate(i.issueDate), formatDate(i.dueDate), i.daysPastDue > 0 ? `${i.daysPastDue} hari` : "", amount(i.total), amount(i.settled), amount(i.open)], { late: i.daysPastDue > 0 });
  }
  if (!input.open.length) {
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`Tidak ada faktur terbuka per ${asOf}.`, M.left, doc.y, { width });
    doc.moveDown(0.3);
  }
  rule();
  const open = sum((i) => i.open);
  line(["Jumlah", "", "", "", amount(sum((i) => i.total)), amount(sum((i) => i.settled)), amount(open)], { bold: true, wide: true });
  if (input.advance > 0n) {
    line(["Uang muka belum dialokasikan", "", "", "", "", "", amount(-input.advance)], { wide: true });
    line(["Sisa setelah uang muka", "", "", "", "", "", amount(open - input.advance)], { bold: true, wide: true });
  }

  // Umur tagihan: the open amounts in the aging's five buckets, one row.
  doc.moveDown(1.2);
  if (doc.y + 60 > bottom) doc.addPage();
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK).text("Ringkasan umur tagihan", M.left, doc.y, { width });
  doc.moveDown(0.4);
  const cell = width / BUCKETS.length;
  const row = (cells: string[], bold: boolean) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).fillColor(INK);
    const y = doc.y;
    cells.forEach((c, i) => doc.text(c, M.left + i * cell, y, { width: cell - 4, align: "right" }));
    doc.y = y + Math.max(...cells.map((c) => doc.heightOfString(c, { width: cell - 4 }))) + 4;
  };
  row(BUCKETS.map((b) => winAnsi(BUCKET_LABEL[b])), true);
  rule();
  row(BUCKETS.map((b) => amount(sum((i) => (i.bucket === b ? i.open : 0n)))), false);

  doc.moveDown(1.5);
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`Bila pembayaran sudah dilakukan setelah ${asOf}, mohon abaikan surat ini.`, M.left, doc.y, { width });

  // The company and page numbers on every page (the bottom margin is lifted so the footer doesn't open a page of its own).
  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED);
    doc.text(`${company} · Surat tagihan ${customer}`, M.left, A4.height - 36, { width: width * 0.7, lineBreak: false });
    doc.text(`Halaman ${p - range.start + 1} dari ${range.count}`, M.left + width * 0.7, A4.height - 36, { width: width * 0.3, align: "right", lineBreak: false });
    doc.page.margins.bottom = keep;
  }
  doc.end();
  return done;
}
