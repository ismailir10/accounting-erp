import { describe, expect, it } from "vitest";
import type { MemberRole } from "@/lib/generated/prisma/enums";
import { DEFAULT_APPROVALS, describeApprovalChanges, parseApprovals } from "@/lib/settings/approvals";
import {
  APPROVAL_TIER,
  approverProblem,
  formNotice,
  hasApprover,
  sourceRoute,
  hasSecondAdmin,
  journalHead,
  reopenDeciderProblem,
  routing,
  waitingFor,
  waitReason,
} from "@/lib/approvals/second";

/** Persetujuan kedua (cycle 2026-10-18-persetujuan-kedua): the pure rules. */
const ON = { ...DEFAULT_APPROVALS, manual: true, manualAbove: 100_000_000n, aiDraft: true, aiDraftAbove: 50_000_000n, reopen: true };

describe("routing: source × amount × currency × settings", () => {
  it("off routes nothing, whatever the amount", () => {
    for (const source of ["MANUAL", "REVERSAL", "AI_DRAFT"] as const) {
      expect(routing(DEFAULT_APPROVALS, source, 10n ** 15n, "IDR")).toEqual({ routed: false });
      expect(routing(DEFAULT_APPROVALS, source, 1n, "USD")).toEqual({ routed: false });
    }
  });

  it("equal posts, strictly above waits (Rp 100.000.000 posts, Rp 150.000.000 waits); Balik jurnal follows Jurnal manual", () => {
    for (const source of ["MANUAL", "REVERSAL"] as const) {
      expect(routing(ON, source, 100_000_000n, "IDR")).toEqual({ routed: false });
      expect(routing(ON, source, 100_000_001n, "IDR")).toEqual({ routed: true, threshold: 100_000_000n });
      expect(routing(ON, source, 150_000_000n, "IDR")).toEqual({ routed: true, threshold: 100_000_000n });
    }
    expect(routing(ON, "AI_DRAFT", 50_000_000n, "IDR")).toEqual({ routed: false });
    expect(routing(ON, "AI_DRAFT", 60_000_000n, "IDR")).toEqual({ routed: true, threshold: 50_000_000n });
  });

  it("an empty threshold routes every journal of a switched-on source; the other source stays off", () => {
    const all = { ...DEFAULT_APPROVALS, manual: true };
    expect(routing(all, "MANUAL", 1n, "IDR")).toEqual({ routed: true, threshold: null });
    expect(routing(all, "REVERSAL", 1n, "IDR")).toEqual({ routed: true, threshold: null });
    expect(routing(all, "AI_DRAFT", 10n ** 12n, "IDR")).toEqual({ routed: false });
  });

  it("a company kept in another currency routes every journal: a Rupiah threshold is never compared with cents", () => {
    expect(routing(ON, "MANUAL", 1n, "USD")).toEqual({ routed: true, threshold: 100_000_000n });
    expect(routing(ON, "AI_DRAFT", 1n, "SGD")).toEqual({ routed: true, threshold: 50_000_000n });
    expect(waitReason(100_000_000n, "USD")).toBe("perusahaan berbuku USD: semua jurnal perlu persetujuan");
  });

  it("says why it waits", () => {
    expect(waitReason(100_000_000n, "IDR")).toBe("di atas Rp 100.000.000");
    expect(waitReason(null, "IDR")).toBe("semua nominal perlu persetujuan");
  });
});

