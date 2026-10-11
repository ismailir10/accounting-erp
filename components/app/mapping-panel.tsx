"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AccountPicker } from "@/components/app/account-picker";
import { MethodBadge } from "@/components/app/status";
import { acceptMappingsAction, suggestMappingsAction } from "@/app/actions";
import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { displaySourceCode } from "@/lib/ledger-import/code";
import { againstNature, type NormalSide } from "@/lib/ledger-import/nature";
import { formatMoney } from "@/lib/money";

export type MappingRow = {
  id: string;
  entity: string;
  code: string;
  name: string;
  previousNames: string[];
  suggestedCode: string | null;
  suggestedBy: string | null;
  confidence: number | null;
  reason: string | null;
  mappedCode: string | null;
  mappedBy: string | null;
  typeHint: string | null;
  /** The file's balance for this account, debit-positive minor units as a string: checked against the chosen account's normal side. */
  balance: string | null;
  /** The entity's functional currency: the balance is in its minor units. */
  currency: string;
};
type Option = { code: string; name: string; group: string; normal: NormalSide };
const NEW = "__new__";
const NEW_ITEM = [{ value: NEW, label: "+ Buat akun baru" }];
const RULES = ["PRIOR", "NAME", "KEYWORD", "NEW"];
/** A rule that only knows the side of the books proposes a new account: `new:<FS_LINE>` (lib/ledger-import/mapping.ts). */
const NEW_PREFIX = "new:";
const suggestedNewLine = (code: string | null) => (code?.startsWith(NEW_PREFIX) ? code.slice(NEW_PREFIX.length) : null);
/** One-line catch-alls: right side, no detail. */
const CATCH_ALLS: Record<string, string> = { "1140": "Piutang lain-lain", "2120": "Utang lain-lain", "4110": "Pendapatan jasa", "4910": "Pendapatan lain-lain", "6190": "Beban umum lain-lain" };
const TYPE_LABEL: Record<string, string> = { ASET: "Aset", LIABILITAS: "Liabilitas", EKUITAS: "Ekuitas", PENDAPATAN: "Pendapatan", BEBAN: "Beban" };
const PAGE = 100;
/** "Buat akun baru" starts on the FS line that fits the account's type. */
const DEFAULT_FS: Record<string, string> = { ASET: "PIUTANG_LAIN", LIABILITAS: "UTANG_LAIN", EKUITAS: "MODAL", PENDAPATAN: "PENDAPATAN_LAIN", BEBAN: "BEBAN_UMUM_ADM" };

/**
 * Pemetaan akun (rule 9a): suggestions (rules, then AI on request) are pre-filled but only saved by an explicit click —
 * per row, or in bulk per method. Low-confidence AI suggestions are called out.
 */
