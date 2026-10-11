import type { AiRunView } from "@/lib/ai/run";

/**
 * What the "Saran AI" item says about the client's background run (import result and Review). Pure: `value` follows the label
 * "Saran AI" (the import result shows them as a label/value row, Review as one line `Saran AI ${value}`); `note` is the run's own
 * sentence (budget used up, AI belum diatur…) shown under it. A run that stopped with no suggestion says only its note.
 */
export type AiRunStatusText = { state: "running" | "done" | "stopped"; value: string; note: string | null };

const n = (v: number) => v.toLocaleString("id-ID");

export function aiRunStatusText(run: AiRunView): AiRunStatusText {
  if (run.status === "RUNNING") return { state: "running", value: `diproses · ${n(Math.min(run.askedLines, run.totalLines))} dari ${n(run.totalLines)} transaksi`, note: null };
  if (run.suggestedLines > 0) {
    const left = run.totalLines - run.suggestedLines;
    return { state: "done", value: `selesai · ${n(run.suggestedLines)} saran${left > 0 ? ` · ${n(left)} tetap tebakan sederhana` : ""}`, note: run.note };
  }
  if (run.note) return { state: "stopped", value: "tidak ada saran baru", note: run.note };
  return { state: "done", value: "selesai · tidak ada saran baru", note: null };
}
