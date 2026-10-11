import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { adoptVersion, type BankSection } from "@/lib/inbox/check";
import { createIntake, hash } from "@/lib/evidence/store";
import { toBcaCsv } from "@/lib/demo/writers";
import { createClient } from "@/lib/setup";

// Dokumen's *Bukukan lewat Unggah* (cycle 2026-10-11-dokumen-to-unggah): a stored version becomes an Unggah line without a new copy.
const SECRET = "inbox-adopt-test-secret-32-characters-long";
beforeEach(async () => {
  vi.stubEnv("SETTINGS_SECRET", SECRET);
  await resetDb();
});
afterEach(() => vi.unstubAllEnvs());

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
const bcaCsv = () =>
  Buffer.from(toBcaCsv({ bank: "BCA", accountNumber: "1111111111", holder: "PT Uji Sejahtera", year: 2026, month: 1, opening: 1_000_000n, rows: [{ date: d(2026, 1, 5), description: "SETORAN", amount: 500_000n }, { date: d(2026, 1, 9), description: "PEMBELIAN PAKAN", amount: -200_000n }] }));

/** A file stored in a Dokumen collection (the client's, another client's or the firm's), as an upload leaves it. */
async function stored(firmId: string, clientId: string | undefined, name = "bca-jan.csv", data = bcaCsv()) {
  const intake = await createIntake(db, firmId, clientId);
  const doc = await db.evidenceDocument.create({ data: { firmId, intakeId: intake.id, sourceKey: crypto.randomUUID(), name, path: name, mimeType: "text/csv", status: "READY" } });
  const version = await db.evidenceVersion.create({ data: { firmId, documentId: doc.id, hash: hash(data), data: new Uint8Array(data), name, size: data.length, extracted: true } });
  await db.evidenceDocument.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
  return version;
}

describe("Unggah: adopt a file stored in Dokumen", () => {
  it("reads a client's stored BCA CSV as a statement line of a new drop, keeping the same version", async () => {
    const g = await makeGroup();
    const version = await stored(g.firm.id, g.client.id);
    const versions = await db.evidenceVersion.count();

    const item = await adoptVersion(db, { firmId: g.firm.id, clientId: g.client.id, batchId: "b1", versionId: version.id, actorId: "m1" });
    expect(item).toMatchObject({ kind: "BANK", status: "CHECKED", batchId: "b1", fileName: "bca-jan.csv", evidenceVersionId: version.id, periodStart: "2026-01-01", periodEnd: "2026-01-31" });
    expect(item.sections as BankSection[]).toEqual([expect.objectContaining({ bank: "BCA", number: "1111111111", rows: 2, opening: "1000000", closing: "1300000", error: null })]);
    const row = await db.uploadItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row).toMatchObject({ firmId: g.firm.id, clientId: g.client.id, sha256: version.hash });
    // Not stored again: no new version, no Unggah inbox collection.
    expect(await db.evidenceVersion.count()).toBe(versions);
    expect(await db.evidenceIntake.count({ where: { isInbox: true } })).toBe(0);
  });

  it("refuses a file of another client, of a firm-wide collection or of another firm", async () => {
    const g = await makeGroup();
    const other = await db.$transaction((tx) => createClient(tx, g.firm.id, { name: "Klien Lain", industry: "retail", entities: [{ name: "PT Lain", shortName: "Lain", kind: "PT", banks: [] }] }));
    const foreignFirm = await makeGroup();
    const ofOther = await stored(g.firm.id, other.client.id);
    const firmWide = await stored(g.firm.id, undefined);
    const otherFirm = await stored(foreignFirm.firm.id, foreignFirm.client.id);
    for (const version of [ofOther, firmWide, otherFirm]) {
      await expect(adoptVersion(db, { firmId: g.firm.id, clientId: g.client.id, batchId: "b1", versionId: version.id })).rejects.toThrow("Dokumen tidak ditemukan.");
    }
    // The other firm's own client, named with this firm: refused too.
    await expect(adoptVersion(db, { firmId: g.firm.id, clientId: foreignFirm.client.id, batchId: "b1", versionId: otherFirm.id })).rejects.toThrow("Dokumen tidak ditemukan.");
    expect(await db.uploadItem.count()).toBe(0);
  });

  it("returns the line that already booked the file and creates none", async () => {
    const g = await makeGroup();
    const version = await stored(g.firm.id, g.client.id);
    const first = await adoptVersion(db, { firmId: g.firm.id, clientId: g.client.id, batchId: "b1", versionId: version.id });
    await db.uploadItem.update({ where: { id: first.id }, data: { status: "BOOKED" } });

    const again = await adoptVersion(db, { firmId: g.firm.id, clientId: g.client.id, batchId: "b2", versionId: version.id });
    expect(again).toMatchObject({ id: first.id, batchId: "b1", status: "BOOKED" });
    expect(await db.uploadItem.count()).toBe(1);

    // A ledger draft counts the same.
    await db.uploadItem.update({ where: { id: first.id }, data: { status: "DRAFT" } });
    expect((await adoptVersion(db, { firmId: g.firm.id, clientId: g.client.id, batchId: "b3", versionId: version.id })).id).toBe(first.id);
    expect(await db.uploadItem.count()).toBe(1);

    // Once its import is removed the file is no longer booked: it can be handed over again.
    await db.uploadItem.update({ where: { id: first.id }, data: { status: "BOOKED", statementImportIds: ["removed-import"] } });
    const rebook = await adoptVersion(db, { firmId: g.firm.id, clientId: g.client.id, batchId: "b4", versionId: version.id });
    expect(rebook).toMatchObject({ batchId: "b4", status: "CHECKED" });
    expect(await db.uploadItem.count()).toBe(2);
  });

  it("hands a combined file over again when one of its sections' imports was removed (review of #148)", async () => {
    const g = await makeGroup();
    const version = await stored(g.firm.id, g.client.id);
    const date = d(2026, 1, 1);
    const kept = await db.statementImport.create({ data: { firmId: g.firm.id, bankAccountId: g.pt.banks[0].id, fileName: "gabungan.pdf", format: "BCA", periodStart: date, periodEnd: date, openingBalance: 0n, closingBalance: 0n, rowCount: 1, continuityOk: true } });
    const line = await db.uploadItem.create({ data: { firmId: g.firm.id, clientId: g.client.id, batchId: "b1", fileName: "gabungan.pdf", sha256: version.hash, evidenceVersionId: version.id, kind: "BANK", status: "BOOKED", statementImportIds: [kept.id] } });
    expect((await adoptVersion(db, { firmId: g.firm.id, clientId: g.client.id, batchId: "b2", versionId: version.id })).id).toBe(line.id);

    await db.uploadItem.update({ where: { id: line.id }, data: { statementImportIds: [kept.id, "removed-section-import"] } });
    const again = await adoptVersion(db, { firmId: g.firm.id, clientId: g.client.id, batchId: "b3", versionId: version.id });
    expect(again).toMatchObject({ batchId: "b3", status: "CHECKED" });
  });
});
