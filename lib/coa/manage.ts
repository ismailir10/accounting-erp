import type { Db, Tx } from "@/lib/db";
import { recordEvent } from "@/lib/audit";
import { ACCOUNT_CODES, FS_LINES, type FsLine } from "@/lib/coa/template";
import { allocateAccountCode, isReservedCode, NEW_ACCOUNT_FS_LINES, newAccountData } from "@/lib/ledger-import/mapping";
import { withholdingAccountCode } from "@/lib/tax/withholding";
import { GUESS_CODES } from "@/lib/classify/fallback";
import type { Account } from "@/lib/generated/prisma/client";

/**
 * Bagan akun (chart of accounts) edits: add an account, rename it, move it to another report line, remove an unused one. An account
 * never changes its code, type or normal side, so no posted line changes meaning; a move changes presentation only (accounting-rules 1:
 * the statements group by FS line, totals by type stay). Accounts the ledger reaches by code or flag are protected. Every change bumps the
 * client's chart version (cached AI answers keyed on the old chart stop applying) and writes an `ACCOUNT` event in Riwayat.
 */
export class AccountEditError extends Error {}

const WITHHOLDING_CODES = (["PPH_21", "PPH_22", "PPH_23", "PPH_4_2"] as const).flatMap((k) => [withholdingAccountCode(k, "IN"), withholdingAccountCode(k, "OUT")]);
/** Codes the ledger, tax, lease, benefit, inventory and FX code posts to by number (`templateAccounts` refuses them renamed). */
const SYSTEM_CODES = new Set<string>([...Object.values(ACCOUNT_CODES), ...WITHHOLDING_CODES]);

/** Why an account can't be renamed, moved or removed here (null = it can), in the words the page shows. */
export function protection(a: Pick<Account, "code" | "isBank" | "isIntercompany" | "isClearing" | "isSuspense" | "isRetained" | "taxTag">): string | null {
  if (a.isBank) return "Akun bank: namanya mengikuti rekening di Perusahaan & aturan.";
  if (a.isIntercompany || a.isClearing || a.isSuspense || a.isRetained || a.taxTag || SYSTEM_CODES.has(a.code)) return "Akun sistem: dipakai Buku lewat kodenya, jadi tidak bisa diubah atau dihapus.";
  return null;
}

/** Accounts the classifier's simple guess files to (lib/classify/fallback.ts): renamable and movable, never removable — a later import would
 *  otherwise suggest a code the chart no longer has. */
const GUESS = new Set<string>(Object.values(GUESS_CODES));
export const removalBlock = (a: Pick<Account, "code">): string | null =>
  GUESS.has(a.code) ? "Akun ini dipakai Buku sebagai tebakan bawaan untuk mutasi tanpa aturan, jadi tidak bisa dihapus. Namanya boleh diubah." : null;

/** Report lines an account can be created under or moved to (the ranges *Buat akun baru* uses). */
export const ACCOUNT_FS_LINES = NEW_ACCOUNT_FS_LINES;
const isFsLine = (v: string): v is FsLine => ACCOUNT_FS_LINES.some((l) => l.key === v);

/** Report lines an existing account may move to: same type and the same normal side, so its balance keeps its sign and statement. */
export function moveTargets(a: Pick<Account, "type" | "normalBalance">): FsLine[] {
  return ACCOUNT_FS_LINES.map((l) => l.key).filter((k) => {
    const d = newAccountData(k, "x");
    return d.type === a.type && d.normalBalance === a.normalBalance;
  });
}

const cleanName = (name: string) => {
  const n = name.replace(/\s+/g, " ").trim();
  if (n.length < 2) throw new AccountEditError("Isi nama akun.");
  if (n.length > 80) throw new AccountEditError("Nama akun paling panjang 80 huruf.");
  return n;
};

async function bump(tx: Tx, clientId: string) {
  await tx.client.update({ where: { id: clientId }, data: { coaVersion: { increment: 1 } } });
}

/** The next code `create` would give an account under `fsLine`, for the form to show before saving. */
export async function proposedCode(db: Db, clientId: string, fsLine: string): Promise<string | null> {
  if (!isFsLine(fsLine)) return null;
  return allocateAccountCode(fsLine, new Set((await db.account.findMany({ where: { clientId }, select: { code: true } })).map((a) => a.code)));
}

