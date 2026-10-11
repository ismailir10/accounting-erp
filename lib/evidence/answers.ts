import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { ANSWER_PLAN_MAX_TOKENS, AiAnswerError, EVIDENCE_PROMPT_VERSION, buildAnswerPlanPrompt, parseEvidenceAnswerPlan, type AiProvider, type EvidenceAnswerPlan } from "@/lib/ai/provider";
import { AiBudgetError, QUESTION_TOKEN_LIMIT, runBudgetedAi } from "@/lib/ai/budget";
import { formatMoney } from "@/lib/money";
import { isCurrency } from "@/lib/fx/currency";
import { periodBounds } from "@/lib/format";
import { incomeStatement, trialBalance } from "@/lib/reports/ledger";
import { runControls } from "@/lib/controls";
import { intakeForFirm, json, hash } from "./store";
import { HIDE_INVALID_CURRENCY_FACTS, type EvidenceFigure, type EvidenceUnit } from "./types";
import { selectionEntityIds } from "./review";

export type EvidenceQuestion = { question: string; entityId?: string; period?: string | { from: string; to: string } };
export type EvidenceAnswer = {
  text: string;
  rows?: { label: string; value: string; source: string }[];
  citations: { versionId: string; locator: string; label: string }[];
  links?: { label: string; href: string }[];
  limitations: string[];
};
const MAX_RESULTS = 30;
/** `AiUsage.note` of every answer-plan call (ok or rejected): the plan-rejection rate on Pengaturan counts these. */
export const PLAN_NOTE = "Rencana jawaban";
const STOP = new Set("apa apakah yang dan atau dengan dari ke untuk ini itu pada saya berapa tolong bagaimana why what the a an of in on is are can me please show compare bandingkan banding tahun lalu dokumen file laporan perusahaan company profile cari find search saldo balance transaksi transaction akun account saat sekarang terakhir latest".split(" "));
function searchTerms(question: string) {
  return [...new Set(question.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.-]*/gu) ?? [])].filter((t) => t.length > 1 && !STOP.has(t)).slice(0, 8);
}
export function fallbackEvidencePlan(question: string): EvidenceAnswerPlan {
  const q = question.toLowerCase();
  const intent = /banding|compare|perbandingan/.test(q) ? "COMPARE" : /kurang|missing|belum lengkap/.test(q) ? "MISSING" : /rekonsiliasi|selisih|control|kontrol|kenapa saldo/.test(q) ? "CONTROLS" : /profil|company|perusahaan|usaha|fiskal/.test(q) ? "CONTEXT" : /dokumen|file|unggah/.test(q) ? "SEARCH" : /transaksi|transaction/.test(q) ? "TRANSACTIONS" : /saldo|balance/.test(q) ? "BALANCE" : "SEARCH";
  const accountCode = q.match(/(?:akun|account)\s+([0-9][a-z0-9.-]{0,29})\b/i)?.[1];
  return { intent, terms: searchTerms(question), ...(accountCode ? { accountCode } : {}) };
}
function date(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Tanggal pertanyaan harus YYYY-MM-DD.");
  const out = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(+out) || out.toISOString().slice(0, 10) !== value) throw new Error("Tanggal pertanyaan tidak valid.");
  return out;
}
function rangeFor(period: EvidenceQuestion["period"], plan: EvidenceAnswerPlan, fallback: Date) {
  if (typeof period === "string") {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error("Periode pertanyaan harus YYYY-MM.");
    return periodBounds(Number(period.slice(0, 4)), Number(period.slice(5)));
  }
  const start = period?.from ?? plan.from, end = period?.to ?? plan.to;
  if (start || end) {
    if (!start || !end) throw new Error("Pilih tanggal awal dan akhir pertanyaan.");
    const from = date(start), to = date(end);
    if (from > to) throw new Error("Tanggal awal melebihi tanggal akhir.");
    return { start: from, end: to };
  }
  return periodBounds(fallback.getUTCFullYear(), fallback.getUTCMonth() + 1);
}
function canonical(value: string) { return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); }
function matches(label: string, terms: string[]) {
  return !terms.length || terms.some((t) => canonical(label).includes(canonical(t)));
}
function validFigure(value: EvidenceFigure) {
  return typeof value?.label === "string" && typeof value.amount === "string" && /^-?\d+$/.test(value.amount) && isCurrency(value.currency) && typeof value.locator === "string" && !!value.periodEnd;
}

