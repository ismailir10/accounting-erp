import type { Db } from "@/lib/db";
import type { ScheduleKind } from "@/lib/generated/prisma/enums";
import { formatDate, periodBounds } from "@/lib/format";
import { scanLedger } from "@/lib/controls/anomaly";

/**
 * Candidates for new adjustment schedules, read from the period's ledger (deterministic, cycle adjustment-schedules).
 * Shown as suggestions with a prefilled form; nothing is created until the accountant clicks, and they never block the
 * close. A candidate disappears once a schedule covers its source line. Accruals are not candidates: a recurring cost missing this
 * month is proposed per counterparty in Kotak persetujuan (lib/adjust/accruals.ts, cycle 2026-10-18-usulan-akrual).
 */

export const DEFAULT_MONTHS: Record<ScheduleKind, number> = { DEPRECIATION: 48, AMORTIZATION: 12, ACCRUAL: 1 };
const DEPRECIATION_EXPENSE = "6180";
const ACCUMULATED_DEPRECIATION = "1219";
const DEFERRED_REVENUE = "2160";
const SERVICE_REVENUE = "4110";
const DEFERRED_NAME = /diterima di muka|unearned|deferred revenue/i;

export type Candidate = {
  key: string;
  kind: ScheduleKind;
  entity: { id: string; shortName: string; functionalCurrency: string };
  /** What the ledger shows, e.g. "Pembelian aset tetap 19 Agu 2026". */
  reason: string;
  memo: string;
  /** null = the accountant picks (the expense a prepayment is amortised into). */
  debitCode: string | null;
  creditCode: string;
  amount: bigint;
  months: number;
  startYear: number;
  startMonth: number;
  sourceEntryId: string | null;
};

function next(year: number, month: number) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

