import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { makePdf, table } from "../pdf-fixture";
import { importStatement } from "@/lib/import/pipeline";
import { CLOSE_SIGNOFFS, lockPeriod, runControls } from "@/lib/controls";
import { FLUX_PERCENT, scanLedger } from "@/lib/controls/anomaly";
import { DEFAULT_AUTOMATION, saveAutomation } from "@/lib/settings/automation";
import { postJournal } from "@/lib/ledger/post";
import { dateOnly } from "@/lib/format";

const accountId = async (clientId: string, code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId, code } } })).id;
type Extra = { kind?: "ADJUSTMENT" | "OPENING" | "IMPORTED"; memo?: string; ledgerImportId?: string };
const post = async (entityId: string, clientId: string, date: Date, dr: string, cr: string, amount: bigint, x: Extra = {}) =>
  db.$transaction(async (tx) =>
    postJournal(tx, { entityId, date, kind: x.kind ?? "ADJUSTMENT", memo: x.memo ?? "uji", ledgerImportId: x.ledgerImportId, lines: [{ accountId: await accountId(clientId, dr), debit: amount }, { accountId: await accountId(clientId, cr), credit: amount }] }),
  );

/** May–Jul: revenue 100 jt and utilities 5 jt a month, small office supplies. Volume 105,1 jt/month → materiality Rp 1.051.000. */
async function baseline() {
  const g = await makeGroup();
  const pt = g.pt.entity.id;
  const c = g.client.id;
  await post(pt, c, dateOnly(2026, 4, 30), "1210", "3100", 50_000_000n, { kind: "OPENING" });
  for (const m of [5, 6, 7]) {
    await post(pt, c, dateOnly(2026, m, 10), "1130", "4100", 100_000_000n);
    await post(pt, c, dateOnly(2026, m, 20), "6130", "1130", 5_000_000n);
    await post(pt, c, dateOnly(2026, m, 25), "6160", "1130", 100_000n);
  }
  return { g, pt, c };
}

const byKind = async (clientId: string, entityId: string) => {
  const all = await runControls(db, clientId, 2026, 8);
  return Object.fromEntries(all.filter((x) => x.key.endsWith(`:${entityId}`)).map((x) => [x.key.split(":")[0], x]));
};

