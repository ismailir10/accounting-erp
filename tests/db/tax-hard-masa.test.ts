import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { postJournal } from "@/lib/ledger/post";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction } from "@/lib/review";
import { createInvoice, voidInvoice } from "@/lib/receivables/invoices";
import { masaReport } from "@/lib/tax/masa-report";
import { postPpnOffset } from "@/lib/tax/ppn-offset";
import { fakturRecon, importFaktur, bookFaktur } from "@/lib/tax/faktur";
import { setInstalment } from "@/lib/tax/instalment";
import { saveEmployee } from "@/lib/benefits/census";
import { dateOnly } from "@/lib/format";

/**
 * Pajak Masa (accounting-rules 5j, 5k, 13a) tested hard (cycle 2026-10-21-uji-keras-pajak-impor-tutup): figures computed by hand first,
 * cases built through the real writers. Its failures were fixed in the same cycle: a remittance confirmed or moved in Review is judged by
 * its bank line, and a replaced (AMENDED) Coretax faktur no longer counts.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;
const acc = async (g: G, code: string) => (await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code } })).id;
const journal = async (g: G, date: Date, dr: string, cr: string, amount: bigint, memo = "uji") =>
  db.$transaction(async (tx) => postJournal(tx, { entityId: g.pt.entity.id, date, kind: "ADJUSTMENT", memo, lines: [{ accountId: await acc(g, dr), debit: amount }, { accountId: await acc(g, cr), credit: amount }] }));
const balance = async (g: G, code: string) => {
  const s = await db.journalLine.aggregate({ where: { entityId: g.pt.entity.id, account: { clientId: g.client.id, code } }, _sum: { debit: true, credit: true } });
  return (s._sum.debit ?? 0n) - (s._sum.credit ?? 0n);
};
async function bank(g: G, rows: [string, string, bigint, bigint][]) {
  const csv = ["Tanggal;Keterangan;Debet;Kredit;Saldo", ...rows.map(([d, k, out, inn], i) => `${d};${k};${out};${inn};${1_000_000_000 + i}`), ""].join("\n");
  await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: `bca-${rows[0][0].replace(/\//g, "")}.csv`, data: Buffer.from(csv), provider: null });
}
const line = (desc: string) => db.bankTransaction.findFirstOrThrow({ where: { description: { contains: desc } } });
const report = (g: G, year: number, month: number) => masaReport(db, { clientId: g.client.id, entityId: g.pt.entity.id, year, month, now: dateOnly(2026, 10, 21) }).then((r) => r!);
const row = async (g: G, year: number, month: number, key: string) => (await report(g, year, month)).rows.find((r) => r.key === key)!;
const inv = (g: G, direction: "SALES" | "PURCHASE", number: string, issueDate: string, dpp: string, ppn: string) =>
  createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction, contactName: direction === "SALES" ? "PT Pembeli Satu" : "PT Pemasok Satu", number, issueDate, dpp, ppn, counterCode: direction === "SALES" ? "4100" : "5100" });
const offset = (g: G, year: number, month: number) => postPpnOffset(db, { clientId: g.client.id, entityId: g.pt.entity.id, year, month });
const entryLines = async (entryId: string) => (await db.journalLine.findMany({ where: { entryId }, include: { account: true }, orderBy: { id: "asc" } })).map((l) => [l.account.code, l.debit, l.credit]);

/**
 * UU PPN Pasal 9 ayat (3)–(4): PPN terutang = keluaran − masukan; a lebih bayar is compensated to the next masa (also across a year end,
 * UU HPP; restitusi only at the taxpayer's request, not modelled).
 * Nov 2025: masukan 11 jt, keluaran 5,5 jt → LB 5,5 jt.  Dec 2025: keluaran 1,98 jt → LB 3,52 jt.
 * Jan 2026: keluaran 11 jt, masukan 1,1 jt, carried 3,52 jt → kurang bayar 6,38 jt, remitted 27 Feb 2026 (due 28 Feb).
 */
async function ppnChain(g: G) {
  await inv(g, "PURCHASE", "P-1", "2025-11-10", "100000000", "11000000");
  await inv(g, "SALES", "S-1", "2025-11-15", "50000000", "5500000");
  await inv(g, "SALES", "S-2", "2025-12-10", "18000000", "1980000");
  await inv(g, "SALES", "S-3", "2026-01-05", "100000000", "11000000");
  await inv(g, "PURCHASE", "P-2", "2026-01-06", "10000000", "1100000");
}

