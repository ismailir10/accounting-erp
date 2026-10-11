import { randomUUID } from "node:crypto";
import type { Db, Tx } from "@/lib/db";
import { decryptSecret } from "@/lib/settings/secret";
import { extractEvidence } from "./extract";
import type { EvidenceUnit } from "./types";
import { FILE_COUNT_LIMIT } from "./config";
import { assertLease, capacity, claimStep, hash, intakeForFirm, json, lockIntake, releaseStep } from "./store";
import { downloadDriveFile, DriveError, DRIVE_FOLDER_MIME, DRIVE_SHORTCUT_MIME, getDriveFile, listDriveChildren, parseDriveFolderUrl, refreshAccessToken, type DriveFile } from "./drive";

type Folder = { id: string; path: string; resourceKey?: string; pageToken?: string; depth: number };
type Cursor = { run: string; queue: Folder[]; visited: string[]; complete: boolean };
/** System and code files a folder walk skips (Dokumen's inventory, the Unggah Drive listing). */
export const ignored = /^(\.git|\.next|\.claude|\.opencode|\.vscode|\.idea|\.cache|\.turbo|\.venv|venv|__pycache__|node_modules|src|scripts|dist|build|\.DS_Store|\.gitignore|AGENTS\.md|CLAUDE\.md|package(?:-lock)?\.json)$|\.(?:cjs|mjs|js|jsx|ts|tsx|py|sh)$/i;
/** Backup / temporary copies: Dokumen excludes them by default, the Unggah Drive listing skips them. */
export const backup = /(^|[ _.-])(backup[s]?|tmp|checkpoint|intermediate)([ _.-]|$)/i;
const fingerprintOf = (file: DriveFile) => file.version ?? file.md5Checksum ?? file.modifiedTime ?? "";
const OBSOLETE = "Otomatis: konflik tidak lagi melibatkan versi sumber aktif.";
const MAX_CONFLICT_COMPARISONS = 10_000;
const MAX_CONFLICTS = 500;
const MAX_CONFLICT_FACTS = 5_000;
const CONFLICT_LIMIT_ISSUE = "Pemeriksaan konflik belum lengkap: batas 10.000 perbandingan, 500 konflik, atau 5.000 fakta tercapai. Keluarkan duplikat atau pisahkan kumpulan, lalu periksa kembali.";

const isProcessingLimit = (message: string) => /melebihi batas|batas (?:100 MiB|500 file)|terlalu kompleks|ekstraksi dibatasi|sebagian isi belum diperiksa/i.test(message);

/** Lock the lease row before writing so a replacement worker cannot race the commit. */
async function withLease<T>(db: Db, firmId: string, intakeId: string, token: string, work: (tx: Tx) => Promise<T>) {
  return db.$transaction(async tx => {
    await lockIntake(tx, intakeId);
    const owned = await tx.evidenceIntake.updateMany({ where: { id: intakeId, firmId, leaseToken: token, leaseUntil: { gt: new Date() } }, data: { leaseToken: token } });
    if (owned.count !== 1) throw new Error("Langkah sudah diambil sesi lain. Muat ulang untuk melanjutkan.");
    await assertLease(tx, firmId, intakeId, token);
    return work(tx);
  }, { timeout: 30_000 });
}
export async function driveToken(db: Db, firmId: string) {
  const connection = await db.driveConnection.findUnique({ where: { firmId } });
  if (!connection) throw new Error("Hubungkan Google sebelum membaca folder.");
  let refreshToken: string;
  // A token saved under another SETTINGS_SECRET can't be read; only a new consent helps.
  try { refreshToken = decryptSecret(connection.refreshToken); } catch { throw new DriveError("Koneksi Google perlu dihubungkan ulang oleh admin.", "RECONNECT"); }
  return (await refreshAccessToken(refreshToken)).accessToken;
}
export async function attachDrive(db: Db, firmId: string, intakeId: string, url: string) {
  const intake = await intakeForFirm(db, firmId, intakeId);
  const root = parseDriveFolderUrl(url);
  if (intake.sourceUrl && parseDriveFolderUrl(intake.sourceUrl).id !== root.id) throw new Error("Gunakan kumpulan baru untuk folder berbeda.");
  const remote = await getDriveFile(await driveToken(db, firmId), root.id, root.resourceKey);
  if (remote.mimeType !== DRIVE_FOLDER_MIME) throw new Error("Tautan harus menuju folder Google Drive.");
  return db.$transaction(async tx => {
    await lockIntake(tx, intakeId);
    const latest = await intakeForFirm(tx, firmId, intakeId);
    if (latest.leaseUntil && latest.leaseUntil > new Date()) throw new Error("Proses masih berjalan. Tunggu sebelum memeriksa pembaruan.");
    const cursor: Cursor = { run: randomUUID(), queue: [{ ...root, path: remote.name, depth: 0 }], visited: [root.id], complete: false };
    return tx.evidenceIntake.update({ where: { id: intakeId }, data: { name: remote.name, sourceUrl: url, cursor: json(cursor), status: "READY", issue: null, contextVersion: { increment: 1 } } });
  });
}

