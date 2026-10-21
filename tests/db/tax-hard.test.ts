import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { postJournal } from "@/lib/ledger/post";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction } from "@/lib/review";
import { taxPack } from "@/lib/tax/pack";
import { postTax } from "@/lib/tax/post";
import { addCredit, setLoss, setRegime } from "@/lib/tax/records";
import { masaReport } from "@/lib/tax/masa-report";
import { corporateTax } from "@/lib/tax/compute";
import { dateOnly } from "@/lib/format";

/**
 * The PPh badan pack (accounting-rules 5d) and its journals tested hard (cycle 2026-10-21-uji-keras-pajak-impor-tutup), every figure
 * computed by hand first, cases built through the real writers (postJournal, importStatement + reviewTransaction, the tax records and
 * postTax). Its failures were fixed in the same cycle: final PPh 4(2) a customer withheld is neither booked again under PP 55 nor taxed
 * again under the normal regime, and natura is deductible under UU HPP.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;
const acc = async (g: G, code: string) => (await db.account.findFirstOrThrow({ where: { clientId: g.client.id, code } })).id;
const journal = async (g: G, date: Date, dr: string, cr: string, amount: bigint, memo = "uji") =>
  db.$transaction(async (tx) => postJournal(tx, { entityId: g.pt.entity.id, date, kind: "ADJUSTMENT", memo, lines: [{ accountId: await acc(g, dr), debit: amount }, { accountId: await acc(g, cr), credit: amount }] }));
const balance = async (g: G, code: string) => {
  const s = await db.journalLine.aggregate({ where: { entityId: g.pt.entity.id, account: { clientId: g.client.id, code } }, _sum: { debit: true, credit: true } });
  return (s._sum.debit ?? 0n) - (s._sum.credit ?? 0n);
};
/** BCA CSV: Debet = money out, Kredit = money in. */
async function bank(g: G, rows: [string, string, bigint, bigint][]) {
  const csv = ["Tanggal;Keterangan;Debet;Kredit;Saldo", ...rows.map(([d, k, out, inn], i) => `${d};${k};${out};${inn};${1_000_000_000 + i}`), ""].join("\n");
  await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: `bca-${rows[0][0].replace(/\//g, "")}.csv`, data: Buffer.from(csv), provider: null });
}
const line = (desc: string) => db.bankTransaction.findFirstOrThrow({ where: { description: { contains: desc } } });
const pack = (g: G, month: number, year = 2026) => taxPack(db, g.client.id, g.pt.entity.id, year, month).then((p) => p!);
const lines = (p: { code: string; amount: bigint }[]) => p.map((l) => [l.code, l.amount]);

