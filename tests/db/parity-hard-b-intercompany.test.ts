import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";
import { createClient, createFirm } from "@/lib/setup";
import { postJournal } from "@/lib/ledger/post";
import { postOpening } from "@/lib/opening";
import { addEntity } from "@/lib/onboarding";
import { removeEntity } from "@/lib/clients/entities";
import { approveJournal, submitAdjustment, type Maker } from "@/lib/approvals/journals";
import { saveApprovals } from "@/lib/settings/approvals";
import { balanceSheet, combinedWorksheet } from "@/lib/reports/ledger";
import { cashFlow } from "@/lib/reports/statements";
import { runControls } from "@/lib/controls";
import { createAccount } from "@/lib/coa/manage";
import { deleteClient } from "@/lib/clients/delete";
import { importStatement } from "@/lib/import/pipeline";
import { dateOnly } from "@/lib/format";

/**
 * Round nine, probe B (cycle 2026-10-21-uji-keras-paritas): Antar entitas per pihak (lib/coa/intercompany.ts, cycle
 * 2026-10-21-antar-entitas-per-pihak) through the real writers — companies added and removed, the transfer matcher, Persetujuan kedua,
 * the worksheet, the statements and the controls. Every figure is computed by hand in the comments first. A failing test names a defect.
 * J = Rp 1 juta. The group: PT Uji Sejahtera (PT), CV Maju Bersama (CV), the owner Andi Wijaya (PERORANGAN); every bank a BCA, so one file
 * layout serves all three.
 */
const J = 1_000_000n;

async function makeGroup3() {
  return db.$transaction(async (tx) => {
    const firm = await createFirm(tx, "KJA Uji Grup");
    const { client, entities } = await createClient(tx, firm.id, {
      name: "Grup Maju",
      industry: "dagang",
      entities: [
        { name: "PT Uji Sejahtera", shortName: "PT Uji", kind: "PT", banks: [{ bank: "BCA", number: "1111111111", label: "BCA Giro" }, { bank: "MANDIRI", number: "2222222222", label: "Mandiri Giro" }] },
        { name: "CV Maju Bersama", shortName: "CV Maju", kind: "CV", banks: [{ bank: "BCA", number: "4444444444", label: "BCA Giro" }] },
        { name: "Andi Wijaya", shortName: "Andi", kind: "PERORANGAN", banks: [{ bank: "BCA", number: "3333333333", label: "BCA Tahapan" }] },
      ],
    });
    return { firm, client, pt: entities[0], cv: entities[1], owner: entities[2] };
  });
}
type G = Awaited<ReturnType<typeof makeGroup3>>;
type Who = "pt" | "cv" | "owner";
type AnyGroup = { client: { id: string } } & Partial<Record<Who, { entity: { id: string } }>>;

/** An account by code, or "@pt" / "@cv" / "@owner" for that company's intercompany account (`1190NN`). */
const account = async (g: AnyGroup, code: string) =>
  db.account.findFirstOrThrow({ where: { clientId: g.client.id, ...(code.startsWith("@") ? { counterpartyEntityId: g[code.slice(1) as Who]!.entity.id } : { code }) } });
/** One typed journal through postJournal; positive = debit, negative = credit. */
const post = async (g: AnyGroup, who: Who, date: Date, memo: string, lines: [string, bigint][]) =>
  db.$transaction(async (tx) =>
    postJournal(tx, {
      entityId: g[who]!.entity.id,
      date,
      kind: "ADJUSTMENT",
      memo,
      lines: await Promise.all(lines.map(async ([code, v]) => (v > 0n ? { accountId: (await account(g, code)).id, debit: v } : { accountId: (await account(g, code)).id, credit: -v }))),
    }),
  );
const open = (g: AnyGroup, who: Who, cash: bigint) =>
  postOpening(db, { clientId: g.client.id, entityId: g[who]!.entity.id, date: dateOnly(2025, 12, 31), lines: [{ accountCode: "1120", debit: String(cash), credit: "" }, { accountCode: "3100", debit: "", credit: String(cash) }] });
