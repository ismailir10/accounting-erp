import { describe, expect, it } from "vitest";
import { COA_TEMPLATE } from "@/lib/coa/template";
import {
  amountsIn,
  compiledSentence,
  draftSummary,
  flagNone,
  flagTitle,
  keywordHints,
  NOT_UNDERSTOOD,
  parseInstruction,
  REFUSAL,
  scopeAccount,
  validateDraft,
  type InstructionDraft,
} from "@/lib/instructions/compile";

/** Instruksi kantor's own reader and the closed schema (cycle 2026-10-18-instruksi-kantor): pure, no database, no model. */
const ACCOUNTS = [...COA_TEMPLATE.map(scopeAccount), scopeAccount({ code: "1101", name: "Bank BCA Giro", type: "ASET", fsLine: "KAS_SETARA_KAS", isBank: true })];
const parse = (s: string) => parseInstruction(s, ACCOUNTS);
const draft = (s: string) => {
  const r = parse(s);
  if (!r.ok) throw new Error(`${s}: ${r.error}`);
  return r.draft;
};
const refusal = (s: string) => {
  const r = parse(s);
  if (r.ok) throw new Error(`${s} compiled`);
  return r;
};
const D = (d: Partial<InstructionDraft>): InstructionDraft => ({ kind: "ACCOUNT", pattern: null, direction: null, accountCode: null, taxTag: null, minAmount: null, inclusive: false, ...d });

describe("Aturan akun", () => {
  it("reads the keyword before the verb and the account after it, the direction from a BEBAN account with a note", () => {
    const r = parse("biaya admin bank selalu 6190");
    expect(r).toEqual({ ok: true, draft: D({ pattern: "BIAYA ADMIN BANK", direction: "OUT", accountCode: "6190" }), notes: ["Arah: uang keluar, karena 6190 akun beban."] });
  });

  it("a quoted keyword wins; a direction word after it, → and = are verbs", () => {
    expect(draft('"BIAYA ADM" keluar → 6190')).toEqual(D({ pattern: "BIAYA ADM", direction: "OUT", accountCode: "6190" }));
    expect(draft('"BIAYA ADM" -> 6190')).toEqual(D({ pattern: "BIAYA ADM", direction: "OUT", accountCode: "6190" }));
    expect(draft("“Tokopedia” masuk = 4100")).toEqual(D({ pattern: "TOKOPEDIA", direction: "IN", accountCode: "4100" }));
  });

  it("a leading direction phrase is removed and sets the direction; *ke* and *masuk ke* are verbs", () => {
    expect(draft("uang masuk dari TOKOPEDIA ke 4100")).toEqual(D({ pattern: "TOKOPEDIA", direction: "IN", accountCode: "4100" }));
    expect(draft("pembayaran ke PT MAJU JAYA selalu 5100")).toEqual(D({ pattern: "PT MAJU JAYA", direction: "OUT", accountCode: "5100" }));
    expect(draft("TOKOPEDIA masuk ke 4100")).toEqual(D({ pattern: "TOKOPEDIA", direction: "IN", accountCode: "4100" }));
    expect(draft("pengeluaran GOJEK selalu ke akun 6140")).toEqual(D({ pattern: "GOJEK", direction: "OUT", accountCode: "6140" }));
  });

  it("an account by its exact name, a PENDAPATAN account means money in, any other type both ways", () => {
    expect(parse("TOKOPEDIA selalu Penjualan")).toEqual({ ok: true, draft: D({ pattern: "TOKOPEDIA", direction: "IN", accountCode: "4100" }), notes: ["Arah: uang masuk, karena 4100 akun pendapatan."] });
    expect(parse("BANK MEGA SYARIAH selalu 2210")).toEqual({ ok: true, draft: D({ pattern: "BANK MEGA SYARIAH", accountCode: "2210" }), notes: [] });
  });

  it("a tax tag by its label", () => {
    expect(draft("PT PAKAN JAYA selalu 5100 dengan PPN Masukan")).toEqual(D({ pattern: "PT PAKAN JAYA", direction: "OUT", accountCode: "5100", taxTag: "PPN_MASUKAN" }));
    expect(draft("KONSULTAN PAJAK ANDI selalu 6190 PPh 23")).toEqual(D({ pattern: "KONSULTAN PAJAK ANDI", direction: "OUT", accountCode: "6190", taxTag: "PPH_23" }));
    expect(draft("SEWA KANTOR selalu 6120 pph 4(2)").taxTag).toBe("PPH_4_2");
  });
});