describe("PPN masa", () => {
  beforeEach(resetDb);

  it("carries a lebih bayar through December into January and judges January's payment", async () => {
    const g = await makeGroup();
    await ppnChain(g);
    await bank(g, [["27/02/2026", "SETORAN PPN MASA JANUARI 2026", 6_380_000n, 0n]]);
    expect((await line("SETORAN PPN")).accountCode).toBe("2130");
    expect((await row(g, 2025, 11, "PPN")).ppn).toMatchObject({ keluaran: 5_500_000n, masukan: 11_000_000n, carryIn: 0n, carryOut: 5_500_000n });
    expect((await row(g, 2025, 12, "PPN")).ppn).toMatchObject({ keluaran: 1_980_000n, masukan: 0n, carryIn: 5_500_000n, carryOut: 3_520_000n });
    const jan = await row(g, 2026, 1, "PPN");
    expect(jan.ppn).toMatchObject({ keluaran: 11_000_000n, masukan: 1_100_000n, carryIn: 3_520_000n, carryOut: 0n });
    expect(jan.owed).toBe(6_380_000n);
    const feb = await row(g, 2026, 2, "PPN");
    expect(feb.previous).toMatchObject({ owed: 6_380_000n, state: "LUNAS", short: 0n });
    expect(feb.status).toBe("PASS");
  });

  it("compensation journals: 5,5 jt, 1,98 jt, 4,62 jt; once only; 2130 then holds exactly January's kurang bayar", async () => {
    const g = await makeGroup();
    await ppnChain(g);
    // Nov: 1150 11 jt less the 5,5 jt carried → 5,5 jt. Dec: 1150 5,5 jt less 3,52 jt carried → 1,98 jt. Jan: 3,52 + 1,1 → 4,62 jt.
    expect(await entryLines((await offset(g, 2025, 11)).id)).toEqual([["2130", 5_500_000n, 0n], ["1150", 0n, 5_500_000n]]);
    expect(await entryLines((await offset(g, 2025, 12)).id)).toEqual([["2130", 1_980_000n, 0n], ["1150", 0n, 1_980_000n]]);
    expect(await entryLines((await offset(g, 2026, 1)).id)).toEqual([["2130", 4_620_000n, 0n], ["1150", 0n, 4_620_000n]]);
    await expect(offset(g, 2026, 1)).rejects.toThrow(/Tidak ada PPN masukan/);
    expect(await balance(g, "2130")).toBe(-6_380_000n);
    expect(await balance(g, "1150")).toBe(0n);
    // The masa figures don't move with the compensation journals.
    expect((await row(g, 2026, 1, "PPN")).ppn).toMatchObject({ keluaran: 11_000_000n, masukan: 1_100_000n, carryIn: 3_520_000n, offset: 0n });
    expect((await row(g, 2026, 1, "PPN")).owed).toBe(6_380_000n);
    // An earlier masa is refused once a later one is compensated.
    await expect(offset(g, 2025, 12)).rejects.toThrow(/sudah dijurnal per/);
  });

  it("catches up never-compensated months in one entry", async () => {
    const g = await makeGroup();
    await ppnChain(g);
    // Straight to January: 1150 holds 12,1 jt, nothing carried out of January → 12,1 jt in one entry; 2130 = 18,48 − 12,1 = 6,38 jt.
    expect(await entryLines((await offset(g, 2026, 1)).id)).toEqual([["2130", 12_100_000n, 0n], ["1150", 0n, 12_100_000n]]);
    expect(await balance(g, "2130")).toBe(-6_380_000n);
  });

  it("refuses the compensation journal in a locked month", async () => {
    const g = await makeGroup();
    await inv(g, "SALES", "S-4", "2026-04-05", "10000000", "1100000");
    await inv(g, "PURCHASE", "P-4", "2026-04-06", "5000000", "550000");
    await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 4 } }, update: { status: "LOCKED" }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 4, status: "LOCKED" } });
    await expect(offset(g, 2026, 4)).rejects.toThrow(/ditutup|dikunci/i);
    expect(await db.journalEntry.count({ where: { sourceRef: { startsWith: "ppn-offset:" } } })).toBe(0);
  });

  it("a voided sales invoice leaves the masa (its reversal is dated on the original)", async () => {
    const g = await makeGroup();
    await inv(g, "SALES", "S-5", "2026-03-05", "10000000", "1100000");
    const wrong = await inv(g, "SALES", "S-6", "2026-03-06", "20000000", "2200000");
    await voidInvoice(db, { clientId: g.client.id, invoiceId: wrong.id, reason: "dobel input, faktur yang sama" });
    expect((await row(g, 2026, 3, "PPN")).owed).toBe(1_100_000n);
  });

  it("bank-line PPN: a 111 jt receipt tagged keluaran splits 100 jt + 11 jt (rule 8)", async () => {
    const g = await makeGroup();
    await bank(g, [["10/03/2026", "TRF DARI PT PEMBELI DUA", 0n, 111_000_000n], ["12/03/2026", "PAKAN TERNAK MAJU", 55_500_000n, 0n]]);
    await reviewTransaction(db, { bankTxId: (await line("PEMBELI DUA")).id, accountCode: "4100", taxTag: "PPN_KELUARAN" });
    // PAKAN → 5100 with PPN masukan by the client rule: 55,5 jt → 50 jt + 5,5 jt.
    const r = await row(g, 2026, 3, "PPN");
    expect(r.ppn).toMatchObject({ keluaran: 11_000_000n, masukan: 5_500_000n });
    expect(r.owed).toBe(5_500_000n);
  });
});

