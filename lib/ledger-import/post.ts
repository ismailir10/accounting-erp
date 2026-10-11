import { createHash } from "node:crypto";
import { fiscalEndMonth, fiscalYearStart } from "@/lib/fiscal";
import type { Db, Tx } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import type { Prisma } from "@/lib/generated/prisma/client";
import { postJournal, type PostLine } from "@/lib/ledger/post";
import { ACCOUNT_CODES } from "@/lib/coa/template";
import { formatDate, formatPeriod } from "@/lib/format";
import { loadRates, lookupRate, upsertFileRate } from "@/lib/fx/rates";
import { formatRate, formatRateId, isCurrency, parseRate } from "@/lib/fx/currency";
import { ParseError } from "@/lib/import/types";
import { columnLetter, detectTables, readSheets, readTable, reportKind } from "@/lib/ledger-import/read";
import { accountKey, cap, missingMonths, periodList, planLedger, planNeraca, planTb, tbIsWorksheet, type Check, type CurrencyMode, type EntityInfo, type Plan, type PlanEntry } from "@/lib/ledger-import/check";
import { inferType, learnScheme, suggestMappings } from "@/lib/ledger-import/mapping";
import type { NeracaRow, TableCandidate } from "@/lib/ledger-import/types";

/** Memo of the 1999 line an accepted unbalanced group posts (rule 15a); the 1999 correction proposals look for it. */
export const SOURCE_DIFFERENCE_MEMO = "Selisih dari file sumber";

/**
 * Ledger / Neraca import (accounting-rules §15a): stage (read → check → source accounts → DRAFT plan),
 * then post the saved plan all-or-nothing once every BLOCK is fixed or accepted and every source account is mapped.
 */

export class LedgerImportError extends Error {}

/** A file's entity label belongs to the client entity with that short or full name (case-insensitive). No fuzzy match. */
export function entityForLabel<E extends { shortName: string; name: string }>(entities: E[], label: string): E | undefined {
  const l = label.trim().toLowerCase();
  return l ? entities.find((e) => [e.shortName, e.name].some((n) => n.toLowerCase() === l)) : undefined;
}

export type StageInput = {
  /** Evidence handoff: the file must stay inside the confirmed dates, currency and entities. */
  allowedPeriod?: { start: string; end: string; currency?: string; entityIds?: string[] };
  evidenceVersionId?: string;
  evidenceUnitKey?: string;
  firmId: string;
  clientId: string;
  fileName: string;
  data: Buffer;
  /** Sheet to read when the file has several tables. */
  sheet?: string;
  /** File entity label → client entity id. Labels matching an entity's short/full name are paired automatically. */
  entityMap?: Record<string, string>;
  /** Files without an entity column (and every Neraca) go to this entity. */
  entityId?: string;
  /** Member staging the file; null for system runs. */
  actorId?: string | null;
  /** Neraca date when the file doesn't state one. */
  date?: Date;
  currencyMode?: CurrencyMode;
};

export type StageResult =
  | { status: "CHOOSE_SHEET"; candidates: TableCandidate[] }
  | { status: "STAGED"; importId: string; mode: "LEDGER" | "NERACA"; checks: Check[]; entries: number; sourceAccounts: number; unmapped: number };

type FileRate = { currency: string; quote: string; date: string; rate: string; ref: string };
/** `rates`: the one rate per pair and date written to Kurs; `stated`: every distinct rate the file states (reviewed on posting). */
type SavedPlan = { rates?: FileRate[]; stated?: FileRate[]; entries: (Omit<PlanEntry, "date" | "imbalance" | "rounding" | "lines"> & { date: string; imbalance: string; rounding: string; lines: (Omit<PlanEntry["lines"][number], "amount" | "fx"> & { amount: string; fx: { currency: string; amount: string; rate: string } | null })[] })[]; entities: Record<string, string> };

const toSaved = (entries: PlanEntry[], entities: Map<string, EntityInfo>): SavedPlan => ({
  entities: Object.fromEntries([...entities].map(([k, v]) => [k, v.entityId])),
  entries: entries.map((e) => ({
    ...e,
    date: e.date.toISOString().slice(0, 10),
    imbalance: e.imbalance.toString(),
    rounding: e.rounding.toString(),
    lines: e.lines.map((l) => ({ ...l, amount: l.amount.toString(), fx: l.fx ? { ...l.fx, amount: l.fx.amount.toString() } : null })),
  })),
});

/** A group posts when it yields at least two lines: non-zero file lines plus any rounding or source-difference line. */
function willPost(e: PlanEntry) {
  return e.lines.filter((l) => l.amount !== 0n).length + (e.rounding !== 0n ? 1 : 0) + (e.imbalance !== 0n ? 1 : 0) >= 2;
}

