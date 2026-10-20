import { FS_LINES } from "@/lib/coa/template";
import type { AccountOption } from "@/components/app/account-picker";

const TYPE_LABEL: Record<string, string> = { ASET: "Aset", LIABILITAS: "Liabilitas", EKUITAS: "Ekuitas", PENDAPATAN: "Pendapatan", BEBAN: "Beban" };

/** Group label for pickers: "Beban · Beban umum & administrasi". */
export const accountGroup = (a: { type: string; fsLine: string | null }) => `${TYPE_LABEL[a.type]} · ${FS_LINES[a.fsLine as keyof typeof FS_LINES]?.label ?? ""}`.replace(/ · $/, "");

/** Accounts a bank line can be classified to (never a bank, 1999 or 3290 Selisih Saldo Awal), grouped for pickers. */
export function classifiableOptions(accounts: { code: string; name: string; type: string; fsLine: string | null; isBank: boolean; isSuspense: boolean; archivedAt?: Date | null }[]): AccountOption[] {
  return accounts.filter((a) => !a.isBank && !a.isSuspense && !a.archivedAt && a.fsLine !== "SELISIH_SALDO_AWAL").map((a) => ({ code: a.code, name: a.name, group: accountGroup(a) }));
}

/** Where an opening difference can go (ADR 0012): balance-sheet accounts that explain it — never a bank, 1999, 1199 or 3290 itself. */
export function openingTargetOptions(accounts: { code: string; name: string; type: string; fsLine: string | null; isBank: boolean; isSuspense: boolean; isClearing: boolean; archivedAt?: Date | null }[]): AccountOption[] {
  return accounts
    .filter((a) => ["ASET", "LIABILITAS", "EKUITAS"].includes(a.type) && !a.isBank && !a.isSuspense && !a.isClearing && !a.archivedAt && a.fsLine !== "SELISIH_SALDO_AWAL")
    .map((a) => ({ code: a.code, name: a.name, group: accountGroup(a) }));
}
