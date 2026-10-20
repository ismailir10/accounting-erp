import type { Db } from "@/lib/db";
import { recordEvent } from "@/lib/audit";
import { formatDate, formatPeriod } from "@/lib/format";
import { lockedAfter } from "@/lib/ledger/post";
import { MAX_UPLOAD_BYTES } from "@/lib/upload";

/**
 * Lampiran jurnal (cycle 2026-10-20-lampiran-arsip): receipts, invoices and approvals kept with a journal. Evidence only — a lampiran
 * never changes a number, is never read for amounts and never sent to a model. PDF, JPG or PNG (told by their first bytes, not the
 * name), up to 5 MB each and 10 per journal. Added to any journal, also in a closed month (evidence arriving after the close changes no
 * figure); removed only while the journal's month is open and no later month is closed, like the journal itself.
 */
export class AttachmentError extends Error {}

export const MAX_ATTACHMENTS = 10;

const KINDS: { type: string; ext: string; magic: number[] }[] = [
  { type: "application/pdf", ext: "pdf", magic: [0x25, 0x50, 0x44, 0x46] },
  { type: "image/jpeg", ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  { type: "image/png", ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
];

/** The file's type from its first bytes, or null when it is not a PDF, JPG or PNG. */
export const sniff = (data: Buffer) => KINDS.find((k) => k.magic.every((b, i) => data[i] === b)) ?? null;

/** A safe download name: the uploaded name without a path or control characters, with the extension its bytes say. */
export function cleanName(name: string, ext: string) {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f"]/g, "").trim().slice(0, 120) || "lampiran";
  return /\.[a-z0-9]{2,4}$/i.test(base) ? base : `${base}.${ext}`;
}

/** The client's journal, or a refusal: an attachment never crosses clients. */
async function entryOf(db: Db, clientId: string, entryId: string) {
  const entry = await db.journalEntry.findFirst({
    where: { id: entryId, entity: { clientId } },
    select: { id: true, firmId: true, number: true, memo: true, date: true, entityId: true, _count: { select: { attachments: true } } },
  });
  if (!entry) throw new AttachmentError("Jurnal tidak ditemukan.");
  return entry;
}

const label = (e: { number: string | null; memo: string; date: Date }) => `${e.number ?? formatDate(e.date)} · ${e.memo}`;

export async function addAttachments(db: Db, input: { clientId: string; entryId: string; files: { name: string; data: Buffer }[]; actorId?: string | null }) {
  const entry = await entryOf(db, input.clientId, input.entryId);
  if (!input.files.length) throw new AttachmentError("Pilih file lampiran.");
  if (entry._count.attachments + input.files.length > MAX_ATTACHMENTS) throw new AttachmentError(`Satu jurnal paling banyak ${MAX_ATTACHMENTS} lampiran.`);
  const rows = input.files.map((f) => {
    if (f.data.length === 0) throw new AttachmentError(`${f.name} kosong.`);
    if (f.data.length > MAX_UPLOAD_BYTES) throw new AttachmentError(`${f.name} terlalu besar (maks. 5 MB).`);
    const kind = sniff(f.data);
    if (!kind) throw new AttachmentError(`${f.name} bukan PDF, JPG atau PNG.`);
    return { firmId: entry.firmId, entryId: entry.id, fileName: cleanName(f.name, kind.ext), contentType: kind.type, size: f.data.length, data: new Uint8Array(f.data), uploadedById: input.actorId ?? null };
  });
  return db.$transaction(async (tx) => {
    const created = [];
    for (const r of rows) created.push(await tx.journalAttachment.create({ data: r, select: { id: true, fileName: true } }));
    await recordEvent(tx, { clientId: input.clientId, entityId: entry.entityId, kind: "ATTACHMENT", subject: `entry:${entry.id}`, summary: `Lampiran ditambahkan ke ${label(entry)}: ${created.map((c) => c.fileName).join(", ")}`, actorId: input.actorId });
    return created;
  });
}

export async function removeAttachment(db: Db, input: { clientId: string; attachmentId: string; actorId?: string | null }) {
  const a = await db.journalAttachment.findFirst({
    where: { id: input.attachmentId, entry: { entity: { clientId: input.clientId } } },
    select: { id: true, fileName: true, entry: { select: { id: true, number: true, memo: true, date: true, entityId: true, period: { select: { year: true, month: true, status: true } } } } },
  });
  if (!a) throw new AttachmentError("Lampiran tidak ditemukan.");
  const p = a.entry.period;
  const closed = p.status === "LOCKED" ? p : await lockedAfter(db, input.clientId, p.year, p.month);
  if (closed) throw new AttachmentError(`${formatPeriod(closed.year, closed.month)} sudah ditutup: lampiran tetap bersama jurnalnya. Buka kembali bulan itu dulu untuk menghapusnya.`);
  await db.$transaction(async (tx) => {
    await tx.journalAttachment.delete({ where: { id: a.id } });
    await recordEvent(tx, { clientId: input.clientId, entityId: a.entry.entityId, kind: "ATTACHMENT", subject: `entry:${a.entry.id}`, summary: `Lampiran dihapus dari ${label(a.entry)}: ${a.fileName}`, actorId: input.actorId });
  });
}

/** The file to download, for a member of the client's firm only (the caller checked the client through the session). */
export async function attachmentFile(db: Db, clientId: string, attachmentId: string) {
  return db.journalAttachment.findFirst({ where: { id: attachmentId, entry: { entity: { clientId } } }, select: { fileName: true, contentType: true, data: true } });
}

/** Attachments of these journals, without their bytes: id → list, for Jurnal Umum and the Buku Besar drawer. */
export async function attachmentsOf(db: Db, entryIds: string[]) {
  const rows = entryIds.length
    ? await db.journalAttachment.findMany({ where: { entryId: { in: entryIds } }, select: { id: true, entryId: true, fileName: true, size: true }, orderBy: { createdAt: "asc" } })
    : [];
  const out = new Map<string, { id: string; fileName: string; size: number }[]>();
  for (const r of rows) out.set(r.entryId, [...(out.get(r.entryId) ?? []), { id: r.id, fileName: r.fileName, size: r.size }]);
  return out;
}
