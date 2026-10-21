import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { createClient, createFirm } from "@/lib/setup";
import { postJournal } from "@/lib/ledger/post";
import { postOpening } from "@/lib/opening";
import { addEntity } from "@/lib/onboarding";
import { removeEntity, renameEntity } from "@/lib/clients/entities";
import { balanceSheet, combinedWorksheet } from "@/lib/reports/ledger";
import { cashFlow } from "@/lib/reports/statements";
import { runControls } from "@/lib/controls";
import { dateOnly } from "@/lib/format";

/**
 * Antar entitas per pihak (cycle 2026-10-21-antar-entitas-per-pihak): a group of three or more companies records a balance with each
 * company on that company's account (`1190NN`), so one party never nets another. Round five's three failing probes are the core here.
 * J = Rp 1 juta; every figure by hand.
 */
const J = 1_000_000n;

async function makeGroup3() {
  return db.$transaction(async (tx) => {
    const firm = await createFirm(tx, "KJA Uji Grup");
    const { client, entities } = await createClient(tx, firm.id, {
      name: "Grup Maju",
      industry: "dagang",
      entities: [
        { name: "PT Uji Sejahtera", shortName: "PT Uji", kind: "PT", banks: [{ bank: "BCA", number: "1111111111", label: "BCA Giro" }] },
        { name: "CV Maju Bersama", shortName: "CV Maju", kind: "CV", banks: [{ bank: "BCA", number: "4444444444", label: "BCA Giro" }] },
        { name: "Andi Wijaya", shortName: "Andi", kind: "PERORANGAN", banks: [{ bank: "BRI", number: "3333333333", label: "BRI Tabungan" }] },
      ],
    });
    return { firm, client, pt: entities[0], cv: entities[1], owner: entities[2] };
  });
}
type G = Awaited<ReturnType<typeof makeGroup3>>;
type Who = "pt" | "cv" | "owner";

/** An account by code, or "@pt" / "@cv" / "@owner": that company's intercompany account. */
const id = async (g: G, code: string) =>
  (await db.account.findFirstOrThrow({ where: { clientId: g.client.id, ...(code.startsWith("@") ? { counterpartyEntityId: g[code.slice(1) as Who].entity.id } : { code }) } })).id;
const post = async (g: G, who: Who, d: number, memo: string, lines: [string, bigint][]) =>
  db.$transaction(async (tx) =>
    postJournal(tx, {
      entityId: g[who].entity.id,
      date: dateOnly(2026, 1, d),
      kind: "ADJUSTMENT",
      memo,
      lines: await Promise.all(lines.map(async ([code, v]) => (v > 0n ? { accountId: await id(g, code), debit: v } : { accountId: await id(g, code), credit: -v }))),
    }),
  );
const open = (g: G, who: Who, cash: bigint) =>
  postOpening(db, { clientId: g.client.id, entityId: g[who].entity.id, date: dateOnly(2025, 12, 31), lines: [{ accountCode: "1120", debit: String(cash), credit: "" }, { accountCode: "3100", debit: "", credit: String(cash) }] });
const line = (bs: Awaited<ReturnType<typeof balanceSheet>>, fs: string) => [...bs.currentAssets, ...bs.liabilities].find((i) => i.fsLine === fs)?.amount ?? 0n;
const own = (g: G, who: Who) => ({ clientId: g.client.id, entityIds: [g[who].entity.id] });
const ic = async (g: G) => (await runControls(db, g.client.id, 2026, 1)).filter((c) => c.key.startsWith("intercompany"));