describe("Tandai", () => {
  it("every amount form, read in whole Rupiah, and both operators", () => {
    const f = (s: string) => draft(s);
    expect(f("tandai pengeluaran > Rp10 jt")).toEqual(D({ kind: "FLAG", direction: "OUT", minAmount: 10_000_000n }));
    expect(f("tandai pengeluaran lebih dari 10 juta")).toMatchObject({ minAmount: 10_000_000n, inclusive: false });
    expect(f("tandai pengeluaran di atas Rp 10.000.000")).toMatchObject({ minAmount: 10_000_000n, inclusive: false });
    expect(f("tandai pengeluaran di atas Rp 10.000.000,00")).toMatchObject({ minAmount: 10_000_000n });
    expect(f("tandai pengeluaran di atas 500 rb")).toMatchObject({ minAmount: 500_000n });
    expect(f("tandai pengeluaran di atas 1,5 M")).toMatchObject({ minAmount: 1_500_000_000n });
    expect(f("tandai pengeluaran di atas 2 miliar")).toMatchObject({ minAmount: 2_000_000_000n });
    expect(f("tandai pengeluaran di atas 1.5 jt")).toMatchObject({ minAmount: 1_500_000n });
    expect(f("tandai pengeluaran ≥ Rp10 jt")).toMatchObject({ minAmount: 10_000_000n, inclusive: true });
    expect(f("tandai pengeluaran >= Rp10 jt")).toMatchObject({ inclusive: true });
    expect(f("tandai pengeluaran minimal Rp10 jt")).toMatchObject({ inclusive: true });
    expect(f("tandai pengeluaran paling sedikit Rp10 jt")).toMatchObject({ inclusive: true });
    expect(f("tandai pengeluaran mulai Rp10 jt")).toMatchObject({ inclusive: true });
  });

  it("direction, optional keyword, or both ways", () => {
    expect(draft("cek penerimaan TOKOPEDIA di atas 50 jt")).toEqual(D({ kind: "FLAG", pattern: "TOKOPEDIA", direction: "IN", minAmount: 50_000_000n }));
    expect(draft("tandai semua mutasi di atas Rp 100 jt")).toEqual(D({ kind: "FLAG", minAmount: 100_000_000n }));
    expect(draft("tandai pembayaran ke PT MAJU JAYA di atas 5 jt")).toEqual(D({ kind: "FLAG", pattern: "PT MAJU JAYA", direction: "OUT", minAmount: 5_000_000n }));
  });

  it("a fraction of a Rupiah is refused", () => {
    expect(refusal("tandai pengeluaran di atas Rp 10.000.000,50")).toMatchObject({ error: REFUSAL.fraction, refused: true });
    expect(refusal("tandai pengeluaran di atas 1,2345678 jt")).toMatchObject({ error: REFUSAL.fraction });
  });

  it("without an amount it is not understood", () => {
    expect(refusal("tandai pengeluaran besar")).toMatchObject({ error: NOT_UNDERSTOOD, refused: false });
  });
});

describe("Tahan di Review", () => {
  it("a keyword, a direction phrase and an optional amount", () => {
    expect(draft("PT MAJU JAYA selalu ke Review")).toEqual(D({ kind: "HOLD", pattern: "PT MAJU JAYA" }));
    expect(draft("tahan pembayaran ke PT MAJU JAYA")).toEqual(D({ kind: "HOLD", pattern: "PT MAJU JAYA", direction: "OUT" }));
    expect(draft("tahan pembayaran ke PT MAJU JAYA di atas Rp 50 jt")).toEqual(D({ kind: "HOLD", pattern: "PT MAJU JAYA", direction: "OUT", minAmount: 50_000_000n }));
  });

  it("a hold by amount only is refused with the Otomasi pointer", () => {
    expect(refusal("semua mutasi di atas Rp 50 jt ke Review")).toEqual({ ok: false, error: REFUSAL.holdAmount, refused: true });
    expect(refusal("tahan semua pembayaran di atas Rp 50 jt")).toMatchObject({ error: REFUSAL.holdAmount });
  });
});