describe("Coretax faktur ekualisasi", () => {
  beforeEach(resetDb);
  const HEAD = "Nomor Faktur Pajak;Tanggal Faktur Pajak;Masa Pajak;Tahun;NPWP Pembeli;Nama Pembeli;Status Faktur;Harga Jual/Penggantian/DPP;PPN";
  const upload = (g: G, rows: string[]) => importFaktur(db, { clientId: g.client.id, entityId: g.pt.entity.id, fileName: "keluaran.csv", data: Buffer.from([HEAD, ...rows, ""].join("\n")) });

  /**
   * A faktur replaced by a faktur pengganti (PER-03/PJ/2022 / PMK 81/2024: the pengganti supersedes it; Coretax shows the original as
   * AMENDED). Only the pengganti counts in the SPT Masa PPN: keluaran 11 jt, one to one with invoice S-3.
   */
  it("a replaced (AMENDED) faktur doesn't count beside its pengganti", async () => {
    const g = await makeGroup();
    await inv(g, "SALES", "S-3", "2026-01-05", "100000000", "11000000");
    await upload(g, [
      "04002600000000101;05/01/2026;1;2026;'0123456789015000;PT Pembeli Satu;AMENDED;90000000;9900000",
      "04002600000000102;05/01/2026;1;2026;'0123456789015000;PT Pembeli Satu;APPROVED;100000000;11000000",
      "04002600000000103;06/01/2026;1;2026;'0123456789015000;PT Pembeli Satu;CANCELED;5000000;550000",
    ]);
    const k = (await fakturRecon(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 1 })).directions.find((d) => d.direction === "KELUARAN")!;
    expect(k.fakturPpn).toBe(11_000_000n);
    expect(k.status).toBe("MATCH");
  });

  it("an unmatched faktur is DIFF until booked from the faktur; then it matches", async () => {
    const g = await makeGroup();
    await inv(g, "SALES", "S-3", "2026-01-05", "100000000", "11000000");
    await upload(g, [
      "04002600000000102;05/01/2026;1;2026;'0123456789015000;PT Pembeli Satu;APPROVED;100000000;11000000",
      // DPP nilai lain 11/12 at 12 % (PMK 131/2024): 24 jt × 11/12 = 22 jt × 12 % = 2.640.000 = 11 % of 24 jt.
      "04002600000000104;20/01/2026;1;2026;'0987654321015000;PT Pembeli Dua;APPROVED;24000000;2640000",
    ]);
    const recon = async () => (await fakturRecon(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 1 })).directions.find((d) => d.direction === "KELUARAN")!;
    const before = await recon();
    expect(before).toMatchObject({ fakturPpn: 13_640_000n, bookPpn: 11_000_000n, difference: 2_640_000n, status: "DIFF" });
    expect(before.unmatchedFaktur.map((f) => f.number)).toEqual(["04002600000000104"]);
    await bookFaktur(db, { clientId: g.client.id, fakturId: before.unmatchedFaktur[0].id, counterCode: "4100" });
    expect(await recon()).toMatchObject({ bookPpn: 13_640_000n, difference: 0n, status: "MATCH" });
    expect((await row(g, 2026, 1, "PPN")).ppn).toMatchObject({ keluaran: 13_640_000n });
  });
});

