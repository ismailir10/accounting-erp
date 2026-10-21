import { convertMinor, exponentOf, isCurrency } from "@/lib/fx/currency";
import { centsToMinor, formatMoney, microToMinor, roundEntry } from "@/lib/money";
import { dateOnly, formatDate, formatPeriod } from "@/lib/format";
import type { LedgerDateOrder, LedgerRow, LedgerTotal, NeracaRow, NeracaTotal, TbGroup, TbRead, TbRow } from "@/lib/ledger-import/types";
import { columnLetter, TB_GROUP_LABEL } from "@/lib/ledger-import/read";
import { NO_CODE_PREFIX } from "@/lib/ledger-import/code";

/**
 * Source checks + posting plan (accounting-rules §15a). Pure: no DB, no AI.
 * The plan is exactly what post.ts will post, so every check describes the real outcome.
 */

export type Severity = "BLOCK" | "REVIEW" | "INFO";
export type Check = {
  severity: Severity;
  code: string;
  message: string;
  refs: string[];
  entityKey?: string;
  date?: Date;
  /** Functional minor units of the entity, when the check is about an amount. */
  amount?: bigint;
  /** BLOCK checks the accountant may accept (unbalanced group → difference to 1999). */
  acceptable?: boolean;
  groupKey?: string;
};

export type EntityInfo = { entityId: string; name: string; currency: string };
export type CurrencyMode = "FUNCTIONAL" | "CONVERT";

export type PlanLine = {
  ref: string;
  code: string;
  name: string;
  /** Signed functional minor units, debit-positive. */
  amount: bigint;
  fx: { currency: string; amount: bigint; rate: string } | null;
  memo: string | null;
};
export type PlanEntry = {
  key: string;
  /** The journal kind when it isn't the import's own (a TB's Adjustment, its movement). */
  kind?: "OPENING" | "ADJUSTMENT" | "IMPORTED";
  /** Opening bridge: the Neraca is an anchor at this date (YYYY-MM-DD); the books' movement up to it is reversed when posting. */
  bridge?: { anchor: string };
  entityKey: string;
  date: Date;
  ref: string;
  memo: string;
  lines: PlanLine[];
  /** Σ lines before rounding residue; ≠ 0 = the source group doesn't balance (goes to 1999 only if accepted). */
  imbalance: bigint;
  /** 7190 residue (debit-positive) so rounded lines + residue = rounded total. */
  rounding: bigint;
  /** The residue includes rounding from converting foreign lines (the group balances in every source currency). */
  fxRounding?: boolean;
  /** A one-date worksheet's balances before adjustment: the period's own figures at its date, not a Saldo Awal before the books. */
  worksheet?: boolean;
};

export type Plan = { entries: PlanEntry[]; checks: Check[]; accounts: Map<string, { entityKey: string; code: string; name: string; previousNames: string[]; balance: bigint; currency: string | null }> };

type RateFor = (currency: string, functional: string, date: Date) => string | null;

const MAX_REFS = 50;
export const cap = (refs: string[]) => (refs.length > MAX_REFS ? [...refs.slice(0, MAX_REFS), `… +${refs.length - MAX_REFS} baris`] : refs);
export const accountKey = (entityKey: string, code: string) => `${entityKey}|${code}`;

/** Compress "S!5, S!6, S!7" → "S!5-7" for entry refs. A side-by-side file's refs carry a column ("S!A5", "S!F5") and are grouped per column. */
export function rangeRef(refs: string[]): string {
  if (!refs.length) return "";
  const sheet = refs[0].slice(0, refs[0].lastIndexOf("!"));
  const byColumn = new Map<string, number[]>();
  for (const r of refs) {
    const m = r.slice(r.lastIndexOf("!") + 1).match(/^([A-Z]*)(\d+)$/);
    if (!m) continue;
    const list = byColumn.get(m[1]);
    if (list) list.push(Number(m[2]));
    else byColumn.set(m[1], [Number(m[2])]);
  }
  const groups: string[] = [];
  for (const [col, list] of byColumn) {
    const nums = list.sort((a, b) => a - b);
    const parts: string[] = [];
    let start = nums[0];
    let prev = nums[0];
    for (const n of [...nums.slice(1), NaN]) {
      if (n === prev + 1) {
        prev = n;
        continue;
      }
      parts.push(start === prev ? `${col}${start}` : `${col}${start}-${prev}`);
      start = n;
      prev = n;
    }
    groups.push(parts.join(","));
  }
  return `${sheet}!${groups.join(",")}`.slice(0, 500);
}

/** Names compare after case, spacing, dash and punctuation are normalised; a name equal to its code is "no name". */
export function sameName(a: string, b: string) {
  const norm = (x: string) => x.toLowerCase().replace(/[–—]/g, "-").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return norm(a) === norm(b);
}

const DEBIT_NORMAL = /(piutang|receivable|\bkas\b|\bcash\b|\bbank\b|prepaid|dibayar di muka|uang muka|persediaan|inventory)/i;
/** Income/expense and contra accounts are never sign-checked; "Non-Bank" loans aren't banks. */
const NO_SIGN_CHECK = /(revenue|income|expense|pendapatan|beban|biaya|interest|bunga|allowance|penyisihan|akumulasi|accumulat|kontra|contra|non-bank|gain|loss|laba|rugi|in transit)/i;
const CREDIT_NORMAL = /(\butang\b|\bhutang\b|payable|accrued|masih harus dibayar)/i; // "Piutang" contains "utang"

const monthIndex = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
const periodOf = (i: number) => formatPeriod(Math.floor(i / 12), (i % 12) + 1);

