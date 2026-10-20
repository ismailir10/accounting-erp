import type { Db } from "@/lib/db";
import type { WithholdingKind } from "@/lib/generated/prisma/enums";
import { dateOnly, formatDate, formatPeriod, periodBounds } from "@/lib/format";
import { formatRupiah } from "@/lib/money";
import { WITHHOLDING_LABEL } from "@/lib/tax/withholding";
import { formatTerRate, PTKP_LABEL, pph21Annual, pph21Ter, type Pph21Annual, type PtkpStatus, type TerCategory } from "@/lib/tax/ter";
import { defaultTaxMonth } from "@/lib/tax/masa";
import { instalmentFor, instalments, type Instalment } from "@/lib/tax/instalment";

/**
 * Pajak masa of one company and month (I4c, accounting-rules 5j): PPN, PPh 21, PPh 23 and the other withholdings, each judged on what
 * was booked for the masa and the bank payments filed to its account by the due date; the bukti potong of the month (Unifikasi); and
 * the PPh 21 TER estimate from the census. Read from the GL at request time; nothing stored, nothing posted.
 */
export type MasaKey = "PPN" | "PPH_21" | "PPH_23" | "PPH_LAIN";
type Masa = { year: number; month: number };

const TAXES: { key: MasaKey; label: string; code: string }[] = [
  { key: "PPN", label: "PPN", code: "2130" },
  { key: "PPH_21", label: "PPh 21", code: "2140" },
  { key: "PPH_23", label: "PPh 23", code: "2141" },
  { key: "PPH_LAIN", label: "PPh 4(2), 22 & 26", code: "2145" },
];
const PPN_MASUKAN = "1150";

/**
 * The PPN compensation journal of a masa (Dr 2130 PPN Keluaran / Cr 1150 PPN Masukan, `postPpnOffset`) carries this prefix in its
 * `sourceRef`. It moves PPN between the two accounts and is neither keluaran nor masukan, so every per-masa sum skips it.
 */
export const PPN_OFFSET_REF = "ppn-offset:";
/** Prisma filter for journal entries other than a PPN compensation (a null sourceRef included). */
export const notPpnOffset = { OR: [{ sourceRef: null }, { NOT: { sourceRef: { startsWith: PPN_OFFSET_REF } } }] };

const shift = (m: Masa, by: number): Masa => {
  const i = m.year * 12 + m.month - 1 + by;
  return { year: Math.floor(i / 12), month: (i % 12) + 1 };
};
const keyOf = (m: Masa) => m.year * 12 + m.month;

/** Setor deadline of a masa (PMK 81/2024): PPh by the 15th of the next month, PPN by the end of it. A holiday moves it to the next working day; Buku does not shift it. */
export function dueDate(key: MasaKey, masa: Masa): Date {
  const next = shift(masa, 1);
  return key === "PPN" ? periodBounds(next.year, next.month).end : dateOnly(next.year, next.month, 15);
}

export type Payment = { date: Date; amount: bigint };
export type PreviousMasa = {
  masa: Masa;
  owed: bigint;
  due: Date;
  /** Bank payments filed to the account after the masa before it fell due, up to this one's due date. */
  paid: Payment[];
  /** Paid after the due date (within the report month), covering a shortfall. */
  late: Payment[];
  /** Still unpaid at the end of the report month. */
  short: bigint;
  state: "NIHIL" | "LUNAS" | "LEBIH" | "TERLAMBAT" | "KURANG" | "BELUM_JATUH_TEMPO";
};
export type MasaRow = {
  key: MasaKey;
  label: string;
  code: string;
  /** Booked for this masa: credits net of non-payment debits (PPN: keluaran − masukan − lebih bayar carried in, never below zero). */
  owed: bigint;
  due: Date;
  /** PPN only: the month's keluaran and masukan, and the lebih bayar carried in and out. `offset`: PPN masukan still to compensate
   *  against keluaran at the masa end (1150's balance less the lebih bayar carried out; negative = compensated too much); none when a
   *  compensation is already journalled after this masa (`offsetLater`). */
  ppn: { keluaran: bigint; masukan: bigint; carryIn: bigint; carryOut: bigint; offset: bigint; offsetLater: Date | null } | null;
  previous: PreviousMasa;
  /** Paid in the report month toward this masa (after the previous one was covered). */
  paidAhead: bigint;
  /** Month-end balance owed (PPN: 2130 less 1150). */
  balance: bigint;
  /** The part of the balance not explained by this masa or the previous one's shortfall: older arrears (> 0) or an overpayment (< 0). */
  other: bigint;
  /** PPh 21 remitted with nothing booked as withheld this masa or the last: payroll was likely booked net to salary expense. */
  netPayroll: boolean;
  status: "PASS" | "REVIEW";
};