type UnitRef = { versionId: string; unitKey: string };
/**
 * Units are left out of an answer only when they are known to be out of scope: confirmed for another entity, or with a
 * known period (confirmed, else extracted) outside the range. Unconfirmed units stay in and are counted, so a freshly
 * uploaded collection answers dated questions instead of returning nothing.
 */
const unknownNote = (n: number) => `${n} bagian belum dikonfirmasi entitas/periodenya; ikut dicari.`;

async function sourceScope(db: Db, firmId: string, intakeId: string, clientId: string | null, versionIds: string[], entityId: string | undefined, range: { start: Date; end: Date } | null, intent: EvidenceAnswerPlan["intent"]) {
  if (!versionIds.length) return { excluded: [] as UnitRef[], unknown: 0, versionOut: ((): boolean => false) as (versionId: string) => boolean };
  const [selections, units] = await Promise.all([
    db.evidenceSelection.findMany({ where: { firmId, intakeId, versionId: { in: versionIds }, confirmed: true }, select: { versionId: true, unitKey: true, entityId: true, periodStart: true, periodEnd: true } }),
    db.$queryRaw<{ versionId: string; unitKey: string; periodStart: string | null; periodEnd: string | null }[]>(Prisma.sql`
      SELECT v.id AS "versionId", u->>'key' AS "unitKey",
             COALESCE(u->>'periodStart', u->'table'->>'periodStart') AS "periodStart",
             COALESCE(u->>'periodEnd', u->'table'->>'periodEnd') AS "periodEnd"
      FROM "EvidenceVersion" v CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.units) = 'array' THEN v.units ELSE '[]'::jsonb END) u
      WHERE v."firmId" = ${firmId} AND v.id IN (${Prisma.join(versionIds)})`),
  ]);
  const confirmed = new Map(selections.map((s) => [`${s.versionId}\0${s.unitKey}`, s]));
  const refs = new Map<string, UnitRef & { periodStart: string | null; periodEnd: string | null }>();
  for (const u of units) if (u.unitKey) refs.set(`${u.versionId}\0${u.unitKey}`, u);
  for (const s of selections) if (!refs.has(`${s.versionId}\0${s.unitKey}`)) refs.set(`${s.versionId}\0${s.unitKey}`, { versionId: s.versionId, unitKey: s.unitKey, periodStart: null, periodEnd: null });
  const start = range?.start.toISOString().slice(0, 10), end = range?.end.toISOString().slice(0, 10);
  const excluded: UnitRef[] = [];
  let unknown = 0;
  for (const [key, unit] of refs) {
    const sel = confirmed.get(key);
    let known = true;
    if (entityId && sel) {
      // A confirmed selection without an entity is "per entity column" (multi-entity ledger): resolve its labels.
      const covered = sel.entityId ? [sel.entityId] : clientId ? await selectionEntityIds(db, clientId, sel) : [];
      if (covered.length && !covered.includes(entityId)) { excluded.push({ versionId: unit.versionId, unitKey: unit.unitKey }); continue; }
      if (!covered.length) known = false;
    }
    if (entityId && !sel) known = false;
    if (range) {
      const periodEnd = sel?.periodEnd ?? unit.periodEnd, periodStart = sel?.periodEnd ? sel.periodStart : unit.periodStart;
      if (!periodEnd) known = false;
      else if (intent === "COMPARE" ? periodEnd > end! : periodEnd < start! || (periodStart ?? periodEnd) > end!) { excluded.push({ versionId: unit.versionId, unitKey: unit.unitKey }); continue; }
    }
    if (!known) unknown++;
  }
  // A version is known to be out of scope when it has units and every one of them is excluded.
  const total = new Map<string, number>(), out = new Map<string, number>();
  for (const u of refs.values()) total.set(u.versionId, (total.get(u.versionId) ?? 0) + 1);
  for (const u of excluded) out.set(u.versionId, (out.get(u.versionId) ?? 0) + 1);
  const versionOut = (versionId: string) => (total.get(versionId) ?? 0) > 0 && out.get(versionId) === total.get(versionId);
  return { excluded, unknown, versionOut };
}

