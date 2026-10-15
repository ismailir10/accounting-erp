import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real entrypoints, imported with every side effect mocked: no .env load, no Prisma client, no DB, no Auth admin, no child
// process, no file writes. Only lib/db-url.ts and lib/local-database-only.ts are real. Fictional URLs; each case sets every variable.
const LOCAL = "postgresql://buku:buku@localhost:5432/buku_test";
const HOSTED = "postgresql://u:p@hosted-pooler.invalid:6543/postgres";
const VARS = ["POSTGRES_PRISMA_URL", "POSTGRES_URL", "DATABASE_URL", "POSTGRES_URL_NON_POOLING", "DIRECT_URL", "TEST_DATABASE_URL",
  "PGHOST", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "NEXT_PUBLIC_SUPABASE_URL"];
const REFUSED = /refused: only a localhost database and Auth are allowed; not localhost or not supported: /;

let calls: string[];
let errors: unknown[];
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

function env(values: Record<string, string>) {
  for (const name of VARS) vi.stubEnv(name, values[name] ?? "");
  // Vitest exposes Vite's BASE_URL ("/") in process.env; e2e-setup reads BASE_URL as the app's address, so set the real default.
  vi.stubEnv("BASE_URL", values.BASE_URL ?? "http://localhost:3200");
}

function mockSideEffects() {
  vi.doMock("dotenv/config", () => ({}));
  vi.doMock("@/lib/db", () => ({
    createPrisma: vi.fn(() => {
      calls.push("createPrisma");
      return { $disconnect: vi.fn(async () => {}), $queryRawUnsafe: vi.fn(async () => []), firm: { findFirstOrThrow: vi.fn(async () => { throw new Error("stop: fake db"); }) } };
    }),
  }));
  vi.doMock("@/lib/demo/seed", () => ({
    seedDemo: vi.fn(async () => { calls.push("seedDemo (truncateAll)"); }),
    liveUploadFile: vi.fn(async () => ({ fileName: "fiktif.csv", data: "" })),
  }));
  vi.doMock("@/lib/demo/admin", () => ({ seedDemoAdmin: vi.fn(async () => { calls.push("seedDemoAdmin (Auth write)"); }) }));
  vi.doMock("node:fs", () => ({ writeFileSync: vi.fn(() => calls.push("writeFileSync")), mkdirSync: vi.fn(), readFileSync: vi.fn() }));
  vi.doMock("node:child_process", () => ({ execSync: vi.fn((cmd: string) => { calls.push(`execSync ${cmd}`); throw new Error("stop: after the guard"); }) }));
  vi.doMock("@/lib/auth/operator", () => ({ ensureLocalAdmin: vi.fn(() => calls.push("ensureLocalAdmin (Auth write)")) }));
  vi.doMock("@/lib/supabase/admin", () => ({ createSupabaseAdmin: vi.fn(() => calls.push("createSupabaseAdmin")) }));
  vi.doMock("@/lib/setup", () => ({ createClient: vi.fn(), createFirm: vi.fn() }));
  vi.doMock("@/lib/access/grant", () => ({ endOfDayJakarta: vi.fn() }));
}

