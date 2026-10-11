import { revalidateLegacy } from "@/lib/import/revalidate";
import { guardTransferCounterparts } from "@/lib/import/transfer-guard";
import { createHash } from "node:crypto";
import { validateStatement, readValidation } from "@/lib/import/validation";
import { dedupeStatement as dedupe } from "@/lib/import/dedupe";
import type { Db } from "@/lib/db";
import type { BankCode, ClassifyMethod, Direction } from "@/lib/generated/prisma/enums";
import { ACCOUNT_CODES, isClassifiable } from "@/lib/coa/template";
import { parseStatementSections } from "@/lib/import/parsers";
import { checkContinuity, isGenericKey, merchantKey, rowHashes } from "@/lib/import/normalize";
import { AccountMismatchError, ParseError, UnreadableFileError, type ParsedStatement } from "@/lib/import/types";
import type { RememberedLayout } from "@/lib/import/mapped";
import { matchRule, sortRules } from "@/lib/classify/rules";
import { financingSuggestion, taxPaymentSuggestion } from "@/lib/classify/financing";
import { simpleGuess } from "@/lib/classify/fallback";
import { matchTransfers } from "@/lib/classify/transfer";
import { AUTO_POST_CONFIDENCE, type Classification } from "@/lib/classify/types";
import { aiScope, suggestWithAi } from "@/lib/ai/classify";
import { demoteUnbacked, tradeBacking } from "@/lib/ai/unbacked";
import type { AiProvider } from "@/lib/ai/provider";
import { postBankTransaction } from "@/lib/ledger/bank";
import { defaultTaxMonth } from "@/lib/tax/masa";
import { formatDate, formatPeriod } from "@/lib/format";
import { formatMoney } from "@/lib/money";

export type ImportSummary = {
  importId: string;
  rows: number;
  duplicates: number;
  posted: number;
  needsReview: number;
  byMethod: Record<ClassifyMethod, number>;
  /** `later`: with `aiLater`, the lines of this import left on a simple guess for the client's background run (lib/ai/run.ts). */
  ai: { calls: number; cacheHits: number; note?: string; later?: number };
  continuityOk: boolean;
  continuityNote: string | null;
  /** Combined statements: the other account sections in the file, not imported into this bank account. */
  otherSections: string[];
  /** The same sections as data, so the form can offer "Impor juga ke …" for the client's matching accounts. */
  otherAccounts: { number: string; label: string; currency: string; imported: boolean }[];
  /** Lines of this client still waiting in Review after the import (any month), for the result's next step. */
  pendingReview: number;
  /** Choices the parser made (direction read from the balance, sheets joined): stored on the import and shown. */
  notes: string[];
  /** The months the statement covers ("Mei 2026"), first to last. */
  months: string[];
  /** The bank the file names (its heading, or an MT940 BIC); GENERIC when it names none. The form says so when it differs from the account's. */
  fileBank: BankCode;
  /** Read with a layout the firm mapped in *Atur kolom*: the result offers *Lupakan pemetaan ini*. */
  layout: { id: string; label: string } | null;
};

