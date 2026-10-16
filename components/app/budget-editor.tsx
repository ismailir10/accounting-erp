"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AccountPicker, type AccountOption } from "@/components/app/account-picker";
import { saveBudgetAction } from "@/app/actions";
import { formatMoney, parseMoney } from "@/lib/money";
import { percentToBp } from "@/lib/format";

export type EditorRow = { code: string; name: string; type: "PENDAPATAN" | "BEBAN"; cells: string[]; lastYear: string[] };

const read = (s: string, currency: string): bigint | null => {
  try {
    return parseMoney(s, currency);
  } catch {
    return null;
  }
};

/**
 * Atur anggaran: one company's financial year, income and expense accounts × twelve months. Cells take Indonesian amounts; *Setahun*
 * spreads a yearly amount evenly (the remainder on the last month); *Salin realisasi tahun lalu* fills every row from last year's
 * months, optionally grown by a percentage. Only changed cells are sent; the server parses them again.
 */
export function BudgetEditor({ clientId, entityId, year, month, months, currency, rows: initial, options, canWrite }: { clientId: string; entityId: string; year: number; month: number; months: { key: string; label: string }[]; currency: string; rows: EditorRow[]; options: (AccountOption & { type: "PENDAPATAN" | "BEBAN" })[]; canWrite: boolean }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [growth, setGrowth] = useState("0");
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const saved = useMemo(() => new Map(initial.map((r) => [r.code, r.cells])), [initial]);
  const fmt = (v: bigint) => formatMoney(v, currency, { bare: true });
  const changes = rows.flatMap((r) => r.cells.flatMap((c, i) => (c.trim() !== (saved.get(r.code)?.[i] ?? "") ? [{ accountCode: r.code, key: months[i].key, amount: c.trim() }] : [])));
  const invalid = rows.some((r) => r.cells.some((c) => c.trim() !== "" && read(c, currency) === null));
  const setCell = (code: string, i: number, value: string) => setRows((rs) => rs.map((r) => (r.code === code ? { ...r, cells: r.cells.map((c, j) => (j === i ? value : c)) } : r)));
  const total = (r: EditorRow) => r.cells.reduce((s, c) => s + (read(c, currency) ?? 0n), 0n);

  const spread = (code: string, text: string) => {
    const yearly = read(text, currency);
    if (yearly === null || yearly < 0n) return void toast.error("Tulis nominal setahun, misalnya 120.000.000.");
    const each = yearly / 12n;
    setRows((rs) => rs.map((r) => (r.code === code ? { ...r, cells: months.map((_, i) => fmt(i === 11 ? yearly - each * 11n : each)) } : r)));
  };
  const copyLastYear = () => {
    const bp = percentToBp(growth.replace(/^\+/, ""));
    if (bp === null) return void toast.error("Tulis kenaikan dalam persen, misalnya 10 atau 2,5.");
    setRows((rs) => rs.map((r) => ({ ...r, cells: r.lastYear.map((v) => (BigInt(v) === 0n ? "" : fmt((BigInt(v) * BigInt(10_000 + bp) + 5_000n) / 10_000n))) })));
    toast.success(`Diisi dari realisasi tahun lalu${bp ? ` + ${growth}%` : ""}. Periksa, lalu simpan.`);
  };
  const add = (code: string) => {
    const o = options.find((x) => x.code === code);
    if (!o || rows.some((r) => r.code === code)) return;
    setRows((rs) => [...rs, { code: o.code, name: o.name, type: o.type, cells: months.map(() => ""), lastYear: months.map(() => "0") }].sort((a, b) => a.code.localeCompare(b.code)));
    setAdding("");
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await saveBudgetAction({ clientId, entityId, year, month, cells: changes });
      if (!r.ok) return void toast.error(r.error);
      toast.success(`Anggaran disimpan: ${r.set} sel diisi${r.removed ? `, ${r.removed} dikosongkan` : ""}`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const available = options.filter((o) => !rows.some((r) => r.code === o.code));
  return (
    <div className="space-y-4" data-testid="budget-editor">
      {canWrite && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-sm">
              <span className="text-xs text-muted-foreground">Kenaikan dari tahun lalu (%)</span>
              <Input aria-label="Kenaikan dari tahun lalu" inputMode="decimal" value={growth} onChange={(e) => setGrowth(e.target.value)} className="num w-24 text-right" />
            </label>
            <Button variant="outline" onClick={copyLastYear}>
              <Copy /> Salin realisasi tahun lalu
            </Button>
            {available.length > 0 && <AccountPicker value={adding} onChange={add} options={available} ariaLabel="Tambah akun ke anggaran" placeholder="Tambah akun…" className="w-64" />}
          </div>
          <div className="flex items-center gap-3">
            {changes.length > 0 && <span className="text-sm text-muted-foreground" data-testid="budget-pending">{changes.length} sel belum disimpan</span>}
            <Button onClick={save} disabled={busy || !changes.length || invalid}>{busy ? "Menyimpan…" : "Simpan anggaran"}</Button>
          </div>
        </div>
      )}
      {invalid && <p role="alert" className="text-sm text-destructive">Ada nominal yang tidak bisa dibaca. Tulis dengan titik ribuan, misalnya 12.500.000.</p>}
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="sticky left-0 z-10 min-w-48 bg-card py-2 pl-4 text-left font-medium text-muted-foreground sm:min-w-64">Akun</th>
              {canWrite && <th className="px-2 py-2 text-right font-medium whitespace-nowrap text-muted-foreground">Setahun (bagi rata)</th>}
              {months.map((m) => (
                <th key={m.key} className="px-1 py-2 text-right font-medium whitespace-nowrap text-muted-foreground">{m.label}</th>
              ))}
              <th className="py-2 pr-4 pl-2 text-right font-medium whitespace-nowrap">Jumlah</th>
            </tr>
          </thead>
          <tbody>
            {(["PENDAPATAN", "BEBAN"] as const).map((type) => (
              <TypeRows key={type} type={type} rows={rows.filter((r) => r.type === type)} months={months} canWrite={canWrite} setCell={setCell} spread={spread} total={total} currency={currency} />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={months.length + 3} className="px-4 py-8 text-center text-muted-foreground">Belum ada akun pendapatan atau beban dengan transaksi. Tambahkan akun di atas.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TypeRows({ type, rows, months, canWrite, setCell, spread, total, currency }: { type: "PENDAPATAN" | "BEBAN"; rows: EditorRow[]; months: { key: string; label: string }[]; canWrite: boolean; setCell: (code: string, i: number, v: string) => void; spread: (code: string, text: string) => void; total: (r: EditorRow) => bigint; currency: string }) {
  const [yearly, setYearly] = useState<Record<string, string>>({});
  if (!rows.length) return null;
  return (
    <>
      <tr>
        <td className="sticky left-0 z-10 bg-card pt-3 pb-1 pl-4 text-xs font-medium text-muted-foreground">{type === "PENDAPATAN" ? "Pendapatan" : "Beban"}</td>
        <td colSpan={months.length + (canWrite ? 2 : 1)} />
      </tr>
      {rows.map((r) => (
        <tr key={r.code} className="border-t border-border/50" data-testid={`budget-row-${r.code}`}>
          <td className="sticky left-0 z-10 bg-card py-1 pr-2 pl-4 align-middle">
            <span className="num text-muted-foreground">{r.code}</span> {r.name}
          </td>
          {canWrite && (
            <td className="px-2 py-1">
              <Input
                aria-label={`Setahun ${r.code}`}
                inputMode="decimal"
                value={yearly[r.code] ?? ""}
                onChange={(e) => setYearly((y) => ({ ...y, [r.code]: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && spread(r.code, yearly[r.code] ?? "")}
                onBlur={() => yearly[r.code]?.trim() && spread(r.code, yearly[r.code])}
                placeholder="–"
                className="num h-8 w-32 text-right"
              />
            </td>
          )}
          {r.cells.map((c, i) => (
            <td key={months[i].key} className="px-1 py-1">
              {canWrite ? (
                <Input aria-label={`${r.code} ${months[i].label}`} inputMode="decimal" value={c} onChange={(e) => setCell(r.code, i, e.target.value)} placeholder="–" className="num h-8 w-32 text-right" />
              ) : (
                <span className="num block w-32 text-right">{c || "–"}</span>
              )}
            </td>
          ))}
          <td className="num py-1 pr-4 pl-2 text-right font-medium whitespace-nowrap">{formatMoney(total(r), currency, { bare: true })}</td>
        </tr>
      ))}
    </>
  );
}
