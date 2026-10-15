import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { closeTimeline, formatDuration } from "@/lib/controls/timeline";
import { recordEvent } from "@/lib/audit";
import { dateOnly } from "@/lib/format";
import { addMember } from "../members";

// recordExport reads the session through lib/auth/session. The identity source is pinned here (tests/members.ts), so the result never
// depends on whether the shell running the suite has Auth configured: without these mocks, a configured NEXT_PUBLIC_SUPABASE_* made the
// real Supabase client call cookies() outside a request, recordExport swallowed the error and logged nothing.
const auth = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({ authConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getClaims: async () => ({ data: auth.userId ? { claims: { sub: auth.userId } } : null }) } }) }));
const { recordExport } = await import("@/lib/reports/export-log");

// ADR 0014's north-star metric: first file in → lock → first report sent after the lock, per client-month.
type G = Awaited<ReturnType<typeof makeGroup>>;
let g: G;
const t = (h: number) => new Date(Date.UTC(2026, 9, 1, h)); // hours on 1 October 2026

beforeEach(async () => {
  await resetDb();
  g = await makeGroup();
  auth.userId = null;
});

async function statement(month: number, createdAt: Date) {
  const bank = await db.bankAccount.findFirstOrThrow({ where: { entityId: g.pt.entity.id } });
  return db.statementImport.create({
    data: { firmId: g.firm.id, bankAccountId: bank.id, fileName: `bca-${month}.csv`, format: "BCA", periodStart: dateOnly(2026, month, 1), periodEnd: dateOnly(2026, month + 1, 0), openingBalance: 0n, closingBalance: 0n, rowCount: 0, continuityOk: true, createdAt },
  });
}
const exported = (month: number, at: Date) =>
  db.auditEvent.create({ data: { firmId: g.firm.id, clientId: g.client.id, kind: "REPORT_EXPORT", subject: `period:2026-${String(month).padStart(2, "0")}`, summary: "x", createdAt: at } });

describe("closeTimeline", () => {
  it("measures first file → lock → first report sent after the lock", async () => {
    await statement(8, t(1));
    await statement(8, t(3));
    await exported(8, t(4)); // a draft sent before the lock doesn't count
    await db.period.create({ data: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 8, status: "LOCKED", lockedAt: t(6) } });
    await exported(8, t(7));
    await exported(8, t(9));

    const [aug] = await closeTimeline(db, g.client.id);
    expect(aug).toMatchObject({ year: 2026, month: 8, files: 2, firstFileAt: t(1), lastFileAt: t(3), lockedAt: t(6), firstSentAt: t(7) });
    expect(formatDuration(aug.toLockMs)).toBe("5 jam 0 menit");
    expect(formatDuration(aug.toSentMs)).toBe("6 jam 0 menit");
  });

  it("an open month has no lock or sent time; --period picks one month", async () => {
    await statement(7, t(1));
    await statement(8, t(2));
    const all = await closeTimeline(db, g.client.id);
    expect(all.map((m) => m.month)).toEqual([7, 8]);
    expect(all[1]).toMatchObject({ lockedAt: null, firstSentAt: null, toLockMs: null, toSentMs: null });
    expect((await closeTimeline(db, g.client.id, { year: 2026, month: 7 })).map((m) => m.month)).toEqual([7]);
  });

  it("a review counts for the month of the bank line it changed", async () => {
    await statement(8, t(1));
    const bank = await db.bankAccount.findFirstOrThrow({ where: { entityId: g.pt.entity.id } });
    const imp = await db.statementImport.findFirstOrThrow();
    const tx = await db.bankTransaction.create({
      data: { firmId: g.firm.id, bankAccountId: bank.id, entityId: g.pt.entity.id, importId: imp.id, date: dateOnly(2026, 8, 5), description: "X", amount: -10n, hash: "h1", rowNumber: 2, rawRow: "x", merchantKey: "X", direction: "OUT", status: "NEEDS_REVIEW", method: "HEURISTIC", confidence: 0.5, reason: "uji" },
    });
    await recordEvent(db, { clientId: g.client.id, kind: "CLASSIFY", subject: `bankTx:${tx.id}`, summary: "x" });
    const [aug] = await closeTimeline(db, g.client.id);
    expect(aug.lastReviewAt).not.toBeNull();
  });

  it("a download is logged for its period, final or draft, and counts once the month is locked", async () => {
    await statement(8, t(1));
    await db.period.create({ data: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 8, status: "LOCKED", lockedAt: new Date(Date.now() - 1000) } });
    await recordExport(db, { clientId: g.client.id, entityId: g.pt.entity.id, scope: "PT Uji Sejahtera", year: 2026, month: 8, file: "Laporan keuangan (PDF)", final: true });
    const e = await db.auditEvent.findFirstOrThrow({ where: { kind: "REPORT_EXPORT" } });
    expect(e).toMatchObject({ subject: "period:2026-08", actorId: null, entityId: g.pt.entity.id });
    expect(e.summary).toBe("Laporan keuangan (PDF) · PT Uji Sejahtera · Agustus 2026 · final");
    expect((await closeTimeline(db, g.client.id))[0].firstSentAt).toEqual(e.createdAt);
  });

  it("a signed-in member's download names that member", async () => {
    const member = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    auth.userId = member.userId;
    await recordExport(db, { clientId: g.client.id, entityId: g.pt.entity.id, scope: "PT Uji Sejahtera", year: 2026, month: 8, file: "Laporan keuangan (Excel)", final: false });
    const e = await db.auditEvent.findFirstOrThrow({ where: { kind: "REPORT_EXPORT" } });
    expect(e).toMatchObject({ subject: "period:2026-08", actorId: member.id });
    expect(e.summary).toBe("Laporan keuangan (Excel) · PT Uji Sejahtera · Agustus 2026 · draf");
  });

  it("formats durations as an accountant reads them", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(45 * 60_000)).toBe("45 menit");
    expect(formatDuration((2 * 24 + 3) * 3_600_000)).toBe("2 hari 3 jam");
  });
});
