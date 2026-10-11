import type { Db } from "@/lib/db";
import { CHUNK_LIMIT, FILE_LIMIT } from "@/lib/evidence/config";
import { appendUpload, beginUpload, finishUpload, hash } from "@/lib/evidence/store";

/**
 * The client's Unggah inbox: one `EvidenceIntake` flagged `isInbox` (at most one per client — partial unique index, migration
 * `unggah_inbox`), found or created on the first drop. Every dropped file is stored in it like any Dokumen upload, so it shows in
 * Dokumen with its versions and questions.
 */
export async function inboxIntake(db: Db, firmId: string, clientId: string) {
  const find = () => db.evidenceIntake.findFirst({ where: { firmId, clientId, isInbox: true } });
  const found = await find();
  if (found) return found;
  if (!(await db.client.findFirst({ where: { id: clientId, firmId }, select: { id: true } }))) throw new Error("Klien tidak ditemukan.");
  try {
    return await db.evidenceIntake.create({ data: { firmId, clientId, name: "Unggah", isInbox: true } });
  } catch (e) {
    // A concurrent first drop created it: the unique index refused this one.
    const raced = await find();
    if (raced) return raced;
    throw e;
  }
}

const FULL = /^Batas (?:100 MiB|500 file)/;

/** Stores the file in the client's inbox (begin / 1 MiB chunks / finish). The same bytes twice are the same version. */
export async function storeFile(db: Db, input: { firmId: string; clientId: string; name: string; data: Buffer }) {
  const intake = await inboxIntake(db, input.firmId, input.clientId);
  // Refused here, not by beginUpload: that would mark the whole inbox PARTIAL for one file whose own line already says why.
  if (input.data.length > FILE_LIMIT) throw new Error("File melebihi batas 10 MiB. Pecah file sebelum mengunggah.");
  let upload;
  try {
    upload = await beginUpload(db, input.firmId, intake.id, input.name, input.data.length);
  } catch (e) {
    if (e instanceof Error && FULL.test(e.message)) {
      throw new Error(`Penyimpanan Unggah klien ini penuh (${e.message.startsWith("Batas 100") ? "batas 100 MiB" : "batas 500 file"}). File tidak disimpan.`);
    }
    throw e;
  }
  for (let offset = 0; offset < input.data.length; offset += CHUNK_LIMIT) {
    await appendUpload(db, input.firmId, upload.id, offset, input.data.subarray(offset, offset + CHUNK_LIMIT));
  }
  const doc = await finishUpload(db, input.firmId, upload.id);
  const sha256 = hash(input.data);
  const version = await db.evidenceVersion.findUniqueOrThrow({ where: { documentId_hash: { documentId: doc.id, hash: sha256 } }, select: { id: true } });
  return { intakeId: intake.id, documentId: doc.id, versionId: version.id, sha256 };
}
