import { z } from "zod";
import type { Db } from "@/lib/db";
import { FS_LINES, type FsLine } from "@/lib/coa/template";
import { PSEUDO_LABEL, type BalanceSheet, type FsItem, type IncomeStatement, type PseudoLine } from "@/lib/reports/ledger";

/**
 * A client's report format (use-case UC-K3): its own labels, order, headings and subtotals for the Laba Rugi and the Neraca, as in its
 * latest final report. Presentation only (accounting-rules 1): every number still comes from the GL through `incomeStatement` /
 * `balanceSheet`; a format only arranges their lines. A client without one uses the standard format, today's layout.
 *
 * Lines: a *Judul* (heading), a *Pos* (one or more FS lines under one label, with a presentation sign) and a *Total* (a sum of earlier
 * lines with signs). Saving checks the format symbolically — every FS line exactly once, sums of earlier lines only, the Laba Rugi's last
 * total is net profit, the Neraca has total assets and total liabilities + equity — so it holds for every period.
 */
export type FormatLine =
  | { key: string; kind: "HEADING"; label: string }
  | { key: string; kind: "GROUP"; label: string; lines: string[]; sign?: 1 | -1 }
  | { key: string; kind: "TOTAL"; label: string; terms: { key: string; sign: 1 | -1 }[]; strong?: boolean; caps?: boolean; subtotal?: boolean };
export type ReportFormat = { unit: "RUPIAH" | "RIBUAN"; source?: string; labaRugi: FormatLine[]; neraca: FormatLine[] };
export type StatementKey = "labaRugi" | "neraca";

const sectionLines = (...sections: string[]) => (Object.keys(FS_LINES) as FsLine[]).filter((k) => sections.includes(FS_LINES[k].section));

/** Every line each statement can carry, with its sign in the statement's own result (net profit; assets; liabilities + equity). */
const IS_RESULT: Record<string, 1 | -1> = {
  PENDAPATAN_USAHA: 1, HPP: -1, BEBAN_PENJUALAN: -1, BEBAN_UMUM_ADM: -1, PENDAPATAN_LAIN: 1, BEBAN_LAIN: 1, UNMAPPED_INCOME: 1, UNMAPPED_EXPENSE: 1, BEBAN_PAJAK: -1,
};
const ASSET_LINES = [...sectionLines("ASET_LANCAR", "ASET_TIDAK_LANCAR"), "UNMAPPED_ASSET"];
const LIAB_EQUITY_LINES = [...sectionLines("LIABILITAS_JANGKA_PENDEK", "LIABILITAS_JANGKA_PANJANG"), "UTANG_ANTAR_ENTITAS", "UNMAPPED_LIABILITY", ...sectionLines("EKUITAS"), "LABA_BERJALAN", "UNMAPPED_EQUITY"];
export const STATEMENT_LINES: Record<StatementKey, string[]> = { labaRugi: Object.keys(IS_RESULT), neraca: [...ASSET_LINES, ...LIAB_EQUITY_LINES] };

/** The name Buku gives a line (an FS line's label, or a synthetic line's). */
export const lineLabel = (line: string) => (FS_LINES as Record<string, { label: string }>)[line]?.label ?? PSEUDO_LABEL[line as PseudoLine] ?? line;

const group = (line: string, label = lineLabel(line)): FormatLine => ({ key: line.toLowerCase(), kind: "GROUP", label, lines: [line] });
const groups = (lines: string[]) => lines.map((l) => group(l));
const total = (key: string, label: string, terms: string[], opts: { strong?: boolean; subtotal?: boolean; minus?: string[] } = {}): FormatLine => ({
  key,
  kind: "TOTAL",
  label,
  terms: terms.map((t) => ({ key: t, sign: opts.minus?.includes(t) ? -1 : 1 })),
  ...(opts.strong ? { strong: true } : {}),
  ...(opts.subtotal ? { subtotal: true } : {}),
});
const keys = (lines: string[]) => lines.map((l) => l.toLowerCase());