export function MappingPanel({
  clientId,
  rows,
  options,
  fsLines,
  aiActive,
  locked,
}: {
  clientId: string;
  rows: MappingRow[];
  options: Option[];
  fsLines: { key: string; label: string }[];
  aiActive: boolean;
  locked: boolean;
}) {
  const router = useRouter();
  const [showAll, setShowAll] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [newAcc, setNewAcc] = useState<Record<string, { fsLine: string; name: string }>>({});

  const unmapped = rows.filter((r) => !r.mappedCode);
  const ruleReady = unmapped.filter((r) => r.suggestedCode && RULES.includes(r.suggestedBy ?? ""));
  const newReady = ruleReady.filter((r) => suggestedNewLine(r.suggestedCode));
  const aiReady = unmapped.filter((r) => r.suggestedCode && r.suggestedBy === "AI");
  const noSuggestion = unmapped.filter((r) => !r.suggestedCode);
  // The type each Buku account belongs to, from the option group label ("Beban · Beban umum & administrasi").
  const typeOfCode = new Map(options.map((o) => [o.code, o.group.split(" · ")[0]]));
  const normalOfCode = new Map(options.map((o) => [o.code, o.normal]));
  const visible = (showAll ? rows : unmapped).slice(0, limit);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }
  const accept = (items: Parameters<typeof acceptMappingsAction>[1], label: string) =>
    run(label, async () => {
      const r = await acceptMappingsAction(clientId, items);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${r.mapped} akun dipetakan`);
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          disabled={locked || !ruleReady.length || busy !== null}
          onClick={() => accept(ruleReady.map((r) => ({ sourceAccountId: r.id, accountCode: r.suggestedCode!, method: r.suggestedBy! })), "rules")}
        >
          {busy === "rules" ? <Loader2 className="animate-spin" /> : <Check />} Terima {ruleReady.length} saran aturan{newReady.length ? ` (membuat ${newReady.length} akun baru)` : ""}
        </Button>
        <Button
          variant="outline"
          disabled={locked || !aiActive || !noSuggestion.length || busy !== null}
          onClick={() =>
            run("ai", async () => {
              const r = await suggestMappingsAction(clientId, true);
              if (!r.ok) return void toast.error(r.error);
              if (r.note) (r.note.startsWith("AI gagal") ? toast.error : toast.message)(r.note);
              else toast.success(`${r.aiAnswered} saran AI dari ${r.calls} panggilan`);
              router.refresh();
            })
          }
        >
          {busy === "ai" ? <Loader2 className="animate-spin" /> : null} Minta saran AI untuk {noSuggestion.length} akun
        </Button>
        <Button
          variant="outline"
          disabled={locked || !aiReady.length || busy !== null}
          onClick={() => accept(aiReady.map((r) => ({ sourceAccountId: r.id, accountCode: r.suggestedCode!, method: "AI" })), "acceptAi")}
        >
          {busy === "acceptAi" ? <Loader2 className="animate-spin" /> : <Check />} Terima {aiReady.length} saran AI
        </Button>
        {!aiActive && <span className="text-xs text-muted-foreground">AI tidak aktif: petakan manual, atau isi kunci di Pengaturan.</span>}
      </div>

      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">
          {unmapped.length ? `${unmapped.length} dari ${rows.length} akun belum dipetakan` : `Semua ${rows.length} akun sudah dipetakan`}
          {unmapped.length > 0 && (
            <span className="ml-2 text-xs" data-testid="mapping-counts">
              · aturan {ruleReady.length - newReady.length} · akun baru {newReady.length} · AI {aiReady.length} · tanpa saran {noSuggestion.length}
            </span>
          )}
        </span>
        <Button variant="ghost" size="sm" onClick={() => { setShowAll((v) => !v); setLimit(PAGE); }}>
          {showAll ? "Tampilkan yang belum saja" : `Tampilkan semua (${rows.length})`}
        </Button>
      </div>

      {visible.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="p-2 pl-3 text-left font-medium">Akun di file</TableHead>
                <TableHead className="p-2 text-left font-medium">Akun Buku</TableHead>
                <TableHead className="hidden p-2 text-left font-medium lg:table-cell">Dasar</TableHead>
                <TableHead className="w-28 p-2 pr-3" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((r) => {
                const newLine = suggestedNewLine(r.suggestedCode);
                const value = choice[r.id] ?? r.mappedCode ?? (newLine ? NEW : r.suggestedCode) ?? "";
                const changed = value !== (r.mappedCode ?? "");
                const low = r.suggestedBy === "AI" && (r.confidence ?? 0) < 0.7 && !r.mappedCode;
                const creating = value === NEW;
                const na = newAcc[r.id] ?? { fsLine: newLine ?? DEFAULT_FS[r.typeHint ?? ""] ?? fsLines[0]?.key ?? "", name: r.name };
                const sideDiffers = !creating && !!value && !!r.typeHint && !!typeOfCode.get(value) && typeOfCode.get(value) !== TYPE_LABEL[r.typeHint];
                const against = !creating && value && r.balance ? againstNature(BigInt(r.balance), normalOfCode.get(value) ?? "DEBIT") : null;
                const catchAll = !creating && !!value && !r.mappedCode && CATCH_ALLS[value];
                return (
                  <TableRow key={r.id} className="border-t align-top">
                    <TableCell className="whitespace-normal p-2 pl-3">
                      <div>
                        <span className="num text-muted-foreground">{displaySourceCode(r.code)}</span> {r.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {r.entity}
                        {r.previousNames.length > 0 && <> · dulu: {r.previousNames.map((p) => `“${p}”`).join(", ")}</>}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal min-w-64 p-2">
                      <AccountPicker
                        value={value}
                        onChange={(v) => setChoice((c) => ({ ...c, [r.id]: v }))}
                        options={options}
                        extra={NEW_ITEM}
                        ariaLabel={`Akun Buku untuk ${r.code}`}
                        disabled={locked}
                        className={cn(low && "border-review")}
                      />
                      {creating && (
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <Select value={na.fsLine} onValueChange={(v) => setNewAcc((m) => ({ ...m, [r.id]: { ...na, fsLine: v as string } }))}>
                            <SelectTrigger className="w-full" aria-label="Pos laporan"><SelectValue>{fsLines.find((f) => f.key === na.fsLine)?.label}</SelectValue></SelectTrigger>
                            <SelectContent>{fsLines.map((f) => <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>)}</SelectContent>
                          </Select>
                          <Input aria-label="Nama akun baru" value={na.name} onChange={(e) => setNewAcc((m) => ({ ...m, [r.id]: { ...na, name: e.target.value } }))} />
                        </div>
                      )}
                      {low && <div className="mt-1 text-xs text-review">Keyakinan AI rendah ({Math.round((r.confidence ?? 0) * 100)}%). Periksa sebelum menerima.</div>}
                      {sideDiffers && <div className="mt-1 text-xs text-review" data-testid="side-differs">Sisi akun berbeda: di file {TYPE_LABEL[r.typeHint!]}, akun Buku {typeOfCode.get(value)}.</div>}
                      {against && !sideDiffers && (
                        <div className="mt-1 text-xs text-review" data-testid="balance-against-nature">
                          Saldo di file {formatMoney(BigInt(r.balance!) < 0n ? -BigInt(r.balance!) : BigInt(r.balance!), r.currency)} di sisi {against}, tidak biasa untuk akun Buku ini. Periksa pilihannya.
                        </div>
                      )}
                      {catchAll && <div className="mt-1 text-xs text-muted-foreground" data-testid="catch-all">Akun penampung ({catchAll}) — pilih “+ Buat akun baru” untuk mempertahankan rincian klien.</div>}
                    </TableCell>
                    <TableCell className="whitespace-normal hidden p-2 lg:table-cell">
                      {r.mappedCode ? (
                        <MethodBadge method={r.mappedBy ?? "MANUAL"} />
                      ) : r.suggestedBy ? (
                        <div className="space-y-0.5">
                          <MethodBadge method={r.suggestedBy} />
                          {r.suggestedBy === "AI" && r.confidence !== null && <span className="num ml-1 text-xs text-muted-foreground">{Math.round(r.confidence * 100)}%</span>}
                          {r.reason && <div className="max-w-xs truncate text-xs text-muted-foreground" title={r.reason}>{r.reason}</div>}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">Belum ada saran</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-normal p-2 pr-3 text-right">
                      {r.mappedCode && !changed ? (
                        <span className="inline-flex items-center gap-1 text-xs text-pass"><Check className="size-3.5" /> Dipetakan</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={locked || !value || busy !== null || (creating && !na.name.trim())}
                          onClick={() =>
                            accept(
                              [
                                creating
                                  ? { sourceAccountId: r.id, newAccount: { fsLine: na.fsLine, name: na.name.trim() }, method: "NEW" }
                                  : { sourceAccountId: r.id, accountCode: value, method: value === r.suggestedCode && r.suggestedBy ? r.suggestedBy : "MANUAL" },
                              ],
                              r.id,
                            )
                          }
                        >
                          {busy === r.id ? <Loader2 className="animate-spin" /> : null}
                          {r.mappedCode ? "Ubah" : "Terima"}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {(showAll ? rows : unmapped).length > limit && (
        <Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + PAGE)}>
          Tampilkan {Math.min(PAGE, (showAll ? rows : unmapped).length - limit)} berikutnya
        </Button>
      )}
    </div>
  );
}