export type WithholdingLine = {
  id: string;
  date: Date;
  direction: "IN" | "OUT";
  kind: WithholdingKind;
  description: string;
  contact: { name: string; npwp: string | null } | null;
  cash: bigint;
  withheld: bigint;
  gross: bigint;
  inReview: boolean;
};

export type TerEmployee = { id: string; name: string; employeeNo: string | null; status: PtkpStatus; category: TerCategory; wage: bigint; rate: number; tax: bigint };
/** December: an employee's year recomputed under Pasal 17 (`pph21Annual`). */
export type AnnualEmployee = { id: string; name: string; employeeNo: string | null; status: PtkpStatus; wage: bigint } & Pph21Annual;
export type TerCheck =
  | { state: "NO_EMPLOYEES" }
  | { state: "NO_STATUS"; missing: number }
  /** `leavers`: employees whose last day falls in the masa; their last masa is the Pasal 17 recompute (PMK 168/2023), not TER. */
  | { state: "CHECKED"; employees: TerEmployee[]; leavers: AnnualEmployee[]; missing: number; estimate: bigint; booked: bigint; status: "PASS" | "REVIEW" }
  | { state: "ANNUAL"; employees: AnnualEmployee[]; missing: number; estimate: bigint; booked: bigint; status: "PASS" | "REVIEW" };

/**
 * PPh 25 angsuran: the masa due in the report month (the 15th), judged on the bank lines tagged PPH_25 for it (by masa pajak, else the
 * month before payment) against the instalment in force; and the report masa, due the 15th of the next month. `expected` null = no
 * instalment set, so the amount can't be judged ("DISETOR" when something was paid, "BELUM_DIISI" when not).
 */
export type Pph25 = {
  previous: { masa: Masa; expected: bigint | null; due: Date; paid: Payment[]; late: Payment[]; short: bigint; state: PreviousMasa["state"] | "DISETOR" | "BELUM_DIISI" };
  current: { masa: Masa; expected: bigint | null; due: Date; paid: Payment[] };
  /** The instalment in force for the report masa (and every one set, for the form). */
  instalment: Instalment | null;
  instalments: Instalment[];
  status: "PASS" | "REVIEW";
};

export type MasaReport = {
  entity: { id: string; name: string; shortName: string; npwp: string | null };
  masa: Masa;
  rows: MasaRow[];
  /** Null under PP 55 (final), and for a company with no instalment set and no PPh 25 paid for these two masa. */
  pph25: Pph25 | null;
  withheldByUs: WithholdingLine[];
  withheldFromUs: WithholdingLine[];
  ter: TerCheck;
};

type Line = { code: string; date: Date; debit: bigint; credit: bigint; opening: boolean; payment: boolean; offset: boolean };