describe("PPh 23, PPh 25 and PPh 21 masa", () => {
  beforeEach(resetDb);

  /** PPh 23 2 % of a 10 jt consulting fee (UU PPh Pasal 23 ayat (1) huruf c), withheld in March, due 15 April (PMK 81/2024), paid 16 April. */
  it("PPh 23 withheld by us in March and remitted on 16 April reads TERLAMBAT", async () => {
    const g = await makeGroup();
    await bank(g, [["20/03/2026", "TRF KE PT KONSULTAN JAYA", 9_800_000n, 0n], ["16/04/2026", "SETORAN PPH 23 MASA MARET 2026", 200_000n, 0n]]);
    await reviewTransaction(db, { bankTxId: (await line("KONSULTAN JAYA")).id, accountCode: "6170", taxTag: null, withholding: { kind: "PPH_23", amount: 200_000n } });
    expect((await line("SETORAN PPH 23")).accountCode).toBe("2141");
    const mar = await report(g, 2026, 3);
    expect(mar.withheldByUs.map((w) => [w.cash, w.withheld, w.gross])).toEqual([[9_800_000n, 200_000n, 10_000_000n]]);
    expect(mar.rows.find((r) => r.key === "PPH_23")!.owed).toBe(200_000n);
    const apr = (await report(g, 2026, 4)).rows.find((r) => r.key === "PPH_23")!;
    expect(apr.previous).toMatchObject({ owed: 200_000n, state: "TERLAMBAT", short: 0n });
    expect(apr.due.toISOString().slice(0, 10)).toBe("2026-05-15");
    expect(apr.status).toBe("REVIEW");
    expect(await balance(g, "2141")).toBe(0n);
  });

  it("PPh 25: the instalment of masa February paid on 16 March is TERLAMBAT; January's paid 14 February is LUNAS", async () => {
    const g = await makeGroup();
    await setInstalment(db, { clientId: g.client.id, entityId: g.pt.entity.id, from: "2026-01", amount: "5000000" });
    await bank(g, [["14/02/2026", "SETORAN PPH 25 MASA JANUARI", 5_000_000n, 0n], ["16/03/2026", "SETORAN PPH 25 MASA FEBRUARI", 5_000_000n, 0n]]);
    expect((await report(g, 2026, 2)).pph25!.previous).toMatchObject({ expected: 5_000_000n, state: "LUNAS" });
    const mar = (await report(g, 2026, 3)).pph25!;
    expect(mar.previous).toMatchObject({ expected: 5_000_000n, state: "TERLAMBAT" });
    expect(mar.status).toBe("REVIEW");
    // April: masa March was never paid → KURANG 5 jt.
    expect((await report(g, 2026, 4)).pph25!.previous).toMatchObject({ short: 5_000_000n, state: "KURANG" });
  });

  /**
   * PP 58/2023 TER (A: TK/0 10 jt → 2 %; B: K/1 9,2 jt → 1 % at the bracket's inclusive top; C: K/3 15 jt → 5 %; A: K/0 20 jt → 9 %).
   * March: 200.000 + 92.000 + 750.000 + 1.800.000 = 2.842.000.
   * June: the K/0 employee leaves on 15 June (masa pajak terakhir, PMK 168/2023): 6 × 20 jt = 120 jt − biaya jabatan 3 jt − PTKP
   * 58,5 jt = 58,5 jt → 5 % = 2.925.000 − TER Jan–May 9 jt = −6.075.000; with the others' TER 1.042.000 → −5.033.000.
   * December (Pasal 17): TK/0 800.000; K/1 1.082.000; K/3 1.050.000; a TK/0 10 jt hired 1 July: 6 months 60 jt − 3 jt − 54 jt = 3 jt
   * → 150.000 − TER Jul–Nov 1 jt = −850.000. Total 2.082.000.
   */
  it("PPh 21 TER estimate and the December / last-masa Pasal 17 recompute", async () => {
    const g = await makeGroup();
    const base = { clientId: g.client.id, entityId: g.pt.entity.id, sex: "MALE" as const, birthDate: "1990-01-01" };
    await saveEmployee(db, { ...base, name: "Adi", hireDate: "2020-01-06", wage: "10000000", ptkpStatus: "TK/0" });
    await saveEmployee(db, { ...base, name: "Budi", hireDate: "2020-01-06", wage: "9200000", ptkpStatus: "K/1" });
    await saveEmployee(db, { ...base, name: "Cici", hireDate: "2020-01-06", wage: "15000000", ptkpStatus: "K/3" });
    await saveEmployee(db, { ...base, name: "Dodi", hireDate: "2020-01-06", wage: "20000000", ptkpStatus: "K/0", leftOn: "2026-06-15" });
    await saveEmployee(db, { ...base, name: "Eka", hireDate: "2026-07-01", wage: "10000000", ptkpStatus: "TK/0" });
    await journal(g, dateOnly(2026, 3, 31), "6100", "2140", 2_842_000n, "PPh 21 Maret");
    const mar = (await report(g, 2026, 3)).ter;
    expect(mar).toMatchObject({ state: "CHECKED", estimate: 2_842_000n, booked: 2_842_000n, status: "PASS" });
    const jun = (await report(g, 2026, 6)).ter;
    expect(jun.state === "CHECKED" && [jun.estimate, jun.leavers.map((l) => [l.name, l.pkp, l.annual, l.ter, l.december])]).toEqual([-5_033_000n, [["Dodi", 58_500_000n, 2_925_000n, 9_000_000n, -6_075_000n]]]);
    const dec = (await report(g, 2026, 12)).ter;
    expect(dec.state === "ANNUAL" && [dec.estimate, dec.employees.map((e) => [e.name, e.december])]).toEqual([2_082_000n, [["Adi", 800_000n], ["Budi", 1_082_000n], ["Cici", 1_050_000n], ["Eka", -850_000n]]]);
  });
});

