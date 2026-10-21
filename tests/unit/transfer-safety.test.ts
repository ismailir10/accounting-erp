import { describe, expect, it } from "vitest";
import { matchTransfers, thirdPartyName } from "@/lib/classify/transfer";

/** UC-B2: a transfer pair needs a clean description on both sides and exactly one candidate; nothing is auto-picked. */
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const line = (id: string, bankAccountId: string, date: string, description: string, amount: bigint, entityId = "pt") =>
  ({ id, entityId, bankAccountId, date: d(date), description, merchantKey: "", direction: amount < 0n ? ("OUT" as const) : ("IN" as const), amount });
const own = [
  { entityId: "pt", names: ["PT GEMILANG MAHAKARYA NUSA"] },
  { entityId: "owner", names: ["RANI KUSUMAWARDANI"] },
];

describe("third-party names", () => {
  it("finds a supplier or customer, not banks, channels, references or the group's own names", () => {
    const names = own.flatMap((e) => e.names);
    expect(thirdPartyName("TRSF E-BANKING DB 1305/FTSCY/WS912345 PT SUMBER BAHAN MAKMUR", names)).toBe("PT SUMBER BAHAN MAKMUR");
    expect(thirdPartyName("PINDAH BUKU KE BCA PT GEMILANG MAHAKARYA NUSA", names)).toBeNull();
    expect(thirdPartyName("TRSF E-BANKING DB 2005/FTSCY/WS955555 RANI KUSUMAWARDANI PINJAMAN PEMILIK", names)).toBeNull();
    expect(thirdPartyName("BI-FAST CR 20260513 ANTAR REKENING SENDIRI", names)).toBeNull();
    expect(thirdPartyName("TRANSFER DARI CV MAJU JAYA", names)).toBe("CV MAJU JAYA");
    // How banks really print own transfers: a cut name (BCA), Mandiri's MCM, BRI's NBMB.
    expect(thirdPartyName("TRSF E-BANKING CR 1305/FTSCY/WS912345 30000000.00 PT GEMILANG MAHAKAR", names)).toBeNull();
    expect(thirdPartyName("Transfer Dana Masuk MCM InhouseTrf DARI PT GEMILANG MAHAKARYA NUSA", names)).toBeNull();
    expect(thirdPartyName("NBMB RANI KUSUMAWARDANI TO PT GEMILANG MAHAKARYA NUSA TGL 13/05", names)).toBeNull();
    // Part of a name is not the name: "PT SUMBER …" shares only "PT" with the group.
    expect(thirdPartyName("TRSF E-BANKING DB PT SUMBER GEMILANG", names)).toBe("PT SUMBER GEMILANG");
  });
});

describe("transfer matcher safety", () => {
  it("never pairs a supplier withdrawal with a stranger's credit of the same amount (the netted Rp 100 jt / Rp 300 jt case)", () => {
    const r = matchTransfers(
      [
        line("w1", "bca", "2026-05-12", "TRSF E-BANKING DB 1205/FTSCY/WS911111 PT SUPPLIER BAJA PRIMA", -100_000_000n),
        line("c1", "mdr", "2026-05-12", "TRSF E-BANKING CR 1205/FTSCY/WS922222 CV PELANGGAN SETIA", 100_000_000n),
        line("w2", "bca", "2026-05-20", "TRANSFER KE UD BESI KUAT", -300_000_000n),
        line("c2", "mdr", "2026-05-21", "TRANSFER DARI BCA PT GEMILANG MAHAKARYA NUSA", 300_000_000n),
      ],
      own,
    );
    expect(r.has("w1")).toBe(false);
    expect(r.has("c1")).toBe(false);
    expect(r.has("w2")).toBe(false);
    // The clean half would be an own transfer whose other half isn't here, but a same-amount line naming someone else sits on the other
    // side: it waits in Review (suggestion 1199) instead of auto-posting.
    expect(r.get("c2")).toMatchObject({ accountCode: "1199", confidence: 0.8 });
    expect(r.get("c2")?.matchedTxId).toBeUndefined();
    expect(r.get("c2")?.reason).toMatch(/^Bernominal sama dengan mutasi yang menyebut pihak lain \(20 Mei 2026 Rp 300\.000\.000\)/);
  });

  it("pairs exactly one candidate; with two candidates every line involved waits in Review naming them", () => {
    const one = matchTransfers([line("o", "mdr", "2026-05-13", "PINDAH BUKU KE BCA PT GEMILANG MAHAKARYA NUSA", -30_000_000n), line("i", "bca", "2026-05-13", "TRSF E-BANKING CR PINDAH BUKU DARI MANDIRI", 30_000_000n)], own);
    expect(one.get("o")).toMatchObject({ accountCode: "1199", confidence: 0.99, matchedTxId: "i" });

    const two = matchTransfers(
      [
        line("o", "mdr", "2026-05-13", "PINDAH BUKU KE BCA PT GEMILANG MAHAKARYA NUSA", -30_000_000n),
        line("i1", "bca", "2026-05-13", "TRSF E-BANKING CR PINDAH BUKU DARI MANDIRI", 30_000_000n),
        line("i2", "own-bca", "2026-05-14", "TRSF E-BANKING CR PT GEMILANG MAHAKARYA NUSA", 30_000_000n, "owner"),
      ],
      own,
    );
    for (const id of ["o", "i1", "i2"]) {
      expect(two.get(id)?.matchedTxId).toBeUndefined();
      expect(two.get(id)!.confidence).toBeLessThan(0.9); // below auto-post: Review
    }
    expect(two.get("o")?.reason).toBe("Tidak dipasangkan otomatis: 2 mutasi lain bernominal sama ikut cocok (13 Mei 2026 Rp 30.000.000; 14 Mei 2026 Rp 30.000.000). Pilih akunnya di Review");
    expect(two.get("i2")?.accountCode).toBe("1190");
  });

  it("an incoming line two outgoing lines could pair with pairs with neither", () => {
    const r = matchTransfers(
      [
        line("o1", "mdr", "2026-05-13", "PINDAH BUKU KE BCA", -5_000_000n),
        line("o2", "own-bca", "2026-05-13", "TRSF E-BANKING DB PT GEMILANG MAHAKARYA NUSA", -5_000_000n, "owner"),
        line("i", "bca", "2026-05-13", "TRSF E-BANKING CR PINDAH BUKU", 5_000_000n),
      ],
      own,
    );
    expect([...r.values()].some((c) => c.matchedTxId)).toBe(false);
    expect(r.get("i")?.reason).toMatch(/^Tidak dipasangkan otomatis: 2 mutasi lain/);
    // Each out's suggestion follows its own candidate: o2 (the owner's) is intercompany, o1 an own-account move.
    expect([r.get("o1")?.accountCode, r.get("o2")?.accountCode]).toEqual(["1199", "1190"]);
  });

  it("never pairs a line the reviewer took out of a pair", () => {
    const r = matchTransfers([{ ...line("o", "mdr", "2026-05-13", "PINDAH BUKU KE BCA", -5_000_000n), pairRefused: true }, line("i", "bca", "2026-05-13", "TRSF E-BANKING CR PINDAH BUKU", 5_000_000n)], own);
    expect(r.get("i")?.matchedTxId).toBeUndefined();
    expect(r.has("o")).toBe(false);
  });
});