export async function masaReport(db: Db, input: { clientId: string; entityId: string; year: number; month: number; now?: Date }): Promise<MasaReport | null> {
  const { clientId, entityId, year, month } = input;
  const now = input.now ?? new Date();
  const entity = await db.entity.findFirst({ where: { id: entityId, clientId }, select: { id: true, name: true, shortName: true, npwp: true } });
  if (!entity) return null;
  const masa = { year, month };
  const prev = shift(masa, -1);
  const { start, end } = periodBounds(year, month);
  const codes = [...TAXES.map((t) => t.code), PPN_MASUKAN];
  const accounts = await db.account.findMany({ where: { clientId, code: { in: codes } }, select: { id: true, code: true } });
  const codeOf = new Map(accounts.map((a) => [a.id, a.code]));
  // From the company's first tax line (at the latest January of the previous masa's year): the PPN lebih bayar carried forward is rebuilt
  // from there, across year ends, as a December lebih bayar is compensated in January and on.
  const first = await db.journalLine.findFirst({ where: { entityId, accountId: { in: accounts.map((a) => a.id) } }, orderBy: { date: "asc" }, select: { date: true } });
  const yearStart = dateOnly(prev.year, 1, 1);
  const from = first && +first.date < +yearStart ? dateOnly(first.date.getUTCFullYear(), first.date.getUTCMonth() + 1, 1) : yearStart;
  // An opening line belongs to the masa before its date (owedIn below): start the chain one month earlier so it is counted.
  const chainStart = shift({ year: from.getUTCFullYear(), month: from.getUTCMonth() + 1 }, -1);
  const raw = await db.journalLine.findMany({
    where: { entityId, accountId: { in: accounts.map((a) => a.id) }, date: { gte: from, lte: end } },
    select: { accountId: true, date: true, debit: true, credit: true, entry: { select: { kind: true, sourceRef: true, lines: { where: { credit: { gt: 0 }, account: { isBank: true } }, select: { id: true }, take: 1 } } } },
  });
  const lines: Line[] = raw.map((l) => ({ code: codeOf.get(l.accountId)!, date: l.date, debit: l.debit, credit: l.credit, opening: l.entry.kind === "OPENING", payment: l.debit > 0n && l.entry.lines.length > 0, offset: l.entry.sourceRef?.startsWith(PPN_OFFSET_REF) ?? false }));
  // Balances through the month end (all time, openings included).
  const balances = await db.journalLine.groupBy({ by: ["accountId"], where: { entityId, accountId: { in: accounts.map((a) => a.id) }, date: { lte: end } }, _sum: { debit: true, credit: true } });
  const credit = (code: string) => {
    const b = balances.find((x) => codeOf.get(x.accountId) === code);
    return (b?._sum.credit ?? 0n) - (b?._sum.debit ?? 0n);
  };
  const inMasa = (d: Date, m: Masa) => d.getUTCFullYear() === m.year && d.getUTCMonth() + 1 === m.month;
  // An opening balance is what was owed as the books start: it belongs to the masa before its date (an opening "per 28 Februari" or
  // "per 1 Maret" is February's tax), so the first remittance reads as paying it.
  const owedIn = (l: Line, m: Masa) => inMasa(l.opening ? new Date(+l.date - 86_400_000) : l.date, m);
  const sum = (xs: bigint[]) => xs.reduce((s, v) => s + v, 0n);
  const offsetLater = (await db.journalEntry.findFirst({ where: { entityId, sourceRef: { startsWith: PPN_OFFSET_REF }, date: { gt: end } }, orderBy: { date: "asc" }, select: { date: true } }))?.date ?? null;

  const rows: MasaRow[] = TAXES.map((t) => {
    const own = lines.filter((l) => l.code === t.code);
    let owedOf: (m: Masa) => bigint;
    let ppn: MasaRow["ppn"] = null;
    if (t.key === "PPN") {
      // Keluaran − masukan per masa, a lebih bayar carried to the next masa (restitusi is not modelled).
      const masukan = lines.filter((l) => l.code === PPN_MASUKAN);
      const owed = new Map<number, { keluaran: bigint; masukan: bigint; carryIn: bigint; carryOut: bigint; owed: bigint }>();
      let carry = 0n;
      for (let m: Masa = keyOf(chainStart) < keyOf({ year: prev.year, month: 1 }) ? chainStart : { year: prev.year, month: 1 }; keyOf(m) <= keyOf(masa); m = shift(m, 1)) {
        // Net of corrections: a reclass that takes PPN back off (Dr 2130, Cr 1150) lowers the masa; a remittance to 2130 is a payment, not
        // keluaran. On 1150 a purchase's own bank credit is not a payment, so masukan nets every line of the month. The compensation
        // journal is neither.
        const k = sum(own.filter((l) => !l.payment && !l.offset && owedIn(l, m)).map((l) => l.credit - l.debit));
        const mk = sum(masukan.filter((l) => !l.offset && owedIn(l, m)).map((l) => l.debit - l.credit));
        const net = k - mk - carry;
        owed.set(keyOf(m), { keluaran: k, masukan: mk, carryIn: carry, carryOut: net < 0n ? -net : 0n, owed: net > 0n ? net : 0n });
        carry = net < 0n ? -net : 0n;
      }
      owedOf = (m) => owed.get(keyOf(m))?.owed ?? 0n;
      const cur = owed.get(keyOf(masa))!;
      // What compensation leaves on 1150 is the lebih bayar carried forward; the rest of its balance goes against 2130.
      const offset = offsetLater ? 0n : -credit(PPN_MASUKAN) - cur.carryOut;
      ppn = { keluaran: cur.keluaran, masukan: cur.masukan, carryIn: cur.carryIn, carryOut: cur.carryOut, offset, offsetLater };
    } else {
      owedOf = (m) => sum(own.filter((l) => !l.payment && owedIn(l, m)).map((l) => l.credit - l.debit));
    }
    const payments = own.filter((l) => l.payment).map((l) => ({ date: l.date, amount: l.debit }));
    const prevDue = dueDate(t.key, prev);
    const windowStart = dueDate(t.key, shift(prev, -1));
    const owedPrev = owedOf(prev);
    const paid = payments.filter((p) => +p.date > +windowStart && +p.date <= +prevDue);
    const paidSum = sum(paid.map((p) => p.amount));
    const after = payments.filter((p) => +p.date > +prevDue && +p.date <= +end).sort((a, b) => +a.date - +b.date);
    // Payments after the due date first cover the previous masa's shortfall; the rest is paid ahead toward this masa.
    let gap = owedPrev > paidSum ? owedPrev - paidSum : 0n;
    const late: Payment[] = [];
    let paidAhead = 0n;
    for (const p of after) {
      const take = p.amount < gap ? p.amount : gap;
      if (take > 0n) late.push({ date: p.date, amount: take });
      gap -= take;
      paidAhead += p.amount - take;
    }
    const state: PreviousMasa["state"] =
      owedPrev === 0n && paidSum === 0n ? "NIHIL"
      : gap > 0n ? (+now <= +prevDue ? "BELUM_JATUH_TEMPO" : "KURANG")
      : late.length ? "TERLAMBAT"
      : paidSum > owedPrev ? "LEBIH"
      : "LUNAS";
    const owed = owedOf(masa);
    const balance = t.key === "PPN" ? credit("2130") + credit(PPN_MASUKAN) : credit(t.code);
    const expected = owed - (ppn?.carryOut ?? 0n) - paidAhead + gap;
    const other = balance - expected;
    const netPayroll = t.key === "PPH_21" && paidSum + sum(after.map((p) => p.amount)) > 0n && owed === 0n && owedPrev === 0n;
    const review = state === "KURANG" || state === "TERLAMBAT" || other !== 0n || netPayroll;
    return {
      key: t.key,
      label: t.label,
      code: t.code,
      owed,
      due: dueDate(t.key, masa),
      ppn,
      previous: { masa: prev, owed: owedPrev, due: prevDue, paid, late, short: gap, state },
      paidAhead,
      balance,
      other,
      netPayroll,
      status: review ? "REVIEW" : "PASS",
    };
  });

  const txs = await db.bankTransaction.findMany({
    // Unifikasi only: PPh 21 (employees and other individuals) is reported per recipient in e-Bupot 21/26, and the PPh 21 row covers it.
    where: { entityId, date: { gte: start, lte: end }, whtKind: { not: null, notIn: ["PPH_21"] }, whtAmount: { gt: 0n } },
    include: { contact: { select: { name: true, npwp: true } } },
    orderBy: [{ date: "asc" }, { rowNumber: "asc" }],
  });
  const wht: WithholdingLine[] = txs.map((t) => {
    const cash = t.amount < 0n ? -t.amount : t.amount;
    return { id: t.id, date: t.date, direction: t.direction, kind: t.whtKind!, description: t.description, contact: t.contact, cash, withheld: t.whtAmount, gross: cash + t.whtAmount, inReview: t.status === "NEEDS_REVIEW" };
  });

  return {
    entity,
    masa,
    rows,
    withheldByUs: wht.filter((w) => w.direction === "OUT"),
    withheldFromUs: wht.filter((w) => w.direction === "IN"),
    pph25: await pph25Check(db, { clientId, entityId, masa, now }),
    ter: await terCheck(db, { clientId, entityId, masa, booked: rows.find((r) => r.key === "PPH_21")!.owed }),
  };
}

