import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, resetDb } from "../helpers";
import { accessState } from "@/lib/access/grant";
import { AccessAdminError, createOrganisation, extendGrant, grantAccess, revokeGrant, setLimits, setSuspended } from "@/lib/access/admin";

const ops = () => db.platformAdmin.create({ data: { userId: randomUUID(), email: `ops-${randomUUID()}@buku.test`, name: "Ops" } });
const stateAt = async (firmId: string, at: string) => {
  const firm = await db.firm.findUniqueOrThrow({ where: { id: firmId }, include: { grants: true } });
  return accessState(firm.grants, firm, new Date(at)).state;
};

describe("Buku admins manage organisations and access (T08)", () => {
  beforeEach(resetDb);

  it("creates a trial firm and a company (with its one client), each with a logged grant", async () => {
    const admin = await ops();
    const now = new Date("2026-10-10T03:00:00Z");
    const firm = await createOrganisation(db, admin.id, { name: "KAP Coba", kind: "KANTOR_AKUNTAN", grant: { kind: "TRIAL", endsOn: "2026-10-24" }, seatLimit: 5 }, now);
    expect(await stateAt(firm.id, "2026-10-24T16:00:00Z")).toBe("ACTIVE");
    expect(await stateAt(firm.id, "2026-10-24T17:00:00Z")).toBe("READ_ONLY");
    expect((await db.firm.findUniqueOrThrow({ where: { id: firm.id } })).seatLimit).toBe(5);
    expect(await db.client.count({ where: { firmId: firm.id } })).toBe(0);

    const company = await createOrganisation(db, admin.id, { name: "PT Maju Jaya", kind: "PERUSAHAAN", grant: { kind: "TRIAL", endsOn: "2026-10-24" } }, now);
    const books = await db.client.findMany({ where: { firmId: company.id }, include: { entities: true } });
    expect(books.map((c) => [c.name, c.entities.map((e) => e.name)])).toEqual([["PT Maju Jaya", ["PT Maju Jaya"]]]);
    expect(await db.platformAuditEvent.count({ where: { kind: "ORG_CREATED", adminId: admin.id } })).toBe(2);
    expect(await db.auditEvent.count()).toBe(0); // nothing in any tenant's Riwayat
    await expect(createOrganisation(db, admin.id, { name: " ", kind: "KANTOR_AKUNTAN", grant: { kind: "TRIAL", endsOn: "2026-10-24" } }, now)).rejects.toBeInstanceOf(AccessAdminError);
    await expect(createOrganisation(db, admin.id, { name: "X", kind: "KANTOR_AKUNTAN", grant: { kind: "TRIAL", endsOn: "2026-10-01" } }, now)).rejects.toThrow("harus sesudah");
  });

  it("grant → active, end → read-only, extend → active again, revoke → closed, suspend and reinstate", async () => {
    const admin = await ops();
    const firm = await createOrganisation(db, admin.id, { name: "KAP Siklus", kind: "KANTOR_AKUNTAN", grant: { kind: "TRIAL", endsOn: "2026-10-14" } }, new Date("2026-10-01T00:00:00Z"));
    const [trial] = await db.accessGrant.findMany({ where: { firmId: firm.id } });
    expect(await stateAt(firm.id, "2026-10-20T00:00:00Z")).toBe("READ_ONLY");
    await extendGrant(db, admin.id, trial.id, "2026-10-31");
    expect(await stateAt(firm.id, "2026-10-20T00:00:00Z")).toBe("ACTIVE");
    const paid = await grantAccess(db, admin.id, firm.id, { kind: "PAID", startsOn: "2026-11-01", endsOn: "2027-10-31", note: "Paket tahunan" });
    expect(await stateAt(firm.id, "2027-01-15T00:00:00Z")).toBe("ACTIVE");
    await expect(revokeGrant(db, admin.id, paid.id, "x")).rejects.toThrow("min. 5");
    await revokeGrant(db, admin.id, paid.id, "Salah input");
    expect(await stateAt(firm.id, "2027-01-15T00:00:00Z")).toBe("READ_ONLY");
    await revokeGrant(db, admin.id, trial.id, "Penyalahgunaan", new Date("2026-10-15T00:00:00Z")); // a fixed day, not the clock
    expect(await stateAt(firm.id, "2026-10-20T00:00:00Z")).toBe("NONE");
    await expect(extendGrant(db, admin.id, trial.id, "2026-12-31")).rejects.toThrow("sudah dicabut");

    const open = await grantAccess(db, admin.id, firm.id, { kind: "COMP", endsOn: null });
    expect(open.endsAt).toBeNull();
    await setSuspended(db, admin.id, firm.id, true, "Tagihan belum dibayar");
    expect(await stateAt(firm.id, new Date(Date.now() + 1000).toISOString())).toBe("NONE");
    await setSuspended(db, admin.id, firm.id, false, "");
    expect(await stateAt(firm.id, new Date(Date.now() + 1000).toISOString())).toBe("ACTIVE");

    const kinds = (await db.platformAuditEvent.findMany({ where: { firmId: firm.id }, orderBy: { createdAt: "asc" } })).map((e) => e.kind);
    expect(kinds).toEqual(["ORG_CREATED", "GRANT_EXTENDED", "GRANT", "GRANT_REVOKED", "GRANT_REVOKED", "GRANT", "SUSPENDED", "REINSTATED"]);
    expect(await db.auditEvent.count()).toBe(0);
  });

  it("sets and clears limits; the CLI acts without an admin row", async () => {
    const firm = await createOrganisation(db, null, { name: "KAP CLI", kind: "KANTOR_AKUNTAN", grant: { kind: "COMP", endsOn: null } });
    await setLimits(db, null, firm.id, { seatLimit: 3, aiMonthlyTokenBudget: 50_000 });
    expect(await db.firm.findUniqueOrThrow({ where: { id: firm.id } })).toMatchObject({ seatLimit: 3, aiMonthlyTokenBudget: 50_000 });
    await setLimits(db, null, firm.id, { seatLimit: null, aiMonthlyTokenBudget: null });
    await expect(setLimits(db, null, firm.id, { seatLimit: 0, aiMonthlyTokenBudget: null })).rejects.toThrow("minimal 1");
    expect(await db.platformAuditEvent.count({ where: { firmId: firm.id, adminId: null } })).toBe(3);
  });
});
