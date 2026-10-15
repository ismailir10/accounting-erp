import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import pg from "pg";
import { db, makeGroup, resetDb } from "../helpers";
import { importSourceAccounts, postImport, stageImport } from "@/lib/ledger-import/post";
import { acceptMappings, suggestMappings } from "@/lib/ledger-import/mapping";

// One ledger file posts its journals once, however many calls race to post it: a double click, two tabs, or the same file staged
// twice from Unggah and Dokumen. Each call reads the draft as DRAFT before it writes, so the check must hold inside the write.
//
// The race is made deterministic: a holder session row-locks the draft(s) FOR NO KEY UPDATE, which lets the journal inserts through
// (their foreign-key checks take KEY SHARE) and blocks only the final status write. The hold is released only once both posting
// calls are blocked in the database, so without the per-file lock both calls have passed their checks and inserted their journals.
type G = Awaited<ReturnType<typeof makeGroup>>;
let g: G;

async function ledgerFile() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("GL");
  ws.addRow(["Entity", "Entry Date", "Account Code", "Account Name", "Debit", "Credit"]);
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(2026, 2, 1 + i));
    ws.addRow(["PT Uji", d, "10000", "Kas", 1000 + i, 0]);
    ws.addRow(["PT Uji", d, "40000", "Pendapatan Jasa", 0, 1000 + i]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function stage(data: Buffer) {
  const st = await stageImport(db, { firmId: g.firm.id, clientId: g.client.id, fileName: "gl.xlsx", data });
  if (st.status !== "STAGED") throw new Error(`not staged: ${st.status}`);
  await suggestMappings(db, { firmId: g.firm.id, clientId: g.client.id, provider: null, useAi: false });
  const src = await importSourceAccounts(db, st.importId);
  await acceptMappings(db, g.client.id, src.map((x) => ({ sourceAccountId: x.id, accountCode: x.suggestedCode!, method: x.suggestedBy! })));
  return st.importId;
}

async function booked() {
  const lines = await db.journalLine.aggregate({ where: { entry: { ledgerImportId: { not: null } }, entityId: g.pt.entity.id }, _sum: { debit: true }, _count: true });
  return { debit: lines._sum.debit ?? 0n, entries: await db.journalEntry.count({ where: { ledgerImportId: { not: null } } }) };
}

const ONCE = Array.from({ length: 12 }, (_, i) => BigInt(1000 + i)).reduce((a, b) => a + b, 0n);

/** Starts both posts while the draft rows are held, waits until both are blocked in the database, then releases the hold. */
async function postBothWhileHeld(heldIds: string[], posts: [string, string]) {
  const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  try {
    const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    await holder.query("BEGIN");
    await holder.query(`SELECT id FROM "LedgerImport" WHERE id = ANY($1) FOR NO KEY UPDATE`, [heldIds]);
    const running = Promise.allSettled(posts.map((id) => postImport(db, g.client.id, id)));
    const deadline = Date.now() + 20_000;
    let blocked = 0;
    while (blocked < 2 && Date.now() < deadline) {
      // The holder polls inside its own transaction, where backend status is a cached snapshot: refresh it on every poll.
      await holder.query("SELECT pg_stat_clear_snapshot()");
      const r = await holder.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> $1 AND cardinality(pg_blocking_pids(pid)) > 0`,
        [holderPid],
      );
      blocked = r.rows[0].n;
      if (blocked < 2) await new Promise((res) => setTimeout(res, 25));
    }
    if (blocked < 2) await holder.query("SELECT pg_stat_clear_snapshot()");
    const seen = blocked < 2
      ? (await holder.query(`SELECT state, wait_event_type, wait_event, left(query, 70) AS q FROM pg_stat_activity WHERE datname = current_database() AND pid <> $1 AND backend_type = 'client backend'`, [holderPid])).rows
      : [];
    // Never leave the posts running into the next test: release the hold and let both settle before reporting anything.
    await holder.query("COMMIT");
    const results = await running;
    if (blocked < 2) throw new Error(`only ${blocked} of 2 posting calls reached the barrier: ${JSON.stringify(seen)} results ${JSON.stringify(results.map((r) => r.status))}`);
    return results;
  } finally {
    await holder.end();
  }
}

describe("posting a ledger import concurrently", () => {
  beforeEach(async () => {
    await resetDb();
    g = await makeGroup();
  });

  it("the same draft posted by two calls at once books its journals once", async () => {
    const id = await stage(await ledgerFile());
    const results = await postBothWhileHeld([id], [id, id]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message)).toBe("Impor ini sudah dicatat.");
    expect(await booked()).toEqual({ debit: ONCE, entries: 12 });
    expect(await db.ledgerImport.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "POSTED", groupCount: 12 });
  });

  it("two drafts of the same file posted at once book the file once", async () => {
    const data = await ledgerFile();
    const [a, b] = [await stage(data), await stage(data)];
    const results = await postBothWhileHeld([a, b], [a, b]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message)).toBe("Sheet ini sudah diimpor.");
    expect(await booked()).toEqual({ debit: ONCE, entries: 12 });
    expect((await db.ledgerImport.findMany({ where: { clientId: g.client.id } })).map((i) => i.status).sort()).toEqual(["DRAFT", "POSTED"]);
  });

  it("a draft posted after its twin is refused, and the sequential path is unchanged", async () => {
    const data = await ledgerFile();
    const [a, b] = [await stage(data), await stage(data)];
    await expect(postImport(db, g.client.id, a)).resolves.toEqual({ entries: 12 });
    await expect(postImport(db, g.client.id, b)).rejects.toThrow("Sheet ini sudah diimpor.");
    await expect(postImport(db, g.client.id, a)).rejects.toThrow("Impor ini sudah dicatat.");
    expect(await booked()).toEqual({ debit: ONCE, entries: 12 });
  });
});
