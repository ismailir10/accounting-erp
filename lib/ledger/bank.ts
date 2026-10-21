import type { Tx } from "@/lib/db";
import type { TaxTag } from "@/lib/generated/prisma/enums";
import { ACCOUNT_CODES } from "@/lib/coa/template";
import { splitPpn } from "@/lib/money";
import { LedgerError, postJournal, type PostLine } from "@/lib/ledger/post";
import { templateAccounts } from "@/lib/coa/ensure";
import { withholdingAccountCode, type Withholding } from "@/lib/tax/withholding";

/**
 * Posting for bank transactions. The bank side is posted once and never changes.
 * The classification side (everything except the bank GL account) can be moved later
 * by a RECLASS entry that posts only the difference — so drill-down from any account
 * still lands on the same bank row (entries keep bankTransactionId).
 *
 * Departemen & Proyek (lib/dimensions): the line's tags (`BankTransaction.departmentId`, `projectId`) go on the classification account
 * (each part of a split), never on the bank, tax or suspense legs, and the difference is taken per account and tags — so changing only
 * a tag moves it by a RECLASS as changing the account does (rule 3).
 */
type Target = {
  accountCode: string;
  taxTag?: TaxTag | null;
  /** Tax withheld from the payment: not in the bank amount, on the classification side (accounting-rules 5h). */
  withholding?: Withholding | null;
  /** A split line (pecah transaksi): the classification side by part, positive magnitudes adding up to the bank amount; no tax. */
  parts?: { accountCode: string; amount: bigint }[];
};

/** Desired non-bank side as signed nets per account code (debit positive). */
export function classificationNets(amount: bigint, target: Target): Map<string, bigint> {
  const nets = new Map<string, bigint>();
  const add = (code: string, v: bigint) => nets.set(code, (nets.get(code) ?? 0n) + v);
  if (target.parts) {
    // Money in → the parts are credits; money out → debits. Their sum is the bank amount (checked by splitTransaction).
    for (const p of target.parts) add(p.accountCode, amount > 0n ? -p.amount : p.amount);
    return nets;
  }
  // Money in → bank debit, so classification side is credit (negative); money out → debit.
  // A withheld part is a tax leg on the same side as the bank amount's opposite: money in, the customer paid net, so the counterparty
  // (receivable) is credited gross and the prepaid tax debited; money out, the counterparty is debited gross and the liability credited.
  const w = target.withholding && target.withholding.amount > 0n ? target.withholding : null;
  const taxNet = w ? (amount > 0n ? w.amount : -w.amount) : 0n;
  const side = -amount - taxNet;
  if (amount > 0n && target.taxTag === "PPN_KELUARAN") {
    const { dpp, ppn } = splitPpn(side);
    add(target.accountCode, dpp);
    add(ACCOUNT_CODES.PPN_KELUARAN, ppn);
  } else if (amount < 0n && target.taxTag === "PPN_MASUKAN") {
    const { dpp, ppn } = splitPpn(side);
    add(target.accountCode, dpp);
    add(ACCOUNT_CODES.PPN_MASUKAN, ppn);
  } else {
    add(target.accountCode, side);
  }
  if (w) add(withholdingAccountCode(w.kind, amount > 0n ? "IN" : "OUT"), taxNet);
  return nets;
}

async function accountIdMap(tx: Tx, clientId: string) {
  const accounts = await tx.account.findMany({ where: { clientId }, select: { id: true, code: true } });
  return new Map(accounts.map((a) => [a.code, a.id]));
}