describe("refusals", () => {
  it.each([
    ["akrualkan sewa Rp 5 jt setiap bulan", REFUSAL.journal],
    ["catat jurnal gaji tiap bulan", REFUSAL.journal],
    ["susutkan mobil kantor", REFUSAL.journal],
    ["amortisasi sewa dibayar dimuka", REFUSAL.journal],
    ["tandai beban yang naik lebih dari 20%", REFUSAL.flux],
    ["kabari kalau ada fluktuasi", REFUSAL.flux],
    ["PT MAJU JAYA bagi 50/50 ke 6190 dan 6120", REFUSAL.split],
    ["sebagian TOKOPEDIA ke 4200", REFUSAL.split],
    ["usulan AI di atas Rp 10 jt harus minta persetujuan partner", REFUSAL.ai],
    ["partner harus menyetujui semua jurnal", REFUSAL.journal],
    ["PT MAJU JAYA selalu 6190 mulai Januari", REFUSAL.date],
    ["TOKOPEDIA selalu 4100 sebelum tanggal 15", REFUSAL.date],
    ["BIAYA ADM selalu 6190 dan BIAYA TRF selalu 7100", REFUSAL.multiple],
    ["BIAYA ADM dan BIAYA TRF selalu 7100", REFUSAL.multiple],
    ["BIAYA ADM selalu 6190\nGOJEK selalu 6140", REFUSAL.multiple],
    ["BIAYA ADM selalu 6190 atau 7100", REFUSAL.multiple],
  ])("%s", (sentence, error) => {
    expect(refusal(sentence)).toMatchObject({ error, refused: true });
  });

  it("a generic keyword, an account no rule may target, and an account no chart has", () => {
    expect(refusal("TRANSFER selalu 6190")).toMatchObject({ error: 'Kata kunci "TRANSFER" tidak menyebut pengirim atau penerima, jadi tidak bisa dijadikan aturan.', refused: true });
    expect(refusal("BI FAST selalu 6190")).toMatchObject({ refused: true, field: "pattern" });
    expect(refusal("BIAYA ADM selalu 1999")).toMatchObject({ error: "Akun 1999 tidak bisa menjadi tujuan aturan.", refused: true });
    for (const code of ["3200", "3290", "1101"]) expect(refusal(`BIAYA ADM selalu ${code}`).error).toBe(`Akun ${code} tidak bisa menjadi tujuan aturan.`);
    for (const code of ["1190", "1199"]) expect(refusal(`BIAYA ADM selalu ${code}`).error).toBe("Transfer antar rekening dipasangkan oleh Buku, bukan oleh aturan.");
    expect(refusal("BIAYA ADM selalu 6195")).toMatchObject({ error: "Akun 6195 tidak ada di bagan akun klien ini.", refused: true });
  });

  it("an unrecognised sentence is not understood (AI may be offered), and length limits", () => {
    expect(refusal("kalau ada yang aneh kabari saya")).toEqual({ ok: false, error: NOT_UNDERSTOOD, refused: false });
    expect(refusal("BIAYA ADM selalu Beban yang tidak ada")).toMatchObject({ error: NOT_UNDERSTOOD, refused: false });
    expect(refusal("   ")).toMatchObject({ error: REFUSAL.empty });
    expect(refusal(`${"X".repeat(290)} selalu 6190`)).toMatchObject({ error: REFUSAL.long });
    expect(refusal("AB selalu 6190")).toMatchObject({ error: "Kata kunci harus 3–60 karakter.", field: "pattern" });
  });
});

describe("the closed schema", () => {
  const ok = { kind: "ACCOUNT", pattern: "biaya  adm", direction: "OUT", accountCode: "6190", taxTag: null, minAmount: null, inclusive: false };
  const v = (o: unknown) => validateDraft(o, ACCOUNTS);

  it("normalises the keyword and accepts the amount as digits, a bigint or a safe integer", () => {
    expect(v(ok)).toEqual({ ok: true, draft: D({ pattern: "BIAYA ADM", direction: "OUT", accountCode: "6190" }) });
    for (const minAmount of ["10000000", 10_000_000n, 10_000_000]) {
      expect(v({ ...ok, kind: "FLAG", accountCode: null, pattern: null, minAmount, inclusive: true })).toEqual({ ok: true, draft: D({ kind: "FLAG", direction: "OUT", minAmount: 10_000_000n, inclusive: true }) });
    }
  });

  it("refuses unknown and missing keys, wrong types and what a kind does not use", () => {
    expect(v({ ...ok, note: "x" })).toMatchObject({ ok: false, error: "Isian instruksi tidak dikenal: note." });
    const short = Object.fromEntries(Object.entries(ok).filter(([k]) => k !== "taxTag"));
    expect(v(short)).toMatchObject({ ok: false, error: "Isian instruksi kurang: taxTag." });
    expect(v(null)).toMatchObject({ ok: false });
    expect(v([ok])).toMatchObject({ ok: false });
    expect(v({ ...ok, kind: "NONE" })).toMatchObject({ ok: false, field: "kind" });
    expect(v({ ...ok, direction: "SIDEWAYS" })).toMatchObject({ ok: false, field: "direction" });
    expect(v({ ...ok, taxTag: "PPH_99" })).toMatchObject({ ok: false, field: "taxTag" });
    expect(v({ ...ok, minAmount: "5" })).toMatchObject({ ok: false, field: "minAmount" });
    expect(v({ ...ok, kind: "FLAG", pattern: null, accountCode: null, minAmount: null })).toMatchObject({ ok: false, field: "minAmount" });
    expect(v({ ...ok, kind: "FLAG", minAmount: "5" })).toMatchObject({ ok: false, field: "accountCode" });
    expect(v({ ...ok, kind: "HOLD", accountCode: null, taxTag: "PPH_23" })).toMatchObject({ ok: false, field: "taxTag" });
    expect(v({ ...ok, kind: "HOLD", accountCode: null, pattern: null })).toMatchObject({ ok: false, field: "pattern" });
    expect(v({ ...ok, kind: "FLAG", accountCode: null, minAmount: "0" })).toMatchObject({ ok: false, field: "minAmount" });
    expect(v({ ...ok, kind: "FLAG", accountCode: null, minAmount: "1.5" })).toMatchObject({ ok: false, field: "minAmount" });
    expect(v({ ...ok, kind: "FLAG", accountCode: null, minAmount: 1.5 })).toMatchObject({ ok: false, field: "minAmount" });
    expect(v({ ...ok, inclusive: "ya" })).toMatchObject({ ok: false, field: "inclusive" });
  });

  it("a keyword under 3 or over 60 characters, a generic keyword, a non-classifiable or transfer account, an account not in the charts", () => {
    expect(v({ ...ok, pattern: "AB" })).toMatchObject({ ok: false, field: "pattern" });
    expect(v({ ...ok, pattern: "A".repeat(61) })).toMatchObject({ ok: false, field: "pattern" });
    expect(v({ ...ok, pattern: "TRSF E-BANKING DB" })).toMatchObject({ ok: false, field: "pattern", refused: true });
    expect(v({ ...ok, accountCode: "1999" })).toMatchObject({ ok: false, error: "Akun 1999 tidak bisa menjadi tujuan aturan." });
    expect(v({ ...ok, accountCode: "1199" })).toMatchObject({ ok: false, error: REFUSAL.transfer });
    expect(v({ ...ok, accountCode: "6195" })).toMatchObject({ ok: false, error: "Akun 6195 tidak ada di bagan akun klien ini.", field: "accountCode" });
    expect(validateDraft(ok, [])).toMatchObject({ ok: false, field: "accountCode" });
  });
});

