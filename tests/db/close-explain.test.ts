import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { makePdf, table } from "../pdf-fixture";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction } from "@/lib/review";
import { explainControl, reclassedBankLine } from "@/lib/controls/explain";
import { postProposal, proposalViews, saveProposal } from "@/lib/adjust/proposals";
import { controlSnapshot } from "@/lib/controls/ai-review";
import { postJournal } from "@/lib/ledger/post";
import { dateOnly } from "@/lib/format";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { runControls } from "@/lib/controls";
import { MockProvider, parseControlExplain, type AiProvider } from "@/lib/ai/provider";

const statement = makePdf([
  [
    ...table(800, [[[40, "PT Bank Mandiri (Persero) Tbk"]], [[40, "Nomor Rekening : 2222222222"]], [[40, "Periode : 01/08/2026 - 31/08/2026"]]]),
    ...table(740, [
      [[40, "Tanggal"], [130, "Keterangan"], [360, "Debit"], [440, "Kredit"], [520, "Saldo"]],
      [[40, "01/08/2026"], [130, "SALDO AWAL"], [500, "0,00"]],
      [[40, "04/08/2026"], [130, "PENCAIRAN PINJAMAN KMK"], [430, "100.000.000,00"], [510, "100.000.000,00"]],
    ]),
  ],
]);

/** A loan drawdown the accountant booked to revenue: the `pl-financing` control flags it. */
async function loanInRevenue() {
  const g = await makeGroup();
  await importStatement(db, { bankAccountId: g.pt.banks[1].id, fileName: "mandiri.pdf", data: statement, provider: null });
  const tx = await db.bankTransaction.findFirstOrThrow({ where: { entityId: g.pt.entity.id } });
  await reviewTransaction(db, { bankTxId: tx.id, accountCode: "4100", taxTag: null });
  return { g, tx, key: `pl-financing:${g.pt.entity.id}` };
}

