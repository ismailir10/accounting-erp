import { describe, expect, it } from "vitest";
import { can, capabilityRefusal, isAdminRole, isWrite, ROLE_LABEL, type Capability } from "@/lib/auth/permissions";
import type { MemberRole } from "@/lib/generated/prisma/enums";

// The Roles table of docs/cycles/2026-10-09-trial-tenants-roles.md, row by row: OWNER, ADMIN, AKUNTAN, VIEWER.
const TABLE: Record<Capability, [boolean, boolean, boolean, boolean]> = {
  "books.read": [true, true, true, true],
  "books.write": [true, true, true, false],
  "client.create": [true, true, true, false],
  "period.unlock": [true, true, false, false],
  "import.remove": [true, true, false, false],
  "close.batch": [true, true, false, false],
  "checklist.manage": [true, true, false, false],
  "client.delete": [true, true, false, false],
  "org.settings": [true, true, false, false],
  "members.manage": [true, true, false, false],
  "org.transfer": [true, false, false, false],
};
const ROLES: MemberRole[] = ["OWNER", "ADMIN", "AKUNTAN", "VIEWER"];

describe("permissions", () => {
  for (const [capability, row] of Object.entries(TABLE) as [Capability, boolean[]][]) {
    it(capability, () => expect(ROLES.map((r) => can(r, capability))).toEqual(row));
  }
  it("admins are OWNER and ADMIN", () => expect(ROLES.filter(isAdminRole)).toEqual(["OWNER", "ADMIN"]));
  it("only reading is not a write", () => expect((Object.keys(TABLE) as Capability[]).filter((c) => !isWrite(c))).toEqual(["books.read"]));
  it("refuses checklist set-up to non-admins in Bahasa", () => expect(capabilityRefusal("checklist.manage")).toBe("Hanya admin kantor yang dapat mengatur checklist."));
  it("labels every role in Bahasa", () => expect(ROLES.map((r) => ROLE_LABEL[r])).toEqual(["Pemilik", "Admin", "Akuntan", "Peninjau"]));
});
