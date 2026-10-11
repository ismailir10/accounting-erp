import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { MockProvider } from "@/lib/ai/provider";
import { importStatement } from "@/lib/import/pipeline";
import { postJournal } from "@/lib/ledger/post";
import { tradeBacking, UNBACKED_CONFIDENCE } from "@/lib/ai/unbacked";
import { simpleGuessRows, suggestForRows } from "@/lib/ai/retry";
import type { AiProvider } from "@/lib/ai/provider";
import { dateOnly } from "@/lib/format";

/** Review's old synchronous *Minta saran AI*, kept here to test the shared line update (the app now uses the background run). */
async function suggestAgainWithAi(_db: typeof db, args: { clientId: string; entityIds: string[]; through: Date; provider: AiProvider | null }) {
  const rows = await simpleGuessRows(_db, args);
  if (!rows.length) return { rows: 0, updated: 0, calls: 0, cacheHits: 0, note: undefined as string | undefined };
  const r = await suggestForRows(_db, { clientId: args.clientId, rows, provider: args.provider });
  return { rows: rows.length, updated: r.updated, calls: r.calls, cacheHits: r.cacheHits, note: r.notes[0] };
}

const accountId = async (clientId: string, code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId, code } } })).id;
const post = async (entityId: string, clientId: string, dr: string, cr: string, amount: bigint, date = dateOnly(2026, 7, 31)) =>
  db.$transaction(async (tx) => postJournal(tx, { entityId, date, kind: "ADJUSTMENT", memo: "uji", lines: [{ accountId: await accountId(clientId, dr), debit: amount }, { accountId: await accountId(clientId, cr), credit: amount }] }));

// A receipt from a customer and a payment to a supplier, nothing else.
const file = Buffer.from(["Tanggal;Keterangan;Debet;Kredit;Saldo", "01/08/2026;SALDO AWAL;;;10.000.000", "05/08/2026;TRSF MASUK PT PELANGGAN SETIA;;5.000.000;15.000.000", "06/08/2026;TRSF KELUAR CV PEMASOK ABADI;2.000.000;;13.000.000", ""].join("\n"));
const provider = () =>
  new MockProvider({
    "MASUK PT PELANGGAN SETIA": { accountCode: "1130", confidence: 0.85, taxTag: null, reason: "Pelunasan piutang usaha" },
    "KELUAR CV PEMASOK ABADI": { accountCode: "2110", confidence: 0.88, taxTag: null, reason: "Pembayaran utang usaha" },
  });

describe("an AI receivable or payable with nothing on the books to settle", () => {
  beforeEach(resetDb);

  it("is kept as a suggestion but below the bulk accept, with the reason said", async () => {
    const g = await makeGroup();
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "agu.csv", data: file, provider: provider() });
    const lines = await db.bankTransaction.findMany({ where: { bankAccountId: g.pt.banks[0].id }, orderBy: { rowNumber: "asc" } });
    expect(lines.map((l) => [l.status, l.method, l.suggestedCode, l.confidence])).toEqual([
      ["NEEDS_REVIEW", "AI", "1130", UNBACKED_CONFIDENCE],
      ["NEEDS_REVIEW", "AI", "2110", UNBACKED_CONFIDENCE],
    ]);
    expect(lines[0].reason).toMatch(/Belum ada piutang usaha tercatat/);
    expect(lines[1].reason).toMatch(/Belum ada utang usaha tercatat/);
  });

  it("is left as the AI gave it when the entity holds a receivable and a payable", async () => {
    const g = await makeGroup();
    await post(g.pt.entity.id, g.client.id, "1130", "4100", 5_000_000n);
    await post(g.pt.entity.id, g.client.id, "5100", "2110", 2_000_000n);
    expect((await tradeBacking(db, g.pt.entity.id))(dateOnly(2026, 8, 31))).toEqual({ receivable: true, payable: true });
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "agu.csv", data: file, provider: provider() });
    const lines = await db.bankTransaction.findMany({ where: { bankAccountId: g.pt.banks[0].id }, orderBy: { rowNumber: "asc" } });
    expect(lines.map((l) => [l.suggestedCode, l.confidence])).toEqual([["1130", 0.85], ["2110", 0.88]]);
    expect(lines[0].reason).not.toMatch(/Belum ada/);
  });

  it("is demoted the same way when the accountant asks for AI suggestions on Review", async () => {
    const g = await makeGroup();
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "agu.csv", data: file, provider: null });
    const r = await suggestAgainWithAi(db, { clientId: g.client.id, entityIds: [g.pt.entity.id], through: dateOnly(2026, 8, 31), provider: provider() });
    expect(r.updated).toBe(2);
    const lines = await db.bankTransaction.findMany({ where: { bankAccountId: g.pt.banks[0].id }, orderBy: { rowNumber: "asc" } });
    expect(lines.map((l) => [l.suggestedCode, l.confidence])).toEqual([["1130", UNBACKED_CONFIDENCE], ["2110", UNBACKED_CONFIDENCE]]);
  });

  it("counts only what was on the books by the row's date: a receivable booked later settles nothing earlier", async () => {
    const g = await makeGroup();
    await post(g.pt.entity.id, g.client.id, "1130", "4100", 5_000_000n, dateOnly(2026, 8, 20));
    const at = await tradeBacking(db, g.pt.entity.id);
    expect([at(dateOnly(2026, 8, 5)).receivable, at(dateOnly(2026, 8, 20)).receivable]).toEqual([false, true]);
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "agu.csv", data: file, provider: provider() });
    const receipt = await db.bankTransaction.findFirstOrThrow({ where: { bankAccountId: g.pt.banks[0].id, suggestedCode: "1130" } });
    expect(receipt.confidence).toBe(UNBACKED_CONFIDENCE); // the 5 Aug receipt, before the 20 Aug invoice
  });

  it("counts another entity's receivable for nothing", async () => {
    const g = await makeGroup();
    await post(g.owner.entity.id, g.client.id, "1130", "4910", 5_000_000n);
    expect((await tradeBacking(db, g.pt.entity.id))(dateOnly(2026, 8, 31))).toEqual({ receivable: false, payable: false });
  });
});
