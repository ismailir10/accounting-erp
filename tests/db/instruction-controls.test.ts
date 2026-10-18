import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { importStatement } from "@/lib/import/pipeline";
import { closeReadiness, runControls, type Control } from "@/lib/controls";
import { saveControlNote } from "@/lib/controls/ack";
import { gather } from "@/lib/controls/ai-review";
import { parseInstruction, toJson } from "@/lib/instructions/compile";
import { approveInstruction, scopeCharts, turnOffInstruction } from "@/lib/instructions/store";

/**
 * *Tandai* controls (cycle 2026-10-18-instruksi-kantor, accounting-rules 22d): one REVIEW control per entity in every open month, listing
 * the month's bank lines above (or at least) the minimum; PASS with none; a note clears it until the list changes; never in a locked month.
 */
type G = Awaited<ReturnType<typeof makeGroup>>;
const csv = (opening: string, start: string, ...rows: string[]) => Buffer.from(["Tanggal;Keterangan;Debet;Kredit;Saldo", `${start};SALDO AWAL;;;${opening}`, ...rows, ""].join("\n"));
const STATEMENT = csv(
  "500.000.000,00",
  "01/07/2026",
  "10/07/2026;BIAYA ADM;15.000,00;0,00;499.985.000,00",
  "05/08/2026;TRSF E-BANKING DB PT ANGKASA RAYA;25.000.000,00;0,00;474.985.000,00",
  "06/08/2026;TRSF E-BANKING DB PT BUMI SENTOSA;10.000.000,00;0,00;464.985.000,00",
  "07/08/2026;BIAYA ADM;15.000,00;0,00;464.970.000,00",
  "08/08/2026;TRSF E-BANKING CR CV CAHAYA;0,00;30.000.000,00;494.970.000,00",
  "09/08/2026;GOJEK;50.000,00;0,00;494.920.000,00",
  "10/08/2026;GRAB;40.000,00;0,00;494.880.000,00",
);
const LATER = csv("494.880.000,00", "20/08/2026", "21/08/2026;TRSF E-BANKING DB PT CEMARA;12.000.000,00;0,00;482.880.000,00");

async function approve(g: G, sentence: string) {
  const r = parseInstruction(sentence, (await scopeCharts(db, { firmId: g.firm.id, clientId: g.client.id })).accounts);
  if (!r.ok) throw new Error(r.error);
  const out = await approveInstruction(db, { firmId: g.firm.id, clientId: g.client.id, sentence, fields: toJson(r.draft) });
  if (!out.ok) throw new Error(out.error);
  return out.id;
}
const instr = (cs: Control[]) => cs.filter((c) => c.key.startsWith("instr:"));
const setup = async () => {
  const g = await makeGroup();
  await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca.csv", data: STATEMENT, provider: null });
  return g;
};