async function inventoryStep(db: Db, firmId: string, intakeId: string, token: string, cursor: Cursor) {
  const folder = cursor.queue[0];
  const page = await listDriveChildren(await driveToken(db, firmId), folder.id, folder.pageToken, folder.resourceKey);
  await withLease(db, firmId, intakeId, token, async tx => {
    // Manual uploads reserve a slot before their chunks finish arriving.
    const [documents, uploads] = await Promise.all([
      tx.evidenceDocument.count({ where: { firmId, intakeId } }),
      tx.evidenceUpload.count({ where: { firmId, intakeId } }),
    ]);
    let count = documents + uploads;
    const queue = cursor.queue.slice(1);
    if (page.nextPageToken) queue.unshift({ ...folder, pageToken: page.nextPageToken });
    let limit = false;
    for (const file of page.files) {
      const existing = await tx.evidenceDocument.findUnique({ where: { intakeId_sourceKey: { intakeId, sourceKey: file.id } } });
      if (!existing && count >= FILE_COUNT_LIMIT) { limit = true; break; }
      if (!existing) count++;
      const skip = ignored.test(file.name);
      const excluded = existing?.excluded ?? backup.test(file.name);
      const shortcut = file.mimeType === DRIVE_SHORTCUT_MIME;
      const approved = shortcut && !!existing?.approvedShortcutTarget && existing.approvedShortcutTarget === file.shortcutDetails?.targetId;
      const target = approved ? { ...(existing.remote as unknown as DriveFile), id: file.shortcutDetails!.targetId, mimeType: file.shortcutDetails!.targetMimeType, resourceKey: file.shortcutDetails!.targetResourceKey } : file;
      const isFolder = target.mimeType === DRIVE_FOLDER_MIME;
      const fingerprint = approved ? existing!.fingerprint : fingerprintOf(file);
      const changed = !existing || fingerprint !== existing.fingerprint;
      const pending = approved || changed || ["MISSING", "ERROR"].includes(existing?.status ?? "");
      const status = skip ? "IGNORED" : shortcut && !approved ? "SHORTCUT" : isFolder ? "DIRECTORY" : pending ? "PENDING" : existing!.status;
      const record = { name: file.name, path: `${folder.path}/${file.name}`, mimeType: file.mimeType, sourceUrl: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`, remote: json(target), fingerprint, approvedShortcutTarget: approved ? existing!.approvedShortcutTarget : null, excluded: skip || excluded || (shortcut && !approved), status, seenRun: cursor.run, issue: skip ? "File sistem/kode dilewati." : shortcut && !approved ? "Pintasan: pilih Sertakan untuk membaca targetnya." : null };
      await tx.evidenceDocument.upsert({ where: { intakeId_sourceKey: { intakeId, sourceKey: file.id } }, create: { firmId, intakeId, sourceKey: file.id, ...record }, update: record });
      if (isFolder && !skip && !excluded && (!shortcut || approved) && !cursor.visited.includes(target.id)) {
        if (folder.depth >= 20) { limit = true; continue; }
        cursor.visited.push(target.id);
        queue.push({ id: target.id, path: `${folder.path}/${file.name}`, resourceKey: target.resourceKey, depth: folder.depth + 1 });
      }
    }
    cursor.queue = queue;
    cursor.complete = !queue.length && !limit;
    if (cursor.complete) await tx.evidenceDocument.updateMany({ where: { firmId, intakeId, sourceKey: { not: { startsWith: "upload:" } }, seenRun: { not: cursor.run }, excluded: false }, data: { status: "MISSING", issue: "Tidak ditemukan pada pemeriksaan terakhir. Versi sebelumnya tetap tersimpan." } });
    await tx.evidenceIntake.update({ where: { id: intakeId }, data: { cursor: json(cursor), ...(limit ? { status: "PARTIAL", issue: "Inventaris belum lengkap: batas 500 file atau 20 tingkat folder tercapai. Tambahkan subfolder secara terpisah." } : {}) } });
  });
}

export async function processStep(db: Db, firmId: string, intakeId: string, password?: string, documentIdToProcess?: string) {
  const token = await claimStep(db, firmId, intakeId);
  if (!token) return { more: true, busy: true };
  let documentId: string | undefined;
  try {
    const intake = await intakeForFirm(db, firmId, intakeId);
    const cursor = intake.cursor as unknown as Partial<Cursor>;
    if (!documentIdToProcess && cursor.queue?.length && intake.status !== "PARTIAL") {
      await inventoryStep(db, firmId, intakeId, token, cursor as Cursor);
      return { more: true };
    }
    const doc = await db.evidenceDocument.findFirst({ where: { firmId, intakeId, excluded: false, status: "PENDING", ...(documentIdToProcess ? { id: documentIdToProcess } : {}) }, include: { versions: { orderBy: { createdAt: "desc" }, take: 1 } }, orderBy: { id: "asc" } });
    if (!doc) {
      if (documentIdToProcess) return { more: false, error: "Dokumen tidak lagi menunggu proses. Muat ulang hasil pemeriksaan." };
      await withLease(db, firmId, intakeId, token, async tx => {
        await rebuildCurrentConflicts(tx, firmId, intakeId);
        const latest = await intakeForFirm(tx, firmId, intakeId);
        if (latest.sourceUrl && (latest.cursor as unknown as Partial<Cursor>).complete !== true) {
          await tx.evidenceIntake.update({ where: { id: intakeId }, data: { status: "PARTIAL", issue: latest.issue ?? "Inventaris Google Drive belum lengkap. Periksa pembaruan folder untuk melanjutkan." } });
          return;
        }
        await tx.evidenceIntake.updateMany({ where: { id: intakeId, firmId, leaseToken: token, leaseUntil: { gt: new Date() }, status: { not: "PARTIAL" } }, data: { status: "DONE", issue: null } });
      });
      return { more: false };
    }
    documentId = doc.id;
    let version = doc.versions[0];
    let remote = doc.remote as unknown as DriveFile;
    if (!doc.sourceKey.startsWith("upload:")) {
      const accessToken = await driveToken(db, firmId);
      if (doc.approvedShortcutTarget) {
        const resourceKey = remote.resourceKey;
        remote = await getDriveFile(accessToken, doc.approvedShortcutTarget, resourceKey);
        remote.resourceKey ??= resourceKey;
        if (remote.id !== doc.approvedShortcutTarget || remote.mimeType === DRIVE_SHORTCUT_MIME || remote.mimeType === DRIVE_FOLDER_MIME) throw new Error("Target pintasan berubah. Periksa pembaruan folder dan konfirmasi kembali.");
        if (doc.currentVersionId && fingerprintOf(remote) && fingerprintOf(remote) === doc.fingerprint) {
          await withLease(db, firmId, intakeId, token, async tx => { await tx.evidenceDocument.update({ where: { id: doc.id }, data: { status: "READY", remote: json(remote), issue: null } }); });
          return { more: true };
        }
      }
      const downloaded = await downloadDriveFile(accessToken, remote);
      const digest = hash(downloaded.data);
      const cached = await db.evidenceVersion.findUnique({ where: { documentId_hash: { documentId: doc.id, hash: digest } } });
      if (cached) version = cached;
      else version = await withLease(db, firmId, intakeId, token, async tx => {
        await capacity(tx, firmId, intakeId, downloaded.data.length, 0);
        return tx.evidenceVersion.create({ data: { firmId, documentId: doc.id, hash: digest, name: downloaded.name, data: new Uint8Array(downloaded.data), size: downloaded.data.length } });
      });
    }
    if (!version) throw new Error("File sumber belum lengkap. Unggah ulang.");
    if (!version.extracted) {
      const extracted = await extractEvidence(version.name, Buffer.from(version.data), { password });
      await withLease(db, firmId, intakeId, token, async tx => {
        const current = await tx.evidenceVersion.findUniqueOrThrow({ where: { id: version.id } });
        if (current.extracted) return;
        await tx.evidenceVersion.update({ where: { id: version.id }, data: { units: json(extracted.units), issues: json(extracted.issues), extracted: true } });
        const truncation = [...extracted.issues, ...extracted.units.flatMap(unit => unit.issues)].find(isProcessingLimit);
        if (truncation) await tx.evidenceIntake.update({ where: { id: intakeId }, data: { status: "PARTIAL", issue: `${version.name.slice(0, 120)}: ${truncation}` } });
        for (const unit of extracted.units) {
          if (unit.passages.length) await tx.evidencePassage.createMany({ data: unit.passages.map(p => ({ firmId, versionId: version.id, unitKey: unit.key, locator: p.locator, text: p.text })) });
          await tx.evidenceSelection.create({ data: { firmId, intakeId, versionId: version.id, unitKey: unit.key, role: unit.role, periodStart: unit.periodStart, periodEnd: unit.periodEnd, currency: unit.currency } });
          if (unit.facts.length) await tx.evidenceFact.createMany({ data: unit.facts.map(f => ({ firmId, intakeId, versionId: version.id, unitKey: unit.key, locator: f.locator, key: f.key, value: f.value, effectiveDate: unit.periodEnd })), skipDuplicates: true });
        }
        await tx.evidenceIntake.update({ where: { id: intakeId }, data: { contextVersion: { increment: 1 } } });
      });
    }
    await withLease(db, firmId, intakeId, token, async tx => {
      await tx.evidenceDocument.updateMany({ where: { id: doc.id, firmId }, data: { status: "READY", currentVersionId: version.id, remote: json(remote), ...(doc.approvedShortcutTarget ? { fingerprint: fingerprintOf(remote) } : {}), issue: null } });
    });
    return { more: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "File tidak dapat diproses.";
    try {
      await withLease(db, firmId, intakeId, token, async tx => {
        if (documentId) await tx.evidenceDocument.updateMany({ where: { id: documentId, firmId, intakeId }, data: { status: "ERROR", issue: message } });
        if (!documentId || isProcessingLimit(message)) await tx.evidenceIntake.update({ where: { id: intakeId }, data: { status: "PARTIAL", issue: message } });
      });
    } catch { /* An expired worker must never overwrite the replacement worker's result. */ }
    return { more: Boolean(documentId), error: message };
  } finally { await releaseStep(db, firmId, intakeId, token); }
}

export async function rebuildConflicts(db: Db, firmId: string, intakeId: string) {
  return db.$transaction(async tx => {
    await lockIntake(tx, intakeId);
    await rebuildCurrentConflicts(tx, firmId, intakeId);
  }, { timeout: 30_000 });
}

async function rebuildCurrentConflicts(db: Tx, firmId: string, intakeId: string) {
  const intake = await intakeForFirm(db, firmId, intakeId);
  const docs = await db.evidenceDocument.findMany({ where: { firmId, intakeId, excluded: false, status: "READY" }, select: { id: true, name: true, currentVersionId: true } });
  const activeVersions = docs.flatMap(d => d.currentVersionId ? [d.currentVersionId] : []);
  const versions = await db.evidenceVersion.findMany({ where: { firmId, id: { in: activeVersions } }, select: { id: true, hash: true, units: true, issues: true }, orderBy: { id: "asc" } });
  const documentByVersion = new Map(docs.map(d => [d.currentVersionId, d]));
  const records = versions.flatMap(v => {
    const d = documentByVersion.get(v.id);
    return d ? (v.units as unknown as EvidenceUnit[]).map(u => ({ d, v, u })) : [];
  });
  const sourceLimit = versions.flatMap(v => [...v.issues as string[], ...(v.units as unknown as EvidenceUnit[]).flatMap(u => u.issues)]).find(isProcessingLimit);
  const activeKeys: string[] = [];
  const detected: { firmId: string; intakeId: string; key: string; kind: string; message: string; versionIds: string[] }[] = [];
  let comparisons = 0, capped = false;
  compare: for (let i = 0; i < records.length; i++) for (let j = i + 1; j < records.length; j++) {
    if (comparisons >= MAX_CONFLICT_COMPARISONS || detected.length >= MAX_CONFLICTS) { capped = true; break compare; }
    comparisons++;
    const a = records[i], b = records[j];
    if (a.v.id === b.v.id && a.u.key === b.u.key) continue;
    const duplicate = a.v.hash === b.v.hash && a.d.id !== b.d.id;
    const overlap = a.u.kind !== "CONTEXT" && b.u.kind !== "CONTEXT" && a.u.entity && a.u.entity.toLowerCase() === b.u.entity?.toLowerCase() && a.u.currency === b.u.currency && a.u.periodStart && b.u.periodStart && a.u.periodEnd && b.u.periodEnd && a.u.periodStart <= b.u.periodEnd && b.u.periodStart <= a.u.periodEnd;
    if (!duplicate && !overlap) continue;
    const ids = [a.v.id, b.v.id].sort();
    const key = hash(`${ids.join("|")}|${[a.u.key, b.u.key].sort().join("|")}`);
    activeKeys.push(key);
    detected.push({ firmId, intakeId, key, kind: duplicate ? "DUPLICATE" : "OVERLAP", message: duplicate ? `${a.d.name} dan ${b.d.name}: isi file sama.` : `${a.d.name} (${a.u.label}) dan ${b.d.name} (${b.u.label}): cakupan beririsan. Tentukan sumber pencatatan agar tidak dihitung dua kali.`, versionIds: ids });
  }
  // One bounded insert avoids a network round trip for every pair.
  if (detected.length) await db.evidenceConflict.createMany({ data: detected, skipDuplicates: true });
  if (!capped) await db.evidenceConflict.updateMany({ where: { firmId, intakeId, key: { notIn: activeKeys }, resolved: false }, data: { resolved: true, note: OBSOLETE } });
  await db.evidenceConflict.updateMany({ where: { firmId, intakeId, key: { in: activeKeys }, resolved: true, note: OBSOLETE }, data: { resolved: false, note: null } });
  const includedVersions = await db.evidenceVersion.findMany({ where: { firmId, document: { firmId, intakeId, excluded: false } }, select: { id: true } });
  const fetchedFacts = await db.evidenceFact.findMany({ where: { firmId, intakeId, OR: [{ versionId: { in: activeVersions }, status: { not: "REJECTED" } }, { versionId: { in: includedVersions.map(v => v.id) }, status: "CONFIRMED" }] }, orderBy: { id: "asc" }, take: MAX_CONFLICT_FACTS + 1 });
  const factsCapped = fetchedFacts.length > MAX_CONFLICT_FACTS;
  const facts = fetchedFacts.slice(0, MAX_CONFLICT_FACTS);
  const entityByUnit = new Map(records.map(({ d, v, u }) => [`${v.id}:${u.key}`, u.entity ? `entity:${u.entity.trim().toLowerCase()}` : `document:${d.id}`]));
  const historicIds = [...new Set(facts.filter(f => !activeVersions.includes(f.versionId)).map(f => f.versionId))];
  const historic = historicIds.length ? await db.evidenceVersion.findMany({ where: { firmId, id: { in: historicIds } }, select: { id: true, documentId: true, units: true } }) : [];
  for (const v of historic) for (const u of v.units as unknown as EvidenceUnit[]) entityByUnit.set(`${v.id}:${u.key}`, u.entity ? `entity:${u.entity.trim().toLowerCase()}` : `document:${v.documentId}`);
  const groupKey = (f: (typeof facts)[number]) => {
    const entity = entityByUnit.get(`${f.versionId}:${f.unitKey}`);
    return entity ? JSON.stringify([entity, f.key]) : null;
  };
  const valuesByGroup = new Map<string, Set<string>>();
  for (const f of facts) {
    const key = groupKey(f);
    if (!key) continue;
    const values = valuesByGroup.get(key) ?? new Set<string>();
    values.add(f.value.toLowerCase());
    valuesByGroup.set(key, values);
  }
  const conflicting: string[] = [], noLongerConflicting: string[] = [];
  for (const f of facts) {
    const key = groupKey(f);
    const conflict = key && (valuesByGroup.get(key)?.size ?? 0) > 1;
    if (conflict && f.status === "PROPOSED") conflicting.push(f.id);
    if (!conflict && !factsCapped && f.status === "CONFLICTING") noLongerConflicting.push(f.id);
  }
  if (conflicting.length) await db.evidenceFact.updateMany({ where: { firmId, intakeId, id: { in: conflicting }, status: "PROPOSED" }, data: { status: "CONFLICTING" } });
  if (noLongerConflicting.length) await db.evidenceFact.updateMany({ where: { firmId, intakeId, id: { in: noLongerConflicting }, status: "CONFLICTING" }, data: { status: "PROPOSED" } });
  if (capped || factsCapped) {
    await db.evidenceIntake.update({ where: { id: intakeId }, data: { status: "PARTIAL", issue: CONFLICT_LIMIT_ISSUE } });
  } else if (sourceLimit) {
    await db.evidenceIntake.update({ where: { id: intakeId }, data: { status: "PARTIAL", issue: sourceLimit } });
  } else if (intake.issue === CONFLICT_LIMIT_ISSUE) {
    const incompleteDrive = intake.sourceUrl && (intake.cursor as unknown as Partial<Cursor>).complete !== true;
    await db.evidenceIntake.update({ where: { id: intakeId }, data: { status: incompleteDrive ? "PARTIAL" : "READY", issue: incompleteDrive ? "Inventaris Google Drive belum lengkap. Periksa pembaruan folder untuk melanjutkan." : null } });
  }
}

export async function includeDocument(db: Db, firmId: string, intakeId: string, documentId: string) {
  await intakeForFirm(db, firmId, intakeId);
  const doc = await db.evidenceDocument.findFirst({ where: { id: documentId, firmId, intakeId } });
  if (!doc || doc.status === "IGNORED") throw new Error("Dokumen tidak dapat disertakan.");
  let file = doc.remote as unknown as DriveFile;
  let approvedShortcutTarget = doc.approvedShortcutTarget;
  if (doc.status === "SHORTCUT") {
    if (!file.shortcutDetails) throw new Error("Target pintasan tidak ditemukan.");
    const detail = file.shortcutDetails;
    file = await getDriveFile(await driveToken(db, firmId), detail.targetId, detail.targetResourceKey);
    file.resourceKey ??= detail.targetResourceKey;
    if (file.mimeType === DRIVE_SHORTCUT_MIME) throw new Error("Pintasan berantai belum didukung. Sertakan folder target secara langsung.");
    approvedShortcutTarget = file.id;
  }
  return db.$transaction(async tx => {
    await lockIntake(tx, intakeId);
    const intake = await intakeForFirm(tx, firmId, intakeId);
    if (intake.leaseUntil && intake.leaseUntil > new Date()) throw new Error("Tunggu proses aktif selesai.");
    if (file.mimeType === DRIVE_FOLDER_MIME) {
      const cursor = intake.cursor as unknown as Cursor;
      if (!cursor.run) throw new Error("Periksa pembaruan folder sebelum menyertakan subfolder.");
      if (!cursor.visited.includes(file.id)) { cursor.visited.push(file.id); cursor.queue.push({ id: file.id, resourceKey: file.resourceKey, path: doc.path, depth: 0 }); }
      cursor.complete = false;
      await tx.evidenceIntake.update({ where: { id: intakeId }, data: { cursor: json(cursor), status: "READY" } });
    } else await tx.evidenceIntake.update({ where: { id: intakeId }, data: { status: "READY" } });
    await tx.evidenceDocument.update({ where: { id: doc.id }, data: { excluded: false, remote: json(file), approvedShortcutTarget, status: file.mimeType === DRIVE_FOLDER_MIME ? "DIRECTORY" : "PENDING", issue: null } });
  });
}
