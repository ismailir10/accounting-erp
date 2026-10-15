import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Production keeps its members (FirmMember), the encrypted AI key and other settings (AppSetting), the firm and the Drive connection
 * across every release: each migration is applied to the real database. From 2026-09-30 a migration may add to these tables
 * (new columns, indexes, foreign keys) but never delete, rewrite, rename or drop what is in them.
 */
const PROTECTED = new Set(["firmmember", "appsetting", "firm", "driveconnection"]);
const FROM = "20260930000000";
const DIR = join(process.cwd(), "prisma", "migrations");

/** "public"."FirmMember" / "FirmMember" / firmmember → firmmember */
const ident = (raw: string) => raw.trim().replace(/"/g, "").replace(/^public\./i, "").replace(/[(),;]/g, "").toLowerCase();
const isProtected = (raw: string) => PROTECTED.has(ident(raw));
const list = (raw: string) => raw.split(",").map((t) => t.trim().split(/\s+/).filter((w) => !/^(if|exists|only|cascade|restrict|restart|continue|identity)$/i.test(w))[0] ?? "");

/** The destructive statements against a protected table in a migration's SQL; empty when the migration is safe. */
export function violations(sql: string): string[] {
  const out: string[] = [];
  const statements = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  for (const st of statements) {
    let m = st.match(/^DROP TABLE\s+(?:IF EXISTS\s+)?(.+)$/i);
    if (m && list(m[1]).some(isProtected)) out.push(`DROP TABLE: ${st}`);
    m = st.match(/^TRUNCATE\s+(?:TABLE\s+)?(.+)$/i);
    if (m && list(m[1]).some(isProtected)) out.push(`TRUNCATE: ${st}`);
    m = st.match(/^DELETE FROM\s+(?:ONLY\s+)?(\S+)/i);
    if (m && isProtected(m[1])) out.push(`DELETE FROM: ${st}`);
    m = st.match(/^UPDATE\s+(?:ONLY\s+)?(\S+)/i);
    if (m && isProtected(m[1])) out.push(`UPDATE: ${st}`);
    m = st.match(/^ALTER TABLE\s+(?:IF EXISTS\s+)?(?:ONLY\s+)?(\S+)\s+(.*)$/i);
    if (m && isProtected(m[1]) && /(?:^|,)\s*(?:DROP\b|ALTER\s+(?:COLUMN\s+)?["\w]+\s+(?:TYPE|SET|DROP)\b|ALTER\s+COLUMN\b|RENAME\b)/i.test(m[2])) out.push(`ALTER TABLE: ${st}`);
  }
  return out;
}

const files = readdirSync(DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name >= FROM)
  .map((d) => ({ name: d.name, sql: readFileSync(join(DIR, d.name, "migration.sql"), "utf8") }));

describe("migrations keep members, AI settings, firm and Drive connection intact", () => {
  it("scans every migration from the cut-off", () => {
    for (const f of files) expect(violations(f.sql), f.name).toEqual([]);
  });

  it.each([
    'DELETE FROM "AppSetting" WHERE 1=1;',
    'DELETE FROM ONLY "public"."AppSetting";',
    'TRUNCATE TABLE "Client", "FirmMember" CASCADE;',
    'TRUNCATE "Client"; TRUNCATE ONLY "Firm";',
    'DROP TABLE "FirmMember";',
    'DROP TABLE "Client", "FirmMember";',
    'DROP TABLE IF EXISTS "Client", "public"."AppSetting" CASCADE;',
    'UPDATE "AppSetting" SET "value" = \'\';',
    'UPDATE ONLY "FirmMember" SET "role" = \'ADMIN\';',
    'ALTER TABLE "FirmMember" DROP COLUMN "email";',
    'ALTER TABLE IF EXISTS "FirmMember" DROP COLUMN "email";',
    'ALTER TABLE ONLY "FirmMember" DROP CONSTRAINT "x";',
    'ALTER TABLE "FirmMember" ADD COLUMN "a" TEXT, DROP COLUMN "email";',
    'ALTER TABLE "FirmMember" ALTER COLUMN "email" TYPE TEXT;',
    'ALTER TABLE "Firm" RENAME TO "Kantor";',
    'ALTER TABLE "AppSetting" RENAME COLUMN "value" TO "v";',
  ])("refuses: %s", (sql) => {
    expect(violations(sql)).not.toEqual([]);
  });

  it.each([
    'ALTER TABLE "Entity" ADD COLUMN "x" TEXT;',
    'ALTER TABLE "Entity" DROP COLUMN "x";',
    'DROP TABLE "PeriodUnlockLog";',
    'DELETE FROM "PeriodUnlockLog";',
    'ALTER TABLE "PeriodUnlockLog" ADD CONSTRAINT "f" FOREIGN KEY ("a") REFERENCES "FirmMember"("id") ON DELETE RESTRICT;',
    'ALTER TABLE "FirmMember" ADD COLUMN "note" TEXT;',
    'ALTER TABLE IF EXISTS "FirmMember" ADD CONSTRAINT "c" CHECK ("role" IN (\'ADMIN\'));',
    'CREATE INDEX "i" ON "FirmMember"("email");',
    '-- DELETE FROM "AppSetting"\nSELECT 1;',
  ])("allows: %s", (sql) => {
    expect(violations(sql)).toEqual([]);
  });
});
