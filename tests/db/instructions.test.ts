import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import type { Prisma } from "@/lib/generated/prisma/client";
import { importStatement } from "@/lib/import/pipeline";
import { createClient } from "@/lib/setup";
import { listEvents } from "@/lib/audit";
import { parseInstruction, toJson, type InstructionDraft } from "@/lib/instructions/compile";
import { approveInstruction, scopeCharts, turnOffInstruction } from "@/lib/instructions/store";
import { previewInstruction } from "@/lib/instructions/preview";
import { addMember } from "../members";

/** Instruksi kantor (cycle 2026-10-18-instruksi-kantor): the table's invariants and the instruction lifecycle. */
type G = Awaited<ReturnType<typeof makeGroup>>;

describe("Instruction table CHECKs", () => {
  beforeEach(resetDb);
  const base = (g: G): Prisma.InstructionUncheckedCreateInput => ({ firmId: g.firm.id, sentence: "biaya admin bank selalu 6190", kind: "ACCOUNT", origin: "PARSER", pattern: "BIAYA ADM", direction: "OUT", accountCode: "6190" });
  const refused = (data: Prisma.InstructionUncheckedCreateInput) => expect(db.instruction.create({ data })).rejects.toThrow(/check/i);

  it("accepts each kind in its compiled shape", async () => {
    const g = await makeGroup();
    await db.instruction.create({ data: base(g) });
    await db.instruction.create({ data: { ...base(g), kind: "FLAG", pattern: null, accountCode: null, minAmount: 10_000_000n, sentence: "tandai pengeluaran > Rp10 jt" } });
    await db.instruction.create({ data: { ...base(g), kind: "HOLD", pattern: "PT MAJU JAYA", accountCode: null, direction: null, clientId: g.client.id, sentence: "PT MAJU JAYA selalu ke Review" } });
    await db.instruction.create({ data: { ...base(g), kind: "HOLD", pattern: "PT MAJU JAYA", accountCode: null, minAmount: 1n, inclusive: true } });
    expect(await db.instruction.count()).toBe(4);
  });

  it("refuses a shape its kind does not have", async () => {
    const g = await makeGroup();
    await refused({ ...base(g), pattern: null });
    await refused({ ...base(g), accountCode: null });
    await refused({ ...base(g), minAmount: 5n });
    await refused({ ...base(g), kind: "FLAG", accountCode: null });
    await refused({ ...base(g), kind: "FLAG", minAmount: 5n });
    await refused({ ...base(g), kind: "FLAG", accountCode: null, taxTag: "PPH_23", minAmount: 5n });
    await refused({ ...base(g), kind: "HOLD", pattern: null, accountCode: null });
    await refused({ ...base(g), kind: "HOLD" });
  });

  it("refuses a keyword outside 3–60 upper-case characters, an amount of zero, a blank or long sentence, and OFF without its time", async () => {
    const g = await makeGroup();
    await refused({ ...base(g), pattern: "AB" });
    await refused({ ...base(g), pattern: "X".repeat(61) });
    await refused({ ...base(g), pattern: "biaya adm" });
    await refused({ ...base(g), kind: "FLAG", pattern: null, accountCode: null, minAmount: 0n });
    await refused({ ...base(g), sentence: "" });
    await refused({ ...base(g), sentence: "   " });
    await refused({ ...base(g), sentence: "x".repeat(301) });
    await refused({ ...base(g), status: "OFF" });
    await refused({ ...base(g), offAt: new Date() });
    await db.instruction.create({ data: { ...base(g), status: "OFF", offAt: new Date() } });
  });

  it("a rule points at one instruction, and the instruction cannot go while its rule exists", async () => {
    const g = await makeGroup();
    const i = await db.instruction.create({ data: base(g) });
    await db.rule.create({ data: { firmId: g.firm.id, pattern: "BIAYA ADM", direction: "OUT", accountCode: "6190", priority: 5, source: "INSTRUKSI", instructionId: i.id } });
    await expect(db.rule.create({ data: { firmId: g.firm.id, pattern: "BIAYA ADM", direction: "OUT", accountCode: "6190", priority: 5, source: "INSTRUKSI", instructionId: i.id } })).rejects.toThrow();
    await expect(db.instruction.delete({ where: { id: i.id } })).rejects.toThrow();
  });
});

