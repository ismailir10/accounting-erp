import "dotenv/config";
import "../lib/local-database-only";
import { createPrisma } from "../lib/db";

/**
 * Row counts of every tenant table, as JSON on stdout, for e2e/support-session.spec.ts (Prisma is ESM, so the spec runs this through
 * tsx). Buku's own support log and the migrations table are left out. Localhost databases only, like scripts/e2e-setup.ts.
 */
const BUKU_LOG = new Set(["SupportSession", "SupportSessionView", "PlatformAuditEvent", "_prisma_migrations"]);

async function main() {
  const db = createPrisma();
  try {
    const tables = await db.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
    const counts: Record<string, number> = {};
    for (const { tablename } of tables) {
      if (BUKU_LOG.has(tablename)) continue;
      const [row] = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "${tablename}"`);
      counts[tablename] = Number(row.n);
    }
    process.stdout.write(JSON.stringify(counts));
  } finally { await db.$disconnect(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