const fsLine = (bs: Awaited<ReturnType<typeof balanceSheet>>, fs: string) => [...bs.currentAssets, ...bs.nonCurrentAssets, ...bs.liabilities].find((i) => i.fsLine === fs)?.amount ?? 0n;
const items = (xs: { key: string; amount: bigint }[]) => Object.fromEntries(xs.map((i) => [i.key, i.amount]));
const icControls = async (clientId: string, month = 1) => (await runControls(db, clientId, 2026, month)).filter((c) => c.key.startsWith("intercompany")).map((c) => [c.key, c.status, c.detail]);
const mk = (m: { id: string; role: Maker["role"] }): Maker => ({ id: m.id, role: m.role });
/** Whose intercompany account a code is: the counterparty's short name, or the code when it is not a per-company account. */
const partyOf = async (clientId: string, code: string | null) => {
  const a = await db.account.findFirst({ where: { clientId, code: code ?? "" }, include: { counterpartyEntity: { select: { shortName: true } } } });
  return a?.counterpartyEntity?.shortName ?? code;
};

describe("Antar entitas per pihak, tested hard — companies added and removed", () => {
  beforeEach(resetDb);

  it("a third company joins a two-company client: old 1190 balances stay and eliminate, the party control asks to move them, the move clears it", async () => {
    const g = await makeGroup(); // PT Uji (BCA, Mandiri) + Andi (BRI): one 1190
    const two = { client: g.client, pt: g.pt, owner: g.owner } as AnyGroup;
    await open(two, "pt", 500n * J);
    await open(two, "owner", 200n * J);
    // 10 Jan: PT lends Andi 100 on the one 1190 — PT Dr 1190 100 / Cr 1120 100; Andi Dr 1120 100 / Cr 1190 100.
    await post(two, "pt", dateOnly(2026, 1, 10), "Pinjaman ke Andi", [["1190", 100n * J], ["1120", -100n * J]]);
    await post(two, "owner", dateOnly(2026, 1, 10), "Pinjaman dari PT", [["1120", 100n * J], ["1190", -100n * J]]);
    const asOf = dateOnly(2026, 1, 31);
    // Gabungan cash: PT 500 − 100 = 400; Andi 200 + 100 = 300 → assets 700, the loan eliminated.
    const before = await balanceSheet(db, { clientId: g.client.id, entityIds: [g.pt.entity.id, g.owner.entity.id] }, asOf);
    expect([before.totals.assets, fsLine(before, "PIUTANG_LAIN"), fsLine(before, "UTANG_ANTAR_ENTITAS")]).toEqual([700n * J, 0n, 0n]);
    expect(await icControls(g.client.id)).toEqual([["intercompany", "PASS", "Tereliminasi Rp 100.000.000"]]);

    const cv = await addEntity(db, g.firm.id, g.client.id, { name: "CV Maju Bersama", shortName: "CV Maju", kind: "CV", npwp: "", banks: [] });
    // Three per-company accounts now (one each); 1190 keeps its old balances.
    expect(await db.account.count({ where: { clientId: g.client.id, counterpartyEntityId: { not: null } } })).toBe(3);
    const three = { ...two, cv: { entity: cv } } as AnyGroup;
    const all = { clientId: g.client.id, entityIds: [g.pt.entity.id, cv.id, g.owner.entity.id] };
    const after = await balanceSheet(db, all, asOf);
    expect([after.totals.assets, fsLine(after, "PIUTANG_LAIN"), fsLine(after, "UTANG_ANTAR_ENTITAS")]).toEqual([700n * J, 0n, 0n]);
    // Still eliminated (100), and 1190 can't tell its party: REVIEW naming each company's balance there (order: companies by name, owner last).
    const [ic, party] = await icControls(g.client.id);
    expect(ic).toEqual(["intercompany", "PASS", "Tereliminasi Rp 100.000.000"]);
    expect(party[0]).toBe("intercompany-party");
    expect(party[1]).toBe("REVIEW");
    expect(party[2]).toMatch(/^PT Uji Rp 100\.000\.000; Andi \S*Rp 100\.000\.000 di 1190\. /);

    // The way out (31 Jan): PT Dr Andi's account 100 / Cr 1190 100; Andi Dr 1190 100 / Cr PT's account 100.
    await post(three, "pt", asOf, "Pindah saldo antar entitas ke pihaknya", [["@owner", 100n * J], ["1190", -100n * J]]);
    await post(three, "owner", asOf, "Pindah saldo antar entitas ke pihaknya", [["1190", 100n * J], ["@pt", -100n * J]]);
    expect(await icControls(g.client.id)).toEqual([["intercompany", "PASS", "Tereliminasi Rp 100.000.000"]]);
    const ws = await combinedWorksheet(db, g.client.id, asOf);
    expect([ws.matched, ws.residual, ws.pairs]).toEqual([100n * J, 0n, []]);
    // PT's own Neraca: the receivable from Andi on Andi's account; group assets unchanged.
    const ptOwn = await balanceSheet(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, asOf);
    expect([fsLine(ptOwn, "PIUTANG_LAIN"), ptOwn.totals.assets, (await balanceSheet(db, all, asOf)).totals.assets]).toEqual([100n * J, 500n * J, 700n * J]);
  });

  it("a company is not removed while a waiting journal names its intercompany account, so the approval can never post to the next company", async () => {
    const g = await makeGroup3();
    const maker = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    const boss = await addMember(g.firm.id, "ADMIN", { name: "boss" });
    await saveApprovals(db, { firmId: g.firm.id, settings: { manual: true, manualAbove: "1.000.000", aiDraft: false, aiDraftAbove: "", reopen: false } });
    const cvCode = (await account(g, "@cv")).code;
    // PT lends the CV Rp 50 juta: Dr CV's account 50 J / Cr 1120 50 J, above the threshold → a request (no entry, so CV's account has no line).
    const asked = await submitAdjustment(db, {
      clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 1, 15), memo: "Pinjaman ke CV Maju", maker: mk(maker),
      lines: [{ accountCode: cvCode, debit: "50.000.000", credit: "" }, { accountCode: "1120", debit: "", credit: "50.000.000" }],
    });
    expect(asked.posted).toBe(false);
    // The CV has no entry of its own, so removeEntity lets it go and deletes its account (no line on it) — though the request names its code.
    const removal = await removeEntity(db, { firmId: g.firm.id, clientId: g.client.id, entityId: g.cv.entity.id }).then(() => "removed", () => "refused");
    let landedOn: string | null = null;
    if (removal === "removed") {
      // A new company takes the lowest free code — the CV's — and the approved request posts PT's loan to the CV onto its account.
      const baru = await addEntity(db, g.firm.id, g.client.id, { name: "PT Baru Jaya", shortName: "PT Baru", kind: "PT", npwp: "", banks: [] });
      expect((await db.account.findFirstOrThrow({ where: { clientId: g.client.id, counterpartyEntityId: baru.id } })).code).toBe(cvCode);
      const entry = await approveJournal(db, { clientId: g.client.id, approvalId: asked.posted ? "" : asked.approvalId, approver: mk(boss) });
      const line = await db.journalLine.findFirstOrThrow({ where: { entryId: entry.id, debit: { gt: 0n } }, include: { account: { include: { counterpartyEntity: true } } } });
      landedOn = line.account.counterpartyEntity?.shortName ?? line.account.code;
    }
    // Right behaviour: the removal is refused while a waiting journal (or a Jurnal berulang template) names the company's account, as an
    // account archive is refused for the same reason (rule 23); a loan to the CV must never become a loan to PT Baru.
    expect({ removal, landedOn }).toEqual({ removal: "refused", landedOn: null });
  });

  it("a rule naming a company's intercompany account holds its removal; a removed company's code is never issued again", async () => {
    const g = await makeGroup3();
    const codes = async () => (await db.account.findMany({ where: { clientId: g.client.id, counterpartyEntityId: { not: null } }, select: { code: true } })).map((a) => a.code).sort();
    // Three companies: 119001–119003, one each.
    expect(await codes()).toEqual(["119001", "119002", "119003"]);
    const cvCode = (await account(g, "@cv")).code;
    // A client rule files "CV MAJU" to the CV's account: no journal line on it, but the rule would file to whatever takes the code next.
    const rule = await db.rule.create({ data: { firmId: g.firm.id, clientId: g.client.id, pattern: "CV MAJU", accountCode: cvCode, source: "USER" } });
    await expect(removeEntity(db, { firmId: g.firm.id, clientId: g.client.id, entityId: g.cv.entity.id })).rejects.toThrow(/masih dipakai: 1 aturan klasifikasi ke akun ini/);
    await db.rule.delete({ where: { id: rule.id } });
    await removeEntity(db, { firmId: g.firm.id, clientId: g.client.id, entityId: g.cv.entity.id });
    expect((await codes()).includes(cvCode)).toBe(false);
    // The next company gets the code above the highest ever issued (119004), never the CV's freed one; removed again, the next gets 119005.
    const baru = await addEntity(db, g.firm.id, g.client.id, { name: "PT Baru Jaya", shortName: "PT Baru", kind: "PT", npwp: "", banks: [] });
    expect((await db.account.findFirstOrThrow({ where: { clientId: g.client.id, counterpartyEntityId: baru.id } })).code).toBe("119004");
    await removeEntity(db, { firmId: g.firm.id, clientId: g.client.id, entityId: baru.id });
    const lagi = await addEntity(db, g.firm.id, g.client.id, { name: "PT Lagi Jaya", shortName: "PT Lagi", kind: "PT", npwp: "", banks: [] });
    expect((await db.account.findFirstOrThrow({ where: { clientId: g.client.id, counterpartyEntityId: lagi.id } })).code).toBe("119005");
  });

  it("a removed company's account goes with it, a rename follows, and a client of three companies with intercompany lines can be deleted", async () => {
    const g = await makeGroup3();
    await open(g, "pt", 100n * J);
    await post(g, "pt", dateOnly(2026, 1, 10), "Pinjaman ke CV", [["@cv", 10n * J], ["1120", -10n * J]]);
    await post(g, "cv", dateOnly(2026, 1, 10), "Pinjaman dari PT", [["1120", 10n * J], ["@pt", -10n * J]]);
    // The CV has entries: refused. Andi has none and nobody recorded anything on Andi's account: Andi and the account go.
    await expect(removeEntity(db, { firmId: g.firm.id, clientId: g.client.id, entityId: g.cv.entity.id })).rejects.toThrow(/Sudah ada/);
    await removeEntity(db, { firmId: g.firm.id, clientId: g.client.id, entityId: g.owner.entity.id });
    expect(await db.account.count({ where: { clientId: g.client.id, counterpartyEntityId: { not: null } } })).toBe(2);
    await deleteClient(db, { firmId: g.firm.id, clientId: g.client.id, confirmName: g.client.name });
    expect(await db.account.count({ where: { clientId: g.client.id } })).toBe(0);
  });
});

