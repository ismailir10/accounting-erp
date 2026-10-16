import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { postJournal } from "@/lib/ledger/post";
import { importStatement } from "@/lib/import/pipeline";
import { trialBalance } from "@/lib/reports/ledger";
import { generalLedger, rangeBounds } from "@/lib/reports/general-ledger";
import { journalRegister, parseKindFilter, parseSearch } from "@/lib/reports/journal-register";
import { reverseEntry } from "@/lib/ledger/reverse";
import { dateOnly, periodBounds } from "@/lib/format";

const J = 1_000_000n;
const CSV = ["Tanggal;Keterangan;Debet;Kredit;Saldo", "05/09/2026;TRSF CR PT MITRA UNGGAS;0;4250000;104250000", "12/09/2026;BIAYA ADM;15000;0;104235000", ""].join("\n");

async function books(endMonth = 12) {
  const g = await makeGroup();
  await db.client.update({ where: { id: g.client.id }, data: { fiscalYearEndMonth: endMonth } });
  const acc = async (code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code } } })).id;
  const post = async (date: Date, memo: string, lines: [string, bigint, bigint][], kind: "ADJUSTMENT" | "OPENING" = "ADJUSTMENT") =>
    db.$transaction(async (tx) => postJournal(tx, { entityId: g.pt.entity.id, date, kind, memo, lines: await Promise.all(lines.map(async ([c, d, k]) => ({ accountId: await acc(c), debit: d, credit: k }))) }));
  // Last year: capital and a profit of 100 (it folds into Saldo Laba this year).
  await post(dateOnly(2025, 3, 1), "Setoran modal", [["1110", 500n * J, 0n], ["3100", 0n, 500n * J]]);
  await post(dateOnly(2025, 6, 15), "Penjualan 2025", [["1110", 100n * J, 0n], ["4100", 0n, 100n * J]]);
  // This year.
  await post(dateOnly(2026, 8, 10), "Penjualan Agustus", [["1110", 40n * J, 0n], ["4100", 0n, 40n * J]]);
  await post(dateOnly(2026, 9, 3), "Gaji September", [["6100", 12n * J, 0n], ["1110", 0n, 12n * J]]);
  await post(dateOnly(2026, 9, 20), "Sewa kantor", [["6190", 3_500_000n, 0n], ["1110", 0n, 3_500_000n]]);
  return { g, scope: { clientId: g.client.id, entityIds: [g.pt.entity.id] }, post };
}

describe("general ledger", () => {
  beforeEach(resetDb);

  it("ties every account's closing to the trial balance, prior-year profit folded into Saldo Laba", async () => {
    const { scope } = await books();
    const sep = periodBounds(2026, 9);
    const gl = await generalLedger(db, scope, sep.start, sep.end);
    const tb = await trialBalance(db, scope, sep.end);
    for (const a of gl) {
      const row = tb.find((r) => r.account.id === a.account.id)!;
      expect(a.closing, a.account.code).toBe(a.account.normalBalance === "DEBIT" ? row.net : -row.net);
    }
    // Every TB balance appears in the ledger.
    expect(tb.filter((r) => r.net !== 0n).map((r) => r.account.code)).toEqual(gl.filter((a) => a.closing !== 0n).map((a) => a.account.code));
    const by = (code: string) => gl.find((a) => a.account.code === code)!;
    expect(by("3200")).toMatchObject({ opening: 100n * J, priorYearProfit: 100n * J, lines: [], closing: 100n * J });
    // Income restarts on 1 January: August is its opening, nothing of 2025.
    expect(by("4100")).toMatchObject({ opening: 40n * J, closing: 40n * J });
    const cash = by("1110");
    expect([cash.opening, cash.debit, cash.credit, cash.closing]).toEqual([640n * J, 0n, 15_500_000n, 624_500_000n]);
    expect(cash.lines.map((l) => [l.memo, l.balance])).toEqual([["Gaji September", 628n * J], ["Sewa kantor", 624_500_000n]]);
  });

  it("year to date starts at the financial year (February for a January year end), one account on request", async () => {
    const { scope, g } = await books(1);
    const r = await rangeBounds(db, g.client.id, "ytd", periodBounds(2026, 9));
    expect(r.start.toISOString().slice(0, 10)).toBe("2026-02-01");
    const gl = await generalLedger(db, scope, r.start, r.end, { accountCode: "4100" });
    expect(gl.map((a) => [a.account.code, a.opening, a.credit, a.closing])).toEqual([["4100", 0n, 40n * J, 40n * J]]);
  });

  it("names the statement row behind a bank line", async () => {
    const { g, scope } = await books();
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca-sep.csv", data: Buffer.from(CSV), provider: null });
    const sep = periodBounds(2026, 9);
    const bank = (await generalLedger(db, scope, sep.start, sep.end)).find((a) => a.account.id === g.pt.banks[0].accountId)!;
    expect(bank.lines.map((l) => l.source)).toEqual(["BCA Giro · bca-sep.csv, baris 2", "BCA Giro · bca-sep.csv, baris 3"]);
  });
});

