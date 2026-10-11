import { describe, expect, it } from "vitest";
import { RUN_TOKEN_TTL_MS, signRunToken, verifyRunToken } from "@/lib/ai/run-token";

const SECRET = "s".repeat(40);
const RUN = "cmv2abc123def456ghi789jk";

describe("background AI run continuation token", () => {
  it("names the run it was signed for, for ten minutes", () => {
    const now = Date.UTC(2026, 9, 11, 3, 0, 0);
    const token = signRunToken(SECRET, RUN, now);
    expect(verifyRunToken(SECRET, token, now)).toBe(RUN);
    expect(verifyRunToken(SECRET, token, now + RUN_TOKEN_TTL_MS - 1)).toBe(RUN);
    expect(verifyRunToken(SECRET, token, now + RUN_TOKEN_TTL_MS + 1)).toBeNull();
  });

  it("refuses another secret, another run, a moved expiry and malformed bodies", () => {
    const now = Date.UTC(2026, 9, 11, 3, 0, 0);
    const token = signRunToken(SECRET, RUN, now);
    expect(verifyRunToken("t".repeat(40), token, now)).toBeNull();
    expect(verifyRunToken(SECRET, { ...token, runId: "cmv2zzz123def456ghi789jk" }, now)).toBeNull();
    expect(verifyRunToken(SECRET, { ...token, exp: token.exp + 1000 }, now)).toBeNull();
    // An expiry further out than one token lifetime is never one the server signed.
    const far = signRunToken(SECRET, RUN, now + 60 * 60 * 1000);
    expect(verifyRunToken(SECRET, far, now)).toBeNull();
    for (const bad of [null, "x", 1, {}, { runId: RUN }, { runId: "../x", exp: token.exp, sig: token.sig }, { ...token, sig: "" }]) expect(verifyRunToken(SECRET, bad, now)).toBeNull();
  });
});