describe("Antar entitas per pihak", () => {
  beforeEach(resetDb);

  it("a group of three gets an account per company, a fourth adds one, a rename follows, two companies keep 1190 only", async () => {
    const g = await makeGroup3();
    const accounts = async (clientId: string) => (await db.account.findMany({ where: { clientId, isIntercompany: true }, orderBy: { code: "asc" } })).map((a) => [a.code, a.name, a.counterpartyEntityId]);
    const byId = [g.pt, g.cv, g.owner].map((e) => e.entity).sort((a, b) => a.id.localeCompare(b.id));
    expect(await accounts(g.client.id)).toEqual([
      ["1190", "Piutang/Utang Antar Entitas", null],
      ...byId.map((e, i) => [`11900${i + 1}`, `Piutang/Utang Antar Entitas — ${e.shortName}`, e.id]),
    ]);
    const fourth = await addEntity(db, g.firm.id, g.client.id, { name: "PT Baru Jaya", shortName: "PT Baru", kind: "PT", npwp: "", banks: [] });
    expect((await accounts(g.client.id)).at(-1)).toEqual(["119004", "Piutang/Utang Antar Entitas — PT Baru", fourth.id]);
    await renameEntity(db, { firmId: g.firm.id, clientId: g.client.id, entityId: fourth.id, name: "PT Baru Jaya Abadi", shortName: "Baru Abadi", npwp: "" });
    expect((await accounts(g.client.id)).at(-1)?.[1]).toBe("Piutang/Utang Antar Entitas — Baru Abadi");
    // Removed while nobody recorded a balance with it: its account goes with it.
    await removeEntity(db, { firmId: g.firm.id, clientId: g.client.id, entityId: fourth.id });
    expect((await accounts(g.client.id)).map((a) => a[0])).not.toContain("119004");
    const two = await makeGroup();
    expect((await accounts(two.client.id)).map((a) => a[0])).toEqual(["1190"]);
  });

  it("postJournal refuses a company's own intercompany account", async () => {
    const g = await makeGroup3();
    await open(g, "pt", 100n * J);
    await expect(post(g, "pt", 5, "Salah akun", [["@pt", 10n * J], ["1120", -10n * J]])).rejects.toThrow(/akun antar entitas untuk PT Uji sendiri/);
  });

  it("PT's own Neraca shows the receivable from the CV and the payable to the owner apart; its cash flow keeps lending and borrowing apart", async () => {
    const g = await makeGroup3();
    await open(g, "pt", 500n * J);
    await open(g, "owner", 400n * J);
    await post(g, "pt", 10, "Pinjaman ke CV", [["@cv", 100n * J], ["1120", -100n * J]]);
    await post(g, "cv", 10, "Pinjaman dari PT", [["1120", 100n * J], ["@pt", -100n * J]]);
    await post(g, "owner", 15, "Pinjaman ke PT", [["@pt", 300n * J], ["1120", -300n * J]]);
    await post(g, "pt", 15, "Pinjaman dari pemilik", [["1120", 300n * J], ["@owner", -300n * J]]);
    await post(g, "cv", 20, "Cicil ke PT", [["@pt", 30n * J], ["1120", -30n * J]]);
    await post(g, "pt", 20, "Terima cicilan CV", [["1120", 30n * J], ["@cv", -30n * J]]);
    const asOf = dateOnly(2026, 1, 31);
    // PT: cash 500 − 100 + 300 + 30 = 730; owed by the CV 70; owes the owner 300. Assets 800 = 300 + 500. No set-off between parties.
    const bs = await balanceSheet(db, own(g, "pt"), asOf);
    expect({ assets: bs.totals.assets, receivable: line(bs, "PIUTANG_LAIN"), payable: line(bs, "UTANG_ANTAR_ENTITAS") }).toEqual({ assets: 800n * J, receivable: 70n * J, payable: 300n * J });
    // PT's cash flow: lent the CV 100, repaid 30 → investing −70; borrowed from the owner → financing +300.
    const cf = await cashFlow(db, own(g, "pt"), asOf);
    expect(cf.totals).toEqual({ OPERATING: 0n, INVESTING: -70n * J, FINANCING: 300n * J });
    // The group: every pair mirrors — eliminated, no intercompany line, cash flow without the loans.
    const all = { clientId: g.client.id, entityIds: [g.pt.entity.id, g.cv.entity.id, g.owner.entity.id] };
    const group = await balanceSheet(db, all, asOf);
    expect([line(group, "PIUTANG_LAIN"), line(group, "UTANG_ANTAR_ENTITAS"), group.totals.assets]).toEqual([0n, 0n, 900n * J]);
    expect((await cashFlow(db, all, asOf)).totals).toEqual({ OPERATING: 0n, INVESTING: 0n, FINANCING: 0n });
    const ws = await combinedWorksheet(db, g.client.id, asOf);
    expect([ws.matched, ws.residual, ws.pairs]).toEqual([370n * J, 0n, []]);
    expect((await ic(g)).map((c) => [c.key, c.status])).toEqual([["intercompany", "PASS"]]);
  });

  it("two broken pairs that offset make the control REVIEW, naming both pairs", async () => {
    const g = await makeGroup3();
    await open(g, "pt", 500n * J);
    await open(g, "cv", 100n * J);
    await open(g, "owner", 200n * J);
    // PT lends the CV 100, the CV books it as a sale; the owner lends the CV 100, the owner books it as prive.
    await post(g, "pt", 10, "Pinjaman ke CV", [["@cv", 100n * J], ["1120", -100n * J]]);
    await post(g, "cv", 10, "Terima transfer", [["1120", 100n * J], ["4100", -100n * J]]);
    await post(g, "cv", 12, "Pinjaman dari pemilik", [["1120", 100n * J], ["@owner", -100n * J]]);
    await post(g, "owner", 12, "Transfer ke CV", [["3300", 100n * J], ["1120", -100n * J]]);
    const [control] = await ic(g);
    expect(control.status).toBe("REVIEW");
    expect(control.detail).toBe("CV Maju–PT Uji selisih Rp 100.000.000; CV Maju–Andi selisih Rp 100.000.000");
  });

  it("a balance left on 1190 in a group of three is a REVIEW naming the company and the way out", async () => {
    const g = await makeGroup3();
    await open(g, "pt", 500n * J);
    await post(g, "pt", 10, "Pinjaman (lama)", [["1190", 50n * J], ["1120", -50n * J]]);
    const party = (await ic(g)).find((c) => c.key === "intercompany-party")!;
    expect([party.status, party.detail]).toEqual(["REVIEW", "PT Uji Rp 50.000.000 di 1190. Pindahkan ke akun antar entitas pihaknya (1190xx) lewat Jurnal Penyesuaian"]);
  });
});
