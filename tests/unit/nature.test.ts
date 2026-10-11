import { describe, expect, it } from "vitest";
import { againstNature } from "@/lib/ledger-import/nature";

describe("a file balance against the account's normal side", () => {
  it("is quiet when the balance is on the normal side or zero", () => {
    expect(againstNature(100n, "DEBIT")).toBeNull();
    expect(againstNature(-100n, "CREDIT")).toBeNull();
    expect(againstNature(0n, "DEBIT")).toBeNull();
    expect(againstNature(0n, "CREDIT")).toBeNull();
  });
  it("says which side the balance sits on when it is the other one (the Rp 1,38 M credit in Piutang lain-lain)", () => {
    expect(againstNature(-1_382_305_358n, "DEBIT")).toBe("kredit");
    expect(againstNature(5n, "CREDIT")).toBe("debit");
  });
});