async function pph25Check(db: Db, input: { clientId: string; entityId: string; masa: Masa; now: Date }): Promise<Pph25 | null> {
  const { masa, now } = input;
  const regime = (await db.taxYear.findUnique({ where: { entityId_year: { entityId: input.entityId, year: masa.year } }, select: { regime: true } }))?.regime;
  if (regime === "FINAL_UMKM") return null;
  const prev = shift(masa, -1);
  const { end } = periodBounds(masa.year, masa.month);
  const list = await instalments(db, input.entityId);
  // Payments for either masa: made from the start of the masa before through the end of the report month (paid ahead or in arrears).
  const lines = await db.bankTransaction.findMany({
    where: { entityId: input.entityId, taxTag: "PPH_25", direction: "OUT", status: { not: "NEEDS_REVIEW" }, date: { gte: dateOnly(prev.year, prev.month, 1), lte: end } },
    orderBy: [{ date: "asc" }, { rowNumber: "asc" }],
    select: { date: true, amount: true, taxMonth: true },
  });
  const forMasa = (m: Masa) =>
    lines
      .filter((t) => {
        const k = t.taxMonth ?? defaultTaxMonth(t.date);
        return k.getUTCFullYear() === m.year && k.getUTCMonth() + 1 === m.month;
      })
      .map((t) => ({ date: t.date, amount: -t.amount }));
  const prevIn = instalmentFor(list, prev.year, prev.month);
  const curIn = instalmentFor(list, masa.year, masa.month);
  const prevPaid = forMasa(prev);
  const curPaid = forMasa(masa);
  if (!prevIn && !curIn && !prevPaid.length && !curPaid.length) return null;

  const due = dueDate("PPH_23", prev);
  const onTime = prevPaid.filter((p) => +p.date <= +due);
  const late = prevPaid.filter((p) => +p.date > +due);
  const sum = (xs: Payment[]) => xs.reduce((t, p) => t + p.amount, 0n);
  const expected = prevIn?.amount ?? null;
  let short = 0n;
  let state: Pph25["previous"]["state"];
  if (expected === null) state = prevPaid.length ? "DISETOR" : "BELUM_DIISI";
  else {
    const paidOnTime = sum(onTime);
    short = expected > paidOnTime + sum(late) ? expected - paidOnTime - sum(late) : 0n;
    state =
      expected === 0n && !prevPaid.length ? "NIHIL"
      : short > 0n ? (+now <= +due ? "BELUM_JATUH_TEMPO" : "KURANG")
      : paidOnTime < expected ? "TERLAMBAT"
      : sum(prevPaid) > expected ? "LEBIH"
      : "LUNAS";
  }
  return {
    previous: { masa: prev, expected, due, paid: onTime, late, short, state },
    current: { masa, expected: curIn?.amount ?? null, due: dueDate("PPH_23", masa), paid: curPaid },
    instalment: curIn,
    instalments: list,
    status: state === "KURANG" || state === "TERLAMBAT" ? "REVIEW" : "PASS",
  };
}