/** A new account under a report line: the typed code when given (3–10 digits, free, not reserved), else the next free one in the line's range. */
export async function createAccount(db: Db, input: { clientId: string; fsLine: string; name: string; code?: string; actorId?: string | null }) {
  if (!isFsLine(input.fsLine)) throw new AccountEditError("Pilih pos laporan untuk akun ini.");
  const fsLine = input.fsLine;
  const name = cleanName(input.name);
  const typed = input.code?.trim() ?? "";
  if (typed && !/^\d{3,10}$/.test(typed)) throw new AccountEditError("Kode akun berupa angka, 3 sampai 10 digit.");
  return db.$transaction(async (tx) => {
    const client = await tx.client.findUniqueOrThrow({ where: { id: input.clientId }, select: { firmId: true } });
    const chart = await tx.account.findMany({ where: { clientId: input.clientId }, select: { code: true, name: true } });
    const used = new Set(chart.map((a) => a.code));
    if (chart.some((a) => a.name.toLowerCase() === name.toLowerCase())) throw new AccountEditError(`Akun bernama “${name}” sudah ada.`);
    if (typed && used.has(typed)) throw new AccountEditError(`Kode ${typed} sudah dipakai: ${chart.find((a) => a.code === typed)!.name}.`);
    if (typed && isReservedCode(typed)) throw new AccountEditError(`Kode ${typed} dicadangkan untuk akun bawaan Buku. Pakai kode lain.`);
    const code = typed || allocateAccountCode(fsLine, used);
    const account = await tx.account.create({ data: { firmId: client.firmId, clientId: input.clientId, ...newAccountData(fsLine, name), name, code } });
    await bump(tx, input.clientId);
    await recordEvent(tx, { clientId: input.clientId, kind: "ACCOUNT", subject: `account:${code}`, summary: `Akun ${code} ${name} ditambahkan di ${FS_LINES[fsLine].label}`, after: { code, name, fsLine }, actorId: input.actorId });
    return account;
  });
}

/** Rename and/or move to another report line of the same type and normal side. The code, type and normal side never change. */
export async function updateAccount(db: Db, input: { clientId: string; accountId: string; name: string; fsLine: string; actorId?: string | null }) {
  const name = cleanName(input.name);
  return db.$transaction(async (tx) => {
    const a = await tx.account.findFirst({ where: { id: input.accountId, clientId: input.clientId } });
    if (!a) throw new AccountEditError("Akun tidak ditemukan.");
    const blocked = protection(a);
    if (blocked) throw new AccountEditError(blocked);
    const moved = input.fsLine !== a.fsLine;
    if (moved && !(isFsLine(input.fsLine) && moveTargets(a).includes(input.fsLine))) throw new AccountEditError("Akun hanya bisa dipindah ke pos laporan dengan jenis dan saldo normal yang sama.");
    if (name === a.name && !moved) return a;
    if (name.toLowerCase() !== a.name.toLowerCase() && (await tx.account.count({ where: { clientId: input.clientId, id: { not: a.id }, name: { equals: name, mode: "insensitive" } } }))) throw new AccountEditError(`Akun bernama “${name}” sudah ada.`);
    const updated = await tx.account.update({ where: { id: a.id }, data: { name, fsLine: input.fsLine } });
    await bump(tx, input.clientId);
    const what = [name !== a.name ? `nama “${a.name}” → “${name}”` : null, moved ? `pos ${FS_LINES[a.fsLine as FsLine]?.label ?? a.fsLine} → ${FS_LINES[input.fsLine as FsLine].label}` : null].filter(Boolean).join(", ");
    await recordEvent(tx, { clientId: input.clientId, kind: "ACCOUNT", subject: `account:${a.code}`, summary: `Akun ${a.code}: ${what}`, before: { name: a.name, fsLine: a.fsLine }, after: { name, fsLine: input.fsLine }, actorId: input.actorId });
    return updated;
  });
}

