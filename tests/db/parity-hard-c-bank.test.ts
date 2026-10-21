import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { createDimension } from "@/lib/dimensions";
import { importStatement } from "@/lib/import/pipeline";
import { acceptSimilar, reviewTransaction, setBankTagsTx, splitTransaction, unpairTransfer } from "@/lib/review";
import { saveAutomation } from "@/lib/settings/automation";
import { createInvoice } from "@/lib/receivables/invoices";
import { settleWithReclass } from "@/lib/receivables/settle";
import { incomeByDimension } from "@/lib/reports/by-dimension";
import { incomeStatement } from "@/lib/reports/ledger";
import { listEvents } from "@/lib/audit";
import { dateOnly } from "@/lib/format";

/**
 * Round nine, probe C (cycle 2026-10-21-uji-keras-paritas): Departemen & Proyek on bank lines, through the real writers (import, Review,
 * Buku Besar's tag drawer, split, settle, unpair). Every expected figure is computed by hand in the comment beside it. A failing test is a
 * confirmed defect: its name says what goes wrong, its assertion says what is right.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;

const statement = (opening: string, ...rows: string[]) => Buffer.from(["Tanggal;Keterangan;Debet;Kredit;Saldo", `01/08/2026;SALDO AWAL;;;${opening}`, ...rows, ""].join("\n"));

async function setup() {
  const g = await makeGroup();
  const A = await createDimension(db, { clientId: g.client.id, kind: "DEPARTEMEN", code: "OUTLET-A", name: "Outlet A" });
  const B = await createDimension(db, { clientId: g.client.id, kind: "DEPARTEMEN", code: "OUTLET-B", name: "Outlet B" });
  const P = await createDimension(db, { clientId: g.client.id, kind: "PROYEK", code: "PRJ-01", name: "Proyek satu" });
  const bankCode = (await db.account.findUniqueOrThrow({ where: { id: g.pt.banks[0].accountId } })).code;
  return { g, A, B, P, bankCode };
}

async function load(g: G, rows: string[], opening = "100.000.000,00", bank = 0) {
  await importStatement(db, { bankAccountId: g.pt.banks[bank].id, fileName: `m${Math.random()}.csv`, data: statement(opening, ...rows), provider: null });
}
const line = (contains: string) => db.bankTransaction.findFirstOrThrow({ where: { description: { contains } } });

/** Net (debit − credit) per "account|department|project" of every entry of the bank line; zero keys dropped. */
async function nets(bankTxId: string) {
  const ls = await db.journalLine.findMany({ where: { entry: { bankTransactionId: bankTxId } }, include: { account: true } });
  const m = new Map<string, bigint>();
  for (const l of ls) {
    const k = `${l.account.code}|${l.departmentId ?? "-"}|${l.projectId ?? "-"}`;
    m.set(k, (m.get(k) ?? 0n) + l.debit - l.credit);
  }
  return Object.fromEntries([...m].filter(([, v]) => v !== 0n).map(([k, v]) => [k, v]));
}
const lastReclass = async (bankTxId: string) =>
  db.journalEntry.findFirstOrThrow({ where: { bankTransactionId: bankTxId, kind: "RECLASS" }, orderBy: { createdAt: "desc" }, include: { lines: { include: { account: true } } } });
const shape = (lines: { account: { code: string }; debit: bigint; credit: bigint; departmentId: string | null }[]) =>
  lines.map((l) => `${l.account.code}|${l.departmentId ?? "-"}|${l.debit - l.credit}`).sort();

const lock = (g: G, month: number) =>
  db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month } }, update: { status: "LOCKED" }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month, status: "LOCKED" } });

