import { execSync, spawnSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertLoopbackDatabase } from "@/lib/db-url";

// The real scripts/db-drift.sh against a throwaway database next to buku_test, migrated from this checkout. It proves the check is
// clean on a correctly migrated database (no false positive that would block a production build) and refuses each kind of drift.
const root = path.resolve(__dirname, "../..");
const testUrl = process.env.TEST_DATABASE_URL ?? "postgresql://buku:buku@localhost:5432/buku_test";
const NAME = "buku_drift_check";
const url = testUrl.replace(/\/[^/?]+(\?|$)/, `/${NAME}$1`);
const childEnv = { ...process.env, DATABASE_URL: url, POSTGRES_PRISMA_URL: "", POSTGRES_URL: "", POSTGRES_URL_NON_POOLING: "", DIRECT_URL: "" };

async function admin(sql: string) {
  const c = new pg.Client({ connectionString: testUrl });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}
async function onCopy(sql: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}
const drift = () => spawnSync("bash", ["scripts/db-drift.sh"], { cwd: root, env: childEnv, encoding: "utf8" });

beforeAll(async () => {
  assertLoopbackDatabase({ DATABASE_URL: url }, "Drift-check test database");
  await admin(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin(`CREATE DATABASE ${NAME}`);
  execSync("npx prisma migrate deploy", { cwd: root, env: childEnv, stdio: "pipe" });
}, 120_000);
afterAll(async () => {
  await admin(`DROP DATABASE IF EXISTS ${NAME}`);
});

describe("db-drift.sh on a real database", () => {
  it("a database migrated from this checkout passes both checks", () => {
    const r = drift();
    expect(r.stderr).not.toMatch(/✗/);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Migration history matches/);
    expect(r.stdout).toMatch(/tables match prisma\/schema\.prisma/);
  }, 60_000);

  it("a column added by hand fails the schema check and names the table", async () => {
    await onCopy(`ALTER TABLE "Client" ADD COLUMN "byHand" text`);
    try {
      const r = drift();
      expect(r.status).toBe(2);
      expect(r.stdout).toMatch(/Client/);
      expect(r.stderr).toMatch(/differ from prisma\/schema\.prisma/);
    } finally {
      await onCopy(`ALTER TABLE "Client" DROP COLUMN "byHand"`);
    }
  }, 60_000);

  it("an edited migration and an unknown applied migration fail the history check before the schema is compared", async () => {
    await onCopy(`UPDATE "_prisma_migrations" SET checksum = repeat('0', 64) WHERE migration_name = (SELECT min(migration_name) FROM "_prisma_migrations")`);
    await onCopy(
      `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count) VALUES ('drift-test', repeat('1', 64), '20991231000000_from_a_branch', now(), now(), 1)`,
    );
    const r = drift();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/changed after it was applied: \d+_init/);
    expect(r.stderr).toMatch(/not in prisma\/migrations: 20991231000000_from_a_branch/);
    expect(r.stdout).not.toMatch(/tables match/);
  }, 60_000);
});