/** Months with no row between the first and the last (indexes as `monthIndex`). */
export function missingMonths(months: number[]): number[] {
  const set = new Set(months);
  const out: number[] = [];
  for (let m = Math.min(...months) + 1; m < Math.max(...months); m++) if (!set.has(m)) out.push(m);
  return out;
}
export const periodList = (months: number[]) => (months.length > 4 ? `${months.slice(0, 4).map(periodOf).join(", ")} dan ${months.length - 4} bulan lain` : months.map(periodOf).join(", "));

/**
 * A year typo (2023 in a 2026 file, use-case UC-B1f): rows more than six months from the file's main run of months, when they are few (≤ 5
 * and under a fifth of the rows). Each gets the one date with the same day and month inside the main run, when there is exactly one.
 */
export function dateOutliers(rows: LedgerRow[]): { row: LedgerRow; fix: Date | null; main: { start: Date; end: Date } }[] {
  const dated = rows.filter((r) => r.date && !r.errors.length);
  const months = [...new Set(dated.map((r) => monthIndex(r.date!)))].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const m of months) {
    const last = runs[runs.length - 1];
    if (last && m - last[last.length - 1] <= 6) last.push(m);
    else runs.push([m]);
  }
  if (runs.length < 2) return [];
  const size = (run: number[]) => dated.filter((r) => run.includes(monthIndex(r.date!))).length;
  const main = runs.reduce((a, b) => (size(b) > size(a) ? b : a));
  const inMain = dated.filter((r) => main.includes(monthIndex(r.date!)));
  // Only another year can be a year typo: a sparse file with a far month of the same year is just sparse.
  const mainYears = new Set(main.map((m) => Math.floor(m / 12)));
  const outliers = dated.filter((r) => !main.includes(monthIndex(r.date!)) && !mainYears.has(r.date!.getUTCFullYear()));
  if (outliers.length > 5 || outliers.length * 5 >= dated.length) return [];
  const start = new Date(Math.min(...inMain.map((r) => +r.date!)));
  const end = new Date(Math.max(...inMain.map((r) => +r.date!)));
  return outliers.map((row) => {
    const d = row.date!;
    const candidates: Date[] = [];
    for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) {
      const c = dateOnly(y, d.getUTCMonth() + 1, d.getUTCDate());
      // Inside the run's months (a typo on the period's first day is before the other rows).
      if (c.getUTCDate() === d.getUTCDate() && +c >= +dateOnly(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) && +c <= +dateOnly(end.getUTCFullYear(), end.getUTCMonth() + 2, 0)) candidates.push(c);
    }
    return { row, fix: candidates.length === 1 ? candidates[0] : null, main: { start, end } };
  });
}

