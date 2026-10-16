import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLoopbackDatabase, databaseUrl, driverHost, isLoopbackDatabaseUrl, nonLocalTargets } from "@/lib/db-url";

// Fictional URLs only: nothing here reads the real environment or connects.
const LOCAL = "postgresql://buku:buku@localhost:5432/buku_test";
const HOSTED = "postgresql://u:p@hosted-pooler.invalid:6543/postgres";
const DIRECT = "postgresql://u:p@hosted-direct.invalid:5432/postgres";
const root = path.resolve(__dirname, "../..");
const requireFromRoot = createRequire(path.join(root, "package.json"));

afterEach(() => vi.unstubAllEnvs());

describe("databaseUrl", () => {
  it("prefers the integration's pooled URL, then POSTGRES_URL, then DATABASE_URL", () => {
    expect(databaseUrl({ POSTGRES_PRISMA_URL: HOSTED, POSTGRES_URL: DIRECT, DATABASE_URL: LOCAL })).toBe(HOSTED);
    expect(databaseUrl({ POSTGRES_URL: DIRECT, DATABASE_URL: LOCAL })).toBe(DIRECT);
    expect(databaseUrl({ DATABASE_URL: LOCAL })).toBe(LOCAL);
  });

  it("treats an empty variable as unset and never picks the non-pooling URL", () => {
    expect(databaseUrl({ POSTGRES_PRISMA_URL: "", POSTGRES_URL: "", DATABASE_URL: LOCAL })).toBe(LOCAL);
    expect(databaseUrl({ POSTGRES_URL_NON_POOLING: DIRECT, DIRECT_URL: DIRECT })).toBeUndefined();
  });
});

describe("isLoopbackDatabaseUrl follows the driver, not the URL's hostname alone", () => {
  it.each([LOCAL, "postgresql://u@127.0.0.1:55432/db", "postgresql://u@[::1]:5432/db", "postgres://u@localhost/db", "postgresql:///db"])("accepts %s", (url) => {
    expect(isLoopbackDatabaseUrl(url)).toBe(true);
  });

  it.each([
    [HOSTED, "hosted host"],
    ["postgresql://u@localhost:5432/db?host=hosted.invalid", "?host= override: the driver dials hosted.invalid"],
    ["postgresql://u@localhost:5432/db?HOST=hosted.invalid", "host parameter in any case"],
    ["postgresql://u@localhost:5432/db?%68ost=hosted.invalid", "percent-encoded parameter name"],
    ["postgresql://u@localhost/db?host=localhost", "any host-moving parameter, even a local one"],
    ["postgresql://u@localhost/db?hostaddr=192.0.2.1", "hostaddr"],
    ["postgresql://u@localhost/db?service=fiktif", "service"],
    ["postgresql://u@hosted.invalid/db?host=localhost", "parsers disagree"],
    ["postgresql:///db?host=/var/run/postgresql", "socket path"],
    ["socket:/tmp/fiktif?db=d", "socket scheme"],
    ["postgresql://u@localhost,hosted.invalid/db", "host list"],
    ["postgresql://u@localhost.invalid/db", "lookalike name"],
    ["postgresql://u@LOCALHOST/db?x=1&host=hosted.invalid", "parameter after another"],
    ["mysql://u@localhost/db", "other scheme"],
    ["not a url", "pg parses this to host 'base'"],
    ["", "empty"],
  ])("refuses %s (%s)", (url) => {
    expect(isLoopbackDatabaseUrl(url)).toBe(false);
  });

  it("an empty host falls back to PGHOST, as the driver does", () => {
    expect(driverHost("postgresql:///db", { PGHOST: "hosted.invalid" })).toBe("hosted.invalid");
    expect(isLoopbackDatabaseUrl("postgresql:///db", { PGHOST: "hosted.invalid" })).toBe(false);
    expect(isLoopbackDatabaseUrl("postgresql:///db", { PGHOST: "127.0.0.1" })).toBe(true);
  });

  it("uses the same pg-connection-string file the pg driver loads", () => {
    const requireFromPg = createRequire(requireFromRoot.resolve("pg"));
    expect(requireFromRoot.resolve("pg-connection-string")).toBe(requireFromPg.resolve("pg-connection-string"));
  });

  it.each([
    ["postgresql://u@localhost:5432/db", ""],
    ["postgresql://u@localhost:5432/db?host=hosted.invalid", ""],
    ["postgresql:///db", "hosted.invalid"],
    ["postgresql:///db", ""],
    ["postgresql://u@[::1]:5432/db", ""],
    ["postgresql://u@localhost/db?host=", "hosted.invalid"],
  ])("driverHost(%s, PGHOST=%s) equals pg's own ConnectionParameters.host (no connection made)", (url, pghost) => {
    const ConnectionParameters = createRequire(requireFromRoot.resolve("pg"))("./connection-parameters") as new (u: string) => { host: string };
    vi.stubEnv("PGHOST", pghost || undefined);
    expect(driverHost(url, pghost ? { PGHOST: pghost } : {})).toBe(new ConnectionParameters(url).host);
  });
});