describe("transfers to the group's owner as banks print them", () => {
  // PT + its owner in one client, the owner without a bank account in Buku: the PT's side is all there is.
  const group = [
    { entityId: "pt", names: ["PT SINARLA MAHAJAYA NUSANTARA", "PT SINARLA"] },
    { entityId: "owner", names: ["BUDI HARTONO"] },
  ];
  const names = group.flatMap((e) => e.names);

  it("reads the company name without its legal form, and channel words, as no third party", () => {
    expect(thirdPartyName("TRSF E-BANKING DB 2506/FTSCY/WS95051 152000000.00 Sinarla BUDI HARTONO", names)).toBeNull();
    expect(thirdPartyName("BI-FAST DB BIF TRANSFER KE 002 BUDI HARTONO", names)).toBeNull();
    // A customer paying the company still names the customer.
    expect(thirdPartyName("TRSF E-BANKING CR 0706/FTSCY/WS95271 70475000.00 bayar nota Sinarla DINA PUSPITA", names)).toBe("NOTA DINA PUSPITA");
  });

  it("an own-name transfer to the owner goes to 1190, a short code beside the owner's name waits in Review on 1190", () => {
    const r = matchTransfers(
      [
        line("a", "bca", "2026-06-25", "TRSF E-BANKING DB 2506/FTSCY/WS95051 152000000.00 Sinarla BUDI HARTONO", -152_000_000n),
        line("b", "bca", "2026-06-03", "BI-FAST DB BIF TRANSFER KE 002 BUDI HARTONO KBB", -105_000_000n),
        line("c", "bca", "2026-06-03", "BI-FAST DB BIF BIAYA TXN KE 002 BUDI HARTONO KBB", -2_500n),
        line("d", "bca", "2026-06-07", "TRSF E-BANKING CR 0706/FTSCY/WS95271 70475000.00 bayar nota Sinarla DINA PUSPITA", 70_475_000n),
      ],
      group,
    );
    expect(r.get("a")).toMatchObject({ accountCode: "1190", confidence: 0.92 });
    expect(r.get("b")).toMatchObject({ accountCode: "1190", confidence: 0.8 });
    expect(r.get("b")?.reason).toMatch(/BUDI HARTONO.*"KBB"/);
    // The fee is the bank's (a firm rule), the customer's payment is a sale: neither is the matcher's.
    expect(r.has("c")).toBe(false);
    expect(r.has("d")).toBe(false);
  });

  it("a remark repeating one word of the payer's own name still waits in Review on 1190 (never left to AI as a supplier)", () => {
    const full = [{ entityId: "pt", names: ["PT SINARLA MAHAJAYA NUSANTARA"] }, { entityId: "owner", names: ["BUDI HARTONO"] }];
    const r = matchTransfers(
      [
        line("a", "bca", "2026-06-25", "TRSF E-BANKING DB 2506/FTSCY/WS95051 152000000.00 Sinarla BUDI HARTONO", -152_000_000n),
        line("d", "bca", "2026-06-07", "TRSF E-BANKING CR 0706/FTSCY/WS95271 70475000.00 bayar nota Sinarla DINA PUSPITA", 70_475_000n),
        // The word belongs to the payer, not to the receiving owner: from the owner's account it is still a name to check.
        line("o", "jenius", "2026-06-25", "TRSF KE BUDI HARTONO MAHAJAYA", -1_000_000n, "owner"),
      ],
      full,
    );
    expect(r.get("a")).toMatchObject({ accountCode: "1190", confidence: 0.8 });
    expect(r.get("a")?.reason).toMatch(/BUDI HARTONO/);
    expect(r.get("a")?.reason).not.toMatch(/""/);
    expect(r.has("d")).toBe(false);
    expect(r.has("o")).toBe(false);
  });

  it("finds the entity by its name without the legal form when only the full name was kept (short names under 8 letters are dropped)", () => {
    const full = [{ entityId: "pt", names: ["PT SINARLA MAHAJAYA NUSANTARA"] }, { entityId: "owner", names: ["BUDI HARTONO"] }];
    const r = matchTransfers([line("o", "bri", "2026-06-25", "TRSF KE SINARLA MAHAJAYA NUSANTARA", -10_000_000n, "owner")], full);
    expect(r.get("o")).toMatchObject({ accountCode: "1190", confidence: 0.92 });
    // A whole word only: another company whose name starts the same way is not the group.
    expect(matchTransfers([line("x", "bri", "2026-06-25", "TRSF KE SINARLA MAHAJAYA NUSANTARAKU", -10_000_000n, "owner")], full).get("x")?.accountCode).not.toBe("1190");
  });

  it("a real person's name beside the owner's is a payment, not a transfer", () => {
    const r = matchTransfers([line("x", "bca", "2026-06-03", "BI-FAST DB BIF TRANSFER KE 002 BUDI HARTONO UNTUK SUPPLIER KAIN", -5_000_000n)], group);
    expect(r.has("x")).toBe(false);
  });
});

