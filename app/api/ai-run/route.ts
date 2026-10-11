import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { continueRun } from "@/lib/ai/background";
import { verifyRunToken } from "@/lib/ai/run-token";

export const runtime = "nodejs";
// The slice runs after the response within this limit (lib/ai/run.ts FUNCTION_LIMIT_MS).
export const maxDuration = 300;

/**
 * The next time box of a background AI run, asked for by the slice before it (lib/ai/background.ts). No session: the signed, short-lived
 * token names one run, and only a RUNNING run nobody is working on is continued — it can't start a run, change its scope or exceed its
 * call cap. The answer carries no data.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.SETTINGS_SECRET ?? "";
  if (secret.length < 32) return new NextResponse(null, { status: 404 });
  const runId = verifyRunToken(secret, await request.json().catch(() => null));
  if (!runId) return new NextResponse(null, { status: 403 });
  const continued = await continueRun(prisma, runId);
  return new NextResponse(null, { status: continued ? 202 : 204, headers: { "Cache-Control": "no-store" } });
}
