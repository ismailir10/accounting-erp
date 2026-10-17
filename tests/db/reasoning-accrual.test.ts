import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { accrualProposals, postAccrual } from "@/lib/adjust/accruals";
import { accrualReasoning, accrualSteps, NOT_FOUND, reasoningCsv, reasoningFor, reasoningSteps } from "@/lib/approvals/reasoning";
import { hasReasoning } from "@/lib/approvals/has-reasoning";
import { BERSIH, NOW, qaBooks } from "../accrual-books";

// Lihat alasan on an accrual card (cycle 2026-10-18-usulan-akrual): deterministic steps over the history rows, no AI, nothing stored.
describe("Lihat alasan — an accrual proposal", () => {
  beforeEach(resetDb);

  it("shows the five steps and Tanpa AI; the CSV holds every history row as text and as minor units; reading writes nothing", async () => {
    const { g } = await qaBooks();
    const bersih = (await accrualProposals(db, g.client.id, 2026, 8, { now: NOW })).find((p) => p.counterparty === BERSIH)!;
    expect(hasReasoning({ source: "ACCRUAL" })).toBe(true);
    const before = [await db.proposedEntry.count(), await db.journalEntry.count(), await db.aiUsage.count()];
    const f = await accrualReasoning(db, { firmId: g.firm.id, clientId: g.client.id }, bersih.key, NOW);
    const steps = accrualSteps(f);
    expect(steps.map((s) => s.label)).toEqual(["Riwayat dibaca", "Aturan", "Bulan ini", "Nominal", "Belum dicatat"]);
    expect(steps[0].lines).toEqual(["Apr 2026: Rp 4.200.000 (1 baris)", "Mei 2026: Rp 4.200.000 (1 baris)", "Jun 2026: Rp 4.350.000 (1 baris)", "Jul 2026: Rp 4.200.000 (1 baris)"]);
    expect(steps[0].rows!.map((r) => [r.date, r.text, r.amount, r.account, r.cited])).toEqual([
      ["2026-04-10", BERSIH, "Rp 4.200.000", "6190", true],
      ["2026-05-10", BERSIH, "Rp 4.200.000", "6190", true],
      ["2026-06-10", BERSIH, "Rp 4.350.000", "6190", true],
      ["2026-07-10", BERSIH, "Rp 4.200.000", "6190", true],
    ]);
    expect(steps[1].checks!.every((c) => c.ok)).toBe(true);
    expect(steps[1].checks!.map((c) => c.text)).toEqual([
      "Ada di 4 dari 4 bulan (paling sedikit 3), tidak ada bulan yang minus.",
      "Setiap bulan dalam 25 % dari nilai tengah Rp 4.200.000.",
      expect.stringMatching(/^Nilai tengah Rp 4\.200\.000 tidak kurang dari batas materialitas Rp [\d.]+\.$/),
    ]);
    expect(steps[1].note).toBe("Tanpa AI: tidak ada yang dikirim ke model.");
    expect(steps[2].lines).toEqual([`Tidak ada mutasi ${BERSIH} sampai 31 Agu 2026.`, "Rekening koran BCA Giro lengkap sampai 31 Agu 2026."]);
    expect(steps[3].lines).toEqual(["Rp 4.200.000, nilai tengah riwayat (Jul 2026).", "Debit 6190 Beban Umum Lain-lain · Kredit 2150 Beban Masih Harus Dibayar · dibalik otomatis 1 Sep 2026."]);
    expect(steps[4].lines).toEqual(["Tidak ada yang dicatat sampai Anda menyetujui usulan ini."]);

    const csv = reasoningCsv(f);
    for (const ref of bersih.refs) expect(csv).toContain(`;ya;${ref}`);
    expect(csv).toContain(`Riwayat dibaca;Baris;${BERSIH};2026-06-10;Rp 4.350.000;4350000;IDR;6190;BCA Giro baris `);
    expect(csv).toContain("Riwayat dibaca;Bulan Jun 2026;1 baris;;Rp 4.350.000;4350000;IDR;6190;");
    expect(csv).toContain("Nominal;Nilai tengah;Jul 2026;;Rp 4.200.000;4200000;IDR;6190;");
    expect(csv).toContain("Nominal;Tanpa AI;Tanpa AI: tidak ada yang dikirim ke model.;");
    expect(csv.split("\n").filter((l) => l.startsWith("Riwayat dibaca;Baris;"))).toHaveLength(4);
    // The action and the download find it by its key (the card id) the same way.
    expect(reasoningSteps(await reasoningFor(db, { firmId: g.firm.id, clientId: g.client.id }, bersih.key))).toEqual(steps);
    expect([await db.proposedEntry.count(), await db.journalEntry.count(), await db.aiUsage.count()]).toEqual(before);
  });

  it("another client's key, a crafted key or a decided proposal is not found", async () => {
    const { g } = await qaBooks();
    const [telkom] = await accrualProposals(db, g.client.id, 2026, 8, { now: NOW });
    const other = await makeGroup();
    await expect(accrualReasoning(db, { firmId: other.firm.id, clientId: other.client.id }, telkom.key, NOW)).rejects.toThrow(NOT_FOUND);
    await expect(accrualReasoning(db, { firmId: g.firm.id, clientId: g.client.id }, "ACCRUAL:x:2026-08:6130:ledger", NOW)).rejects.toThrow(NOT_FOUND);
    await expect(reasoningFor(db, { firmId: g.firm.id, clientId: g.client.id }, "ACCRUAL:bukan-kunci")).rejects.toThrow(NOT_FOUND);
    await postAccrual(db, { firmId: g.firm.id, clientId: g.client.id, key: telkom.key, now: NOW });
    await expect(accrualReasoning(db, { firmId: g.firm.id, clientId: g.client.id }, telkom.key, NOW)).rejects.toThrow(NOT_FOUND);
  });
});
