import { recordEvent } from "@/lib/audit";
import { formatMoney, MoneyError, parseMoney } from "@/lib/money";
import { formatPeriod } from "@/lib/format";
import { isSimpleGuess, simpleGuess } from "@/lib/classify/fallback";
import type { Db, Tx } from "@/lib/db";
import type { TaxTag } from "@/lib/generated/prisma/enums";
import { postBankTransaction } from "@/lib/ledger/bank";
import { LedgerError, lockedAfter } from "@/lib/ledger/post";
import { isGenericKey } from "@/lib/import/normalize";
import { ACCOUNT_CODES, isClassifiable, isIntercompanyCode } from "@/lib/coa/template";
import { defaultTaxMonth } from "@/lib/tax/masa";
import { checkWithholding, type Withholding } from "@/lib/tax/withholding";

/** What a line in Review proposed when the reviewer decided on it, as its `CLASSIFY` event keeps it (`after.suggestion`). */
export type ClassifySuggestion = { accountCode: string; taxTag: TaxTag | null; method: string; confidence: number };

type ReviewArgs = {
  bankTxId: string;
  accountCode: string;
  taxTag: TaxTag | null;
  createRule?: boolean;
  actorId?: string | null;
  /**
   * false: a provisional decision (the line goes back to Review) — Memory learns only from the final one. Unset: learns, except a simple
   * guess accepted unchanged (fallback.ts `isSimpleGuess`), which is no one's decision yet. true: learns anyway (the seed's ground truth).
   */
  learn?: boolean;
  /**
   * Tax withheld from this payment or receipt (rent, services, a customer's PPh 23): the part not in the bank amount, posted on the
   * classification side (accounting-rules 5h). undefined keeps what the line has; null removes it.
   */
  withholding?: Withholding | null;
  /**
   * The reviewer chose one account for a split line (Buku Besar's *Simpan*): the parts go. Any other caller — settling, proposals,
   * similar lines — is refused while a split stands, so its parts never vanish silently.
   */
  replaceSplit?: boolean;
  /** Departemen & Proyek chosen with the decision (Review); undefined keeps the line's. */
  tags?: BankTags;
};

/**
 * Reviewer decision on a bank line. Posts a RECLASS (difference only), marks REVIEWED,
 * and always feeds the learning loop (Memory) so the next import needs fewer AI calls.
 */
export async function reviewTransaction(db: Db, args: ReviewArgs) {
  return db.$transaction((tx) => reviewTransactionTx(tx, args));
}