export async function stageImport(db: Db, input: StageInput): Promise<StageResult> {
  const sheets = await readSheets(input.fileName, input.data);
  const candidates = detectTables(sheets);
  if (!candidates.length) {
    const report = sheets.map(reportKind).find(Boolean);
    if (report === "LABA_RUGI") throw new ParseError("File ini laporan laba rugi, bukan buku besar atau neraca. Impor neraca atau buku besarnya; laba tahun berjalan sudah ada di saldo laba neraca.");
    if (report === "ARUS_KAS") throw new ParseError("File ini laporan arus kas, bukan buku besar atau neraca. Impor neraca atau buku besarnya; Buku menyusun arus kas dari buku besar.");
    throw new ParseError("Tabel buku besar atau neraca tidak ditemukan. Pastikan ada baris judul kolom (tanggal, kode akun, debit, kredit — atau kode akun dan saldo).");
  }
  const table = input.sheet ? candidates.find((c) => c.sheet === input.sheet) : candidates.length === 1 ? candidates[0] : null;
  if (!table) return { status: "CHOOSE_SHEET", candidates };

  const fileHash = createHash("sha256").update(input.data).update(`|${table.sheet}`).digest("hex");
  const posted = await db.ledgerImport.findFirst({ where: { clientId: input.clientId, fileHash, status: "POSTED" } });
  if (posted) throw new LedgerImportError(`Sheet "${table.sheet}" dari file ini sudah diimpor (${formatDate(posted.postedAt ?? posted.createdAt)}).`);

  const entities = await db.entity.findMany({ where: { clientId: input.clientId } });
  const read = readTable(sheets, table);
  const currencyMode = input.currencyMode ?? "FUNCTIONAL";
  const info = (id: string) => {
    const e = entities.find((x) => x.id === id);
    if (!e) throw new LedgerImportError("Entitas tidak ditemukan untuk klien ini");
    return { entityId: e.id, name: e.shortName, currency: e.functionalCurrency } satisfies EntityInfo;
  };
  const existing = await db.sourceAccount.findMany({ where: { clientId: input.clientId } });

  let plan: Plan;
  const entityInfos = new Map<string, EntityInfo>();
  let periodStart: Date;
  let periodEnd: Date;
  if (read.mode === "LEDGER") {
    const labels = [...new Set(read.rows.map((r) => r.entity ?? ""))];
    for (const label of labels) {
      const id =
        input.entityMap?.[label] ??
        (label === "" ? input.entityId : undefined) ??
        entityForLabel(entities, label)?.id ??
        (labels.length === 1 ? input.entityId : undefined);
      if (id) entityInfos.set(label, info(id));
    }
    const existingNames = new Map<string, string>();
    for (const [label, ei] of entityInfos) for (const s of existing.filter((x) => x.entityId === ei.entityId)) existingNames.set(accountKey(label, s.code), s.name);
    const rates = currencyMode === "CONVERT" ? await loadRates(db, input.firmId) : [];
    plan = planLedger(read.rows, { entities: entityInfos, currencyMode, rateFor: (c, f, d) => lookupRate(rates, c, f, d), existingNames, totals: read.totals, dateOrder: read.dateOrder });
    plan.checks.push(...(await ledgerBookChecks(db, plan, entityInfos)));
    // The file's period follows the dates that will post (a year typo, once accepted, posts on its corrected date).
    const dates = plan.entries.length ? plan.entries.map((e) => +e.date) : read.rows.filter((r) => r.date).map((r) => +r.date!);
    periodStart = new Date(dates.length ? Math.min(...dates) : Date.now());
    periodEnd = new Date(dates.length ? Math.max(...dates) : Date.now());
  } else {
    if (!input.entityId) throw new LedgerImportError("Pilih entitas untuk neraca ini.");
    await assertNoOpening(db, [input.entityId]);
    const date = read.date ?? input.date;
    if (!date) throw new LedgerImportError(read.tb ? "Tanggal neraca saldo tidak tertulis di file. Isi tanggal saldo akhirnya." : "Tanggal neraca tidak tertulis di file. Isi tanggalnya.");
    entityInfos.set("", info(input.entityId));
    const existingNames = new Map(existing.filter((x) => x.entityId === input.entityId).map((s) => [accountKey("", s.code), s.name]));
    const name = info(input.entityId).name;
    const first = await db.journalEntry.findFirst({ where: { entityId: input.entityId }, orderBy: { date: "asc" }, select: { date: true } });
    if (read.tb) {
      // A one-date worksheet is wholly at its date. Otherwise, without a written opening date, last year's balance is taken at the
      // client's financial-year end before the closing date (lib/fiscal.ts).
      const worksheet = tbIsWorksheet(read.tb.layout);
      const opening = worksheet ? date : (read.tb.opening ?? new Date(+fiscalYearStart(await fiscalEndMonth(db, input.clientId), date) - 86_400_000));
      if (!worksheet && +opening >= +date) throw new LedgerImportError(`Tanggal saldo awal neraca saldo (${formatDate(opening)}) harus sebelum tanggal saldo akhirnya (${formatDate(date)}).`);
      plan = planTb(read.tb, { entityKey: "", entity: info(input.entityId), opening, closing: date, existingNames });
      if (!worksheet && !read.tb.opening) plan.checks.push({ severity: "INFO", code: "TB_OPENING_DATE", message: `Tanggal saldo awal tidak tertulis di file: dianggap ${formatDate(opening)} (akhir tahun sebelum ${formatDate(date)}).`, refs: [], entityKey: "" });
      // A TB brings the period's movement itself: journals already in that period would count twice.
      if (first && +first.date <= +date) {
        plan.checks.push({ severity: "BLOCK", code: "TB_OVERLAP", message: `Neraca saldo ini mencakup s.d. ${formatDate(date)}, tetapi ${name} sudah punya jurnal sejak ${formatDate(first.date)}: mutasinya akan terhitung dua kali. Impor neraca saldo per tanggal sebelum jurnal pertama, atau Neraca (satu kolom saldo) per ${formatDate(date)} sebagai jangkar opening bridge.`, refs: [], entityKey: "" });
      }
      periodStart = opening;
    } else {
      plan = planNeraca(read.rows, read.totals, { entityKey: "", entity: info(input.entityId), date, sheet: table.sheet, existingNames, periods: table.periods, column: table.columns.amount });
      // Opening bridge (UC-K2, UC-B4): a Neraca after the entity's first journal is an anchor, never a Saldo Awal on its own date (every
      // movement before it would count twice). Saldo Awal goes the day before the first journal; posting reverses the books' movement.
      if (first && +first.date <= +date) {
        const openingDate = new Date(+first.date - 86_400_000);
        for (const e of plan.entries) Object.assign(e, { date: openingDate, memo: `Saldo awal (opening bridge) dari Neraca ${formatDate(date)}`, bridge: { anchor: date.toISOString().slice(0, 10) } });
        plan.checks.push({
          severity: "REVIEW",
          code: "OPENING_BRIDGE",
          message: `Neraca ini per ${formatDate(date)}, sesudah jurnal pertama ${name} (${formatDate(first.date)}). Saldo awal dibangun per ${formatDate(openingDate)}: saldo Neraca dikurangi mutasi yang sudah ada di buku s.d. ${formatDate(date)}, sehingga Neraca per ${formatDate(date)} sama dengan file. Laba rugi sebelum ${formatDate(first.date)} tidak diketahui dan termasuk di Saldo Laba.`,
          refs: [],
          entityKey: "",
        });
      }
      periodStart = date;
    }
    periodEnd = date;
  }

  // A TB is confirmed as a document of its closing date (Dokumen lists a Neraca-mode table by its date); its opening date is derived.
  const fileStart = read.mode === "NERACA" && read.tb ? periodEnd : periodStart;
  if (input.allowedPeriod && (fileStart.toISOString().slice(0, 10) < input.allowedPeriod.start || periodEnd.toISOString().slice(0, 10) > input.allowedPeriod.end)) throw new LedgerImportError("Rentang sumber harus mencakup seluruh periode file.");

  // A closed month can't take a journal (rule 4): said on the draft, not only when posting.
  plan.checks.push(...(await lockedMonthChecks(db, input.clientId, plan.entries)));

  if (input.allowedPeriod?.entityIds && [...entityInfos.values()].some(e => !input.allowedPeriod!.entityIds!.includes(e.entityId))) throw new LedgerImportError("File mencakup entitas lain di luar pilihan sumber. Pisahkan sheet atau gunakan impor manual.");
  if (input.allowedPeriod?.currency && [...entityInfos.values()].some(e => e.currency !== input.allowedPeriod!.currency)) throw new LedgerImportError("Mata uang fungsional entitas berbeda dengan pilihan sumber.");

  // Rates written in the file (rate column or "Rate: 1.31" notes) are kept and saved to the Kurs table on post.
  const fileRates = new Map<string, FileRate>();
  // Every distinct rate a row states, for the Kurs comparison; only one per date can be kept in the table.
  const statedRates = new Map<string, FileRate>();
  if (read.mode === "LEDGER") {
    for (const r of read.rows) {
      const ei = entityInfos.get(r.entity ?? "");
      if (!ei || !r.rate || !r.date || !r.currency || !isCurrency(r.currency) || r.currency === ei.currency) continue;
      try {
        const rate = formatRate(parseRate(r.rate));
        const date = r.date.toISOString().slice(0, 10);
        const stated = { currency: r.currency, quote: ei.currency, date, rate, ref: r.ref };
        fileRates.set(`${r.currency}|${ei.currency}|${date}`, stated);
        if (!statedRates.has(`${r.currency}|${ei.currency}|${date}|${rate}`)) statedRates.set(`${r.currency}|${ei.currency}|${date}|${rate}`, stated);
      } catch {
        // an unreadable rate note is just not a rate
      }
    }
  }
  plan.checks.push(...(await fileRateChecks(db, input.firmId, [...statedRates.values()], currencyMode, [...fileRates.values()])));
  // A column read through a typo is shown, so a wrong reading is caught before posting (UC-K2).
  for (const t of table.typos ?? []) {
    plan.checks.push({ severity: "INFO", code: "HEADER_TYPO", message: `Kolom "${t.header}" dibaca sebagai ${t.label} (salah ketik di judul kolom).`, refs: [`${table.sheet}!${columnLetter(t.column)}${t.row + 1}`] });
  }
  // All-zero groups are reported in the checks ("… jurnal bernilai nol dilewati") but not staged, so the draft's
  // "Catat N jurnal" is the number that will post.
  const entries = plan.entries.filter(willPost);
  const neracaHints = read.mode === "NERACA" ? new Map(read.rows.map((r) => [r.code, r.typeHint])) : new Map();
  // The file's own numbering (learned from its unambiguous names) beats weak name words like "bank" or "deposit".
  const scheme = learnScheme([...plan.accounts.values()]);
  const termHints = read.mode === "NERACA" ? new Map(read.rows.map((r) => [r.code, r.termHint])) : new Map<string, NeracaRow["termHint"]>();
  const imp = await db.$transaction(
    async (tx) => {
      // Source accounts: create new codes, keep the latest name, remember earlier names (rule 9a, assumption 4).
      for (const a of plan.accounts.values()) {
        const ei = entityInfos.get(a.entityKey);
        if (!ei) continue;
        const found = existing.find((s) => s.entityId === ei.entityId && s.code === a.code);
        const typeHint = neracaHints.get(a.code) ?? inferType(a.code, a.name, scheme);
        if (!found) {
          await tx.sourceAccount.create({ data: { firmId: input.firmId, clientId: input.clientId, entityId: ei.entityId, code: a.code, name: a.name, previousNames: a.previousNames, typeHint, termHint: termHints.get(a.code) ?? null } });
        } else {
          const data: { name?: string; previousNames?: string[]; termHint?: NeracaRow["termHint"]; typeHint?: NeracaRow["typeHint"] } = {};
          if (found.name !== a.name || a.previousNames.some((p) => !found.previousNames.includes(p))) {
            data.name = a.name;
            data.previousNames = [...new Set([...found.previousNames, ...a.previousNames])].filter((p) => p !== a.name);
          }
          // A Neraca states the account's term even when an earlier file created the code; it is only a mapping hint.
          const term = termHints.get(a.code) ?? null;
          if (term && term !== found.termHint) data.termHint = term;
          // An unmapped code keeps the freshest type evidence (this file's scheme or section); accepted mappings are untouched.
          if (!found.accountId && typeHint && typeHint !== found.typeHint) data.typeHint = typeHint;
          if (Object.keys(data).length) await tx.sourceAccount.update({ where: { id: found.id }, data });
        }
      }
      return tx.ledgerImport.create({
        data: {
          firmId: input.firmId,
          clientId: input.clientId,
          fileName: input.fileName,
          evidenceVersionId: input.evidenceVersionId,
          evidenceUnitKey: input.evidenceUnitKey,
          fileHash,
          sheetName: table.sheet,
          importedById: input.actorId ?? null,
          mode: read.mode,
          currencyMode,
          periodStart,
          periodEnd,
          rowCount: read.rows.length,
          groupCount: entries.length,
          roundingTotal: entries.reduce((s, e) => s + (e.rounding < 0n ? -e.rounding : e.rounding), 0n),
          data: { ...toSaved(entries, entityInfos), rates: [...fileRates.values()], stated: [...statedRates.values()], ...(read.mode === "NERACA" && read.tb ? { tb: true } : {}) } as unknown as Prisma.InputJsonValue,
          checks: {
            create: plan.checks.map((c) => ({
              severity: c.severity,
              code: c.code,
              message: c.message,
              refs: c.refs,
              entityId: c.entityKey !== undefined ? (entityInfos.get(c.entityKey)?.entityId ?? null) : null,
              date: c.date ?? null,
              amount: c.amount ?? null,
            })),
          },
        },
      });
    },
    { timeout: 120_000 },
  );
  const entityIds = [...entityInfos.values()].map((e) => e.entityId);
  const codes = [...plan.accounts.values()].map((a) => a.code);
  const unmapped = await db.sourceAccount.count({ where: { entityId: { in: entityIds }, code: { in: codes }, accountId: null } });
  // Rule suggestions are free: every draft (manual upload or evidence handoff) opens with them. AI only on request.
  await suggestMappings(db, { firmId: input.firmId, clientId: input.clientId, provider: null, useAi: false });
  return { status: "STAGED", importId: imp.id, mode: read.mode, checks: plan.checks, entries: entries.length, sourceAccounts: plan.accounts.size, unmapped };
}

