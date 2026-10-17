import { db, makeGroup } from "./helpers";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction } from "@/lib/review";

/**
 * Usulan akrual (cycle 2026-10-18-usulan-akrual): the QA books its tests share, built through the real import pipeline. Generic CSV
 * statements with a declared period (statement coverage needs one, rule 22c).
 */

/** 17 Okt 2026, 10.00 WIB: every month up to September has ended. */
export const NOW = new Date("2026-10-17T03:00:00Z");
const pad = (n: number) => String(n).padStart(2, "0");
const day = (y: number, m: number, d: number) => `${pad(d)}/${pad(m)}/${y}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Running balance per bank account, so each month's statement continues the last one. */
export const balances = new Map<string, bigint>();
export type Row = [d: number, text: string, amount: bigint];

/** One statement of `from`–`until` of the month: money out positive, money in negative. */
export async function statement(bankAccountId: string, y: number, m: number, rows: Row[], until = lastDay(y, m), from = 1) {
  let bal = balances.get(bankAccountId) ?? 1_000_000_000n;
  const lines = [`Periode : ${day(y, m, from)} - ${day(y, m, until)}`, "Tanggal;Keterangan;Debet;Kredit;Saldo", `${day(y, m, from)};SALDO AWAL;;;${bal}`];
  for (const [d, text, amount] of [...rows].sort((a, b) => a[0] - b[0])) {
    bal -= amount;
    lines.push(`${day(y, m, d)};${text};${amount > 0n ? amount : 0n};${amount < 0n ? -amount : 0n};${bal}`);
  }
  balances.set(bankAccountId, bal);
  return importStatement(db, { bankAccountId, fileName: `mutasi-${y}-${m}-${from}-${until}-${bankAccountId.slice(-4)}.csv`, data: Buffer.from(`${lines.join("\n")}\n`), provider: null });
}

export const BERSIH = "PT BERSIH PRIMA JASA KEBERSIHAN";
export const PLN = "PLN POSTPAID";
export const TELKOM = "TELKOM INDIHOME";
export const ANDALAS = "KANTOR KONSULTAN ANDALAS";
export const jt = (n: number) => BigInt(Math.round(n * 1_000_000));

/**
 * The QA client of the verify flows: one BCA account, April–August 2026. Bersih Prima pays 4,2 / 4,2 / 4,35 / 4,2 jt to 6190 April–July;
 * PLN and Telkom both pay to 6130, only PLN in August; Andalas pays 7,5 jt to 6170 May–July (its first line reviewed by hand, a RECLASS;
 * later ones by Memory). Materiality ≈ Rp 145.000 (no revenue: 1 % of the expenses).
 */
export async function qaBooks(opts: { august?: Row[] } = {}) {
  balances.clear();
  const g = await makeGroup();
  await db.rule.createMany({
    data: [
      { pattern: "BERSIH PRIMA", direction: "OUT" as const, accountCode: "6190" },
      { pattern: "PLN POSTPAID", direction: "OUT" as const, accountCode: "6130" },
      { pattern: "TELKOM", direction: "OUT" as const, accountCode: "6130" },
    ].map((r) => ({ ...r, firmId: g.firm.id, clientId: g.client.id, priority: 50 })),
  });
  const bca = g.pt.banks[0].id;
  const months: [number, Row[]][] = [
    [4, [[10, BERSIH, jt(4.2)], [12, PLN, jt(2.1)], [14, TELKOM, jt(0.5)]]],
    [5, [[10, BERSIH, jt(4.2)], [12, PLN, jt(2.3)], [14, TELKOM, jt(0.5)], [20, ANDALAS, jt(7.5)]]],
    [6, [[10, BERSIH, jt(4.35)], [12, PLN, jt(2.2)], [14, TELKOM, jt(0.5)], [20, ANDALAS, jt(7.5)]]],
    [7, [[10, BERSIH, jt(4.2)], [12, PLN, jt(2.25)], [14, TELKOM, jt(0.5)], [20, ANDALAS, jt(7.5)]]],
    [8, opts.august ?? [[12, PLN, jt(2.4)]]],
  ];
  for (const [m, rows] of months) {
    await statement(bca, 2026, m, rows);
    // Andalas has no rule: the accountant files the first one, Memory files the rest.
    for (const t of await db.bankTransaction.findMany({ where: { entityId: g.pt.entity.id, description: ANDALAS, status: "NEEDS_REVIEW" } })) {
      await reviewTransaction(db, { bankTxId: t.id, accountCode: "6170", taxTag: null });
    }
  }
  return { g, bca };
}