export function planLedger(
  input: LedgerRow[],
  opts: { entities: Map<string, EntityInfo>; currencyMode: CurrencyMode; rateFor?: RateFor; existingNames?: Map<string, string>; totals?: LedgerTotal[]; dateOrder?: LedgerDateOrder },
): Plan {
  const checks: Check[] = [];
  // How two-number dates were read (QA E17): said when it isn't the plain Indonesian day/month; a file mixing both can't post.
  const order = opts.dateOrder;
  if (order?.basis === "mixed") {
    checks.push({ severity: "BLOCK", code: "DATE_ORDER_MIXED", message: `Kolom tanggal mencampur format hari/bulan ("${order.examples[0]}") dan bulan/hari ("${order.examples[1]}"). Samakan format tanggalnya di file lalu unggah ulang.`, refs: [] });
  } else if (order?.basis === "number") {
    checks.push({ severity: "INFO", code: "DATE_ORDER_US", message: `Tanggal dibaca sebagai bulan/hari (format AS), karena ada tanggal seperti "${order.examples[0]}".`, refs: [] });
  } else if (order?.basis === "unsure") {
    checks.push({ severity: "INFO", code: "DATE_ORDER_UNSURE", message: `Format tanggal tidak bisa dipastikan: semua tanggal (mis. "${order.examples[0]}") cocok untuk hari/bulan maupun bulan/hari. Dibaca hari/bulan; bila file memakai format AS, ekspor ulang dengan nama bulan atau format yyyy-mm-dd.`, refs: [] });
  }
  const accounts: Plan["accounts"] = new Map();
  const entityKeyOf = (r: LedgerRow) => r.entity ?? "";

  // BLOCK: a year typo with one plain fix; accepting it posts the row on the corrected date, its memo keeps the date as written.
  // A far date with no such fix may be real (an old adjustment): REVIEW, posted as written.
  const fixes = new Map<LedgerRow, Date>();
  for (const o of dateOutliers(input)) {
    const span = `${formatDate(o.main.start)} – ${formatDate(o.main.end)}`;
    if (o.fix) {
      fixes.set(o.row, o.fix);
      checks.push({ severity: "BLOCK", code: "DATE_TYPO", message: `${o.row.ref}: tanggal ${formatDate(o.row.date!)} jauh dari periode file (${span}). Salah ketik tahun? Terima untuk mencatatnya per ${formatDate(o.fix)}; tanggal asli tetap di memo.`, refs: [o.row.ref], entityKey: entityKeyOf(o.row), date: o.fix, acceptable: true });
    } else {
      checks.push({ severity: "REVIEW", code: "DATE_OUTLIER", message: `${o.row.ref}: tanggal ${formatDate(o.row.date!)} jauh dari periode file (${span}) dan dicatat apa adanya. Bila salah ketik, perbaiki di file lalu unggah ulang.`, refs: [o.row.ref], entityKey: entityKeyOf(o.row) });
    }
  }
  const rows = input.map((r) => {
    const fix = fixes.get(r);
    return fix ? { ...r, date: fix, description: [r.description, `tanggal di file ${formatDate(r.date!)}`].filter(Boolean).join(" · ") } : r;
  });

  // BLOCK: unreadable rows.
  for (const r of rows.filter((x) => x.errors.length)) {
    for (const e of r.errors) {
      checks.push({ severity: "BLOCK", code: "ROW_ERROR", message: `${r.ref}: ${e}`, refs: [r.ref], entityKey: entityKeyOf(r) });
    }
  }
  const unknownEntities = [...new Set(rows.map(entityKeyOf))].filter((k) => !opts.entities.has(k));
  for (const k of unknownEntities) {
    const refs = rows.filter((r) => entityKeyOf(r) === k).map((r) => r.ref);
    const message = k
      ? `Entitas "${k}" belum dipasangkan ke perusahaan klien (${refs.length} baris). Tambahkan perusahaan dengan nama singkat "${k}" di Pengaturan klien, lalu unggah ulang file ini.`
      : `${refs.length} baris tanpa entitas, padahal klien punya lebih dari satu perusahaan: pilih perusahaannya di Impor buku besar (Cara lain), atau isi kolom entitas di file.`;
    checks.push({ severity: "BLOCK", code: "UNKNOWN_ENTITY", message, refs: cap(refs), entityKey: k });
  }
  const unknownCurrency = rows.filter((r) => r.currency && !isCurrency(r.currency));
  for (const [cur, list] of groupBy(unknownCurrency, (r) => r.currency!)) {
    checks.push({ severity: "BLOCK", code: "UNKNOWN_CURRENCY", message: `Mata uang ${cur} belum didukung (${list.length} baris).`, refs: cap(list.map((r) => r.ref)) });
  }

  const usable = rows.filter((r) => !r.errors.length && opts.entities.has(entityKeyOf(r)) && (!r.currency || isCurrency(r.currency)));

  // REVIEW: negative amounts posted on the other side — the same number, never made positive on its own side.
  const negatives = usable.filter((r) => r.negative);
  if (negatives.length) {
    checks.push({ severity: "REVIEW", code: "NEGATIVE_AMOUNT", message: `${negatives.length} baris menulis angka negatif. Angkanya dicatat di sisi sebaliknya (debit negatif = kredit), tidak dibuat positif di sisi yang sama. Pastikan itu maksud file.`, refs: cap(negatives.map((r) => r.ref)) });
  }

  // The file's own grand total (the last Total row) against its rows, summed as written.
  const grand = opts.totals?.[opts.totals.length - 1];
  if (grand) {
    const readable = rows.filter((r) => !r.errors.length);
    const debit = readable.reduce((s, r) => s + (r.raw?.debit ?? r.debit), 0n);
    const credit = readable.reduce((s, r) => s + (r.raw?.credit ?? r.credit), 0n);
    const cur = [...opts.entities.values()][0]?.currency ?? "IDR";
    const money = (c: bigint) => formatMoney(centsToMinor(c, cur), cur);
    const largest = opts.totals!.every((t) => t.debit <= grand.debit);
    if (grand.debit === debit && grand.credit === credit) {
      checks.push({ severity: "INFO", code: "TOTAL_OK", message: `"${grand.label}" di file cocok dengan jumlah baris: debit ${money(debit)}, kredit ${money(credit)}.`, refs: [grand.ref] });
    } else if (largest) {
      checks.push({ severity: "REVIEW", code: "TOTAL_MISMATCH", message: `"${grand.label}" di file: debit ${money(grand.debit)}, kredit ${money(grand.credit)}; jumlah baris yang terbaca: debit ${money(debit)}, kredit ${money(credit)}. Ada baris yang tidak terbaca, atau total file tidak mencakup semua baris.`, refs: [grand.ref] });
    }
  }

  // Source accounts + REVIEW: same code, different names.
  for (const r of usable) {
    const k = accountKey(entityKeyOf(r), r.code);
    const a = accounts.get(k);
    const signed = r.debit - r.credit;
    const named = r.name !== r.code;
    if (!a) {
      const prev = opts.existingNames?.get(k);
      accounts.set(k, { entityKey: entityKeyOf(r), code: r.code, name: r.name, previousNames: prev && !sameName(prev, r.name) ? [prev] : [], balance: signed, currency: null });
    } else {
      a.balance += signed;
      if (!named) continue;
      if (a.name === a.code) a.name = r.name;
      else if (!sameName(a.name, r.name)) {
        if (!a.previousNames.some((p) => sameName(p, a.name))) a.previousNames.push(a.name);
        a.name = r.name; // latest name wins (assumption 4)
      }
    }
  }
  for (const a of accounts.values()) {
    a.previousNames = a.previousNames.filter((p) => !sameName(p, a.name));
    if (a.previousNames.length) {
      const refs = usable.filter((r) => entityKeyOf(r) === a.entityKey && r.code === a.code).map((r) => r.ref);
      checks.push({
        severity: "REVIEW",
        code: "CODE_RENAMED",
        message: `Kode ${a.code} dipakai dengan nama berbeda: ${[...a.previousNames, a.name].map((n) => `"${n}"`).join(" → ")}. Pastikan ini akun yang sama, bukan kode yang dipakai ulang.`,
        refs: cap(refs),
        entityKey: a.entityKey,
      });
    }
  }

  // Group into entries.
  const hasVoucher = usable.some((r) => r.voucher);
  const groups = groupBy(usable, (r) => `${entityKeyOf(r)}|${hasVoucher ? (r.voucher ?? "") : ""}|${r.date!.toISOString().slice(0, 10)}`);
  const entries: PlanEntry[] = [];
  const noRate = new Map<string, LedgerRow[]>();
  const missingRate = new Map<string, LedgerRow[]>();

  for (const [key, list] of groups) {
    const ek = entityKeyOf(list[0]);
    const info = opts.entities.get(ek)!;
    const date = list[0].date!;
    const cents: bigint[] = [];
    const exact: (bigint | undefined)[] = [];
    const lines: PlanLine[] = [];
    let convertedExact = true;
    // Σ signed source amount per currency: all zero = the group balances as written, whatever conversion rounding does.
    const bySourceCurrency = new Map<string, bigint>();
    let converted = 0;
    for (const r of list) {
      const signedCents = r.debit - r.credit;
      // The source amount as written (micro-units): sums and roundings start from it, so nothing is rounded twice (rule 6a).
      const signedMicro = r.exact ?? signedCents * 10_000n;
      const foreign = r.currency && r.currency !== info.currency ? r.currency : null;
      bySourceCurrency.set(foreign ?? info.currency, (bySourceCurrency.get(foreign ?? info.currency) ?? 0n) + signedMicro);
      if (foreign && opts.currencyMode === "CONVERT") {
        const rate = r.rate ?? opts.rateFor?.(foreign, info.currency, date) ?? null;
        if (!rate) {
          missingRate.set(`${ek}|${foreign}|${formatDate(date)}`, [...(missingRate.get(`${ek}|${foreign}|${formatDate(date)}`) ?? []), r]);
          convertedExact = false;
          continue;
        }
        const fxMinor = microToMinor(signedMicro < 0n ? -signedMicro : signedMicro, foreign);
        const functional = convertMinor(fxMinor, foreign, info.currency, rate);
        const signed = signedCents < 0n ? -functional : functional;
        // Back to sen so the entry total and rounding residue are computed over every line alike.
        cents.push(signed * 10n ** BigInt(2 - exponentOf(info.currency)));
        exact.push(undefined);
        lines.push({ ref: r.ref, code: r.code, name: r.name, amount: signed, fx: { currency: foreign, amount: fxMinor, rate }, memo: r.description || null });
        converted++;
      } else {
        if (foreign) noRate.set(`${ek}|${foreign}`, [...(noRate.get(`${ek}|${foreign}`) ?? []), r]);
        cents.push(signedCents);
        exact.push(r.exact);
        lines.push({ ref: r.ref, code: r.code, name: r.name, amount: 0n, fx: null, memo: [foreign ? `${foreign} dicatat apa adanya` : null, r.description || null].filter(Boolean).join(" · ") || null });
      }
    }
    if (!convertedExact) continue;
    // Rounding (rule 6a): only lines not already converted to functional minor units.
    const { rounded, rounding: lineRounding, total } = roundEntry(cents, info.currency, exact);
    lines.forEach((l, i) => {
      if (!l.fx) l.amount = rounded[i];
    });
    // Rule 6a for conversions: converting n foreign lines can leave at most n minor units; if the group balances in every
    // source currency, that residue is rounding (7190), not a difference in the file. Anything larger stays a BLOCK.
    const abs = total < 0n ? -total : total;
    const fxRounding = converted > 0 && total !== 0n && abs <= BigInt(converted) && [...bySourceCurrency.values()].every((v) => v === 0n);
    const rounding = fxRounding ? lineRounding - total : lineRounding;
    const refs = list.map((r) => r.ref);
    const entry: PlanEntry = {
      key,
      entityKey: ek,
      date,
      ref: rangeRef(refs),
      memo: `Impor ${list[0].voucher ? `bukti ${list[0].voucher}` : `buku besar ${formatDate(date)}`}`,
      lines,
      imbalance: fxRounding ? 0n : total,
      rounding,
      ...(fxRounding ? { fxRounding: true } : {}),
    };
    entries.push(entry);

    if (entry.imbalance !== 0n) {
      checks.push({
        severity: "BLOCK",
        code: "UNBALANCED",
        message: `Jurnal ${info.name} ${formatDate(date)} tidak seimbang: selisih ${formatMoney(entry.imbalance, info.currency)} (debit ${entry.imbalance > 0n ? ">" : "<"} kredit). Terima untuk mencatat selisihnya di 1999 Belum Terklasifikasi.`,
        refs: cap(refs),
        entityKey: ek,
        date,
        amount: entry.imbalance,
        acceptable: true,
        groupKey: key,
      });
    }
    // REVIEW: different currencies balancing on raw numbers.
    const currencies = new Set(list.map((r) => r.currency ?? info.currency));
    if (opts.currencyMode === "FUNCTIONAL" && currencies.size > 1 && entry.imbalance === 0n) {
      checks.push({
        severity: "REVIEW",
        code: "FX_SAME_NUMBER",
        message: `Jurnal ${info.name} ${formatDate(date)} seimbang hanya pada angka mentah padahal barisnya berbeda mata uang (${[...currencies].join(", ")}): kurs belum diterapkan.`,
        refs: cap(refs),
        entityKey: ek,
        date,
        groupKey: key,
      });
    }
  }

  for (const [k, list] of missingRate) {
    const [ek, cur, date] = k.split("|");
    checks.push({ severity: "BLOCK", code: "MISSING_RATE", message: `Kurs ${cur} tanggal ${date} belum ada (Buku memakai kurs bulan itu atau bulan sebelumnya, tidak yang lebih lama). Isi di halaman Kurs atau di kolom kurs file.`, refs: cap(list.map((r) => r.ref)), entityKey: ek });
  }
  for (const [k, list] of noRate) {
    const [ek, cur] = k.split("|");
    const info = opts.entities.get(ek)!;
    const gross = list.reduce((s, r) => s + r.debit + r.credit, 0n);
    const largest = list.reduce((m, r) => (r.debit + r.credit > m.debit + m.credit ? r : m), list[0]);
    checks.push({
      severity: "REVIEW",
      code: "FX_NO_RATE",
      message: `${list.length} baris ${cur} di buku ${info.currency} ${info.name} dicatat apa adanya tanpa kurs (total ${formatMoney(centsToMinor(gross, info.currency), info.currency, { bare: true })}; terbesar ${largest.ref} ${largest.code} ${largest.name}).`,
      refs: cap(list.map((r) => r.ref)),
      entityKey: ek,
      amount: centsToMinor(gross, info.currency),
    });
  }

  // REVIEW: a year-end balance against the account's nature (receivable in credit, payable in debit…).
  const years = [...new Set(usable.map((r) => r.date!.getUTCFullYear()))].sort();
  for (const a of accounts.values()) {
    if (NO_SIGN_CHECK.test(a.name)) continue;
    const debitNormal = DEBIT_NORMAL.test(a.name) && !CREDIT_NORMAL.test(a.name);
    const creditNormal = CREDIT_NORMAL.test(a.name) && !DEBIT_NORMAL.test(a.name);
    if (!debitNormal && !creditNormal) continue;
    const info = opts.entities.get(a.entityKey)!;
    const mine = usable.filter((r) => entityKeyOf(r) === a.entityKey && r.code === a.code);
    for (const y of years) {
      const cents = mine.filter((r) => r.date!.getUTCFullYear() <= y).reduce((s, r) => s + r.debit - r.credit, 0n);
      const bal = centsToMinor(cents, info.currency);
      if ((debitNormal && bal < 0n) || (creditNormal && bal > 0n)) {
        checks.push({
          severity: "REVIEW",
          code: "SIGN_AGAINST_TYPE",
          message: `${info.name} ${a.code} ${a.name}: saldo akhir ${y} di file ${debitNormal ? "kredit" : "debit"} ${formatMoney(bal < 0n ? -bal : bal, info.currency)}, berlawanan dengan sifat akunnya.`,
          refs: cap(mine.filter((r) => r.date!.getUTCFullYear() === y).map((r) => r.ref)),
          entityKey: a.entityKey,
          amount: bal,
        });
        break;
      }
    }
  }

  // REVIEW: a month with no row between the file's first and last month, per entity.
  for (const [ek, info] of opts.entities) {
    const months = usable.filter((r) => entityKeyOf(r) === ek).map((r) => monthIndex(r.date!));
    if (!months.length) continue;
    const gaps = missingMonths(months);
    if (gaps.length) {
      checks.push({ severity: "REVIEW", code: "MISSING_MONTH", message: `${info.name}: tidak ada baris di ${periodList(gaps)} (file berisi ${periodOf(Math.min(...months))} – ${periodOf(Math.max(...months))}). Pastikan bulan itu memang tanpa transaksi, bukan hilang dari file.`, refs: [], entityKey: ek });
    }
  }

  // INFO: stats + rounding.
  for (const [ek, info] of opts.entities) {
    const mine = entries.filter((e) => e.entityKey === ek);
    if (!mine.length) continue;
    const debit = mine.reduce((s, e) => s + e.lines.reduce((t, l) => t + (l.amount > 0n ? l.amount : 0n), 0n), 0n);
    const rounding = mine.reduce((s, e) => s + (e.rounding < 0n ? -e.rounding : e.rounding), 0n);
    const zero = mine.filter((e) => e.imbalance === 0n && e.lines.every((l) => l.amount === 0n)).length;
    checks.push({
      severity: "INFO",
      code: "STATS",
      message: `${info.name}: ${mine.reduce((s, e) => s + e.lines.length, 0)} baris dalam ${mine.length} jurnal, Σdebit ${formatMoney(debit, info.currency)}${rounding ? `, pembulatan ke 7190 total ${formatMoney(rounding, info.currency)} di ${mine.filter((e) => e.rounding).length} jurnal` : ""}${zero ? `, ${zero} jurnal bernilai nol dilewati` : ""}.`,
      refs: [],
      entityKey: ek,
    });
  }
  return { entries, checks, accounts };
}

