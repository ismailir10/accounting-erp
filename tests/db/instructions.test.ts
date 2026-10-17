import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import type { Prisma } from "@/lib/generated/prisma/client";

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