describe("Antar entitas per pihak, tested hard — writers refuse a company's own account", () => {
  beforeEach(resetDb);

  it("a Jurnal Penyesuaian on the company's own account is refused at the request too; a 1190NN code can't be typed for a new account", async () => {
    const g = await makeGroup3();
    const maker = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    await addMember(g.firm.id, "ADMIN", { name: "boss" });
    await saveApprovals(db, { firmId: g.firm.id, settings: { manual: true, manualAbove: "1.000.000", aiDraft: false, aiDraftAbove: "", reopen: false } });
    const ptCode = (await account(g, "@pt")).code;
    await expect(
      submitAdjustment(db, {
        clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 1, 15), memo: "Salah pihak", maker: mk(maker),
        lines: [{ accountCode: ptCode, debit: "5.000.000", credit: "" }, { accountCode: "1120", debit: "", credit: "5.000.000" }],
      }),
    ).rejects.toThrow(/akun antar entitas untuk PT Uji sendiri/);
    expect(await db.journalApproval.count()).toBe(0);
    // The CV may record its balance with PT on PT's account (below the threshold: posted).
    const ok = await submitAdjustment(db, {
      clientId: g.client.id, entityId: g.cv.entity.id, date: dateOnly(2026, 1, 15), memo: "Utang ke PT", maker: mk(maker),
      lines: [{ accountCode: "6170", debit: "500.000", credit: "" }, { accountCode: ptCode, debit: "", credit: "500.000" }],
    });
    expect(ok.posted).toBe(true);
    await expect(createAccount(db, { clientId: g.client.id, fsLine: "PIUTANG_LAIN", name: "Piutang afiliasi lain", code: "119050" })).rejects.toThrow(/dicadangkan/);
  });
});