/** Saldo against the account's nature (a negative receivable or cash, a debit payable): REVIEW, posted as written, never flipped. */
function signChecks(rows: { ref: string; code: string; name: string; amount: bigint }[], entity: EntityInfo, entityKey: string): Check[] {
  const out: Check[] = [];
  for (const r of rows) {
    if (NO_SIGN_CHECK.test(r.name)) continue;
    const debitNormal = DEBIT_NORMAL.test(r.name) && !CREDIT_NORMAL.test(r.name);
    const creditNormal = CREDIT_NORMAL.test(r.name) && !DEBIT_NORMAL.test(r.name);
    if ((debitNormal && r.amount < 0n) || (creditNormal && r.amount > 0n)) {
      const bal = centsToMinor(r.amount < 0n ? -r.amount : r.amount, entity.currency);
      const code = r.code.startsWith(NO_CODE_PREFIX) ? "" : `${r.code} `;
      out.push({ severity: "REVIEW", code: "SIGN_AGAINST_TYPE", message: `${entity.name} ${code}${r.name}: saldo di file ${debitNormal ? "kredit" : "debit"} ${formatMoney(bal, entity.currency)}, berlawanan dengan sifat akunnya. Dicatat apa adanya, tidak dibalik; periksa di file sumber.`, refs: [r.ref], entityKey, amount: r.amount });
    }
  }
  return out;
}