describe("ledger anomaly controls", () => {
  beforeEach(resetDb);

  it("a usual month gives the entity one PASS row and no anomaly", async () => {
    const { pt, c } = await baseline();
    await post(pt, c, dateOnly(2026, 8, 10), "1130", "4100", 104_000_000n);
    await post(pt, c, dateOnly(2026, 8, 20), "6130", "1130", 5_500_000n);
    const k = await byKind(c, pt);
    expect(k.sanity?.status).toBe("PASS");
    for (const kind of ["flux", "flip", "dormant", "dup"]) expect(k[kind]).toBeUndefined();
    expect((await scanLedger(db, c, pt, 2026, 8)).materiality).toBe(1_051_000n);
  });

  it("flags a P&L swing above materiality and ignores a large percentage on a small amount", async () => {
    const { pt, c } = await baseline();
    await post(pt, c, dateOnly(2026, 8, 10), "1130", "4100", 100_000_000n);
    await post(pt, c, dateOnly(2026, 8, 20), "6130", "1130", 12_000_000n); // +140 %, Δ 7 jt
    await post(pt, c, dateOnly(2026, 8, 25), "6160", "1130", 400_000n); // +300 %, but Δ 300 rb < materiality
    const k = await byKind(c, pt);
    expect(k.flux.status).toBe("REVIEW");
    expect(k.flux.detail).toBe("6130 Beban Listrik, Air & Internet Rp 12.000.000 vs rata-rata 3 bln Rp 5.000.000 (+140%)");
    expect(k.flux.href).toBe(`/clients/${c}/ledger/6130?period=2026-08&entity=${pt}`);
    expect(k.sanity).toBeUndefined();
  });

  it("applies the firm's Ambang fluktuasi: the Rupiah floor and the percent each unflag, the defaults equal the fixed rule", async () => {
    const { g, pt, c } = await baseline();
    await post(pt, c, dateOnly(2026, 8, 10), "1130", "4100", 100_000_000n);
    await post(pt, c, dateOnly(2026, 8, 20), "6130", "1130", 12_000_000n); // +140 %, Δ 7 jt
    const set = (fluxFloor: string, fluxPercent: string) => saveAutomation(db, { firmId: g.firm.id, settings: { transfer: true, rules: true, memory: true, cap: "", fluxFloor, fluxPercent } });
    const flagged = async () => (await scanLedger(db, c, pt, 2026, 8)).flux.map((f) => f.account.code);
    const untouched = await scanLedger(db, c, pt, 2026, 8);
    expect(untouched.thresholds).toEqual({ floor: null, percent: Number(FLUX_PERCENT), ignoredFloor: null });
    expect(DEFAULT_AUTOMATION.fluxPercent).toBe(Number(FLUX_PERCENT));
    expect(untouched.flux.map((f) => f.account.code)).toEqual(["6130"]);

    await set("", "141");
    expect(await flagged()).toEqual([]);
    expect((await byKind(c, pt)).flux).toBeUndefined();
    await set("", "140");
    expect(await flagged()).toEqual(["6130"]);
    await set("7.000.001", "50");
    expect(await flagged()).toEqual([]);
    await set("7.000.000", "50");
    expect(await flagged()).toEqual(["6130"]);
    // A floor below materiality changes nothing: max(materiality, floor).
    await set("1", "50");
    expect(await flagged()).toEqual(["6130"]);
    // Back to the defaults: the scan reads exactly as before any setting was saved.
    await set("", "50");
    expect(await scanLedger(db, c, pt, 2026, 8)).toEqual(untouched);
  });

  it("flip, dormant and duplicates and the materiality are unchanged by the flux thresholds", async () => {
    const { g, pt, c } = await baseline();
    await post(pt, c, dateOnly(2026, 8, 10), "1130", "4100", 100_000_000n);
    await post(pt, c, dateOnly(2026, 8, 20), "6130", "1130", 12_000_000n);
    await post(pt, c, dateOnly(2026, 8, 22), "4110", "1130", 2_000_000n); // flip
    await post(pt, c, dateOnly(2026, 8, 14), "6150", "1130", 3_000_000n); // dormant: never used
    await post(pt, c, dateOnly(2026, 8, 10), "6170", "2110", 3_000_000n, { memo: "a" });
    await post(pt, c, dateOnly(2026, 8, 12), "6170", "2110", 3_000_000n, { memo: "b" }); // dup
    const before = await scanLedger(db, c, pt, 2026, 8);
    expect([before.flux.length, before.flip.length, before.dormant.length, before.dup.length]).toEqual([1, 1, 4, 1]); // dormant: 4110, 6150, 6170, 2110
    await saveAutomation(db, { firmId: g.firm.id, settings: { transfer: true, rules: true, memory: true, cap: "", fluxFloor: "999.999.999.999", fluxPercent: "1000" } });
    const after = await scanLedger(db, c, pt, 2026, 8);
    expect(after.flux).toEqual([]);
    expect({ ...after, flux: before.flux, thresholds: before.thresholds }).toEqual(before);
  });

  it("a company kept in another currency ignores the Rupiah floor and keeps the percent", async () => {
    const { g, pt, c } = await baseline();
    await db.entity.update({ where: { id: pt }, data: { functionalCurrency: "USD" } });
    await post(pt, c, dateOnly(2026, 8, 10), "1130", "4100", 100_000_000n);
    await post(pt, c, dateOnly(2026, 8, 20), "6130", "1130", 12_000_000n); // Δ 7.000.000 minor units (USD 70.000)
    await saveAutomation(db, { firmId: g.firm.id, settings: { transfer: true, rules: true, memory: true, cap: "", fluxFloor: "999.999.999", fluxPercent: "50" } });
    const usd = await scanLedger(db, c, pt, 2026, 8);
    expect(usd.thresholds).toEqual({ floor: null, percent: 50, ignoredFloor: 999_999_999n });
    expect(usd.flux.map((f) => f.account.code)).toEqual(["6130"]);
    await saveAutomation(db, { firmId: g.firm.id, settings: { transfer: true, rules: true, memory: true, cap: "", fluxFloor: "999.999.999", fluxPercent: "141" } });
    expect((await scanLedger(db, c, pt, 2026, 8)).flux).toEqual([]);
  });

  it("needs two baseline months for flux", async () => {
    const g = await makeGroup();
    const pt = g.pt.entity.id;
    const c = g.client.id;
    await post(pt, c, dateOnly(2026, 7, 10), "1130", "4100", 100_000_000n);
    await post(pt, c, dateOnly(2026, 7, 20), "6130", "1130", 5_000_000n);
    await post(pt, c, dateOnly(2026, 8, 20), "6130", "1130", 50_000_000n);
    expect((await byKind(c, pt)).flux).toBeUndefined();
  });

  it("needs two baseline months on the account itself, not just on the entity", async () => {
    const { pt, c } = await baseline(); // entity active May–Jul
    await post(pt, c, dateOnly(2026, 7, 22), "6150", "1130", 2_000_000n); // 6150 moved once, in July only
    await post(pt, c, dateOnly(2026, 8, 10), "1130", "4100", 100_000_000n);
    await post(pt, c, dateOnly(2026, 8, 20), "6130", "1130", 5_000_000n);
    await post(pt, c, dateOnly(2026, 8, 22), "6150", "1130", 6_000_000n); // vs a zero-padded "average" of 667 rb
    expect((await byKind(c, pt)).flux).toBeUndefined();
  });

  it("flags P&L movement against its nature, but not rounding or FX", async () => {
    const { pt, c } = await baseline();
    await post(pt, c, dateOnly(2026, 8, 10), "1130", "4100", 100_000_000n);
    await post(pt, c, dateOnly(2026, 8, 20), "6130", "1130", 5_000_000n);
    await post(pt, c, dateOnly(2026, 8, 21), "1130", "6130", 1_000_000n); // refund within the month, still net debit
    await post(pt, c, dateOnly(2026, 8, 22), "4110", "1130", 2_000_000n); // service revenue net debit
    await post(pt, c, dateOnly(2026, 8, 23), "1130", "7190", 3_000_000n); // rounding: either side
    const k = await byKind(c, pt);
    expect(k.flip.detail).toBe("4110 Pendapatan Jasa bersaldo debit Rp 2.000.000 bulan ini");
  });

  it("tells a brand-new account from one that moves again, skipping amounts below materiality", async () => {
    const { pt, c } = await baseline();
    await post(pt, c, dateOnly(2026, 8, 10), "1130", "4100", 100_000_000n);
    await post(pt, c, dateOnly(2026, 8, 20), "6130", "1130", 5_000_000n);
    await post(pt, c, dateOnly(2026, 8, 12), "1210", "1130", 20_000_000n); // fixed asset: only an opening balance before
    await post(pt, c, dateOnly(2026, 8, 14), "6150", "1130", 3_000_000n); // marketing: never used
    await post(pt, c, dateOnly(2026, 8, 15), "6140", "1130", 500_000n); // transport: never used, below materiality
    const k = await byKind(c, pt);
    expect(k.dormant.detail).toBe("1210 Aset Tetap Rp 20.000.000, bergerak lagi setelah ≥ 3 bulan diam; 6150 Beban Pemasaran Rp 3.000.000, akun baru");
    expect(k.flux).toBeUndefined(); // an account the baseline never saw is not a swing
  });

  it("flags identical entries days apart, but not bank rows, far-apart entries or same-file rows with different memos", async () => {
    const { g, pt, c } = await baseline();
    await post(pt, c, dateOnly(2026, 8, 10), "1130", "4100", 100_000_000n);
    await post(pt, c, dateOnly(2026, 8, 20), "6130", "1130", 5_000_000n);
    await post(pt, c, dateOnly(2026, 8, 10), "6170", "2110", 3_000_000n, { memo: "Jasa konsultan" });
    await post(pt, c, dateOnly(2026, 8, 12), "6170", "2110", 3_000_000n, { memo: "Konsultan pajak Agustus" }); // double entry
    await post(pt, c, dateOnly(2026, 8, 1), "6120", "2110", 2_000_000n);
    await post(pt, c, dateOnly(2026, 8, 20), "6120", "2110", 2_000_000n); // monthly-ish, 19 days apart
    const imp = await db.ledgerImport.create({ data: { firmId: g.firm.id, clientId: c, fileName: "gl.xlsx", fileHash: "h", sheetName: "GL", mode: "LEDGER", status: "POSTED", periodStart: dateOnly(2026, 8, 1), periodEnd: dateOnly(2026, 8, 31), rowCount: 4, data: {} } });
    await post(pt, c, dateOnly(2026, 8, 15), "6190", "2110", 4_000_000n, { kind: "IMPORTED", memo: "Fee agen A", ledgerImportId: imp.id });
    await post(pt, c, dateOnly(2026, 8, 15), "6190", "2110", 4_000_000n, { kind: "IMPORTED", memo: "Fee agen B", ledgerImportId: imp.id });
    const statement = makePdf([
      [
        ...table(800, [[[40, "PT Bank Mandiri (Persero) Tbk"]], [[40, "Nomor Rekening : 2222222222"]], [[40, "Periode : 01/08/2026 - 31/08/2026"]]]),
        ...table(740, [
          [[40, "Tanggal"], [130, "Keterangan"], [360, "Debit"], [440, "Kredit"], [520, "Saldo"]],
          [[40, "01/08/2026"], [130, "SALDO AWAL"], [500, "0,00"]],
          [[40, "05/08/2026"], [130, "SETORAN TUNAI"], [430, "5.000.000,00"], [510, "5.000.000,00"]],
          [[40, "05/08/2026"], [130, "SETORAN TUNAI"], [430, "5.000.000,00"], [510, "10.000.000,00"]],
        ]),
      ],
    ]);
    await importStatement(db, { bankAccountId: g.pt.banks[1].id, fileName: "mandiri.pdf", data: statement, provider: null });
    const bank = await db.journalEntry.findMany({ where: { entityId: pt, bankTransactionId: { not: null } }, include: { lines: true } });
    expect(bank.map((e) => e.lines.map((l) => `${l.debit}/${l.credit}`).sort().join())).toEqual(["0/5000000,5000000/0", "0/5000000,5000000/0"]); // same signature
    const k = await byKind(c, pt);
    expect(k.dup.status).toBe("REVIEW");
    expect(k.dup.detail).toBe("1 pasang: 10 Agu 2026 & 12 Agu 2026 Rp 3.000.000 6170 (jurnal penyesuaian + jurnal penyesuaian)");

    // Every other flag acknowledged and the checklist ticked: the duplicate alone still blocks the close until it has a note.
    const period = await db.period.findUniqueOrThrow({ where: { clientId_year_month: { clientId: c, year: 2026, month: 8 } } });
    await db.closeSignoff.createMany({ data: CLOSE_SIGNOFFS.map((x) => ({ periodId: period.id, key: x.key })) });
    for (const x of (await runControls(db, c, 2026, 8)).filter((x) => x.status === "REVIEW" && !x.key.startsWith("dup:"))) {
      await db.controlAck.create({ data: { periodId: period.id, controlKey: x.key, note: "wajar" } });
    }
    // Earlier months (their own closing is not what this test is about) are closed, as closing goes in order.
    await db.period.updateMany({ where: { clientId: c, OR: [{ year: { lt: 2026 } }, { year: 2026, month: { lt: 8 } }] }, data: { status: "LOCKED" } });
    await expect(lockPeriod(db, c, 2026, 8, "uji")).rejects.toThrow("1 kontrol Perlu dicek belum diberi catatan");
    await db.controlAck.create({ data: { periodId: period.id, controlKey: `dup:${pt}`, note: "Dua tagihan berbeda, faktur ada" } });
    expect((await lockPeriod(db, c, 2026, 8, "uji")).status).toBe("LOCKED");
  });

  it("still scans a holding with no P&L baseline: materiality falls back to all its movement", async () => {
    const g = await makeGroup();
    const pt = g.pt.entity.id;
    const c = g.client.id;
    for (const m of [5, 6, 7]) await post(pt, c, dateOnly(2026, m, 10), "1260", "3100", 10_000_000n); // investments funded by capital
    await post(pt, c, dateOnly(2026, 8, 10), "1260", "3100", 10_000_000n, { memo: "Setoran investasi" });
    await post(pt, c, dateOnly(2026, 8, 11), "1260", "3100", 10_000_000n, { memo: "Setoran investasi" }); // entered twice
    await post(pt, c, dateOnly(2026, 8, 20), "1140", "2120", 5_000_000n); // a loan to an affiliate: new accounts
    expect((await scanLedger(db, c, pt, 2026, 8)).materiality).toBe(200_000n); // 1 % of (10 jt debit + 10 jt credit) a month
    const k = await byKind(c, pt);
    expect(k.dup.detail).toBe("1 pasang: 10 Agu 2026 & 11 Agu 2026 Rp 10.000.000 1260 (jurnal penyesuaian + jurnal penyesuaian)");
    expect(k.dormant.detail).toBe("1140 Piutang Lain-lain Rp 5.000.000, akun baru; 2120 Utang Lain-lain Rp 5.000.000, akun baru");
  });
});

