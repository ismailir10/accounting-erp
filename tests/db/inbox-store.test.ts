import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { inboxIntake, storeFile } from "@/lib/inbox/store";
import { createClient } from "@/lib/setup";

beforeEach(resetDb);

describe("Unggah inbox store", () => {
  it("creates one inbox per client, also under concurrent first drops", async () => {
    const g = await makeGroup();
    const intakes = await Promise.all(Array.from({ length: 5 }, () => inboxIntake(db, g.firm.id, g.client.id)));
    expect(new Set(intakes.map((i) => i.id)).size).toBe(1);
    expect(await db.evidenceIntake.count({ where: { clientId: g.client.id, isInbox: true } })).toBe(1);
    expect(await db.evidenceIntake.count()).toBe(1);

    const other = await db.$transaction((tx) => createClient(tx, g.firm.id, { name: "Klien Lain", industry: "retail", entities: [{ name: "PT Lain", shortName: "Lain", kind: "PT", banks: [] }] }));
    const second = await inboxIntake(db, g.firm.id, other.client.id);
    expect(second.id).not.toBe(intakes[0].id);
    await expect(inboxIntake(db, "foreign", g.client.id)).rejects.toThrow("Klien tidak ditemukan");
  });

  it("stores files as versions of the inbox; the same bytes twice are the same version", async () => {
    const g = await makeGroup();
    const data = Buffer.alloc(2.5 * 1024 * 1024, 7); // three chunks
    const a = await storeFile(db, { firmId: g.firm.id, clientId: g.client.id, name: "mutasi.csv", data });
    const b = await storeFile(db, { firmId: g.firm.id, clientId: g.client.id, name: "mutasi (1).csv", data });
    expect(b.versionId).toBe(a.versionId);
    const version = await db.evidenceVersion.findUniqueOrThrow({ where: { id: a.versionId }, include: { document: { include: { intake: true } } } });
    expect(version.document.intake).toMatchObject({ isInbox: true, clientId: g.client.id });
    expect(Buffer.from(version.data).equals(data)).toBe(true);
    expect(version.hash).toBe(a.sha256);
    expect(await db.evidenceVersion.count()).toBe(1);
    expect(await db.evidenceUpload.count()).toBe(0);
  });
});
