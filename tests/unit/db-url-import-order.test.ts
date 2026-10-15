import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real lib/db.ts, real generated PrismaClient and real PrismaPg adapter, wrapped only to count constructions: lib/db builds its client
// when first imported, so a guard inside main() would run after a client for the hosted URL exists. Every socket, TLS and DNS entry
// point is replaced by a blocking counter that throws before any syscall. Fictional .invalid / port-1 URLs only; seeding, Auth
// writes, child processes and file writes are mocked.
const LOCAL = "postgresql://fictional:fictional@127.0.0.1:1/fictional";
const HOSTED = "postgresql://u:p@hosted-pooler.invalid:6543/postgres";
const VARS = ["POSTGRES_PRISMA_URL", "POSTGRES_URL", "DATABASE_URL", "POSTGRES_URL_NON_POOLING", "DIRECT_URL", "TEST_DATABASE_URL",
  "PGHOST", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "NEXT_PUBLIC_SUPABASE_URL"];

let calls: string[];
let network: string[];
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const block = (name: string) => () => { network.push(name); throw new Error(`blocked ${name}`); };

function env(values: Record<string, string>) {
  for (const name of VARS) vi.stubEnv(name, values[name] ?? "");
  vi.stubEnv("BASE_URL", "http://localhost:3200");
}

const host = (options: unknown) => {
  const url = options && typeof options === "object" && "connectionString" in options ? String(options.connectionString) : "";
  try { return new URL(url).hostname; } catch { return "?"; }
};

beforeEach(() => {
  calls = [];
  network = [];
  vi.resetModules();
  delete (globalThis as { prisma?: unknown }).prisma; // lib/db.ts caches its client here outside production
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(block("net.Socket.connect") as never);
  vi.spyOn(net, "connect").mockImplementation(block("net.connect") as never);
  vi.spyOn(net, "createConnection").mockImplementation(block("net.createConnection") as never);
  vi.spyOn(tls, "connect").mockImplementation(block("tls.connect") as never);
  vi.spyOn(dns, "lookup").mockImplementation(block("dns.lookup") as never);
  vi.spyOn(dns.promises, "lookup").mockImplementation(block("dns.promises.lookup") as never);
  vi.doMock("dotenv/config", () => ({}));
  vi.doMock("@prisma/adapter-pg", async (importOriginal) => {
    const real = await importOriginal<typeof import("@prisma/adapter-pg")>();
    function PrismaPg(...args: ConstructorParameters<typeof real.PrismaPg>) { calls.push(`new PrismaPg(${host(args[0])})`); return new real.PrismaPg(...args); }
    return { ...real, PrismaPg };
  });
  vi.doMock("@/lib/generated/prisma/client", async (importOriginal) => {
    const real = await importOriginal<typeof import("@/lib/generated/prisma/client")>();
    function PrismaClient(...args: ConstructorParameters<typeof real.PrismaClient>) { calls.push("new PrismaClient"); return new real.PrismaClient(...args); }
    return { ...real, PrismaClient };
  });
  vi.doMock("@/lib/demo/seed", () => ({ seedDemo: vi.fn(async () => { calls.push("seedDemo (truncateAll)"); }), liveUploadFile: vi.fn(async () => ({ fileName: "fiktif.csv", data: "" })) }));
  vi.doMock("@/lib/demo/admin", () => ({ seedDemoAdmin: vi.fn(async () => { calls.push("seedDemoAdmin (Auth write)"); }) }));
  vi.doMock("@/lib/auth/operator", () => ({ ensureLocalAdmin: vi.fn(() => calls.push("ensureLocalAdmin (Auth write)")) }));
  vi.doMock("@/lib/supabase/admin", () => ({ createSupabaseAdmin: vi.fn(() => calls.push("createSupabaseAdmin")) }));
  vi.doMock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:fs")>()), writeFileSync: vi.fn(() => calls.push("writeFileSync")), mkdirSync: vi.fn() }));
  vi.doMock("node:child_process", () => ({ execSync: vi.fn((cmd: string) => { calls.push(`execSync ${cmd}`); throw new Error("stop: after the guard"); }) }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => { calls.push(`process.exit ${code}`); }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete (globalThis as { prisma?: unknown }).prisma;
  process.exitCode = undefined;
});

const ENTRYPOINTS = [
  ["demo:reset", () => import("../../scripts/seed")],
  ["e2e setup", () => import("../../scripts/e2e-setup")],
  ["e2e table counts", () => import("../../scripts/e2e-table-counts")],
  ["DB test helper", () => import("../helpers")],
] as const;

describe.each(ENTRYPOINTS)("%s: a non-local target is refused before any constructor or network attempt", (_, load) => {
  it.each([
    ["hosted pooled URL over a local DATABASE_URL", { DATABASE_URL: LOCAL, POSTGRES_PRISMA_URL: HOSTED }],
    ["?host= override in a localhost DATABASE_URL", { DATABASE_URL: "postgresql://u@localhost:5432/db?host=hosted.invalid" }],
    ["empty host falling back to a hosted PGHOST", { DATABASE_URL: "postgresql:///db", PGHOST: "hosted.invalid" }],
    ["hosted Auth URL", { DATABASE_URL: LOCAL, NEXT_PUBLIC_SUPABASE_URL: "https://fiktif.invalid" }],
  ])("%s", async (_case, values) => {
    env(values);
    const error = await load().then(() => null, (e: unknown) => e);
    await settle();
    expect(error).toBeInstanceOf(Error);
    expect({ calls, network }).toEqual({ calls: [], network: [] });
  });
});

describe("loopback passes the guard and reaches the real constructors (no query issued, so no socket)", () => {
  it("demo:reset: the import-time client and main()'s client both point at 127.0.0.1", async () => {
    env({ DATABASE_URL: LOCAL });
    await import("../../scripts/seed");
    await settle();
    expect(calls).toEqual(["new PrismaPg(127.0.0.1)", "new PrismaClient", "new PrismaPg(127.0.0.1)", "new PrismaClient", "seedDemo (truncateAll)", "seedDemoAdmin (Auth write)", "writeFileSync"]);
    expect(network).toEqual([]);
  });

  it("DB test helper", async () => {
    env({ DATABASE_URL: LOCAL });
    await import("../helpers");
    expect(calls).toEqual(["new PrismaPg(127.0.0.1)", "new PrismaClient", "new PrismaPg(127.0.0.1)", "new PrismaClient"]);
    expect(network).toEqual([]);
  });
});

describe("test migrations (tests/global-setup.ts)", () => {
  it("a hosted TEST_DATABASE_URL never reaches prisma migrate or the network", async () => {
    env({ TEST_DATABASE_URL: HOSTED });
    const { default: setup } = await import("../global-setup");
    expect(() => setup()).toThrow(/^Test migrations refused/);
    expect({ calls, network }).toEqual({ calls: [], network: [] });
  });
});