/** The same decision inside a caller's transaction (a posted proposal records the RECLASS it produced atomically). */
export async function reviewTransactionTx(tx: Tx, args: ReviewArgs) {
  // One writer at a time per bank line (a split, a review and a settlement serialise here).
  await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE id = ${args.bankTxId} FOR UPDATE`;
  const t = await tx.bankTransaction.findUniqueOrThrow({
    where: { id: args.bankTxId },
    include: { bankAccount: { include: { entity: true } }, settlements: { select: { withheld: true, invoice: { select: { number: true, arApAccount: { select: { code: true } } } } } } },
  });
  const clientId = t.bankAccount.entity.clientId;
  const generic = isGenericKey(t.merchantKey);
  if (args.createRule && generic) {
    throw new LedgerError(`Keterangan "${t.merchantKey}" tidak menyebut pengirim atau penerima, jadi tidak bisa dijadikan aturan. Pilih akunnya per transaksi.`);
  }
  // A line that settles invoices stays on their receivable/payable account (rule 5c): moving it would leave them paid by money the
  // ledger no longer shows there.
  const away = t.settlements.filter((s) => s.invoice.arApAccount.code !== args.accountCode);
  if (away.length) {
    throw new LedgerError(`Mutasi ini melunasi ${away.map((s) => s.invoice.number).join(", ")} di akun ${away[0].invoice.arApAccount.code}. Hapus pencocokannya dulu di Piutang & Utang sebelum mengubah akunnya.`);
  }
  // Withholding that comes from settlements is changed by (un)settling, not by hand: the invoice's amounts would no longer add up.
  const settledWht = t.settlements.reduce((sum, x) => sum + x.withheld, 0n);
  if (settledWht > 0n && args.withholding !== undefined && ((args.withholding?.amount ?? 0n) !== t.whtAmount || (args.withholding?.kind ?? null) !== t.whtKind)) {
    throw new LedgerError("Pemotongan pajak pada mutasi ini berasal dari pencocokan faktur. Ubah lewat pencocokan (hapus, lalu cocokkan lagi).");
  }
  // The withholding stays with the line through a change of account (the tax was withheld whichever account it files to), except in Review.
  const held = t.whtKind && t.whtAmount > 0n ? { kind: t.whtKind, amount: t.whtAmount } : null;
  const withholding = args.withholding === undefined ? (args.accountCode === ACCOUNT_CODES.SUSPENSE ? null : held) : args.withholding && checkWithholding(args.withholding, t.direction);
  // One account replaces a split (pecah transaksi): the parts go, and the posting moves the difference back onto that account.
  const parts = await tx.bankTxSplit.findMany({ where: { bankTransactionId: t.id }, orderBy: { position: "asc" }, select: { accountCode: true, amount: true } });
  if (parts.length && !args.replaceSplit) throw new LedgerError("Mutasi ini dipecah ke beberapa akun. Ubah lewat Pecah transaksi, atau gabungkan dulu ke satu akun di Buku Besar.");
  if (parts.length) await tx.bankTxSplit.deleteMany({ where: { bankTransactionId: t.id } });
  // Tags chosen with the decision are on the line before it posts (postBankTransaction reads them from it).
  const tags = args.tags && { departmentId: args.tags.departmentId || null, projectId: args.tags.projectId || null };
  const retag = !!tags && (tags.departmentId !== t.departmentId || tags.projectId !== t.projectId);
  if (retag) {
    await checkBankTags(tx, clientId, t, tags);
    await tx.bankTransaction.update({ where: { id: t.id }, data: tags });
  }
  const entry = await postBankTransaction(tx, t.id, { accountCode: args.accountCode, taxTag: args.taxTag, withholding }, { actorId: args.actorId });
  // The proposal this decision was taken on (a line still in Review): kept on the event with the RECLASS it produced, so the entry
  // names its origin ("Usulan AI 6120 (92 %) disetujui", lib/reports/entry-origin.ts). A later *Ubah akun* decides on no proposal.
  const suggestion: ClassifySuggestion | null = t.status === "NEEDS_REVIEW" && t.suggestedCode ? { accountCode: t.suggestedCode, taxTag: t.taxTag, method: t.method, confidence: t.confidence } : null;
  // Merging a split back is a decision too, even onto the account first suggested.
  const changed = args.accountCode !== t.suggestedCode || args.taxTag !== t.taxTag || parts.length > 0;
  // Riwayat (ADR 0013): every decision that moves the line's classification, from where it was to where it goes.
  const from = { accountCode: t.accountCode, taxTag: t.taxTag, whtKind: t.whtKind, whtAmount: t.whtAmount.toString(), ...(retag ? { departmentId: t.departmentId, projectId: t.projectId } : {}), ...(parts.length ? { parts: parts.map((p) => ({ accountCode: p.accountCode, amount: p.amount.toString() })) } : {}) };
  const to = { accountCode: args.accountCode, taxTag: args.taxTag, whtKind: withholding?.kind ?? null, whtAmount: (withholding?.amount ?? 0n).toString(), ...(retag ? tags : {}) };
  if (JSON.stringify(from) !== JSON.stringify(to)) {
    const tag = (x: { accountCode: string | null; taxTag: string | null; parts?: unknown[] }) => `${x.parts ? "dipecah " : ""}${x.accountCode ?? "—"}${x.taxTag ? ` (${x.taxTag})` : ""}`;
    await recordEvent(tx, {
      clientId,
      entityId: t.entityId,
      kind: "CLASSIFY",
      subject: `bankTx:${t.id}`,
      summary: `${t.description.slice(0, 70)} · ${formatMoney(t.amount < 0n ? -t.amount : t.amount, t.bankAccount.currency)}: ${tag(from)} → ${tag(to)}`,
      before: from,
      after: { ...to, suggestion, entryId: entry?.id ?? null },
      actorId: args.actorId,
    });
  }
  // A paired half moved off the transfer accounts is no longer half of a transfer (UC-B2): the link goes, and this line is never paired
  // again; its old partner may still find its real other half.
  const leavesPair = t.matchedTxId !== null && args.accountCode !== ACCOUNT_CODES.CLEARING && !isIntercompanyCode(args.accountCode);
  if (leavesPair) await tx.bankTransaction.updateMany({ where: { id: t.matchedTxId!, matchedTxId: t.id }, data: { matchedTxId: null } });
  await tx.bankTransaction.update({
    where: { id: t.id },
    data: {
      status: "REVIEWED",
      accountCode: args.accountCode,
      taxTag: args.taxTag,
      // The masa pajak of a PPh 25 instalment: the month before payment unless the accountant set one; none once it isn't PPh 25.
      taxMonth: args.taxTag === "PPH_25" ? (t.taxMonth ?? defaultTaxMonth(t.date)) : null,
      whtKind: withholding?.kind ?? null,
      whtAmount: withholding?.amount ?? 0n,
      method: changed ? "MANUAL" : t.method,
      reason: parts.length ? `Pecahan digabung ke ${args.accountCode}` : changed ? "Diubah oleh reviewer" : t.reason,
      ...(leavesPair ? { matchedTxId: null, pairRefused: true } : {}),
    },
  });
  // A key without a counterparty covers unrelated payments: never learned (normalize.ts, isGenericKey).
  const learn = args.learn ?? !(isSimpleGuess(t) && !changed && !args.createRule);
  if (learn && !generic) await tx.memory.upsert({
    where: { clientId_merchantKey_direction: { clientId, merchantKey: t.merchantKey, direction: t.direction } },
    create: { clientId, merchantKey: t.merchantKey, direction: t.direction, accountCode: args.accountCode, taxTag: args.taxTag },
    update: { accountCode: args.accountCode, taxTag: args.taxTag, hits: { increment: 1 } },
  });
  if (args.createRule) {
    await tx.rule.create({
      data: { firmId: t.firmId, clientId, pattern: t.merchantKey, direction: t.direction, accountCode: args.accountCode, taxTag: args.taxTag, priority: 60, source: "USER" },
    });
  }
  return { id: t.id, learned: learn && !generic };
}

type BankTags = { departmentId: string | null; projectId: string | null };

/** The client's own department and project of the right kind; an archived one only when the line already carries it. */
async function checkBankTags(tx: Tx, clientId: string, t: BankTags, next: BankTags) {
  const ids = [next.departmentId, next.projectId].filter((x): x is string => !!x);
  const dims = new Map((await tx.dimension.findMany({ where: { id: { in: ids }, clientId } })).map((d) => [d.id, d]));
  for (const [id, kind, label] of [[next.departmentId, "DEPARTEMEN", "Departemen"], [next.projectId, "PROYEK", "Proyek"]] as const) {
    if (!id) continue;
    const d = dims.get(id);
    if (!d || d.kind !== kind) throw new LedgerError(`${label} tidak termasuk klien ini.`);
    // Keeping an archived tag the line already has is fine; choosing one is not.
    if (d.archivedAt && id !== (kind === "DEPARTEMEN" ? t.departmentId : t.projectId)) throw new LedgerError(`${label} ${d.code} ${d.name} sudah diarsipkan. Aktifkan lagi di Pengaturan klien untuk memakainya.`);
  }
  return dims;
}

/**
 * Departemen & Proyek on a bank line (Review, Buku Besar): stored on the line and moved in the ledger by a RECLASS of the classification
 * account (each part of a split) from the old tags to the new — the account, tax and bank legs stay. A line still in Review keeps the tags
 * for when it is classified (its suspense leg carries none). An archived tag can't be chosen; empty removes it.
 */
export async function setBankTagsTx(tx: Tx, args: BankTags & { bankTxId: string; actorId?: string | null }) {
  await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE id = ${args.bankTxId} FOR UPDATE`;
  const t = await tx.bankTransaction.findUniqueOrThrow({ where: { id: args.bankTxId }, include: { bankAccount: { include: { entity: true } }, splits: { orderBy: { position: "asc" } } } });
  const clientId = t.bankAccount.entity.clientId;
  const next = { departmentId: args.departmentId || null, projectId: args.projectId || null };
  if (next.departmentId === t.departmentId && next.projectId === t.projectId) return null;
  const dims = await checkBankTags(tx, clientId, t, next);
  // A closed month (or one before a closed month) keeps its lines as they are, the tags on the row included: a line still in Review posts
  // nothing here, so postJournal's lock check would never run for it.
  const month = { year: t.date.getUTCFullYear(), month: t.date.getUTCMonth() + 1 };
  const closed = (await tx.period.findFirst({ where: { clientId, ...month, status: "LOCKED" }, select: { year: true, month: true } })) ?? (await lockedAfter(tx, clientId, month.year, month.month));
  if (closed) throw new LedgerError(`${formatPeriod(closed.year, closed.month)} sudah ditutup. Buka kembali bulan itu dulu di Tutup Buku untuk mengubah departemen atau proyek mutasi ini.`);
  await tx.bankTransaction.update({ where: { id: t.id }, data: next });
  // Re-posted with the line's classification as it stands; postBankTransaction reads the new tags from the line. A line still in Review
  // sits on 1999, whose leg carries no tag: nothing to move, and its suggestion (PPN, withholding) is nobody's decision yet.
  let entry = null;
  if (t.accountCode && t.status !== "NEEDS_REVIEW") {
    const held = t.whtKind && t.whtAmount > 0n ? { kind: t.whtKind, amount: t.whtAmount } : null;
    const target = t.splits.length ? { accountCode: t.accountCode, parts: t.splits.map((p) => ({ accountCode: p.accountCode, amount: p.amount })) } : { accountCode: t.accountCode, taxTag: t.taxTag, withholding: held };
    entry = await postBankTransaction(tx, t.id, target, { actorId: args.actorId });
  }
  const names = new Map([...dims.values()].map((d) => [d.id, d.code]));
  const before = await tx.dimension.findMany({ where: { id: { in: [t.departmentId, t.projectId].filter((x): x is string => !!x) } }, select: { id: true, code: true } });
  for (const d of before) names.set(d.id, d.code);
  const show = (x: { departmentId: string | null; projectId: string | null }) => [x.departmentId, x.projectId].flatMap((id) => (id ? [names.get(id) ?? "?"] : [])).join(" · ") || "tanpa tag";
  await recordEvent(tx, {
    clientId,
    entityId: t.entityId,
    kind: "DIMENSION",
    subject: `bankTx:${t.id}`,
    summary: `${t.description.slice(0, 70)} · ${formatMoney(t.amount < 0n ? -t.amount : t.amount, t.bankAccount.currency)}: ${show(t)} → ${show(next)}`,
    before: { departmentId: t.departmentId, projectId: t.projectId },
    after: { ...next, entryId: entry?.id ?? null },
    actorId: args.actorId,
  });
  return entry;
}

