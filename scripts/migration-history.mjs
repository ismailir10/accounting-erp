// Read-only: compares the migrations a database records as applied with prisma/migrations. Plain Node + pg, no compile step, so the
// production build can run it (scripts/db-drift.sh). Pending and failed migrations are `prisma migrate status`'s job; this catches what
// it reads as "up to date": an applied migration the repo doesn't have, and a migration file edited after it was applied.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {{ name: string, checksum: string, rolledBack: boolean }[]} applied rows of `_prisma_migrations`
 * @param {Map<string, string>} local migration folder name → SHA-256 of its migration.sql
 * @returns {string[]} one line per difference; empty when the history matches
 */
export function compareHistory(applied, local) {
  const problems = [];
  for (const row of applied) {
    if (row.rolledBack) continue;
    const sum = local.get(row.name);
    if (sum === undefined) problems.push(`applied in the database but not in prisma/migrations: ${row.name}`);
    else if (sum !== row.checksum) problems.push(`migration.sql changed after it was applied: ${row.name}`);
  }
  return problems;
}

/** Folder name → SHA-256 (hex) of its migration.sql, the value Prisma stores in `_prisma_migrations.checksum`. */
export function localMigrations(dir) {
  const sums = new Map();
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name, "migration.sql");
    if (existsSync(file)) sums.set(name, createHash("sha256").update(readFileSync(file)).digest("hex"));
  }
  return sums;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let rows;
  try {
    await client.query("BEGIN READ ONLY");
    ({ rows } = await client.query(
      `SELECT migration_name AS name, checksum, rolled_back_at IS NOT NULL AS "rolledBack" FROM "_prisma_migrations" ORDER BY migration_name`,
    ));
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const problems = compareHistory(rows, localMigrations(path.join(root, "prisma/migrations")));
  if (problems.length) {
    console.error(`✗ Migration history drift (${problems.length}):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(2);
  }
  console.log(`✓ Migration history matches prisma/migrations (${rows.filter((r) => !r.rolledBack).length} applied).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // The message only: a connection error can carry the host, never print the URL itself.
    console.error(`✗ Migration history check failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