describe("Antar entitas per pihak, tested hard — statements and controls", () => {
  beforeEach(resetDb);

  /**
   * Saldo Awal 31 Dec 2025: PT 1120 500 | CV 1120 100 | Andi 1120 400 (each against 3100). January 2026, both sides booked:
   *  10 Jan PT lends CV 100     PT Dr @cv 100 / Cr 1120 100      CV Dr 1120 100 / Cr @pt 100
   *  15 Jan Andi lends PT 300   Andi Dr @pt 300 / Cr 1120 300    PT Dr 1120 300 / Cr @owner 300
   *  20 Jan Andi lends CV 50    Andi Dr @cv 50 / Cr 1120 50      CV Dr 1120 50 / Cr @owner 50
   */
  async function january(g: G) {
    await open(g, "pt", 500n * J);
    await open(g, "cv", 100n * J);
    await open(g, "owner", 400n * J);
    await post(g, "pt", dateOnly(2026, 1, 10), "Pinjaman ke CV", [["@cv", 100n * J], ["1120", -100n * J]]);
    await post(g, "cv", dateOnly(2026, 1, 10), "Pinjaman dari PT", [["1120", 100n * J], ["@pt", -100n * J]]);
    await post(g, "owner", dateOnly(2026, 1, 15), "Pinjaman ke PT", [["@pt", 300n * J], ["1120", -300n * J]]);
    await post(g, "pt", dateOnly(2026, 1, 15), "Pinjaman dari pemilik", [["1120", 300n * J], ["@owner", -300n * J]]);
    await post(g, "owner", dateOnly(2026, 1, 20), "Pinjaman ke CV", [["@cv", 50n * J], ["1120", -50n * J]]);
    await post(g, "cv", dateOnly(2026, 1, 20), "Pinjaman dari pemilik", [["1120", 50n * J], ["@owner", -50n * J]]);
  }

  it("a scope of two of the three companies: the loan between them eliminates, their borrowing from the owner stays a liability and financing", async () => {
    const g = await makeGroup3();
    await january(g);
    const asOf = dateOnly(2026, 1, 31);
    const ptCv = { clientId: g.client.id, entityIds: [g.pt.entity.id, g.cv.entity.id] };
    // PT + CV: cash 700 + 250 = 950. PT on the CV's account +100 vs the CV on PT's −100: one group's money, 0. On the owner's account
    // PT −300, CV −50: a payable to a company outside the scope, 350. 950 = 350 + equity 600.
    const bs = await balanceSheet(db, ptCv, asOf);
    expect({ assets: bs.totals.assets, receivable: fsLine(bs, "PIUTANG_LAIN"), payable: fsLine(bs, "UTANG_ANTAR_ENTITAS"), equity: bs.totals.equity, diff: bs.totals.difference }).toEqual({ assets: 950n * J, receivable: 0n, payable: 350n * J, equity: 600n * J, diff: 0n });
    // Cash flow: opening 600, net +350; PT→CV cancels inside the scope, the owner's loans are financing +350; no investing.
    const cf = await cashFlow(db, ptCv, asOf);
    expect([cf.net, cf.totals.OPERATING, cf.totals.INVESTING, cf.totals.FINANCING, items(cf.financing)]).toEqual([350n * J, 0n, 0n, 350n * J, { INTERCOMPANY: 350n * J }]);
    // The owner alone: lent PT 300 and the CV 50 — receivables 350 and investing −350; cash 400 − 350 = 50.
    const own = { clientId: g.client.id, entityIds: [g.owner.entity.id] };
    const ownBs = await balanceSheet(db, own, asOf);
    expect([fsLine(ownBs, "PIUTANG_LAIN"), ownBs.totals.assets]).toEqual([350n * J, 400n * J]);
    expect(items((await cashFlow(db, own, asOf)).investing)).toEqual({ INTERCOMPANY_LENT: -350n * J });
    // The group: every pair mirrors.
    expect(await icControls(g.client.id)).toEqual([["intercompany", "PASS", "Tereliminasi Rp 450.000.000"]]);
  });

  it("a pair booked on a party account on one side and on the old 1190 on the other is never a pass", async () => {
    const g = await makeGroup3();
    await open(g, "pt", 500n * J);
    await open(g, "cv", 100n * J);
    // PT lends the CV 100 on the CV's account; the CV books it on 1190 out of habit.
    await post(g, "pt", dateOnly(2026, 1, 10), "Pinjaman ke CV", [["@cv", 100n * J], ["1120", -100n * J]]);
    await post(g, "cv", dateOnly(2026, 1, 10), "Pinjaman dari PT", [["1120", 100n * J], ["1190", -100n * J]]);
    const controls = await icControls(g.client.id);
    expect(controls.map((c) => [c[0], c[1]])).toEqual([["intercompany", "REVIEW"], ["intercompany-party", "REVIEW"]]);
    expect(controls[0][2]).toContain("CV Maju–PT Uji selisih Rp 100.000.000");
  });
});