describe("Tandai controls", () => {
  beforeEach(resetDb);
  afterEach(() => vi.unstubAllGlobals());

  it("pengeluaran > Rp10 jt: one REVIEW control per entity listing the lines above, not the one of exactly Rp 10.000.000; PASS with none", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const g = await setup();
    const id = await approve(g, "tandai pengeluaran > Rp10 jt");
    const aug = await runControls(db, g.client.id, 2026, 8);
    expect(instr(aug)).toEqual([
      { key: `instr:${g.pt.entity.id}:${id}`, title: "Pengeluaran di atas Rp 10.000.000", scope: "PT Uji", status: "REVIEW", detail: "5 Agu 2026 · TRSF E-BANKING DB PT ANGKASA RAYA · Rp 25.000.000", ack: undefined },
      { key: `instr:${g.owner.entity.id}:${id}`, title: "Pengeluaran di atas Rp 10.000.000", scope: "Andi", status: "PASS", detail: "Tidak ada pengeluaran di atas Rp 10.000.000", ack: undefined },
    ]);
    expect(instr(await runControls(db, g.client.id, 2026, 7)).map((c) => [c.status, c.detail])).toEqual([["PASS", "Tidak ada pengeluaran di atas Rp 10.000.000"], ["PASS", "Tidak ada pengeluaran di atas Rp 10.000.000"]]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("minimal Rp10 jt lists the line of exactly Rp 10.000.000 too; a keyword narrows it; more than five lines say +N lainnya", async () => {
    const g = await setup();
    await approve(g, "tandai pengeluaran minimal Rp10 jt");
    await approve(g, "cek penerimaan CV CAHAYA di atas 1 jt");
    await approve(g, "tandai mutasi minimal Rp 1");
    const [atLeast, cahaya, all] = instr(await runControls(db, g.client.id, 2026, 8)).filter((c) => c.scope === "PT Uji");
    expect(atLeast).toMatchObject({ title: "Pengeluaran minimal Rp 10.000.000", detail: "5 Agu 2026 · TRSF E-BANKING DB PT ANGKASA RAYA · Rp 25.000.000; 6 Agu 2026 · TRSF E-BANKING DB PT BUMI SENTOSA · Rp 10.000.000" });
    expect(cahaya).toMatchObject({ title: 'Penerimaan di atas Rp 1.000.000 yang memuat "CV CAHAYA"', status: "REVIEW", detail: "8 Agu 2026 · TRSF E-BANKING CR CV CAHAYA · Rp 30.000.000" });
    expect(all.detail).toMatch(/^5 Agu 2026 · .*; \+1 lainnya$/);
    expect(all.detail.split("; ")).toHaveLength(6);
  });

  it("a note clears it while the list is unchanged; a new line above the minimum makes the note stale", async () => {
    const g = await setup();
    await approve(g, "tandai pengeluaran > Rp10 jt");
    const control = instr(await runControls(db, g.client.id, 2026, 8))[0];
    const period = await db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 8 } }, create: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 8 }, update: {} });
    await saveControlNote(db, { clientId: g.client.id, periodId: period.id, year: 2026, month: 8, controlKey: control.key, title: control.title, note: "Kontrak sewa gudang, sudah dicek", detail: control.detail });
    const noted = instr(await runControls(db, g.client.id, 2026, 8))[0];
    expect(noted).toMatchObject({ status: "REVIEW", ack: "Kontrak sewa gudang, sudah dicek" });
    expect(closeReadiness([noted], []).unacked).toEqual([]);
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "later.csv", data: LATER, provider: null });
    const stale = instr(await runControls(db, g.client.id, 2026, 8))[0];
    expect(stale).toMatchObject({ ack: undefined, staleAck: "Kontrak sewa gudang, sudah dicek", detail: expect.stringContaining("PT CEMARA") });
    expect(closeReadiness([stale], []).unacked).toHaveLength(1);
  });

  it("a locked month has no such control (reopening shows it); Matikan removes it from open months and keeps its old note", async () => {
    const g = await setup();
    const id = await approve(g, "tandai pengeluaran > Rp10 jt");
    await db.period.update({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 8 } }, data: { status: "LOCKED", lockedAt: new Date() } });
    expect(instr(await runControls(db, g.client.id, 2026, 8))).toEqual([]);
    const period = await db.period.update({ where: { clientId_year_month: { clientId: g.client.id, year: 2026, month: 8 } }, data: { status: "OPEN", lockedAt: null } });
    const control = instr(await runControls(db, g.client.id, 2026, 8))[0];
    expect(control.status).toBe("REVIEW");
    await saveControlNote(db, { clientId: g.client.id, periodId: period.id, year: 2026, month: 8, controlKey: control.key, note: "Dicek", detail: control.detail });
    expect(await turnOffInstruction(db, { firmId: g.firm.id, id })).toEqual({ ok: true });
    expect(instr(await runControls(db, g.client.id, 2026, 8))).toEqual([]);
    expect(await db.controlAck.count({ where: { controlKey: control.key } })).toBe(1);
  });

  it("the AI close review sends the lines it lists, like any flagged control's rows", async () => {
    const g = await setup();
    const id = await approve(g, "tandai pengeluaran > Rp10 jt");
    const g8 = await gather(db, g.client.id, 2026, 8);
    const sent = g8.input.controls.find((c) => c.key === `instr:${g.pt.entity.id}:${id}`)!;
    const angkasa = await db.bankTransaction.findFirstOrThrow({ where: { description: { contains: "ANGKASA" } } });
    expect(sent.rows).toEqual([expect.objectContaining({ id: angkasa.id, text: "TRSF E-BANKING DB PT ANGKASA RAYA", amount: "-Rp 25.000.000" })]);
    // A PASS control is not flagged, so it sends nothing.
    expect(g8.input.controls.some((c) => c.key === `instr:${g.owner.entity.id}:${id}`)).toBe(false);
  });
});