describe("PPh badan pack", () => {
  beforeEach(resetDb);

  /**
   * PP 55/2022 (Pasal 56–59): a UMKM's final 0,5 % is withheld by the customer when it is a designated withholder (the company holds a
   * Surat Keterangan); the withheld part is the company's final tax already paid, so the company remits only the rest itself.
   * January 2026: a cash sale 100 jt (company remits 0,5 % = 500 rb itself) and a sale of 100 jt paid 99,5 jt net after the customer
   * withheld PPh final 4(2) 500 rb (posted Dr 8200 500 rb by rule 5h).
   * Expected: the year's final tax = 0,5 % × 200 jt = 1.000.000 on 8200 in total; 2145 owes 500.000 (the part not withheld).
   */
  it("PP 55: the final tax a customer already withheld is not booked a second time (8200 = 0,5 % of turnover, 2145 = only the unwithheld part)", async () => {
    const g = await makeGroup();
    await setRegime(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, regime: "FINAL_UMKM" });
    await journal(g, dateOnly(2026, 1, 10), "1110", "4100", 100_000_000n, "Penjualan tunai");
    await bank(g, [["20/01/2026", "TRF DARI PT PELANGGAN SATU", 0n, 99_500_000n]]);
    const receipt = await line("PELANGGAN SATU");
    await reviewTransaction(db, { bankTxId: receipt.id, accountCode: "4100", taxTag: null, withholding: { kind: "PPH_4_2", amount: 500_000n } });
    expect(await balance(g, "8200")).toBe(500_000n); // the withheld final tax, rule 5h
    expect(await balance(g, "4100")).toBe(-200_000_000n);

    const p = await pack(g, 1);
    expect(p.tax.due).toBe(1_000_000n);
    expect(p.finalWithheld).toBe(500_000n);
    expect(lines(p.proposals.CURRENT)).toEqual([["2145", -500_000n], ["8200", 500_000n]]);
    await postTax(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 1, kind: "CURRENT" });
    expect(await balance(g, "8200")).toBe(1_000_000n);
    expect(await balance(g, "2145")).toBe(-500_000n);
    // Pajak Masa February judges January's PPh final on what is left to remit: 500 rb.
    const m = (await masaReport(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 2, now: dateOnly(2026, 3, 31) }))!;
    expect(m.rows.find((r) => r.key === "PPH_LAIN")!.previous.owed).toBe(500_000n);
  });

  /**
   * UU PPh Pasal 4 ayat (2) + PP 34/2017: rent of land / buildings is taxed finally at 10 % (the tenant withholds). Final-taxed income
   * leaves the PPh badan computation (koreksi fiskal negatif, beda tetap) and is not peredaran bruto for Pasal 31E (SE-02/PJ/2015).
   * 2026 Jan–Sep: sales 1 M, salaries 400 jt, office rent received 90 jt net of PPh 4(2) 10 jt (gross 100 jt on 4120).
   * Expected: PBT 700 jt (8200 is below PBT), koreksi negatif 100 jt → fiscal profit 600 jt; turnover for 31E 1 M (≤ 4,8 M: all at
   * 11 %) → PPh terutang 66 jt.
   */
  it("normal regime: income a tenant withheld PPh 4(2) final on (rule 5h) leaves fiscal profit and the 31E turnover", async () => {
    const g = await makeGroup();
    await db.account.create({ data: { firmId: g.firm.id, clientId: g.client.id, code: "4120", name: "Pendapatan Sewa Ruangan", type: "PENDAPATAN", normalBalance: "CREDIT", fsLine: "PENDAPATAN_USAHA" } });
    await journal(g, dateOnly(2026, 3, 31), "1130", "4100", 1_000_000_000n, "Penjualan");
    await journal(g, dateOnly(2026, 4, 30), "6100", "1110", 400_000_000n, "Gaji");
    await bank(g, [["05/05/2026", "TRF DARI PT PENYEWA RUANG", 0n, 90_000_000n]]);
    await reviewTransaction(db, { bankTxId: (await line("PENYEWA RUANG")).id, accountCode: "4120", taxTag: null, withholding: { kind: "PPH_4_2", amount: 10_000_000n } });
    const p = await pack(g, 9);
    expect(p.profitBeforeTax).toBe(700_000_000n);
    expect(p.fiscalProfit).toBe(600_000_000n);
    expect(p.corrections.filter((c) => c.key === "auto:final42:4120").map((c) => [c.direction, c.kind, c.amount])).toEqual([["NEGATIVE", "PERMANENT", 100_000_000n]]);
    expect(p.turnover).toBe(1_000_000_000n);
    expect(p.tax.due).toBe(66_000_000n);
  });

  /**
   * UU PPh Pasal 6 ayat (2): a fiscal loss is compensated for five years after the origin year, oldest first. Tax year 2026: losses left
   * at 1 January from 2021 (30 jt — its last year) and 2023 (100 jt). A 2020 loss is out of time (setLoss refuses it).
   * Fiscal profit 600.000.500 (sales 1.000.000.500 − salaries 400 jt) − 130 jt = 470.000.500 → PKP rounded down 470.000.000; turnover
   * ≤ 4,8 M → 11 % = 51.700.000.
   */
  it("compensates losses oldest first within five years and rounds PKP down after the compensation", async () => {
    const g = await makeGroup();
    await journal(g, dateOnly(2026, 3, 31), "1130", "4100", 1_000_000_500n, "Penjualan");
    await journal(g, dateOnly(2026, 4, 30), "6100", "1110", 400_000_000n, "Gaji");
    const base = { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026 };
    await expect(setLoss(db, { ...base, originYear: 2020, amount: "50000000" })).rejects.toThrow(/2021–2025/);
    await setLoss(db, { ...base, originYear: 2023, amount: "100000000" });
    await setLoss(db, { ...base, originYear: 2021, amount: "30000000" });
    const p = await pack(g, 12);
    expect(p.fiscalProfit).toBe(600_000_500n);
    expect(p.losses.map((l) => [l.originYear, l.used, l.remaining, l.expired])).toEqual([[2021, 30_000_000n, 0n, false], [2023, 100_000_000n, 0n, false]]);
    expect(p.compensation).toBe(130_000_000n);
    expect(p.tax).toMatchObject({ pkp: 470_000_000n, due: 51_700_000n });
    // 2027: the 2021 loss has expired (its five years are 2022–2026); recorded there it is skipped.
    await journal(g, dateOnly(2027, 3, 31), "1130", "4100", 100_000_000n, "Penjualan 2027");
    await db.taxYear.create({ data: { firmId: g.firm.id, clientId: g.client.id, entityId: g.pt.entity.id, year: 2027 } });
    await setLoss(db, { ...base, year: 2027, originYear: 2022, amount: "40000000" });
    const n = await pack(g, 12, 2027);
    expect(n.losses.map((l) => [l.originYear, l.used])).toEqual([[2022, 40_000_000n]]);
    expect(n.tax.pkp).toBe(60_000_000n);
  });

  /**
   * UU HPP (UU 7/2021) Pasal 6 ayat (1) huruf a angka 2 and PMK 66/2023 Pasal 2: from tax year 2022 natura and kenikmatan given to
   * employees are deductible for the employer (and income of the employee). A 2026 pack must not suggest adding 100 % of a
   * "Beban Natura Karyawan" back as a permanent positive correction (the pre-HPP Pasal 9 ayat (1) huruf e rule).
   */
  it("does not suggest natura / kenikmatan as non-deductible under UU HPP", async () => {
    const g = await makeGroup();
    await db.account.create({ data: { firmId: g.firm.id, clientId: g.client.id, code: "6115", name: "Beban Natura Karyawan", type: "BEBAN", normalBalance: "DEBIT", fsLine: "BEBAN_UMUM_ADM" } });
    await journal(g, dateOnly(2026, 3, 31), "1130", "4100", 500_000_000n, "Penjualan");
    await journal(g, dateOnly(2026, 4, 30), "6115", "1110", 12_000_000n, "Makan dan seragam karyawan");
    const p = await pack(g, 12);
    expect(p.suggestions.filter((s) => s.code === "6115" && s.direction === "POSITIVE")).toEqual([]);
  });

  /**
   * 2025: sales 100 jt, costs 300 jt → fiscal loss 200 jt (PKP 0, no tax). 2026: sales 500 jt, costs 100 jt → fiscal profit 400 jt;
   * the 2025 loss is suggested; once recorded, PKP 200 jt → 11 % = 22 jt (UU PPh Pasal 6 ayat (2), Pasal 31E).
   */
  it("suggests last year's fiscal loss and compensates it once recorded", async () => {
    const g = await makeGroup();
    await journal(g, dateOnly(2025, 6, 30), "1130", "4100", 100_000_000n);
    await journal(g, dateOnly(2025, 7, 31), "6100", "1110", 300_000_000n);
    const y25 = await pack(g, 12, 2025);
    expect([y25.fiscalProfit, y25.tax.pkp, y25.tax.due]).toEqual([-200_000_000n, 0n, 0n]);
    await journal(g, dateOnly(2026, 6, 30), "1130", "4100", 500_000_000n);
    await journal(g, dateOnly(2026, 7, 31), "6100", "1110", 100_000_000n);
    expect((await pack(g, 12)).lossSuggestion).toEqual({ originYear: 2025, amount: 200_000_000n });
    await setLoss(db, { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, originYear: 2025, amount: "200000000" });
    const p = await pack(g, 12);
    expect([p.lossSuggestion, p.compensation, p.tax.pkp, p.tax.due]).toEqual([null, 200_000_000n, 200_000_000n, 22_000_000n]);
  });

  /** A PPh 25 instalment paid by MPN without naming the tax, confirmed in Review to 1180 / PPH_25, is a credit of the masa before payment. */
  it("counts a PPh 25 instalment confirmed in Review as a credit", async () => {
    const g = await makeGroup();
    await journal(g, dateOnly(2026, 3, 31), "1130", "4100", 1_000_000_000n);
    await bank(g, [["14/04/2026", "PEMBAYARAN MPN G2 KODE BILLING 920260414001", 7_000_000n, 0n]]);
    const mpn = await line("MPN G2");
    expect(mpn.status).toBe("NEEDS_REVIEW");
    await reviewTransaction(db, { bankTxId: mpn.id, accountCode: "1180", taxTag: "PPH_25" });
    const p = await pack(g, 12);
    expect(p.credits.map((c) => [c.type, c.amount, c.accountCode, c.masa?.toISOString().slice(0, 10)])).toEqual([["PPH_25", 7_000_000n, "1180", "2026-03-01"]]);
  });

  /** Pasal 31E bounds ("sampai dengan" Rp 4,8 M and Rp 50 M, both inclusive), PKP 1 M, a full year. */
  it("Pasal 31E at its bounds", () => {
    // Turnover exactly 4,8 M: all PKP at 11 % → 110 jt.
    expect(corporateTax({ regime: "NORMAL", pkp: 1_000_000_000n, turnover: 4_800_000_000n })).toMatchObject({ facilityPkp: 1_000_000_000n, due: 110_000_000n });
    // Exactly 50 M: 4,8/50 × 1 M = 96 jt at 11 % (10.560.000) + 904 jt at 22 % (198.880.000) = 209.440.000.
    expect(corporateTax({ regime: "NORMAL", pkp: 1_000_000_000n, turnover: 50_000_000_000n })).toMatchObject({ facilityPkp: 96_000_000n, facilityTax: 10_560_000n, regularTax: 198_880_000n, due: 209_440_000n });
    // Rp 1 over 50 M: no facility, 22 % → 220 jt.
    expect(corporateTax({ regime: "NORMAL", pkp: 1_000_000_000n, turnover: 50_000_000_001n })).toMatchObject({ facilityPkp: 0n, due: 220_000_000n });
  });

  /**
   * The current-tax journal of a full year with PPh 25 instalments, PPh 23 and PPh 22 credits (UU PPh Pasal 28, 29): sales 2 M,
   * costs 1,2 M → PKP 800 jt, 11 % = 88 jt. Credits: PPh 25 4 jt × 12 = 48 jt (paid the 14th of the next month, 1180), PPh 23 bukti
   * potong 10 jt and PPh 22 2 jt (1180) → 60 jt; PPh 29 = 28 jt on 2146. Next year's PPh 25 = (88 − 12) ÷ 12 = 6.333.333.
   */
  it("full year: PPh 29 after PPh 25, 23 and 22 credits, and next year's PPh 25", async () => {
    const g = await makeGroup();
    await journal(g, dateOnly(2026, 6, 30), "1130", "4100", 2_000_000_000n);
    await journal(g, dateOnly(2026, 6, 30), "5100", "2110", 1_200_000_000n);
    const pay = ["14/02/2026", "14/03/2026", "14/04/2026", "14/05/2026", "14/06/2026", "14/07/2026", "14/08/2026", "14/09/2026", "14/10/2026", "14/11/2026", "14/12/2026", "14/01/2027"];
    await bank(g, pay.map((d, i) => [d, `SETORAN PPH 25 MASA ${i + 1}`, 4_000_000n, 0n] as [string, string, bigint, bigint]));
    const base = { clientId: g.client.id, entityId: g.pt.entity.id, year: 2026 };
    await addCredit(db, { ...base, type: "PPH_23", reference: "BP-23", date: "2026-08-10", amount: "10000000", accountCode: "1180" });
    await addCredit(db, { ...base, type: "PPH_22", reference: "BP-22", date: "2026-09-10", amount: "2000000", accountCode: "1180" });
    const p = await pack(g, 12);
    expect(p.tax.due).toBe(88_000_000n);
    expect(p.settlement).toEqual({ credits: 60_000_000n, balance: 28_000_000n, nextInstalment: 6_333_333n });
    const e = await postTax(db, { ...base, month: 12, kind: "CURRENT" });
    expect(e.date.toISOString().slice(0, 10)).toBe("2026-12-31");
    expect(await balance(g, "2146")).toBe(-28_000_000n);
    expect(await balance(g, "8100")).toBe(88_000_000n);
    // 1180 held the 48 jt of instalments + nothing else (the bukti potong were typed only): 48 − 60 = −12 jt, since the PPh 23/22
    // credits were never debited to 1180 in the books (only typed), the journal takes them off 1180 anyway.
    expect(await balance(g, "1180")).toBe(-12_000_000n);
  });
});
