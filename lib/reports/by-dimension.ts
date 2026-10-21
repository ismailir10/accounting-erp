import type { Db } from "@/lib/db";
import type { DimensionKind } from "@/lib/generated/prisma/enums";
import { incomeStatement, type FsItem, type IncomeStatement, type Scope } from "@/lib/reports/ledger";
import { newWorkbook, excelAmount, type WorkbookMeta } from "@/lib/reports/workbook";
import { DIMENSION_LABEL } from "@/lib/dimensions";
import { formatDateLong } from "@/lib/format";

/**
 * Laba Rugi per Departemen / per Proyek (cycle 2026-10-21-departemen-proyek): one column per department (or project) carrying income or
 * expense in the range, *Tanpa departemen* for the lines without one, and the total — which is the Laba Rugi itself (`incomeStatement`
 * unfiltered). Each column is the same `incomeStatement` filtered on the tag, so the columns of a row always add up to its total: a line
 * carries one department at most (accounting-rules 1, nothing stored).
 */
export type DimensionColumn = { key: string; id: string | null; code: string; label: string; archived: boolean };
export type DimensionPlRow =
  | { type: "heading"; label: string }
  | { type: "account"; code: string; name: string; amounts: bigint[]; total: bigint }
  | { type: "subtotal"; label: string; amounts: bigint[]; total: bigint; strong?: boolean };
export type DimensionPl = { kind: DimensionKind; columns: DimensionColumn[]; rows: DimensionPlRow[]; total: IncomeStatement };

const SECTIONS: { label: string; key: keyof Omit<IncomeStatement, "totals">; after?: { label: string; total: keyof IncomeStatement["totals"]; strong?: boolean } }[] = [
  { label: "Pendapatan", key: "revenue" },
  { label: "Beban pokok penjualan", key: "cogs", after: { label: "Laba kotor", total: "grossProfit" } },
  { label: "Beban operasional", key: "opex", after: { label: "Laba usaha", total: "operatingProfit" } },
  { label: "Pendapatan & beban lain-lain", key: "other", after: { label: "Laba sebelum pajak", total: "profitBeforeTax" } },
  { label: "Beban pajak penghasilan", key: "tax", after: { label: "Laba bersih", total: "netProfit", strong: true } },
];

/** The departments (or projects) any income or expense line of the scope carries in [from, to], by code. */
async function inUse(db: Db, scope: Scope, kind: DimensionKind, from: Date, to: Date) {
  const field = kind === "DEPARTEMEN" ? "departmentId" : "projectId";
  const used = await db.journalLine.findMany({
    where: { entityId: { in: scope.entityIds }, date: { gte: from, lte: to }, account: { type: { in: ["PENDAPATAN", "BEBAN"] } }, [field]: { not: null } },
    distinct: [field],
    select: { departmentId: true, projectId: true },
  });
  const ids = used.map((u) => u[field]!);
  return db.dimension.findMany({ where: { id: { in: ids }, clientId: scope.clientId }, orderBy: { code: "asc" } });
}

export async function incomeByDimension(db: Db, scope: Scope, from: Date, to: Date, kind: DimensionKind): Promise<DimensionPl> {
  const dims = await inUse(db, scope, kind, from, to);
  const columns: DimensionColumn[] = [
    ...dims.map((d) => ({ key: d.id, id: d.id, code: d.code, label: d.name, archived: !!d.archivedAt })),
    { key: "tanpa", id: null, code: "", label: `Tanpa ${DIMENSION_LABEL[kind].toLowerCase()}`, archived: false },
  ];
  const [total, ...parts] = await Promise.all([incomeStatement(db, scope, from, to), ...columns.map((c) => incomeStatement(db, scope, from, to, { kind, id: c.id }))]);
  const byCode = (items: FsItem[]) => new Map(items.flatMap((i) => i.accounts).map((a) => [a.code, a]));
  const rows: DimensionPlRow[] = [];
  for (const s of SECTIONS) {
    const maps = parts.map((p) => byCode(p[s.key]));
    const totals = byCode(total[s.key]);
    // An account can net to zero in total and not in a column (moved from Outlet A to Outlet B): the rows are the union of every column's.
    const codes = [...new Set([...totals.keys(), ...maps.flatMap((m) => [...m.keys()])])].sort();
    if (codes.length) {
      rows.push({ type: "heading", label: s.label });
      for (const code of codes) {
        const a = totals.get(code) ?? maps.find((m) => m.has(code))!.get(code)!;
        rows.push({ type: "account", code, name: a.name, amounts: maps.map((m) => m.get(code)?.amount ?? 0n), total: totals.get(code)?.amount ?? 0n });
      }
    }
    if (s.after) rows.push({ type: "subtotal", label: s.after.label, amounts: parts.map((p) => p.totals[s.after!.total]), total: total.totals[s.after.total], strong: s.after.strong });
  }
  return { kind, columns, rows, total };
}

/** The report as Excel: one row per account and subtotal, a column per department (or project), *Tanpa …* and Total; numbers, not text. */
export async function dimensionWorkbook(pl: DimensionPl, meta: WorkbookMeta, from: Date, to: Date) {
  const { wb, sheet, head } = newWorkbook(meta);
  const name = `Laba Rugi per ${DIMENSION_LABEL[pl.kind]}`;
  const ws = sheet(name.slice(0, 31), name, `Untuk periode ${formatDateLong(from)} – ${formatDateLong(to)}`, [44, ...pl.columns.map(() => 18), 18], "RUPIAH", meta.currency);
  head(ws, ["Akun", ...pl.columns.map((c) => (c.code ? `${c.code} ${c.label}` : c.label)), "Total"]);
  const cur = meta.currency ?? "IDR";
  for (const r of pl.rows) {
    if (r.type === "heading") {
      ws.addRow([r.label]).font = { bold: true };
      continue;
    }
    const row = ws.addRow([r.type === "account" ? `  ${r.code} ${r.name}` : r.label, ...r.amounts.map((v) => excelAmount(v, cur)), excelAmount(r.total, cur)]);
    if (r.type === "subtotal") row.font = { bold: true };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
