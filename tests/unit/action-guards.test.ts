import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every server action and every mutating route handler reaches the one guard, `requireCapability` (ADR 0017 §5): organisation
 * open and writable, role allowed, client assigned. A new action that forgets it fails here, not in production.
 *
 * A function is guarded when its body calls `requireCapability(` (or `requirePlatformAdmin(` in the backoffice), or calls a
 * guarded function of the same file, or delegates to a guarded export of another server-action module (`evidenceActions.x(`).
 */
const ROOT = join(process.cwd(), "app");
/** Server actions that run before anyone is signed in, by design. */
const PUBLIC_ACTIONS: Record<string, string> = {
  "app/login/actions.ts": "sign in, ask for a reset link, sign out",
  "app/daftar/actions.ts": "the public trial request, throttled per address and IP (lib/signup.ts)",
};
/** Mutating routes guarded elsewhere, with where. */
const OTHER_GUARD: Record<string, string> = {
  "app/auth/callback/confirm/route.ts": "public email authentication before membership exists; same-origin POST, allowlisted token type and Auth verification (email-templates.test.ts, auth-links.spec.ts)",
  "app/kirim/[token]/upload/route.ts": "token-only client upload; lib/upload-links resolveUploadLink refuses a link of an organisation that is not ACTIVE",
  "app/api/ai-run/route.ts": "server-to-server continuation of a background AI run; a short-lived HMAC token (lib/ai/run-token.ts) names one existing RUNNING run, and lib/ai/background continueRun refuses a run someone is working on or of an organisation that is not ACTIVE",
};
const GUARDS = /\b(requireCapability|requirePlatformAdmin)\(/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

type Fn = { name: string; exported: boolean; body: string };
/** Top-level functions of a module: each runs from its declaration at column 0 to the next top-level declaration. */
export function functions(src: string): Fn[] {
  const decl = /^(export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/gm;
  const starts = [...src.matchAll(decl)];
  return starts.map((m, i) => ({ name: m[2], exported: Boolean(m[1]), body: src.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index : src.length) }));
}

/** Names of the guarded functions of a module, given the guarded exports of the modules it delegates to. */
export function guarded(src: string, delegates: Record<string, Set<string>> = {}): Set<string> {
  const fns = functions(src);
  const ok = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const f of fns) {
      if (ok.has(f.name)) continue;
      const calls = (name: string) => new RegExp(`(?<![\\w.])${name}\\(`).test(f.body.slice(f.body.indexOf("{")));
      const viaDelegate = Object.entries(delegates).some(([ns, names]) => [...f.body.matchAll(new RegExp(`\\b${ns}\\.(\\w+)\\(`, "g"))].some((m) => names.has(m[1])));
      if (GUARDS.test(f.body) || [...ok].some(calls) || viaDelegate) { ok.add(f.name); changed = true; }
    }
  }
  return ok;
}

const rel = (p: string) => relative(process.cwd(), p).split("\\").join("/");
const files = walk(ROOT).filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"));
const serverModules = files.filter((p) => /^\s*["']use server["']/.test(readFileSync(p, "utf8")));

describe("every server action reaches requireCapability", () => {
  const delegates = {
    evidenceActions: guarded(readFileSync(join(ROOT, "evidence-actions.ts"), "utf8")),
    googleActions: guarded(readFileSync(join(ROOT, "google-actions.ts"), "utf8")),
    inboxActions: guarded(readFileSync(join(ROOT, "inbox-actions.ts"), "utf8")),
  };
  it("finds the server-action modules", () => expect(serverModules.map(rel)).toEqual(expect.arrayContaining(["app/actions.ts", "app/evidence-actions.ts", "app/settings-actions.ts", "app/google-actions.ts", "app/inbox-actions.ts", "app/workspace-actions.ts"])));
  for (const path of serverModules) {
    const name = rel(path);
    if (PUBLIC_ACTIONS[name]) continue;
    it(name, () => {
      const src = readFileSync(path, "utf8");
      const ok = guarded(src, delegates);
      const open = functions(src).filter((f) => f.exported && !ok.has(f.name)).map((f) => f.name);
      expect(open, `${name}: exported actions without requireCapability`).toEqual([]);
    });
  }
});

describe("every mutating route handler reaches requireCapability", () => {
  const routes = files.filter((p) => /\/route\.ts$/.test(p));
  for (const path of routes) {
    const name = rel(path);
    const src = readFileSync(path, "utf8");
    const mutating = functions(src).filter((f) => f.exported && /^(POST|PUT|PATCH|DELETE)$/.test(f.name));
    const settingsGet = name.startsWith("app/api/") ? functions(src).filter((f) => f.exported && f.name === "GET") : [];
    const handlers = [...mutating, ...settingsGet];
    if (!handlers.length || OTHER_GUARD[name]) continue;
    it(name, () => {
      const ok = guarded(src);
      expect(handlers.filter((f) => !ok.has(f.name)).map((f) => f.name), `${name}: handlers without requireCapability`).toEqual([]);
    });
  }
  it("names the guard of every route it exempts", () => {
    for (const [name, why] of Object.entries(OTHER_GUARD)) {
      expect(files.map(rel)).toContain(name);
      expect(why.length).toBeGreaterThan(20);
    }
  });
});

describe("the guard scanner", () => {
  it("flags an export that reaches no guard, directly or through helpers", () => {
    const src = `"use server";
async function helper(id: string) { await requireCapability("books.write", { clientId: id }); }
async function plain() { return 1; }
export async function viaHelper(id: string) { await helper(id); }
export async function direct() { await requireCapability("books.read"); }
export async function open() { await plain(); }
export async function delegated() { return evidenceActions.ok(); }
export async function delegatedOpen() { return evidenceActions.nope(); }`;
    const ok = guarded(src, { evidenceActions: new Set(["ok"]) });
    expect(functions(src).filter((f) => f.exported && !ok.has(f.name)).map((f) => f.name)).toEqual(["open", "delegatedOpen"]);
  });
});