describe("transfer matcher, a group of three companies (an account per party)", () => {
  const group = [
    { entityId: "pt", names: ["PT UJI SEJAHTERA"] },
    { entityId: "cv", names: ["CV MAJU BERSAMA"] },
    { entityId: "owner", names: ["ANDI WIJAYA"] },
  ];
  const ic = (id: string) => `ic-${id}`;
  const toCv = line("p1", "pt-bca", "2026-01-05", "TRSF E-BANKING DB 0501/FTSCY/WS1 CV MAJU BERSAMA", -25_000_000n);
  const fromPt = (id: string, entityId: string) => ({ ...line(id, `${entityId}-bca`, "2026-01-05", "TRSF E-BANKING CR 0501/FTSCY/WS1 PT UJI SEJAHTERA", 25_000_000n), entityId });

  it("a line naming one group company pairs only with that company's line; unpaired, each waits on the named party's account", () => {
    const r = matchTransfers([toCv, fromPt("o1", "owner")], group, ic);
    expect([r.get("p1")?.accountCode, r.get("p1")?.matchedTxId, r.get("o1")?.accountCode, r.get("o1")?.matchedTxId]).toEqual(["ic-cv", undefined, "ic-pt", undefined]);
    // The CV's own receipt from PT pairs: each half on the other's account.
    const paired = matchTransfers([toCv, fromPt("c1", "cv")], group, ic);
    expect([paired.get("p1")?.accountCode, paired.get("p1")?.matchedTxId, paired.get("c1")?.accountCode]).toEqual(["ic-cv", "c1", "ic-pt"]);
  });

  it("a line naming no group company pairs by amount and date as before; with two companies a named line pairs as before", () => {
    const plain = line("p2", "pt-bca", "2026-01-05", "TRSF E-BANKING DB 0501/FTSCY/WS1", -25_000_000n);
    expect(matchTransfers([plain, fromPt("o1", "owner")], group, ic).get("p2")).toMatchObject({ accountCode: "ic-owner", matchedTxId: "o1" });
    // PT's BCA line naming the owner and PT's own Mandiri receipt of the same amount: two companies pair them (1199) as before;
    // three don't (the line names Andi, the receipt is PT's).
    const toAndi = line("p3", "pt-bca", "2026-01-05", "TRSF E-BANKING DB 0501/FTSCY/WS1 ANDI WIJAYA", -25_000_000n);
    const ownIn = line("p4", "pt-mdr", "2026-01-05", "TRSF E-BANKING CR 0501/FTSCY/WS1", 25_000_000n);
    const two = group.filter((e) => e.entityId !== "cv");
    expect(matchTransfers([toAndi, ownIn], two, ic).get("p3")).toMatchObject({ accountCode: "1199", matchedTxId: "p4" });
    const three = matchTransfers([toAndi, ownIn], group, ic).get("p3");
    expect([three?.accountCode, three?.matchedTxId]).toEqual(["ic-owner", undefined]);
  });
});
