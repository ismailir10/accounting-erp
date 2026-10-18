import type { Db, Tx } from "@/lib/db";
import { recordEvent } from "@/lib/audit";
import { formatRupiah, MoneyError, parseMoney } from "@/lib/money";

/**
 * Otomasi kantor (cycle 2026-10-17-otomasi): per firm, which deterministic sources may post an imported bank line directly (transfer
 * match, rules, remembered choices) and an amount cap above which every line waits in Review (accounting-rules 14), plus the flux
 * scan's thresholds (accounting-rules 22b). Stored on `Firm`; the defaults are the behaviour before the dial existed. Saved by admins
 * only (`org.settings`, app/firm-settings-actions.ts); every change is one AUTOMATION event in each client's Riwayat perubahan.
 */
export type FirmAutomation = {
  transfer: boolean;
  rules: boolean;
  memory: boolean;
  /** Whole Rupiah; null = no cap. */
  cap: bigint | null;
  /** Ambang fluktuasi: minimum difference in whole Rupiah (Rupiah companies only); null = none. */
  fluxFloor: bigint | null;
  /** Ambang fluktuasi: minimum change against the account's baseline average, whole percent 1–1000. */
  fluxPercent: number;
};

export const DEFAULT_AUTOMATION: FirmAutomation = { transfer: true, rules: true, memory: true, cap: null, fluxFloor: null, fluxPercent: 50 };

export const AUTOMATION_SELECT = { autoPostTransfer: true, autoPostRules: true, autoPostMemory: true, autoPostCap: true, fluxFloor: true, fluxPercent: true } as const;
type Row = { autoPostTransfer: boolean; autoPostRules: boolean; autoPostMemory: boolean; autoPostCap: bigint | null; fluxFloor: bigint | null; fluxPercent: number };

export const automationOf = (f: Row): FirmAutomation => ({
  transfer: f.autoPostTransfer,
  rules: f.autoPostRules,
  memory: f.autoPostMemory,
  cap: f.autoPostCap,
  fluxFloor: f.fluxFloor,
  fluxPercent: f.fluxPercent,
});

export async function readAutomation(db: Db | Tx, firmId: string): Promise<FirmAutomation> {
  return automationOf(await db.firm.findUniqueOrThrow({ where: { id: firmId }, select: AUTOMATION_SELECT }));
}

/** What the form sends: switches as booleans, amounts and the percent as typed. */
export type AutomationInput = { transfer: boolean; rules: boolean; memory: boolean; cap: string; fluxFloor: string; fluxPercent: string };
export type AutomationField = "cap" | "fluxFloor" | "fluxPercent";
export type AutomationErrors = Partial<Record<AutomationField, string>>;

export const AMOUNT_MESSAGE = "Isi nominal Rupiah lebih dari 0, atau kosongkan.";
export const PERCENT_MESSAGE = "Isi persentase bulat dari 1 sampai 1000.";
export const PERCENT_MAX = 1000;

/** Empty = none (null); otherwise whole Rupiah above zero, at most 15 digits (as the import reads amounts); undefined = invalid. */
export function rupiahThreshold(text: string): bigint | null | undefined {
  const t = text.trim();
  if (!t) return null;
  try {
    const v = parseMoney(t, "IDR");
    return v > 0n ? v : undefined;
  } catch (e) {
    if (e instanceof MoneyError) return undefined;
    throw e;
  }
}

export function parseAutomation(input: AutomationInput): { ok: true; value: FirmAutomation } | { ok: false; errors: AutomationErrors } {
  const errors: AutomationErrors = {};
  const cap = rupiahThreshold(input.cap);
  if (cap === undefined) errors.cap = AMOUNT_MESSAGE;
  const fluxFloor = rupiahThreshold(input.fluxFloor);
  if (fluxFloor === undefined) errors.fluxFloor = AMOUNT_MESSAGE;
  const p = input.fluxPercent.trim().replace(/\s*%$/, "");
  const fluxPercent = /^\d{1,4}$/.test(p) ? Number(p) : NaN;
  if (!(fluxPercent >= 1 && fluxPercent <= PERCENT_MAX)) errors.fluxPercent = PERCENT_MESSAGE;
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { transfer: input.transfer === true, rules: input.rules === true, memory: input.memory === true, cap: cap!, fluxFloor: fluxFloor!, fluxPercent } };
}