// ---- preview, approve, Matikan -------------------------------------------------------------------------------------------------

const csv = (...rows: string[]) => Buffer.from(["Tanggal;Keterangan;Debet;Kredit;Saldo", "01/06/2026;SALDO AWAL;;;100.000.000,00", ...rows, ""].join("\n"));
/** Four months of bank fees as BCA prints them (BIAYA ADM, BIAYA ADM BULANAN), and one supplier payment. */
const FEES = csv(
  "30/06/2026;BIAYA ADM;15.000,00;0,00;99.985.000,00",
  "31/07/2026;BIAYA ADM;15.000,00;0,00;99.970.000,00",
  "31/07/2026;BIAYA ADM BULANAN;10.000,00;0,00;99.960.000,00",
  "05/08/2026;TRSF E-BANKING DB TOKO MAJU;2.000.000,00;0,00;97.960.000,00",
  "31/08/2026;BIAYA ADM;15.000,00;0,00;97.945.000,00",
  "30/09/2026;BIAYA ADM BULANAN;10.000,00;0,00;97.935.000,00",
  "30/09/2026;BIAYA ADM;15.000,00;0,00;97.920.000,00",
);

async function setup() {
  const g = await makeGroup();
  await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca.csv", data: FEES, provider: null });
  // A second client whose chart has no 6190: a firm-wide Aturan akun to 6190 skips it.
  const other = await db.$transaction((tx) => createClient(tx, g.firm.id, { name: "Klien Tanpa 6190", industry: "", entities: [{ name: "PT Lain", shortName: "Lain", kind: "PT", banks: [{ bank: "BCA", number: "9999999999", label: "BCA" }] }] }));
  await db.account.deleteMany({ where: { clientId: other.client.id, code: "6190" } });
  return { ...g, other: other.client };
}
type S = Awaited<ReturnType<typeof setup>>;
const accountsOf = async (g: S) => (await scopeCharts(db, { firmId: g.firm.id, clientId: null })).accounts;
/** Every table a preview could write to, counted. */
const counts = async () => Promise.all([db.instruction.count(), db.rule.count(), db.auditEvent.count(), db.bankTransaction.count(), db.journalEntry.count(), db.evidenceAiCache.count(), db.aiUsage.count()]);
const parsed = async (g: S, sentence: string) => {
  const r = parseInstruction(sentence, await accountsOf(g));
  if (!r.ok) throw new Error(r.error);
  return r;
};
const fields = (d: InstructionDraft) => toJson(d);