/**
 * A GL file against the books it lands in (use-case UC-K2 / UC-B4):
 * - rows on or before the entity's Saldo Awal are already in it: BLOCK, never counted twice;
 * - no Saldo Awal yet: INFO naming both ways in (a Neraca on the day before, or a later Neraca as the bridge's anchor). Not REVIEW: a GL
 *   file often carries its own opening rows, which is why the close asks for Saldo Awal only when no GL was imported;
 * - months with no GL between this file and the entity's GL already posted: REVIEW.
 */
async function ledgerBookChecks(db: Db, plan: Plan, entities: Map<string, EntityInfo>): Promise<Check[]> {
  const checks: Check[] = [];
  const monthIndex = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
  for (const [ek, info] of entities) {
    const mine = plan.entries.filter((e) => e.entityKey === ek);
    if (!mine.length) continue;
    const start = new Date(Math.min(...mine.map((e) => +e.date)));
    const end = new Date(Math.max(...mine.map((e) => +e.date)));
    const opening = await db.journalEntry.findFirst({ where: { entityId: info.entityId, kind: "OPENING" }, orderBy: { date: "asc" }, select: { date: true } });
    if (opening) {
      const before = mine.filter((e) => +e.date <= +opening.date);
      if (before.length) {
        const next = new Date(+opening.date + 86_400_000);
        checks.push({
          severity: "BLOCK",
          code: "BEFORE_OPENING",
          message: `${info.name}: ${before.length} jurnal bertanggal s.d. ${formatDate(opening.date)}, tanggal Saldo Awal. Angkanya sudah termasuk di saldo awal, jadi akan terhitung dua kali. Impor buku besar mulai ${formatDate(next)}; atau, bila Saldo Awal itu dari impor Neraca, hapus impor itu lalu impor ulang Neraca sesudah buku besar ini, sehingga Buku membangun saldo awal dari mutasi.`,
          refs: cap(before.flatMap((e) => e.lines.map((l) => l.ref))),
          entityKey: ek,
        });
      }
      // A trial balance already brought the movement up to its closing date (one IMPORTED entry of a Neraca-mode import).
      const tbMove = await db.journalEntry.findFirst({ where: { entityId: info.entityId, kind: "IMPORTED", ledgerImport: { mode: "NERACA" } }, orderBy: { date: "desc" }, select: { date: true } });
      const covered = tbMove ? mine.filter((e) => +e.date > +opening.date && +e.date <= +tbMove.date) : [];
      if (tbMove && covered.length) {
        checks.push({
          severity: "BLOCK",
          code: "TB_COVERS",
          message: `${info.name}: ${covered.length} jurnal bertanggal s.d. ${formatDate(tbMove.date)}, periode yang mutasinya sudah dicatat dari neraca saldo. Angkanya akan terhitung dua kali. Impor buku besar mulai ${formatDate(new Date(+tbMove.date + 86_400_000))}, atau hapus impor neraca saldo itu bila buku besar ini yang dipakai.`,
          refs: cap(covered.flatMap((e) => e.lines.map((l) => l.ref))),
          entityKey: ek,
        });
      }
    } else {
      const dayBefore = new Date(+start - 86_400_000);
      checks.push({
        severity: "INFO",
        code: "NO_OPENING",
        message: `${info.name} belum punya Saldo Awal; buku besar ini mulai ${formatDate(start)}. Bila file tidak memuat saldo awal, impor Neraca per ${formatDate(dayBefore)} sebagai Saldo Awal, atau Neraca per tanggal sesudahnya (mis. akhir tahun): Buku lalu membangun saldo awal dari mutasi (opening bridge).`,
        refs: [],
        entityKey: ek,
      });
    }
    // Months between this file and the GL already posted for the entity.
    const [prior, later] = await Promise.all([
      db.journalEntry.findFirst({ where: { entityId: info.entityId, kind: "IMPORTED", date: { lt: start } }, orderBy: { date: "desc" }, select: { date: true } }),
      db.journalEntry.findFirst({ where: { entityId: info.entityId, kind: "IMPORTED", date: { gt: end } }, orderBy: { date: "asc" }, select: { date: true } }),
    ]);
    for (const [a, b, side] of [[prior?.date, start, "sebelum"], [end, later?.date, "sesudah"]] as const) {
      if (!a || !b) continue;
      const gaps = missingMonths([monthIndex(a), monthIndex(b)]);
      if (gaps.length) {
        checks.push({ severity: "REVIEW", code: "MISSING_MONTH", message: `${info.name}: buku besar ${periodList(gaps)} belum ada di antara file ini dan buku besar yang sudah dicatat ${side}nya (${formatDate(side === "sebelum" ? a : b)}).`, refs: [], entityKey: ek });
      }
    }
  }
  return checks;
}