/** What still points at an account, in Bahasa ("12 baris jurnal", "1 aturan"…); empty = it can be removed. */
export async function accountUsage(db: Db | Tx, clientId: string, accountId: string): Promise<string[]> {
  const a = await db.account.findFirst({
    where: { id: accountId, clientId },
    select: {
      code: true,
      firmId: true,
      _count: { select: { lines: true, bankAccounts: true, sourceAccounts: true, scheduleDebits: true, scheduleCredits: true, scheduleSources: true, fixedAssets: true, fixedAssetsAcc: true, invoiceCounter: true, invoiceArAp: true, taxCorrections: true, taxCredits: true, budgets: true } },
    },
  });
  if (!a) return [];
  const code = a.code;
  const ofClient = { bankAccount: { entity: { clientId } } };
  const [rules, memories, bankLines, splits, agings, suggested, proposals] = await Promise.all([
    db.rule.count({ where: { firmId: a.firmId, accountCode: code, OR: [{ clientId }, { clientId: null }] } }),
    db.memory.count({ where: { clientId, accountCode: code } }),
    db.bankTransaction.count({ where: { ...ofClient, OR: [{ accountCode: code }, { suggestedCode: code }] } }),
    db.bankTxSplit.count({ where: { accountCode: code, bankTransaction: ofClient } }),
    db.subledgerImport.count({ where: { clientId, accountCodes: { has: code } } }),
    db.sourceAccount.count({ where: { suggestedCode: code, entity: { clientId } } }),
    db.proposedEntry.findMany({ where: { clientId, status: "PROPOSED" }, select: { lines: true } }).then((ps) => ps.filter((p) => JSON.stringify(p.lines).includes(`"${code}"`)).length),
  ]);
  const c = a._count;
  const parts: [number, string][] = [
    [c.lines, "baris jurnal"],
    [c.bankAccounts, "rekening bank"],
    [c.sourceAccounts + suggested, "akun klien yang dipetakan"],
    [c.scheduleDebits + c.scheduleCredits + c.scheduleSources, "jadwal penyesuaian"],
    [c.fixedAssets + c.fixedAssetsAcc, "aset tetap"],
    [c.invoiceCounter + c.invoiceArAp, "faktur / dokumen"],
    [c.taxCorrections + c.taxCredits, "catatan pajak"],
    [rules, "aturan klasifikasi"],
    [memories, "ingatan klasifikasi"],
    [bankLines + splits, "mutasi bank"],
    [agings, "rekonsiliasi umur piutang/utang"],
    [proposals, "usulan jurnal"],
    [c.budgets, "sel anggaran"],
  ];
  return parts.filter(([n]) => n > 0).map(([n, what]) => `${n.toLocaleString("id-ID")} ${what}`);
}

