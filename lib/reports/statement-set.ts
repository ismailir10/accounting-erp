import type { Db } from "@/lib/db";
import { formatDateLong, periodBounds } from "@/lib/format";
import { financialYear, fiscalEndMonth, periodFrom } from "@/lib/fiscal";
import { reportPeriods } from "@/lib/reports/periods";
import { balanceSheet, incomeStatement, type FsItem, type Scope } from "@/lib/reports/ledger";
import { balanceItems, incomeItems, loadReportFormat, renderFormat, type FormatSection, type ReportFormat } from "@/lib/reports/format";
import { cashFlow, equityChanges, otherComprehensiveIncome, EQUITY_ROWS, EQUITY_ROW_LABEL } from "@/lib/reports/statements";
import { financialNotes, type Notes } from "@/lib/reports/notes";
import { isMixed, scopeCurrency, scopeEntities } from "@/lib/reports/fx";
import { frameworkLabel, scopeFramework, signatoryOf, statementNames, type Framework, type Signatory } from "@/lib/reports/framework";

/**
 * The financial statements as rows (accounting-rules 1): Neraca and Laba Rugi in the client's format (lib/reports/format.ts), Perubahan
 * Ekuitas, Arus Kas, CALK and the directors' statement. The Excel workbook and the PDF both draw this one set, so they never disagree
 * with each other or with the page: every figure comes from the statement functions, exact, in the scope's currency (`currency`).
 *
 * Mixed-currency scopes get Neraca and Laba Rugi only, as on the page.
 */
export type SetRow = {
  label: string;
  values: (bigint | null)[];
  bold?: boolean;
  indent?: number;
  /** An account beneath a *Pos*: the Excel file lists it, the PDF leaves it to the CALK. */
  detail?: boolean;
  /** A format line: its key, and for a total the lines it sums (a formula in Excel; summed from the printed lines in the PDF). */
  key?: string;
  terms?: { key: string; sign: 1 | -1 }[];
};
export type SetStatement = { name: string; title: string; subtitle: string; columns: string[]; widths: number[]; rows: SetRow[] };
export type StatementSet = {
  unit: ReportFormat["unit"];
  /** The amounts' currency: the scope's one functional currency, or IDR for a mixed group (translated). */
  currency: string;
  framework: Framework;
  signatory: Signatory;
  statements: SetStatement[];
  /** Absent for a mixed-currency scope. */
  notes: Notes | null;
};

/** A statement in the client's format: each *Pos* a row with its accounts beneath, each total the lines it sums. */
export function formatRows(sections: FormatSection[]): SetRow[] {
  const rows: SetRow[] = [];
  for (const sec of sections) {
    const keys = [...new Set(sec.items.flatMap((col) => col.map((i) => i.fsLine)))];
    if (sec.title && keys.length) rows.push({ label: sec.title.toUpperCase(), values: [], bold: true });
    for (const k of keys) {
      const cells = sec.items.map((col) => col.find((i) => i.fsLine === k));
      rows.push({ label: cells.find(Boolean)!.label, values: cells.map((c) => c?.amount ?? 0n), indent: 1, key: k });
      const codes = [...new Set(cells.flatMap((c) => c?.accounts.map((a) => a.code) ?? []))];
      for (const code of codes) {
        const name = cells.flatMap((c) => c?.accounts ?? []).find((a) => a.code === code)!.name;
        rows.push({ label: `${code} ${name}`, values: cells.map((c) => c?.accounts.find((a) => a.code === code)?.amount ?? 0n), indent: 2, detail: true });
      }
    }
    const t = sec.total;
    // An empty "Jumlah …" is left out only when it is zero too: a subtotal over lines above it (a heading moved below its lines) still counts.
    if (!t || (t.subtotal && !keys.length && t.values.every((v) => v === 0n))) continue;
    rows.push({ label: t.caps ? t.label.toUpperCase() : t.label, values: t.values, bold: Boolean(t.strong || t.caps), key: t.key, terms: t.terms });
  }
  return rows;
}

const itemRows = (cols: (FsItem[] | undefined)[], prefix: string): SetRow[] => {
  const rows: SetRow[] = [];
  const keys = [...new Set(cols.flatMap((c) => (c ?? []).map((i) => i.fsLine)))];
  for (const k of keys) {
    const cells = cols.map((c) => c?.find((i) => i.fsLine === k));
    rows.push({ label: cells.find(Boolean)!.label, values: cells.map((c) => c?.amount ?? 0n), indent: 1, key: `${prefix}${k}` });
    const codes = [...new Set(cells.flatMap((c) => c?.accounts.map((a) => a.code) ?? []))];
    for (const code of codes) {
      const name = cells.flatMap((c) => c?.accounts ?? []).find((a) => a.code === code)!.name;
      rows.push({ label: `${code} ${name}`, values: cells.map((c) => c?.accounts.find((a) => a.code === code)?.amount ?? 0n), indent: 2, detail: true });
    }
  }
  return rows;
};