/**
 * The opening bridge, computed when posting (the books may have moved since staging): per balance-sheet account the books' movement up to
 * the anchor date, reversed; the income and expense in that span on 3200, since the Neraca's equity already holds that result. Then the
 * Neraca at the anchor date equals the file. Refused while 1999 or the transfer clearing hold money at that date (the bridge would hide
 * it), and for an anchor line mapped to income or expense (a Neraca has none). Without journals up to the anchor, it is a plain Saldo Awal.
 */
async function bridgeLines(tx: Tx, clientId: string, entityId: string, anchor: Date, anchorLines: PostLine[]): Promise<{ date: Date; lines: PostLine[] }> {
  const first = await tx.journalEntry.findFirst({ where: { entityId }, orderBy: { date: "asc" }, select: { date: true } });
  if (!first || +first.date > +anchor) return { date: anchor, lines: [] };
  const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
  // Only the file's own lines: a rounding line (7190) or an accepted source difference (1999) is not a mapping.
  const anchorAccounts = await tx.account.findMany({ where: { id: { in: anchorLines.filter((l) => l.sourceAccountId).map((l) => l.accountId) } } });
  const pl = anchorAccounts.find((a) => a.type === "PENDAPATAN" || a.type === "BEBAN");
  if (pl) throw new LedgerImportError(`Baris Neraca dipetakan ke akun laba rugi ${pl.code} ${pl.name}. Neraca jangkar hanya berisi aset, liabilitas dan ekuitas: petakan laba tahun berjalan ke 3200 Saldo Laba.`);
  const moved = await tx.journalLine.groupBy({ by: ["accountId"], where: { entityId, date: { lte: anchor } }, _sum: { debit: true, credit: true } });
  const accounts = new Map((await tx.account.findMany({ where: { id: { in: moved.map((m) => m.accountId) } } })).map((a) => [a.id, a]));
  const when = formatDate(anchor);
  const lines: PostLine[] = [];
  let result = 0n;
  for (const m of moved) {
    const a = accounts.get(m.accountId)!;
    const net = (m._sum.debit ?? 0n) - (m._sum.credit ?? 0n);
    if (net === 0n) continue;
    if (a.isSuspense || a.isClearing) {
      throw new LedgerImportError(`${a.code} ${a.name} masih ${formatMoney(net, entity.functionalCurrency)} per ${when}. Selesaikan dulu (Review atau koreksi), lalu catat Neraca ini: saldo awal dari mutasi tidak boleh menyembunyikannya.`);
    }
    if (a.type === "PENDAPATAN" || a.type === "BEBAN") result += net;
    else lines.push({ accountId: a.id, debit: net < 0n ? -net : 0n, credit: net > 0n ? net : 0n, memo: `Mutasi buku s.d. ${when} (opening bridge)` });
  }
  if (result !== 0n) {
    const retained = await tx.account.findUniqueOrThrow({ where: { clientId_code: { clientId, code: ACCOUNT_CODES.RETAINED } } });
    lines.push({ accountId: retained.id, debit: result < 0n ? -result : 0n, credit: result > 0n ? result : 0n, memo: `Laba rugi di buku s.d. ${when} (opening bridge)` });
  }
  return { date: new Date(+first.date - 86_400_000), lines };
}