describe("preview (read-only)", () => {
  beforeEach(resetDb);

  it("finds nothing for the typed words and offers the bank's abbreviation; with it, counts the latest three months like a direct query and writes nothing", async () => {
    const g = await setup();
    const before = await counts();
    const typed = await parsed(g, "biaya admin bank selalu 6190");
    const p1 = await previewInstruction(db, { firmId: g.firm.id, clientId: null, draft: typed.draft, notes: typed.notes });
    expect(p1.matched).toBe(0);
    expect(p1.notes).toEqual(["Arah: uang keluar, karena 6190 akun beban.", "Dilewati di 1 klien karena bagan akunnya tidak memuat 6190: Klien Tanpa 6190.", 'Belum ada mutasi yang memuat "BIAYA ADMIN BANK".']);
    expect(p1.hints).toEqual(["BIAYA ADM"]);

    const p2 = await previewInstruction(db, { firmId: g.firm.id, clientId: null, draft: { ...typed.draft, pattern: "BIAYA ADM" } });
    expect(p2.sentence).toBe('Mutasi keluar yang keterangannya memuat "BIAYA ADM" → 6190 Beban Umum Lain-lain, sebelum aturan kantor lain.');
    // The same lines a direct query finds in July–September (June is the fourth month back).
    const direct = await db.bankTransaction.findMany({ where: { entityId: g.pt.entity.id, description: { contains: "BIAYA ADM" }, date: { gte: new Date("2026-07-01") } } });
    expect(p2.matched).toBe(direct.length);
    expect(p2.clients).toEqual([{ id: g.client.id, name: "Grup Uji", months: [{ label: "Juli 2026", count: 2 }, { label: "Agustus 2026", count: 1 }, { label: "September 2026", count: 2 }], total: 5 }]);
    expect(p2.lines.map((l) => [l.date, l.description, l.amount, l.account])).toEqual([
      ["2026-09-30", "BIAYA ADM BULANAN", "-10000", "7100"],
      ["2026-09-30", "BIAYA ADM", "-15000", "7100"],
      ["2026-08-31", "BIAYA ADM", "-15000", "7100"],
      ["2026-07-31", "BIAYA ADM", "-15000", "7100"],
      ["2026-07-31", "BIAYA ADM BULANAN", "-10000", "7100"],
    ]);
    expect(p2.notes).toEqual([
      "5 baris sekarang di akun lain (7100, aturan kantor ADM BULANAN / aturan kantor BIAYA ADM).",
      "Dilewati di 1 klien karena bagan akunnya tidak memuat 6190: Klien Tanpa 6190.",
    ]);
    expect(p2.blocked).toBeNull();
    expect(await counts()).toEqual(before);
  });

  it("counts transfer lines apart, and a client rule on the same text keeps its lines", async () => {
    const g = await setup();
    const fee = await db.bankTransaction.findFirstOrThrow({ where: { description: "BIAYA ADM", date: new Date("2026-08-31") } });
    await db.bankTransaction.update({ where: { id: fee.id }, data: { method: "TRANSFER" } });
    await db.rule.create({ data: { firmId: g.firm.id, clientId: g.client.id, pattern: "BIAYA ADM BULANAN", direction: "OUT", accountCode: "7100", priority: 60, source: "USER" } });
    const p = await previewInstruction(db, { firmId: g.firm.id, clientId: null, draft: (await parsed(g, '"BIAYA ADM" selalu 6190')).draft });
    expect(p.matched).toBe(2);
    expect(p.notes).toEqual([
      "2 baris sekarang di akun lain (7100, aturan kantor BIAYA ADM).",
      "2 baris tetap mengikuti aturan klien BIAYA ADM BULANAN.",
      "1 baris tidak terpengaruh, transfer.",
      "Dilewati di 1 klien karena bagan akunnya tidak memuat 6190: Klien Tanpa 6190.",
    ]);
  });

  it("Tahan: matched lines and how many posted directly would now wait; Tandai: the lines the control would list", async () => {
    const g = await setup();
    const hold = await previewInstruction(db, { firmId: g.firm.id, clientId: g.client.id, draft: (await parsed(g, "BIAYA ADM selalu ke Review")).draft });
    expect(hold.matched).toBe(5);
    expect(hold.notes).toEqual(["5 di antaranya dicatat langsung, dan dengan instruksi ini akan menunggu di Review."]);
    const flag = await previewInstruction(db, { firmId: g.firm.id, clientId: g.client.id, draft: (await parsed(g, "tandai pengeluaran di atas Rp 12.000")).draft });
    expect(flag.clients[0].months.map((m) => m.count)).toEqual([1, 2, 1]);
    expect(flag.lines.map((l) => l.description)).toEqual(["BIAYA ADM", "BIAYA ADM", "TRSF E-BANKING DB TOKO MAJU", "BIAYA ADM"]);
    expect(flag.matched).toBe(4);
  });
});