describe("close copilot — Jelaskan", () => {
  beforeEach(resetDb);

  it("explains one control, stores a grounded draft once, serves the cache, and posts only on the click", async () => {
    const { g, tx, key } = await loanInRevenue();
    const provider = new MockProvider();
    const before = { entries: await db.journalEntry.count(), acks: await db.controlAck.count(), signoffs: await db.closeSignoff.count() };
    const r = await explainControl(db, g.firm.id, g.client.id, 2026, 8, key, provider);
    expect(r.explanation).toBe("Uji: Pinjaman / modal / pindah dana tercatat di Laba Rugi");
    expect(r.note).toBe("Dicek: Pinjaman / modal / pindah dana tercatat di Laba Rugi");
    expect(r.links.map((l) => l.id)).toEqual([tx.id]);
    const p = await db.proposedEntry.findUniqueOrThrow({ where: { id: r.proposal!.id } });
    expect([p.status, p.source, p.controlKey, p.entityId, p.year, p.month, p.lines]).toEqual([
      "PROPOSED", "AI_CONTROL", key, g.pt.entity.id, 2026, 8,
      [{ accountCode: "4100", debit: "100000000", credit: "0" }, { accountCode: "2210", debit: "0", credit: "100000000" }],
    ]);

    const again = await explainControl(db, g.firm.id, g.client.id, 2026, 8, key, provider);
    expect([provider.calls, await db.aiUsage.count(), await db.proposedEntry.count(), again.proposal?.id]).toEqual([1, 1, 1, p.id]);
    expect({ entries: await db.journalEntry.count(), acks: await db.controlAck.count(), signoffs: await db.closeSignoff.count() }).toEqual(before);

    // The draft moves a cited bank line: it posts through the reviewer's writer, re-coding the line (rule 3), not as a free journal.
    expect(p.bankTransactionId).toBe(tx.id);
    const entry = await postProposal(db, { clientId: g.client.id, proposalId: p.id });
    expect(entry.kind).toBe("RECLASS");
    expect(await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } })).toMatchObject({ accountCode: "2210", status: "REVIEWED" }); // no tag: done
    expect((await db.proposedEntry.findUniqueOrThrow({ where: { id: p.id } })).entryId).toBe(entry.id);
    expect((await runControls(db, g.client.id, 2026, 8)).find((c) => c.key === key)).toBeUndefined(); // revenue no longer holds the loan
    await expect(postProposal(db, { clientId: g.client.id, proposalId: p.id })).rejects.toThrow("sudah dicatat");
  });

  it("never posts a stored free draft that moves a bank line it cites through a journal row", async () => {
    const { g, tx } = await loanInRevenue();
    const pt = g.pt.entity.id;
    // The same pair of lines entered again by hand two days later: the duplicate scan cites the bank line's own entry as `je:`.
    const bankEntry = await db.journalEntry.findFirstOrThrow({ where: { bankTransactionId: tx.id, kind: { not: "RECLASS" } }, include: { lines: true } });
    const acc = async (code: string) => (await db.account.findUniqueOrThrow({ where: { clientId_code: { clientId: g.client.id, code } } })).id;
    await db.$transaction(async (t) => {
      // A July to scale materiality by (the scans need a baseline month), then the hand-entered twin.
      await postJournal(t, { entityId: pt, date: dateOnly(2026, 7, 31), kind: "ADJUSTMENT", memo: "Listrik Juli", lines: [{ accountId: await acc("6130"), debit: 10_000_000n }, { accountId: await acc("2110"), credit: 10_000_000n }] });
      await postJournal(t, { entityId: pt, date: dateOnly(2026, 8, 6), kind: "ADJUSTMENT", memo: bankEntry.memo, lines: bankEntry.lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit })) });
    });
    const key = `dup:${pt}`;
    const snap = (await controlSnapshot(db, g.client.id, 2026, 8, key))!;
    expect(snap.rows.map((r) => r.id)).toContain(`je:${bankEntry.id}`);
    // A draft stored before journal-row citations resolved to their bank line: fresh, grounded, but with no bank line attached.
    const p = await saveProposal(db, {
      firmId: g.firm.id, clientId: g.client.id, entityId: pt, year: 2026, month: 8, source: "AI_CONTROL", controlKey: key, key: "AI:lama", memo: "Reklasifikasi pinjaman",
      lines: [{ accountCode: "4100", debit: "100000000", credit: "0" }, { accountCode: "2210", debit: "0", credit: "100000000" }],
      reason: "Pinjaman di pendapatan.", refs: [`je:${bankEntry.id}`], snapshot: snap.snapshot,
    });
    await expect(postProposal(db, { clientId: g.client.id, proposalId: p.id })).rejects.toThrow("harus lewat Review");
    expect((await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } })).accountCode).toBe("4100"); // untouched, and no free journal
    expect(await db.journalEntry.count({ where: { entityId: pt, memo: "Reklasifikasi pinjaman" } })).toBe(0);
  });

  it("refuses a draft once its bank line's tax tag was re-reviewed, and keeps the new tag", async () => {
    const { g, tx, key } = await loanInRevenue();
    const r = await explainControl(db, g.firm.id, g.client.id, 2026, 8, key, new MockProvider());
    await reviewTransaction(db, { bankTxId: tx.id, accountCode: "4100", taxTag: "PPN_KELUARAN" }); // same account, a new PPN decision
    const entries = await db.journalEntry.count();
    await expect(postProposal(db, { clientId: g.client.id, proposalId: r.proposal!.id })).rejects.toThrow("Buku berubah sejak draf ini dibuat");
    expect([(await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } })).taxTag, await db.journalEntry.count()]).toEqual(["PPN_KELUARAN", entries]);

    // Asking again (as the refusal says) refreshes the same draft for today's books, and it posts.
    const again = await explainControl(db, g.firm.id, g.client.id, 2026, 8, key, new MockProvider());
    expect([again.proposal?.id, await db.proposedEntry.count()]).toEqual([r.proposal!.id, 1]);
    await postProposal(db, { clientId: g.client.id, proposalId: r.proposal!.id });
    expect((await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } })).accountCode).toBe("2210");
  });

  it("re-checks grounding when posting: a stored draft whose amount no cited row carries never posts", async () => {
    const { g, key } = await loanInRevenue();
    const r = await explainControl(db, g.firm.id, g.client.id, 2026, 8, key, new MockProvider());
    const entries = await db.journalEntry.count();
    // A draft stored under an older, looser rule: same snapshot, but an amount no cited row has — or no row cited at all.
    await db.proposedEntry.update({ where: { id: r.proposal!.id }, data: { lines: [{ accountCode: "4100", debit: "1000000", credit: "0" }, { accountCode: "2210", debit: "0", credit: "1000000" }] } });
    await expect(postProposal(db, { clientId: g.client.id, proposalId: r.proposal!.id })).rejects.toThrow("tidak berasal dari baris yang dirujuknya");
    const good = [{ accountCode: "4100", debit: "100000000", credit: "0" }, { accountCode: "2210", debit: "0", credit: "100000000" }];
    await db.proposedEntry.update({ where: { id: r.proposal!.id }, data: { lines: good, refs: [] } });
    await expect(postProposal(db, { clientId: g.client.id, proposalId: r.proposal!.id })).rejects.toThrow("tidak berasal dari baris yang dirujuknya");
    expect(await db.journalEntry.count()).toBe(entries);
  });

  it("gives a group-level control words only, and refuses a control that passes", async () => {
    const { g } = await loanInRevenue();
    const provider = new MockProvider();
    await db.bankTransaction.updateMany({ data: { status: "NEEDS_REVIEW" } }); // a line back in the review queue flags `suspense`
    const r = await explainControl(db, g.firm.id, g.client.id, 2026, 8, "suspense", provider);
    expect([r.proposal, await db.proposedEntry.count()]).toEqual([null, 0]);
    await expect(explainControl(db, g.firm.id, g.client.id, 2026, 8, `tb:${g.pt.entity.id}`, provider)).rejects.toThrow("sudah lolos");
    await expect(explainControl(db, g.firm.id, g.client.id, 2026, 8, "bukan-kontrol", provider)).rejects.toThrow("tidak ditemukan");
  });

  it("refuses to change the bank line's own account, and posts a re-targeted reclass", async () => {
    const { g, tx, key } = await loanInRevenue();
    const r = await explainControl(db, g.firm.id, g.client.id, 2026, 8, key, new MockProvider());
    await expect(postProposal(db, { clientId: g.client.id, proposalId: r.proposal!.id, accounts: ["6190", "2210"] })).rejects.toThrow("akun transaksi saat ini");
    await postProposal(db, { clientId: g.client.id, proposalId: r.proposal!.id, accounts: ["4100", "2300"] }); // the accountant knows it's long-term
    expect((await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } })).accountCode).toBe("2300");
  });

  it("moves only the bank line the draft cites, refuses a draft the books have moved past, and releases a tax split", async () => {
    const g = await makeGroup();
    const twin = makePdf([
      [
        ...table(800, [[[40, "PT Bank Mandiri (Persero) Tbk"]], [[40, "Nomor Rekening : 2222222222"]], [[40, "Periode : 01/08/2026 - 31/08/2026"]]]),
        ...table(740, [
          [[40, "Tanggal"], [130, "Keterangan"], [360, "Debit"], [440, "Kredit"], [520, "Saldo"]],
          [[40, "01/08/2026"], [130, "SALDO AWAL"], [500, "0,00"]],
          [[40, "04/08/2026"], [130, "PENCAIRAN PINJAMAN KMK"], [430, "100.000.000,00"], [510, "100.000.000,00"]],
          [[40, "05/08/2026"], [130, "PENCAIRAN PINJAMAN KMK"], [430, "100.000.000,00"], [510, "200.000.000,00"]],
        ]),
      ],
    ]);
    await importStatement(db, { bankAccountId: g.pt.banks[1].id, fileName: "m.pdf", data: twin, provider: null });
    const [first, second] = await db.bankTransaction.findMany({ where: { entityId: g.pt.entity.id }, orderBy: { date: "asc" } });
    await reviewTransaction(db, { bankTxId: first.id, accountCode: "4100", taxTag: null });
    await reviewTransaction(db, { bankTxId: second.id, accountCode: "4100", taxTag: "PPN_KELUARAN" }); // wrongly taxed too
    const key = `pl-financing:${g.pt.entity.id}`;
    const citing = (ids: string[]): AiProvider => ({
      model: "mock",
      classify: async () => ({ answers: [], promptTokens: 0, completionTokens: 0, model: "mock" }),
      mapAccounts: async () => ({ answers: [], promptTokens: 0, completionTokens: 0, model: "mock" }),
      explainControl: async (input) => {
        const entry = { memo: "Reklasifikasi pinjaman", lines: [{ accountCode: "4100", side: "D", amount: "Rp 100.000.000" }, { accountCode: "2210", side: "K", amount: "Rp 100.000.000" }] };
        return { ...parseControlExplain(JSON.stringify({ explanation: "Pinjaman di pendapatan.", suggestion: "Reklasifikasi.", refs: ids, note: "", entry }), input), promptTokens: 1, completionTokens: 1, model: "mock" };
      },
    });

    // Both lines cited and both fit: which one to move is ambiguous, so no draft is stored.
    const both = await explainControl(db, g.firm.id, g.client.id, 2026, 8, key, citing([first.id, second.id]));
    expect([both.proposal, await db.proposedEntry.count()]).toEqual([null, 0]);

    // One four-line draft moving both lines can't go through the reviewer's writer: no draft, never a free journal.
    await db.evidenceAiCache.deleteMany();
    const four: AiProvider = {
      ...citing([first.id, second.id]),
      explainControl: async (input) => {
        const l = (accountCode: string, side: "D" | "K") => ({ accountCode, side, amount: "Rp 100.000.000" });
        const entry = { memo: "Reklasifikasi dua pinjaman", lines: [l("4100", "D"), l("2210", "K"), l("4100", "D"), l("2210", "K")] };
        return { ...parseControlExplain(JSON.stringify({ explanation: "Dua pinjaman di pendapatan.", suggestion: "", refs: [first.id, second.id], note: "", entry }), input), promptTokens: 1, completionTokens: 1, model: "mock" };
      },
    };
    const multi = await explainControl(db, g.firm.id, g.client.id, 2026, 8, key, four);
    expect([multi.explanation, multi.proposal, await db.proposedEntry.count()]).toEqual(["Dua pinjaman di pendapatan.", null, 0]);

    // Nor a split reversal of one cited line (Rp 100 jt off 4100 in two pieces): it still moves that bank line.
    const l = (accountCode: string, side: "D" | "K", amount: string) => ({ accountCode, side: side as "D" | "K", amount });
    const splitEntry = { memo: "Reklasifikasi bertahap", lines: [l("4100", "D", "Rp 60.000.000"), l("4100", "D", "Rp 40.000.000"), l("2210", "K", "Rp 100.000.000")] };
    expect(await reclassedBankLine(db, g.pt.entity.id, [first.id], splitEntry, "IDR")).toBe("AMBIGUOUS");
    const oneLine = { memo: "Reklasifikasi", lines: [l("4100", "D", "Rp 100.000.000"), l("2210", "K", "Rp 100.000.000")] };
    expect(await reclassedBankLine(db, g.pt.entity.id, [first.id], oneLine, "IDR")).toBe(first.id);
    // The ledger anomaly scans cite the journal line or entry behind a bank row: still that bank line, never a free journal.
    const onRevenue = await db.journalLine.findFirstOrThrow({ where: { entry: { bankTransactionId: first.id }, account: { code: "4100" } } });
    expect(await reclassedBankLine(db, g.pt.entity.id, [`jl:${onRevenue.id}`], oneLine, "IDR")).toBe(first.id);
    expect(await reclassedBankLine(db, g.pt.entity.id, [`je:${onRevenue.entryId}`], oneLine, "IDR")).toBe(first.id);
    expect(await reclassedBankLine(db, g.pt.entity.id, [`jl:${onRevenue.id}`], splitEntry, "IDR")).toBe("AMBIGUOUS");
    // The taxed line posts a PPN component too: a draft moving only that component moves the bank line, so no draft (and no free
    // journal) either, and a stored one citing it never posts.
    const ppn = await db.journalLine.findFirstOrThrow({ where: { entry: { bankTransactionId: second.id }, account: { code: "2130" } } });
    const ppnAmount = `Rp ${(ppn.credit - ppn.debit).toLocaleString("id-ID")}`;
    const ppnOnly = { memo: "Pindah PPN", lines: [l("2130", "D", ppnAmount), l("2210", "K", ppnAmount)] };
    expect(await reclassedBankLine(db, g.pt.entity.id, [`jl:${ppn.id}`], ppnOnly, "IDR")).toBe("AMBIGUOUS");
    const tax = (ppn.credit - ppn.debit).toString();
    const stored = await saveProposal(db, { firmId: g.firm.id, clientId: g.client.id, entityId: g.pt.entity.id, year: 2026, month: 8, source: "AI_CONTROL", controlKey: key, key: "AI:ppn", memo: "Pindah PPN", lines: [{ accountCode: "2130", debit: tax, credit: "0" }, { accountCode: "2210", debit: "0", credit: tax }], reason: "PPN pinjaman.", refs: [`jl:${ppn.id}`], snapshot: "lama" });
    await expect(postProposal(db, { clientId: g.client.id, proposalId: stored.id })).rejects.toThrow("harus lewat Review");
    await db.proposedEntry.delete({ where: { id: stored.id } });

    // One cited → that one, even though the other has the lower id. (Same books: clear the cached answer to ask again.)
    await db.evidenceAiCache.deleteMany();
    const one = await explainControl(db, g.firm.id, g.client.id, 2026, 8, key, citing([second.id]));
    const p = await db.proposedEntry.findUniqueOrThrow({ where: { id: one.proposal!.id } });
    expect(p.bankTransactionId).toBe(second.id);
    const [view] = await proposalViews(db, g.client.id, 2026, 8);
    expect(view.reason).toMatch(/Tag pajak transaksi ini dilepas saat dicatat/);

    // Posting releases the tax split: the whole Rp 100 jt lands on 2210, no PPN left behind.
    await postProposal(db, { clientId: g.client.id, proposalId: p.id });
    const moved = await db.bankTransaction.findUniqueOrThrow({ where: { id: second.id } });
    expect([moved.accountCode, moved.taxTag]).toEqual(["2210", null]);
    // …and the line is back in the Review queue on its new account, so the accountant confirms its tax before the close.
    expect([moved.status, moved.suggestedCode]).toEqual(["NEEDS_REVIEW", "2210"]);
    // Memory keeps the last confirmed treatment until then: a new import of the same merchant isn't auto-posted untaxed.
    const memory = await db.memory.findUniqueOrThrow({ where: { clientId_merchantKey_direction: { clientId: g.client.id, merchantKey: moved.merchantKey, direction: "IN" } } });
    expect([memory.accountCode, memory.taxTag]).toEqual(["4100", "PPN_KELUARAN"]);
    expect((await runControls(db, g.client.id, 2026, 8)).find((c) => c.key === "suspense")?.status).not.toBe("PASS");
    const net = async (code: string) => {
      const s = await db.journalLine.aggregate({ where: { entityId: g.pt.entity.id, account: { code } }, _sum: { debit: true, credit: true } });
      return (s._sum.credit ?? 0n) - (s._sum.debit ?? 0n);
    };
    expect([await net("2210"), await net("2130")]).toEqual([100_000_000n, 0n]);

    // A draft for the first line, then the accountant fixes that line in Review: the books moved, the draft can't post.
    const stale = await explainControl(db, g.firm.id, g.client.id, 2026, 8, key, citing([first.id]));
    await reviewTransaction(db, { bankTxId: first.id, accountCode: "2210", taxTag: null });
    const entries = await db.journalEntry.count();
    await expect(postProposal(db, { clientId: g.client.id, proposalId: stale.proposal!.id })).rejects.toThrow("Buku berubah sejak draf ini dibuat");
    expect(await db.journalEntry.count()).toBe(entries); // nothing posted twice
  });
  it("never corrects twice: a Jurnal Penyesuaian that already moved the line blocks the draft, and Jelaskan says so", async () => {
    const { g, key } = await loanInRevenue();
    const r = await explainControl(db, g.firm.id, g.client.id, 2026, 8, key, new MockProvider());
    const p = await db.proposedEntry.findUniqueOrThrow({ where: { id: r.proposal!.id } });
    // The accountant fixed it by hand instead of posting the draft.
    await postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 8, 31), memo: "Koreksi pinjaman", lines: [{ accountCode: "4100", debit: "100.000.000", credit: "" }, { accountCode: "2210", debit: "", credit: "100.000.000" }] });
    const view = (await proposalViews(db, g.client.id, 2026, 8)).find((v) => v.id === p.id)!;
    expect(view.blocked).toContain('Sudah ada Jurnal Penyesuaian 31 Agu 2026 "Koreksi pinjaman" yang memindahkan Rp 100.000.000 dari 4100');
    const entries = await db.journalEntry.count();
    await expect(postProposal(db, { clientId: g.client.id, proposalId: p.id })).rejects.toThrow("mengoreksi dua kali");
    expect(await db.journalEntry.count()).toBe(entries);
    await db.proposedEntry.update({ where: { id: p.id }, data: { status: "DISMISSED" } });
    const again = await explainControl(db, g.firm.id, g.client.id, 2026, 8, key, new MockProvider());
    expect(again.proposal).toBeNull();
    expect(again.suggestion).toContain("mengoreksi dua kali");
  });

  it("never offers Prive to a PT's draft; a CV keeps it", async () => {
    const { g, key } = await loanInRevenue();
    const seen: string[][] = [];
    class Spy extends MockProvider {
      override async explainControl(input: Parameters<MockProvider["explainControl"]>[0]) {
        seen.push(input.accounts.map((a) => a.code));
        return super.explainControl(input);
      }
    }
    await explainControl(db, g.firm.id, g.client.id, 2026, 8, key, new Spy());
    expect(seen[0]).not.toContain("3300");
    await db.entity.update({ where: { id: g.pt.entity.id }, data: { kind: "CV" } });
    await db.evidenceAiCache.deleteMany();
    await explainControl(db, g.firm.id, g.client.id, 2026, 8, key, new Spy());
    expect(seen[1]).toContain("3300");
  });

  it("stores how many citations were outside the rows sent (never the strings) and keeps the count on a cache hit", async () => {
    const { g, tx, key } = await loanInRevenue();
    const provider = new MockProvider();
    const entry = { memo: "Reklasifikasi pencairan KMK", lines: [{ accountCode: "4100", side: "D", amount: "Rp 100.000.000" }, { accountCode: "2210", side: "K", amount: "Rp 100.000.000" }] };
    provider.explainAnswer = JSON.stringify({ explanation: "Pinjaman di pendapatan.", suggestion: "Reklasifikasi.", refs: [tx.id, "baris-karangan"], note: "", entry });
    const r = await explainControl(db, g.firm.id, g.client.id, 2026, 8, key, provider);
    const [cached] = await db.evidenceAiCache.findMany();
    expect((cached.payload as { dropped: number; refs: string[] }).dropped).toBe(1);
    expect((cached.payload as { refs: string[] }).refs).toEqual([tx.id]);
    expect(JSON.stringify(cached.payload)).not.toContain("baris-karangan");
    expect(r.proposal).not.toBeNull(); // the draft stands on the cited row it kept
    // Asked again: the cached answer, no call, the same count.
    await explainControl(db, g.firm.id, g.client.id, 2026, 8, key, provider);
    expect([provider.calls, await db.evidenceAiCache.count(), (await db.evidenceAiCache.findFirstOrThrow()).payload]).toEqual([1, 1, cached.payload]);
  });
});