/** BLOCK per closed month a planned journal would land in (rule 4); reopening it is logged in Tutup Buku. */
async function lockedMonthChecks(db: Db, clientId: string, entries: PlanEntry[]): Promise<Check[]> {
  const months = [...new Map(entries.map((e) => [`${e.date.getUTCFullYear()}-${e.date.getUTCMonth() + 1}`, { year: e.date.getUTCFullYear(), month: e.date.getUTCMonth() + 1 }])).values()];
  if (!months.length) return [];
  const locked = await db.period.findMany({ where: { clientId, status: "LOCKED", OR: months }, orderBy: [{ year: "asc" }, { month: "asc" }] });
  return locked.map((p) => {
    const refs = entries.filter((e) => e.date.getUTCFullYear() === p.year && e.date.getUTCMonth() + 1 === p.month).map((e) => e.ref);
    return { severity: "BLOCK" as const, code: "PERIOD_LOCKED", message: `Bulan ${formatPeriod(p.year, p.month)} sudah ditutup: ${refs.length} jurnal dari file ini jatuh di bulan itu. Buka kembali dulu di Tutup Buku (tercatat dengan alasannya), lalu unggah ulang.`, refs: cap(refs) };
  });
}

/** Rule 5: one opening entry per entity. */
async function assertNoOpening(db: Db, entityIds: string[]) {
  const opening = await db.journalEntry.findFirst({ where: { entityId: { in: entityIds }, kind: "OPENING" } });
  if (opening) throw new LedgerImportError(`Saldo awal entitas ini sudah ada (${formatDate(opening.date)}). Koreksi lewat Jurnal Penyesuaian.`);
}