export async function importStatement(
  db: Db,
  args: { sourceProvenance?: ParsedStatement["provenance"]; evidenceVersionId?: string; evidenceUnitKey?: string; bankAccountId: string; fileName: string; data: Buffer; provider: AiProvider | null; password?: string; year?: number; actorId?: string | null; /** Answer from the cache only and leave the rest to the client's background run: no AI call inside the import. */ aiLater?: boolean },
): Promise<ImportSummary> {
  const bankAccount = await db.bankAccount.findUniqueOrThrow({
    where: { id: args.bankAccountId },
    include: { entity: { include: { client: { include: { entities: true } } } } },
  });
  const entity = bankAccount.entity;
  const client = entity.client;
  if (bankAccount.currency !== "IDR" || entity.functionalCurrency !== "IDR") {
    throw new ParseError("Rekening koran baru didukung untuk rekening dan pembukuan Rupiah. Untuk valas, impor lewat buku besar dengan kurs.");
  }

  // The firm's Atur kolom layouts for this account's bank, tried only when every reader refuses the file (`parseStatementSections`). Rupiah
  // accounts only: a mapped read parses amounts as Rupiah, as the first mapping (`createMappedDraft`) requires too.
  const rupiah = bankAccount.currency === "IDR" && entity.functionalCurrency === "IDR";
  const layouts = rupiah
    ? (await db.statementLayout.findMany({ where: { firmId: bankAccount.firmId, bank: bankAccount.bank }, select: { id: true, label: true, signature: true, mapping: true } })).map((l) => ({ ...l, mapping: l.mapping as unknown as RememberedLayout["mapping"] }))
    : [];
  const sections = await parseStatementSections(args.fileName, args.data, { password: args.password, year: args.year, layouts });
  const digits = (s: string | null) => (s ?? "").replace(/\D/g, "");
  let st = sections.length === 1 ? sections[0] : sections.find((s) => digits(s.accountNumber) === digits(bankAccount.number));
  if (!st) {
    const list = sections.map((s) => `${s.accountNumber}${s.section ? ` ${s.section.label} (${s.section.currency})` : ""}`).join(", ");
    throw new AccountMismatchError(`File ini berisi ${sections.length} rekening (${list}), tapi tidak ada nomor ${bankAccount.number}. Pilih rekening yang sesuai atau tambahkan rekeningnya di klien.`, sections.flatMap((s) => (s.accountNumber ? [s.accountNumber] : [])));
  }
  if (st.accountNumber && digits(st.accountNumber) !== digits(bankAccount.number)) {
    throw new AccountMismatchError(`Nomor rekening di file (${st.accountNumber}) berbeda dengan rekening terpilih (${bankAccount.number}).`, [st.accountNumber]);
  }
  const sourceCurrency = st.currency ?? st.section?.currency;
  if (sourceCurrency && sourceCurrency !== "IDR") {
    throw new ParseError(`Rekening ${st.accountNumber} dalam ${sourceCurrency}. Rekening koran valas belum didukung; impor lewat buku besar dengan kurs.`);
  }
  // The section as parsed (and repaired against its balance, rule 12): `st` is replaced below, the other sections are told apart from it.
  const chosen = st;
  if (args.sourceProvenance) st = { ...st, provenance: args.sourceProvenance };
  if (st.error) throw new UnreadableFileError(st.error);
  // A date that is nowhere near a statement (an Excel serial misread as 1905) must never become a period of the books.
  const odd = st.rows.find((r) => r.date.getUTCFullYear() < 2000 || r.date.getUTCFullYear() > 2100);
  if (odd) throw new ParseError(`Tanggal di baris ${odd.rowNumber}${odd.sheet ? ` (lembar ${odd.sheet})` : ""} tidak masuk akal: ${formatDate(odd.date)}. Periksa kolom tanggal di file.`);
  // An amount beyond any real account would only fail later at the database with no explanation.
  const LIMIT = 10n ** 15n;
  const huge = st.rows.find((r) => r.amount > LIMIT || r.amount < -LIMIT || (r.balance !== null && (r.balance > LIMIT || r.balance < -LIMIT)));
  if (huge) throw new ParseError(`Nominal terlalu besar di baris ${huge.rowNumber}${huge.sheet ? ` (lembar ${huge.sheet})` : ""} (maks. 15 angka). Periksa kolom jumlah dan saldo di file.`);
  if ([st.openingBalance, st.closingBalance].some((v) => v > LIMIT || v < -LIMIT)) throw new ParseError("Saldo awal atau akhir terlalu besar (maks. 15 angka). Periksa angka pada sumber.");
  const unresolved = st.rows.find((r) => r.balanceOnly);
  if (unresolved) throw new ParseError(`Baris ${unresolved.rowNumber}: saldo berubah tetapi nominal transaksi belum terbukti. Perbaiki nominal pada sumber sebelum mengimpor; tidak ada mutasi yang diimpor.`);
  const validation = validateStatement(st, createHash("sha256").update(args.data).digest("hex"));
  // A line that moves no money (0 debit and 0 credit) is no bank transaction and can't be journaled: left out, said so, row numbers kept.
  const zeroRows = st.rows.filter((r) => r.amount === 0n);
  if (zeroRows.length) {
    if (zeroRows.length === st.rows.length) throw new ParseError("File tidak berisi mutasi bernilai: semua baris berjumlah nol.");
    const refs = zeroRows.slice(0, 5).map((r) => r.rowNumber).join(", ");
    st = { ...st, rows: st.rows.filter((r) => r.amount !== 0n), notes: [...(st.notes ?? []), `${zeroRows.length} baris bernilai nol dilewati (baris ${refs}${zeroRows.length > 5 ? ", …" : ""}): tidak ada uang yang bergerak.`] };
  }
  const others = sections.filter((s) => s !== chosen);
  // An account of this client already holding an import of the same period doesn't need "Impor juga ke …" again.
  const done = await db.statementImport.findMany({
    where: { bankAccount: { entity: { clientId: client.id } }, OR: others.map((s) => ({ periodStart: s.periodStart, periodEnd: s.periodEnd })) },
    select: { periodStart: true, periodEnd: true, bankAccount: { select: { number: true, label: true } } },
  });
  const importedTo = (s: ParsedStatement) => done.find((d) => digits(d.bankAccount.number) === digits(s.accountNumber) && +d.periodStart === +s.periodStart && +d.periodEnd === +s.periodEnd);
  const otherSections = others.map((s) => {
    const to = importedTo(s);
    return `${s.accountNumber} ${s.section?.label ?? ""} (${s.section?.currency ?? "IDR"}): ${to ? `sudah diimpor ke ${to.bankAccount.label}` : "tidak diimpor ke rekening ini"}`;
  });
  const otherAccounts = others.flatMap((s) =>
    s.accountNumber
      ? [{
          number: s.accountNumber,
          label: s.section?.label ?? "",
          currency: s.section?.currency ?? "IDR",
          imported: !!importedTo(s),
        }]
      : [],
  );
  const pendingReviewCount = () => db.bankTransaction.count({ where: { bankAccount: { entity: { clientId: client.id } }, status: "NEEDS_REVIEW" } });
  const continuity = checkContinuity(st);

  const locked = await db.period.findMany({ where: { clientId: client.id, status: "LOCKED" } });
  const lockedHit = st.rows.find((r) => locked.some((p) => p.year === r.date.getUTCFullYear() && p.month === r.date.getUTCMonth() + 1));
  if (lockedHit) {
    throw new ParseError(`Periode ${formatPeriod(lockedHit.date.getUTCFullYear(), lockedHit.date.getUTCMonth() + 1)} sudah ditutup. Buka periode dulu atau pilih file lain.`);
  }

  // Dedupe against what's already imported for this bank account (see `dedupe`); checked again under the account's lock when writing.
  const hashes = rowHashes(st.rows);
  // A repaired row is also known by what the file wrote: a file imported before the repair existed dedupes, never doubles.
  // Hashed as one list, like the file was hashed before (two identical written rows keep their ordinals).
  const asWrittenHashes = rowHashes(st.rows.map((r) => (r.written ? { ...r, amount: r.written.amount ?? r.amount, date: r.written.date ?? r.date } : r)));
  const written = st.rows.map((r, i) => (r.written ? asWrittenHashes[i] : null));
  const seen = await dedupe(db, bankAccount.id, st, hashes, written, validation.sourceHash, validation);
  const fresh = st.rows.map((r, i) => ({ r, hash: hashes[i] })).filter((_, i) => !seen.duplicate[i]);
  if (seen.notes.some((n) => n.includes("sebelum diperbaiki"))) validation.issues.push({ code: "LEGACY_WRITTEN_ROWS", severity: "CONFLICT", message: "Mutasi lama masih memakai nilai sebelum perbaikan. Hapus impor lama dan impor ulang sumber yang benar." });
  const notes = [...(st.notes ?? []), ...seen.notes, ...validation.issues.map((i) => i.message)];

  // Saldo Awal already contains everything up to its date: a new row on or before it would be counted twice and break the bank
  // reconciliation. Only rows not yet imported count, so a statement that was imported before stays importable.
  const opening = await db.journalEntry.findFirst({ where: { entityId: entity.id, kind: "OPENING" }, orderBy: { date: "asc" }, select: { date: true } });
  const early = opening ? fresh.filter(({ r }) => +r.date <= +opening.date) : [];
  if (opening && early.length) {
    const first = early.reduce((a, b) => (+b.r.date < +a.r.date ? b : a)).r.date;
    throw new ParseError(`Saldo awal ${entity.shortName} dicatat per ${formatDate(opening.date)}, sudah termasuk transaksi sampai tanggal itu. File ini berisi ${early.length} transaksi bertanggal sampai ${formatDate(opening.date)} (paling awal ${formatDate(first)}). Pilih file yang mulai setelah tanggal itu, atau koreksi saldo awal lewat Jurnal Penyesuaian.`);
  }
  // A trial balance (a Neraca-mode import's IMPORTED entry) already holds the movement up to its closing date: same refusal.
  const tbMove = opening ? await db.journalEntry.findFirst({ where: { entityId: entity.id, kind: "IMPORTED", ledgerImport: { mode: "NERACA" } }, orderBy: { date: "desc" }, select: { date: true } }) : null;
  const covered = tbMove ? fresh.filter(({ r }) => +r.date <= +tbMove.date) : [];
  if (tbMove && covered.length) {
    throw new ParseError(`Mutasi ${entity.shortName} sampai ${formatDate(tbMove.date)} sudah dicatat dari neraca saldo. File ini berisi ${covered.length} transaksi bertanggal sampai tanggal itu, yang akan terhitung dua kali. Pilih file yang mulai setelah ${formatDate(tbMove.date)}, atau hapus impor neraca saldo itu bila rekening koran yang dipakai.`);
  }

  // A statement from before the account's first one must hand over to it: its closing balance is that statement's opening balance. One
  // that doesn't (another year, another account's file) would become the account's history and drive Saldo Awal — refused, whole file.
  if (fresh.length) {
    const first = await db.statementImport.findFirst({ where: { bankAccountId: bankAccount.id }, orderBy: [{ periodStart: "asc" }, { createdAt: "asc" }] });
    if (first && +st.periodEnd < +first.periodStart && st.closingBalance !== first.openingBalance) {
      const money = (v: bigint) => formatMoney(v, bankAccount.currency);
      throw new ParseError(`File ini berakhir ${formatDate(st.periodEnd)} dengan saldo ${money(st.closingBalance)}, tetapi rekening koran ${bankAccount.label} yang sudah diimpor dimulai ${formatDate(first.periodStart)} dengan saldo awal ${money(first.openingBalance)}. Saldonya tidak nyambung: periksa tahun dan rekeningnya. Bila ada bulan di antaranya yang belum diimpor, impor dulu bulan yang paling dekat dengan ${formatDate(first.periodStart)}.`);
    }
  }

  // Nothing new and the statement is already on file: no second history row claiming an import that changed nothing.
  if (fresh.length === 0 && !args.evidenceVersionId) {
    await revalidateLegacy(db, bankAccount.id, st, hashes, validation, args.fileName);
    const candidates = await db.statementImport.findMany({ where: { bankAccountId: bankAccount.id, periodStart: st.periodStart, periodEnd: st.periodEnd }, orderBy: { createdAt: "asc" }, select: { id: true, sourceValidation: true } });
    const existing = candidates.find((c) => {
      const v = readValidation(c.sourceValidation);
      return v !== null && v.sourceHash === validation.sourceHash && Object.entries(validation.source).every(([key, value]) => v.source[key as keyof typeof v.source] === value) && v.issues.length === validation.issues.length && v.issues.every((issue, i) => issue.code === validation.issues[i].code && issue.severity === validation.issues[i].severity && issue.message === validation.issues[i].message);
    });
    if (existing) {
      return {
        importId: existing.id,
        rows: st.rows.length,
        duplicates: st.rows.length,
        posted: 0,
        needsReview: 0,
        byMethod: { TRANSFER: 0, RULE: 0, MEMORY: 0, AI: 0, HEURISTIC: 0, MANUAL: 0 },
        ai: { calls: 0, cacheHits: 0 },
        continuityOk: continuity.ok,
        continuityNote: continuity.note,
        otherSections,
        otherAccounts,
        pendingReview: await pendingReviewCount(),
        notes,
        fileBank: st.format,
        months: monthsOf(st.periodStart, st.periodEnd),
        layout: chosen.layout ?? null,
      };
    }
  }

  const items = fresh.map(({ r, hash }, i) => ({
    id: `new-${i}`,
    hash,
    row: r,
    entityId: entity.id,
    bankAccountId: bankAccount.id,
    date: r.date,
    description: r.description,
    merchantKey: merchantKey(r.description),
    direction: (r.amount >= 0n ? "IN" : "OUT") as Direction,
    amount: r.amount,
  }));

  // ---- classification (reads only; AI runs outside the write transaction) ----
  const window = items.length
    ? { gte: new Date(items[0].date.getTime() - 6 * 86_400_000), lte: new Date(items[items.length - 1].date.getTime() + 6 * 86_400_000) } // ≥ 2 business days across any weekend
    : undefined;
  const openCounterparts = window
    ? (
        await db.bankTransaction.findMany({
          where: { bankAccount: { currency: bankAccount.currency, entity: { clientId: client.id, functionalCurrency: entity.functionalCurrency } }, matchedTxId: null, pairRefused: false, splits: { none: {} }, settlements: { none: {} }, date: window, bankAccountId: { not: bankAccount.id } },
        })
      ).map((t) => ({ ...t, id: t.id }))
    : [];
  // Short names ("PT AND") are too collision-prone for substring matching; use distinctive names only.
  const ownNames = client.entities.map((e) => ({ entityId: e.id, names: [e.name, e.shortName].map((n) => n.toUpperCase()).filter((n) => n.length >= 8) }));
  const transfers = matchTransfers([...items, ...openCounterparts], ownNames);

  const rules = sortRules(await db.rule.findMany({ where: { firmId: client.firmId, OR: [{ clientId: client.id }, { clientId: null }] } }));
  const memories = await db.memory.findMany({ where: { clientId: client.id } });
  // Generic keys (no counterparty) were never meant to be learned; older books may still hold some — ignore them.
  const memoryMap = new Map(memories.filter((m) => !isGenericKey(m.merchantKey)).map((m) => [`${m.merchantKey}|${m.direction}`, m]));

  const accounts = await db.account.findMany({ where: { clientId: client.id }, orderBy: { code: "asc" } });
  const codes = new Set(accounts.map((a) => a.code));

  const result = new Map<string, Classification>();
  const pendingAi: { key: string; direction: Direction; sample: string }[] = [];
  /** Lines a model could be asked about (named counterparty, nothing else suggests an account). */
  const askable = new Set<string>();
  for (const it of items) {
    const financing = financingSuggestion(it.description, it.direction) ?? taxPaymentSuggestion(it.description, it.direction);
    const c =
      transfers.get(it.id) ??
      matchRule(rules, it.description, it.direction, codes) ??
      (() => {
        const m = memoryMap.get(`${it.merchantKey}|${it.direction}`);
        return m
          ? ({ method: "MEMORY", accountCode: m.accountCode, taxTag: m.taxTag, confidence: 0.95, reason: `Pernah dikonfirmasi ${m.hits}× untuk "${m.merchantKey}"` } as Classification)
          : null;
      })() ??
      // Loans, capital, own-money moves and tax payments: a balance-sheet suggestion for review, no AI call (rules 13–14).
      (financing && codes.has(financing.accountCode) ? financing : null);
    if (c) result.set(it.id, c);
    // A description that names no one (only channel words) tells a model nothing: it would only guess (rule 17, credit).
    else if (!isGenericKey(it.merchantKey)) {
      pendingAi.push({ key: it.merchantKey, direction: it.direction, sample: it.description });
      askable.add(it.id);
    }
  }

  const scope = aiScope(client, entity.kind, accounts.filter(isClassifiable));
  const ai = await suggestWithAi(db, {
    firmId: client.firmId,
    clientId: client.id,
    clientName: scope.clientName,
    coaVersion: client.coaVersion,
    accounts: scope.accounts,
    pending: pendingAi,
    provider: args.provider,
    // Cache only: the provider names the model whose stored answers apply, and no call may start (the background run asks).
    ...(args.aiLater ? { maxCalls: 0 } : {}),
  });
  // An AI receivable/payable with nothing on the books to settle is demoted below the bulk accept (lib/ai/unbacked.ts).
  const backingAt = ai.suggestions.size ? await tradeBacking(db, entity.id) : () => ({ receivable: true, payable: true });
  const fsLineOf = (code: string) => accounts.find((a) => a.code === code)?.fsLine;
  for (const it of items) {
    if (result.has(it.id)) continue;
    const suggested = ai.suggestions.get(`${it.merchantKey}|${it.direction}`);
    result.set(it.id, suggested ? demoteUnbacked(suggested, it.direction, fsLineOf, backingAt(it.date)) : simpleGuess(it.direction, entity.kind, isGenericKey(it.merchantKey)));
  }

  // ---- write: import + transactions + journals, all-or-nothing ----
  const byMethod = { TRANSFER: 0, RULE: 0, MEMORY: 0, AI: 0, HEURISTIC: 0, MANUAL: 0 } as Record<ClassifyMethod, number>;
  let needsReview = 0;
  const codeToId = new Map(accounts.map((a) => [a.code, a.id]));

  const importId = await db.$transaction(
    async (tx) => {
      // Two copies of a statement imported at once must not both pass the dedupe: serialise per bank account and look again.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`import:${bankAccount.id}`}, 0))::text`;
      const now = await dedupe(tx, bankAccount.id, st, hashes, written, validation.sourceHash, validation);
      if (now.duplicate.some((d, i) => d !== seen.duplicate[i])) throw new ParseError("Rekening ini baru saja menerima impor lain. Ulangi impor file ini.");
      await guardTransferCounterparts(tx, client.id, openCounterparts.filter((row) => !!transfers.get(row.id)?.matchedTxId));
      const imp = await tx.statementImport.create({
        data: {
          firmId: client.firmId,
          bankAccountId: bankAccount.id,
          fileName: args.fileName,
          evidenceVersionId: args.evidenceVersionId,
          evidenceUnitKey: args.evidenceUnitKey,
          format: st.format,
          periodStart: st.periodStart,
          periodEnd: st.periodEnd,
          openingBalance: st.openingBalance,
          closingBalance: st.closingBalance,
          rowCount: st.rows.length,
          duplicateCount: st.rows.length - fresh.length,
          continuityOk: continuity.ok,
          continuityNote: continuity.note,
          parseNotes: notes,
          sourceValidation: validation,
          deposits: (st.deposits ?? []).map((d) => ({ ...d, idrBalance: d.idrBalance.toString() })),
          importedById: args.actorId ?? null,
        },
      });
      const idMap = new Map<string, string>();
      for (const it of items) {
        const c = result.get(it.id)!;
        const auto = c.method !== "AI" && c.method !== "HEURISTIC" && c.confidence >= AUTO_POST_CONFIDENCE;
        const created = await tx.bankTransaction.create({
          data: {
            firmId: client.firmId,
            importId: imp.id,
            bankAccountId: bankAccount.id,
            entityId: entity.id,
            date: it.date,
            description: it.description,
            merchantKey: it.merchantKey,
            direction: it.direction,
            amount: it.amount,
            balance: it.row.balance,
            rowNumber: it.row.rowNumber,
            sourceSheet: it.row.sheet ?? null,
            rawRow: it.row.rawRow,
            hash: it.hash,
            status: auto ? "POSTED" : "NEEDS_REVIEW",
            method: c.method,
            confidence: c.confidence,
            reason: c.reason,
            accountCode: auto ? c.accountCode : ACCOUNT_CODES.SUSPENSE,
            suggestedCode: c.accountCode,
            taxTag: c.taxTag,
            taxMonth: c.taxTag === "PPH_25" ? defaultTaxMonth(it.date) : null,
          },
        });
        idMap.set(it.id, created.id);
        byMethod[c.method]++;
        if (!auto) needsReview++;
        await postBankTransaction(tx, created.id, auto ? { accountCode: c.accountCode, taxTag: c.taxTag } : { accountCode: ACCOUNT_CODES.SUSPENSE }, { codeToId, actorId: args.actorId });
      }
      // Link transfer pairs (both new, or new ↔ previously imported open half).
      for (const [id, c] of transfers) {
        if (!c.matchedTxId) continue;
        const selfId = idMap.get(id) ?? id;
        const otherId = idMap.get(c.matchedTxId) ?? c.matchedTxId;
        if (id.startsWith("new-")) {
          await tx.bankTransaction.update({ where: { id: selfId }, data: { matchedTxId: otherId } });
        } else {
          // Previously imported half: link and move it onto the transfer account if it was elsewhere.
          const prev = await tx.bankTransaction.update({ where: { id: selfId }, data: { matchedTxId: otherId } });
          if (prev.accountCode !== c.accountCode) {
            await postBankTransaction(tx, prev.id, { accountCode: c.accountCode }, { codeToId, actorId: args.actorId });
            await tx.bankTransaction.update({
              where: { id: prev.id },
              data: { accountCode: c.accountCode, status: "POSTED", method: "TRANSFER", confidence: c.confidence, reason: c.reason, taxTag: null },
            });
          }
        }
      }
      return imp.id;
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  if (chosen.layout) await db.statementLayout.updateMany({ where: { id: chosen.layout.id, firmId: bankAccount.firmId }, data: { lastUsedAt: new Date() } });

  return {
    importId,
    rows: st.rows.length,
    duplicates: st.rows.length - fresh.length,
    posted: items.length - needsReview,
    needsReview,
    byMethod,
    ai: args.aiLater ? { calls: 0, cacheHits: ai.usage.cacheHits, later: items.filter((it) => askable.has(it.id) && !ai.suggestions.has(`${it.merchantKey}|${it.direction}`)).length } : ai.usage,
    continuityOk: continuity.ok,
    continuityNote: continuity.note,
    otherSections,
    otherAccounts,
    pendingReview: await pendingReviewCount(),
    notes,
    months: monthsOf(st.periodStart, st.periodEnd),
    fileBank: st.format,
    layout: chosen.layout ?? null,
  };
}

function monthsOf(start: Date, end: Date): string[] {
  const index = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
  const out: string[] = [];
  for (let k = index(start); k <= index(end); k++) out.push(formatPeriod(Math.floor(k / 12), (k % 12) + 1));
  return out;
}