/** Within 10 % of the estimate passes: the census wage is the PSAK 219 upah, not the whole gross. */
const TOLERANCE_BP = 1000n;

async function terCheck(db: Db, input: { clientId: string; entityId: string; masa: Masa; booked: bigint }): Promise<TerCheck> {
  const { start, end } = periodBounds(input.masa.year, input.masa.month);
  const active = await db.employee.findMany({
    where: { clientId: input.clientId, entityId: input.entityId, hireDate: { lte: end }, OR: [{ leftOn: null }, { leftOn: { gte: start } }] },
    orderBy: [{ name: "asc" }],
  });
  if (!active.length) return { state: "NO_EMPLOYEES" };
  const known = active.filter((e) => e.ptkpStatus);
  const missing = active.length - known.length;
  if (!known.length) return { state: "NO_STATUS", missing };
  const within = (estimate: bigint) => {
    const diff = input.booked - estimate;
    const base = estimate < 0n ? -estimate : estimate;
    return (diff < 0n ? -diff : diff) * 10_000n <= base * TOLERANCE_BP;
  };
  // The year through this masa under Pasal 17 less the TER of the months before it (PMK 168/2023), for the months worked this year.
  const { year, month } = input.masa;
  const annualFor = (e: (typeof known)[number]) => {
    const months = e.hireDate.getUTCFullYear() < year ? month : month - e.hireDate.getUTCMonth();
    return { id: e.id, name: e.name, employeeNo: e.employeeNo, status: e.ptkpStatus!, wage: e.wage, ...pph21Annual(e.wage, e.ptkpStatus!, months) };
  };
  if (month === 12) {
    // December: every employee's year.
    const annual = known.map(annualFor);
    const estimate = annual.reduce((t, e) => t + e.december, 0n);
    return { state: "ANNUAL", employees: annual, missing, estimate, booked: input.booked, status: within(estimate) && missing === 0 ? "PASS" : "REVIEW" };
  }
  // January–November: TER, except for an employee whose last day falls in this masa (masa pajak terakhir: Pasal 17).
  const leaving = (e: (typeof known)[number]) => e.leftOn !== null && +e.leftOn >= +start && +e.leftOn <= +end;
  const employees = known.filter((e) => !leaving(e)).map((e) => {
    const r = pph21Ter(e.wage, e.ptkpStatus!);
    return { id: e.id, name: e.name, employeeNo: e.employeeNo, status: e.ptkpStatus!, category: r.category, wage: e.wage, rate: r.rate, tax: r.tax };
  });
  const leavers = known.filter(leaving).map(annualFor);
  const estimate = employees.reduce((s, e) => s + e.tax, 0n) + leavers.reduce((s, e) => s + e.december, 0n);
  return { state: "CHECKED", employees, leavers, missing, estimate, booked: input.booked, status: within(estimate) && missing === 0 ? "PASS" : "REVIEW" };
}