describe("journal register (Jurnal Umum)", () => {
  beforeEach(resetDb);

  it("lists the range's journals with lines debit first, totals over the whole filter, and pages", async () => {
    const { scope } = await books();
    const sep = periodBounds(2026, 9);
    const all = await journalRegister(db, scope, { ...sep, kinds: null, search: null });
    expect(all.count).toBe(2);
    expect([all.debit, all.credit]).toEqual([15_500_000n, 15_500_000n]);
    expect(all.entries.map((e) => [e.memo, e.lines.map((l) => [l.code, l.debit, l.credit])])).toEqual([
      ["Gaji September", [["6100", 12n * J, 0n], ["1110", 0n, 12n * J]]],
      ["Sewa kantor", [["6190", 3_500_000n, 0n], ["1110", 0n, 3_500_000n]]],
    ]);
    const ytd = await journalRegister(db, scope, { start: dateOnly(2026, 1, 1), end: sep.end, kinds: null, search: null });
    expect(ytd.count).toBe(3);
  });

  it("searches memo, account code or name, and an amount; filters by kind", async () => {
    const { scope, g } = await books();
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca-sep.csv", data: Buffer.from(CSV), provider: null });
    const sep = periodBounds(2026, 9);
    const find = async (q: string, jenis?: string) =>
      (await journalRegister(db, scope, { ...sep, kinds: parseKindFilter(jenis).kinds, search: parseSearch(q, "IDR") })).entries.map((e) => e.memo);
    expect(await find("gaji")).toEqual(["Gaji September"]);
    expect(await find("6190")).toEqual(["Sewa kantor"]);
    expect(await find("3.500.000")).toEqual(["Sewa kantor"]);
    expect(await find("Rp 4.250.000")).toHaveLength(1);
    expect(await find("mitra unggas")).toHaveLength(1);
    expect(await find("", "penyesuaian")).toEqual(["Gaji September", "Sewa kantor"]);
    expect(await find("", "bank")).toHaveLength(2);
    expect(await find("tidak ada")).toEqual([]);
  });

  it("marks a reversed journal and names the one reversing it", async () => {
    const { scope, g } = await books();
    const rent = await db.journalEntry.findFirstOrThrow({ where: { memo: "Sewa kantor" } });
    await reverseEntry(db, { clientId: g.client.id, entryId: rent.id, date: dateOnly(2026, 9, 30) });
    const sep = periodBounds(2026, 9);
    const r = await journalRegister(db, scope, { ...sep, kinds: null, search: null });
    expect(r.entries.find((e) => e.id === rent.id)!.reversedOn?.toISOString().slice(0, 10)).toBe("2026-09-30");
    expect(r.entries.at(-1)!.source).toBe("Membalik jurnal “Sewa kantor”");
  });
});

describe("search parsing", () => {
  it("reads Indonesian amounts and keeps text as text", () => {
    expect(parseSearch("1.250.000", "IDR")).toEqual({ text: "1.250.000", amount: 1_250_000n });
    expect(parseSearch("Rp 1.250.000", "IDR")).toEqual({ text: "Rp 1.250.000", amount: 1_250_000n });
    expect(parseSearch("(15.000)", "IDR")).toEqual({ text: "(15.000)", amount: 15_000n });
    expect(parseSearch("gaji 2026", "IDR")).toEqual({ text: "gaji 2026", amount: null });
    expect(parseSearch("1,5", "IDR")).toEqual({ text: "1,5", amount: null });
    expect(parseSearch("  ", "IDR")).toBeNull();
  });
});