export function planNeraca(
  rows: NeracaRow[],
  totals: NeracaTotal[],
  opts: { entityKey: string; entity: EntityInfo; date: Date; sheet: string; existingNames?: Map<string, string>; periods?: { column: number; date: Date }[]; column?: number },
): Plan {
  const checks: Check[] = [];
  const accounts: Plan["accounts"] = new Map();
  const { entity, entityKey, date } = opts;
  for (const r of rows) for (const e of r.errors) checks.push({ severity: "BLOCK", code: "ROW_ERROR", message: `${r.ref}: ${e}`, refs: [r.ref], entityKey });
  const usable = rows.filter((r) => !r.errors.length);
  checks.push(...signChecks(usable, entity, entityKey));

  // REVIEW: several period columns — the one read is Saldo Awal, the others are not imported; a month missing between them is named.
  if (opts.periods && opts.periods.length > 1) {
    const read = opts.periods.find((p) => p.column === opts.column);
    const others = opts.periods.filter((p) => p !== read);
    // Missing months are claimed only for a monthly series (two columns a month apart), never between yearly comparatives.
    const months = opts.periods.map((p) => monthIndex(p.date)).sort((a, b) => a - b);
    const monthly = months.some((m, i) => i > 0 && m - months[i - 1] === 1);
    const gaps = monthly ? missingMonths(months) : [];
    checks.push({
      severity: "REVIEW",
      code: "MULTI_PERIOD",
      message: `File berisi ${opts.periods.length} kolom periode. Dibaca sebagai Saldo Awal: ${read ? formatDate(read.date) : "kolom pertama"}; tidak diimpor: ${others.map((p) => formatDate(p.date)).join(", ")} (mutasinya datang dari buku besar atau rekening koran).${gaps.length ? ` Kolom ${periodList(gaps)} tidak ada di file.` : ""}`,
      refs: [],
      entityKey,
    });
  }
  for (const r of usable) {
    const k = accountKey(entityKey, r.code);
    const prev = opts.existingNames?.get(k);
    accounts.set(k, { entityKey, code: r.code, name: r.name, previousNames: prev && prev !== r.name ? [prev] : [], balance: r.amount, currency: null });
  }
  const { rounded, rounding, total } = roundEntry(usable.map((r) => r.amount), entity.currency, usable.map((r) => r.exact));
  const entry: PlanEntry = {
    key: `${entityKey}|NERACA|${date.toISOString().slice(0, 10)}`,
    entityKey,
    date,
    ref: rangeRef(usable.map((r) => r.ref)),
    memo: `Saldo awal dari Neraca ${formatDate(date)}`,
    lines: usable.map((r, i) => ({ ref: r.ref, code: r.code, name: r.name, amount: rounded[i], fx: null, memo: null })),
    imbalance: total,
    rounding,
  };
  if (total !== 0n) {
    checks.push({
      severity: "BLOCK",
      code: "UNBALANCED",
      message: `Neraca ${entity.name} ${formatDate(date)} tidak seimbang: aset − (liabilitas + ekuitas) = ${formatMoney(total, entity.currency)}. Terima untuk mencatat selisihnya di 1999 Belum Terklasifikasi.`,
      refs: [],
      entityKey,
      date,
      amount: total,
      acceptable: true,
      groupKey: entry.key,
    });
  }
  // REVIEW: the file's own totals vs the imported rows.
  const assetCents = usable.filter((r) => r.typeHint === "ASET").reduce((s, r) => s + r.amount, 0n);
  const leCents = -usable.filter((r) => r.typeHint === "LIABILITAS" || r.typeHint === "EKUITAS").reduce((s, r) => s + r.amount, 0n);
  for (const t of totals) {
    const mine = t.kind === "ASSETS" ? assetCents : t.kind === "LIAB_EQUITY" ? leCents : null;
    if (mine === null) continue;
    const diff = centsToMinor(mine - t.amount, entity.currency);
    if (diff !== 0n) {
      checks.push({ severity: "REVIEW", code: "TOTAL_MISMATCH", message: `"${t.label}" di file ${formatMoney(centsToMinor(t.amount, entity.currency), entity.currency)} ≠ jumlah baris ${formatMoney(centsToMinor(mine, entity.currency), entity.currency)}.`, refs: [t.ref], entityKey });
    } else {
      checks.push({ severity: "INFO", code: "TOTAL_OK", message: `"${t.label}" cocok dengan jumlah baris: ${formatMoney(centsToMinor(mine, entity.currency), entity.currency)}.`, refs: [t.ref], entityKey });
    }
  }
  checks.push({
    severity: "INFO",
    code: "STATS",
    message: `${entity.name}: ${usable.length} akun per ${formatDate(date)}${rounding ? `, pembulatan ke 7190 ${formatMoney(rounding < 0n ? -rounding : rounding, entity.currency)}` : ""}.`,
    refs: [],
    entityKey,
  });
  return { entries: [entry], checks, accounts };
}

