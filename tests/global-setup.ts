import { execSync } from "node:child_process";
import { assertLoopbackDatabase } from "../lib/db-url";

/**
 * Apply migrations to the throwaway test database once per run — only after the URL it migrates is proved local. prisma migrate reads
 * DATABASE_URL (prisma.config.ts), so that and the libpq variables are what is checked; the POSTGRES_* / DIRECT_URL overrides are
 * blanked for the child (and for the test workers in vitest.config.ts), so a shell holding them neither redirects nor blocks the run.
 */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://buku:buku@localhost:5432/buku_test";
  const { PGHOST, PGHOSTADDR, PGSERVICE, PGSERVICEFILE } = process.env;
  assertLoopbackDatabase({ DATABASE_URL: url, PGHOST, PGHOSTADDR, PGSERVICE, PGSERVICEFILE }, "Test migrations");
  const env = { ...process.env, DATABASE_URL: url, POSTGRES_PRISMA_URL: "", POSTGRES_URL: "", POSTGRES_URL_NON_POOLING: "", DIRECT_URL: "" };
  execSync("npx prisma migrate deploy", { env, stdio: "pipe" });
}
