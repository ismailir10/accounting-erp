import type { Db, Tx } from "@/lib/db";
import type { DimensionKind } from "@/lib/generated/prisma/enums";
import { recordEvent } from "@/lib/audit";

/**
 * Departemen & Proyek (cycle 2026-10-21-departemen-proyek): a client's two analysis dimensions. A journal line may carry one department and
 * one project (`JournalLine.departmentId`, `projectId`): labels for the Laba Rugi per departemen / proyek, never a balance. An archived one
 * leaves the pickers (and postJournal() refuses it on a new line) and stays in reports; one in use is never removed.
 */
export class DimensionError extends Error {}

export const DIMENSION_LABEL: Record<DimensionKind, string> = { DEPARTEMEN: "Departemen", PROYEK: "Proyek" };
export const DIMENSION_KINDS = Object.keys(DIMENSION_LABEL) as DimensionKind[];

export type DimensionView = { id: string; kind: DimensionKind; code: string; name: string; archived: boolean; lines: number };

const isKind = (k: string): k is DimensionKind => (DIMENSION_KINDS as string[]).includes(k);

function clean(input: { code: string; name: string }) {
  const code = input.code.replace(/\s+/g, "").toUpperCase();
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,11}$/.test(code)) throw new DimensionError("Kode 1–12 huruf atau angka (boleh . _ -), mis. OUTLET-A.");
  if (name.length < 2 || name.length > 60) throw new DimensionError("Isi nama 2–60 huruf.");
  return { code, name };
}

const label = (d: { kind: DimensionKind; code: string; name: string }) => `${DIMENSION_LABEL[d.kind]} ${d.code} ${d.name}`;
const subject = (id: string) => `dimension:${id}`;

/** A client's departments and projects, archived last, with how many journal lines carry each. */
export async function listDimensions(db: Db, clientId: string): Promise<DimensionView[]> {
  const rows = await db.dimension.findMany({
    where: { clientId },
    include: { _count: { select: { departmentLines: true, projectLines: true } } },
    orderBy: [{ kind: "asc" }, { archivedAt: { sort: "asc", nulls: "first" } }, { code: "asc" }],
  });
  return rows.map((d) => ({ id: d.id, kind: d.kind, code: d.code, name: d.name, archived: !!d.archivedAt, lines: d._count.departmentLines + d._count.projectLines }));
}

/** The pickers' options: the client's active departments and projects. */
export async function dimensionOptions(db: Db, clientId: string) {
  const rows = await db.dimension.findMany({ where: { clientId, archivedAt: null }, orderBy: { code: "asc" }, select: { id: true, kind: true, code: true, name: true } });
  return { departments: rows.filter((d) => d.kind === "DEPARTEMEN"), projects: rows.filter((d) => d.kind === "PROYEK") };
}

export async function createDimension(db: Db, input: { clientId: string; kind: string; code: string; name: string; actorId?: string | null }) {
  if (!isKind(input.kind)) throw new DimensionError("Pilih departemen atau proyek.");
  const { code, name } = clean(input);
  const client = await db.client.findUniqueOrThrow({ where: { id: input.clientId }, select: { firmId: true } });
  if (await db.dimension.findFirst({ where: { clientId: input.clientId, kind: input.kind, code }, select: { id: true } })) throw new DimensionError(`Kode ${code} sudah dipakai ${DIMENSION_LABEL[input.kind].toLowerCase()} lain.`);
  const taken = () => new DimensionError(`Kode ${code} sudah dipakai ${DIMENSION_LABEL[input.kind as DimensionKind].toLowerCase()} lain.`);
  try {
    return await db.$transaction(async (tx) => {
      const d = await tx.dimension.create({ data: { firmId: client.firmId, clientId: input.clientId, kind: input.kind as DimensionKind, code, name } });
      await recordEvent(tx, { clientId: input.clientId, kind: "DIMENSION", subject: subject(d.id), summary: `${label(d)} ditambahkan`, after: { code, name }, actorId: input.actorId });
      return d;
    });
  } catch (e) {
    // Two members adding the same code at once: the second meets the unique index.
    if ((e as { code?: string }).code === "P2002") throw taken();
    throw e;
  }
}

/** A new name (the code stays: it is how the lines and reports name it). */
export async function renameDimension(db: Db, input: { clientId: string; id: string; name: string; actorId?: string | null }) {
  const d = await db.dimension.findFirst({ where: { id: input.id, clientId: input.clientId } });
  if (!d) throw new DimensionError("Departemen atau proyek tidak ditemukan.");
  const { name } = clean({ code: d.code, name: input.name });
  if (name === d.name) return d;
  return db.$transaction(async (tx) => {
    const updated = await tx.dimension.update({ where: { id: d.id }, data: { name } });
    await recordEvent(tx, { clientId: input.clientId, kind: "DIMENSION", subject: subject(d.id), summary: `${label(d)} diubah menjadi ${name}`, before: { name: d.name }, after: { name }, actorId: input.actorId });
    return updated;
  });
}