/** Remove an account nothing points at (reversible by adding it again); otherwise refused naming what uses it. */
export async function removeAccount(db: Db, input: { clientId: string; accountId: string; actorId?: string | null }) {
  await db.$transaction(async (tx) => {
    const a = await tx.account.findFirst({ where: { id: input.accountId, clientId: input.clientId } });
    if (!a) throw new AccountEditError("Akun tidak ditemukan.");
    const blocked = protection(a) ?? removalBlock(a);
    if (blocked) throw new AccountEditError(blocked);
    // Under the account's row lock: a posting that commits first is counted, one that starts after waits for the delete and fails on its key.
    await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${a.id} FOR UPDATE`;
    const usage = await accountUsage(tx, input.clientId, a.id);
    if (usage.length) throw new AccountEditError(`Akun ${a.code} ${a.name} masih dipakai: ${usage.join(", ")}.`);
    await tx.account.delete({ where: { id: a.id } });
    await bump(tx, input.clientId);
    await recordEvent(tx, { clientId: input.clientId, kind: "ACCOUNT", subject: `account:${a.code}`, summary: `Akun ${a.code} ${a.name} dihapus`, before: { code: a.code, name: a.name, fsLine: a.fsLine }, actorId: input.actorId });
  });
}

/**
 * Arsip akun (cycle 2026-10-20-lampiran-arsip): an account the client stopped using leaves every picker and the classifier, and
 * postJournal() refuses it; reports keep its history. Archived only when nothing still counts on it: an editable account (not a system,
 * bank or guess account), no line in a month that is still open, a zero balance-sheet balance, and no running schedule or registered asset
 * on it. *Aktifkan lagi* undoes it at any time. Both are in Riwayat.
 */
export async function archiveAccount(db: Db, input: { clientId: string; accountId: string; actorId?: string | null }) {
  await db.$transaction(async (tx) => {
    const a = await tx.account.findFirst({ where: { id: input.accountId, clientId: input.clientId } });
    if (!a) throw new AccountEditError("Akun tidak ditemukan.");
    if (a.archivedAt) return;
    const blocked = protection(a) ?? removalBlock(a);
    if (blocked) throw new AccountEditError(blocked.replace("dihapus", "diarsipkan"));
    // Under the account's row lock, as a removal: a posting that commits first is counted.
    await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${a.id} FOR UPDATE`;
    const open = await tx.journalLine.findFirst({ where: { accountId: a.id, entry: { period: { status: "OPEN" } } }, orderBy: { date: "desc" }, select: { date: true } });
    if (open) throw new AccountEditError(`Akun ${a.code} ${a.name} masih dipakai di bulan yang belum ditutup (${open.date.getUTCMonth() + 1}/${open.date.getUTCFullYear()}). Tutup bukunya dulu, atau pindahkan saldonya.`);
    if (a.type !== "PENDAPATAN" && a.type !== "BEBAN") {
      const sum = await tx.journalLine.aggregate({ where: { accountId: a.id }, _sum: { debit: true, credit: true } });
      if ((sum._sum.debit ?? 0n) !== (sum._sum.credit ?? 0n)) throw new AccountEditError(`Akun ${a.code} ${a.name} masih bersaldo. Nolkan saldonya lewat jurnal dulu, baru arsipkan.`);
    }
    const [schedules, assets] = await Promise.all([
      tx.adjustmentSchedule
        .findMany({ where: { stoppedAt: null, OR: [{ debitAccountId: a.id }, { creditAccountId: a.id }] }, select: { months: true, reverse: true, _count: { select: { entries: true } } } })
        .then((ss) => ss.filter((x) => x._count.entries < x.months * (x.reverse ? 2 : 1)).length), // a finished schedule doesn't hold the account
      tx.fixedAsset.count({ where: { disposedOn: null, OR: [{ assetAccountId: a.id }, { accumulatedAccountId: a.id }] } }),
    ]);
    // A running Jurnal berulang and a journal waiting for a second approver would post to it later, and could not (postJournal refuses it).
    const uses = (lines: unknown) => Array.isArray(lines) && lines.some((l) => (l as { accountCode?: string }).accountCode === a.code);
    const now = new Date();
    const [templates, waiting] = await Promise.all([
      tx.recurringJournal
        .findMany({ where: { clientId: input.clientId, stoppedAt: null }, select: { lines: true, endYear: true, endMonth: true } })
        .then((ts) => ts.filter((t) => uses(t.lines) && (!t.endYear || !t.endMonth || t.endYear * 12 + t.endMonth >= now.getUTCFullYear() * 12 + now.getUTCMonth() + 1)).length),
      tx.journalApproval.findMany({ where: { clientId: input.clientId, status: "PENDING" }, select: { lines: true } }).then((rs) => rs.filter((r) => uses(r.lines)).length),
    ]);
    const held = [schedules ? `${schedules} jadwal penyesuaian berjalan` : "", assets ? `${assets} aset tetap` : "", templates ? `${templates} jurnal berulang` : "", waiting ? `${waiting} jurnal menunggu persetujuan` : ""].filter(Boolean);
    if (held.length) throw new AccountEditError(`Akun ${a.code} ${a.name} masih dipakai ${held.join(" dan ")}.`);
    await tx.account.update({ where: { id: a.id }, data: { archivedAt: new Date() } });
    await bump(tx, input.clientId);
    await recordEvent(tx, { clientId: input.clientId, kind: "ACCOUNT", subject: `account:${a.code}`, summary: `Akun ${a.code} ${a.name} diarsipkan`, actorId: input.actorId });
  });
}

export async function unarchiveAccount(db: Db, input: { clientId: string; accountId: string; actorId?: string | null }) {
  await db.$transaction(async (tx) => {
    const a = await tx.account.findFirst({ where: { id: input.accountId, clientId: input.clientId } });
    if (!a) throw new AccountEditError("Akun tidak ditemukan.");
    if (!a.archivedAt) return;
    await tx.account.update({ where: { id: a.id }, data: { archivedAt: null } });
    await bump(tx, input.clientId);
    await recordEvent(tx, { clientId: input.clientId, kind: "ACCOUNT", subject: `account:${a.code}`, summary: `Akun ${a.code} ${a.name} diaktifkan lagi`, actorId: input.actorId });
  });
}