/**
 * Sets the tax withheld on a settled bank line (its classification stays): posts the RECLASS of the difference. Used by (un)settling an
 * invoice, which owns the amount; null removes it.
 */
export async function setWithholdingTx(tx: Tx, bankTxId: string, withholding: Withholding | null, actorId?: string | null) {
  const t = await tx.bankTransaction.findUniqueOrThrow({ where: { id: bankTxId } });
  if (t.status === "NEEDS_REVIEW" || !t.accountCode) throw new LedgerError("Klasifikasikan mutasi ini dulu sebelum mencatat pemotongan pajak.");
  if (withholding) checkWithholding(withholding, t.direction);
  await postBankTransaction(tx, t.id, { accountCode: t.accountCode, taxTag: t.taxTag, withholding }, { actorId });
  await tx.bankTransaction.update({ where: { id: t.id }, data: { whtKind: withholding?.kind ?? null, whtAmount: withholding?.amount ?? 0n } });
}

/**
 * Accept every open line with the same merchant key + direction: with the source line's suggestion, or with the account/tax
 * the reviewer chose on it (`choice`). A generic key groups nothing. Returns the ids decided.
 */
export async function acceptSimilar(
  db: Db,
  bankTxId: string,
  scope?: { entityIds: string[]; through: Date },
  actorId?: string | null,
  choice?: { accountCode: string; taxTag: TaxTag | null },
): Promise<string[]> {
  const t = await db.bankTransaction.findUniqueOrThrow({ where: { id: bankTxId } });
  const entity = await db.entity.findUniqueOrThrow({ where: { id: t.entityId } });
  const peers = await db.bankTransaction.findMany({
    where: {
      ...(scope ? { entityId: { in: scope.entityIds }, date: { lte: scope.through } } : {}),
      bankAccount: { entity: { clientId: entity.clientId } },
      ...(isGenericKey(t.merchantKey) ? { id: t.id } : { merchantKey: t.merchantKey, direction: t.direction }),
      status: "NEEDS_REVIEW",
    },
  });
  const accountCode = choice?.accountCode ?? t.suggestedCode ?? simpleGuess(t.direction, entity.kind).accountCode;
  const taxTag = choice ? choice.taxTag : t.taxTag;
  for (const p of peers) {
    await reviewTransaction(db, { bankTxId: p.id, accountCode, taxTag, actorId });
  }
  return peers.map((p) => p.id);
}

