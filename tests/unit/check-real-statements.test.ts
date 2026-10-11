import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bniWondrPdf, brimoPdf, mandiriEstatementPdf, smbcCombinedPdf } from "../pdf-fixture";

const directories: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "buku-statement-check-"));
  directories.push(path);
  return path;
};
const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/check-real-statements.ts"), ...args], {
  encoding: "utf8",
  env: { ...process.env, DATABASE_URL: "postgresql://unavailable:unavailable@127.0.0.1:1/unavailable", AI_API_KEY: "" },
});
const records = (stdout: string) => stdout.trim().split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
afterEach(() => {
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe("local statement directory check CLI", () => {
  it("prints source metadata for all three synthetic layouts with the correct password", () => {
    const path = directory();
    writeFileSync(join(path, "brimo.pdf"), brimoPdf());
    writeFileSync(join(path, "mandiri.pdf"), mandiriEstatementPdf());
    writeFileSync(join(path, "wondr.pdf"), bniWondrPdf());
    mkdirSync(join(path, "subdirectory"));
    const result = run(path, "--password", "synthetic-password");
    expect(result.status, result.stderr).toBe(0);
    const output = records(result.stdout);
    expect(output).toHaveLength(3);
    expect(output.map((record) => [record.file, record.format, record.accountNumber, record.holder, record.currency, record.rows, record.error])).toEqual([
      ["brimo.pdf", "BRI", "123401000012345", "BUDI CONTOH", "IDR", 6, null],
      ["mandiri.pdf", "MANDIRI", "1110001234567", "BUDI CONTOH", "IDR", 9, null],
      ["wondr.pdf", "BNI", "8311100000", "BUDI CONTOH", "IDR", 6, null],
    ]);
    expect(output[0]).toMatchObject({ section: { index: 1, label: null }, period: { start: "2026-01-01", end: "2026-01-31", provenance: "DECLARED" }, opening: { value: "57400000", provenance: "PRINTED" }, closing: { value: "47400000", provenance: "PRINTED" }, continuity: "ok" });
    expect(result.stdout).not.toContain("synthetic-password");
  });
  it.each([{ options: [] }, { options: ["--password", "wrong"] }])("reports password errors without aborting later files (options=$options)", ({ options }) => {
    const path = directory();
    writeFileSync(join(path, "a-password.pdf"), mandiriEstatementPdf());
    writeFileSync(join(path, "b-brimo.pdf"), brimoPdf());
    const result = run(path, ...options);
    expect(result.status).toBe(1);
    const output = records(result.stdout);
    expect(output).toHaveLength(2);
    expect(output[0].error).toMatch(options.length ? /kata sandi PDF salah/i : /dikunci kata sandi/i);
    expect(output[1]).toMatchObject({ format: "BRI", rows: 6, error: null });
  });
  it("tries the password only on files that are locked", async () => {
    const path = directory();
    // Encrypted for permissions only, like many bank PDFs: opens without a password, refuses a wrong one.
    writeFileSync(join(path, "a-open.pdf"), brimoPdf({ userPassword: "" }));
    writeFileSync(join(path, "b-locked.pdf"), mandiriEstatementPdf());
    const result = run(path, "--password", "synthetic-password");
    expect(result.status, result.stdout).toBe(0);
    expect(records(result.stdout).map((record) => [record.file, record.format, record.error])).toEqual([
      ["a-open.pdf", "BRI", null],
      ["b-locked.pdf", "MANDIRI", null],
    ]);
  });
  it("prints every SMBC section including its unsupported-currency error", () => {
    const path = directory();
    writeFileSync(join(path, "smbc.pdf"), smbcCombinedPdf({ holder: "PT INDUK CONTOH", sectionHolders: ["PT REKENING SATU"] }));
    const result = run(path);
    expect(result.status).toBe(1);
    const output = records(result.stdout);
    expect(output.map((record) => [record.section.index, record.accountNumber, record.holder, record.currency, record.rows])).toEqual([
      [1, "90022152088", "PT REKENING SATU", "IDR", 2],
      [2, "05243002879", "PT INDUK CONTOH", "IDR", 2],
      [3, "90022164251", "PT INDUK CONTOH", "JPY", 0],
    ]);
    expect(output[2].error).toMatch(/JPY/);
  });
  it("continues after an unreadable file and keeps large balances exact", () => {
    const path = directory();
    writeFileSync(join(path, "a-corrupt.csv"), "not a bank statement");
    writeFileSync(join(path, "b-large.csv"), [
      "Periode: 01/01/2026 - 31/01/2026",
      "Saldo Awal: 90071992547409931",
      "Saldo Akhir: 90071992547410031",
      "Tanggal,Keterangan,Jumlah,Saldo",
      "13/01/2026,Transfer sintetis,100,90071992547410031",
    ].join("\n"));
    const result = run(path);
    expect(result.status).toBe(1);
    const output = records(result.stdout);
    expect(output).toHaveLength(2);
    expect(output[0]).toMatchObject({ file: "a-corrupt.csv", format: null, rows: null });
    expect(output[0].error).toBeTypeOf("string");
    expect(output[1]).toMatchObject({ opening: { value: "90071992547409931" }, closing: { value: "90071992547410031" }, rows: 1, error: null });
  });
  it("reports a continuity break apart from errors, since the import only flags it", () => {
    const path = directory();
    writeFileSync(join(path, "brimo.pdf"), brimoPdf({ closing: "48,400,000.00" }));
    const result = run(path);
    expect(result.status).toBe(0);
    expect(records(result.stdout)[0]).toMatchObject({ closing: { value: "48400000", provenance: "PRINTED" }, continuity: expect.stringMatching(/saldo akhir/i), error: null });
  });
  it.each([[], ["https://example.com/statements"], ["/missing-directory"], ["--password", "secret"], [".", "--password"], [".", "--unknown", "secret"], [".", "--password", "secret", "extra"]].map((args) => ({ args })))("rejects invalid arguments or directories $args without reading remote files", ({ args }) => {
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toBeTruthy();
    expect(records(result.stdout)).toEqual([]);
  });
  it("rejects a file where a directory is required", () => {
    const path = directory();
    const file = join(path, "statement.pdf");
    writeFileSync(file, brimoPdf());
    const result = run(file);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/directory/i);
  });
});