export const SOURCE_LABEL = { transfer: "Transfer antar rekening", rules: "Aturan", memory: "Pilihan yang diingat" } as const;
const posting = (on: boolean) => (on ? "langsung dicatat" : "ke Review");
export const capText = (v: bigint | null) => (v === null ? "tanpa batas" : formatRupiah(v));
export const floorText = (v: bigint | null) => (v === null ? "tanpa minimum" : formatRupiah(v));

/** One part per setting that differs, in the card's order: "Aturan: langsung dicatat → ke Review". */
export function describeChanges(before: FirmAutomation, after: FirmAutomation): string[] {
  const out: string[] = [];
  for (const k of ["transfer", "rules", "memory"] as const) {
    if (before[k] !== after[k]) out.push(`${SOURCE_LABEL[k]}: ${posting(before[k])} → ${posting(after[k])}`);
  }
  if (before.cap !== after.cap) out.push(`Batas nominal: ${capText(before.cap)} → ${capText(after.cap)}`);
  if (before.fluxFloor !== after.fluxFloor) out.push(`Selisih minimal: ${floorText(before.fluxFloor)} → ${floorText(after.fluxFloor)}`);
  if (before.fluxPercent !== after.fluxPercent) out.push(`Perubahan minimal: ${before.fluxPercent} % → ${after.fluxPercent} %`);
  return out;
}

/** Amounts as strings: bigint stays exact through JSON (lib/audit.ts). */
const snapshot = (a: FirmAutomation) => ({ ...a, cap: a.cap?.toString() ?? null, fluxFloor: a.fluxFloor?.toString() ?? null });

/**
 * Validates and saves the firm's dial and thresholds. A save that changes something writes, in the same transaction, one AUTOMATION
 * event with before and after into every client's Riwayat perubahan; a save that changes nothing writes nothing. New imports and the
 * next flux scan read the new values; no existing line is re-classified, re-posted or moved.
 */
export async function saveAutomation(
  db: Db,
  input: { firmId: string; settings: AutomationInput; actorId?: string | null },
): Promise<{ ok: true; changed: boolean } | { ok: false; errors: AutomationErrors }> {
  const parsed = parseAutomation(input.settings);
  if (!parsed.ok) return parsed;
  const after = parsed.value;
  return db.$transaction(async (tx) => {
    // Two admins saving at once: the second reads the first's result as its "before".
    await tx.$queryRaw`SELECT id FROM "Firm" WHERE id = ${input.firmId} FOR UPDATE`;
    const before = await readAutomation(tx, input.firmId);
    const changes = describeChanges(before, after);
    if (!changes.length) return { ok: true as const, changed: false };
    await tx.firm.update({
      where: { id: input.firmId },
      data: { autoPostTransfer: after.transfer, autoPostRules: after.rules, autoPostMemory: after.memory, autoPostCap: after.cap, fluxFloor: after.fluxFloor, fluxPercent: after.fluxPercent },
    });
    const clients = await tx.client.findMany({ where: { firmId: input.firmId }, select: { id: true } });
    for (const c of clients) {
      await recordEvent(tx, { clientId: c.id, kind: "AUTOMATION", subject: `firm:${input.firmId}`, summary: changes.join("; "), before: snapshot(before), after: snapshot(after), actorId: input.actorId });
    }
    return { ok: true as const, changed: true };
  });
}

/** The card's "Terakhir diubah …": the newest AUTOMATION event of any of the firm's clients (one per client per save). */
export async function lastAutomationChange(db: Db, firmId: string): Promise<{ at: Date; actor: string } | null> {
  const e = await db.auditEvent.findFirst({
    // Through the firm's clients: AuditEvent is indexed by client, not by firm.
    where: { clientId: { in: (await db.client.findMany({ where: { firmId }, select: { id: true } })).map((c) => c.id) }, kind: "AUTOMATION", subject: `firm:${firmId}` },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, actor: { select: { name: true } } },
  });
  return e && { at: e.createdAt, actor: e.actor?.name ?? "Sistem" };
}
