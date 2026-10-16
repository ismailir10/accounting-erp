import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without type declarations (it must run on the build machine without a compile step)
import { compareHistory, localMigrations } from "../../scripts/migration-history.mjs";

const local = new Map([
  ["20260101000000_init", "a".repeat(64)],
  ["20260201000000_next", "b".repeat(64)],
]);
const row = (name: string, checksum: string, rolledBack = false) => ({ name, checksum, rolledBack });

describe("compareHistory: what `prisma migrate status` reads as up to date", () => {
  it("a database that applied exactly the repo's migrations has no drift", () => {
    expect(compareHistory([row("20260101000000_init", "a".repeat(64)), row("20260201000000_next", "b".repeat(64))], local)).toEqual([]);
  });

  it("a migration still pending in the repo is not drift (migrate status fails the build for it)", () => {
    expect(compareHistory([row("20260101000000_init", "a".repeat(64))], local)).toEqual([]);
  });

  it("an applied migration the repo doesn't have is drift", () => {
    expect(compareHistory([row("20260101000000_init", "a".repeat(64)), row("20260301000000_from_a_branch", "c".repeat(64))], local)).toEqual([
      "applied in the database but not in prisma/migrations: 20260301000000_from_a_branch",
    ]);
  });

  it("a migration file edited after it was applied is drift", () => {
    expect(compareHistory([row("20260101000000_init", "f".repeat(64))], local)).toEqual([
      "migration.sql changed after it was applied: 20260101000000_init",
    ]);
  });

  it("a rolled-back attempt is ignored, whatever its name or checksum", () => {
    expect(compareHistory([row("20260301000000_gone", "c".repeat(64), true), row("20260101000000_init", "0".repeat(64), true)], local)).toEqual([]);
  });
});

describe("localMigrations reads the repo the way Prisma checksums it", () => {
  it("one SHA-256 of migration.sql per migration folder, and nothing for migration_lock.toml", () => {
    const dir = path.resolve(__dirname, "../../prisma/migrations");
    const sums = localMigrations(dir) as Map<string, string>;
    const folders = readdirSync(dir).filter((n) => !n.endsWith(".toml"));
    expect([...sums.keys()].sort()).toEqual(folders.sort());
    const first = folders.sort()[0];
    expect(sums.get(first)).toBe(createHash("sha256").update(readFileSync(path.join(dir, first, "migration.sql"))).digest("hex"));
  });
});