/** Today's layout, line for line: what every client sees until it sets its own format. */
export function standardFormat(): ReportFormat {
  const current = sectionLines("ASET_LANCAR");
  const nonCurrent = sectionLines("ASET_TIDAK_LANCAR");
  const shortTerm = [...sectionLines("LIABILITAS_JANGKA_PENDEK"), "UTANG_ANTAR_ENTITAS", "UNMAPPED_LIABILITY"];
  const longTerm = sectionLines("LIABILITAS_JANGKA_PANJANG");
  const equity = [...sectionLines("EKUITAS"), "UNMAPPED_EQUITY", "LABA_BERJALAN"];
  return {
    unit: "RUPIAH",
    labaRugi: [
      group("PENDAPATAN_USAHA"),
      total("total_pendapatan", "Total pendapatan usaha", ["pendapatan_usaha"]),
      group("HPP"),
      total("laba_kotor", "Laba kotor", ["total_pendapatan", "hpp"], { strong: true, minus: ["hpp"] }),
      { key: "h_operasional", kind: "HEADING", label: "Beban operasional" },
      ...groups(["BEBAN_PENJUALAN", "BEBAN_UMUM_ADM"]),
      total("laba_usaha", "Laba usaha", ["laba_kotor", "beban_penjualan", "beban_umum_adm"], { strong: true, minus: ["beban_penjualan", "beban_umum_adm"] }),
      { key: "h_lain", kind: "HEADING", label: "Pendapatan (beban) lain-lain" },
      ...groups(["PENDAPATAN_LAIN", "UNMAPPED_INCOME", "BEBAN_LAIN", "UNMAPPED_EXPENSE"]),
      total("laba_sebelum_pajak", "Laba sebelum pajak", ["laba_usaha", ...keys(["PENDAPATAN_LAIN", "UNMAPPED_INCOME", "BEBAN_LAIN", "UNMAPPED_EXPENSE"])]),
      group("BEBAN_PAJAK"),
      total("laba_bersih", "Laba bersih", ["laba_sebelum_pajak", "beban_pajak"], { strong: true, minus: ["beban_pajak"] }),
    ],
    neraca: [
      { key: "h_aset_lancar", kind: "HEADING", label: "Aset lancar" },
      ...groups([...current, "UNMAPPED_ASSET"]),
      total("jumlah_aset_lancar", "Jumlah aset lancar", keys([...current, "UNMAPPED_ASSET"]), { subtotal: true }),
      { key: "h_aset_tidak_lancar", kind: "HEADING", label: "Aset tidak lancar" },
      ...groups(nonCurrent),
      total("jumlah_aset_tidak_lancar", "Jumlah aset tidak lancar", keys(nonCurrent), { subtotal: true }),
      total("total_aset", "Jumlah aset", ["jumlah_aset_lancar", "jumlah_aset_tidak_lancar"], { strong: true }),
      { key: "h_liabilitas_pendek", kind: "HEADING", label: "Liabilitas jangka pendek" },
      ...groups(shortTerm),
      total("jumlah_liabilitas_pendek", "Jumlah liabilitas jangka pendek", keys(shortTerm), { subtotal: true }),
      { key: "h_liabilitas_panjang", kind: "HEADING", label: "Liabilitas jangka panjang" },
      ...groups(longTerm),
      total("jumlah_liabilitas_panjang", "Jumlah liabilitas jangka panjang", keys(longTerm), { subtotal: true }),
      total("total_liabilitas", "Jumlah liabilitas", ["jumlah_liabilitas_pendek", "jumlah_liabilitas_panjang"]),
      { key: "h_ekuitas", kind: "HEADING", label: "Ekuitas" },
      ...groups(equity),
      total("jumlah_ekuitas", "Jumlah ekuitas", keys(equity)),
      total("total_liabilitas_ekuitas", "Jumlah liabilitas dan ekuitas", ["total_liabilitas", "jumlah_ekuitas"], { strong: true }),
    ],
  };
}

