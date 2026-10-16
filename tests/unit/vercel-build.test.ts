import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The real scripts/vercel-build.sh under bash with a clean env and fictional URLs. A fake `npx` first on PATH records each call and the
// database host it would use, and never runs anything; nothing connects. ADR 0019: a build writes nothing to the database or Auth.
const root = path.resolve(__dirname, "../..");
const SCRIPT = path.join(root, "scripts/vercel-build.sh");
const POOLED = "postgresql://u:p@hosted-pooler.invalid:6543/postgres";
const DIRECT = "postgresql://u:p@hosted-direct.invalid:5432/postgres";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "vercel-build-"));
  // Each records "<args> | db=<DATABASE_URL host>". `prisma migrate status` exits with $STUB_STATUS_EXIT, `prisma migrate diff` with
  // $STUB_DIFF_EXIT and the history check (`node scripts/migration-history.mjs`) with $STUB_HISTORY_EXIT (all default 0).
  const record = `host=$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-z]+://([^@/]*@)?([^:/?]*).*#\\2#')
echo "$* | db=$host" >> "$CALLS"`;
  writeFileSync(path.join(dir, "npx"), `#!/bin/bash
${record}
if [ "$1 $2 $3" = "prisma migrate status" ]; then exit "\${STUB_STATUS_EXIT:-0}"; fi
if [ "$1 $2 $3" = "prisma migrate diff" ]; then exit "\${STUB_DIFF_EXIT:-0}"; fi
exit 0
`);
  writeFileSync(path.join(dir, "node"), `#!/bin/bash
${record.replace('echo "$*', 'echo "node $*')}
exit "\${STUB_HISTORY_EXIT:-0}"
`);
  chmodSync(path.join(dir, "npx"), 0o755);
  chmodSync(path.join(dir, "node"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function build(env: Record<string, string>) {
  const calls = path.join(dir, "calls.log");
  const childEnv: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: `${dir}:/usr/bin:/bin`, CALLS: calls, ...env }; // only these, nothing inherited
  const r = spawnSync("bash", [SCRIPT], { cwd: root, encoding: "utf8", env: childEnv });
  return { code: r.status, stderr: r.stderr, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [] };
}

const URLS = { POSTGRES_PRISMA_URL: POOLED, POSTGRES_URL_NON_POOLING: DIRECT };
const HAZARD_FLAGS = [
  ["nothing extra", {}],
  ["DEMO_MODE=true", { DEMO_MODE: "true" }],
  ["DEMO_MODE=true + demo admin", { DEMO_MODE: "true", DEMO_ADMIN_EMAIL: "demo@fiktif.invalid", DEMO_ADMIN_PASSWORD: "fiktif-pass" }],
  ["INITIAL_* bootstrap", { INITIAL_FIRM_NAME: "Kantor Fiktif", INITIAL_ADMIN_EMAIL: "admin@fiktif.invalid", INITIAL_ADMIN_NAME: "Admin" }],
  ["every flag at once", { DEMO_MODE: "true", DEMO_ADMIN_EMAIL: "demo@fiktif.invalid", DEMO_ADMIN_PASSWORD: "fiktif-pass", INITIAL_FIRM_NAME: "Kantor Fiktif", INITIAL_ADMIN_EMAIL: "admin@fiktif.invalid" }],
] as const;

describe("vercel-build.sh writes nothing, whatever the environment says", () => {
  it.each(HAZARD_FLAGS)("%s: generate, read-only migrate status and drift check on the direct URL, next build — nothing else", (_name, flags) => {
    const r = build({ ...URLS, ...flags });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([
      `prisma generate | db=hosted-pooler.invalid`,
      `prisma migrate status | db=hosted-direct.invalid`,
      `node scripts/migration-history.mjs | db=hosted-direct.invalid`,
      `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code | db=hosted-direct.invalid`,
      `next build | db=hosted-pooler.invalid`,
    ]);
    expect(r.calls.join("\n")).not.toMatch(/tsx|seed|bootstrap|migrate deploy|db push|migrate reset|demo:reset|access/);
  });

  it("a pending or failed migration fails the build before next build, and says what to run", () => {
    const r = build({ ...URLS, STUB_STATUS_EXIT: "1" });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([`prisma generate | db=hosted-pooler.invalid`, `prisma migrate status | db=hosted-direct.invalid`]);
    expect(r.stderr).toMatch(/Apply the pending migrations with `npm run db:migrate`/);
  });

  it.each([
    ["an unknown or edited applied migration", { STUB_HISTORY_EXIT: "2" }, [`node scripts/migration-history.mjs | db=hosted-direct.invalid`]],
    ["tables that differ from schema.prisma", { STUB_DIFF_EXIT: "2" }, [`node scripts/migration-history.mjs | db=hosted-direct.invalid`, `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code | db=hosted-direct.invalid`]],
  ] as const)("drift (%s) fails the build before next build", (_name, flags, driftCalls) => {
    const r = build({ ...URLS, ...flags });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([`prisma generate | db=hosted-pooler.invalid`, `prisma migrate status | db=hosted-direct.invalid`, ...driftCalls]);
    expect(r.stderr).toMatch(/has drifted from prisma\/migrations/);
  });

  it("without any database URL it stops before running anything", () => {
    const r = build({});
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.stderr).toMatch(/No database URL/);
  });

  it("falls back to DATABASE_URL for both steps when the integration's URLs are absent", () => {
    const r = build({ DATABASE_URL: DIRECT });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([
      `prisma generate | db=hosted-direct.invalid`,
      `prisma migrate status | db=hosted-direct.invalid`,
      `node scripts/migration-history.mjs | db=hosted-direct.invalid`,
      `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code | db=hosted-direct.invalid`,
      `next build | db=hosted-direct.invalid`,
    ]);
  });
});

describe("no write path remains for a build to call", () => {
  it("the build script never names a writing command", () => {
    const text = readFileSync(SCRIPT, "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(text).not.toMatch(/migrate deploy|db push|migrate reset|tsx|seed|bootstrap|demo:reset|access/);
    expect(text).toMatch(/npx prisma migrate status/);
  });

  it("the drift check only reads: no writing command, and its SQL runs in a READ ONLY transaction", () => {
    const code = (f: string) => readFileSync(path.join(root, f), "utf8").split("\n").filter((l) => !/^\s*(#|\/\/|\*)/.test(l)).join("\n");
    expect(code("scripts/db-drift.sh")).not.toMatch(/migrate deploy|db push|db execute|migrate reset|--script|tsx|seed|access/);
    const history = code("scripts/migration-history.mjs");
    expect(history).toMatch(/BEGIN READ ONLY/);
    expect(history).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/);
  });

  it("the hosted-only seed and bootstrap scripts are gone and nothing in package.json points at them", () => {
    expect(existsSync(path.join(root, "scripts/seed-if-empty.ts"))).toBe(false);
    expect(existsSync(path.join(root, "scripts/bootstrap-admin.ts"))).toBe(false);
    const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts as Record<string, string>;
    expect(scripts["vercel-build"]).toBe("bash scripts/vercel-build.sh");
    expect(Object.values(scripts).join("\n")).not.toMatch(/seed-if-empty|bootstrap-admin/);
  });
});
