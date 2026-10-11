// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { BankSection } from "@/lib/inbox/check";
import { proposeClient, type PreviewFile } from "@/lib/inbox/propose";
import { reconcile } from "@/components/app/new-client-from-files";

const section = (number: string, holder: string | null, month = 6): BankSection => ({
  bank: "BCA",
  number,
  holder,
  currency: "IDR",
  periodStart: `2026-0${month}-01`,
  periodEnd: `2026-0${month}-30`,
  rows: 3,
  opening: "1000000",
  closing: "1500000",
  error: null,
});
const file = (fileName: string, s: BankSection): PreviewFile => ({ fileName, kind: "BANK", status: "CHECKED", message: null, sections: [s] });

describe("Klien baru card after more files are read (review of #149)", () => {
  it("moves a rekening from the default company to the company a later file names, and drops the unused default", () => {
    const first = reconcile(proposeClient([file("jun.csv", section("6044551270", null))]), null);
    expect(first.entities).toHaveLength(1);
    const named = reconcile(proposeClient([file("jun.csv", section("6044551270", null)), file("jul.csv", section("6044551270", "PT Maju Jaya", 7))]), first);
    const owner = Object.values(named.owner)[0];
    expect(named.entities.map((e) => e.key)).toEqual([owner]);
    expect(named.entities[0].name).toMatch(/Maju Jaya/);
  });

  it("keeps a rekening the user moved, and the owner they added", () => {
    const first = reconcile(proposeClient([file("a.csv", section("1111111111", null)), file("b.csv", section("2222222222", null))]), null);
    const key = Object.keys(first.owner).find((k) => k.includes("2222"))!;
    const moved = { ...first, entities: [...first.entities, { key: "pemilik-1", name: "Budi", kind: "PERORANGAN" as const }], owner: { ...first.owner, [key]: "pemilik-1" }, moved: { [key]: true as const } };
    const again = reconcile(proposeClient([file("a.csv", section("1111111111", null)), file("b.csv", section("2222222222", null)), file("c.csv", section("1111111111", null, 7))]), moved);
    expect(again.owner[key]).toBe("pemilik-1");
    expect(again.entities.map((e) => e.key)).toContain("pemilik-1");
  });
});