// ─── Validation ───────────────────────────────────────────────────────────────

const lineSchema = z.discriminatedUnion("kind", [
  z.object({ key: z.string().min(1).max(60), kind: z.literal("HEADING"), label: z.string().trim().min(1).max(120) }),
  z.object({ key: z.string().min(1).max(60), kind: z.literal("GROUP"), label: z.string().trim().min(1).max(120), lines: z.array(z.string()).min(1).max(60), sign: z.union([z.literal(1), z.literal(-1)]).optional() }),
  z.object({
    key: z.string().min(1).max(60),
    kind: z.literal("TOTAL"),
    label: z.string().trim().min(1).max(120),
    terms: z.array(z.object({ key: z.string(), sign: z.union([z.literal(1), z.literal(-1)]) })).min(1).max(100),
    strong: z.boolean().optional(),
    caps: z.boolean().optional(),
    subtotal: z.boolean().optional(),
  }),
]);
const formatSchema = z.object({ unit: z.enum(["RUPIAH", "RIBUAN"]), source: z.string().max(200).optional(), labaRugi: z.array(lineSchema).max(200), neraca: z.array(lineSchema).max(200) });

export class FormatError extends Error {}

/** Each line's sum as coefficients over the statement's FS lines: what it adds up, whatever the period. */
function coefficients(lines: FormatLine[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const l of lines) {
    if (l.kind === "GROUP") out.set(l.key, new Map(l.lines.map((f) => [f, l.sign ?? 1])));
    if (l.kind === "TOTAL") {
      const c = new Map<string, number>();
      for (const t of l.terms) for (const [f, v] of out.get(t.key) ?? []) c.set(f, (c.get(f) ?? 0) + t.sign * v);
      out.set(l.key, c);
    }
  }
  return out;
}
const sameVector = (a: Map<string, number>, b: Record<string, number>) => {
  const all = new Set([...a.keys(), ...Object.keys(b)]);
  return [...all].every((k) => (a.get(k) ?? 0) === (b[k] ?? 0));
};

function checkStatement(name: string, statement: StatementKey, lines: FormatLine[]) {
  const universe = new Set(STATEMENT_LINES[statement]);
  const seenKeys = new Set<string>();
  const placed = new Map<string, string>();
  for (const l of lines) {
    if (seenKeys.has(l.key)) throw new FormatError(`${name}: kunci baris "${l.key}" dipakai dua kali.`);
    if (l.kind === "GROUP") {
      for (const f of l.lines) {
        if (!universe.has(f)) throw new FormatError(`${name}: baris "${l.label}" memuat ${lineLabel(f)}, yang bukan bagian dari laporan ini.`);
        if (placed.has(f)) throw new FormatError(`${name}: ${lineLabel(f)} ada di dua baris ("${placed.get(f)}" dan "${l.label}").`);
        placed.set(f, l.label);
      }
    }
    if (l.kind === "TOTAL") {
      for (const t of l.terms) {
        if (l.terms.filter((x) => x.key === t.key).length > 1) throw new FormatError(`${name}: total "${l.label}" menjumlahkan baris yang sama dua kali.`);
        if (!seenKeys.has(t.key)) throw new FormatError(`${name}: total "${l.label}" menjumlahkan baris yang belum ada di atasnya.`);
        if (lines.find((x) => x.key === t.key)?.kind === "HEADING") throw new FormatError(`${name}: total "${l.label}" menjumlahkan judul, bukan pos.`);
      }
    }
    seenKeys.add(l.key);
  }
  const missing = STATEMENT_LINES[statement].filter((f) => !placed.has(f));
  if (missing.length) throw new FormatError(`${name}: ${missing.map(lineLabel).join(", ")} belum ada di format. Setiap pos harus tampil, supaya tidak ada akun yang hilang dari laporan.`);
  const coef = coefficients(lines);
  const totals = lines.filter((l) => l.kind === "TOTAL");
  if (statement === "labaRugi") {
    const last = totals[totals.length - 1];
    if (!last || !sameVector(coef.get(last.key)!, IS_RESULT)) throw new FormatError(`${name}: total terakhir harus laba bersih (pendapatan dikurangi semua beban, dengan tanda yang benar).`);
  } else {
    const assets = Object.fromEntries(ASSET_LINES.map((f) => [f, 1]));
    const le = Object.fromEntries(LIAB_EQUITY_LINES.map((f) => [f, 1]));
    if (!totals.some((t) => sameVector(coef.get(t.key)!, assets))) throw new FormatError(`${name}: harus ada total yang sama dengan jumlah semua aset.`);
    if (!totals.some((t) => sameVector(coef.get(t.key)!, le))) throw new FormatError(`${name}: harus ada total yang sama dengan jumlah liabilitas dan ekuitas.`);
  }
}

