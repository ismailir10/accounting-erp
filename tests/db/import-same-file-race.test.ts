import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import type { Db } from "@/lib/db";
import { importStatement } from "@/lib/import/pipeline";
import { checkFile } from "@/lib/inbox/check";
import { processNext } from "@/lib/inbox/process";
import { toBcaCsv } from "@/lib/demo/writers";

const d = (day: number) => new Date(Date.UTC(2026, 8, day));
type Row = { date: Date; description: string; amount: bigint };
// Fictional statement of PT Uji's BCA Giro, September 2026 (the writer chains the balances).
const SEP: Row[] = [
  { date: d(3), description: "SETORAN TUNAI CV KABUT PAGI", amount: 750_000n },
  { date: d(8), description: "PEMBELIAN PAKAN UD SAWAH HIJAU", amount: -300_000n },
  { date: d(11), description: "BIAYA ADMIN", amount: -15_000n },
];
const csv = (rows: Row[], holder = "PT Uji Sejahtera") => Buffer.from(toBcaCsv({ bank: "BCA", accountNumber: "1111111111", holder, year: 2026, month: 9, opening: 2_000_000n, rows }));
const file = csv(SEP);
/** The same lines in other bytes (another holder line): another file, not the same one. */
const sameRowsOtherBytes = csv(SEP, "PT Uji Sejahtera Cetak");
/** `file` plus one more line: overlaps it in part. */
const overlapping = csv([...SEP, { date: d(12), description: "SETORAN TUNAI CV KABUT PAGI", amount: 100_000n }]);

const RETRY = /baru saja menerima impor lain\. Ulangi impor/;

/**
 * A client whose imports all pause after their dedupe snapshot (at the rules read, before the write transaction) until `expected` of
 * them have taken it: both then race for the account lock. No sleeps, no AI.
 */
function paused(expected: number) {
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const client = db.$extends({ query: { rule: { async findMany({ args, query }) {
    const rows = await query(args);
    if (++arrivals === expected) release();
    await gate;
    return rows;
  } } } }) as unknown as Db;
  return { client, arrivals: () => arrivals };
}

async function booked(bankAccountId: string) {
  const rows = await db.bankTransaction.findMany({ where: { bankAccountId }, include: { entries: { include: { lines: true } } } });
  const entries = rows.flatMap((r) => r.entries);
  for (const e of entries) expect(e.lines.reduce((s, l) => s + l.debit - l.credit, 0n)).toBe(0n);
  return { rows: rows.length, entries: entries.length };
}

beforeEach(async () => {
  vi.stubEnv("SETTINGS_SECRET", "import-same-file-race-secret-32-characters");
  await resetDb();
});
afterEach(() => vi.unstubAllEnvs());

describe("two imports of one statement at the same time", () => {
  it("books the bytes once and answers the second with the import already on file", async () => {
    const g = await makeGroup();
    const bankAccountId = g.pt.banks[0].id;
    const { client, arrivals } = paused(2);
    const results = await Promise.allSettled([1, 2].map(() => importStatement(client, { bankAccountId, fileName: "bca-sep.csv", data: file, provider: null })));
    expect(arrivals()).toBe(2);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const [a, b] = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof importStatement>>>).value);
    expect(a.importId).toBe(b.importId);
    const second = a.duplicates === a.rows ? a : b;
    expect(second).toMatchObject({ rows: 3, duplicates: 3, posted: 0, needsReview: 0 });
    expect(await db.statementImport.count()).toBe(1);
    expect(await booked(bankAccountId)).toEqual({ rows: 3, entries: 3 });
    // As a re-import after the race: the same answer, nothing new.
    const again = await importStatement(db, { bankAccountId, fileName: "bca-sep.csv", data: file, provider: null });
    expect(again).toMatchObject({ importId: a.importId, duplicates: 3, posted: 0 });
    expect(await db.statementImport.count()).toBe(1);
  });

  it("links the second copy of an evidence file to its own empty import, as a re-import would", async () => {
    const g = await makeGroup();
    const bankAccountId = g.pt.banks[0].id;
    const { client } = paused(2);
    const results = await Promise.allSettled([1, 2].map(() => importStatement(client, { bankAccountId, fileName: "bca-sep.csv", data: file, provider: null, evidenceVersionId: "ev-fiktif-1" })));
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const imports = await db.statementImport.findMany({ orderBy: { duplicateCount: "asc" }, include: { _count: { select: { transactions: true } } } });
    expect(imports.map((i) => [i.evidenceVersionId, i.rowCount, i.duplicateCount, i._count.transactions])).toEqual([["ev-fiktif-1", 3, 0, 3], ["ev-fiktif-1", 3, 3, 0]]);
    expect(await booked(bankAccountId)).toEqual({ rows: 3, entries: 3 });
  });

  it("books a file dropped twice in Unggah once and marks both lines booked", async () => {
    const g = await makeGroup();
    const scope = { firmId: g.firm.id, clientId: g.client.id, batchId: "b-fiktif" };
    for (const name of ["bca-sep.csv", "bca-sep (1).csv"]) await checkFile(db, { ...scope, name, data: file });
    const { client } = paused(2);
    const results = await Promise.all([1, 2].map(() => processNext(client, { ...scope, actorId: null, provider: null })));
    expect(results.map((r) => r.item?.status)).toEqual(["BOOKED", "BOOKED"]);
    expect(results.map((r) => r.item?.message).sort()).toEqual([expect.stringMatching(/^Dibukukan ke /), expect.stringMatching(/^Sudah dibukukan sebelumnya ke /)]);
    expect(await booked(g.pt.banks[0].id)).toEqual({ rows: 3, entries: 3 });
  });

  it.each([
    ["the same lines in other bytes", sameRowsOtherBytes],
    ["a file that overlaps in part", overlapping],
  ])("still asks to retry when the other import was %s", async (_, other) => {
    const g = await makeGroup();
    const bankAccountId = g.pt.banks[0].id;
    const { client } = paused(2);
    const results = await Promise.allSettled([file, other].map((data, i) => importStatement(client, { bankAccountId, fileName: `bca-sep-${i}.csv`, data, provider: null })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused?.reason.message).toMatch(RETRY);
    expect(await db.statementImport.count()).toBe(1);
    const won = results.findIndex((r) => r.status === "fulfilled");
    const lines = other === overlapping ? 4 : 3;
    // Only the winner's lines are booked, once.
    expect((await booked(bankAccountId)).rows).toBe(won === 0 ? 3 : lines);
    // The retry then decides as a sequential import does (rows of the other file recognised, or the new line booked).
    await importStatement(db, { bankAccountId, fileName: "retry.csv", data: [file, other][1 - won], provider: null });
    expect(await booked(bankAccountId)).toEqual({ rows: lines, entries: lines });
  });
});