describe("probe C: tags on bank lines", () => {
  beforeEach(resetDb);

  it("PPN Masukan: the tag goes on the DPP only; a retag moves 6120 and leaves 1150 and the bank alone", async () => {
    const { g, A, B, bankCode } = await setup();
    await load(g, ["03/08/2026;BAYAR SEWA OUTLET KEMANG;11.100.000,00;0,00;88.900.000,00"]);
    const t = await line("SEWA OUTLET");
    // Gross 11.100.000 incl. PPN 11 %: DPP = round(11.100.000 × 100 / 111) = 10.000.000; PPN = 1.100.000.
    await reviewTransaction(db, { bankTxId: t.id, accountCode: "6120", taxTag: "PPN_MASUKAN", tags: { departmentId: A.id, projectId: null } });
    expect(await nets(t.id)).toEqual({ [`6120|${A.id}|-`]: 10_000_000n, "1150|-|-": 1_100_000n, [`${bankCode}|-|-`]: -11_100_000n });

    await db.$transaction((tx) => setBankTagsTx(tx, { bankTxId: t.id, departmentId: B.id, projectId: null }));
    // The RECLASS is exactly 6120 A Cr 10.000.000 / 6120 B Dr 10.000.000: no PPN or bank leg.
    expect(shape((await lastReclass(t.id)).lines)).toEqual([`6120|${A.id}|-10000000`, `6120|${B.id}|10000000`].sort());
    expect(await nets(t.id)).toEqual({ [`6120|${B.id}|-`]: 10_000_000n, "1150|-|-": 1_100_000n, [`${bankCode}|-|-`]: -11_100_000n });
  });

  it("withholding on a payment: the tag stays off the PPh 23 liability through a retag", async () => {
    const { g, A, B, bankCode } = await setup();
    await load(g, ["03/08/2026;BAYAR JASA KONSULTAN;9.800.000,00;0,00;90.200.000,00"]);
    const t = await line("KONSULTAN");
    // Paid net 9.800.000, PPh 23 200.000 withheld: 6190 Dr 10.000.000 (gross) / 2141 Cr 200.000 / bank Cr 9.800.000.
    await reviewTransaction(db, { bankTxId: t.id, accountCode: "6190", taxTag: null, withholding: { kind: "PPH_23", amount: 200_000n }, tags: { departmentId: A.id, projectId: null } });
    expect(await nets(t.id)).toEqual({ [`6190|${A.id}|-`]: 10_000_000n, "2141|-|-": -200_000n, [`${bankCode}|-|-`]: -9_800_000n });
    await db.$transaction((tx) => setBankTagsTx(tx, { bankTxId: t.id, departmentId: B.id, projectId: null }));
    expect(shape((await lastReclass(t.id)).lines)).toEqual([`6190|${A.id}|-10000000`, `6190|${B.id}|10000000`].sort());
    expect(await nets(t.id)).toEqual({ [`6190|${B.id}|-`]: 10_000_000n, "2141|-|-": -200_000n, [`${bankCode}|-|-`]: -9_800_000n });
  });

  it("PPh 4(2) on a receipt: the 8200 final-tax expense is the income's, so it carries Outlet A (decided in round nine)", async () => {
    const { g, A } = await setup();
    await load(g, ["03/08/2026;TERIMA SEWA RUKO OUTLET A;0,00;9.000.000,00;109.000.000,00"]);
    const t = await line("SEWA RUKO");
    // Received net 9.000.000 with PPh 4(2) 1.000.000 withheld: 4100 Cr 10.000.000 (A) / 8200 Dr 1.000.000 (A) / bank Dr 9.000.000.
    await reviewTransaction(db, { bankTxId: t.id, accountCode: "4100", taxTag: null, withholding: { kind: "PPH_4_2", amount: 1_000_000n }, tags: { departmentId: A.id, projectId: null } });
    const scope = { clientId: g.client.id, entityIds: [g.pt.entity.id] };
    const pl = await incomeByDimension(db, scope, dateOnly(2026, 8, 1), dateOnly(2026, 8, 31), "DEPARTEMEN");
    const net = pl.rows.find((r) => r.type === "subtotal" && r.label === "Laba bersih") as { amounts: bigint[]; total: bigint };
    // Columns [Outlet A, Tanpa departemen]: A = 10.000.000 − 1.000.000 final tax = 9.000.000; Tanpa 0; Total 9.000.000.
    expect(pl.columns.map((c) => c.code)).toEqual(["OUTLET-A", ""]);
    expect(net.amounts).toEqual([9_000_000n, 0n]);
    expect(net.total).toBe((await incomeStatement(db, scope, dateOnly(2026, 8, 1), dateOnly(2026, 8, 31))).totals.netProfit);
  });

  it("a receipt settled against an invoice with withholding, then retagged: only the receivable's tag moves; 1180 and the settlement stay", async () => {
    const { g, A, B, bankCode } = await setup();
    const inv = await createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "SALES", contactName: "PT Mitra", number: "INV-1", issueDate: "2026-08-01", dueDate: "2026-08-31", dpp: "10000000", counterCode: "4100", whtKind: "PPH_23", whtRate: "2" });
    await load(g, ["10/08/2026;TRSF CR PT MITRA;0,00;9.800.000,00;109.800.000,00"]);
    const t = await line("PT MITRA");
    await db.$transaction((tx) => setBankTagsTx(tx, { bankTxId: t.id, departmentId: A.id, projectId: null }));
    await settleWithReclass(db, { clientId: g.client.id, invoiceId: inv.id, bankTransactionId: t.id });
    // Closes INV-1 (10.000.000) with 9.800.000 cash + 200.000 PPh 23 (2 % of DPP): 1130 Cr 10.000.000 (A), 1180 Dr 200.000, bank Dr 9.800.000.
    expect(await nets(t.id)).toEqual({ [`1130|${A.id}|-`]: -10_000_000n, "1180|-|-": 200_000n, [`${bankCode}|-|-`]: 9_800_000n });
    await db.$transaction((tx) => setBankTagsTx(tx, { bankTxId: t.id, departmentId: B.id, projectId: null }));
    expect(await nets(t.id)).toEqual({ [`1130|${B.id}|-`]: -10_000_000n, "1180|-|-": 200_000n, [`${bankCode}|-|-`]: 9_800_000n });
    expect(await db.invoiceSettlement.findMany({ where: { bankTransactionId: t.id }, select: { amount: true, withheld: true } })).toEqual([{ amount: 10_000_000n, withheld: 200_000n }]);
    expect((await db.bankTransaction.findUniqueOrThrow({ where: { id: t.id } })).whtAmount).toBe(200_000n);
  });

  it("a split line retagged moves every part; merged back onto one account it keeps the tag", async () => {
    const { g, A, B, P, bankCode } = await setup();
    await load(g, ["03/08/2026;BAYAR GAJI DAN ONGKOS;10.000.000,00;0,00;90.000.000,00"]);
    const t = await line("GAJI DAN ONGKOS");
    await reviewTransaction(db, { bankTxId: t.id, accountCode: "6120", taxTag: null, tags: { departmentId: A.id, projectId: null } });
    await splitTransaction(db, { bankTxId: t.id, parts: [{ accountCode: "6120", amount: "6.000.000" }, { accountCode: "6190", amount: "4.000.000" }] });
    await db.$transaction((tx) => setBankTagsTx(tx, { bankTxId: t.id, departmentId: B.id, projectId: P.id }));
    // Parts 6120 6.000.000 and 6190 4.000.000 move from (A, –) to (B, PRJ-01): a 4-line RECLASS.
    expect((await lastReclass(t.id)).lines.length).toBe(4);
    expect(await nets(t.id)).toEqual({ [`6120|${B.id}|${P.id}`]: 6_000_000n, [`6190|${B.id}|${P.id}`]: 4_000_000n, [`${bankCode}|-|-`]: -10_000_000n });
    // Buku Besar's *Gabungkan ke akun ini*: the parts go; 6190 takes the whole 10.000.000 with the line's tags.
    await reviewTransaction(db, { bankTxId: t.id, accountCode: "6190", taxTag: null, replaceSplit: true });
    expect(await db.bankTxSplit.count({ where: { bankTransactionId: t.id } })).toBe(0);
    expect(await nets(t.id)).toEqual({ [`6190|${B.id}|${P.id}`]: 10_000_000n, [`${bankCode}|-|-`]: -10_000_000n });
  });

  it("acceptSimilar decides each line with its own tags: one tagged in Review keeps its tag, the source's tags are not copied", async () => {
    const { g, A } = await setup();
    await load(g, ["03/08/2026;BAYAR SEWA OUTLET KEMANG;1.000.000,00;0,00;99.000.000,00", "20/08/2026;BAYAR SEWA OUTLET KEMANG;1.500.000,00;0,00;97.500.000,00"]);
    const [first, second] = await db.bankTransaction.findMany({ where: { description: { contains: "SEWA OUTLET" } }, orderBy: { date: "asc" } });
    expect(first.merchantKey).toBe(second.merchantKey);
    expect([first.status, second.status]).toEqual(["NEEDS_REVIEW", "NEEDS_REVIEW"]);
    await db.$transaction((tx) => setBankTagsTx(tx, { bankTxId: second.id, departmentId: A.id, projectId: null }));
    const ids = await acceptSimilar(db, first.id, undefined, null, { accountCode: "6190", taxTag: null });
    expect(ids.sort()).toEqual([first.id, second.id].sort());
    expect(Object.keys(await nets(first.id)).filter((k) => k.startsWith("6190"))).toEqual(["6190|-|-"]);
    expect((await nets(second.id))[`6190|${A.id}|-`]).toBe(1_500_000n);
  });

  it("a tag-only change on a line still in Review posts nothing, even when its suggestion carries PPN (no PPN Masukan for an undecided line)", async () => {
    const { g, A } = await setup();
    // Aturan off: the PAKAN rule (5100, PPN Masukan) no longer posts; the line waits in Review with the suggestion.
    expect(await saveAutomation(db, { firmId: g.firm.id, settings: { transfer: true, rules: false, memory: true, cap: "", fluxFloor: "", fluxPercent: "50" } })).toMatchObject({ ok: true });
    await load(g, ["04/08/2026;BELI PAKAN AYAM CV MAJU;11.100.000,00;0,00;88.900.000,00"]);
    const t = await line("PAKAN");
    expect(t).toMatchObject({ status: "NEEDS_REVIEW", accountCode: "1999", suggestedCode: "5100", taxTag: "PPN_MASUKAN" });
    const entries = await db.journalEntry.count({ where: { bankTransactionId: t.id } });
    await db.$transaction((tx) => setBankTagsTx(tx, { bankTxId: t.id, departmentId: A.id, projectId: null }));
    // The line is undecided: its whole 11.100.000 stays on 1999 and no entry is added. (Today a RECLASS moves the suggested PPN
    // 1.100.000 to 1150 — rule 4 "AI never auto-posts" — because setBankTagsTx re-posts with the line's suggested taxTag.)
    expect(await db.journalEntry.count({ where: { bankTransactionId: t.id } })).toBe(entries);
    const n = await nets(t.id);
    expect(n["1150|-|-"]).toBeUndefined();
    expect(n["1999|-|-"]).toBe(11_100_000n);
  });

  it("a tag change on a line in Review in a locked month is refused and writes nothing (row tags, events)", async () => {
    const { g, A } = await setup();
    await load(g, ["03/08/2026;BAYAR SEWA OUTLET KEMANG;10.000.000,00;0,00;90.000.000,00"]);
    const t = await line("SEWA OUTLET");
    expect(t.status).toBe("NEEDS_REVIEW");
    // August closed with the 1999 control acknowledged (a REVIEW control may be closed with a note): the line stays in Review.
    await lock(g, 8);
    const events = (await listEvents(db, g.client.id, { kind: "DIMENSION" })).length;
    // A closed month refuses every write (rule 4), as splitTransaction refuses an unchanged re-split there.
    await expect(db.$transaction((tx) => setBankTagsTx(tx, { bankTxId: t.id, departmentId: A.id, projectId: null }))).rejects.toThrow(/ditutup|dikunci/);
    expect((await db.bankTransaction.findUniqueOrThrow({ where: { id: t.id } })).departmentId).toBeNull();
    expect((await listEvents(db, g.client.id, { kind: "DIMENSION" })).length).toBe(events);
  });

  it("a tag change on a classified line in a locked month is refused and leaves the row's tags (setBankTagsTx and Review)", async () => {
    const { g, A, B } = await setup();
    await load(g, ["03/08/2026;BAYAR SEWA OUTLET KEMANG;10.000.000,00;0,00;90.000.000,00"]);
    const t = await line("SEWA OUTLET");
    await reviewTransaction(db, { bankTxId: t.id, accountCode: "6120", taxTag: null, tags: { departmentId: A.id, projectId: null } });
    await lock(g, 8);
    const before = await db.journalLine.count();
    await expect(db.$transaction((tx) => setBankTagsTx(tx, { bankTxId: t.id, departmentId: B.id, projectId: null }))).rejects.toThrow(/sudah ditutup/);
    await expect(reviewTransaction(db, { bankTxId: t.id, accountCode: "6120", taxTag: null, tags: { departmentId: B.id, projectId: null } })).rejects.toThrow(/sudah ditutup/);
    expect((await db.bankTransaction.findUniqueOrThrow({ where: { id: t.id } })).departmentId).toBe(A.id);
    expect(await db.journalLine.count()).toBe(before);
  });

  it("a tag change racing a review: the row and the ledger agree whichever wins", async () => {
    const { g, A, B, bankCode } = await setup();
    await load(g, ["03/08/2026;BAYAR SEWA OUTLET KEMANG;10.000.000,00;0,00;90.000.000,00"]);
    const t = await line("SEWA OUTLET");
    await reviewTransaction(db, { bankTxId: t.id, accountCode: "6120", taxTag: null, tags: { departmentId: A.id, projectId: null } });
    for (let round = 0; round < 3; round++) {
      const target = round % 2 ? A.id : B.id;
      const code = round % 2 ? "6120" : "6190";
      await Promise.all([db.$transaction((tx) => setBankTagsTx(tx, { bankTxId: t.id, departmentId: target, projectId: null })), reviewTransaction(db, { bankTxId: t.id, accountCode: code, taxTag: null })]);
      const row = await db.bankTransaction.findUniqueOrThrow({ where: { id: t.id } });
      expect([row.accountCode, row.departmentId]).toEqual([code, target]);
      expect(await nets(t.id)).toEqual({ [`${code}|${target}|-`]: 10_000_000n, [`${bankCode}|-|-`]: -10_000_000n });
    }
  });

  it("a transfer half tagged in Review: the import pairs it onto 1199 with the tag (no P&L column), unpair sends it to 1999 untagged and the row keeps it", async () => {
    const { g, A } = await setup();
    const dial = (transfer: boolean) => saveAutomation(db, { firmId: g.firm.id, settings: { transfer, rules: true, memory: true, cap: "", fluxFloor: "", fluxPercent: "50" } });
    // Transfer automation off: the BCA half waits in Review on 1999 (held), and is tagged there.
    await dial(false);
    await load(g, ["05/08/2026;PINDAH BUKU KE MANDIRI PT UJI SEJAHTERA;5.000.000,00;0,00;95.000.000,00"]);
    const out = await line("KE MANDIRI");
    expect([out.status, out.accountCode]).toEqual(["NEEDS_REVIEW", "1999"]);
    await db.$transaction((tx) => setBankTagsTx(tx, { bankTxId: out.id, departmentId: A.id, projectId: null }));
    await dial(true);
    // The Mandiri half arrives: the pipeline re-posts the earlier half (pipeline.ts, previously imported half) onto 1199.
    await load(g, ["05/08/2026;PINDAH BUKU DARI BCA PT UJI SEJAHTERA;0,00;5.000.000,00;15.000.000,00"], "10.000.000,00", 1);
    const inn = await line("DARI BCA");
    expect((await db.bankTransaction.findUniqueOrThrow({ where: { id: out.id } })).matchedTxId).toBe(inn.id);
    expect((await nets(out.id))[`1199|${A.id}|-`]).toBe(5_000_000n);
    // 1199 is not income or expense: no Outlet A column, and the per-department report still adds up.
    const scope = { clientId: g.client.id, entityIds: [g.pt.entity.id] };
    const pl = await incomeByDimension(db, scope, dateOnly(2026, 8, 1), dateOnly(2026, 8, 31), "DEPARTEMEN");
    expect(pl.columns.map((c) => c.code)).toEqual([""]);

    await unpairTransfer(db, { clientId: g.client.id, bankTxId: out.id });
    const n = await nets(out.id);
    expect(n["1999|-|-"]).toBe(5_000_000n);
    expect(Object.keys(n).some((k) => k.includes(A.id))).toBe(false);
    expect((await db.bankTransaction.findUniqueOrThrow({ where: { id: out.id } })).departmentId).toBe(A.id);
  });
});