/** What the editor can leave half-done (a new line without a label, a *Pos* without Buku lines, a total over nothing), named in Bahasa. */
function precheck(input: unknown) {
  if (!input || typeof input !== "object") return;
  const statements: [string, unknown][] = [["Laba Rugi", (input as Record<string, unknown>).labaRugi], ["Neraca", (input as Record<string, unknown>).neraca]];
  for (const [name, lines] of statements) {
    if (!Array.isArray(lines)) continue;
    lines.forEach((raw, i) => {
      const l = (raw ?? {}) as { kind?: unknown; label?: unknown; lines?: unknown; terms?: unknown };
      const label = typeof l.label === "string" ? l.label.trim() : "";
      if (!label) throw new FormatError(`${name}: baris ke-${i + 1} belum diberi label.`);
      if (label.length > 120) throw new FormatError(`${name}: label "${label.slice(0, 40)}…" terlalu panjang (maks. 120 huruf).`);
      if (l.kind === "GROUP" && (!Array.isArray(l.lines) || l.lines.length === 0)) throw new FormatError(`${name}: pos "${label}" belum memuat pos buku. Tambahkan pos buku atau hapus barisnya.`);
      if (l.kind === "TOTAL" && (!Array.isArray(l.terms) || l.terms.length === 0)) throw new FormatError(`${name}: total "${label}" belum menjumlahkan baris apa pun.`);
    });
  }
}

/** A format as stored or submitted, checked: the shape, then each statement; refusals name the line, in Bahasa. */
export function validateFormat(input: unknown): ReportFormat {
  precheck(input);
  const parsed = formatSchema.safeParse(input);
  if (!parsed.success) {
    const at = parsed.error.issues[0]?.path.join(".");
    throw new FormatError(`Format laporan tidak terbaca${at ? ` (bagian ${at})` : ""}. Muat ulang halaman, atau kembali ke format standar.`);
  }
  const f = parsed.data as ReportFormat;
  checkStatement("Laba Rugi", "labaRugi", f.labaRugi);
  checkStatement("Neraca", "neraca", f.neraca);
  return f;
}