export async function postBankTransaction(
  tx: Tx,
  bankTxId: string,
  target: Target,
  opts: { codeToId?: Map<string, string>; actorId?: string | null } = {},
) {
  const bankTx = await tx.bankTransaction.findUniqueOrThrow({
    where: { id: bankTxId },
    include: { bankAccount: { include: { entity: true } } },
  });
  const clientId = bankTx.bankAccount.entity.clientId;
  const codeToId = new Map(opts.codeToId ?? (await accountIdMap(tx, clientId)));
  // The tax leg's account may be a template account this (older) chart lacks: created on first use when the code is free.
  if (target.withholding && target.withholding.amount > 0n) {
    const code = withholdingAccountCode(target.withholding.kind, bankTx.amount > 0n ? "IN" : "OUT");
    if (!codeToId.has(code)) codeToId.set(code, (await templateAccounts(tx, clientId, [code])).get(code)!);
  }
  // A split line is re-posted only as a split: a one-account posting from elsewhere would silently drop its parts.
  if (!target.parts && (await tx.bankTxSplit.count({ where: { bankTransactionId: bankTx.id } }))) {
    throw new LedgerError("Mutasi ini dipecah ke beberapa akun. Ubah lewat Pecah transaksi, atau pilih satu akun di Review untuk menggabungkannya lagi.");
  }
  const bankGlId = bankTx.bankAccount.accountId;
  const idOf = (code: string) => {
    const id = codeToId.get(code);
    if (!id) throw new Error(`Akun ${code} tidak ada di bagan akun`);
    return id;
  };

  const desired = classificationNets(bankTx.amount, target);
  const existing = await tx.journalLine.findMany({
    where: { entry: { bankTransactionId: bankTx.id }, accountId: { not: bankGlId } },
    select: { accountId: true, debit: true, credit: true, departmentId: true, projectId: true },
  });

  // Nets keyed by account and tags: "accountId|departmentId|projectId".
  const tagged = new Set(target.parts ? target.parts.map((p) => p.accountCode) : [target.accountCode]);
  tagged.delete(ACCOUNT_CODES.SUSPENSE);
  // A withheld tax that is an expense (final PPh 4(2) on a receipt, 8200) belongs to the income it was withheld from: it carries the tags.
  // A tax that is a receivable or payable (PPh 23 prepaid, PPh 21 owed) is the company's and doesn't.
  if (target.withholding && target.withholding.amount > 0n) {
    const code = withholdingAccountCode(target.withholding.kind, bankTx.amount > 0n ? "IN" : "OUT");
    const acc = await tx.account.findFirst({ where: { clientId, code }, select: { type: true } });
    if (acc && (acc.type === "BEBAN" || acc.type === "PENDAPATAN")) tagged.add(code);
  }
  const keyOf = (code: string) => (tagged.has(code) ? `${idOf(code)}|${bankTx.departmentId ?? ""}|${bankTx.projectId ?? ""}` : `${idOf(code)}||`);
  const toLines = (nets: Map<string, bigint>): PostLine[] =>
    [...nets.entries()].map(([key, v]) => {
      const [accountId, departmentId, projectId] = key.split("|");
      const tags = { departmentId: departmentId || null, projectId: projectId || null };
      return v > 0n ? { accountId, debit: v, ...tags } : { accountId, credit: -v, ...tags };
    });

  if (existing.length === 0) {
    const nets = new Map<string, bigint>();
    for (const [code, v] of desired) nets.set(keyOf(code), (nets.get(keyOf(code)) ?? 0n) + v);
    const bankKey = `${bankGlId}||`;
    nets.set(bankKey, (nets.get(bankKey) ?? 0n) + bankTx.amount);
    return postJournal(tx, {
      entityId: bankTx.entityId,
      date: bankTx.date,
      kind: "BANK",
      memo: bankTx.description,
      bankTransactionId: bankTx.id,
      actorId: opts.actorId,
      lines: toLines(nets),
    });
  }

  const diff = new Map<string, bigint>();
  for (const l of existing) {
    const key = `${l.accountId}|${l.departmentId ?? ""}|${l.projectId ?? ""}`;
    diff.set(key, (diff.get(key) ?? 0n) - (l.debit - l.credit));
  }
  for (const [code, v] of desired) diff.set(keyOf(code), (diff.get(keyOf(code)) ?? 0n) + v);
  for (const [k, v] of diff) if (v === 0n) diff.delete(k);
  if (diff.size === 0) return null;
  return postJournal(tx, {
    entityId: bankTx.entityId,
    date: bankTx.date,
    kind: "RECLASS",
    memo: `Reklasifikasi: ${bankTx.description}`,
    bankTransactionId: bankTx.id,
    actorId: opts.actorId,
    lines: toLines(diff),
  });
}