/**
 * *Lepas pasangan* (use-case feedback UC-B2): the reviewer says two lines are not one transfer. Both halves go back to Review on 1999
 * through the bank writer (a RECLASS of the difference; the bank side never moves), lose their link, and are marked so no later import
 * pairs them again. Their transfer suggestion stays for the reviewer to accept or change. A locked month refuses (postJournal).
 */
export async function unpairTransfer(db: Db, args: { clientId: string; bankTxId: string; actorId?: string | null }) {
  return db.$transaction(async (tx) => {
    const t = await tx.bankTransaction.findFirst({ where: { id: args.bankTxId, bankAccount: { entity: { clientId: args.clientId } } } });
    if (!t) throw new LedgerError("Mutasi tidak ditemukan.");
    if (!t.matchedTxId) throw new LedgerError("Mutasi ini tidak berpasangan dengan transfer lain.");
    const halves = await tx.bankTransaction.findMany({ where: { id: { in: [t.id, t.matchedTxId] }, bankAccount: { entity: { clientId: args.clientId } } }, include: { settlements: { select: { invoice: { select: { number: true } } } } } });
    // A half that settles invoices stays where they are paid (rule 5c): unsettle first.
    const settled = halves.flatMap((h) => h.settlements.map((x) => x.invoice.number));
    if (settled.length) throw new LedgerError(`Mutasi ini melunasi ${settled.join(", ")}. Hapus pencocokannya dulu di Piutang & Utang sebelum melepas pasangannya.`);
    await recordEvent(tx, {
      clientId: args.clientId,
      entityId: t.entityId,
      kind: "UNPAIR",
      subject: `bankTx:${t.id}`,
      summary: `Pasangan transfer dilepas: ${halves.map((h) => `${h.description.slice(0, 50)} (${h.accountCode})`).join(" ↔ ")}; keduanya kembali ke Review`,
      before: { pair: halves.map((h) => ({ id: h.id, accountCode: h.accountCode })) },
      after: { accountCode: ACCOUNT_CODES.SUSPENSE },
      actorId: args.actorId,
    });
    for (const h of halves) {
      if (h.id !== t.id) await recordEvent(tx, { clientId: args.clientId, entityId: h.entityId, kind: "UNPAIR", subject: `bankTx:${h.id}`, summary: `Pasangan transfer dilepas (bersama ${t.description.slice(0, 50)}); kembali ke Review`, before: { accountCode: h.accountCode }, after: { accountCode: ACCOUNT_CODES.SUSPENSE }, actorId: args.actorId });
      await postBankTransaction(tx, h.id, { accountCode: ACCOUNT_CODES.SUSPENSE }, { actorId: args.actorId });
      await tx.bankTransaction.update({
        where: { id: h.id },
        data: {
          status: "NEEDS_REVIEW",
          accountCode: ACCOUNT_CODES.SUSPENSE,
          suggestedCode: h.accountCode,
          taxTag: null,
          whtKind: null,
          whtAmount: 0n,
          matchedTxId: null,
          pairRefused: true,
          reason: "Pasangan transfer dilepas oleh reviewer: pilih akunnya",
        },
      });
    }
    return halves.map((h) => h.id);
  });
}

