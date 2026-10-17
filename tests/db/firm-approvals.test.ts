import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";
import { createClient, createFirm } from "@/lib/setup";
import { listEvents } from "@/lib/audit";
import { AMOUNT_MESSAGE } from "@/lib/settings/automation";
import { activeAdminCount, DEFAULT_APPROVALS, lastApprovalsChange, readApprovals, saveApprovals, type ApprovalsInput } from "@/lib/settings/approvals";

/** Persetujuan kedua (cycle 2026-10-18-persetujuan-kedua): the firm card, saved with one Riwayat event per client. */
const OFF: ApprovalsInput = { manual: false, manualAbove: "", aiDraft: false, aiDraftAbove: "", reopen: false };

describe("Persetujuan kedua settings", () => {
  beforeEach(resetDb);

  it("a firm starts with nothing routed: the behaviour before the card", async () => {
    const firm = await db.$transaction((tx) => createFirm(tx, "KAP Baru"));
    expect(await readApprovals(db, firm.id)).toEqual(DEFAULT_APPROVALS);
    expect(DEFAULT_APPROVALS).toEqual({ manual: false, manualAbove: null, aiDraft: false, aiDraftAbove: null, reopen: false });
  });

  it("saves the columns and writes one APPROVAL event, before and after (amounts as strings), into every client's Riwayat", async () => {
    const g = await makeGroup();
    const second = await db.$transaction((tx) => createClient(tx, g.firm.id, { name: "Klien Dua", industry: "retail", entities: [{ name: "PT Dua Jaya", shortName: "Dua", kind: "PT", banks: [] }] }));
    const admin = await addMember(g.firm.id, "ADMIN", { name: "Sari Admin" });
    expect(await lastApprovalsChange(db, g.firm.id)).toBeNull();

    const r = await saveApprovals(db, { firmId: g.firm.id, settings: { manual: true, manualAbove: "Rp 100.000.000", aiDraft: true, aiDraftAbove: "", reopen: true }, actorId: admin.id });
    expect(r).toEqual({ ok: true, changed: true });
    expect(await readApprovals(db, g.firm.id)).toEqual({ manual: true, manualAbove: 100_000_000n, aiDraft: true, aiDraftAbove: null, reopen: true });
    for (const clientId of [g.client.id, second.client.id]) {
      const events = await listEvents(db, clientId, { kind: "APPROVAL" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        label: "Persetujuan kedua",
        actor: "Sari Admin",
        summary: "Jurnal manual: tanpa persetujuan → di atas Rp 100.000.000; Draf AI: tanpa persetujuan → semua nominal; Buka kembali bulan: langsung oleh admin → dikonfirmasi admin kedua",
        before: { manual: false, manualAbove: null, aiDraft: false, aiDraftAbove: null, reopen: false },
        after: { manual: true, manualAbove: "100000000", aiDraft: true, aiDraftAbove: null, reopen: true },
      });
    }
    expect(await lastApprovalsChange(db, g.firm.id)).toMatchObject({ actor: "Sari Admin" });
  });

  it("a save that changes nothing writes nothing; a switched-off source keeps no threshold", async () => {
    const g = await makeGroup();
    expect(await saveApprovals(db, { firmId: g.firm.id, settings: OFF })).toEqual({ ok: true, changed: false });
    // Off with a typed threshold: the input is ignored (and not validated), so nothing changes.
    expect(await saveApprovals(db, { firmId: g.firm.id, settings: { ...OFF, manualAbove: "abc" } })).toEqual({ ok: true, changed: false });
    await saveApprovals(db, { firmId: g.firm.id, settings: { ...OFF, manual: true, manualAbove: "100000000" } });
    expect(await saveApprovals(db, { firmId: g.firm.id, settings: { ...OFF, manual: true, manualAbove: "100.000.000" } })).toEqual({ ok: true, changed: false });
    await saveApprovals(db, { firmId: g.firm.id, settings: { ...OFF, manualAbove: "100.000.000" } });
    expect(await readApprovals(db, g.firm.id)).toEqual(DEFAULT_APPROVALS);
    expect((await listEvents(db, g.client.id, { kind: "APPROVAL" })).map((e) => e.summary)).toEqual(["Jurnal manual: di atas Rp 100.000.000 → tanpa persetujuan", "Jurnal manual: tanpa persetujuan → di atas Rp 100.000.000"]);
  });

  it("refuses an invalid threshold of a switched-on source with the field message and saves nothing", async () => {
    const g = await makeGroup();
    expect(await saveApprovals(db, { firmId: g.firm.id, settings: { ...OFF, manual: true, manualAbove: "abc", aiDraft: true, aiDraftAbove: "0" } })).toEqual({ ok: false, errors: { manualAbove: AMOUNT_MESSAGE, aiDraftAbove: AMOUNT_MESSAGE } });
    expect(AMOUNT_MESSAGE).toBe("Isi nominal Rupiah lebih dari 0, atau kosongkan.");
    expect(await readApprovals(db, g.firm.id)).toEqual(DEFAULT_APPROVALS);
    expect(await listEvents(db, g.client.id, { kind: "APPROVAL" })).toHaveLength(0);
  });

  it("the database refuses a threshold of zero or less", async () => {
    const g = await makeGroup();
    await expect(db.firm.update({ where: { id: g.firm.id }, data: { approvalManualAbove: 0n } })).rejects.toThrow();
    await expect(db.firm.update({ where: { id: g.firm.id }, data: { approvalAiDraftAbove: -5n } })).rejects.toThrow();
  });

  it("counts active Pemilik and Admin members only (the card's one-admin warning)", async () => {
    const g = await makeGroup();
    await addMember(g.firm.id, "OWNER");
    await addMember(g.firm.id, "AKUNTAN");
    expect(await activeAdminCount(db, g.firm.id)).toBe(1);
    const admin = await addMember(g.firm.id, "ADMIN");
    expect(await activeAdminCount(db, g.firm.id)).toBe(2);
    await db.firmMember.update({ where: { id: admin.id }, data: { disabled: true } });
    expect(await activeAdminCount(db, g.firm.id)).toBe(1);
  });
});
