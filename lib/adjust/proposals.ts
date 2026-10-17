import type { Db, Tx } from "@/lib/db";
import type { ProposalSource } from "@/lib/generated/prisma/enums";
import { LedgerError, postJournal } from "@/lib/ledger/post";
import { formatDate, periodBounds } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { reviewTransactionTx } from "@/lib/review";
import { controlSnapshot } from "@/lib/controls/ai-review";
import { amountOf } from "@/lib/ai/provider";
import { bankLineAccounts, citedBankIds } from "@/lib/controls/cited";
import { PENDING_DRAFT } from "@/lib/approvals/second";

/**
 * Proposed entries (accounting-rules 20b): draft journals from the close copilot or a deterministic check. Nothing posts until
 * the accountant clicks; then postJournal() writes an ADJUSTMENT and the proposal records it (one entry per proposal).
 * The accountant may change a line's account, never its amount.
 */

export type ProposalLine = { accountCode: string; debit: string; credit: string };

/**
 * A Jurnal Penyesuaian already made the correction a draft would make: an ADJUSTMENT of the line's entity, dated from the line's
 * date to the period end, moving exactly the line's amount off its current account. Reclassifying the line as well would correct
 * it twice (staging E2E 2026-09-29, H5). Returns the Bahasa reason, or null.
 */
export async function priorCorrection(db: Db | Tx, t: { entityId: string; date: Date; amount: bigint; accountCode: string | null }, until: Date): Promise<string | null> {
  if (!t.accountCode) return null;
  const abs = t.amount < 0n ? -t.amount : t.amount;
  const line = await db.journalLine.findFirst({
    where: { entityId: t.entityId, account: { code: t.accountCode }, date: { gte: t.date, lte: until }, entry: { kind: "ADJUSTMENT", bankTransactionId: null, ledgerImportId: null }, ...(t.amount < 0n ? { credit: abs } : { debit: abs }) },
    select: { date: true, entry: { select: { memo: true, entity: { select: { functionalCurrency: true } } } } },
    orderBy: { date: "asc" },
  });
  if (!line) return null;
  return `Sudah ada Jurnal Penyesuaian ${formatDate(line.date)} "${line.entry.memo}" yang memindahkan ${formatMoney(abs, line.entry.entity.functionalCurrency)} dari ${t.accountCode}; mencatat usulan ini akan mengoreksi dua kali.`;
}

const DIGITS = /^\d{1,18}$/;

/** Lines as stored (JSON): shape-checked on every read, amounts as minor-unit strings. */
export function readLines(value: unknown): ProposalLine[] {
  if (!Array.isArray(value)) throw new LedgerError("Usulan jurnal rusak.");
  return value.map((l) => {
    const x = l as Record<string, unknown>;
    if (typeof x.accountCode !== "string" || typeof x.debit !== "string" || typeof x.credit !== "string" || !DIGITS.test(x.debit) || !DIGITS.test(x.credit)) throw new LedgerError("Usulan jurnal rusak.");
    return { accountCode: x.accountCode, debit: x.debit, credit: x.credit };
  });
}

export type NewProposal = {
  firmId: string;
  clientId: string;
  entityId: string;
  year: number;
  month: number;
  source: ProposalSource;
  controlKey?: string | null;
  key: string;
  memo: string;
  lines: ProposalLine[];
  reason: string;
  refs?: string[];
  /** The draft re-classifies this bank line (posted through the review writer, rule 3). */
  bankTransactionId?: string | null;
  /** AI drafts: fingerprint of the control's rows at draft time (`snapshotOf`). */
  snapshot?: string | null;
};

/**
 * Stores a proposal once per key (a cached AI answer or a suspense line never duplicates). A still-open draft made from books
 * that have moved since (its snapshot differs) is refreshed in place, so asking again after a stale refusal gives a postable
 * draft; a decided one stays as it was decided.
 */
