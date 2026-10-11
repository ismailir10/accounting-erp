import { ParseError, SourceAmountError, SourceCurrencyError, SourceDateError, ScanError, StatementRepairError, UnreadableFileError, YearNeededError, type ParsedStatement } from "@/lib/import/types";
import { PdfPasswordError } from "@/lib/import/parsers/pdf";
import { readGrid } from "@/lib/import/grid";
import { readWithLayout, type RememberedLayout } from "@/lib/import/mapped";
import { sniffImageFile } from "@/lib/ocr/pages";
import { isBcaCsv, isBcaIndividualCsv, parseBca, parseBcaIndividual } from "@/lib/import/parsers/bca";
import { isBriCsv, parseBri } from "@/lib/import/parsers/bri";
import { parseTabular, parseWorkbook, xlsxToSheets } from "@/lib/import/parsers/tabular";
import { decodeText, detectDelimiter, readCsv } from "@/lib/import/parsers/common";
import { parsePdfSections } from "@/lib/import/parsers/pdf";
import { isMt940, parseMt940 } from "@/lib/import/parsers/mt940";
import { readableXlsx, sniffFile } from "@/lib/import/workbook";
import { repairStatement } from "@/lib/import/normalize";

export type ParseOptions = {
  /** Used once to open a PDF; never stored. */
  password?: string;
  /** Year of the first month, for files whose dates have none (the accountant's answer to `YearNeededError`). */
  year?: number;
  /** The firm's *Atur kolom* layouts: tried only when every reader refuses the file. */
  layouts?: RememberedLayout[];
};

/** Detect the bank format from content (not the file name) and parse; the first statement of the file. */
export async function parseStatement(fileName: string, data: Buffer, opts: ParseOptions = {}): Promise<ParsedStatement> {
  return (await parseStatementSections(fileName, data, opts))[0];
}

/**
 * Every statement in the file: combined PDFs and workbooks with several accounts hold one per account. Each is repaired against its own
 * running balance (`repairStatement`, rule 12), so every reader — the import, Dokumen — sees the same rows.
 */
export async function parseStatementSections(fileName: string, data: Buffer, opts: ParseOptions = {}): Promise<ParsedStatement[]> {
  const kind = sniffImageFile(data);
  if (kind === "PNG" || kind === "JPEG") throw new ScanError("File ini gambar (foto atau scan) rekening koran, bukan file dengan teks. Minta e-statement atau ekspor CSV/Excel dari internet banking.");
  let read = false;
  try {
    const sections = await parseAny(fileName, data, opts);
    read = true;
    // One account's refusal (a year it can't hold) doesn't refuse the file's other accounts: it travels on its own section.
    return sections.map((st) => {
      try {
        return repairStatement(st);
      } catch (e) {
        if (sections.length === 1 || !(e instanceof ParseError)) throw e;
        return { ...st, error: e.message };
      }
    });
  } catch (e) {
    // A password, a missing year or a scan is the accountant's to answer: no layout can help.
    if (e instanceof PdfPasswordError || e instanceof YearNeededError || e instanceof ScanError || e instanceof SourceAmountError || e instanceof SourceCurrencyError || e instanceof SourceDateError) throw e;
    const message = e instanceof ParseError ? e.message : `File tidak bisa dibaca: ${(e as Error).message}`;
    const remembered = opts.layouts?.length ? await rememberedRead(fileName, data, opts) : null;
    if (remembered) return [remembered];
    throw read ? new StatementRepairError(message) : new UnreadableFileError(message);
  }
}

/** The file read with a layout the firm mapped before (its header matches), repaired like any statement; null when none matches. */
async function rememberedRead(fileName: string, data: Buffer, opts: ParseOptions): Promise<ParsedStatement | null> {
  let grid;
  try {
    grid = await readGrid(data, { password: opts.password });
  } catch {
    return null;
  }
  const st = readWithLayout(grid, opts.layouts!, { fileName, year: opts.year });
  return st && repairStatement(st);
}

async function parseAny(fileName: string, data: Buffer, opts: ParseOptions): Promise<ParsedStatement[]> {
  if (sniffFile(data) === "PDF") return parsePdfSections(data, opts);
  const xlsx = await readableXlsx(data);
  if (xlsx) return parseWorkbook(await xlsxToSheets(xlsx), { year: opts.year, fileName });
  const text = decodeText(data);
  if (isMt940(text)) return parseMt940(text);
  const generic = () => {
    const { cursor: _cursor, verdict: _verdict, ...st } = parseTabular(readCsv(text, detectDelimiter(text)), "GENERIC", { year: opts.year, fileName });
    void _cursor;
    void _verdict;
    return [st];
  };
  const specific = isBcaCsv(text) ? () => [parseBca(text)] : isBcaIndividualCsv(text) ? () => [parseBcaIndividual(text)] : isBriCsv(text) ? () => [parseBri(text)] : null;
  if (!specific) return generic();
  try {
    return specific();
  } catch (e) {
    // A file that only looks like BCA's / BRI's may still be a plain table: try the generic reader, keep this error if it can't either.
    if (!(e instanceof ParseError) || e instanceof SourceAmountError || e instanceof SourceCurrencyError || e instanceof SourceDateError) throw e;
    try {
      return generic();
    } catch (g) {
      throw g instanceof YearNeededError ? g : e;
    }
  }
}