describe("words", () => {
  it("the compiled sentence, the control's title and Riwayat's summary", () => {
    const rule = D({ pattern: "BIAYA ADM", direction: "OUT", accountCode: "6190" });
    expect(compiledSentence(rule, { accountName: "Beban Umum Lain-lain", firmWide: true })).toBe('Mutasi keluar yang keterangannya memuat "BIAYA ADM" → 6190 Beban Umum Lain-lain, sebelum aturan kantor lain.');
    expect(draftSummary(rule)).toBe('Aturan akun: keluar, memuat "BIAYA ADM" → 6190');
    const flag = D({ kind: "FLAG", direction: "OUT", minAmount: 10_000_000n });
    expect(flagTitle(flag)).toBe("Pengeluaran di atas Rp 10.000.000");
    expect(flagNone(flag)).toBe("Tidak ada pengeluaran di atas Rp 10.000.000");
    expect(flagTitle({ ...flag, inclusive: true, direction: "IN", pattern: "TOKOPEDIA" })).toBe('Penerimaan minimal Rp 10.000.000 yang memuat "TOKOPEDIA"');
    expect(draftSummary(flag)).toBe("Tandai: keluar, di atas Rp 10.000.000");
    const hold = D({ kind: "HOLD", pattern: "PT MAJU JAYA" });
    expect(compiledSentence(hold, { firmWide: false })).toBe('Mutasi yang keterangannya memuat "PT MAJU JAYA" menunggu di Review.');
    expect(draftSummary(hold)).toBe('Tahan di Review: keduanya, memuat "PT MAJU JAYA"');
  });

  it("amounts in a sentence: money only, never an account code", () => {
    expect(amountsIn("tandai pengeluaran > Rp10 jt ke 6190 atau 1.500.000 dan 2,5 M")).toEqual([10_000_000n, 1_500_000n, 2_500_000_000n]);
    expect(amountsIn("BIAYA ADM selalu 6190")).toEqual([]);
  });
});

describe("keyword hints", () => {
  it("each word of the hint is a prefix of at least 3 letters of the typed words, in order", () => {
    expect(keywordHints("BIAYA ADMIN BANK", ["BIAYA ADM", "BIAYA ADM BULANAN", "ADM BULANAN", "BIAYA TRANSFER", "BI ADM", "ADM BIAYA", "BIAYA ADMIN BANK", "biaya  adm"])).toEqual(["BIAYA ADM"]);
    expect(keywordHints("pembayaran tokopedia", ["TOKOPEDIA", "PEMB TOKO", "PEMBAYARAN"])).toEqual(["TOKOPEDIA", "PEMB TOKO", "PEMBAYARAN"]);
    expect(keywordHints("BIAYA ADMIN BANK", [])).toEqual([]);
  });
});