const STATE_LABEL: Record<PreviousMasa["state"], string> = {
  NIHIL: "Nihil",
  LUNAS: "Lunas",
  LEBIH: "Lebih setor",
  TERLAMBAT: "Disetor terlambat",
  KURANG: "Kurang setor",
  BELUM_JATUH_TEMPO: "Belum jatuh tempo",
};
export const previousStateLabel = (s: PreviousMasa["state"]) => STATE_LABEL[s];

/** The plain sentences a row needs, problems first (shown on the page and in the Excel). */
export function rowNotes(r: MasaRow): string[] {
  const p = r.previous;
  const prevLabel = formatPeriod(p.masa.year, p.masa.month);
  const rp = (v: bigint) => formatRupiah(v < 0n ? -v : v);
  const out: string[] = [];
  if (p.state === "KURANG") out.push(`Masa ${prevLabel}: ${rp(p.short)} dari ${rp(p.owed)} belum disetor sampai jatuh tempo ${formatDate(p.due)}.`);
  if (p.state === "TERLAMBAT") out.push(`Masa ${prevLabel}: disetor setelah jatuh tempo ${formatDate(p.due)} (${p.late.map((x) => `${formatDate(x.date)} ${rp(x.amount)}`).join(", ")}).`);
  if (r.netPayroll) out.push("PPh 21 disetor, tetapi tidak ada PPh 21 terutang yang dicatat masa ini maupun masa lalu. Gaji mungkin dicatat neto: catat gaji bruto dan potongan PPh 21 ke 2140.");
  if (r.other > 0n) out.push(`Saldo ${r.code} memuat ${rp(r.other)} dari masa yang lebih lama (atau setoran yang belum tercatat).`);
  if (r.other < 0n) out.push(`Saldo ${r.code} ${rp(r.other)} lebih kecil dari yang masih terutang: setoran masa sebelumnya melebihi yang dicatat terutang, atau ada pajak yang belum dicatat.`);
  if (p.state === "BELUM_JATUH_TEMPO") out.push(`Masa ${prevLabel} jatuh tempo ${formatDate(p.due)}; ${rp(p.short)} belum disetor.`);
  if (p.state === "LEBIH" && !r.netPayroll) out.push(`Masa ${prevLabel}: disetor ${rp(p.paid.reduce((s, x) => s + x.amount, 0n))}, lebih dari yang dicatat terutang ${rp(p.owed)}.`);
  if (r.ppn && r.ppn.carryOut > 0n) out.push(`PPN lebih bayar ${rp(r.ppn.carryOut)} dikompensasikan ke masa berikutnya.`);
  return out;
}