/**
 * A worksheet at one date (Sebelum Penyesuaian | Jurnal Penyesuaian | Setelah Penyesuaian): no last-year balance, no movement, no closing.
 * Its balances and adjustments are all at the worksheet date — never pushed to the year before.
 */
export const tbIsWorksheet = (layout: TbRead["layout"]) => !layout.groups.OPENING && !layout.groups.MOVEMENT && !layout.groups.CLOSING;

/**
 * A trial balance (use-case UC-K2): up to three journals, each citing its own column — the opening on the opening date (OPENING), the
 * Adjustment column on the same date as its own journal (ADJUSTMENT, never merged into the opening), and the movement on the closing date
 * (IMPORTED). Every row must tie (opening + adjustment = adjusted; adjusted + movement = closing) and every column its Total row.
 */
export function planTb(tb: TbRead, opts: { entityKey: string; entity: EntityInfo; opening: Date; closing: Date; existingNames?: Map<string, string> }): Plan {
  const checks: Check[] = [];
  const accounts: Plan["accounts"] = new Map();
  const { entity, entityKey } = opts;
  const has = (g: TbGroup) => tb.layout.groups[g] !== undefined;
  const v = (r: TbRow, g: TbGroup) => r.values[g] ?? 0n;
  // The same value as written, in micro-units: journal lines and their totals are rounded once from it (rule 6a).
  const vx = (r: TbRow, g: TbGroup) => r.exact?.[g] ?? v(r, g) * 10_000n;
  const money = (c: bigint) => formatMoney(centsToMinor(c, entity.currency), entity.currency);
  for (const r of tb.rows) for (const e of r.errors) checks.push({ severity: "BLOCK", code: "ROW_ERROR", message: `${r.ref}: ${e}`, refs: [r.ref], entityKey });
  const usable = tb.rows.filter((r) => !r.errors.length);

  // The balance before adjustments: last year's (OPENING) or, in a one-date worksheet, the unadjusted balance at that date.
  const base: TbGroup | null = has("OPENING") ? "OPENING" : has("UNADJUSTED") ? "UNADJUSTED" : null;
  if (has("OPENING") && has("UNADJUSTED")) {
    checks.push({ severity: "BLOCK", code: "TB_LAYOUT", message: "File berisi kolom saldo awal dan kolom sebelum penyesuaian sekaligus: tidak jelas mana yang menjadi saldo awal. Sisakan salah satu, lalu unggah ulang.", refs: [], entityKey });
  }
  // Adjustment from its own column, else implied by adjusted − before (said below) so the books still equal the adjusted column.
  const derivedAdjustment = !has("ADJUSTMENT") && has("ADJUSTED") && base !== null;

  // Each row's opening, adjustment and movement — from its own columns, or derived when a column is absent (said below).
  const split = (r: TbRow, get: (r: TbRow, g: TbGroup) => bigint) => {
    const adjustment = derivedAdjustment ? get(r, "ADJUSTED") - get(r, base!) : get(r, "ADJUSTMENT");
    const opening = base ? get(r, base) : has("ADJUSTED") ? get(r, "ADJUSTED") - adjustment : get(r, "CLOSING") - get(r, "MOVEMENT") - adjustment;
    const adjusted = has("ADJUSTED") ? get(r, "ADJUSTED") : opening + adjustment;
    const movement = has("MOVEMENT") ? get(r, "MOVEMENT") : has("CLOSING") ? get(r, "CLOSING") - adjusted : 0n;
    const closing = has("CLOSING") ? get(r, "CLOSING") : adjusted + movement;
    return { opening, adjustment, adjusted, movement, closing };
  };
  const parts = usable.map((r) => ({ r, ...split(r, v), exact: split(r, vx) }));
  for (const p of parts) {
    const prev = opts.existingNames?.get(accountKey(entityKey, p.r.code));
    accounts.set(accountKey(entityKey, p.r.code), { entityKey, code: p.r.code, name: p.r.name, previousNames: prev && !sameName(prev, p.r.name) ? [prev] : [], balance: p.closing, currency: null });
  }

  // REVIEW: rows that don't tie across their own columns.
  const tie = (label: string, bad: typeof parts, expected: (p: (typeof parts)[number]) => bigint, actual: (p: (typeof parts)[number]) => bigint) => {
    if (!bad.length) return;
    const p = bad[0];
    checks.push({ severity: "REVIEW", code: "TB_ROW_MISMATCH", message: `${bad.length} baris tidak cocok: ${label}. Contoh ${p.r.ref} ${p.r.code.startsWith(NO_CODE_PREFIX) ? "" : `${p.r.code} `}${p.r.name}: seharusnya ${money(expected(p))}, di file ${money(actual(p))}.`, refs: cap(bad.map((x) => x.r.ref)), entityKey });
  };
  if (has("ADJUSTED") && base && has("ADJUSTMENT")) {
    tie(`${TB_GROUP_LABEL[base].toLowerCase()} + adjustment ≠ saldo setelah penyesuaian`, parts.filter((p) => p.opening + p.adjustment !== p.adjusted), (p) => p.opening + p.adjustment, (p) => p.adjusted);
  }
  if (has("CLOSING") && has("MOVEMENT")) {
    tie("saldo setelah penyesuaian + mutasi ≠ saldo akhir", parts.filter((p) => p.adjusted + p.movement !== p.closing), (p) => p.adjusted + p.movement, (p) => p.closing);
  }
  if (!base) checks.push({ severity: "INFO", code: "TB_DERIVED", message: `Kolom saldo awal tidak ada: saldo awal dihitung dari ${has("ADJUSTED") ? "saldo setelah penyesuaian − adjustment" : "saldo akhir − mutasi − adjustment"}.`, refs: [], entityKey });
  if (derivedAdjustment) checks.push({ severity: "INFO", code: "TB_DERIVED", message: `Kolom Adjustment tidak ada: adjustment dihitung dari saldo setelah penyesuaian − ${TB_GROUP_LABEL[base!].toLowerCase()}, dan dicatat sebagai jurnal penyesuaiannya sendiri.`, refs: [], entityKey });
  for (const g of tb.flipped ?? []) checks.push({ severity: "INFO", code: "TB_PRESENTATION_SIGN", message: `Kolom ${TB_GROUP_LABEL[g]} ditulis dengan tanda penyajian (liabilitas dan ekuitas positif): dibaca dengan liabilitas dan ekuitas di kredit.`, refs: [], entityKey });
  if (!has("MOVEMENT") && has("CLOSING")) checks.push({ severity: "INFO", code: "TB_DERIVED", message: "Kolom mutasi tidak ada: mutasi dihitung dari saldo akhir − saldo setelah penyesuaian.", refs: [], entityKey });

  // The file's own Total row, column by column.
  const total = tb.totals[tb.totals.length - 1];
  if (total) {
    // A presentation-signed column's Total is a section total, not a trial-balance sum: not compared.
    const groups = (Object.keys(tb.layout.groups) as TbGroup[]).filter((g) => total.values[g] !== undefined && !tb.flipped?.includes(g));
    const off = groups.filter((g) => usable.reduce((s, r) => s + v(r, g), 0n) !== total.values[g]);
    if (off.length) {
      checks.push({ severity: "REVIEW", code: "TOTAL_MISMATCH", message: `"${total.label}" di file tidak sama dengan jumlah baris pada kolom ${off.map((g) => `${TB_GROUP_LABEL[g]} (file ${money(total.values[g]!)}, baris ${money(usable.reduce((s, r) => s + v(r, g), 0n))})`).join(", ")}.`, refs: [total.ref], entityKey });
    } else if (groups.length) {
      checks.push({ severity: "INFO", code: "TOTAL_OK", message: `"${total.label}" cocok dengan jumlah baris di setiap kolom (${groups.map((g) => TB_GROUP_LABEL[g]).join(", ")}).`, refs: [total.ref], entityKey });
    }
  }

  // The journals, each line citing the cell it came from.
  const cell = (r: TbRow, g: TbGroup) => {
    const slot = tb.layout.groups[g];
    const col = slot?.balance ?? slot?.debit;
    return col === undefined ? r.ref : `${r.ref.slice(0, r.ref.lastIndexOf("!"))}!${columnLetter(col)}${r.row}`;
  };
  const entries: PlanEntry[] = [];
  const entry = (kind: NonNullable<PlanEntry["kind"]>, key: string, date: Date, memo: string, list: { r: TbRow; amount: bigint; exact: bigint; group: TbGroup }[]) => {
    const lines = list.filter((x) => x.exact !== 0n);
    if (!lines.length) return;
    const { rounded, rounding, total: imbalance } = roundEntry(lines.map((x) => x.amount), entity.currency, lines.map((x) => x.exact));
    const e: PlanEntry = {
      key: `${entityKey}|${key}|${date.toISOString().slice(0, 10)}`,
      entityKey,
      date,
      kind,
      ref: rangeRef(lines.map((x) => x.r.ref)),
      memo,
      lines: lines.map((x, i) => ({ ref: cell(x.r, x.group), code: x.r.code, name: x.r.name, amount: rounded[i], fx: null, memo: null })),
      imbalance,
      rounding,
      ...(kind === "OPENING" && tbIsWorksheet(tb.layout) ? { worksheet: true } : {}),
    };
    entries.push(e);
    if (imbalance !== 0n) {
      checks.push({ severity: "BLOCK", code: "UNBALANCED", message: `${memo} ${entity.name} ${formatDate(date)} tidak seimbang: selisih ${formatMoney(imbalance, entity.currency)} (debit ${imbalance > 0n ? ">" : "<"} kredit). Terima untuk mencatat selisihnya di 1999 Belum Terklasifikasi.`, refs: [], entityKey, date, amount: imbalance, acceptable: true, groupKey: e.key });
    }
  };
  const openingFrom: TbGroup = base ?? (has("ADJUSTED") ? "ADJUSTED" : "CLOSING");
  const worksheet = tbIsWorksheet(tb.layout);
  entry("OPENING", "TB-OPENING", opts.opening, worksheet ? `Saldo sebelum penyesuaian dari neraca saldo per ${formatDate(opts.opening)}` : `Saldo awal dari neraca saldo per ${formatDate(opts.opening)}`, parts.map((p) => ({ r: p.r, amount: p.opening, exact: p.exact.opening, group: openingFrom })));
  if (has("ADJUSTMENT") || derivedAdjustment) entry("ADJUSTMENT", "TB-ADJUSTMENT", opts.opening, derivedAdjustment ? "Adjustment dari neraca saldo (setelah penyesuaian − sebelumnya)" : "Adjustment dari neraca saldo (kolom Adjustment)", parts.map((p) => ({ r: p.r, amount: p.adjustment, exact: p.exact.adjustment, group: derivedAdjustment ? ("ADJUSTED" as const) : ("ADJUSTMENT" as const) })));
  if (has("MOVEMENT") || has("CLOSING")) entry("IMPORTED", "TB-MOVEMENT", opts.closing, `Mutasi ${formatDate(new Date(+opts.opening + 86_400_000))} – ${formatDate(opts.closing)} dari neraca saldo`, parts.map((p) => ({ r: p.r, amount: p.movement, exact: p.exact.movement, group: has("MOVEMENT") ? ("MOVEMENT" as const) : ("CLOSING" as const) })));

  checks.push(...signChecks(parts.map((p) => ({ ref: cell(p.r, has("CLOSING") ? "CLOSING" : openingFrom), code: p.r.code, name: p.r.name, amount: p.closing })), entity, entityKey));
  checks.push({
    severity: "INFO",
    code: "STATS",
    message: `${entity.name}: neraca saldo ${usable.length} akun, kolom ${(Object.keys(tb.layout.groups) as TbGroup[]).map((g) => TB_GROUP_LABEL[g]).join(", ")}; ${entries.length} jurnal (${entries.map((e) => (e.kind === "OPENING" ? "saldo awal" : e.kind === "ADJUSTMENT" ? "adjustment" : "mutasi")).join(", ")}).`,
    refs: [],
    entityKey,
  });
  return { entries, checks, accounts };
}

function groupBy<T>(list: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const t of list) {
    const k = key(t);
    const arr = m.get(k);
    if (arr) arr.push(t);
    else m.set(k, [t]);
  }
  return m;
}

export const hasBlocking = (checks: Check[]) => checks.some((c) => c.severity === "BLOCK" && !c.acceptable);