describe("remittances decided in Review", () => {
  beforeEach(resetDb);

  /**
   * A state payment that doesn't name the tax ("MPN G2 … KODE BILLING") goes to Review (rule 13a: suggestion 2145, posted to 1999 until
   * decided). The reviewer files it to 2141: it is the remittance of March's PPh 23 (200 rb, due 15 April, paid 14 April) → LUNAS, and
   * April itself owes nothing (no withholding in April).
   */
  it("PPh 23 remitted on time but confirmed in Review counts as the payment, not as negative tax of April", async () => {
    const g = await makeGroup();
    await bank(g, [["20/03/2026", "TRF KE PT KONSULTAN JAYA", 9_800_000n, 0n], ["14/04/2026", "PEMBAYARAN MPN G2 KODE BILLING 820260414001", 200_000n, 0n]]);
    await reviewTransaction(db, { bankTxId: (await line("KONSULTAN JAYA")).id, accountCode: "6170", taxTag: null, withholding: { kind: "PPH_23", amount: 200_000n } });
    const mpn = await line("MPN G2");
    expect(mpn.status).toBe("NEEDS_REVIEW");
    await reviewTransaction(db, { bankTxId: mpn.id, accountCode: "2141", taxTag: null });
    expect(await balance(g, "2141")).toBe(0n);
    const apr = (await report(g, 2026, 4)).rows.find((r) => r.key === "PPH_23")!;
    expect(apr.previous).toMatchObject({ owed: 200_000n, state: "LUNAS", short: 0n });
    expect(apr.owed).toBe(0n);
    expect(apr.status).toBe("PASS");
  });

  /** The same for PPN: January kurang bayar 6,38 jt, remitted 27 February through Review → January LUNAS, February keluaran 0 (not −6,38 jt). */
  it("PPN remitted on time but confirmed in Review counts as the payment, not as negative keluaran", async () => {
    const g = await makeGroup();
    await ppnChain(g);
    await bank(g, [["27/02/2026", "PEMBAYARAN MPN G2 KODE BILLING 720260227001", 6_380_000n, 0n]]);
    const mpn = await line("MPN G2");
    expect(mpn.status).toBe("NEEDS_REVIEW");
    await reviewTransaction(db, { bankTxId: mpn.id, accountCode: "2130", taxTag: null });
    const feb = await row(g, 2026, 2, "PPN");
    expect(feb.previous).toMatchObject({ owed: 6_380_000n, state: "LUNAS" });
    expect(feb.ppn).toMatchObject({ keluaran: 0n, carryOut: 0n });
  });

  /**
   * The reverse: a line auto-filed to 2141 as a remittance ("SETORAN PPH 23") is moved by the reviewer to 6190 (it was a fee, not tax).
   * March's 200 rb PPh 23 was then never remitted → April reads KURANG 200 rb; April itself withheld nothing (owed 0).
   */
  it("a remittance moved off the tax account in Review no longer pays the masa and is not new tax", async () => {
    const g = await makeGroup();
    await bank(g, [["20/03/2026", "TRF KE PT KONSULTAN JAYA", 9_800_000n, 0n], ["14/04/2026", "SETORAN PPH 23 MASA MARET 2026", 200_000n, 0n]]);
    await reviewTransaction(db, { bankTxId: (await line("KONSULTAN JAYA")).id, accountCode: "6170", taxTag: null, withholding: { kind: "PPH_23", amount: 200_000n } });
    const s = await line("SETORAN PPH 23");
    expect(s.accountCode).toBe("2141");
    await reviewTransaction(db, { bankTxId: s.id, accountCode: "6190", taxTag: null });
    const apr = (await report(g, 2026, 4)).rows.find((r) => r.key === "PPH_23")!;
    expect(apr.previous).toMatchObject({ owed: 200_000n, state: "KURANG", short: 200_000n });
    expect(apr.owed).toBe(0n);
  });
});