describe("approve and Matikan", () => {
  beforeEach(resetDb);

  it("an Aturan akun for Semua klien: one Rule (INSTRUKSI, priority 5, instructionId), an event in every client, origin decided by the server", async () => {
    const g = await setup();
    const actor = await addMember(g.firm.id, "ADMIN", { name: "Bu Admin" });
    const typed = await parsed(g, "biaya admin bank selalu 6190");
    const r = await approveInstruction(db, { firmId: g.firm.id, clientId: null, sentence: "biaya admin bank selalu 6190", fields: fields({ ...typed.draft, pattern: "BIAYA ADM" }), actorId: actor.id });
    expect(r).toMatchObject({ ok: true, origin: "EDITED" });
    const id = (r as { id: string }).id;
    const rule = await db.rule.findFirstOrThrow({ where: { instructionId: id } });
    expect(rule).toMatchObject({ firmId: g.firm.id, clientId: null, pattern: "BIAYA ADM", direction: "OUT", accountCode: "6190", taxTag: null, priority: 5, source: "INSTRUKSI" });
    expect(await db.instruction.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "ACTIVE", origin: "EDITED", approvedById: actor.id, kind: "ACCOUNT", sentence: "biaya admin bank selalu 6190" });
    for (const c of [g.client.id, g.other.id]) {
      const events = await listEvents(db, c, { kind: "INSTRUCTION" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        label: "Instruksi kantor",
        actor: "Bu Admin",
        summary: 'Disetujui: "biaya admin bank selalu 6190" → Aturan akun: keluar, memuat "BIAYA ADM" → 6190',
        before: { status: null },
        after: { sentence: "biaya admin bank selalu 6190", kind: "ACCOUNT", pattern: "BIAYA ADM", direction: "OUT", accountCode: "6190", taxTag: null, minAmount: null, inclusive: false, scope: "Semua klien", clientId: null, origin: "EDITED", status: "ACTIVE" },
      });
    }
    // The same keyword and direction again, with any account: refused, nothing stored.
    const again = await approveInstruction(db, { firmId: g.firm.id, clientId: null, sentence: '"BIAYA ADM" selalu 7100', fields: fields({ ...typed.draft, pattern: "BIAYA ADM", accountCode: "7100" }) });
    expect(again).toEqual({ ok: false, error: 'Sudah ada instruksi aktif untuk kata kunci ini: "biaya admin bank selalu 6190". Matikan dulu bila ingin menggantinya.' });
    expect(await db.instruction.count()).toBe(1);
    expect(await db.rule.count({ where: { source: "INSTRUKSI" } })).toBe(1);
    // The preview says the same before Setujui.
    expect((await previewInstruction(db, { firmId: g.firm.id, clientId: null, draft: { ...typed.draft, pattern: "BIAYA ADM" } })).blocked).toMatch(/^Sudah ada instruksi aktif/);
    // A client-scope instruction on the same text is another scope: allowed, and only that client hears of it.
    const own = await approveInstruction(db, { firmId: g.firm.id, clientId: g.client.id, sentence: '"BIAYA ADM" selalu 6190', fields: fields({ ...typed.draft, pattern: "BIAYA ADM" }) });
    expect(own).toMatchObject({ ok: true, origin: "PARSER" });
    expect(await db.rule.findFirstOrThrow({ where: { instructionId: (own as { id: string }).id } })).toMatchObject({ clientId: g.client.id, priority: 5 });
    expect(await listEvents(db, g.client.id, { kind: "INSTRUCTION" })).toHaveLength(2);
    expect(await listEvents(db, g.other.id, { kind: "INSTRUCTION" })).toHaveLength(1);
  });

  it("origin: Buku's reader, a cached AI answer for this sentence, or an edit", async () => {
    const g = await setup();
    const sentence = "PT MAJU JAYA selalu ke Review";
    const d = (await parsed(g, sentence)).draft;
    expect(await approveInstruction(db, { firmId: g.firm.id, clientId: g.client.id, sentence, fields: fields(d) })).toMatchObject({ ok: true, origin: "PARSER" });
    const odd = "kalau PT SINAR ABADI kirim uang, saya mau lihat dulu";
    const ai: InstructionDraft = { ...d, pattern: "PT SINAR ABADI", direction: "IN" };
    await db.evidenceAiCache.create({ data: { key: "k1", firmId: g.firm.id, scope: `instruksi:${g.firm.id}`, payload: { sentence: odd, draft: fields(ai) } } });
    expect(await approveInstruction(db, { firmId: g.firm.id, clientId: g.client.id, sentence: odd, fields: fields(ai) })).toMatchObject({ ok: true, origin: "AI" });
    const edited = await approveInstruction(db, { firmId: g.firm.id, clientId: g.client.id, sentence: odd, fields: fields({ ...ai, direction: "OUT" }) });
    expect(edited).toMatchObject({ ok: true, origin: "EDITED" });
  });

  it("refuses what the closed schema refuses, against the scope's charts", async () => {
    const g = await setup();
    const base = (await parsed(g, '"BIAYA ADM" selalu 6190')).draft;
    const go = (f: unknown, clientId: string | null = null) => approveInstruction(db, { firmId: g.firm.id, clientId, sentence: '"BIAYA ADM" selalu 6190', fields: f });
    expect(await go({ ...fields(base), accountCode: "6195" })).toEqual({ ok: false, error: "Akun 6195 tidak ada di bagan akun klien ini.", field: "accountCode" });
    expect(await go(fields(base), g.other.id)).toEqual({ ok: false, error: "Akun 6190 tidak ada di bagan akun klien ini.", field: "accountCode" });
    expect(await go({ ...fields(base), accountCode: "1199" })).toMatchObject({ ok: false, error: "Transfer antar rekening dipasangkan oleh Buku, bukan oleh aturan." });
    expect(await go({ ...fields(base), pattern: "TRANSFER" })).toMatchObject({ ok: false, field: "pattern" });
    expect(await go({ ...fields(base), extra: 1 })).toMatchObject({ ok: false, error: "Isian instruksi tidak dikenal: extra." });
    expect(await approveInstruction(db, { firmId: g.firm.id, clientId: null, sentence: " ", fields: fields(base) })).toEqual({ ok: false, error: "Tulis instruksinya dulu." });
    await expect(approveInstruction(db, { firmId: "another-firm", clientId: g.client.id, sentence: "x", fields: fields(base) })).rejects.toThrow("Klien tidak ditemukan.");
    expect(await db.instruction.count()).toBe(0);
  });

  it("Matikan deletes the rule, keeps the instruction as Dimatikan, changes no bank line or journal, and writes one event per client", async () => {
    const g = await setup();
    const sentence = '"BIAYA ADM" selalu 6190';
    const d = (await parsed(g, sentence)).draft;
    const { id } = (await approveInstruction(db, { firmId: g.firm.id, clientId: null, sentence, fields: fields(d) })) as { id: string };
    const books = async () => ({ bank: await db.bankTransaction.findMany({ orderBy: { id: "asc" } }), entries: await db.journalEntry.findMany({ orderBy: { id: "asc" }, include: { lines: { orderBy: { id: "asc" } } } }) });
    const before = await books();
    const actor = await addMember(g.firm.id, "OWNER", { name: "Pak Pemilik" });
    expect(await turnOffInstruction(db, { firmId: g.firm.id, id, actorId: actor.id })).toEqual({ ok: true });
    expect(await db.rule.count({ where: { source: "INSTRUKSI" } })).toBe(0);
    expect(await db.instruction.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "OFF", offById: actor.id, offAt: expect.any(Date) });
    expect(await books()).toEqual(before);
    for (const c of [g.client.id, g.other.id]) {
      const [off] = await listEvents(db, c, { kind: "INSTRUCTION" });
      expect(off).toMatchObject({ summary: `Dimatikan: "${sentence}"`, actor: "Pak Pemilik", before: { status: "ACTIVE" }, after: { status: "OFF" } });
    }
    expect(await turnOffInstruction(db, { firmId: g.firm.id, id })).toEqual({ ok: false, error: "Instruksi ini sudah dimatikan." });
    expect(await turnOffInstruction(db, { firmId: "another-firm", id })).toEqual({ ok: false, error: "Instruksi tidak ditemukan." });
    // Written again after Matikan: a new instruction, no conflict with the one turned off.
    expect(await approveInstruction(db, { firmId: g.firm.id, clientId: null, sentence, fields: fields(d) })).toMatchObject({ ok: true });
  });
});