/** BLOCK checks the accountant may accept: an unbalanced group (its difference posts to 1999) or a year typo (posts on the corrected date). */
export const ACCEPTABLE_CHECKS = ["UNBALANCED", "DATE_TYPO"];

/** Accept an acceptable BLOCK: an unbalanced group's difference posts to 1999, visible until fixed; a year typo posts on the corrected date. */
export async function acceptCheck(db: Db, clientId: string, checkId: string) {
  const check = await db.importCheck.findFirst({ where: { id: checkId, ledgerImport: { clientId, status: "DRAFT" } } });
  if (!check) throw new LedgerImportError("Pemeriksaan tidak ditemukan");
  if (check.severity !== "BLOCK" || !ACCEPTABLE_CHECKS.includes(check.code)) throw new LedgerImportError("Hanya jurnal tidak seimbang atau tanggal salah ketik yang bisa diterima; perbaiki file untuk masalah lain.");
  return db.importCheck.update({ where: { id: checkId }, data: { accepted: true } });
}

/** Source accounts this draft needs, with their mapping state (for the Pemetaan akun page). */
/** Each source account's balance in the staged plan (`entityId|code` → debit-positive minor units), for the mapping table's hints. */
export async function importBalances(db: Db, importId: string): Promise<Map<string, bigint>> {
  const imp = await db.ledgerImport.findUniqueOrThrow({ where: { id: importId } });
  const saved = imp.data as unknown as SavedPlan;
  const balances = new Map<string, bigint>();
  for (const e of saved.entries) {
    const entityId = saved.entities[e.entityKey];
    for (const l of e.lines) balances.set(`${entityId}|${l.code}`, (balances.get(`${entityId}|${l.code}`) ?? 0n) + BigInt(l.amount));
  }
  return balances;
}

