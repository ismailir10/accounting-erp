import { describe, expect, it } from "vitest";
import { isCompanyName, matchEntity, normalName, titleCase } from "@/lib/inbox/names";

describe("Unggah: holder ↔ entity names", () => {
  it("drops punctuation and legal-form words and ignores word order", () => {
    expect(normalName("BELIFI MAHAJAYA NUSANTARA PT")).toBe("BELIFI MAHAJAYA NUSANTARA");
    expect(normalName("PT. Belifi Mahajaya Nusantara")).toBe(normalName("BELIFI MAHAJAYA NUSANTARA PT"));
    expect(normalName("P.T. Belifi  Mahajaya, Nusantara")).toBe(normalName("Nusantara Belifi Mahajaya"));
    expect(normalName("PT Bank Mandiri (Persero) Tbk")).toBe(normalName("BANK MANDIRI"));
    expect(normalName("CV Sinar-Jaya")).toBe("JAYA SINAR");
    expect(normalName("  ")).toBe("");
  });

  it("tells a company from a person by its legal-form word", () => {
    expect(isCompanyName("BELIFI MAHAJAYA NUSANTARA PT")).toBe(true);
    expect(isCompanyName("CV. Maju")).toBe(true);
    expect(isCompanyName("UD Sumber Rejeki")).toBe(true);
    expect(isCompanyName("BUDI SANTOSO")).toBe(false);
    // A word that merely contains PT is no legal form.
    expect(isCompanyName("APTONO")).toBe(false);
  });

  it("matches an entity by name or short name, else null", () => {
    const entities = [
      { id: "pt", name: "PT Belifi Mahajaya Nusantara", shortName: "Belifi" },
      { id: "owner", name: "Budi Santoso", shortName: "Budi" },
    ];
    expect(matchEntity(entities, "BELIFI MAHAJAYA NUSANTARA PT")?.id).toBe("pt");
    expect(matchEntity(entities, "PT BELIFI")?.id).toBe("pt");
    expect(matchEntity(entities, "SANTOSO BUDI")?.id).toBe("owner");
    expect(matchEntity(entities, "BUDI SANTOSO WIJAYA")).toBeNull();
    expect(matchEntity(entities, "PT LAIN SEKALI")).toBeNull();
    expect(matchEntity(entities, null)).toBeNull();
    expect(matchEntity(entities, "PT")).toBeNull();
  });

  it("writes a person's name in title case", () => {
    expect(titleCase("BUDI  SANTOSO")).toBe("Budi Santoso");
  });
});