/** Operating lines that are not cash movements of working capital: depreciation, non-cash and deferred items (cashFlow's keys). */
const NON_CASH_KEYS = new Set(["AKUM_PENYUSUTAN", "BENEFITS", "DEFERRED_TAX", "OCI", "NONCASH", "DISPOSAL_NONCASH", "LEASE_INTEREST", "FX_UNREALISED"]);

export async function statementSet(db: Db, scope: Scope, year: number, month: number): Promise<StatementSet> {
  const asOf = periodBounds(year, month).end;
  // The client's financial year (lib/fiscal.ts): 1 January – 31 December unless it closes in another month.
  const endMonth = await fiscalEndMonth(db, scope.clientId);
  const fy = financialYear(endMonth, year, month);
  // One period rule with the page and the CALK (lib/reports/periods.ts): no comparative column of dashes, books opened inside the year
  // reported from their Saldo Awal.
  const per = await reportPeriods(db, scope, year, month, endMonth);
  const from = periodFrom(per.ytdFrom, asOf, true);
  const scoped = await scopeEntities(db, scope.entityIds);
  const mixed = isMixed(scoped);
  const currency = scopeCurrency(scoped);
  // Names and the signatory follow the entities' reporting framework (reports/framework.ts); no figure does.
  const entities = await db.entity.findMany({ where: { id: { in: scope.entityIds } }, select: { kind: true, reportingFramework: true } });
  const framework = scopeFramework(entities);
  const names = statementNames(framework);
  const [bs, bsPrior, is, isPrior, format] = await Promise.all([
    balanceSheet(db, scope, asOf),
    per.balanceComparative ? balanceSheet(db, scope, per.balanceComparative.date).catch(() => null) : null,
    incomeStatement(db, scope, fy.start, asOf),
    per.priorPl ? incomeStatement(db, scope, per.priorPl.start, per.priorPl.end).catch(() => null) : null,
    loadReportFormat(db, scope.clientId),
  ]);
  const statements: SetStatement[] = [];

  // Neraca
  const cur = formatDateLong(asOf);
  const old = per.balanceComparative?.label ?? "";
  statements.push({
    name: "Neraca",
    title: names.position,
    subtitle: `Per ${cur}${bsPrior ? ` dan ${per.balanceComparative!.opening ? `saldo awal ${formatDateLong(per.balanceComparative!.date)}` : old}` : ""}`,
    columns: [cur, ...(bsPrior ? [old] : [])],
    widths: [56, 20, 20],
    rows: formatRows(renderFormat(format.neraca, [bs, ...(bsPrior ? [bsPrior] : [])].map(balanceItems))),
  });

  // Laba Rugi (with other comprehensive income unless SAK EMKM)
  const lr: SetRow[] = formatRows(renderFormat(format.labaRugi, [is, ...(isPrior ? [isPrior] : [])].map(incomeItems)));
  const pl = <T,>(a: T, pick: () => T) => [a, ...(isPrior ? [pick()] : [])];
  if (!mixed && framework !== "SAK_EMKM") {
    const [oci, ociPrior] = await Promise.all([otherComprehensiveIncome(db, scope, fy.start, asOf), per.priorPl ? otherComprehensiveIncome(db, scope, per.priorPl.start, per.priorPl.end) : null]);
    const ociRows = itemRows(pl(oci.items, () => ociPrior!.items), "oci:");
    // No OCI in the period: one line with a dash, not a heading with nothing under it.
    if (ociRows.length) lr.push({ label: "Penghasilan komprehensif lain", values: [], bold: true }, ...ociRows);
    else lr.push({ label: "Penghasilan komprehensif lain", values: pl(0n, () => 0n) });
    // Net profit (the format's last total) plus each OCI line: a formula in Excel, the printed lines' sum in the PDF.
    const net = format.labaRugi.filter((l) => l.kind === "TOTAL").at(-1)!.key;
    lr.push({
      label: "Total penghasilan komprehensif",
      values: pl(is.totals.netProfit + oci.total, () => isPrior!.totals.netProfit + ociPrior!.total),
      bold: true,
      key: "oci:total",
      terms: [{ key: net, sign: 1 }, ...ociRows.filter((r) => r.key).map((r) => ({ key: r.key!, sign: 1 as const }))],
    });
  }
  statements.push({
    name: "Laba Rugi",
    title: names.income,
    subtitle: `Untuk periode ${from} – ${cur}${isPrior ? `, dibandingkan periode yang sama ${endMonth === 12 ? year - 1 : "tahun buku sebelumnya"}` : ""}`,
    columns: [`${from} – ${cur}`, ...(isPrior ? [`${periodFrom(per.priorPl!.start, per.priorPl!.end, true)} – ${formatDateLong(per.priorPl!.end)}`] : [])],
    widths: [56, 20, 20],
    rows: lr,
  });
  const signatory = signatoryOf(entities);
  if (mixed) return { unit: format.unit, currency, framework, signatory, statements, notes: null };

  // Perubahan Ekuitas
  const eq = await equityChanges(db, scope, asOf);
  const pe: SetRow[] = [];
  for (const r of EQUITY_ROWS) {
    if (r !== "opening" && r !== "closing" && eq.totals[r] === 0n) continue;
    const label = r === "opening" ? `Saldo ${formatDateLong(eq.openedAt)}` : r === "closing" ? `Saldo ${cur}` : frameworkLabel(framework, EQUITY_ROW_LABEL[r]);
    pe.push({ label, values: [...eq.values[r], eq.totals[r]], bold: r === "opening" || r === "closing" });
  }
  statements.push({ name: "Perubahan Ekuitas", title: names.equity, subtitle: `Untuk periode ${from} – ${cur}`, columns: [...eq.columns.map((c) => c.label), "Jumlah"], widths: [40, ...eq.columns.map(() => 20), 20], rows: pe });

  // Arus Kas
  const cf = await cashFlow(db, scope, asOf);
  // A published statement names the line, not the ledger's account codes (the page keeps them, to drill into).
  const flows = (items: typeof cf.operating, indent = 1) => items.map((i): SetRow => ({ label: frameworkLabel(framework, i.label), values: [i.amount], indent }));
  // Indirect method: profit, then the non-cash items, then the changes in working capital.
  const adjustments = cf.operating.filter((i) => NON_CASH_KEYS.has(i.key));
  const workingCapital = cf.operating.filter((i) => !NON_CASH_KEYS.has(i.key));
  statements.push({
    name: "Arus Kas",
    title: names.cashFlow,
    subtitle: `Untuk periode ${from} – ${cur}`,
    columns: [],
    widths: [56, 20],
    rows: [
      { label: "ARUS KAS DARI AKTIVITAS OPERASI", values: [], bold: true },
      { label: "Laba bersih", values: [cf.netProfit], indent: 1 },
      ...(adjustments.length ? [{ label: "Penyesuaian:", values: [], indent: 1 }, ...flows(adjustments, 2)] : []),
      ...(workingCapital.length ? [{ label: "Perubahan modal kerja:", values: [], indent: 1 }, ...flows(workingCapital, 2)] : []),
      { label: "Kas bersih dari aktivitas operasi", values: [cf.totals.OPERATING], bold: true },
      { label: "ARUS KAS DARI AKTIVITAS INVESTASI", values: [], bold: true },
      ...flows(cf.investing),
      { label: "Kas bersih dari aktivitas investasi", values: [cf.totals.INVESTING], bold: true },
      { label: "ARUS KAS DARI AKTIVITAS PENDANAAN", values: [], bold: true },
      ...flows(cf.financing),
      { label: "Kas bersih dari aktivitas pendanaan", values: [cf.totals.FINANCING], bold: true },
      { label: "Kenaikan (penurunan) bersih kas dan setara kas", values: [cf.net], bold: true },
      ...(cf.fxEffect ? [{ label: "Pengaruh perubahan kurs terhadap kas dan setara kas", values: [cf.fxEffect] }] : []),
      { label: `Kas dan setara kas ${formatDateLong(cf.openedAt)}`, values: [cf.openingCash] },
      ...(cf.joinedCash && cf.joinedOn ? [{ label: `Kas entitas yang bergabung (saldo awal ${formatDateLong(cf.joinedOn)})`, values: [cf.joinedCash] }] : []),
      { label: `Kas dan setara kas ${cur}`, values: [cf.closingCash], bold: true },
    ],
  });

  const notes = await financialNotes(db, scope, year, month);
  return { unit: format.unit, currency, framework, signatory, statements, notes };
}