export async function importSourceAccounts(db: Db, importId: string) {
  const imp = await db.ledgerImport.findUniqueOrThrow({ where: { id: importId } });
  const saved = imp.data as unknown as SavedPlan;
  const pairs = new Map<string, Set<string>>();
  for (const e of saved.entries) {
    const entityId = saved.entities[e.entityKey];
    for (const l of e.lines) (pairs.get(entityId) ?? pairs.set(entityId, new Set()).get(entityId)!).add(l.code);
  }
  const or = [...pairs].map(([entityId, codes]) => ({ entityId, code: { in: [...codes] } }));
  return or.length ? db.sourceAccount.findMany({ where: { OR: or }, include: { account: true, entity: true }, orderBy: [{ entityId: "asc" }, { code: "asc" }] }) : [];
}

export async function postImport(db: Db, clientId: string, importId: string, actorId?: string | null) {
  const imp = await db.ledgerImport.findFirst({ where: { id: importId, clientId }, include: { checks: true } });
  if (!imp) throw new LedgerImportError("Impor tidak ditemukan");
  if (imp.status === "POSTED") throw new LedgerImportError("Impor ini sudah dicatat.");
  const blocking = imp.checks.filter((c) => c.severity === "BLOCK" && !c.accepted);
  if (blocking.length) throw new LedgerImportError(`${blocking.length} masalah BLOCK belum diselesaikan. Perbaiki file atau terima selisihnya.`);
  const again = await db.ledgerImport.findFirst({ where: { clientId, fileHash: imp.fileHash, status: "POSTED" } });
  if (again) throw new LedgerImportError("Sheet ini sudah diimpor.");

  const saved = imp.data as unknown as SavedPlan;
  if (imp.mode === "NERACA") await assertNoOpening(db, Object.values(saved.entities));
  const sources = await importSourceAccounts(db, importId);
  const unmapped = sources.filter((s) => !s.accountId);
  if (unmapped.length) throw new LedgerImportError(`${unmapped.length} akun sumber belum dipetakan. Selesaikan Pemetaan akun dulu.`);
  const sourceOf = new Map(sources.map((s) => [`${s.entityId}|${s.code}`, s]));
  const accounts = await db.account.findMany({ where: { clientId, code: { in: [ACCOUNT_CODES.ROUNDING, ACCOUNT_CODES.SUSPENSE] } } });
  const rounding = accounts.find((a) => a.code === ACCOUNT_CODES.ROUNDING)!;
  const suspense = accounts.find((a) => a.code === ACCOUNT_CODES.SUSPENSE)!;

  // Rate differences are shown on the draft before anything posts (rule 6b). The Kurs table may have changed since staging (another
  // import, the accountant): refresh the draft's reviews, and when one is new, stop so the accountant sees it before posting.
  // A draft staged before `stated` was saved can't prove its reviews complete: it keeps them and only gains new ones.
  const stated = saved.stated ?? saved.rates ?? [];
  const ownRates = saved.rates ?? [];
  const onDraft = imp.checks.filter((c) => c.code === "FX_FILE_RATE_DIFFERS").map((c) => c.message);
  const expected = await fileRateChecks(db, imp.firmId, stated, imp.currencyMode, ownRates);
  const fresh = expected.filter((c) => !onDraft.includes(c.message));
  const stale = saved.stated ? onDraft.filter((m) => !expected.some((c) => c.message === m)) : [];
  if (fresh.length || stale.length) {
    await db.$transaction([
      db.importCheck.deleteMany({ where: { ledgerImportId: imp.id, code: "FX_FILE_RATE_DIFFERS", message: { in: stale } } }),
      db.importCheck.createMany({ data: fresh.map((c) => ({ ledgerImportId: imp.id, severity: c.severity, code: c.code, message: c.message, refs: c.refs })) }),
    ]);
    if (fresh.length) throw new LedgerImportError("Tabel Kurs berubah sejak draf dibuat: temuan kurs di draf sudah diperbarui. Periksa, lalu catat lagi.");
  }
  const reviewed = new Set([...onDraft.filter((m) => !stale.includes(m)), ...fresh.map((c) => c.message)]);

  return db.$transaction(
    async (tx) => {
      let posted = 0;
      for (const e of saved.entries) {
        const entityId = saved.entities[e.entityKey];
        const lines: PostLine[] = [];
        for (const l of e.lines) {
          const amount = BigInt(l.amount);
          if (amount === 0n) continue;
          const src = sourceOf.get(`${entityId}|${l.code}`)!;
          const abs = amount < 0n ? -amount : amount;
          lines.push({
            accountId: src.accountId!,
            sourceAccountId: src.id,
            sourceRef: l.ref,
            debit: amount > 0n ? abs : 0n,
            credit: amount < 0n ? abs : 0n,
            memo: l.memo?.slice(0, 300) ?? undefined,
            fx: l.fx ? { currency: l.fx.currency, amount: BigInt(l.fx.amount), rate: l.fx.rate } : null,
          });
        }
        const r = BigInt(e.rounding);
        if (r !== 0n) lines.push({ accountId: rounding.id, debit: r > 0n ? r : 0n, credit: r < 0n ? -r : 0n, memo: e.fxRounding ? "Selisih pembulatan konversi kurs" : "Selisih pembulatan sen" });
        const imbalance = BigInt(e.imbalance);
        if (imbalance !== 0n) lines.push({ accountId: suspense.id, debit: imbalance < 0n ? -imbalance : 0n, credit: imbalance > 0n ? imbalance : 0n, memo: SOURCE_DIFFERENCE_MEMO });
        let date = new Date(`${e.date}T00:00:00.000Z`);
        if (e.bridge) {
          const bridged = await bridgeLines(tx, clientId, entityId, new Date(`${e.bridge.anchor}T00:00:00.000Z`), lines);
          date = bridged.date;
          lines.push(...bridged.lines);
        }
        if (lines.length < 2) continue;
        await postJournal(tx, {
          entityId,
          date,
          kind: e.kind ?? (imp.mode === "NERACA" ? "OPENING" : "IMPORTED"),
          memo: `${e.memo} · ${imp.fileName}`.slice(0, 300),
          ledgerImportId: imp.id,
          sourceRef: e.ref,
          actorId,
          lines,
        });
        posted++;
      }
      for (const r of saved.rates ?? []) {
        await upsertFileRate(tx, imp.firmId, { currency: r.currency, quote: r.quote, date: new Date(`${r.date}T00:00:00.000Z`), kind: "SPOT", rate: r.rate, note: `${imp.fileName} ${r.ref}` });
      }
      // Same check on the Kurs rows that now stand: a rate another import wrote in the meantime rolls this post back (the next try
      // shows it on the draft first).
      const now = await fileRateChecks(tx as unknown as Db, imp.firmId, stated, imp.currencyMode, ownRates);
      if (now.some((c) => !reviewed.has(c.message))) throw new LedgerImportError("Tabel Kurs berubah bersamaan; coba catat lagi.");
      await tx.ledgerImport.update({ where: { id: imp.id }, data: { status: "POSTED", postedAt: new Date(), postedById: actorId ?? null, groupCount: posted } });
      return { entries: posted };
    },
    { timeout: 300_000, maxWait: 20_000 },
  );
}

