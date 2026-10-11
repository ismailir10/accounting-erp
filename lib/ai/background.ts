import { after } from "next/server";
import type { Db } from "@/lib/db";
import type { AiProvider } from "@/lib/ai/provider";
import { aiRunView, isStalled, latestAiRun, resumeAiRun, runInBackground, startAiRun, type AiRunView } from "@/lib/ai/run";
import { signRunToken } from "@/lib/ai/run-token";
import { accessState } from "@/lib/access/grant";
import { resolveProvider } from "@/lib/settings/ai";

/**
 * The app's side of the background run (lib/ai/run.ts): work scheduled with next/server `after()`, so no request waits on an AI call.
 * Callers check access first; only a member who may write a client's books starts or resumes paid calls for it. A slice that ends with
 * work left asks the app for the next one (app/api/ai-run), so a run finishes even when nobody keeps the page open.
 */

type Client = { id: string; firmId: string };

/** One time box of the client's run, then — when it ended with work left — the request for the next one. */
async function work(db: Db, client: Client, provider: AiProvider | null) {
  const { continueRunId } = await runInBackground(db, { firmId: client.firmId, clientId: client.id, provider });
  if (continueRunId) await requestNextSlice(continueRunId);
}

/** The same for a run already validated as stalled: only that run is worked, never a new one (no fresh call cap). */
async function resume(db: Db, runId: string, provider: AiProvider | null) {
  const { continueRunId } = await resumeAiRun(db, runId, { provider });
  if (continueRunId) await requestNextSlice(continueRunId);
}

/**
 * Ask the app (a new function invocation with its own time limit) to continue the run. Without APP_URL or SETTINGS_SECRET nothing is
 * sent: the next page view or status poll of the client resumes the run instead. Failures are logged, never thrown (an `after` callback
 * has no one to report to).
 */
export async function requestNextSlice(runId: string, fetchImpl: typeof fetch = fetch) {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const secret = process.env.SETTINGS_SECRET ?? "";
  if (!base || secret.length < 32) return false;
  try {
    const res = await fetchImpl(`${base}/api/ai-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signRunToken(secret, runId)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.error(`AI run ${runId}: next slice refused (${res.status})`);
    return res.ok;
  } catch (e) {
    console.error(`AI run ${runId}: next slice not requested: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`);
    return false;
  }
}

/** Start (or join) the client's run and schedule its work after the response. */
export async function scheduleAiRun(db: Db, client: Client, provider: AiProvider): Promise<AiRunView | null> {
  const run = await startAiRun(db, { firmId: client.firmId, clientId: client.id });
  if (run) after(() => work(db, client, provider));
  return aiRunView(run);
}

/** The client's run to show; a stalled one is resumed after the response when the viewer may write (read-only viewers only see it). */
export async function aiRunForView(db: Db, client: Client, opts: { canWrite: boolean }): Promise<AiRunView | null> {
  const run = await latestAiRun(db, client.id);
  if (run && opts.canWrite && isStalled(run)) {
    const provider = await resolveProvider(db);
    after(() => resume(db, run.id, provider));
  }
  return aiRunView(run);
}

/**
 * The next slice a previous slice asked for (app/api/ai-run): only a RUNNING run nobody is working on, for its own client, of an
 * organisation whose access is still ACTIVE (a read-only or suspended organisation gets no AI work, ADR 0017).
 */
export async function continueRun(db: Db, runId: string, opts: { now?: Date; schedule?: (task: () => Promise<void>) => void } = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  const run = await db.aiRun.findUnique({ where: { id: runId }, select: { status: true, leaseUntil: true, clientId: true, firmId: true } });
  if (!run || !isStalled(run, now)) return false;
  const firm = await db.firm.findUnique({ where: { id: run.firmId }, select: { suspendedAt: true, grants: true } });
  if (!firm || accessState(firm.grants, firm, now).state !== "ACTIVE") return false;
  const provider = await resolveProvider(db);
  (opts.schedule ?? after)(() => resume(db, runId, provider));
  return true;
}
