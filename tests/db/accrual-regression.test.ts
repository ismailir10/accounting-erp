import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import type { Db } from "@/lib/db";
import { accrualProposals, accrualRule, type RuleMiss } from "@/lib/adjust/accruals";
import { installments } from "@/lib/adjust/schedules";
import { ACCOUNT_CODES } from "@/lib/coa/template";
import { scanLedger } from "@/lib/controls/anomaly";
import { postJournal } from "@/lib/ledger/post";
import { dateOnly } from "@/lib/format";

/**
 * Regression (cycle 2026-10-18-usulan-akrual, the owner's ask): the per-account recurring-cost candidate that Jurnal Penyesuaian used
 * to show is gone. For ledger-fed books (imported lines, one bucket per account) the new rule must propose every case the old one
 * did, except the cases the cycle excludes on purpose: an account the new rule leaves out (HPP, tax, 7300), a history outside the
 * 25 % band, a refund month in M−4, or a median below materiality where the old average was above it. Every old case is classified,
 * and the surviving share is asserted, so the test can't pass empty.
 */

const NOW = new Date("2026-10-17T03:00:00Z");

/** The removed branch of `scheduleCandidates` (lib/adjust/candidates.ts before this cycle), kept verbatim as the oracle. */
async function legacyRecurringCost(db: Db, clientId: string, year: number, month: number) {
  const entities = await db.entity.findMany({ where: { clientId }, orderBy: { name: "asc" } });
  const codes = new Set((await db.account.findMany({ where: { clientId }, select: { code: true } })).map((a) => a.code));
  const out: { entityId: string; code: string; amount: bigint }[] = [];
  for (const e of entities) {
    const scan = await scanLedger(db, clientId, e.id, year, month);
    const floor = scan.materiality ?? 1n;
    if (scan.baseline.length === 3 && codes.has("2150")) {
      const scheduled = new Set(
        (await db.adjustmentSchedule.findMany({ where: { entityId: e.id, stoppedAt: null } }))
          .filter((s) => installments(s).some((i) => !i.reversal && i.year === year && i.month === month))
          .map((s) => s.debitAccountId),
      );
      const accounts = await db.account.findMany({ where: { clientId, type: "BEBAN", code: { notIn: [ACCOUNT_CODES.ROUNDING, ACCOUNT_CODES.FX_GAIN_LOSS] } } });
      for (const a of accounts) {
        const series = scan.series.get(a.id);
        if (!series || scheduled.has(a.id)) continue;
        const prior = series.slice(0, 3);
        if (series[3] !== 0n || prior.some((v) => v <= 0n)) continue;
        const average = prior.reduce((s, v) => s + v, 0n) / 3n;
        if (average < floor) continue;
        out.push({ entityId: e.id, code: a.code, amount: average });
      }
    }
  }
  return out;
}

/** Deterministic PRNG (mulberry32), so a failing round can be replayed. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACCOUNTS = ["5100", "5110", "6100", "6110", "6120", "6130", "6140", "6150", "6160", "6170", "6180", "6185", "6190", "7100", "7110", "7195", "7190", "7200", "7300", "8100", "8200"];
const SHAPES = ["stable4", "stable3", "wild", "refundApr", "small", "gap", "paidAug"] as const;
type Shape = (typeof SHAPES)[number];

/** April–August natural amounts (minor units) for a shape: base B, ± up to 10 % (stable: always inside the band) or one month × 1,6 (wild). */
function series(shape: Shape, r: () => number): bigint[] {
  const base = shape === "small" ? 400_000 + Math.floor(r() * 1_200_000) : 1_000_000 + Math.floor(r() * 20_000_000);
  const around = () => BigInt(Math.round(base * (0.9 + r() * 0.2)));
  const s = [around(), around(), around(), around(), 0n];
  if (shape === "stable3") s[0] = 0n;
  if (shape === "wild") s[1 + Math.floor(r() * 3)] = BigInt(Math.round(base * 1.6));
  if (shape === "refundApr") s[0] = -BigInt(Math.round(base * 0.3));
  if (shape === "gap") s[1 + Math.floor(r() * 3)] = 0n;
  if (shape === "paidAug") s[4] = around();
  return s;
}

