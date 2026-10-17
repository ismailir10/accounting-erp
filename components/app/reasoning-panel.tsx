"use client";

import { useId, useState } from "react";
import { Check, ChevronDown, CircleAlert, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { reasoningAction } from "@/app/actions";
import type { ReasoningStep } from "@/lib/approvals/reasoning";
import { cn } from "@/lib/utils";

type State = { status: "idle" | "loading" } | { status: "ready"; steps: ReasoningStep[] } | { status: "error"; error: string };

/**
 * *Lihat alasan* on an AI card (Review, Kotak persetujuan): a visible ghost toggle for the card's reason line and, when open, the steps
 * behind the suggestion as a full-width row under it — no box in a box, no sheet. Loaded on open through a read-only action, so the page
 * loads as before; the download is the only action inside. `children` lays out the reason line with the toggle where it belongs; the
 * panel follows it, so the parent must be a wrapping flex row.
 */
export function ReasoningDisclosure({ clientId, itemId, children }: { clientId: string; itemId: string; children: (toggle: React.ReactNode) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ status: "idle" });
  const panelId = useId();
  const toggle = async () => {
    setOpen((o) => !o);
    if (open || state.status === "ready" || state.status === "loading") return;
    setState({ status: "loading" });
    const r = await reasoningAction(clientId, itemId);
    setState(r.ok ? { status: "ready", steps: r.steps } : { status: "error", error: r.error });
  };
  const button = (
    <Button type="button" variant="ghost" size="sm" aria-expanded={open} aria-controls={panelId} onClick={(e) => { e.stopPropagation(); void toggle(); }} data-testid="reasoning-toggle">
      {open ? "Tutup alasan" : "Lihat alasan"} <ChevronDown className={cn("transition-transform", open && "rotate-180")} aria-hidden />
    </Button>
  );
  return (
    <>
      {children(button)}
      {open && (
        <div id={panelId} className="basis-full border-l-2 py-1 pl-4 text-sm text-foreground" data-testid="reasoning-panel">
          {state.status === "ready" ? (
            <ReasoningSteps steps={state.steps} download={`/clients/${clientId}/approvals/alasan?item=${encodeURIComponent(itemId)}`} />
          ) : state.status === "error" ? (
            <p className="text-review">{state.error}</p>
          ) : (
            <Skeleton className="h-4 w-2/3" aria-label="Memuat alasan" />
          )}
        </div>
      )}
    </>
  );
}

function ReasoningSteps({ steps, download }: { steps: ReasoningStep[]; download: string }) {
  return (
    <div className="space-y-3">
      <ol className="space-y-3">
        {steps.map((s, i) => (
          <li key={s.label} className="flex gap-3" data-testid="reasoning-step">
            <span className="num mt-0.5 w-4 shrink-0 text-xs text-muted-foreground">{i + 1}</span>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-medium">{s.label}</p>
              {s.lines.map((l) => (
                <p key={l} className="break-words">{l}</p>
              ))}
              {s.rows && (
                <table className="w-full text-left text-xs" data-testid="reasoning-rows">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="hidden py-1 pr-3 font-medium sm:table-cell">Tanggal</th>
                      <th className="py-1 pr-3 font-medium">Keterangan</th>
                      <th className="py-1 pr-3 text-right font-medium">Jumlah</th>
                      <th className="hidden py-1 pr-3 font-medium sm:table-cell">Akun</th>
                      <th className="py-1 font-medium">Dikutip</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {s.rows.map((r, j) => (
                      <tr key={j} className="align-top">
                        <td className="num hidden py-1 pr-3 sm:table-cell">{r.date}</td>
                        <td className="py-1 pr-3">
                          <span className="break-all font-mono">{r.text}</span>
                          {r.how && <span className="block text-muted-foreground">{r.how}</span>}
                        </td>
                        <td className="num py-1 pr-3 text-right whitespace-nowrap">{r.amount}</td>
                        <td className="num hidden py-1 pr-3 sm:table-cell">{r.account}</td>
                        <td className="py-1">{r.cited ? "Ya" : "Tidak"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {s.note && <p className="text-muted-foreground">{s.note}</p>}
              {s.checks && (
                <ul className="space-y-1">
                  {s.checks.map((c) => (
                    <li key={c.text} className="flex items-start gap-2">
                      {c.ok ? <Check className="mt-0.5 size-4 shrink-0 text-pass" aria-label="Lolos" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-review" aria-label="Perlu dicek" />}
                      <span>{c.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ol>
      <a href={download} download className="drill inline-flex items-center gap-1" data-testid="reasoning-download" onClick={(e) => e.stopPropagation()}>
        <Download className="size-4" aria-hidden /> Unduh nilai (CSV)
      </a>
    </div>
  );
}
