import type { Db } from "@/lib/db";
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
  return db.$transaction(async (tx) => {
    const d = await tx.dimension.create({ data: { firmId: client.firmId, clientId: input.clientId, kind: input.kind as DimensionKind, code, name } });
    await recordEvent(tx, { clientId: input.clientId, kind: "DIMENSION", subject: subject(d.id), summary: `${label(d)} ditambahkan`, after: { code, name }, actorId: input.actorId });
    return d;
  });
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

/** *Hapus*: only one no line, bank line or stored journal carries (archive it otherwise). */
export async function removeDimension(db: Db, input: { clientId: string; id: string; actorId?: string | null }) {
  const d = await db.dimension.findFirst({ where: { id: input.id, clientId: input.clientId }, include: { _count: { select: { departmentLines: true, projectLines: true, departmentTxs: true, projectTxs: true } } } });
  if (!d) throw new DimensionError("Departemen atau proyek tidak ditemukan.");
  const used = d._count.departmentLines + d._count.projectLines + d._count.departmentTxs + d._count.projectTxs;
  const stored = await storedUses(db, input.clientId, d.id);
  if (used || stored) throw new DimensionError(`${label(d)} sudah dipakai, jadi tidak bisa dihapus. Arsipkan saja agar tidak muncul di pilihan.`);
  await db.$transaction(async (tx) => {
    await tx.dimension.delete({ where: { id: d.id } });
    await recordEvent(tx, { clientId: input.clientId, kind: "DIMENSION", subject: subject(d.id), summary: `${label(d)} dihapus`, before: { code: d.code, name: d.name }, actorId: input.actorId });
  });
}

/** Lines stored outside the ledger that name it: a Jurnal berulang template or a journal waiting for approval. */
async function storedUses(db: Db, clientId: string, id: string) {
  const names = (lines: unknown) => Array.isArray(lines) && lines.some((l) => (l as { departmentId?: string; projectId?: string }).departmentId === id || (l as { projectId?: string }).projectId === id);
  const [templates, waiting] = await Promise.all([
    db.recurringJournal.findMany({ where: { clientId }, select: { lines: true } }),
    db.journalApproval.findMany({ where: { clientId, status: "PENDING" }, select: { lines: true } }),
  ]);
  return [...templates, ...waiting].filter((x) => names(x.lines)).length;
}
