import type { CorrectionDirection, CorrectionKind } from "@/lib/generated/prisma/enums";

/**
 * Koreksi fiskal categories suggested from expense-account names (accounting-rules 5d): UU PPh Pasal 9 non-deductibles and the usual
 * timing differences. A match is only a suggestion; the accountant accepts it (with the default % or another) or dismisses it. First match
 * wins, so the more specific words come first. Tax expense accounts (BEBAN_PAJAK) never reach this list: they are below profit before tax.
 * Natura / kenikmatan is not one: from tax year 2022 it is deductible for the employer (UU HPP Pasal 6 ayat (1) huruf a, PMK 66/2023).
 */
export type CorrectionCategory = { key: string; label: string; pattern: RegExp; direction: CorrectionDirection; kind: CorrectionKind; percent: number };

export const CATEGORIES: CorrectionCategory[] = [
  { key: "PHONE_VEHICLE", label: "Telepon seluler / kendaraan dinas (50%, KEP-220/PJ/2002)", pattern: /telepon seluler|handphone|pulsa|kendaraan dinas/i, direction: "POSITIVE", kind: "PERMANENT", percent: 50 },
  { key: "ENTERTAINMENT", label: "Entertainment / jamuan tanpa daftar nominatif", pattern: /entertain|jamuan|representasi/i, direction: "POSITIVE", kind: "PERMANENT", percent: 100 },
  { key: "DONATION", label: "Sumbangan / donasi", pattern: /sumbangan|donasi/i, direction: "POSITIVE", kind: "PERMANENT", percent: 100 },
  { key: "PENALTY", label: "Sanksi / denda / bunga penagihan pajak", pattern: /sanksi|denda|bunga penagihan/i, direction: "POSITIVE", kind: "PERMANENT", percent: 100 },
  { key: "INCOME_TAX_EXPENSED", label: "PPh yang dibebankan", pattern: /\bpph\b|pajak penghasilan/i, direction: "POSITIVE", kind: "PERMANENT", percent: 100 },
  { key: "PROVISION", label: "Cadangan / penyisihan / CKPN", pattern: /cadangan|penyisihan|ckpn|kerugian penurunan nilai/i, direction: "POSITIVE", kind: "TEMPORARY", percent: 100 },
  { key: "EMPLOYEE_BENEFITS", label: "Imbalan kerja / pesangon (akrual)", pattern: /imbalan kerja|imbalan pasca|pesangon/i, direction: "POSITIVE", kind: "TEMPORARY", percent: 100 },
];

export const categoryOf = (accountName: string) => CATEGORIES.find((c) => c.pattern.test(accountName)) ?? null;
export const categoryByKey = (key: string | null | undefined) => CATEGORIES.find((c) => c.key === key) ?? null;

/** amount × percent / 100, rounded half up (amounts ≥ 0). */
export const share = (amount: bigint, percent: number) => (amount * BigInt(percent) * 2n + 100n) / 200n;

/** Losses (UU PPh Pasal 6 ayat 2): usable for five years after the origin year, oldest first. */
export type LossRow = { id: string | null; originYear: number; opening: bigint; used: bigint; remaining: bigint; expiresAfter: number; expired: boolean };

export function compensate(fiscalProfit: bigint, year: number, losses: { id?: string; originYear: number; amount: bigint }[]): { rows: LossRow[]; used: bigint } {
  let room = fiscalProfit > 0n ? fiscalProfit : 0n;
  const rows = [...losses]
    .sort((a, b) => a.originYear - b.originYear)
    .map((l) => {
      const expired = l.originYear + 5 < year || l.originYear >= year;
      const used = expired ? 0n : l.amount < room ? l.amount : room;
      room -= used;
      return { id: l.id ?? null, originYear: l.originYear, opening: l.amount, used, remaining: l.amount - used, expiresAfter: l.originYear + 5, expired };
    });
  return { rows, used: rows.reduce((t, r) => t + r.used, 0n) };
}