/** The plain sentences the PPh 25 row needs, problems first (page, Excel and Tutup Buku). */
export function pph25Notes(p: Pph25): string[] {
  const v = p.previous;
  const prevLabel = formatPeriod(v.masa.year, v.masa.month);
  const rp = (x: bigint) => formatRupiah(x);
  const paid = [...v.paid, ...v.late].reduce((t, x) => t + x.amount, 0n);
  const out: string[] = [];
  if (v.state === "KURANG") out.push(`Masa ${prevLabel}: ${rp(v.short)} dari angsuran ${rp(v.expected!)} belum disetor sampai jatuh tempo ${formatDate(v.due)}.`);
  if (v.state === "TERLAMBAT") out.push(`Masa ${prevLabel}: angsuran disetor setelah jatuh tempo ${formatDate(v.due)} (${v.late.map((x) => `${formatDate(x.date)} ${rp(x.amount)}`).join(", ")}).`);
  if (v.state === "BELUM_JATUH_TEMPO") out.push(`Masa ${prevLabel} jatuh tempo ${formatDate(v.due)}; ${rp(v.short)} belum disetor.`);
  if (v.state === "LEBIH") out.push(`Masa ${prevLabel}: disetor ${rp(paid)}, lebih dari angsuran ${rp(v.expected!)}.`);
  if (!p.instalment) out.push("Angsuran PPh 25 per bulan belum diisi: isi dari SPT tahunan terakhir supaya setorannya bisa dicek.");
  return out;
}

const PPH25_STATE_LABEL: Record<Pph25["previous"]["state"], string> = { ...STATE_LABEL, DISETOR: "Disetor", BELUM_DIISI: "Angsuran belum diisi" };
export const pph25StateLabel = (s: Pph25["previous"]["state"]) => PPH25_STATE_LABEL[s];

/** "Keluaran Rp 2.200 − masukan Rp 400 − lebih bayar dibawa Rp 900". */
export const ppnLine = (p: NonNullable<MasaRow["ppn"]>) =>
  `Keluaran ${formatRupiah(p.keluaran)} − masukan ${formatRupiah(p.masukan)}${p.carryIn ? ` − lebih bayar dibawa ${formatRupiah(p.carryIn)}` : ""}`;

/** One sentence on the TER check. */
export function terNote(t: TerCheck): string {
  switch (t.state) {
    case "NO_EMPLOYEES":
      return "Tidak ada karyawan aktif di sensus bulan ini. Isi sensus di Imbalan Kerja untuk mengecek PPh 21 dengan TER.";
    case "NO_STATUS":
      return `${t.missing} karyawan aktif belum punya status PTKP. Isi statusnya di Imbalan Kerja untuk mengecek PPh 21 dengan TER.`;
    case "CHECKED": {
      const head = t.leavers.length
        ? `Estimasi PPh 21 ${t.estimate < 0n ? `lebih potong ${formatRupiah(-t.estimate)} (dikembalikan ke karyawan)` : formatRupiah(t.estimate)} dari upah sensus: TER, dan tarif Pasal 17 setahun untuk ${t.leavers.length} karyawan yang berhenti bulan ini; PPh 21 yang dicatat terutang ${formatRupiah(t.booked)}.`
        : `Estimasi TER ${formatRupiah(t.estimate)} dari upah sensus; PPh 21 yang dicatat terutang ${formatRupiah(t.booked)}.`;
      const gap = t.status === "PASS" ? " Selisihnya dalam 10 %." : t.missing ? ` ${t.missing} karyawan belum punya status PTKP.` : " Selisihnya lebih dari 10 %: periksa daftar gaji bulan ini.";
      return head + gap;
    }
    case "ANNUAL": {
      const est = t.estimate < 0n ? `lebih potong ${formatRupiah(-t.estimate)} (dikembalikan ke karyawan)` : formatRupiah(t.estimate);
      const head = `Estimasi PPh 21 Desember ${est}: PPh 21 setahun dengan tarif Pasal 17 dikurangi TER Januari–November, dari upah sensus; PPh 21 yang dicatat terutang ${formatRupiah(t.booked)}.`;
      const gap = t.status === "PASS" ? " Selisihnya dalam 10 %." : t.missing ? ` ${t.missing} karyawan belum punya status PTKP.` : " Selisihnya lebih dari 10 %: periksa perhitungan PPh 21 Desember (termasuk THR atau bonus).";
      return head + gap;
    }
  }
}

export const terRow = (e: TerEmployee) => ({ ...e, statusLabel: PTKP_LABEL[e.status], rateLabel: formatTerRate(e.rate) });
export const withholdingLabel = (k: WithholdingKind) => WITHHOLDING_LABEL[k];