beforeEach(() => {
  calls = [];
  errors = [];
  vi.resetModules();
  mockSideEffects();
  vi.spyOn(console, "error").mockImplementation((e: unknown) => { errors.push(e); });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => { calls.push(`process.exit ${code}`); }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const message = () => errors.map((e) => (e instanceof Error ? e.message : String(e))).join(" | ");

/** A refused entrypoint throws while it is imported: nothing after the guard import runs. */
async function refused(load: () => Promise<unknown>, names: RegExp) {
  const error = await load().then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(REFUSED);
  expect((error as Error).message).toMatch(names);
  expect((error as Error).message).not.toMatch(/invalid:|u:p@|fiktif/);
  await settle();
  expect(calls).toEqual([]);
}

describe("demo:reset (scripts/seed.ts)", () => {
  it("refuses a hosted pooled URL over a local DATABASE_URL at import: no client, truncate, seed or Auth write", async () => {
    env({ DATABASE_URL: LOCAL, POSTGRES_PRISMA_URL: HOSTED });
    await refused(() => import("../../scripts/seed"), /POSTGRES_PRISMA_URL\.$/);
  });

  it("refuses a ?host= override inside an otherwise local DATABASE_URL", async () => {
    env({ DATABASE_URL: "postgresql://u@localhost:5432/db?host=hosted.invalid" });
    await refused(() => import("../../scripts/seed"), /DATABASE_URL\.$/);
  });

  it("refuses a hosted Auth URL (the demo admin is written there)", async () => {
    env({ DATABASE_URL: LOCAL, NEXT_PUBLIC_SUPABASE_URL: "https://fiktif.invalid" });
    await refused(() => import("../../scripts/seed"), /NEXT_PUBLIC_SUPABASE_URL\.$/);
  });

  it("passes on loopback and reaches the (mocked) client, seed and Auth write", async () => {
    env({ DATABASE_URL: LOCAL, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" });
    await import("../../scripts/seed");
    await settle();
    expect(calls.slice(0, 3)).toEqual(["createPrisma", "seedDemo (truncateAll)", "seedDemoAdmin (Auth write)"]);
    expect(calls).not.toContain("process.exit 1");
  });
});

describe("E2E setup (scripts/e2e-setup.ts)", () => {
  it("refuses a hosted POSTGRES_URL before the reseed command or any client", async () => {
    env({ DATABASE_URL: LOCAL, POSTGRES_URL: HOSTED });
    await refused(() => import("../../scripts/e2e-setup"), /POSTGRES_URL\.$/);
  });

  it("refuses a hosted non-pooling URL too (scripts/vercel-build.sh sends seeds and migrations there)", async () => {
    env({ DATABASE_URL: LOCAL, POSTGRES_URL_NON_POOLING: HOSTED });
    await refused(() => import("../../scripts/e2e-setup"), /POSTGRES_URL_NON_POOLING\.$/);
  });

  it("refuses a hosted Auth URL before any Auth admin client or user write", async () => {
    env({ DATABASE_URL: LOCAL, NEXT_PUBLIC_SUPABASE_URL: "https://fiktif.invalid" });
    await refused(() => import("../../scripts/e2e-setup"), /NEXT_PUBLIC_SUPABASE_URL\.$/);
  });

  it("refuses a hosted app address even with a local database", async () => {
    env({ DATABASE_URL: LOCAL, BASE_URL: "https://hosted-app.invalid" });
    await import("../../scripts/e2e-setup");
    await settle();
    expect(calls).toEqual([]);
    expect(message()).toMatch(/E2E setup only accepts disposable localhost environments/);
  });

  it("passes on loopback: its first action is the reseed command", async () => {
    env({ DATABASE_URL: LOCAL, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" });
    await import("../../scripts/e2e-setup");
    await settle();
    expect(calls).toEqual(["execSync npx tsx scripts/seed.ts"]);
    expect(message()).toContain("stop: after the guard");
  });
});

describe("E2E table counts (scripts/e2e-table-counts.ts)", () => {
  it("refuses a hosted pooled URL before any client", async () => {
    env({ DATABASE_URL: LOCAL, POSTGRES_PRISMA_URL: HOSTED });
    await refused(() => import("../../scripts/e2e-table-counts"), /POSTGRES_PRISMA_URL\.$/);
  });

  it("passes on loopback", async () => {
    env({ DATABASE_URL: LOCAL });
    await import("../../scripts/e2e-table-counts");
    await settle();
    expect(calls).toEqual(["createPrisma"]);
    expect(process.exitCode).toBeUndefined();
  });
});

describe("DB test helper (tests/helpers.ts)", () => {
  it("refuses at import, before the shared client exists", async () => {
    env({ DATABASE_URL: LOCAL, POSTGRES_PRISMA_URL: HOSTED });
    await refused(() => import("../helpers"), /^DB tests refused: .*POSTGRES_PRISMA_URL\.$/);
  });

  it("builds the shared client on loopback", async () => {
    env({ DATABASE_URL: LOCAL });
    await import("../helpers");
    expect(calls).toEqual(["createPrisma"]);
  });
});

describe("Test migrations (tests/global-setup.ts)", () => {
  it("refuses a hosted TEST_DATABASE_URL before prisma migrate runs", async () => {
    env({ DATABASE_URL: LOCAL, TEST_DATABASE_URL: HOSTED });
    const { default: setup } = await import("../global-setup");
    expect(() => setup()).toThrow(/^Test migrations refused: .*DATABASE_URL\.$/);
    expect(calls).toEqual([]);
  });

  it("refuses a ?host= override in TEST_DATABASE_URL", async () => {
    env({ TEST_DATABASE_URL: "postgresql://buku:buku@localhost:5432/buku_test?host=hosted.invalid" });
    const { default: setup } = await import("../global-setup");
    expect(() => setup()).toThrow(REFUSED);
    expect(calls).toEqual([]);
  });

  it("migrates a local TEST_DATABASE_URL (the command is mocked)", async () => {
    env({ TEST_DATABASE_URL: LOCAL });
    const { default: setup } = await import("../global-setup");
    expect(() => setup()).toThrow("stop: after the guard");
    expect(calls).toEqual(["execSync npx prisma migrate deploy"]);
  });

  it("a shell holding hosted POSTGRES_* overrides still migrates the local test DB, and the overrides don't reach the child", async () => {
    env({ TEST_DATABASE_URL: LOCAL, POSTGRES_PRISMA_URL: HOSTED, POSTGRES_URL: HOSTED, POSTGRES_URL_NON_POOLING: HOSTED, DIRECT_URL: HOSTED });
    const { execSync } = await import("node:child_process");
    const { default: setup } = await import("../global-setup");
    expect(() => setup()).toThrow("stop: after the guard");
    const childEnv = (vi.mocked(execSync).mock.calls[0][1] as { env: Record<string, string> }).env;
    expect([childEnv.DATABASE_URL, childEnv.POSTGRES_PRISMA_URL, childEnv.POSTGRES_URL, childEnv.POSTGRES_URL_NON_POOLING, childEnv.DIRECT_URL]).toEqual([LOCAL, "", "", "", ""]);
  });

  it("refuses a hosted PGHOST before prisma migrate runs", async () => {
    env({ TEST_DATABASE_URL: LOCAL, PGHOST: "hosted.invalid" });
    const { default: setup } = await import("../global-setup");
    expect(() => setup()).toThrow(/^Test migrations refused: .*PGHOST\.$/);
    expect(calls).toEqual([]);
  });
});

describe("createPrisma (lib/db.ts) with the driver mocked", () => {
  it("hands the driver the resolved URL: the pooled override wins at runtime, by design", async () => {
    const urls: string[] = [];
    vi.doUnmock("@/lib/db");
    delete (globalThis as { prisma?: unknown }).prisma;
    vi.doMock("@prisma/adapter-pg", () => ({ PrismaPg: vi.fn(function (this: object, o: { connectionString: string }) { urls.push(o.connectionString); }) }));
    vi.doMock("@/lib/generated/prisma/client", () => ({ PrismaClient: vi.fn(function () { calls.push("new PrismaClient"); }) }));
    env({ DATABASE_URL: LOCAL, POSTGRES_PRISMA_URL: HOSTED });
    const { createPrisma } = await import("@/lib/db");
    createPrisma();
    expect(urls.every((u) => u === HOSTED)).toBe(true);
    expect(urls.length).toBeGreaterThan(0);
    delete (globalThis as { prisma?: unknown }).prisma;
  });
});
