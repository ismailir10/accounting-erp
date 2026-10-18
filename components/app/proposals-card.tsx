"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Money } from "@/components/app/money";
import { dismissProposalAction, postProposalAction } from "@/app/actions";
import { formNotice, type SourceRoute } from "@/lib/approvals/second";

export type ProposalView = {
  id: string;
  memo: string;
  reason: string;
  source: "AI_CONTROL" | "SUSPENSE";
  entity: string;
  currency: string;
  /** Re-classifies one bank line: its current account (line `fixed`) can't change, only the target. */
  fixed: number | null;
  lines: { accountCode: string; debit: string; credit: string }[];
  /** Why it can't be posted (e.g. a Jurnal Penyesuaian already made this correction); only *Abaikan* is offered. */
  blocked?: string | null;
  /** A second approver rejected it (Persetujuan kedua): "Ditolak <nama>: <catatan>". */
  rejected?: string | null;
};

/**
 * Draft journals of the period (accounting-rules 20b). Accounts may be changed, amounts never; posting is the accountant's click — and
 * above the firm's *Draf AI* threshold (`route`) that click sends it to a second approver (Persetujuan kedua).
 */
export function ProposalsCard({ clientId, periodLabel, items, accounts, locked, route }: { clientId: string; periodLabel: string; items: ProposalView[]; accounts: { code: string; name: string }[]; locked: boolean; route?: SourceRoute }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [codes, setCodes] = useState<Record<string, string[]>>({});
  const codesOf = (p: ProposalView) => codes[p.id] ?? p.lines.map((l) => l.accountCode);
  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string; pending?: boolean }>, done: string) => {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    if (!r.ok) return void toast.error((r as { error: string }).error);
    toast.success(r.pending ? "Jurnal menunggu persetujuan" : done);
    router.refresh();
  };
  const noticeOf = (p: ProposalView) => (p.source === "AI_CONTROL" ? formNotice(route, p.lines.reduce((s, l) => s + BigInt(l.debit), 0n), p.currency) : null);
  return (
    <Card data-testid="proposals">
      <CardHeader>
        <CardTitle>Usulan jurnal koreksi {periodLabel}</CardTitle>
        <CardDescription>Draf dari AI dan pemeriksaan otomatis. Nominal sudah dicocokkan dengan baris sumber; Anda boleh mengganti akun sebelum mencatat. Tidak ada yang dicatat tanpa klik Anda.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {items.map((p) => (
          <div key={p.id} className="space-y-2 border-t pt-4 first:border-t-0 first:pt-0" data-testid="proposal">
            <div className="text-sm font-medium">{p.memo}</div>
            <div className="text-xs text-muted-foreground">{p.entity} · {p.source === "AI_CONTROL" ? "Usulan AI" : "Koreksi 1999"} · {p.reason}</div>
            <div className="divide-y rounded-lg border">
              {p.lines.map((l, i) => (
                <div key={i} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
                  <div className="min-w-0 flex-1 basis-56">
                    <Select value={codesOf(p)[i]} disabled={locked || p.fixed === i} onValueChange={(v) => setCodes((x) => ({ ...x, [p.id]: codesOf(p).map((c, j) => (j === i ? (v as string) : c)) }))}>
                      <SelectTrigger className="w-full" aria-label={`Akun baris ${i + 1}`}><SelectValue placeholder="Pilih akun" /></SelectTrigger>
                      <SelectContent>{accounts.map((a) => <SelectItem key={a.code} value={a.code}>{a.code} {a.name}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <span className="w-12 text-xs text-muted-foreground">{BigInt(l.debit) > 0n ? "Debit" : "Kredit"}</span>
                  <Money className="w-36 text-right text-sm" value={BigInt(l.debit) > 0n ? BigInt(l.debit) : BigInt(l.credit)} currency={p.currency} />
                </div>
              ))}
            </div>
            {p.blocked && <p className="text-sm font-medium text-review" data-testid="proposal-blocked">{p.blocked}</p>}
            {p.rejected && <p className="text-sm font-medium text-review" data-testid="proposal-rejected">{p.rejected}</p>}
            {!p.blocked && noticeOf(p) && <p className="text-sm text-muted-foreground">{noticeOf(p)!.text}</p>}
            <div className="flex flex-wrap gap-2">
              {!p.blocked && (
                <Button variant="outline" size="sm" disabled={locked || busy !== null} onClick={() => run(p.id, () => postProposalAction(clientId, p.id, codesOf(p)), "Jurnal koreksi dicatat")}>
                  {busy === p.id ? "Mencatat…" : noticeOf(p)?.waits ? "Ajukan persetujuan" : "Catat jurnal"}
                </Button>
              )}
              {/* A 1999 difference has to be corrected before the close, so its correction can't be dismissed. */}
              {p.source !== "SUSPENSE" && <Button variant="ghost" size="sm" disabled={locked || busy !== null} onClick={() => run(`x:${p.id}`, () => dismissProposalAction(clientId, p.id), "Usulan diabaikan")}>Abaikan</Button>}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