export type SplitPartInput = { accountCode: string; amount: string; memo?: string | null };

/**
 * Pecah transaksi (use-case UC-B3): one bank line's classification side split across accounts — a combined transfer ("gaji + ongkos
 * produksi"). The parts must add up exactly to the line; each is posted as its own leg of a RECLASS of the difference, keeping
 * `bankTransactionId`, so every part drills to the bank row. Never learned (a combined transfer is a one-off) and never paired.
 */
export async function splitTransaction(db: Db, args: { bankTxId: string; parts: SplitPartInput[]; actorId?: string | null }) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE id = ${args.bankTxId} FOR UPDATE`;
    const t = await tx.bankTransaction.findUniqueOrThrow({
      where: { id: args.bankTxId },
      include: { bankAccount: { include: { entity: true } }, settlements: { select: { invoice: { select: { number: true } } } }, splits: { orderBy: { position: "asc" } } },
    });
    // Checked here, not left to the posting: an unchanged re-split posts nothing, and a closed month's parts must not move either.
    const month = { year: t.date.getUTCFullYear(), month: t.date.getUTCMonth() + 1 };
    if (await tx.period.findFirst({ where: { clientId: t.bankAccount.entity.clientId, ...month, status: "LOCKED" }, select: { id: true } })) {
      throw new LedgerError(`${formatPeriod(month.year, month.month)} sudah dikunci. Buka kunci bulan itu dulu untuk memecah mutasi ini.`);
    }
    const clientId = t.bankAccount.entity.clientId;
    // The line's own currency: the one its amount is shown in (Review, Buku Besar) and the one the parts are typed in.
    const currency = t.bankAccount.currency;
    const total = t.amount < 0n ? -t.amount : t.amount;
    if (t.matchedTxId) throw new LedgerError("Mutasi ini dipasangkan sebagai transfer antar rekening. Lepas pasangannya dulu, lalu pecah.");
    if (t.settlements.length) throw new LedgerError(`Mutasi ini melunasi ${t.settlements.map((x) => x.invoice.number).join(", ")}. Hapus pencocokannya dulu di Piutang & Utang, lalu pecah.`);
    // A line still in Review only has a suggested tag (its posting is on 1999): the tax that blocks a split is one posted on the line.
    if ((t.taxTag && t.status !== "NEEDS_REVIEW") || t.whtAmount > 0n) throw new LedgerError("Mutasi ini memakai pajak (PPN/PPh). Pecahan belum mendukung pajak per bagian: hapus pajaknya di Review dulu, lalu catat pajaknya lewat jurnal.");
    const parts = args.parts.filter((p) => p.accountCode || p.amount?.trim());
    if (parts.length < 2) throw new LedgerError("Pecah ke setidaknya dua akun.");

    const accounts = new Map((await tx.account.findMany({ where: { clientId } })).map((a) => [a.code, a]));
    const blocked = new Set<string>([ACCOUNT_CODES.SUSPENSE, ACCOUNT_CODES.CLEARING, ACCOUNT_CODES.INTERCOMPANY]);
    const seen = new Set<string>();
    const parsed = parts.map((p, i) => {
      const n = i + 1;
      const a = accounts.get(p.accountCode);
      if (!a) throw new LedgerError(`Bagian ${n}: pilih akun.`);
      if (blocked.has(a.code) || isIntercompanyCode(a.code) || !isClassifiable(a)) throw new LedgerError(`Bagian ${n}: akun ${a.code} ${a.name} tidak bisa dipakai untuk pecahan. Pilih akun pendapatan, beban, aset atau liabilitas.`);
      if (seen.has(a.code)) throw new LedgerError(`Akun ${a.code} ${a.name} dipakai di dua bagian. Gabungkan nominalnya dalam satu bagian.`);
      seen.add(a.code);
      let amount: bigint;
      try {
        amount = parseMoney(p.amount ?? "", currency);
      } catch (e) {
        throw new LedgerError(`Bagian ${n}: ${e instanceof MoneyError ? e.message : "nominal tidak terbaca."}`);
      }
      if (amount <= 0n) throw new LedgerError(`Bagian ${n}: isi nominal lebih dari nol.`);
      return { accountCode: a.code, amount, memo: p.memo?.trim() || null };
    });
    const sum = parsed.reduce((s, p) => s + p.amount, 0n);
    if (sum !== total) {
      const gap = total - sum;
      throw new LedgerError(`Jumlah bagian ${formatMoney(sum, currency)} belum sama dengan nominal mutasi ${formatMoney(total, currency)} (${gap > 0n ? "kurang" : "lebih"} ${formatMoney(gap > 0n ? gap : -gap, currency)}).`);
    }

    // The largest part names the line for filters and controls (the 6101 leakage control, Review lists); the parts are the posting.
    const main = parsed.reduce((m, p) => (p.amount > m.amount ? p : m), parsed[0]);
    const same = t.splits.length === parsed.length && t.splits.every((p, i) => p.accountCode === parsed[i].accountCode && p.amount === parsed[i].amount && (p.memo ?? null) === parsed[i].memo);
    if (same) return { id: t.id, parts: parsed.length };
    await tx.bankTxSplit.deleteMany({ where: { bankTransactionId: t.id } });
    await tx.bankTxSplit.createMany({ data: parsed.map((p, i) => ({ firmId: t.firmId, bankTransactionId: t.id, position: i, accountCode: p.accountCode, amount: p.amount, memo: p.memo })) });
    await postBankTransaction(tx, t.id, { accountCode: main.accountCode, parts: parsed }, { actorId: args.actorId });
    await tx.bankTransaction.update({
      where: { id: t.id },
      data: { status: "REVIEWED", accountCode: main.accountCode, taxTag: null, taxMonth: null, method: "MANUAL", reason: `Dipecah ke ${parsed.length} akun` },
    });
    const show = (ps: { accountCode: string; amount: bigint }[]) => ps.map((p) => `${p.accountCode} ${formatMoney(p.amount, currency)}`).join(" + ");
    await recordEvent(tx, {
      clientId,
      entityId: t.entityId,
      kind: "CLASSIFY",
      subject: `bankTx:${t.id}`,
      summary: `${t.description.slice(0, 70)} · ${formatMoney(total, currency)}: ${t.splits.length ? `dipecah ${show(t.splits)}` : (t.accountCode ?? "—")} → dipecah ${show(parsed)}`,
      before: t.splits.length ? { parts: t.splits.map((p) => ({ accountCode: p.accountCode, amount: p.amount.toString() })) } : { accountCode: t.accountCode, taxTag: t.taxTag },
      after: { parts: parsed.map((p) => ({ accountCode: p.accountCode, amount: p.amount.toString(), memo: p.memo })) },
      actorId: args.actorId,
    });
    return { id: t.id, parts: parsed.length };
  });
}

