import type { Db } from "@/lib/db";
import { INTAKE_TOKEN_LIMIT, runBudgetedAi } from "@/lib/ai/budget";
import { AiAnswerError, buildEvidencePrompt, EVIDENCE_MAX_TOKENS, EVIDENCE_PROMPT_VERSION, EVIDENCE_TIMEOUT_MS, parseEvidenceAnalysis, type AiProvider } from "@/lib/ai/provider";
import { factAllowed } from "./types";
import { assertLease, claimStep, intakeForFirm, lockIntake, releaseStep, hash, json } from "./store";

/** Explicit, review-only enrichment. Extraction/refresh never call this automatically. */
export async function analyzeVersion(db: Db, firmId: string, intakeId: string, versionId: string, provider: AiProvider | null): Promise<{ facts: number; cached: boolean; note?: string }> {
  await intakeForFirm(db, firmId, intakeId);
  const version = await db.evidenceVersion.findFirst({ where: { id: versionId, firmId, document: { firmId, intakeId } } });
  if (!version) throw new Error("Versi dokumen tidak ditemukan.");
  if (!version.extracted) throw new Error("Selesaikan pembacaan dokumen sebelum analisis AI.");
  if (!provider?.analyzeEvidence) return { facts: 0, cached: false, note: "AI tidak aktif. Dokumen tetap tersedia untuk ditinjau manual." };
  // The AI call may take EVIDENCE_TIMEOUT_MS; a lapsed lease would discard its paid answer at assertLease.
  const token = await claimStep(db, firmId, intakeId, EVIDENCE_TIMEOUT_MS + 60_000);
  if (!token) throw new Error("Dokumen sedang diproses sesi lain. Tunggu sampai selesai.");
  try {
    const current = await db.evidenceVersion.findFirstOrThrow({ where: { id: versionId, firmId, document: { firmId, intakeId } } });
    const contextIntake = await intakeForFirm(db, firmId, intakeId);
    const passages = await db.evidencePassage.findMany({ where: { firmId, versionId }, orderBy: [{ unitKey: "asc" }, { locator: "asc" }, { id: "asc" }], take: 24 });
    if (!passages.length) throw new Error("Dokumen belum memiliki teks yang dapat dianalisis.");
    // Compact aliases are unambiguous across sheets and map only to this immutable version.
    const locations = new Map(passages.map((p, i) => [`source:${i}`, p]));
    const client = contextIntake.clientId ? await db.client.findFirst({ where: { id: contextIntake.clientId, firmId }, select: { name: true, industry: true } }) : null;
    const includedVersions = await db.evidenceVersion.findMany({ where: { firmId, document: { firmId, intakeId, excluded: false } }, select: { id: true } });
    const confirmed = await db.evidenceFact.findMany({ where: { firmId, intakeId, status: "CONFIRMED", versionId: { in: includedVersions.map(v => v.id) } }, select: { key: true, value: true }, orderBy: { id: "asc" }, take: 12 });
    const input = { context: JSON.stringify({ client: client ?? contextIntake.name, confirmed }), passages: [...locations].map(([locator, p]) => ({ locator, text: p.text })) };
    const prompt = buildEvidencePrompt(input);
    const key = hash(JSON.stringify([firmId, intakeId, contextIntake.clientId, contextIntake.contextVersion, current.hash, EVIDENCE_PROMPT_VERSION, provider.model, prompt]));
    const cached = await db.evidenceAiCache.findFirst({ where: { key, firmId, scope: `intake:${intakeId}:analysis` } });
    const analysis = cached ? parseEvidenceAnalysis(JSON.stringify(cached.payload), input) : (await runBudgetedAi(db, { firmId, scope: `intake:${intakeId}`, prompt, maxCompletionTokens: EVIDENCE_MAX_TOKENS, scopeTokenLimit: INTAKE_TOKEN_LIMIT, model: provider.model, note: "analisis dokumen" }, async () => {
      const result = await provider.analyzeEvidence!(input);
      try { return { ...result, analysis: parseEvidenceAnalysis(JSON.stringify(result.analysis), input) }; }
      catch { throw new AiAnswerError("Analisis AI tidak valid; tinjau dokumen manual.", result.promptTokens, result.completionTokens, result.model); }
    })).analysis;
    const proposed = [...analysis.facts];
    const sent = JSON.parse(prompt.user) as { passages: { locator: string; text: string }[] };
    const addSourceProposal = (key: string, value: string | null, tokens: string[] = value ? [value] : []) => {
      if (!value) return;
      const passage = sent.passages.find(p => tokens.some(t => p.text.includes(t)));
      if (passage) proposed.push({ key, value, locator: passage.locator });
    };
    addSourceProposal("entity", analysis.entity);
    addSourceProposal("currency", analysis.currency);
    for (const key of ["periodStart", "periodEnd"] as const) {
      const value = analysis[key];
      if (!value) continue;
      const [year, month, day] = value.split("-");
      addSourceProposal(key, value, [value, `${day}/${month}/${year}`, `${day}-${month}-${year}`, `${Number(day)}/${Number(month)}/${year}`]);
    }
    // Classification is an inference over the sampled unit, not a verbatim source claim.
    // Do not assign one classification to an entire workbook containing several units.
    const unitKeys = new Set([...locations.values()].map(p => p.unitKey));
    if (analysis.kind !== "OTHER" && unitKeys.size === 1 && sent.passages[0]) {
      const labels = { BANK: "Rekening koran", LEDGER: "Buku besar", FINANCIAL_STATEMENT: "Laporan keuangan", COMPANY_PROFILE: "Profil perusahaan" };
      proposed.push({ key: "documentKind", value: `${labels[analysis.kind]} (inferensi AI, bukan kutipan)`, locator: sent.passages[0].locator });
    }
    return await db.$transaction(async tx => {
      await lockIntake(tx, intakeId);
      await assertLease(tx, firmId, intakeId, token);
      await tx.evidenceVersion.findFirstOrThrow({ where: { id: versionId, firmId, document: { firmId, intakeId } } });
      let facts = 0;
      for (const fact of proposed) {
        const source = locations.get(fact.locator);
        if (!source || !factAllowed(fact.key, fact.value)) continue;
        const created = await tx.evidenceFact.createMany({ data: [{ firmId, intakeId, versionId, unitKey: source.unitKey, locator: source.locator, key: fact.key, value: fact.value, effectiveDate: analysis.periodEnd }], skipDuplicates: true });
        facts += created.count;
      }
      await tx.evidenceVersion.update({ where: { id: versionId }, data: { analyzed: true } });
      // Proposals do not change confirmed company context or invalidate their own cache.
      await tx.evidenceAiCache.upsert({ where: { key }, create: { key, firmId, scope: `intake:${intakeId}:analysis`, payload: json(analysis) }, update: {} });
      return { facts, cached: Boolean(cached) };
    });
  } finally { await releaseStep(db, firmId, intakeId, token); }
}
