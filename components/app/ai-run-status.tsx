"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, CircleCheck, Loader2 } from "lucide-react";
import { aiRunStatusAction } from "@/app/actions";
import type { AiRunView } from "@/lib/ai/run";
import { aiRunStatusText } from "@/lib/ai/run-status";
import { cn } from "@/lib/utils";

const FAST_MS = 4_000;
const SLOW_MS = 10_000;
const SLOW_AFTER_MS = 120_000;

/**
 * The client's background AI run as the page knows it (cycle 2026-10-10-import-ai-background). Starts from the server's `initial`
 * (and follows it when a refresh brings a new one); `adopt` seeds it from an action's answer at once. While RUNNING it polls
 * `aiRunStatusAction` (every 4 s, 10 s after two minutes, paused while the tab is hidden) and refreshes the page once each time
 * suggestions arrive or the run finishes, so Review lines and counts follow. `watched`: this view saw the run while it was RUNNING.
 */
export function useAiRun(clientId: string | undefined, initial: AiRunView | null) {
  const router = useRouter();
  const [run, setRun] = useState(initial);
  const [seen, setSeen] = useState<string | null>(initial?.status === "RUNNING" ? initial.id : null);
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    setRun(initial);
    if (initial?.status === "RUNNING") setSeen(initial.id);
  }
  const adopt = useCallback((next: AiRunView | null) => {
    setRun(next);
    if (next?.status === "RUNNING") setSeen(next.id);
  }, []);

  const last = useRef(run);
  useEffect(() => {
    last.current = run;
  }, [run]);

  const running = run?.status === "RUNNING";
  const runId = run?.id;
  useEffect(() => {
    if (!clientId || !running) return;
    const started = Date.now();
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(tick, Date.now() - started > SLOW_AFTER_MS ? SLOW_MS : FAST_MS);
    };
    const tick = async () => {
      timer = undefined;
      // Hidden tab: no request; becoming visible again asks at once.
      if (stopped || document.hidden) return;
      inFlight = true;
      try {
        const r = await aiRunStatusAction(clientId);
        if (stopped) return;
        if (!r.ok) return; // no access any more: stop asking
        const prev = last.current;
        const next = r.aiRun;
        last.current = next;
        setRun(next);
        if (next && prev && next.id === prev.id && (next.suggestedLines > prev.suggestedLines || (next.status === "DONE" && prev.status !== "DONE"))) router.refresh();
        if (next?.status === "RUNNING") {
          setSeen(next.id);
          schedule();
        }
      } catch {
        // A dropped request: ask again later.
        if (!stopped) schedule();
      } finally {
        inFlight = false;
      }
    };
    const onVisible = () => {
      if (!document.hidden && !inFlight && !timer) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [clientId, running, runId, router]);

  return { run, adopt, watched: !!run && run.id === seen };
}

function StatusIcon({ state }: { state: "running" | "done" | "stopped" }) {
  if (state === "running") return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" role="img" aria-label="Sedang diproses" />;
  if (state === "stopped") return <CircleAlert className="size-3.5 shrink-0 text-review" aria-hidden />;
  return <CircleCheck className="size-3.5 shrink-0 text-pass" aria-hidden />;
}

/**
 * One "Saran AI" item. `row`: the import result's label/value row with the run's note under it. `line`: one sentence for Review
 * (a run that stopped with no suggestion says only its note). A polite live region, so progress is announced without stealing focus.
 */
export function AiRunStatus({ run, variant, className }: { run: AiRunView; variant: "row" | "line"; className?: string }) {
  const s = aiRunStatusText(run);
  if (variant === "row") {
    return (
      <div className={cn("space-y-1", className)} aria-live="polite" data-testid="ai-run-status" data-state={s.state}>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">Saran AI</span>
          <span className="num inline-flex items-center gap-1.5 text-right">
            <StatusIcon state={s.state} />
            {s.value}
          </span>
        </div>
        {s.note && <p className="text-xs text-muted-foreground">{s.note}</p>}
      </div>
    );
  }
  const main = s.state === "stopped" && s.note ? s.note : `Saran AI ${s.value}`;
  const note = s.state === "stopped" ? null : s.note;
  return (
    <div className={cn("space-y-1 text-sm", className)} aria-live="polite" data-testid="ai-run-status" data-state={s.state}>
      <p className="num flex items-center gap-1.5">
        <StatusIcon state={s.state} />
        {main}
      </p>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