describe("the approver rule", () => {
  const roles: MemberRole[] = ["OWNER", "ADMIN", "AKUNTAN", "VIEWER"];

  it("never the maker, an admin's own journal included", () => {
    for (const role of ["OWNER", "ADMIN", "AKUNTAN"] as const) {
      expect(approverProblem({ id: "m", role }, { makerId: "m", makerRole: role })).toMatch(/^Anda yang mengajukan jurnal ini/);
    }
  });

  it("the 4 × 4 tier matrix, Admin and Pemilik one tier, Peninjau never", () => {
    // [approver][maker] → may decide
    const expected: Record<MemberRole, Record<MemberRole, boolean>> = {
      OWNER: { OWNER: true, ADMIN: true, AKUNTAN: true, VIEWER: true },
      ADMIN: { OWNER: true, ADMIN: true, AKUNTAN: true, VIEWER: true },
      AKUNTAN: { OWNER: false, ADMIN: false, AKUNTAN: true, VIEWER: true },
      VIEWER: { OWNER: false, ADMIN: false, AKUNTAN: false, VIEWER: false },
    };
    for (const a of roles) for (const m of roles) expect([a, m, approverProblem({ id: "a", role: a }, { makerId: "m", makerRole: m }) === null]).toEqual([a, m, expected[a][m]]);
    expect(APPROVAL_TIER.OWNER).toBe(APPROVAL_TIER.ADMIN);
  });

  it("refusals are Bahasa sentences naming the rule", () => {
    expect(approverProblem({ id: "a", role: "AKUNTAN" }, { makerId: "m", makerRole: "ADMIN" })).toBe("Jurnal ini diajukan Admin, jadi hanya Admin atau Pemilik lain yang dapat memutuskannya.");
    expect(approverProblem({ id: "a", role: "AKUNTAN" }, { makerId: "m", makerRole: "OWNER" })).toBe("Jurnal ini diajukan Pemilik, jadi hanya Admin atau Pemilik lain yang dapat memutuskannya.");
    expect(approverProblem({ id: "a", role: "VIEWER" }, { makerId: "m", makerRole: "AKUNTAN" })).toBe("Peran Peninjau hanya dapat melihat, jadi tidak dapat menyetujui jurnal.");
    expect(waitingFor("AKUNTAN")).toBe("Menunggu Akuntan lain, Admin atau Pemilik");
    expect(waitingFor("OWNER")).toBe("Menunggu Admin atau Pemilik lain");
    expect(waitingFor("ADMIN")).toBe("Menunggu Admin atau Pemilik lain");
  });
});

describe("the fallback: no second person", () => {
  const p = (id: string, role: MemberRole, extra: Partial<{ disabled: boolean; canOpen: boolean }> = {}) => ({ id, role, disabled: false, canOpen: true, ...extra });

  it("the only admin's own journal has no approver; an Akuntan's always has the Pemilik", () => {
    const owner = p("o", "OWNER");
    const akuntan = p("k", "AKUNTAN");
    expect(hasApprover([owner, akuntan], { id: "o", role: "OWNER" })).toBe(false); // an Akuntan ranks below
    expect(hasApprover([owner, akuntan], { id: "k", role: "AKUNTAN" })).toBe(true);
    expect(hasApprover([owner, akuntan, p("a", "ADMIN")], { id: "o", role: "OWNER" })).toBe(true);
  });

  it("a disabled, unassigned or read-only member is not an approver", () => {
    const maker = { id: "k", role: "AKUNTAN" as const };
    expect(hasApprover([p("k", "AKUNTAN"), p("x", "ADMIN", { disabled: true })], maker)).toBe(false);
    expect(hasApprover([p("k", "AKUNTAN"), p("y", "AKUNTAN", { canOpen: false })], maker)).toBe(false);
    expect(hasApprover([p("k", "AKUNTAN"), p("v", "VIEWER")], maker)).toBe(false);
    expect(hasApprover([p("k", "AKUNTAN"), p("y", "AKUNTAN")], maker)).toBe(true);
  });

  it("a reopen needs another active admin", () => {
    expect(hasSecondAdmin([p("o", "OWNER"), p("k", "AKUNTAN")], "o")).toBe(false);
    expect(hasSecondAdmin([p("o", "OWNER"), p("a", "ADMIN", { disabled: true })], "o")).toBe(false);
    expect(hasSecondAdmin([p("o", "OWNER"), p("a", "ADMIN")], "o")).toBe(true);
  });
});

