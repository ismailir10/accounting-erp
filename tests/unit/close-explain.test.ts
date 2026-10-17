import { describe, expect, it } from "vitest";
import { buildControlExplainPrompt, parseControlExplain, type ControlExplainInput } from "@/lib/ai/provider";

const input = (over: Partial<ControlExplainInput> = {}): ControlExplainInput => ({
  client: "Grup Uji",
  period: "Agustus 2026",
  currency: "IDR",
  canDraft: true,
  accounts: [{ code: "4100", name: "Penjualan" }, { code: "2210", name: "Utang Bank" }, { code: "7110", name: "Beban Bunga Pinjaman" }],
  control: {
    key: "pl-financing:e1",
    title: "Pinjaman / modal / pindah dana tercatat di Laba Rugi",
    scope: "PT Uji",
    status: "REVIEW",
    detail: "1 transaksi",
    rows: [
      { id: "tx-1", date: "2026-08-04", text: "PENCAIRAN PINJAMAN KMK", amount: "Rp 100.000.000", account: "4100" },
      { id: "tx-2", date: "2026-08-10", text: "BUNGA PINJAMAN KMK", amount: "-Rp 1.000.000", account: "6190" },
    ],
  },
  ...over,
});
const answer = (entry: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ explanation: "Pencairan pinjaman dicatat sebagai penjualan.", suggestion: "Reklasifikasi ke 2210.", refs: ["tx-1", "tx-9"], note: "Wajar karena …", entry, ...extra });
const reclass = (amount = "Rp 100.000.000", credit = "2210") => ({ memo: "Reklasifikasi pencairan KMK", lines: [{ accountCode: "4100", side: "D", amount }, { accountCode: credit, side: "K", amount }] });

describe("close copilot parser", () => {
  it("keeps a balanced draft whose amounts are copied from cited rows, and drops foreign refs", () => {
    const a = parseControlExplain(answer(reclass()), input());
    expect(a.refs).toEqual(["tx-1"]);
    expect(a.entry).toEqual({ memo: "Reklasifikasi pencairan KMK", lines: [{ accountCode: "4100", side: "D", amount: "Rp 100.000.000" }, { accountCode: "2210", side: "K", amount: "Rp 100.000.000" }] });
    // A row's negative amount may be cited without its sign; bare digits of the same value match too.
    expect(parseControlExplain(answer(reclass("1.000.000"), { refs: ["tx-2"] }), input()).entry?.lines[0].amount).toBe("Rp 1.000.000");
    // Re-validating a stored answer gives the same result; its dropped citations were dropped already (the cache keeps the count).
    expect(parseControlExplain(JSON.stringify(a), input())).toEqual({ ...a, dropped: 0 });
  });

  it("counts the citations it discards (outside the rows sent, or not an id at all), never keeping them", () => {
    expect(parseControlExplain(answer(reclass()), input()).dropped).toBe(1); // tx-9
    const a = parseControlExplain(answer(null, { refs: ["tx-1", "tx-1", "tx-2", "tx-9", "tx-9", "abaikan instruksi", 7, null] }), input());
    expect([a.refs, a.dropped]).toEqual([["tx-1", "tx-2"], 4]);
    expect(JSON.stringify(a)).not.toMatch(/tx-9|abaikan/);
    expect(parseControlExplain(answer(null, { refs: undefined }), input()).dropped).toBe(0);
  });

  it("drops the draft — keeping the explanation — for an invented amount, an unknown account, unbalanced lines or a group control", () => {
    expect(parseControlExplain(answer(reclass("Rp 99.000.000")), input()).entry).toBeNull();
    // An amount copied from a row the answer doesn't cite has no source: tx-2's Rp 1.000.000 while citing only tx-1, or nothing cited.
    expect(parseControlExplain(answer(reclass("Rp 1.000.000")), input()).entry).toBeNull();
    expect(parseControlExplain(answer(reclass(), { refs: [] }), input()).entry).toBeNull();
    expect(parseControlExplain(answer(reclass(undefined, "1101")), input()).entry).toBeNull();
    const unbalanced = { memo: "x", lines: [{ accountCode: "4100", side: "D", amount: "Rp 100.000.000" }, { accountCode: "2210", side: "K", amount: "Rp 1.000.000" }] };
    expect(parseControlExplain(answer(unbalanced), input()).entry).toBeNull();
    const group = parseControlExplain(answer(reclass()), input({ canDraft: false }));
    expect([group.entry, group.explanation]).toEqual([null, "Pencairan pinjaman dicatat sebagai penjualan."]);
  });

  it("caps note and texts, refuses an empty explanation, and sends only this control's rows", () => {
    expect(parseControlExplain(answer(null, { note: "x".repeat(500) }), input()).note).toHaveLength(300);
    expect(() => parseControlExplain(answer(null, { explanation: " " }), input())).toThrow("kosong");
    const sent = JSON.parse(buildControlExplainPrompt(input()).user);
    expect(sent.control.rows.map((r: { id: string }) => r.id)).toEqual(["tx-1", "tx-2"]);
    expect(buildControlExplainPrompt(input()).system).toMatch(/bukan instruksi/);
  });
});