/**
 * File rates only fill empty Kurs dates (`upsertFileRate`). Where the Kurs table already holds a different rate for the same
 * pair and date, say so: one REVIEW per pair, latest dates first.
 */
async function fileRateChecks(db: Db, firmId: string, rates: FileRate[], mode: CurrencyMode, own: FileRate[] = []): Promise<Check[]> {
  if (!rates.length) return [];
  const existing = await db.exchangeRate.findMany({ where: { firmId, kind: "SPOT", OR: rates.map((r) => ({ currency: r.currency, quote: r.quote, date: new Date(`${r.date}T00:00:00.000Z`) })) }, select: { currency: true, quote: true, date: true, rate: true } });
  const kurs = new Map(existing.map((e) => [`${e.currency}|${e.quote}|${e.date.toISOString().slice(0, 10)}`, e.rate]));
  // An empty date will hold the rate this import writes there (`own`): a second, different rate the file states for it differs too.
  for (const r of own) if (!kurs.has(`${r.currency}|${r.quote}|${r.date}`)) kurs.set(`${r.currency}|${r.quote}|${r.date}`, r.rate);
  const diffs: RateDiff[] = [];
  for (const r of rates) {
    const k = kurs.get(`${r.currency}|${r.quote}|${r.date}`);
    if (k && formatRate(k) !== formatRate(r.rate)) diffs.push({ r, kurs: k });
  }
  return rateDiffChecks(diffs, mode);
}

type RateDiff = { r: FileRate; kurs: string };

/** One REVIEW per currency pair whose file rates differ from the Kurs table, latest dates first. */
function rateDiffChecks(diffs: RateDiff[], mode: CurrencyMode): Check[] {
  const byPair = new Map<string, RateDiff[]>();
  for (const d of diffs) byPair.set(`${d.r.currency}|${d.r.quote}`, [...(byPair.get(`${d.r.currency}|${d.r.quote}`) ?? []), d]);
  return [...byPair.values()].map((list) => {
    const sorted = list.sort((a, b) => b.r.date.localeCompare(a.r.date));
    const { r } = sorted[0];
    const sample = sorted.slice(0, 5).map((x) => `${formatDate(new Date(`${x.r.date}T00:00:00.000Z`))}: file ${formatRateId(x.r.rate)}, Kurs ${formatRateId(x.kurs)}`).join("; ");
    const dates = new Set(sorted.map((x) => x.r.date)).size;
    const more = sorted.length > 5 ? ` dan ${sorted.length - 5} lainnya` : "";
    return {
      severity: "REVIEW" as const,
      code: "FX_FILE_RATE_DIFFERS",
      message: `Kurs ${r.currency}→${r.quote} di file berbeda dari tabel Kurs pada ${dates} tanggal (${sample}${more}). ${mode === "CONVERT" ? "Baris dikonversi dengan kurs file; " : ""}tabel Kurs tidak diubah.`,
      refs: sorted.slice(0, 20).map((x) => x.r.ref),
    };
  });
}