describe("the reopen confirm rule", () => {
  it("another Pemilik or Admin decides; the requester and an Akuntan never", () => {
    expect(reopenDeciderProblem({ id: "a", role: "ADMIN" }, { requestedById: "o" })).toBeNull();
    expect(reopenDeciderProblem({ id: "o", role: "OWNER" }, { requestedById: "a" })).toBeNull();
    expect(reopenDeciderProblem({ id: "o", role: "OWNER" }, { requestedById: "o" })).toMatch(/^Anda yang meminta membuka kembali bulan ini/);
    expect(reopenDeciderProblem({ id: "k", role: "AKUNTAN" }, { requestedById: "o" })).toBe("Hanya admin kantor yang dapat membuka kembali periode.");
  });
});

describe("the forms' notice (Jurnal Penyesuaian, Balik jurnal, a draft's Catat jurnal)", () => {
  const route = sourceRoute(ON, "MANUAL", false);
  it("says nothing at or below the threshold or with the source off; above it the button reads Ajukan persetujuan", () => {
    expect(formNotice(sourceRoute(DEFAULT_APPROVALS, "MANUAL", false), 10n ** 12n, "IDR")).toBeNull();
    expect(formNotice(route, 100_000_000n, "IDR")).toBeNull();
    expect(formNotice(route, 150_000_000n, "IDR")).toEqual({ waits: true, text: "Di atas Rp 100.000.000: jurnal ini menunggu persetujuan anggota lain sebelum dicatat." });
    expect(formNotice(sourceRoute({ ...DEFAULT_APPROVALS, manual: true }, "REVERSAL", false), 1n, "IDR")).toMatchObject({ waits: true, text: expect.stringMatching(/^Semua nominal:/) });
    expect(formNotice(route, 1n, "USD")).toMatchObject({ waits: true, text: expect.stringMatching(/^Perusahaan berbuku USD:/) });
    expect(formNotice(sourceRoute(ON, "AI_DRAFT", false), 60_000_000n, "IDR")).toMatchObject({ waits: true, text: expect.stringMatching(/^Di atas Rp 50\.000\.000:/) });
  });
  it("with nobody else to approve, it says the journal posts without a second approver", () => {
    expect(formNotice(sourceRoute(ON, "MANUAL", true), 150_000_000n, "IDR")).toEqual({ waits: false, text: "Dicatat tanpa persetujuan kedua: tidak ada anggota lain yang berhak menyetujui." });
  });
});

describe("the card's parse and summary texts", () => {
  it("one-line diffs in the card's order", () => {
    expect(describeApprovalChanges(DEFAULT_APPROVALS, ON)).toEqual([
      "Jurnal manual: tanpa persetujuan → di atas Rp 100.000.000",
      "Draf AI: tanpa persetujuan → di atas Rp 50.000.000",
      "Buka kembali bulan: langsung oleh admin → dikonfirmasi admin kedua",
    ]);
    expect(describeApprovalChanges(ON, { ...ON, manualAbove: null })).toEqual(["Jurnal manual: di atas Rp 100.000.000 → semua nominal"]);
    expect(describeApprovalChanges(ON, ON)).toEqual([]);
  });

  it("validates a switched-on threshold only", () => {
    expect(parseApprovals({ manual: true, manualAbove: "Rp 100.000.000", aiDraft: false, aiDraftAbove: "abc", reopen: false })).toEqual({ ok: true, value: { ...DEFAULT_APPROVALS, manual: true, manualAbove: 100_000_000n } });
    expect(parseApprovals({ manual: true, manualAbove: "0", aiDraft: true, aiDraftAbove: "-5", reopen: false })).toMatchObject({ ok: false, errors: { manualAbove: expect.any(String), aiDraftAbove: expect.any(String) } });
  });

  it("an event's head names the source, memo, date and amount", () => {
    expect(journalHead("MANUAL", "Akrual gaji", "31 Jul 2026", "Rp 150.000.000")).toBe('Jurnal manual "Akrual gaji" 31 Jul 2026 · Rp 150.000.000');
    expect(journalHead("REVERSAL", "x", "1 Agu 2026", "Rp 1")).toMatch(/^Balik jurnal/);
    expect(journalHead("AI_DRAFT", "x", "1 Agu 2026", "Rp 1")).toMatch(/^Draf AI/);
  });
});
