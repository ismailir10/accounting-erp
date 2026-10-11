import type { Db } from "@/lib/db";
import { intakeForFirm } from "./store";
import { bookedView } from "@/lib/inbox/view";
import { liveImports, liveOutcome } from "@/lib/inbox/live";
import { HIDE_INVALID_CURRENCY_FACTS, type EvidenceUnit } from "./types";
export async function loadWorkspace(db: Db, firmId: string, intakeId: string) {
  const intake = await intakeForFirm(db, firmId, intakeId);
  const documents = await db.evidenceDocument.findMany({ where: { firmId, intakeId }, select: { id: true, name: true, path: true, status: true, excluded: true, issue: true, currentVersionId: true, versions: { select: { id: true, name: true, analyzed: true, createdAt: true }, orderBy: { createdAt: "desc" } } }, orderBy: { name: "asc" } });
  const activeIds = documents.filter(d => !d.excluded && d.status === "READY").flatMap(d => d.currentVersionId ? [d.currentVersionId] : []);
  const includedIds = documents.filter(d => !d.excluded).flatMap(d => d.versions.map(v => v.id));
  const [versions, facts, conflicts, selections, messages, entities] = await Promise.all([
    db.evidenceVersion.findMany({ where: { firmId, id: { in: documents.flatMap(d => d.currentVersionId ? [d.currentVersionId] : []) } }, select: { id: true, units: true, issues: true, uploadItems: { where: { firmId, status: { in: ["BOOKED", "DRAFT"] } }, orderBy: { createdAt: "desc" }, take: 1, select: { clientId: true, status: true, message: true, sections: true, statementImportIds: true, ledgerImportId: true } } } }),
    db.evidenceFact.findMany({ where: { firmId, intakeId, ...HIDE_INVALID_CURRENCY_FACTS, OR: [{ status: { not: "REJECTED" }, versionId: { in: activeIds } }, { status: "CONFIRMED", versionId: { in: includedIds } }] }, orderBy: { id: "asc" }, take: 100 }),
    db.evidenceConflict.findMany({ where: { firmId, intakeId }, orderBy: [{ resolved: "asc" }, { id: "asc" }], take: 100 }),
    db.evidenceSelection.findMany({ where: { firmId, intakeId } }),
    db.evidenceMessage.findMany({ where: { firmId, intakeId }, orderBy: { createdAt: "desc" }, take: 10 }),
    intake.clientId ? db.entity.findMany({ where: { firmId, clientId: intake.clientId }, select: { id: true, name: true, shortName: true, functionalCurrency: true, bankAccounts: { select: { id: true, label: true, number: true } } } }) : Promise.resolve([]),
  ]);
  // A discarded ledger draft leaves no import behind: show the selection as ready to prepare again.
  const linked = selections.flatMap(s => s.importId ? [s.importId] : []);
  const live = new Set(linked.length ? [...(await db.ledgerImport.findMany({ where: { firmId, id: { in: linked } }, select: { id: true } })), ...(await db.statementImport.findMany({ where: { firmId, id: { in: linked } }, select: { id: true } }))].map(i => i.id) : []);
  // What Unggah booked, as the books stand now (a removed import or discarded draft is no longer "Dibukukan").
  const uploads = await liveImports(db, firmId, versions.flatMap(v => v.uploadItems));
  const cursor = intake.cursor as { queue?: unknown[] };
  const hasPendingWork = documents.some(d => !d.excluded && d.status === "PENDING") || intake.status !== "PARTIAL" && Array.isArray(cursor.queue) && cursor.queue.length > 0;
  return {
    intake: { id: intake.id, name: intake.name, clientId: intake.clientId, sourceUrl: intake.sourceUrl, status: intake.status, issue: intake.issue, hasPendingWork },
    documents: documents.map(d => ({ ...d, versions: d.versions.map(v => { const current = versions.find(x => x.id === v.id); return { ...v, createdAt: v.createdAt.toISOString(), units: ((current?.units ?? []) as unknown as EvidenceUnit[]).map(u => ({ ...u, passages: u.passages.slice(0, 1), figures: u.figures.slice(0, 6) })), issues: (current?.issues ?? []) as string[], booked: current?.uploadItems[0] ? bookedView(liveOutcome(current.uploadItems[0], uploads)) : null }; }) })),
    facts: facts.map(f => ({ ...f, sourceWarning: activeIds.includes(f.versionId) ? null : "Konteks dikonfirmasi dari versi sumber sebelumnya; belum digantikan oleh versi baru." })), conflicts: conflicts.map(c => ({ ...c, versionIds: c.versionIds as string[] })), selections: selections.map(s => s.importId && !live.has(s.importId) ? { ...s, importId: null } : s), entities,
    messages: messages.map(m => ({ id: m.id, question: m.question, answer: m.answer, createdAt: m.createdAt.toISOString() })),
  };
}
export type Workspace = Awaited<ReturnType<typeof loadWorkspace>>;
