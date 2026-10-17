import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";
import { createClient, createFirm } from "@/lib/setup";
import { listEvents } from "@/lib/audit";
import { AMOUNT_MESSAGE, DEFAULT_AUTOMATION, lastAutomationChange, PERCENT_MESSAGE, readAutomation, saveAutomation, type AutomationInput } from "@/lib/settings/automation";

/** Otomasi kantor (cycle 2026-10-17-otomasi): the firm's dial and flux thresholds, saved with one Riwayat event per client. */
const DEFAULTS: AutomationInput = { transfer: true, rules: true, memory: true, cap: "", fluxFloor: "", fluxPercent: "50" };

describe("Otomasi kantor settings", () => {
  beforeEach(resetDb);

  it("a firm starts with the defaults that equal the behaviour before the dial: every source posts, no cap, 50 %", async () => {
    const firm = await db.$transaction((tx) => createFirm(tx, "KAP Baru"));
    expect(await readAutomation(db, firm.id)).toEqual(DEFAULT_AUTOMATION);
    expect(DEFAULT_AUTOMATION).toEqual({ transfer: true, rules: true, memory: true, cap: null, fluxFloor: null, fluxPercent: 50 });
  });

  it("saves the columns and writes one AUTOMATION event, before and after, into every client's Riwayat", async () => {
    const g = await makeGroup();
    const second = await db.$transaction((tx) => createClient(tx, g.firm.id, { name: "Klien Dua", industry: "retail", entities: [{ name: "PT Dua Jaya", shortName: "Dua", kind: "PT", banks: [] }] }));
    const admin = await addMember(g.firm.id, "ADMIN", { name: "Sari Admin" });
    expect(await lastAutomationChange(db, g.firm.id)).toBeNull();

    const r = await saveAutomation(db, { firmId: g.firm.id, settings: { ...DEFAULTS, rules: false, cap: "Rp 100.000.000" }, actorId: admin.id });
    expect(r).toEqual({ ok: true, changed: true });
    expect(await readAutomation(db, g.firm.id)).toEqual({ ...DEFAULT_AUTOMATION, rules: false, cap: 100_000_000n });

    for (const clientId of [g.client.id, second.client.id]) {
      const events = await listEvents(db, clientId, { kind: "AUTOMATION" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        label: "Otomasi kantor",
        actor: "Sari Admin",
        summary: "Aturan: langsung dicatat → ke Review; Batas nominal: tanpa batas → Rp 100.000.000",
        before: { transfer: true, rules: true, memory: true, cap: null, fluxFloor: null, fluxPercent: 50 },
        after: { transfer: true, rules: false, memory: true, cap: "100000000", fluxFloor: null, fluxPercent: 50 },
      });
    }
    expect(await lastAutomationChange(db, g.firm.id)).toMatchObject({ actor: "Sari Admin" });

    // Thresholds read in the same diff, and the second save's "before" is the first save's "after".
    await saveAutomation(db, { firmId: g.firm.id, settings: { ...DEFAULTS, rules: false, cap: "100.000.000", fluxFloor: "6.000.000", fluxPercent: "60" }, actorId: admin.id });
    const [latest] = await listEvents(db, g.client.id, { kind: "AUTOMATION" });
    expect(latest.summary).toBe("Selisih minimal: tanpa minimum → Rp 6.000.000; Perubahan minimal: 50 % → 60 %");
    expect(latest.before).toMatchObject({ rules: false, cap: "100000000" });
  });

  it("a save that changes nothing writes nothing", async () => {
    const g = await makeGroup();
    expect(await saveAutomation(db, { firmId: g.firm.id, settings: DEFAULTS })).toEqual({ ok: true, changed: false });
    expect(await listEvents(db, g.client.id, { kind: "AUTOMATION" })).toHaveLength(0);
    expect(await lastAutomationChange(db, g.firm.id)).toBeNull();
  });

  it("refuses invalid input with a field message and saves nothing, no event", async () => {
    const g = await makeGroup();
    for (const bad of ["abc", "0", "-5", "1234567890123456"]) {
      expect(await saveAutomation(db, { firmId: g.firm.id, settings: { ...DEFAULTS, cap: bad } })).toEqual({ ok: false, errors: { cap: AMOUNT_MESSAGE } });
      expect(await saveAutomation(db, { firmId: g.firm.id, settings: { ...DEFAULTS, fluxFloor: bad } })).toEqual({ ok: false, errors: { fluxFloor: AMOUNT_MESSAGE } });
    }
    for (const bad of ["0", "", "1001", "12.5", "abc"]) {
      expect(await saveAutomation(db, { firmId: g.firm.id, settings: { ...DEFAULTS, rules: false, fluxPercent: bad } })).toEqual({ ok: false, errors: { fluxPercent: PERCENT_MESSAGE } });
    }
    expect(AMOUNT_MESSAGE).toBe("Isi nominal Rupiah lebih dari 0, atau kosongkan.");
    expect(await readAutomation(db, g.firm.id)).toEqual(DEFAULT_AUTOMATION);
    expect(await listEvents(db, g.client.id, { kind: "AUTOMATION" })).toHaveLength(0);
    // The boundaries are accepted: 15 digits, 1 % and 1000 %.
    expect(await saveAutomation(db, { firmId: g.firm.id, settings: { ...DEFAULTS, cap: "999999999999999", fluxPercent: "1000" } })).toEqual({ ok: true, changed: true });
    expect(await saveAutomation(db, { firmId: g.firm.id, settings: { ...DEFAULTS, fluxPercent: "1" } })).toEqual({ ok: true, changed: true });
  });

  it("the database refuses a cap or floor of zero and a percent outside 1–1000, whatever the app sends", async () => {
    const g = await makeGroup();
    await expect(db.firm.update({ where: { id: g.firm.id }, data: { autoPostCap: 0n } })).rejects.toThrow();
    await expect(db.firm.update({ where: { id: g.firm.id }, data: { fluxFloor: 0n } })).rejects.toThrow();
    await expect(db.firm.update({ where: { id: g.firm.id }, data: { fluxPercent: 0 } })).rejects.toThrow();
    await expect(db.firm.update({ where: { id: g.firm.id }, data: { fluxPercent: 1001 } })).rejects.toThrow();
  });
});
