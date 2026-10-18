import type { Db } from "@/lib/db";
import type { Control } from "@/lib/controls";
import type { Instruction } from "@/lib/generated/prisma/client";
import { formatDate } from "@/lib/format";
import { formatRupiah } from "@/lib/money";
import { flagNone, flagTitle } from "@/lib/instructions/compile";
import { matchesLine, type LineCondition } from "@/lib/instructions/match";

/**
 * *Tandai* controls (accounting-rules 22d, cycle 2026-10-18-instruksi-kantor): an active FLAG instruction is one REVIEW control per entity
 * in a month that is not locked, listing that month's bank lines with its direction, its keyword and an absolute amount above (or at
 * least) its minimum. Computed at read time from the instruction's typed fields; a note clears it as any REVIEW control, while the list is
 * unchanged. Deterministic: no model decides it.
 */
const SHOWN = 5;
const TEXT = 60;

/** The month's bank lines of an entity that a *Tandai* instruction lists, oldest first (the AI close review sends the largest). */
export async function flaggedLines(db: Db, f: LineCondition, entityId: string, start: Date, end: Date) {
  const rows = await db.bankTransaction.findMany({
    where: {
      entityId,
      date: { gte: start, lte: end },
      ...(f.direction ? { direction: f.direction } : {}),
      ...(f.pattern ? { description: { contains: f.pattern, mode: "insensitive" as const } } : {}),
    },
    orderBy: [{ date: "asc" }, { rowNumber: "asc" }],
  });
  return rows.filter((t) => matchesLine(f, t));
}

export const flagKey = (entityId: string, instructionId: string) => `instr:${entityId}:${instructionId}`;

export async function instructionControls(
  db: Db,
  input: { flags: Instruction[]; entity: { id: string; shortName: string }; start: Date; end: Date; acks: Map<string, string> },
): Promise<Control[]> {
  const out: Control[] = [];
  for (const f of input.flags) {
    const lines = await flaggedLines(db, f, input.entity.id, input.start, input.end);
    const key = flagKey(input.entity.id, f.id);
    const shown = lines.slice(0, SHOWN).map((t) => `${formatDate(t.date)} · ${t.description.slice(0, TEXT)} · ${formatRupiah(t.amount < 0n ? -t.amount : t.amount)}`);
    out.push({
      key,
      title: flagTitle(f),
      scope: input.entity.shortName,
      status: lines.length ? "REVIEW" : "PASS",
      detail: lines.length ? `${shown.join("; ")}${lines.length > SHOWN ? `; +${lines.length - SHOWN} lainnya` : ""}` : flagNone(f),
      ack: lines.length ? input.acks.get(key) : undefined,
    });
  }
  return out;
}