export async function scheduleCandidates(db: Db, clientId: string, year: number, month: number): Promise<Candidate[]> {
  const { start, end } = periodBounds(year, month);
  const entities = await db.entity.findMany({ where: { clientId }, orderBy: { name: "asc" } });
  const codes = new Set((await db.account.findMany({ where: { clientId }, select: { code: true } })).map((a) => a.code));
  const nm = next(year, month);
  const out: Candidate[] = [];
  for (const e of entities) {
    const ent = { id: e.id, shortName: e.shortName, functionalCurrency: e.functionalCurrency };
    const scan = await scanLedger(db, clientId, e.id, year, month);
    const floor = scan.materiality ?? 1n;
    const lines = await db.journalLine.findMany({
      where: {
        entityId: e.id,
        date: { gte: start, lte: end },
        // Lease journals depreciate through the lease register (rule 5f), never a schedule.
        entry: { kind: { not: "OPENING" }, scheduleId: null, leaseCommenced: null, leaseCancelled: null, leasePosting: null },
        OR: [{ account: { fsLine: { in: ["ASET_TETAP", "BIAYA_DIBAYAR_DIMUKA"] } } }, { account: { code: DEFERRED_REVENUE } }, ...["diterima di muka", "unearned", "deferred revenue"].map((w) => ({ account: { type: "LIABILITAS" as const, name: { contains: w, mode: "insensitive" as const } } }))],
      },
      include: { account: true, entry: { select: { id: true, memo: true, date: true, bankTransaction: { select: { description: true } } } } },
      orderBy: [{ date: "asc" }, { id: "asc" }],
    });
    // One candidate per source entry and account, on the net movement of that entry.
    const groups = new Map<string, { line: (typeof lines)[number]; net: bigint }>();
    for (const l of lines) {
      const k = `${l.entryId}|${l.accountId}`;
      const g = groups.get(k) ?? { line: l, net: 0n };
      g.net += l.debit - l.credit;
      groups.set(k, g);
    }
    // A schedule made from an entry covers only the line it came from, so a compound entry's other lines stay proposed. Schedules are
    // matched to lines one to one: a schedule covers at most one line, and a line is covered by one schedule.
    const from = await db.adjustmentSchedule.findMany({ where: { entityId: e.id, sourceEntryId: { in: [...new Set(lines.map((l) => l.entryId))] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const coveredLines = new Set<string>();
    const words = (memo: string) => new Set(memo.toLowerCase().split(/\s+/));
    const mentions = (memo: string, g: { line: (typeof lines)[number] }) => words(memo).has(g.line.account.code.toLowerCase()) || memo.toLowerCase().includes(g.line.account.name.toLowerCase());
    const size = (net: bigint) => (net < 0n ? -net : net);
    for (const entryId of new Set(lines.map((l) => l.entryId))) {
      const inEntry = [...groups.entries()].filter(([, g]) => g.line.entryId === entryId);
      const assets = inEntry.filter(([, g]) => g.line.account.fsLine === "ASET_TETAP");
      // Only movements that could be a candidate: a prepayment paid (debit), deferred revenue received (credit). A prepayment
      // credited away (e.g. reclassed into a fixed asset) is no line a schedule was made from.
      const others = inEntry.filter(([, g]) => g.line.account.fsLine !== "ASET_TETAP" && (g.line.account.fsLine === "BIAYA_DIBAYAR_DIMUKA" ? g.net > 0n : g.net < 0n));
      const cited = from.filter((x) => x.sourceEntryId === entryId);
      // A schedule that stores its source line covers exactly that line.
      for (const s of cited.filter((x) => x.sourceAccountId)) {
        const k = `${entryId}|${s.sourceAccountId}`;
        if (groups.has(k)) coveredLines.add(k);
      }
      // Schedules made before the line was stored are matched by what they carry. Those that name their line's account go first,
      // so a depreciation is weighed only against the lines still open.
      const legacy = cited.filter((x) => !x.sourceAccountId);
      for (const s of [...legacy.filter((x) => x.kind !== "DEPRECIATION"), ...legacy.filter((x) => x.kind === "DEPRECIATION")]) {
        // A prepayment is released by crediting its account, deferred revenue by debiting it: only a schedule with the account on
        // that side can cover the line (one on the other side would grow the balance). When a schedule fits two such lines (it
        // credits a prepayment and debits deferred revenue), its memo, then its amount, picks the one it came from.
        const fits = others
          .filter(([k]) => !coveredLines.has(k))
          .filter(([, g]) => (g.line.account.fsLine === "BIAYA_DIBAYAR_DIMUKA" ? s.creditAccountId : s.debitAccountId) === g.line.accountId);
        const released = fits.find(([, g]) => mentions(s.memo, g)) ?? fits.find(([, g]) => size(g.net) === s.amount) ?? fits[0];
        let hit = released;
        if (s.kind === "DEPRECIATION") {
          // A depreciation hides only the asset line it identifies, never one it merely might be: first by the account code its memo
          // carries (a schedule made from a candidate keeps "Penyusutan <code> <account> <date>", the code never cut off, whatever
          // amount it was given), then by the account name (longest first). Its amount identifies an asset line only when it doesn't
          // also point at another line of the entry (e.g. a prepayment candidate turned into a depreciation). An entry with a single
          // asset line needs no memo: a schedule citing it covers that line (older schedules carry custom memos and adjusted
          // amounts), on the same condition. A schedule that identifies no line hides none, so at worst a suggestion stays visible.
          const open = assets.filter(([k]) => !coveredLines.has(k));
          const coded = open.filter(([, g]) => words(s.memo).has(g.line.account.code.toLowerCase()));
          const named = open.filter(([, g]) => s.memo.toLowerCase().includes(g.line.account.name.toLowerCase())).sort(([, x], [, y]) => y.line.account.name.length - x.line.account.name.length);
          // A memo naming another line always points away; an equal amount only while that line is still open.
          const elsewhere = others.some(([k, g]) => mentions(s.memo, g) || (!coveredLines.has(k) && size(g.net) === s.amount));
          const byAmount = elsewhere ? undefined : (open.find(([, g]) => g.net === s.amount) ?? (assets.length === 1 && open.length === 1 ? open[0] : undefined));
          hit = coded[0] ?? named.find(([, g]) => g.net === s.amount) ?? named[0] ?? byAmount ?? released;
        }
        if (hit) coveredLines.add(hit[0]);
      }
    }
    for (const [k, { line: l, net }] of groups) {
      if (coveredLines.has(k)) continue;
      const when = formatDate(l.entry.date);
      // What happened, in the source's words: the bank description for a reviewed bank line, else the journal memo.
      const what = (l.entry.bankTransaction?.description ?? l.memo ?? l.entry.memo).replace(/^Reklasifikasi:\s*/i, "").slice(0, 90);
      const label = `${l.account.name} ${when}`;
      const base = { entity: ent, sourceEntryId: l.entry.id, startYear: nm.year, startMonth: nm.month };
      // The depreciation memo leads with the account code: it survives the 80-character cut and identifies the line of a schedule made before the line was stored (see the matching above).
      if (l.account.fsLine === "ASET_TETAP" && net >= floor && codes.has(DEPRECIATION_EXPENSE) && codes.has(ACCUMULATED_DEPRECIATION)) {
        out.push({ ...base, key: `DEPRECIATION:${e.id}:${l.entry.id}:${l.account.code}`, kind: "DEPRECIATION", reason: `Pembelian ${l.account.code} ${l.account.name} ${when}: ${what}`, memo: `Penyusutan ${l.account.code} ${label}`.slice(0, 80), debitCode: DEPRECIATION_EXPENSE, creditCode: ACCUMULATED_DEPRECIATION, amount: net, months: DEFAULT_MONTHS.DEPRECIATION });
      } else if (l.account.fsLine === "BIAYA_DIBAYAR_DIMUKA" && net >= floor) {
        out.push({ ...base, key: `AMORTIZATION:${e.id}:${l.entry.id}:${l.account.code}`, kind: "AMORTIZATION", reason: `Dibayar di muka ke ${l.account.code} ${when}: ${what}`, memo: `Amortisasi ${label}`.slice(0, 80), debitCode: null, creditCode: l.account.code, amount: net, months: DEFAULT_MONTHS.AMORTIZATION });
      } else if (l.account.type === "LIABILITAS" && (l.account.code === DEFERRED_REVENUE || DEFERRED_NAME.test(l.account.name)) && -net >= floor && codes.has(SERVICE_REVENUE)) {
        out.push({ ...base, key: `AMORTIZATION:${e.id}:${l.entry.id}:${l.account.code}`, kind: "AMORTIZATION", reason: `Diterima di muka ke ${l.account.code} ${when}: ${what}`, memo: `Pengakuan ${label}`.slice(0, 80), debitCode: l.account.code, creditCode: SERVICE_REVENUE, amount: -net, months: DEFAULT_MONTHS.AMORTIZATION });
      }
    }
  }
  return out;
}
