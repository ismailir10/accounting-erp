import { beforeEach, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { createIntake, hash, json } from "@/lib/evidence/store";
import { decideFact } from "@/lib/evidence/review";
import { rebuildConflicts } from "@/lib/evidence/jobs";
import { loadWorkspace } from "@/lib/evidence/workspace";
import { askEvidence } from "@/lib/evidence/answers";
import { analyzeVersion } from "@/lib/evidence/enrich";
import { MockProvider, type AiProvider } from "@/lib/ai/provider";
import type { EvidenceUnit } from "@/lib/evidence/types";

beforeEach(resetDb);

it("refresh retains confirmed context, exposes conflicting proposals, and respects source scopes and exclusions", async () => {
  const g = await makeGroup(), intake = await createIntake(db, g.firm.id, g.client.id);
  const doc = await db.evidenceDocument.create({ data: { firmId: g.firm.id, intakeId: intake.id, sourceKey: "profile", name: "profile.txt", path: "profile.txt", mimeType: "text/plain", status: "READY" } });
  const unit: EvidenceUnit = { key: "profile", label: "Profil", kind: "CONTEXT", role: "CONTEXT", entity: g.pt.entity.name, periodStart: "2026-01-01", periodEnd: "2026-01-31", currency: "IDR", scale: "1", passages: [], figures: [], facts: [], issues: [] };
  async function addVersion(value: string) {
    const text = `Industry: ${value}`;
    const version = await db.evidenceVersion.create({ data: { firmId: g.firm.id, documentId: doc.id, hash: hash(text), name: doc.name, size: text.length, data: Buffer.from(text), extracted: true, units: json([unit]) } });
    await db.evidencePassage.create({ data: { firmId: g.firm.id, versionId: version.id, unitKey: unit.key, locator: "baris 1", text } });
    const fact = await db.evidenceFact.create({ data: { firmId: g.firm.id, intakeId: intake.id, versionId: version.id, unitKey: unit.key, locator: "baris 1", key: "industry", value } });
    await db.evidenceSelection.create({ data: { firmId: g.firm.id, intakeId: intake.id, versionId: version.id, unitKey: unit.key, role: "CONTEXT", entityId: g.pt.entity.id, periodStart: unit.periodStart, periodEnd: unit.periodEnd, confirmed: true } });
    await db.evidenceDocument.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
    return { version, fact };
  }
  const old = await addVersion("poultry");
  await decideFact(db, g.firm.id, intake.id, old.fact.id, true);
  await db.evidenceFact.create({ data: { firmId: g.firm.id, intakeId: intake.id, versionId: old.version.id, unitKey: unit.key, locator: "baris 1", key: "stale", value: "old unconfirmed claim" } });
  const current = await addVersion("retail");
  await rebuildConflicts(db, g.firm.id, intake.id);
  const workspace = await loadWorkspace(db, g.firm.id, intake.id);
  expect(workspace.facts).toHaveLength(2);
  expect(workspace.facts.find(f => f.id === old.fact.id)).toMatchObject({ status: "CONFIRMED", sourceWarning: expect.stringContaining("sebelumnya") });
  expect(workspace.facts.find(f => f.id === current.fact.id)).toMatchObject({ status: "CONFLICTING", sourceWarning: null });
  const question = { question: "Profil perusahaan", entityId: g.pt.entity.id, period: "2026-01" };
  const answer = await askEvidence(db, g.firm.id, intake.id, question, null);
  expect(answer.rows?.map(r => r.value)).toEqual(expect.arrayContaining(["poultry (dikonfirmasi; versi sebelumnya)", "retail (bertentangan; belum dikonfirmasi)"]));
  expect(answer.citations).toContainEqual({ versionId: old.version.id, locator: "baris 1", label: "profile.txt" });
  expect(answer.limitations.join(" ")).toContain("versi sebelumnya");
  expect((await askEvidence(db, g.firm.id, intake.id, { ...question, entityId: g.owner.entity.id }, null)).rows).toEqual([]);
  expect((await askEvidence(db, g.firm.id, intake.id, { ...question, period: "2026-02" }, null)).rows).toEqual([]);
  await expect(askEvidence(db, "foreign-firm", intake.id, question, null)).rejects.toThrow();
  await db.evidenceDocument.update({ where: { id: doc.id }, data: { excluded: true } });
  expect((await loadWorkspace(db, g.firm.id, intake.id)).facts).toEqual([]);
  expect((await askEvidence(db, g.firm.id, intake.id, question, null)).rows).toEqual([]);
  expect((await db.evidenceFact.findUniqueOrThrow({ where: { id: old.fact.id } })).status).toBe("CONFIRMED");
  expect(await db.journalEntry.count()).toBe(0);
});

it("AI enrichment context includes historic confirmations but omits explicitly excluded sources", async () => {
  const g = await makeGroup(), intake = await createIntake(db, g.firm.id, g.client.id);
  async function source(key: string, excluded: boolean) {
    const doc = await db.evidenceDocument.create({ data: { firmId: g.firm.id, intakeId: intake.id, sourceKey: key, name: `${key}.txt`, path: key, mimeType: "text/plain", status: "READY", excluded } });
    const version = await db.evidenceVersion.create({ data: { firmId: g.firm.id, documentId: doc.id, hash: hash(key), name: doc.name, size: key.length, data: Buffer.from(key), extracted: true } });
    await db.evidenceFact.create({ data: { firmId: g.firm.id, intakeId: intake.id, versionId: version.id, unitKey: "text", locator: "baris 1", key: "industry", value: key, status: "CONFIRMED" } });
    await db.evidencePassage.create({ data: { firmId: g.firm.id, versionId: version.id, unitKey: "text", locator: "baris 1", text: key } });
    return version;
  }
  const included = await source("retained historical context", false);
  await source("excluded company context", true);
  const provider: AiProvider = new MockProvider();
  let sentContext = "";
  const original = provider.analyzeEvidence!.bind(provider);
  provider.analyzeEvidence = async input => { sentContext = input.context; return original(input); };
  await analyzeVersion(db, g.firm.id, intake.id, included.id, provider);
  expect(sentContext).toContain("retained historical context");
  expect(sentContext).not.toContain("excluded company context");
});

it("a country name is never stored, shown or confirmed as the currency", async () => {
  const g = await makeGroup(), intake = await createIntake(db, g.firm.id, g.client.id);
  const text = "PT CONTOH JAYA, JAKARTA INDONESIA. MATA UANG IDR";
  const doc = await db.evidenceDocument.create({ data: { firmId: g.firm.id, intakeId: intake.id, sourceKey: "bca", name: "bca.pdf", path: "bca.pdf", mimeType: "application/pdf", status: "READY" } });
  const version = await db.evidenceVersion.create({ data: { firmId: g.firm.id, documentId: doc.id, hash: hash(text), name: doc.name, size: text.length, data: Buffer.from(text), extracted: true } });
  await db.evidenceDocument.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
  await db.evidencePassage.create({ data: { firmId: g.firm.id, versionId: version.id, unitKey: "text", locator: "hal 1", text } });
  const provider: AiProvider = new MockProvider();
  provider.analyzeEvidence = async () => ({ analysis: { kind: "BANK", entity: null, periodStart: null, periodEnd: null, currency: null, facts: [{ key: "currency", value: "INDONESIA", locator: "source:0" }, { key: "currency", value: "IDR", locator: "source:0" }] }, promptTokens: 1, completionTokens: 1, model: "mock" });
  await analyzeVersion(db, g.firm.id, intake.id, version.id, provider);
  expect((await db.evidenceFact.findMany({ where: { intakeId: intake.id, key: "currency" } })).map(f => f.value)).toEqual(["IDR"]);
  // A proposal stored before the check: hidden from the workspace and refused on confirm.
  const old = await db.evidenceFact.create({ data: { firmId: g.firm.id, intakeId: intake.id, versionId: version.id, unitKey: "text", locator: "hal 1", key: "currency", value: "INDONESIA" } });
  expect((await loadWorkspace(db, g.firm.id, intake.id)).facts.filter(f => f.key === "currency").map(f => f.value)).toEqual(["IDR"]);
  await expect(decideFact(db, g.firm.id, intake.id, old.id, true)).rejects.toThrow("bukan kode mata uang");
  await decideFact(db, g.firm.id, intake.id, old.id, false);
  expect((await db.evidenceFact.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("REJECTED");
});

it("a file Unggah booked shows as booked, not as a role form", async () => {
  const g = await makeGroup(), intake = await createIntake(db, g.firm.id, g.client.id);
  async function file(name: string) {
    const doc = await db.evidenceDocument.create({ data: { firmId: g.firm.id, intakeId: intake.id, sourceKey: name, name, path: name, mimeType: "application/pdf", status: "READY" } });
    const version = await db.evidenceVersion.create({ data: { firmId: g.firm.id, documentId: doc.id, hash: hash(name), name, size: name.length, data: Buffer.from(name), extracted: true } });
    await db.evidenceDocument.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
    return version;
  }
  const [bank, ledger, other] = [await file("bca.pdf"), await file("gl.xlsx"), await file("akta.pdf")];
  const section = { bank: "BCA", number: "123-456-3814", holder: null, currency: "IDR", periodStart: "2026-01-01", periodEnd: "2026-01-31", rows: 3, opening: "0", closing: "0", error: null };
  const item = { firmId: g.firm.id, clientId: g.client.id, batchId: "b1", sha256: "x" };
  const draft = await db.ledgerImport.create({ data: { firmId: g.firm.id, clientId: g.client.id, fileName: "gl.xlsx", fileHash: "h", sheetName: "GL", mode: "LEDGER", periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-01-31"), rowCount: 2, data: [] } });
  await db.uploadItem.createMany({ data: [
    { ...item, fileName: "bca.pdf", evidenceVersionId: bank.id, kind: "BANK", status: "BOOKED", sections: [section] },
    { ...item, fileName: "gl.xlsx", evidenceVersionId: ledger.id, kind: "LEDGER", status: "DRAFT", ledgerImportId: draft.id },
    { ...item, fileName: "akta.pdf", evidenceVersionId: other.id, kind: "OTHER", status: "KEPT" },
  ] });
  const booked = Object.fromEntries((await loadWorkspace(db, g.firm.id, intake.id)).documents.map(d => [d.name, d.versions[0].booked]));
  expect(booked["bca.pdf"]).toEqual({ status: "BOOKED", label: "Dibukukan → BCA ·3814 · Jan 2026", href: `/clients/${g.client.id}/import` });
  expect(booked["gl.xlsx"]).toEqual({ status: "DRAFT", label: "Draf buku besar →", href: `/clients/${g.client.id}/import/ledger/${draft.id}` });
  expect(booked["akta.pdf"]).toBeNull();
  // The books move on: the draft is posted, then the statement's import is gone.
  await db.ledgerImport.update({ where: { id: draft.id }, data: { status: "POSTED" } });
  await db.uploadItem.updateMany({ where: { fileName: "bca.pdf" }, data: { statementImportIds: ["removed-import"] } });
  const after = Object.fromEntries((await loadWorkspace(db, g.firm.id, intake.id)).documents.map(d => [d.name, d.versions[0].booked]));
  expect(after["gl.xlsx"]).toEqual({ status: "BOOKED", label: "Buku besar dibukukan →", href: `/clients/${g.client.id}/import/ledger/${draft.id}` });
  expect(after["bca.pdf"]).toBeNull();
});