export async function saveProposal(db: Db, p: NewProposal) {
  const existing = await db.proposedEntry.findUnique({ where: { key: p.key } });
  if (existing) {
    if (existing.status !== "PROPOSED" || existing.snapshot === (p.snapshot ?? null)) return existing;
    // Conditional on still PROPOSED: a post racing this refresh either wins (and this changes nothing) or fails to serialize.
    await db.proposedEntry.updateMany({
      where: { id: existing.id, status: "PROPOSED" },
      data: { memo: p.memo, lines: p.lines, reason: p.reason, refs: p.refs ?? [], bankTransactionId: p.bankTransactionId ?? null, snapshot: p.snapshot ?? null },
    });
    return db.proposedEntry.findUniqueOrThrow({ where: { id: existing.id } });
  }
  try {
    return await db.proposedEntry.create({ data: { ...p, controlKey: p.controlKey ?? null, refs: p.refs ?? [], lines: p.lines, bankTransactionId: p.bankTransactionId ?? null, snapshot: p.snapshot ?? null } });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return db.proposedEntry.findUniqueOrThrow({ where: { key: p.key } });
    throw e;
  }
}

export async function openProposals(db: Db, clientId: string, year: number, month: number) {
  return db.proposedEntry.findMany({
    where: { clientId, year, month, status: "PROPOSED" },
    include: { entity: { select: { id: true, shortName: true, functionalCurrency: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/** The accountant's click. `accounts` (optional) replaces each line's account code, in order; amounts never change. */
/** The draft's lines on the accounts the accountant chose (in order; amounts never change): each in the chart and never a bank account. */
export async function chosenAccounts(db: Db | Tx, clientId: string, lines: ProposalLine[], chosen?: string[]) {
  if (chosen && chosen.length !== lines.length) throw new LedgerError("Jumlah akun tidak sesuai dengan baris usulan.");
  const codes = lines.map((l, i) => (chosen?.[i] ?? l.accountCode).trim());
  if (codes.some((c) => !c)) throw new LedgerError("Pilih akun untuk setiap baris.");
  const accounts = new Map((await db.account.findMany({ where: { clientId, code: { in: codes } } })).map((a) => [a.code, a]));
  const posting = lines.map((l, i) => {
    const a = accounts.get(codes[i]);
    if (!a) throw new LedgerError(`Akun ${codes[i]} tidak ada di bagan akun klien.`);
    if (a.isBank) throw new LedgerError("Usulan tidak boleh mengubah akun bank; sisi bank hanya berubah lewat mutasi.");
    return { accountId: a.id, debit: BigInt(l.debit), credit: BigInt(l.credit) };
  });
  return { codes, posting };
}

/**
 * `guard` runs a caller's own precondition on the same serializable snapshot before the write; `onPosted` runs after it with the entry, in
 * the same transaction (the approval of a waiting draft records its decision there, so posting and deciding are one).
 */
export async function postProposal(db: Db, input: { clientId: string; proposalId: string; accounts?: string[]; actorId?: string | null; origin?: { ledgerImportId?: string; sourceRef?: string }; guard?: (tx: Tx) => Promise<void>; onPosted?: (tx: Tx, entry: { id: string }) => Promise<void> }) {
  const p = await db.proposedEntry.findFirst({ where: { id: input.proposalId, clientId: input.clientId } });
  if (!p) throw new LedgerError("Usulan tidak ditemukan.");
  if (p.status !== "PROPOSED") throw new LedgerError(p.status === "POSTED" ? "Usulan ini sudah dicatat." : "Usulan ini sudah diabaikan.");
  const lines = readLines(p.lines);
  const { codes, posting } = await chosenAccounts(db, input.clientId, lines, input.accounts);
  const date = periodBounds(p.year, p.month).end;
  try {
    // Freshness check and write in one SERIALIZABLE transaction: a correction someone makes meanwhile either commits first
    // (the snapshot then differs) or makes this one fail — a stale draft never posts on top of it.
    return await db.$transaction(
      async (tx) => {
        await input.guard?.(tx); // a caller's own precondition, checked on the same serializable snapshot as the write
        if (p.bankTransactionId) {
          const t = await tx.bankTransaction.findFirst({ where: { id: p.bankTransactionId, entityId: p.entityId } });
          const twice = t ? await priorCorrection(tx, t, date) : null;
          if (twice) throw new LedgerError(`${twice} Abaikan usulan ini.`);
        }
        if (p.source === "AI_CONTROL" && !p.bankTransactionId) {
          // A free draft must not touch any account a bank line it cites (directly or through its journal row) posts to, its tax
          // split included: that line only moves through the reviewer's writer (rule 3). Catches drafts stored before `jl:`/`je:` citations resolved to bank lines.
          const cited = await tx.bankTransaction.findMany({ where: { id: { in: await citedBankIds(tx, p.entityId, p.refs) }, entityId: p.entityId }, select: { id: true, accountCode: true } });
          const touched = new Set([...lines.map((l) => l.accountCode), ...codes]);
          const moved = [...(await bankLineAccounts(tx, cited)).values()].some((parts) => [...parts].some((c) => touched.has(c)));
          if (moved) throw new LedgerError("Draf ini memindahkan transaksi bank, jadi harus lewat Review. Minta Jelaskan lagi, atau abaikan draf ini.");
        }
        if (p.source === "AI_CONTROL") {
          // An AI draft is only valid for the books it was made from; one without a snapshot can't be proven fresh.
          // The control readers only read (no nested transaction), so they run on this transaction.
          const now = p.controlKey && p.snapshot ? await controlSnapshot(tx as unknown as Db, input.clientId, p.year, p.month, p.controlKey, p.bankTransactionId) : null;
          if (!now || now.snapshot !== p.snapshot) throw new LedgerError("Buku berubah sejak draf ini dibuat. Minta Jelaskan lagi, atau abaikan draf ini.");
          // Grounding is re-checked here, not only when the draft was stored: every amount is a row the draft cites (rule 20b).
          const { functionalCurrency } = await tx.entity.findUniqueOrThrow({ where: { id: p.entityId }, select: { functionalCurrency: true } });
          const cited = new Set(now.rows.filter((r) => p.refs.includes(r.id)).map((r) => amountOf(r.amount, functionalCurrency)));
          if (lines.some((l) => !cited.has(BigInt(l.debit) || BigInt(l.credit)))) {
            throw new LedgerError("Jumlah draf ini tidak berasal dari baris yang dirujuknya. Minta Jelaskan lagi, atau abaikan draf ini.");
          }
        }
        const entry = p.bankTransactionId
          ? await bankReclass(tx, p, lines, codes, input.actorId)
          : // `origin` keeps the rule-15 chain when the draft corrects an imported row (its file and sheet!row).
            await postJournal(tx, { entityId: p.entityId, date, kind: "ADJUSTMENT", memo: p.memo, lines: posting, actorId: input.actorId, ...input.origin });
        // Only a still-open proposal can be decided: a concurrent click rolls this transaction back.
        const done = await tx.proposedEntry.updateMany({ where: { id: p.id, status: "PROPOSED" }, data: { status: "POSTED", entryId: entry.id, decidedById: input.actorId ?? null, decidedAt: new Date() } });
        if (done.count !== 1) throw new LedgerError("Usulan ini sudah diputuskan.");
        await input.onPosted?.(tx, entry);
        return entry;
      },
      { isolationLevel: "Serializable", timeout: 60_000 },
    );
  } catch (e) {
    if ((e as { code?: string }).code === "P2034") throw new LedgerError("Buku sedang diubah bersamaan; coba catat lagi.");
    throw e;
  }
}

/**
 * A draft that moves one bank line to another account: the bank side never changes, so it goes through the reviewer's own
 * writer (a RECLASS of the difference, Memory learns it) instead of a free journal that would leave the line mis-coded.
 */
async function bankReclass(tx: Tx, p: { entityId: string; bankTransactionId: string | null }, lines: ProposalLine[], codes: string[], actorId?: string | null) {
  const t = await tx.bankTransaction.findFirst({ where: { id: p.bankTransactionId!, entityId: p.entityId } });
  if (!t || !t.accountCode) throw new LedgerError("Transaksi bank usulan ini tidak ditemukan.");
  const from = lines.findIndex((l) => l.accountCode === t.accountCode);
  if (from < 0 || lines.length !== 2) throw new LedgerError("Usulan ini tidak lagi cocok dengan transaksinya.");
  if (codes[from] !== t.accountCode) throw new LedgerError(`Baris ${t.accountCode} adalah akun transaksi saat ini; ganti akun tujuan saja.`);
  const target = codes[1 - from];
  if (target === t.accountCode) throw new LedgerError("Akun tujuan sama dengan akun saat ini.");
  const before = new Set((await tx.journalEntry.findMany({ where: { bankTransactionId: t.id }, select: { id: true } })).map((e) => e.id));
  // The approved draft moves the full amount: a tax split on the line would post something else, so it is released
  // (the card says so) and the line goes back to the Review queue on its new account, where the accountant confirms the
  // tax (the review control holds the close until then); Memory learns only from that final decision, never the untaxed
  // interim one. A line without a tag is simply reviewed.
  await reviewTransactionTx(tx, { bankTxId: t.id, accountCode: target, taxTag: null, actorId, learn: !t.taxTag });
  if (t.taxTag) {
    await tx.bankTransaction.update({ where: { id: t.id }, data: { status: "NEEDS_REVIEW", suggestedCode: target, reason: `Tag pajak ${t.taxTag} dilepas saat usulan dicatat; pastikan pajaknya` } });
  }
  const entry = await tx.journalEntry.findFirst({ where: { bankTransactionId: t.id, kind: "RECLASS", id: { notIn: [...before] } } });
  if (!entry) throw new LedgerError("Tidak ada selisih untuk direklasifikasi.");
  return entry;
}

export async function dismissProposal(db: Db, input: { clientId: string; proposalId: string; actorId?: string | null }) {
  // A draft waiting for a second approver (Persetujuan kedua) is decided in Kotak persetujuan, never dismissed under it.
  if (await db.journalApproval.findFirst({ where: { proposalId: input.proposalId, status: "PENDING" }, select: { id: true } })) throw new LedgerError(PENDING_DRAFT);
  const done = await db.proposedEntry.updateMany({ where: { id: input.proposalId, clientId: input.clientId, status: "PROPOSED" }, data: { status: "DISMISSED", decidedById: input.actorId ?? null, decidedAt: new Date() } });
  if (done.count !== 1) throw new LedgerError("Usulan tidak ditemukan atau sudah diputuskan.");
}

/** Plain JSON for the proposals card (bigint as strings). */
export async function proposalViews(db: Db, clientId: string, year: number, month: number) {
  // 1999 corrections are shown from their source line (lib/adjust/suspense), never twice; a draft waiting for a second approver shows
  // under Persetujuan kedua instead (lib/approvals/queue.ts), never twice either. One rejected there comes back with the reason.
  const open = (await openProposals(db, clientId, year, month)).filter((p) => p.source !== "SUSPENSE");
  const asked = await db.journalApproval.findMany({
    where: { proposalId: { in: open.map((p) => p.id) } },
    select: { proposalId: true, status: true, note: true, decidedBy: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  const waiting = new Set(asked.filter((a) => a.status === "PENDING").map((a) => a.proposalId));
  // The latest decided request per draft: only a rejection is shown (a withdrawn one says nothing).
  const latest = new Map<string, (typeof asked)[number]>();
  for (const a of asked) if (a.proposalId && a.status !== "PENDING" && !latest.has(a.proposalId)) latest.set(a.proposalId, a);
  const rejected = (id: string) => {
    const a = latest.get(id);
    return a?.status === "REJECTED" ? `Ditolak ${a.decidedBy?.name ?? "anggota lain"}: ${a.note}` : null;
  };
  const rows = open.filter((p) => !waiting.has(p.id));
  const txs = new Map((await db.bankTransaction.findMany({ where: { id: { in: rows.flatMap((p) => (p.bankTransactionId ? [p.bankTransactionId] : [])) } }, select: { id: true, entityId: true, date: true, amount: true, accountCode: true, taxTag: true } })).map((t) => [t.id, t]));
  const end = periodBounds(year, month).end;
  const blocked = new Map<string, string>();
  for (const p of rows) {
    const t = p.bankTransactionId ? txs.get(p.bankTransactionId) : null;
    const why = t ? await priorCorrection(db, t, end) : null;
    if (why) blocked.set(p.id, why);
  }
  return rows.map((p) => {
    const lines = readLines(p.lines);
    const tx = p.bankTransactionId ? txs.get(p.bankTransactionId) : null;
    const fixed = tx?.accountCode ? lines.findIndex((l) => l.accountCode === tx.accountCode) : -1;
    const reason = tx?.taxTag ? `${p.reason} · Tag pajak transaksi ini dilepas saat dicatat; transaksinya kembali ke Review untuk memastikan pajaknya.` : p.reason;
    return { id: p.id, memo: p.memo, reason, source: p.source, entityId: p.entityId, entity: p.entity.shortName, currency: p.entity.functionalCurrency, fixed: fixed >= 0 ? fixed : null, lines, blocked: blocked.get(p.id) ?? null, rejected: rejected(p.id) };
  });
}
