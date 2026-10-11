import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseStatementSections } from "@/lib/import/parsers";
import { PdfPasswordError } from "@/lib/import/parsers/pdf";
import { checkContinuity } from "@/lib/import/normalize";

/** Local-only metadata check. Files stay on disk; no database, model or network calls.
 * `error` means the import would refuse the file or section; a running-balance break, which the import only
 * flags, is reported as `continuity`. The password is tried only on files that say they are locked. */
async function main() {
  const args = process.argv.slice(2);
  const directory = args[0];
  if (!directory || directory.startsWith("--") || ![1, 3].includes(args.length) || (args.length === 3 && args[1] !== "--password")) {
    throw new Error("Usage: npx tsx scripts/check-real-statements.ts <dir> [--password X]");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(directory)) throw new Error("The directory must be a local path, not a URL.");
  if (!(await stat(directory)).isDirectory()) throw new Error("The path must be a directory.");
  const password = args[2];
  const files = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name));
  for (const file of files) {
    try {
      const data = await readFile(join(directory, file.name));
      const sections = await parseStatementSections(file.name, data).catch((error: unknown) => {
        if (password && error instanceof PdfPasswordError && error.reason === "needed") return parseStatementSections(file.name, data, { password });
        throw error;
      });
      for (const [index, statement] of sections.entries()) {
        const continuity = checkContinuity(statement);
        const error = statement.error ?? null;
        console.log(JSON.stringify({
          file: file.name,
          section: { index: index + 1, label: statement.section?.label ?? null },
          format: statement.format,
          accountNumber: statement.accountNumber,
          holder: statement.holder ?? null,
          currency: statement.currency ?? null,
          period: { start: statement.periodStart.toISOString().slice(0, 10), end: statement.periodEnd.toISOString().slice(0, 10), provenance: statement.provenance?.period ?? null },
          opening: { value: statement.openingBalance.toString(), provenance: statement.provenance?.opening ?? null },
          closing: { value: statement.closingBalance.toString(), provenance: statement.provenance?.closing ?? null },
          rows: statement.rows.length,
          continuity: continuity.ok ? "ok" : continuity.note,
          error,
        }));
        if (error) process.exitCode = 1;
      }
    } catch (error) {
      console.log(JSON.stringify({ file: file.name, section: null, format: null, accountNumber: null, holder: null, currency: null, period: null, opening: null, closing: null, rows: null, continuity: null, error: error instanceof Error ? error.message : String(error) }));
      process.exitCode = 1;
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