/** `stale`: why the client's stored format no longer applies (shown in settings); the standard is used meanwhile. */
export async function loadReportFormat(db: Db, clientId: string): Promise<ReportFormat & { custom: boolean; stale?: string }> {
  const row = await db.reportFormat.findUnique({ where: { clientId } });
  if (!row) return { ...standardFormat(), custom: false };
  try {
    return { ...validateFormat(row.format), custom: true };
  } catch (e) {
    // A stored format the current rules no longer accept (a new FS line since it was saved) falls back to the standard, never drops a
    // line, and says so where the format is edited.
    return { ...standardFormat(), custom: false, stale: e instanceof FormatError ? e.message : "Format laporan klien tidak terbaca." };
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/** A rendered row item (one *Pos*), the shape the page table, the workbook and the PDF draw. */
export type FormatItem = Omit<FsItem, "fsLine"> & { fsLine: string; review?: boolean };
export type FormatSection = { title?: string; items: FormatItem[][]; total?: { key: string; label: string; values: bigint[]; strong?: boolean; caps?: boolean; subtotal?: boolean; terms: { key: string; sign: 1 | -1 }[] } };

const REVIEW_LINES = new Set(["SUSPENSE", "UNMAPPED_INCOME", "UNMAPPED_EXPENSE", "UNMAPPED_ASSET", "UNMAPPED_LIABILITY", "UNMAPPED_EQUITY"]);

/** Thousands: half away from zero, per line (published statements round each line). */
/**
 * A value in the format's unit, still in minor units of the currency: unchanged for whole amounts; for *ribuan*, rounded half up to whole
 * thousands of the major unit and divided by a thousand (IDR 1.234.567 → 1.235; S$ 12.345,67 = 1234567 sen → 12,00, i.e. 1200 sen).
 */
export const toUnit = (v: bigint, unit: ReportFormat["unit"], exponent = 0) => {
  if (unit === "RUPIAH") return v;
  const minor = 10n ** BigInt(exponent);
  const q = 1000n * minor;
  return (v < 0n ? -1n : 1n) * (((v < 0n ? -v : v) + q / 2n) / q) * minor;
};

export const incomeItems = (is: IncomeStatement): FsItem[] => [...is.revenue, ...is.cogs, ...is.opex, ...is.other, ...is.tax];
export const balanceItems = (bs: BalanceSheet): FsItem[] => [...bs.currentAssets, ...bs.nonCurrentAssets, ...bs.liabilities, ...bs.equity];

/**
 * Sections in the shape the page's FsTable draws: a heading opens a section, each *Pos* is an item (its FS lines merged, accounts
 * beneath), each total closes the section. One column per statement given (current period first). Totals are computed from the rendered
 * lines (in the format's unit), so a printed total always equals the sum of the lines printed above it.
 */
export function renderFormat(lines: FormatLine[], columns: FsItem[][], unit: ReportFormat["unit"] = "RUPIAH", exponent = 0): FormatSection[] {
  const sections: FormatSection[] = [];
  let current: FormatSection = { items: columns.map(() => []) };
  const values = new Map<string, bigint[]>();
  for (const l of lines) {
    if (l.kind === "HEADING") {
      if (current.title || current.items.some((c) => c.length)) sections.push(current);
      current = { title: l.label, items: columns.map(() => []) };
      continue;
    }
    if (l.kind === "GROUP") {
      const sign = BigInt(l.sign ?? 1);
      const amounts = columns.map((col, ci) => {
        const parts = col.filter((i) => l.lines.includes(i.fsLine));
        if (!parts.length) return 0n;
        const accounts = parts.flatMap((p) => p.accounts.map((a) => ({ ...a, amount: toUnit(a.amount * sign, unit, exponent) })));
        const amount = parts.reduce((s, p) => s + toUnit(p.amount * sign, unit, exponent), 0n);
        current.items[ci].push({ fsLine: l.key, label: l.label, amount, accounts, ...(l.lines.some((f) => REVIEW_LINES.has(f)) ? { review: true } : {}) });
        return amount;
      });
      values.set(l.key, amounts);
      continue;
    }
    const totals = columns.map((_, ci) => l.terms.reduce((s, t) => s + BigInt(t.sign) * (values.get(t.key)?.[ci] ?? 0n), 0n));
    values.set(l.key, totals);
    current.total = { key: l.key, label: l.label, values: totals, terms: l.terms, ...(l.strong ? { strong: true } : {}), ...(l.caps ? { caps: true } : {}), ...(l.subtotal ? { subtotal: true } : {}) };
    sections.push(current);
    current = { items: columns.map(() => []) };
  }
  if (current.title || current.items.some((c) => c.length)) sections.push(current);
  return sections;
}