describe("assertLoopbackDatabase", () => {
  it("refuses a local DATABASE_URL shadowed by a hosted pooled URL (the old e2e guard passed this)", () => {
    expect(() => assertLoopbackDatabase({ DATABASE_URL: LOCAL, POSTGRES_PRISMA_URL: HOSTED }, "demo:reset")).toThrow(/POSTGRES_PRISMA_URL/);
    expect(() => assertLoopbackDatabase({ DATABASE_URL: LOCAL, POSTGRES_URL: HOSTED }, "demo:reset")).toThrow(/POSTGRES_URL/);
  });

  it("refuses a hosted migration or seed URL beside a local one", () => {
    expect(() => assertLoopbackDatabase({ DATABASE_URL: LOCAL, POSTGRES_URL_NON_POOLING: DIRECT }, "E2E setup")).toThrow(/POSTGRES_URL_NON_POOLING/);
    expect(() => assertLoopbackDatabase({ DATABASE_URL: LOCAL, DIRECT_URL: DIRECT }, "E2E setup")).toThrow(/DIRECT_URL/);
  });

  it("refuses a ?host= override hidden in the URL the guard used to pass", () => {
    expect(() => assertLoopbackDatabase({ DATABASE_URL: "postgresql://u@localhost:5432/db?host=hosted.invalid" }, "demo:reset")).toThrow(/DATABASE_URL/);
  });

  it("refuses a hosted PGHOST, PGHOSTADDR, any PGSERVICE and a hosted Auth URL", () => {
    expect(nonLocalTargets({ DATABASE_URL: LOCAL, PGHOST: "hosted.invalid", PGHOSTADDR: "192.0.2.1", PGSERVICE: "x", PGSERVICEFILE: "/x" }))
      .toEqual(["PGHOST", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"]);
    expect(nonLocalTargets({ DATABASE_URL: LOCAL, NEXT_PUBLIC_SUPABASE_URL: "https://fiktif.invalid" })).toEqual(["NEXT_PUBLIC_SUPABASE_URL"]);
    expect(nonLocalTargets({ DATABASE_URL: LOCAL, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", PGHOST: "localhost" })).toEqual([]);
  });

  it("names variables but never prints their values", () => {
    expect(() => assertLoopbackDatabase({ POSTGRES_PRISMA_URL: HOSTED, NEXT_PUBLIC_SUPABASE_URL: "https://fiktif.invalid" }, "demo:reset")).toThrow(
      /^demo:reset refused: only a localhost database and Auth are allowed; not localhost or not supported: POSTGRES_PRISMA_URL, NEXT_PUBLIC_SUPABASE_URL\.$/,
    );
  });

  it("refuses no URL at all and accepts an all-local environment, empty overrides included", () => {
    expect(() => assertLoopbackDatabase({}, "demo:reset")).toThrow(/no database URL/);
    expect(() => assertLoopbackDatabase({ DATABASE_URL: LOCAL, POSTGRES_PRISMA_URL: "", POSTGRES_URL_NON_POOLING: LOCAL }, "demo:reset")).not.toThrow();
  });
});

describe("destructive entrypoints refuse before anything that can build a client (static order)", () => {
  const source = (file: string) => readFileSync(path.join(root, file), "utf8");
  const imports = (text: string) => [...text.matchAll(/^import\s.*?["']([^"']+)["'];?$/gm)].map((m) => m[1]);

  it.each(["scripts/seed.ts", "scripts/e2e-setup.ts", "scripts/e2e-table-counts.ts", "tests/helpers.ts"])("%s imports the guard before any app module", (file) => {
    const list = imports(source(file));
    const guard = list.findIndex((spec) => spec.endsWith("lib/local-database-only"));
    expect(guard).toBeGreaterThan(-1);
    const firstApp = list.findIndex((spec) => (spec.startsWith("@/") || spec.startsWith(".")) && !spec.endsWith("lib/local-database-only"));
    expect(firstApp === -1 || guard < firstApp).toBe(true);
    const dotenv = list.indexOf("dotenv/config");
    expect(dotenv === -1 || dotenv < guard).toBe(true);
  });

  it("the test migrations check their URL before running prisma migrate", () => {
    const text = source("tests/global-setup.ts");
    expect(text.indexOf("assertLoopbackDatabase({ DATABASE_URL: url")).toBeGreaterThan(-1);
    expect(text.indexOf("assertLoopbackDatabase({ DATABASE_URL: url")).toBeLessThan(text.indexOf("execSync("));
  });

  it("lib/db.ts resolves its default URL through databaseUrl", () => {
    expect(source("lib/db.ts")).toMatch(/createPrisma\(url = databaseUrl\(process\.env\)\)/);
  });
});