describe("Antar entitas per pihak, tested hard — a pair with a company kept in US dollars", () => {
  beforeEach(resetDb);

  it("a dollar loan from PT to a USD CV mirrors in the worksheet once PT revalues it at the closing rate", async () => {
    const g = await makeGroup3();
    await db.entity.update({ where: { id: g.cv.entity.id }, data: { functionalCurrency: "USD" } });
    // 10 Jan: PT lends the CV USD 1.000 at 15.000 — PT Dr CV's account Rp 15.000.000 (USD 1.000 × 15.000) / Cr 1120;
    // the CV (books in USD) Dr 1120 USD 1.000 / Cr PT's account USD 1.000 (100.000 cents).
    const cvAcc = await account(g, "@cv");
    await db.$transaction(async (tx) =>
      postJournal(tx, {
        entityId: g.pt.entity.id, date: dateOnly(2026, 1, 10), kind: "ADJUSTMENT", memo: "Pinjaman USD ke CV",
        lines: [{ accountId: cvAcc.id, debit: 15_000_000n, fx: { currency: "USD", amount: 100_000n, rate: "15000" } }, { accountId: (await account(g, "1120")).id, credit: 15_000_000n }],
      }),
    );
    await post(g, "cv", dateOnly(2026, 1, 10), "Pinjaman dari PT", [["1120", 100_000n], ["@pt", -100_000n]]);
    const { upsertRate } = await import("@/lib/fx/rates");
    await upsertRate(db, g.firm.id, { currency: "USD", quote: "IDR", date: dateOnly(2026, 1, 31), kind: "SPOT", rate: "15500" });
    const asOf = dateOnly(2026, 1, 31);
    // Before PT's revaluation: the CV's payable translated at 15.500 = 15.500.000 against PT's 15.000.000 → the pair differs by 500.000.
    expect((await combinedWorksheet(db, g.client.id, asOf)).pairs).toEqual([{ a: "CV Maju", b: "PT Uji", difference: -500_000n }]);
    const { postRevaluation } = await import("@/lib/fx/revalue");
    await postRevaluation(db, g.client.id, g.pt.entity.id, 2026, 1);
    // After: PT's receivable 15.000.000 + 500.000 = 15.500.000 = USD 1.000 × 15.500; the pair mirrors and eliminates.
    const ws = await combinedWorksheet(db, g.client.id, asOf);
    expect([ws.pairs, ws.matched]).toEqual([[], 15_500_000n]);
    expect((await icControls(g.client.id)).find((c) => c[0] === "intercompany")?.[1]).toBe("PASS");
  });
});

