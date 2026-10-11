import { randomUUID } from "node:crypto";
import type { Db, Tx } from "@/lib/db";
import { validateNewClient, type NewClientInput } from "@/lib/onboarding";
import { createClient, type ClientCreator } from "@/lib/setup";
import { isCurrency } from "@/lib/fx/currency";
import { factAllowed, type EvidenceUnit } from "./types";
import { intakeForFirm, lockIntake, releaseStep } from "./store";
import { entityForLabel, stageImport } from "@/lib/ledger-import/post";
import type { CurrencyMode } from "@/lib/ledger-import/check";
import { importStatement } from "@/lib/import/pipeline";
import { parseStatementSections } from "@/lib/import/parsers";
import { checkContinuity } from "@/lib/import/normalize";

export async function createClientFromEvidence(db: Db, firmId: string, intakeId: string, input: NewClientInput, creator?: ClientCreator) {
  const spec = validateNewClient(input);
  return db.$transaction(async tx => {
    await lockIntake(tx, intakeId);
    const intake = await intakeForFirm(tx, firmId, intakeId);
    if (intake.clientId) throw new Error("Dokumen sudah terhubung ke klien.");
    const { client } = await createClient(tx, firmId, spec, { creator });
    await tx.evidenceIntake.update({ where: { id: intakeId }, data: { clientId: client.id, contextVersion: { increment: 1 } } });
    return client.id;
  });
}
export async function linkClient(db: Db, firmId: string, intakeId: string, clientId: string) {
  return db.$transaction(async tx => {
    await lockIntake(tx, intakeId);
    const intake = await intakeForFirm(tx, firmId, intakeId);
    if (intake.clientId && intake.clientId !== clientId) throw new Error("Dokumen sudah terhubung ke klien lain.");
    if (!(await tx.client.findFirst({ where: { id: clientId, firmId } }))) throw new Error("Klien tidak ditemukan.");
    await tx.evidenceIntake.update({ where: { id: intakeId }, data: { clientId, contextVersion: { increment: 1 } } });
  });
}
export async function getUnit(db: Db | Tx, firmId: string, intakeId: string, versionId: string, unitKey: string) {
  const intake = await intakeForFirm(db, firmId, intakeId);
  const version = await db.evidenceVersion.findFirst({ where: { id: versionId, firmId, document: { intakeId, firmId, excluded: false, status: "READY", currentVersionId: versionId } }, include: { document: true } });
  if (!version) throw new Error("Versi sumber sudah berubah atau tidak tersedia. Periksa dokumen terbaru.");
  const unit = (version.units as unknown as EvidenceUnit[]).find(u => u.key === unitKey);
  if (!unit) throw new Error("Bagian dokumen tidak ditemukan.");
  return { intake, version, unit };
}
/** Client entities a ledger's entity column names, all matched by short or full name and sharing one currency. */
async function columnEntities(db: Db | Tx, clientId: string, unit: EvidenceUnit) {
  const labels = unit.table?.mode === "LEDGER" ? unit.table.entities : [];
  if (!labels.length) throw new Error("File tidak memiliki kolom entitas. Pilih entitasnya.");
  const entities = await db.entity.findMany({ where: { clientId } });
  const matched = labels.map(label => ({ label, entity: entityForLabel(entities, label) }));
  const missing = matched.filter(m => !m.entity).map(m => m.label);
  if (missing.length) throw new Error(`Entitas ${missing.join(", ")} di file belum ada di klien. Tambahkan entitasnya (nama singkat sama) atau gunakan impor manual.`);
  const found = [...new Map(matched.map(m => [m.entity!.id, m.entity!])).values()];
  if (new Set(found.map(e => e.functionalCurrency)).size > 1) throw new Error("Entitas di file memakai mata uang pembukuan berbeda. Gunakan impor manual.");
  return found;
}
/** Entities a confirmed source covers: the chosen one, or every entity its ledger's entity column names. */
export async function selectionEntityIds(db: Db | Tx, clientId: string, selection: { entityId: string | null; versionId: string; unitKey: string }) {
  if (selection.entityId) return [selection.entityId];
  const version = await db.evidenceVersion.findUnique({ where: { id: selection.versionId }, select: { units: true } });
  const unit = (version?.units as unknown as EvidenceUnit[] | undefined)?.find(u => u.key === selection.unitKey);
  // Labels that no longer match any entity cover nothing here; that source's own import refuses them.
  return unit ? await columnEntities(db, clientId, unit).then(es => es.map(e => e.id), () => []) : [];
}
const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(+new Date(s)) && new Date(s).toISOString().slice(0, 10) === s;
export type SelectionInput = { role: string; entityId?: string; bankAccountId?: string; periodStart?: string; periodEnd?: string; currency?: string };
export async function confirmSelection(db: Db, firmId: string, intakeId: string, versionId: string, unitKey: string, input: SelectionInput) {
  const initial = await intakeForFirm(db, firmId, intakeId);
  return db.$transaction(async tx => {
    // Coverage decisions and import claims share this lock across all client intakes.
    await lockIntake(tx, initial.clientId ?? intakeId);
    if (initial.clientId) await lockIntake(tx, intakeId);
    const { intake, unit } = await getUnit(tx, firmId, intakeId, versionId, unitKey);
    if (intake.leaseUntil && intake.leaseUntil > new Date()) throw new Error("Dokumen sedang diproses. Tunggu sebelum mengubah pilihan sumber.");
    if (!["SOURCE", "COMPARISON", "CONTEXT"].includes(input.role)) throw new Error("Pilih peran dokumen.");
    const entity = input.entityId ? await tx.entity.findFirst({ where: { id: input.entityId, firmId, clientId: intake.clientId ?? "" } }) : null;
    if (input.entityId && !entity) throw new Error("Entitas tidak ditemukan.");
    const bank = input.bankAccountId ? await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, firmId, entityId: entity?.id ?? "" } }) : null;
    if (input.bankAccountId && !bank) throw new Error("Pilih rekening milik entitas sumber.");
    const current = await tx.evidenceSelection.findUnique({ where: { versionId_unitKey: { versionId, unitKey } } });
    const used = await existingImport(tx, firmId, versionId, unitKey);
    if (current?.importId || used) throw new Error("Sumber sudah digunakan. Koreksi buku melalui jurnal penyesuaian.");
    // A ledger with an entity column can post to every entity it names ("Sesuai kolom Entitas di file").
    const byColumn = input.role === "SOURCE" && !entity && unit.table?.mode === "LEDGER" && unit.table.entities.length > 0;
    let covered: string[] = [];
    if (input.role === "SOURCE") {
      if (!intake.clientId) throw new Error("Hubungkan klien sebelum memilih sumber pencatatan.");
      if ((!entity && !byColumn) || !validDate(input.periodStart ?? "") || !validDate(input.periodEnd ?? "") || input.periodStart! > input.periodEnd!) throw new Error("Pilih entitas dan rentang tanggal sumber pencatatan.");
      if (!input.currency || !isCurrency(input.currency)) throw new Error("Pilih mata uang sumber.");
      if (!["BANK", "LEDGER", "REPORT"].includes(unit.kind)) throw new Error("Dokumen ini belum memiliki tabel yang dapat diimpor.");
      if (unit.kind === "BANK" && !unit.table && !bank) throw new Error("Pilih rekening milik entitas sumber.");
      if (unit.kind !== "LEDGER" && unit.currency && unit.currency !== input.currency) throw new Error("Mata uang pilihan berbeda dengan dokumen sumber.");
      const entities = byColumn ? await columnEntities(tx, intake.clientId, unit) : [entity!];
      if (entities.some(e => e.functionalCurrency !== input.currency)) throw new Error("Mata uang sumber berbeda dengan mata uang entitas. Gunakan impor manual dengan pengaturan kurs.");
      if (entity && unit.table?.mode === "LEDGER") {
        const others = unit.table.entities.filter(label => entityForLabel([entity], label) === undefined);
        if (others.length && unit.table.entities.length > 1) throw new Error(`File juga memuat entitas ${others.join(", ")}. Pilih "Sesuai kolom Entitas di file".`);
      }
      if (unit.table?.mode === "NERACA") {
        // A balance sheet has one date: typed by the accountant, and equal to the file's date when it states one.
        if (input.periodStart !== input.periodEnd) throw new Error("Neraca memiliki satu tanggal. Isi tanggal neraca.");
        if (unit.table.periodEnd && unit.table.periodEnd !== input.periodEnd) throw new Error(`Tanggal neraca di file ${unit.table.periodEnd}. Gunakan tanggal itu.`);
      } else if (unit.periodStart && input.periodStart! > unit.periodStart || unit.periodEnd && input.periodEnd! < unit.periodEnd) throw new Error("Rentang sumber harus mencakup seluruh periode file.");
      covered = entities.map(e => e.id);
      const intakes = await tx.evidenceIntake.findMany({ where: { firmId, clientId: intake.clientId }, select: { id: true } });
      const overlaps = await tx.evidenceSelection.findMany({ where: { firmId, intakeId: { in: intakes.map(i => i.id) }, role: "SOURCE", confirmed: true, periodStart: { lte: input.periodEnd }, periodEnd: { gte: input.periodStart }, NOT: { versionId, unitKey } } });
      for (const other of overlaps) {
        // Two distinct bank accounts are independent sources. A ledger covers all accounts.
        if (unit.kind === "BANK" && !unit.table && bank && other.bankAccountId && other.bankAccountId !== bank.id) continue;
        const theirs = await selectionEntityIds(tx, intake.clientId, other);
        if (theirs.some(id => covered.includes(id))) throw new Error("Cakupan beririsan dengan sumber pencatatan yang sudah dipilih. Jadikan salah satu Pembanding atau pisahkan periodenya.");
      }
    }
    const data = { role: input.role, entityId: entity?.id ?? null, bankAccountId: unit.kind === "BANK" && !unit.table ? bank?.id ?? null : null, periodStart: input.periodStart || null, periodEnd: input.periodEnd || null, currency: input.currency || null, confirmed: true };
    const selection = await tx.evidenceSelection.upsert({ where: { versionId_unitKey: { versionId, unitKey } }, create: { firmId, intakeId, versionId, unitKey, ...data }, update: data });
    await tx.evidenceIntake.update({ where: { id: intakeId }, data: { contextVersion: { increment: 1 } } });
    return selection;
  });
}
async function existingImport(db: Db | Tx, firmId: string, versionId: string, unitKey: string) {
  const where = { firmId, evidenceVersionId: versionId, evidenceUnitKey: unitKey };
  return await db.statementImport.findFirst({ where, select: { id: true } }) ?? await db.ledgerImport.findFirst({ where, select: { id: true } });
}
async function withImportLease<T>(db: Db, firmId: string, intakeId: string, work: () => Promise<T>) {
  const initial = await intakeForFirm(db, firmId, intakeId);
  const token = randomUUID();
  await db.$transaction(async tx => {
    await lockIntake(tx, initial.clientId ?? intakeId);
    if (initial.clientId) await lockIntake(tx, intakeId);
    await intakeForFirm(tx, firmId, intakeId);
    const claimed = await tx.evidenceIntake.updateMany({ where: { id: intakeId, firmId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { leaseToken: token, leaseUntil: new Date(Date.now() + 180_000) } });
    if (!claimed.count) throw new Error("Dokumen sedang diproses sesi lain. Tunggu sampai selesai.");
  });
  try { return await work(); } finally { await releaseStep(db, firmId, intakeId, token); }
}
export async function decideFact(db: Db, firmId: string, intakeId: string, factId: string, accept: boolean) {
  await intakeForFirm(db, firmId, intakeId);
  return db.$transaction(async tx => {
    await lockIntake(tx, intakeId);
    const fact = await tx.evidenceFact.findFirst({ where: { id: factId, firmId, intakeId } });
    if (!fact) throw new Error("Konteks tidak ditemukan.");
    if (accept && !factAllowed(fact.key, fact.value)) throw new Error(`"${fact.value}" bukan kode mata uang. Abaikan usulan ini; mata uang ditulis sebagai kode seperti IDR atau USD.`);
    await tx.evidenceFact.update({ where: { id: factId }, data: { status: accept ? "CONFIRMED" : "REJECTED" } });
    await tx.evidenceIntake.update({ where: { id: intakeId }, data: { contextVersion: { increment: 1 } } });
  });
}
export async function resolveConflict(db: Db, firmId: string, intakeId: string, conflictId: string, note: string) {
  await intakeForFirm(db, firmId, intakeId);
  if (note.trim().length < 8 || note.length > 1000) throw new Error("Catat alasan pemilihan sumber (8–1.000 karakter).");
  const conflict = await db.evidenceConflict.findFirst({ where: { id: conflictId, firmId, intakeId } });
  if (!conflict) throw new Error("Perbedaan tidak ditemukan.");
  await db.evidenceConflict.update({ where: { id: conflict.id }, data: { resolved: true, note: note.trim() } });
}

async function prepare(db: Db, firmId: string, intakeId: string, versionId: string, unitKey: string, bankAccountId?: string, password?: string, currencyMode: CurrencyMode = "FUNCTIONAL", actorId?: string | null) {
  const { intake, version, unit } = await getUnit(db, firmId, intakeId, versionId, unitKey);
  const selection = await db.evidenceSelection.findFirst({ where: { versionId, unitKey, firmId, intakeId } });
  const byColumn = !selection?.entityId && unit.table?.mode === "LEDGER" && unit.table.entities.length > 0;
  if (!intake.clientId || !selection?.confirmed || selection.role !== "SOURCE" || (!selection.entityId && !byColumn) || !selection.periodStart || !selection.periodEnd || !selection.currency) throw new Error("Konfirmasi klien, entitas, dan peran Sumber pencatatan terlebih dahulu.");
  const used = await existingImport(db, firmId, versionId, unitKey);
  // The linked draft was discarded: prepare a new one (e.g. to switch between as-written and converted foreign lines).
  if (selection.importId && !used) selection.importId = null;
  if (selection.importId || used) {
    const importId = selection.importId ?? used!.id;
    await db.evidenceSelection.update({ where: { id: selection.id }, data: { importId } });
    return { kind: unit.kind, importId, already: true };
  }
  if (unit.scale !== "1") throw new Error("Skala angka sumber bukan satuan penuh atau belum pasti. Siapkan file dalam satuan penuh sebelum mengimpor; analisis dokumen tetap tersedia.");
  const entities = byColumn ? await columnEntities(db, intake.clientId, unit) : (await db.entity.findMany({ where: { id: selection.entityId ?? "", firmId, clientId: intake.clientId } }));
  if (!entities.length || entities.some(e => selection.currency !== e.functionalCurrency)) throw new Error("Entitas atau mata uang sumber tidak sesuai.");
  const entity = byColumn ? null : entities[0];
  const conflicts = await db.evidenceConflict.findMany({ where: { firmId, intakeId, resolved: false } });
  if (conflicts.some(c => (c.versionIds as string[]).includes(versionId))) throw new Error("Selesaikan perbedaan sumber terkait sebelum menyiapkan impor.");
  // A postable table always goes through the ledger import, whatever its sheet mentions.
  if (unit.kind === "BANK" && !unit.table && entity) {
    if (bankAccountId && bankAccountId !== selection.bankAccountId) throw new Error("Rekening berubah. Konfirmasi ulang pilihan sumber terlebih dahulu.");
    const bank = await db.bankAccount.findFirst({ where: { id: selection.bankAccountId ?? "", firmId, entityId: entity.id } });
    if (!bank) throw new Error("Pilih rekening milik entitas sumber.");
    if (selection.currency !== "IDR") throw new Error("Rekening koran valuta asing tersedia sebagai bukti; pencatatan bank belum didukung.");
    // A statement dated dd/MM takes the year of the confirmed source range, the accountant's own answer.
    const year = Number(selection.periodStart!.slice(0, 4));
    const sections = await parseStatementSections(version.name, Buffer.from(version.data), { password, year });
    const digits = (value: string | null) => (value ?? "").replace(/\D/g, "");
    const st = sections.find(s => digits(s.accountNumber) === digits(bank.number)) ?? (sections.length === 1 && !sections[0].accountNumber ? sections[0] : null);
    if (!st) throw new Error("Nomor rekening tidak ditemukan pada file atau berbeda dengan rekening terpilih.");
    if (st.error) throw new Error(st.error);
    if ((st.section?.currency ?? "IDR") !== selection.currency) throw new Error("Mata uang rekening di file berbeda dengan pilihan sumber.");
    const dates = [st.periodStart, st.periodEnd, ...st.rows.map(row => row.date)].map(date => date.toISOString().slice(0, 10));
    if (dates.some(date => date < selection.periodStart! || date > selection.periodEnd!)) throw new Error("Rentang sumber harus mencakup seluruh periode file.");
    const locked = await db.period.findMany({ where: { firmId, clientId: intake.clientId, status: "LOCKED" }, select: { year: true, month: true } });
    if (st.rows.some(row => locked.some(p => p.year === row.date.getUTCFullYear() && p.month === row.date.getUTCMonth() + 1))) throw new Error("Periode sumber sudah ditutup. Buka periode terlebih dahulu.");
    const continuity = checkContinuity(st);
    return { kind: "BANK", rows: st.rows.length, continuityOk: continuity.ok, bankAccountId: bank.id, year };
  }
  try {
    const staged = await stageImport(db, { firmId, clientId: intake.clientId, fileName: version.name, data: Buffer.from(version.data), sheet: unit.label, entityId: entity?.id, date: new Date(selection.periodEnd), actorId, evidenceVersionId: versionId, evidenceUnitKey: unitKey, currencyMode, allowedPeriod: { start: selection.periodStart, end: selection.periodEnd, currency: selection.currency, entityIds: entities.map(e => e.id) } });
    if (staged.status !== "STAGED") throw new Error("Tabel sumber belum dapat dipilih. Gunakan impor manual untuk memilih sheet.");
    await db.evidenceSelection.update({ where: { id: selection.id }, data: { importId: staged.importId } });
    return { kind: unit.kind, importId: staged.importId };
  } catch (error) {
    // A competing request may win the unique evidence key after our initial lookup.
    const found = await existingImport(db, firmId, versionId, unitKey);
    if (!found) throw error;
    await db.evidenceSelection.update({ where: { id: selection.id }, data: { importId: found.id } });
    return { kind: unit.kind, importId: found.id, already: true };
  }
}
/** `currencyMode` as in the manual ledger import: foreign lines as written (default) or converted with the Kurs table. */
export async function prepareImport(db: Db, firmId: string, intakeId: string, versionId: string, unitKey: string, bankAccountId?: string, password?: string, currencyMode: CurrencyMode = "FUNCTIONAL", actorId?: string | null) {
  return withImportLease(db, firmId, intakeId, () => prepare(db, firmId, intakeId, versionId, unitKey, bankAccountId, password, currencyMode, actorId));
}
export async function postEvidenceBank(db: Db, firmId: string, intakeId: string, versionId: string, unitKey: string, bankAccountId: string, password?: string, actorId?: string | null) {
  return withImportLease(db, firmId, intakeId, async () => {
    if ((await getUnit(db, firmId, intakeId, versionId, unitKey)).unit.kind !== "BANK") throw new Error("Sumber bukan rekening koran.");
    const preview = await prepare(db, firmId, intakeId, versionId, unitKey, bankAccountId, password, "FUNCTIONAL", actorId);
    if (preview.kind !== "BANK") throw new Error("Sumber bukan rekening koran.");
    if (preview.already) return preview.importId!;
    const { version } = await getUnit(db, firmId, intakeId, versionId, unitKey);
    let importId: string;
    try {
      // Existing deterministic pipeline remains the sole writer; AI suggestions are reviewed later.
      const result = await importStatement(db, { bankAccountId: preview.bankAccountId!, fileName: version.name, data: Buffer.from(version.data), provider: null, password, year: preview.year, actorId, evidenceVersionId: versionId, evidenceUnitKey: unitKey });
      importId = result.importId;
    } catch (error) {
      const found = await db.statementImport.findFirst({ where: { firmId, evidenceVersionId: versionId, evidenceUnitKey: unitKey } });
      if (!found) throw error;
      importId = found.id;
    }
    await db.evidenceSelection.update({ where: { versionId_unitKey: { versionId, unitKey } }, data: { importId } });
    return importId;
  });
}
