import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * The token a finished slice gives the next one (app/api/ai-run): it can only continue one existing run, for a short while. Signed with
 * a key derived from SETTINGS_SECRET (never the secret itself), so nothing outside the server can mint one.
 */
export const RUN_TOKEN_TTL_MS = 10 * 60 * 1000;

const key = (secret: string) => createHash("sha256").update(`ai-run-continue:${secret}`).digest();
const mac = (secret: string, runId: string, exp: number) => createHmac("sha256", key(secret)).update(`${runId}.${exp}`).digest("base64url");

export function signRunToken(secret: string, runId: string, now = Date.now()) {
  const exp = now + RUN_TOKEN_TTL_MS;
  return { runId, exp, sig: mac(secret, runId, exp) };
}

/** The run id the token continues, or null when it is malformed, tampered with or expired. */
export function verifyRunToken(secret: string, token: unknown, now = Date.now()): string | null {
  if (!token || typeof token !== "object") return null;
  const { runId, exp, sig } = token as Record<string, unknown>;
  if (typeof runId !== "string" || !/^[a-z0-9]{10,40}$/.test(runId) || typeof exp !== "number" || typeof sig !== "string") return null;
  if (!Number.isSafeInteger(exp) || exp < now || exp > now + RUN_TOKEN_TTL_MS) return null;
  const want = Buffer.from(mac(secret, runId, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? runId : null;
}