/** All arithmetic is deterministic; the model chooses from bounded read tools only. */
export async function askEvidence(db: Db, firmId: string, intakeId: string, input: EvidenceQuestion, provider?: AiProvider | null): Promise<EvidenceAnswer> {
  const question = input.question.trim();
  if (!question || question.length > 2000) throw new Error("Tulis pertanyaan antara 1 dan 2.000 karakter.");
  const intake = await intakeForFirm(db, firmId, intakeId);
  const entities = intake.clientId ? await db.entity.findMany({ where: { firmId, clientId: intake.clientId }, select: { id: true, name: true, shortName: true, functionalCurrency: true }, orderBy: { name: "asc" } }) : [];
  if (input.entityId && !entities.some((e) => e.id === input.entityId)) throw new Error("Entitas di luar klien kumpulan dokumen.");
  // Validate explicit range before any paid call.
  if (input.period) rangeFor(input.period, { intent: "SEARCH", terms: [] }, new Date());
  const answer: EvidenceAnswer = { text: "", citations: [], limitations: [] };
  let plan = fallbackEvidencePlan(question);
  if (provider?.planEvidenceAnswer) {
    const context = JSON.stringify({ clientId: intake.clientId, entityId: input.entityId, period: input.period, entities: entities.slice(0, 20) });
    try {
      const documentState = await db.evidenceDocument.findMany({ where: { firmId, intakeId }, select: { id: true, currentVersionId: true, excluded: true, status: true }, orderBy: { id: "asc" } });
      const currentIds = documentState.flatMap(d => d.currentVersionId ? [d.currentVersionId] : []);
      const content = currentIds.length ? await db.evidenceVersion.findMany({ where: { firmId, id: { in: currentIds } }, select: { id: true, hash: true }, orderBy: { id: "asc" } }) : [];
      const prompt = buildAnswerPlanPrompt(question, context);
      const key = hash(JSON.stringify([firmId, intakeId, intake.clientId, intake.contextVersion, documentState, content, EVIDENCE_PROMPT_VERSION, provider.model, prompt]));
      const scope = `intake:${intakeId}:answer-plan`;
      const cached = await db.evidenceAiCache.findFirst({ where: { key, firmId, scope } });
      if (cached) plan = parseEvidenceAnswerPlan(JSON.stringify(cached.payload));
      else {
        const result = await runBudgetedAi(db, { firmId, scope: `question:${randomUUID()}`, prompt, maxCompletionTokens: ANSWER_PLAN_MAX_TOKENS, scopeTokenLimit: QUESTION_TOKEN_LIMIT, model: provider.model, note: PLAN_NOTE }, async () => {
          const result = await provider.planEvidenceAnswer!(question, context);
          try { return { ...result, plan: parseEvidenceAnswerPlan(JSON.stringify(result.plan)) }; }
          catch { throw new AiAnswerError("Rencana jawaban AI tidak valid; gunakan pencarian dokumen.", result.promptTokens, result.completionTokens, result.model); }
        });
        plan = result.plan;
        await db.evidenceAiCache.upsert({ where: { key }, create: { key, firmId, scope, payload: json(plan) }, update: {} });
      }
    } catch (error) {
      answer.limitations.push(error instanceof AiBudgetError ? error.message : "AI tidak tersedia atau rencana tidak valid; pencarian deterministik digunakan.");
    }
  }
  // A plan may only narrow the scope the accountant chose: an entity outside it is ignored, never an error.
  if (plan.entityId && (!entities.some((e) => e.id === plan.entityId) || input.entityId && input.entityId !== plan.entityId)) {
    plan = { ...plan, entityId: undefined };
    answer.limitations.push("Rencana AI menyebut entitas di luar cakupan yang dipilih; cakupan pilihan Anda yang digunakan.");
  }
  const entityId = input.entityId ?? plan.entityId;
  const selectedEntities = entityId ? entities.filter((e) => e.id === entityId) : entities;
  const compareBooks = plan.intent === "COMPARE" && /\b(?:buku|gl|bulan)\b/i.test(question) && !!intake.clientId && selectedEntities.length > 0;
  const latestForCompare = compareBooks ? await db.journalEntry.findFirst({ where: { firmId, entityId: { in: selectedEntities.map(e => e.id) } }, orderBy: { date: "desc" }, select: { date: true } }) : null;
  if (compareBooks && latestForCompare) {
    const requested = rangeFor(input.period, plan, latestForCompare.date);
    const current = periodBounds(requested.end.getUTCFullYear(), requested.end.getUTCMonth() + 1);
    const previousDate = new Date(Date.UTC(current.start.getUTCFullYear(), current.start.getUTCMonth() - 1, 1));
    const previous = periodBounds(previousDate.getUTCFullYear(), previousDate.getUTCMonth() + 1);
    const currentPeriod = current.start.toISOString().slice(0, 7), previousPeriod = previous.start.toISOString().slice(0, 7);
    answer.rows = []; answer.links = [];
    for (const entity of selectedEntities.slice(0, 20)) {
      const scope = { clientId: intake.clientId!, entityIds: [entity.id] };
      const [before, after] = await Promise.all([incomeStatement(db, scope, previous.start, previous.end), incomeStatement(db, scope, current.start, current.end)]);
      const previousHref = `/clients/${intake.clientId}/reports?entity=${encodeURIComponent(entity.id)}&period=${previousPeriod}`;
      const currentHref = `/clients/${intake.clientId}/reports?entity=${encodeURIComponent(entity.id)}&period=${currentPeriod}`;
      for (const [key, label] of [["revenue", "Pendapatan"], ["grossProfit", "Laba kotor"], ["netProfit", "Laba bersih"]] as const) {
        const delta = after.totals[key] - before.totals[key];
        answer.rows.push({ label: `${entity.shortName} · ${label}`, value: `${previousPeriod}: ${formatMoney(before.totals[key], entity.functionalCurrency)} → ${currentPeriod}: ${formatMoney(after.totals[key], entity.functionalCurrency)}; perubahan ${formatMoney(delta, entity.functionalCurrency)}`, source: currentHref });
      }
      answer.links.push({ label: `${entity.shortName} · ${previousPeriod}`, href: previousHref }, { label: `${entity.shortName} · ${currentPeriod}`, href: currentHref });
    }
    answer.text = `Perbandingan bulanan dari buku Buku: ${previousPeriod} dengan ${currentPeriod}. Angka dihitung ulang dari jurnal.`;
    answer.limitations.push("Perbandingan memakai dua bulan kalender penuh; setiap entitas tetap dalam mata uangnya. Angka nol berarti tidak ada nilai tercatat pada cakupan tersebut, bukan bukti dokumen lengkap. Penyebab perubahan belum dibuktikan.");
    if (!input.period && !plan.from && !plan.to) answer.limitations.push(`Bulan jurnal terbaru ${currentPeriod} digunakan; pilih periode untuk mengubah cakupan.`);
    if (selectedEntities.length > 20) answer.limitations.push("Cakupan dibatasi 20 entitas pertama; pilih satu entitas.");
  } else if (["BALANCE", "TRANSACTIONS", "CONTROLS"].includes(plan.intent) && intake.clientId && selectedEntities.length) {
    const latest = await db.journalEntry.findFirst({ where: { firmId, entityId: { in: selectedEntities.map((e) => e.id) } }, orderBy: { date: "desc" }, select: { date: true } });
    const range = rangeFor(input.period, plan, latest?.date ?? new Date());
    const period = range.end.toISOString().slice(0, 7);
    answer.rows = [];
    answer.links = [];
    if (!input.period && !plan.from && !plan.to) answer.limitations.push(`Periode buku ${period} digunakan; pilih periode untuk mengubah cakupan.`);
    if (plan.intent === "BALANCE") {
      for (const entity of selectedEntities.slice(0, 20)) {
        const tb = await trialBalance(db, { clientId: intake.clientId, entityIds: [entity.id] }, range.end);
        const terms = plan.terms.filter((t) => !STOP.has(t.toLowerCase()));
        const rows = tb.filter((r) => plan.accountCode ? r.account.code === plan.accountCode : r.net !== 0n && matches(`${r.account.code} ${r.account.name}`, terms));
        for (const row of rows.slice(0, MAX_RESULTS)) {
          const href = `/clients/${intake.clientId}/ledger/${encodeURIComponent(row.account.code)}?entity=${encodeURIComponent(entity.id)}&period=${period}`;
          answer.rows.push({ label: `${entity.shortName} · ${row.account.code} ${row.account.name}`, value: `${formatMoney(row.net < 0n ? -row.net : row.net, entity.functionalCurrency)} ${row.net < 0n ? "Kredit" : "Debit"}`, source: href });
          answer.links.push({ label: `${entity.shortName} · ${row.account.code}`, href });
        }
        if (rows.length > MAX_RESULTS) answer.limitations.push(`${entity.shortName}: hanya ${MAX_RESULTS} akun pertama; sebutkan kode akun.`);
      }
      answer.text = `Saldo dari buku Buku per ${range.end.toISOString().slice(0, 10)}. Tiap entitas ditampilkan dalam mata uangnya.`;
      answer.limitations.push("Saldo laba/rugi mengikuti periode pembukuan Buku (tahun buku klien); angka dokumen unggahan tetap terpisah.");
    } else if (plan.intent === "TRANSACTIONS") {
      const contentTerms = plan.terms.filter((t) => !STOP.has(t.toLowerCase()) && t !== plan.accountCode);
      const lines = await db.journalLine.findMany({ where: { ...(contentTerms.length ? { OR: contentTerms.flatMap((term) => [{ memo: { contains: term, mode: "insensitive" as const } }, { entry: { memo: { contains: term, mode: "insensitive" as const } } }, { account: { name: { contains: term, mode: "insensitive" as const } } }]) } : {}), firmId, entityId: { in: selectedEntities.map((e) => e.id) }, date: { gte: range.start, lte: range.end }, ...(plan.accountCode ? { account: { firmId, clientId: intake.clientId, code: plan.accountCode } } : {}) }, include: { account: { select: { code: true, name: true } }, entry: { select: { memo: true, sourceRef: true, bankTransactionId: true } } }, orderBy: [{ date: "desc" }, { id: "desc" }], take: MAX_RESULTS + 1 });
      for (const row of lines.slice(0, MAX_RESULTS)) {
        const entity = selectedEntities.find((e) => e.id === row.entityId)!;
        const href = `/clients/${intake.clientId}/ledger/${encodeURIComponent(row.account.code)}?entity=${encodeURIComponent(entity.id)}&period=${period}`;
        answer.rows.push({ label: `${row.date.toISOString().slice(0, 10)} · ${entity.shortName} · ${row.account.name} · ${row.memo || row.entry.memo}`, value: `Debit ${formatMoney(row.debit, entity.functionalCurrency)}; kredit ${formatMoney(row.credit, entity.functionalCurrency)}`, source: href });
        answer.links.push({ label: row.entry.sourceRef || row.sourceRef || "Lihat baris buku dan sumber", href });
      }
      answer.text = "Baris jurnal dari buku Buku; satu transaksi dapat memiliki beberapa baris.";
      if (lines.length > MAX_RESULTS) answer.limitations.push(`Hanya ${MAX_RESULTS} baris terbaru ditampilkan. Persempit periode atau kode akun.`);
    } else {
      const controls = await runControls(db, intake.clientId, range.end.getUTCFullYear(), range.end.getUTCMonth() + 1);
      const scoped = entityId ? controls.filter((c) => c.scope === selectedEntities[0].shortName) : controls;
      for (const c of scoped.slice(0, MAX_RESULTS)) {
        const href = c.href || `/clients/${intake.clientId}/close?period=${period}`;
        answer.rows.push({ label: `${c.scope} · ${c.title}`, value: `${c.status} · ${c.detail}`, source: href });
        answer.links.push({ label: c.title, href });
      }
      answer.text = `Hasil kontrol buku untuk ${period}. Selisih terukur bukan bukti penyebabnya.`;
      if (entityId) answer.limitations.push("Kontrol gabungan dan kontrol impor tingkat klien tersedia di Tutup Buku.");
    }
    if (!answer.rows.length) answer.limitations.push("Belum ada baris buku yang cocok. Dokumen unggahan tidak otomatis menjadi jurnal.");
    if (selectedEntities.length > 20) answer.limitations.push("Cakupan dibatasi 20 entitas pertama; pilih satu entitas.");
  } else {
    if (["BALANCE", "TRANSACTIONS", "CONTROLS"].includes(plan.intent)) answer.limitations.push("Buku belum tersedia untuk cakupan ini; berikut bukti dokumen, bukan saldo buku.");
    const documents = await db.evidenceDocument.findMany({ where: { firmId, intakeId }, orderBy: { id: "asc" }, take: 501, select: { id: true, name: true, excluded: true, status: true, issue: true, currentVersionId: true } });
    const current = documents.slice(0, 500).filter((d) => !d.excluded && d.status === "READY" && d.currentVersionId);
    const versionIds = current.map((d) => d.currentVersionId!);
    const names = new Map(current.map((d) => [d.currentVersionId!, d.name]));
    const historic = plan.intent === "CONTEXT" ? await db.evidenceVersion.findMany({ where: { firmId, documentId: { in: documents.slice(0, 500).filter(d => !d.excluded).map(d => d.id) } }, select: { id: true, name: true } }) : [];
    for (const version of historic) names.set(version.id, version.name);
    const contextVersionIds = [...new Set([...versionIds, ...historic.map(v => v.id)])];
    if (versionIds.length) {
      const truncated = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT v.id FROM "EvidenceVersion" v
        WHERE v."firmId" = ${firmId} AND v.id IN (${Prisma.join(versionIds)}) AND
          (jsonb_path_exists(v.issues, '$[*] ? (@ like_regex "Ekstraksi dibatasi")') OR
           jsonb_path_exists(v.units, '$[*].issues[*] ? (@ like_regex "Ekstraksi dibatasi")')) LIMIT 1`);
      if (truncated.length) answer.limitations.push("Sebagian isi dokumen melewati batas ekstraksi; jawaban hanya mencakup bagian yang sudah dibaca. Pecah dokumen untuk hasil lengkap.");
    }
    const sourceRange = input.period || plan.from || plan.to ? rangeFor(input.period, plan, new Date()) : null;
    const scope = entityId || sourceRange ? await sourceScope(db, firmId, intakeId, intake.clientId, plan.intent === "CONTEXT" ? contextVersionIds : versionIds, entityId, sourceRange, plan.intent) : null;
    const excludedKeys = new Set(scope?.excluded.map((s) => `${s.versionId}\0${s.unitKey}`) ?? []);
    const unitAllowed = (versionId: string, unitKey: string) => !excludedKeys.has(`${versionId}\0${unitKey}`);
    if (scope) {
      answer.limitations.push("Cakupan sumber memakai entitas yang dikonfirmasi dan periode dokumen; bagian yang diketahui di luar cakupan tidak disertakan.");
      if (scope.unknown) answer.limitations.push(unknownNote(scope.unknown));
    }
    if (documents.length > 500) answer.limitations.push("Pencarian dibatasi 500 dokumen pertama.");
    const partial = documents.some((d) => !d.excluded && d.status !== "DIRECTORY" && (d.issue || !d.currentVersionId || ["REMOVED", "INACCESSIBLE", "ERROR", "MISSING"].includes(d.status)));
    if (partial || intake.issue || !["READY", "COMPLETE", "DONE"].includes(intake.status)) answer.limitations.push("Sebagian dokumen belum diproses atau tidak dapat diakses; hasil belum mencakup seluruh kumpulan.");
    const citation = (versionId: string, locator: string) => {
      if (!names.has(versionId)) return;
      if (!answer.citations.some((c) => c.versionId === versionId && c.locator === locator)) answer.citations.push({ versionId, locator, label: names.get(versionId)! });
    };
    if (plan.intent === "MISSING") {
      // A scoped question leaves out documents and conflicts whose versions are known to be outside the scope; unknown stays in.
      // Their versions (a problem document keeps its last one; a conflict may cite older ones) are scoped here, never searched.
      const fetched = await db.evidenceConflict.findMany({ where: { firmId, intakeId, resolved: false }, take: 501, orderBy: { id: "asc" } });
      const allConflicts = fetched.slice(0, 500);
      if (fetched.length > 500) answer.limitations.push("Pengecualian terbuka lebih dari 500; hanya 500 pertama yang diperiksa.");
      const idsOf = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      const extra = [...new Set([...documents.slice(0, 500).flatMap((d) => (d.currentVersionId && !d.excluded ? [d.currentVersionId] : [])), ...allConflicts.flatMap((c) => idsOf(c.versionIds))])].filter((v) => !versionIds.includes(v));
      const missingScope = scope && extra.length ? await sourceScope(db, firmId, intakeId, intake.clientId, [...versionIds, ...extra], entityId, sourceRange, plan.intent) : scope;
      if (missingScope && missingScope !== scope) {
        // The note counts what this answer actually looked at, retained and conflict versions included.
        answer.limitations = answer.limitations.filter((l) => l !== unknownNote(scope!.unknown));
        if (missingScope.unknown) answer.limitations.push(unknownNote(missingScope.unknown));
      }
      const versionOut = missingScope?.versionOut ?? (() => false);
      const conflictOut = (versionIds: unknown) => idsOf(versionIds).length > 0 && idsOf(versionIds).every(versionOut);
      const conflicts = allConflicts.filter((c) => !conflictOut(c.versionIds)).slice(0, MAX_RESULTS);
      answer.rows = documents.slice(0, 500).filter((d) => !d.excluded && d.status !== "DIRECTORY" && (d.issue || !d.currentVersionId) && !(d.currentVersionId && versionOut(d.currentVersionId))).slice(0, MAX_RESULTS).map((d) => ({ label: d.name, value: d.issue || "Belum selesai diperiksa", source: "Kumpulan dokumen" }));
      answer.rows.push(...conflicts.map((c) => ({ label: c.kind, value: c.message, source: "Pengecualian dokumen" })));
      answer.text = answer.rows.length ? "Dokumen dan keputusan yang masih perlu ditangani:" : "Tidak ada pengecualian terbuka yang tercatat.";
      answer.limitations.push("Daftar ini bukan jaminan dokumen lengkap; kelengkapan bergantung rekening, entitas, dan periode yang dikonfirmasi.");
    } else if (plan.intent === "CONTEXT") {
      const facts = contextVersionIds.length ? await db.evidenceFact.findMany({ where: { firmId, intakeId, AND: [HIDE_INVALID_CURRENCY_FACTS, { OR: [{ versionId: { in: versionIds }, status: { in: ["CONFIRMED", "PROPOSED", "CONFLICTING"] } }, { versionId: { in: contextVersionIds }, status: "CONFIRMED" }] }, ...(scope?.excluded.length ? [{ NOT: { OR: scope.excluded } }] : [])] }, orderBy: [{ status: "asc" }, { id: "asc" }], take: MAX_RESULTS + 1 }) : [];
      if (facts.length > MAX_RESULTS) answer.limitations.push(`Hanya ${MAX_RESULTS} fakta pertama ditampilkan; persempit cakupan.`);
      const scopedFacts = facts.slice(0, MAX_RESULTS).filter((f) => unitAllowed(f.versionId, f.unitKey));
      if (scopedFacts.some(f => !versionIds.includes(f.versionId))) answer.limitations.push("Konteks dikonfirmasi dari versi sebelumnya tetap dipertahankan. Usulan baru tidak menggantikannya tanpa keputusan Anda.");
      answer.rows = scopedFacts.map((f) => {
        citation(f.versionId, f.locator);
        return { label: f.key, value: `${f.value} (${f.status === "CONFIRMED" ? versionIds.includes(f.versionId) ? "dikonfirmasi" : "dikonfirmasi; versi sebelumnya" : f.status === "CONFLICTING" ? "bertentangan; belum dikonfirmasi" : "belum dikonfirmasi"})`, source: `${names.get(f.versionId)} · ${f.locator}` };
      });
      answer.text = answer.rows.length ? "Konteks perusahaan beserta status konfirmasi:" : "Belum ada fakta perusahaan untuk cakupan sumber yang dipilih.";
    } else if (plan.intent === "COMPARE") {
      const versions = versionIds.length ? await db.evidenceVersion.findMany({ where: { firmId, id: { in: versionIds } }, select: { id: true, units: true }, take: 30, orderBy: { id: "asc" } }) : [];
      if (versionIds.length > 30) answer.limitations.push("Perbandingan dibatasi 30 dokumen pertama; pisahkan kumpulan untuk hasil lengkap.");
      const groups = new Map<string, { f: EvidenceFigure; versionId: string; entity: string; scale: string }[]>();
      for (const version of versions) {
        const units = Array.isArray(version.units) ? version.units as unknown as EvidenceUnit[] : [];
        for (const unit of units) {
          if (unit.kind !== "REPORT" || !unit.entity || unit.scale === "UNKNOWN" || !unitAllowed(version.id, unit.key)) continue;
          if (entityId && !selectedEntities.some((e) => canonical(e.name) === canonical(unit.entity!))) continue;
          for (const f of unit.figures ?? []) {
            if (!validFigure(f) || !matches(f.label, plan.terms.filter((t) => !STOP.has(t)))) continue;
            const duration = f.periodStart && f.periodEnd ? Math.round((+date(f.periodEnd) - +date(f.periodStart)) / 86400000) : null;
            const periodType = duration === null ? "point" : duration >= 364 && duration <= 366 ? "annual" : `days:${duration}`;
            const key = `${canonical(unit.entity)}|${canonical(f.label)}|${f.currency}|${unit.scale}|${periodType}`;
            groups.set(key, [...(groups.get(key) ?? []), { f, versionId: version.id, entity: unit.entity, scale: unit.scale }]);
          }
        }
      }
      answer.rows = [];
      for (const group of groups.values()) {
        if (answer.rows.length >= MAX_RESULTS) break;
        const sorted = group.sort((a, b) => a.f.periodEnd!.localeCompare(b.f.periodEnd!));
        const periods = new Set(sorted.map((x) => `${x.f.periodStart}/${x.f.periodEnd}`));
        if (periods.size !== sorted.length) { answer.limitations.push(`${sorted[0].entity} · ${sorted[0].f.label}: lebih dari satu sumber untuk periode sama; pilih sumber sebelum membandingkan.`); continue; }
        if (sorted.length < 2) continue;
        const previous = sorted[sorted.length - 2], latest = sorted[sorted.length - 1];
        if (latest.f.periodStart && latest.f.periodStart <= previous.f.periodEnd!) { answer.limitations.push(`${latest.f.label}: rentang periode bertumpang tindih; tidak dihitung.`); continue; }
        const delta = BigInt(latest.f.amount) - BigInt(previous.f.amount);
        citation(previous.versionId, previous.f.locator); citation(latest.versionId, latest.f.locator);
        answer.rows.push({ label: `${latest.entity} · ${latest.f.label}`, value: `${previous.f.periodEnd}: ${formatMoney(BigInt(previous.f.amount), previous.f.currency)} → ${latest.f.periodEnd}: ${formatMoney(BigInt(latest.f.amount), latest.f.currency)}; perubahan ${formatMoney(delta, latest.f.currency)}`, source: `${names.get(previous.versionId)} · ${previous.f.locator}; ${names.get(latest.versionId)} · ${latest.f.locator}` });
      }
      answer.text = answer.rows.length ? "Perbandingan angka yang dilaporkan dokumen; belum merupakan saldo buku Buku." : "Belum ada pasangan angka dengan entitas, label, mata uang, satuan, dan periode yang dapat dibandingkan.";
      answer.limitations.push("Perubahan dihitung dari angka sumber. Penyebab perubahan belum dibuktikan. Versi bertentangan dan kolom periode ambigu perlu ditinjau.");
    } else {
      let hits: { versionId: string; unitKey: string; locator: string; text: string }[] = [];
      const terms = plan.terms.map((t) => t.trim()).filter(Boolean).slice(0, 8);
      if (versionIds.length && terms.length) {
        try {
          const unitFilter = scope?.excluded.length ? Prisma.sql`AND NOT (${Prisma.join(scope.excluded.map((s) => Prisma.sql`(p."versionId" = ${s.versionId} AND p."unitKey" = ${s.unitKey})`), " OR ")})` : Prisma.empty;
          hits = await db.$queryRaw<{ versionId: string; unitKey: string; locator: string; text: string }[]>(Prisma.sql`
            SELECT p."versionId", p."unitKey", p.locator, p.text FROM "EvidencePassage" p
            WHERE p."firmId" = ${firmId} AND p."versionId" IN (${Prisma.join(versionIds)})
              ${unitFilter}
              AND to_tsvector('simple', p.text) @@ plainto_tsquery('simple', ${terms.join(" ")})
            ORDER BY p.id LIMIT ${MAX_RESULTS}`);
        } catch { answer.limitations.push("Indeks pencarian belum tersedia; pencarian teks digunakan."); }
      }
      if (!hits.length && versionIds.length) hits = await db.evidencePassage.findMany({ where: { firmId, versionId: { in: versionIds }, AND: [...(scope?.excluded.length ? [{ NOT: { OR: scope.excluded } }] : []), ...(terms.length ? [{ OR: terms.map((term) => ({ text: { contains: term, mode: "insensitive" as const } })) }] : [])] }, select: { versionId: true, unitKey: true, locator: true, text: true }, orderBy: { id: "asc" }, take: MAX_RESULTS });
      answer.rows = hits.filter((h) => names.has(h.versionId) && unitAllowed(h.versionId, h.unitKey)).map((hit) => { citation(hit.versionId, hit.locator); return { label: names.get(hit.versionId)!, value: hit.text.slice(0, 1600), source: hit.locator }; });
      answer.text = answer.rows.length ? "Kutipan dokumen yang cocok. Ini bukti sumber, bukan penjelasan atau saldo buku yang diverifikasi." : "Tidak ada bukti yang cocok pada versi dokumen aktif. Coba istilah lebih spesifik atau lengkapi dokumen.";
      if (hits.length >= MAX_RESULTS) answer.limitations.push(`Hanya ${MAX_RESULTS} kutipan pertama ditampilkan; persempit pertanyaan.`);
      answer.limitations.push("Kutipan dapat memuat instruksi atau klaim dari penulis dokumen; tidak dijalankan atau dianggap benar tanpa pemeriksaan.");
    }
  }
  answer.limitations = [...new Set(answer.limitations)];
  await db.evidenceMessage.create({ data: { firmId, intakeId, question, answer: json(answer), scope: json({ clientId: intake.clientId, entityId: entityId ?? null, period: input.period ?? null, contextVersion: intake.contextVersion }) } });
  return answer;
}