/** Why the new rule may drop an old case, by design; null = it must be proposed. */
function excluded(code: string, fsLine: string, amounts: bigint[], floor: bigint): RuleMiss | "account" | null {
  if (!["BEBAN_UMUM_ADM", "BEBAN_PENJUALAN", "BEBAN_LAIN"].includes(fsLine) || code === ACCOUNT_CODES.DISPOSAL_GAIN_LOSS) return "account";
  const rule = accrualRule(amounts, floor);
  return rule.ok ? null : rule.why;
}

describe("the recurring-cost candidate's removal (ledger-fed books)", () => {
  beforeEach(resetDb);

  it("loses no case it used to propose, other than the exclusions the cycle decided", async () => {
    const tally = { kept: 0, account: 0, band: 0, refund: 0, material: 0, few: 0 };
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      await resetDb();
      const r = rng(seed);
      const g = await makeGroup();
      const pt = g.pt.entity.id;
      const accounts = new Map((await db.account.findMany({ where: { clientId: g.client.id } })).map((a) => [a.code, a]));
      const gl = await db.ledgerImport.create({ data: { firmId: g.firm.id, clientId: g.client.id, fileName: `gl-${seed}.xlsx`, fileHash: `h${seed}`, sheetName: "GL", mode: "LEDGER", status: "POSTED", periodStart: dateOnly(2026, 4, 1), periodEnd: dateOnly(2026, 8, 31), rowCount: 1, data: {} } });
      let row = 2;
      const post = (m: number, dr: string, cr: string, amount: bigint) =>
        db.$transaction((tx) =>
          postJournal(tx, { entityId: pt, date: dateOnly(2026, m, 20), kind: "IMPORTED", memo: `GL ${dr}`, ledgerImportId: gl.id, sourceRef: `GL!${row++}`, lines: [{ accountId: accounts.get(dr)!.id, debit: amount }, { accountId: accounts.get(cr)!.id, credit: amount }] }),
        );
      // Revenue every month (the scan's baseline and August's completeness), then each account's series.
      for (const m of [4, 5, 6, 7, 8]) await post(m, "1130", "4100", 150_000_000n);
      for (const code of ACCOUNTS) {
        const s = series(SHAPES[Math.floor(r() * SHAPES.length)], r);
        for (const [i, v] of s.entries()) if (v !== 0n) await (v > 0n ? post(4 + i, code, "2110", v) : post(4 + i, "2110", code, -v));
      }

      const old = await legacyRecurringCost(db, g.client.id, 2026, 8);
      const now = (await accrualProposals(db, g.client.id, 2026, 8, { now: NOW })).filter((p) => p.bucket.kind === "ledger");
      const floor = (await scanLedger(db, g.client.id, pt, 2026, 8)).materiality!;
      for (const o of old) {
        const a = accounts.get(o.code)!;
        const amounts = await Promise.all([4, 5, 6, 7].map(async (m) => {
          const lines = await db.journalLine.findMany({ where: { entityId: pt, accountId: a.id, date: { gte: dateOnly(2026, m, 1), lte: dateOnly(2026, m + 1, 0) } } });
          return lines.reduce((s, l) => s + l.debit - l.credit, 0n);
        }));
        const why = excluded(o.code, a.fsLine, amounts, floor);
        const proposed = now.find((p) => p.account.code === o.code);
        if (why === null) {
          // Kept: proposed on the same account, its amount one month's own (the median, no longer the average).
          expect(proposed, `seed ${seed} account ${o.code} ${amounts.join("/")}`).toBeDefined();
          expect(amounts).toContain(proposed!.amount);
          tally.kept++;
        } else {
          expect(proposed, `seed ${seed} account ${o.code} excluded as ${why}`).toBeUndefined();
          tally[why]++;
        }
      }
    }
    // The old rule needed three positive baseline months, so "too few months" never drops one of its cases.
    expect(tally.few).toBe(0);
    // Non-vacuous: most old cases survive; the rest are only the decided exclusions.
    expect(tally.kept).toBeGreaterThanOrEqual(15);
    expect([tally.account, tally.band, tally.refund].every((n) => n > 0)).toBe(true);
  });
});