const bcaFile = (number: string, lines: string[], opening: string, closing: string) => `Informasi Rekening - Mutasi Rekening
No. rekening : ${number}
Periode : 01/01/2026 - 31/01/2026

Tanggal Transaksi,Keterangan,Cabang,Jumlah,,Saldo
${lines.join("\n")}
"Saldo Awal : ${opening}"
"Saldo Akhir : ${closing}"
`;

describe("Antar entitas per pihak, tested hard — the transfer matcher", () => {
  beforeEach(resetDb);

  it("in a group of three, PT's line paying the CV never pairs with the owner's line from PT of the same amount: it stays on the CV's account", async () => {
    const g = await makeGroup3();
    const bankCode = async (bankAccountId: string) => (await db.bankAccount.findUniqueOrThrow({ where: { id: bankAccountId }, include: { account: true } })).account.code;
    const openBank = async (who: Who, bankAccountId: string, amount: bigint) =>
      postOpening(db, { clientId: g.client.id, entityId: g[who].entity.id, date: dateOnly(2025, 12, 31), lines: [{ accountCode: await bankCode(bankAccountId), debit: String(amount), credit: "" }, { accountCode: "3100", debit: "", credit: String(amount) }] });
    await openBank("pt", g.pt.banks[0].id, 100n * J);
    await openBank("owner", g.owner.banks[0].id, 10n * J);
    // 5 Jan: PT's BCA pays the CV 25 J (the line names CV MAJU BERSAMA). The same day Andi receives 25 J from PT — paid from PT's Mandiri,
    // whose statement is not imported yet. The CV's statement isn't imported yet either.
    const ptFile = bcaFile("1111111111", [`'05/01,"TRSF E-BANKING DB 0501/FTSCY/WS1 CV MAJU BERSAMA",'0000,"25,000,000.00",DB,"75,000,000.00"`], "100,000,000.00", "75,000,000.00");
    const ownerFile = bcaFile("3333333333", [`'05/01,"TRSF E-BANKING CR 0501/FTSCY/WS1 PT UJI SEJAHTERA",'0000,"25,000,000.00",CR,"35,000,000.00"`], "10,000,000.00", "35,000,000.00");
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "pt-bca.csv", data: Buffer.from(ptFile), provider: null });
    const ptTx = await db.bankTransaction.findFirstOrThrow({ where: { bankAccountId: g.pt.banks[0].id } });
    // Unpaired, it names the CV: on the CV's account (right).
    expect(await partyOf(g.client.id, ptTx.accountCode)).toBe("CV Maju");
    await importStatement(db, { bankAccountId: g.owner.banks[0].id, fileName: "andi-bca.csv", data: Buffer.from(ownerFile), provider: null });
    const ownerTx = await db.bankTransaction.findFirstOrThrow({ where: { bankAccountId: g.owner.banks[0].id } });
    const ptAfter = await db.bankTransaction.findUniqueOrThrow({ where: { id: ptTx.id } });
    // The matcher pairs by amount and date only: PT's line (paid to the CV) becomes the other half of Andi's receipt and is re-posted to
    // Andi's account — PT's books now show a loan to Andi and none to the CV. With one 1190 (two companies) that was harmless; with an
    // account per party it misstates both pairs. Right behaviour: a line naming a group company pairs only with that company's line, so
    // PT's line stays on the CV's account unpaired and Andi's receipt waits on PT's account for its own other half.
    expect({ ptLineOn: await partyOf(g.client.id, ptAfter.accountCode), pairedWithAndi: ptAfter.matchedTxId === ownerTx.id }).toEqual({ ptLineOn: "CV Maju", pairedWithAndi: false });
  });
});