/** *Arsipkan* / *Aktifkan lagi*: out of the pickers (and refused on a new line), or back in. Reports keep the history either way. */
export async function setDimensionArchived(db: Db, input: { clientId: string; id: string; archived: boolean; actorId?: string | null }) {
  const d = await db.dimension.findFirst({ where: { id: input.id, clientId: input.clientId } });
  if (!d) throw new DimensionError("Departemen atau proyek tidak ditemukan.");
  if (!!d.archivedAt === input.archived) return d;
  return db.$transaction(async (tx) => {
    const updated = await tx.dimension.update({ where: { id: d.id }, data: { archivedAt: input.archived ? new Date() : null } });
    await recordEvent(tx, { clientId: input.clientId, kind: "DIMENSION", subject: subject(d.id), summary: `${label(d)} ${input.archived ? "diarsipkan" : "diaktifkan lagi"}`, actorId: input.actorId });
    return updated;
  });
}

/**
 * *Hapus*: only one no line, bank line, invoice, schedule or stored journal carries (archive it otherwise). Checked again under a lock on
 * the row, inside the delete: a request or template storing it takes the same row `FOR SHARE` (`lockTags`), and a journal line's foreign
 * key waits on it, so a removal never leaves a stored line naming nothing.
 */
export async function removeDimension(db: Db, input: { clientId: string; id: string; actorId?: string | null }) {
  const used = (d: { code: string; kind: DimensionKind; name: string }) => new DimensionError(`${label(d)} sudah dipakai, jadi tidak bisa dihapus. Arsipkan saja agar tidak muncul di pilihan.`);
  try {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Dimension" WHERE id = ${input.id} AND "clientId" = ${input.clientId} FOR UPDATE`;
      const d = await tx.dimension.findFirst({ where: { id: input.id, clientId: input.clientId }, include: { _count: { select: { departmentLines: true, projectLines: true, departmentTxs: true, projectTxs: true, departmentInvoices: true, projectInvoices: true, departmentSchedules: true, projectSchedules: true } } } });
      if (!d) throw new DimensionError("Departemen atau proyek tidak ditemukan.");
      if (Object.values(d._count).reduce((t, n) => t + n, 0) || (await storedUses(tx, input.clientId, d.id))) throw used(d);
      await tx.dimension.delete({ where: { id: d.id } });
      await recordEvent(tx, { clientId: input.clientId, kind: "DIMENSION", subject: subject(d.id), summary: `${label(d)} dihapus`, before: { code: d.code, name: d.name }, actorId: input.actorId });
    });
  } catch (e) {
    // A journal line naming it committed first: its foreign key keeps the row.
    if ((e as { code?: string }).code === "P2003") {
      const d = await db.dimension.findFirst({ where: { id: input.id }, select: { code: true, kind: true, name: true } });
      if (d) throw used(d);
    }
    throw e;
  }
}

/** The tags a stored line names (a waiting request, a Jurnal berulang template), share-locked so a removal waits for the store. */
export async function lockTags(tx: Tx, lines: { departmentId?: string | null; projectId?: string | null }[]) {
  const ids = [...new Set(lines.flatMap((l) => [l.departmentId, l.projectId]).filter((x): x is string => !!x))];
  if (!ids.length) return;
  const held = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Dimension" WHERE id = ANY(${ids}) FOR SHARE`;
  if (held.length !== ids.length) throw new DimensionError("Departemen atau proyek di jurnal ini baru saja dihapus. Muat ulang halaman lalu pilih lagi.");
}

/** Lines stored outside the ledger that name it: a Jurnal berulang template or a journal waiting for approval. */
async function storedUses(db: Db | Tx, clientId: string, id: string) {
  const names = (lines: unknown) => Array.isArray(lines) && lines.some((l) => (l as { departmentId?: string; projectId?: string }).departmentId === id || (l as { projectId?: string }).projectId === id);
  const [templates, waiting] = await Promise.all([
    db.recurringJournal.findMany({ where: { clientId }, select: { lines: true } }),
    db.journalApproval.findMany({ where: { clientId, status: "PENDING" }, select: { lines: true } }),
  ]);
  return [...templates, ...waiting].filter((x) => names(x.lines)).length;
}

export type Tags = { departmentId: string | null; projectId: string | null };

/**
 * A document's Departemen & Proyek (an invoice, a schedule), checked as `postJournal()` checks a line: the client's own, the right kind,
 * not archived — unless `keep` already carries it (a running schedule keeps the tag it was given). Empty is none.
 */
export async function checkTags(db: Db | Tx, clientId: string, input: { departmentId?: string | null; projectId?: string | null }, keep?: Tags): Promise<Tags> {
  const tags = { departmentId: input.departmentId || null, projectId: input.projectId || null };
  const ids = [tags.departmentId, tags.projectId].filter((x): x is string => !!x);
  if (!ids.length) return tags;
  const dims = new Map((await db.dimension.findMany({ where: { id: { in: ids }, clientId } })).map((d) => [d.id, d]));
  for (const kind of DIMENSION_KINDS) {
    const id = kind === "DEPARTEMEN" ? tags.departmentId : tags.projectId;
    if (!id) continue;
    const d = dims.get(id);
    if (!d || d.kind !== kind) throw new DimensionError(`${DIMENSION_LABEL[kind]} tidak termasuk klien ini.`);
    const kept = kind === "DEPARTEMEN" ? keep?.departmentId : keep?.projectId;
    if (d.archivedAt && id !== kept) throw new DimensionError(`${label(d)} sudah diarsipkan. Aktifkan lagi di Pengaturan klien untuk memakainya.`);
  }
  return tags;
}
