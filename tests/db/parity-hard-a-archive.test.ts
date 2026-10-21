import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { db, makeGroup, resetDb } from "../helpers";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { postJournal } from "@/lib/ledger/post";
import { postOpening } from "@/lib/opening";
import { archiveAccount, createAccount, unarchiveAccount } from "@/lib/coa/manage";
import { openingTargetOptions } from "@/lib/coa/options";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction } from "@/lib/review";
import { createRecurring, recurringDue, stopRecurring } from "@/lib/adjust/recurring";
import { importSourceAccounts, postImport, stageImport } from "@/lib/ledger-import/post";
import { acceptMappings, suggestMappings } from "@/lib/ledger-import/mapping";
import { trialBalance } from "@/lib/reports/ledger";
import { journalRegister } from "@/lib/reports/journal-register";
import { createClient, createFirm } from "@/lib/setup";
import { dateOnly } from "@/lib/format";

/**
 * Round nine, probe A — Arsip akun (cycle 2026-10-20-lampiran-arsip): archived only when nothing still counts on it (an editable account,
 * no line in an open month, a zero balance-sheet balance, no running schedule, asset, Jurnal berulang or waiting journal); then it leaves
 * every picker and the classifier, postJournal() refuses it, and reports keep its history.
 */

const lock = (g: { firm: { id: string }; client: { id: string } }, year: number, month: number) =>
  db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year, month } }, create: { firmId: g.firm.id, clientId: g.client.id, year, month, status: "LOCKED" }, update: { status: "LOCKED" } });
const account = (clientId: string, code: string) => db.account.findFirstOrThrow({ where: { clientId, code } });

/** Wait until `n` sessions of this database wait on a lock. */
async function waitForLockWaiters(n: number) {
  for (let i = 0; i < 200; i++) {
    const [{ c }] = await db.$queryRaw<{ c: number }[]>`SELECT count(*)::int AS c FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (c >= n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`fewer than ${n} sessions waiting on a lock`);
}

describe("arsip akun: refused while a balance still counts", () => {
  beforeEach(resetDb);

  it("DEFECT: a balance-sheet account two companies hold opposite balances on is archived, because the check nets the whole group", async () => {
    // 1140-range "Titipan Dana Proyek" (PIUTANG_LAIN). July 2026, both months then closed:
    //   PT Uji  Dr titipan 1.000.000 / Cr 1110 1.000.000   → PT's Neraca: titipan 1.000.000 (debit)
    //   Andi    Dr 1110 1.000.000 / Cr titipan 1.000.000   → Andi's Neraca: titipan (1.000.000) (credit)
    // Σ over the client = 0, but each company's Neraca still carries 1.000.000: archiving would freeze a balance nobody can clear without
    // reactivating it. The balance must be zero per company, so the archive is refused ("masih bersaldo").
    const g = await makeGroup();
    const x = await createAccount(db, { clientId: g.client.id, fsLine: "PIUTANG_LAIN", name: "Titipan Dana Proyek" });
    await postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 7, 10), memo: "Titip dana", lines: [{ accountCode: x.code, debit: "1.000.000", credit: "" }, { accountCode: "1110", debit: "", credit: "1.000.000" }] });
    await postAdjustment(db, { clientId: g.client.id, entityId: g.owner.entity.id, date: dateOnly(2026, 7, 11), memo: "Terima titipan", lines: [{ accountCode: "1110", debit: "1.000.000", credit: "" }, { accountCode: x.code, debit: "", credit: "1.000.000" }] });
    await lock(g, 2026, 7);
    const pt = await trialBalance(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, dateOnly(2026, 7, 31));
    expect(pt.find((r) => r.account.code === x.code)!.net).toBe(1_000_000n);
    await expect(archiveAccount(db, { clientId: g.client.id, accountId: x.id })).rejects.toThrow("masih bersaldo");
  });

  it("DEFECT: in a Rupiah + Dollar group, Rp 1.000.000 and US$ 10.000,00 on one account add up to 'zero' and the account is archived", async () => {
    // PT Rp: Dr X Rp 1.000.000 (1.000.000 minor units). PT USD: Cr X US$ 10.000,00 (1.000.000 cents). The check sums minor units of two
    // currencies: 1.000.000 − 1.000.000 = 0. Each company holds a balance (Rp 1.000.000; US$ 10.000,00): refused.
    const firm = await createFirm(db, "KJA Valas");
    const { client, entities } = await createClient(db, firm.id, {
      name: "Grup Valas",
      industry: "trading",
      entities: [
        { name: "PT Rupiah", shortName: "PT Rp", kind: "PT", banks: [] },
        { name: "PT Dolar", shortName: "PT USD", kind: "PT", functionalCurrency: "USD", banks: [] },
      ],
    });
    const [rp, usd] = entities.map((e) => e.entity);
    const x = await createAccount(db, { clientId: client.id, fsLine: "PIUTANG_LAIN", name: "Piutang Pihak Ketiga" });
    await postAdjustment(db, { clientId: client.id, entityId: rp.id, date: dateOnly(2026, 7, 10), memo: "Pinjaman ke pihak ketiga", lines: [{ accountCode: x.code, debit: "1.000.000", credit: "" }, { accountCode: "1110", debit: "", credit: "1.000.000" }] });
    await postAdjustment(db, { clientId: client.id, entityId: usd.id, date: dateOnly(2026, 7, 10), memo: "Titipan pihak ketiga", lines: [{ accountCode: "1110", debit: "10.000,00", credit: "" }, { accountCode: x.code, debit: "", credit: "10.000,00" }] });
    const usdLine = await db.journalLine.findFirstOrThrow({ where: { entityId: usd.id, accountId: x.id } });
    expect(usdLine.credit).toBe(1_000_000n); // US$ 10.000,00 in cents
    await lock({ firm, client }, 2026, 7);
    await expect(archiveAccount(db, { clientId: client.id, accountId: x.id })).rejects.toThrow("masih bersaldo");
  });

  it("refused: an open month's line, a single company's balance, a running Jurnal berulang; allowed once those are gone, undone by Aktifkan lagi", async () => {
    const g = await makeGroup();
    const rent = await createAccount(db, { clientId: g.client.id, fsLine: "BEBAN_UMUM_ADM", name: "Beban Sewa Gudang Lama" });
    const july = await postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 7, 10), memo: "Sewa gudang", lines: [{ accountCode: rent.code, debit: "1.000.000", credit: "" }, { accountCode: "1110", debit: "", credit: "1.000.000" }] });
    await expect(archiveAccount(db, { clientId: g.client.id, accountId: rent.id })).rejects.toThrow("masih dipakai di bulan yang belum ditutup (7/2026)");
    const t = await createRecurring(db, { clientId: g.client.id, entryId: july.id });
    await lock(g, 2026, 7);
    await expect(archiveAccount(db, { clientId: g.client.id, accountId: rent.id })).rejects.toThrow("1 jurnal berulang");
    await stopRecurring(db, { clientId: g.client.id, recurringId: t.id });
    await archiveAccount(db, { clientId: g.client.id, accountId: rent.id });
    expect((await account(g.client.id, rent.code)).archivedAt).not.toBeNull();
    await unarchiveAccount(db, { clientId: g.client.id, accountId: rent.id });
    expect((await account(g.client.id, rent.code)).archivedAt).toBeNull();
  });

  it("DEFECT: a Jurnal berulang whose end month has passed on the calendar but whose instalments are still unposted does not hold the account", async () => {
    // The books run behind the calendar, as at most firms. Template from M0's rent (Dr sewa 1.000.000 / Cr 1110), instalments M0+1 and
    // M0+2 (its end), both before today's month and neither posted yet; M0 is closed. recurringDue() still proposes both instalments, yet
    // archiveAccount counts a template as running only while its end month ≥ today's month, so the archive goes through and both
    // instalments can never post (postJournal refuses the archived account), holding up the close of M0+1. Expected: refused, "1 jurnal berulang".
    const g = await makeGroup();
    const now = new Date();
    const idx = now.getUTCFullYear() * 12 + now.getUTCMonth(); // 0-based month index of today
    const m = (i: number) => ({ year: Math.floor(i / 12), month: (i % 12) + 1 });
    const m0 = m(idx - 4);
    const end = m(idx - 2);
    const rent = await createAccount(db, { clientId: g.client.id, fsLine: "BEBAN_UMUM_ADM", name: "Beban Sewa Gudang Lama" });
    const first = await postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(m0.year, m0.month, 10), memo: "Sewa gudang", lines: [{ accountCode: rent.code, debit: "1.000.000", credit: "" }, { accountCode: "1110", debit: "", credit: "1.000.000" }] });
    await createRecurring(db, { clientId: g.client.id, entryId: first.id, end });
    await lock(g, m0.year, m0.month);
    expect((await recurringDue(db, g.client.id, end.year, end.month)).length).toBe(2);
    await expect(archiveAccount(db, { clientId: g.client.id, accountId: rent.id })).rejects.toThrow("1 jurnal berulang");
  });
});

describe("arsip akun: nothing reaches an archived account", () => {
  beforeEach(resetDb);

  it("DEFECT: a posting already past its checks when the account is archived still lands on it, in an open month", async () => {
    // postJournal() reads the accounts (archivedAt null) without a lock; archiveAccount() then takes the account row FOR UPDATE, finds no
    // line, archives and commits; the posting's insert then goes through. A busy series (another journal holding the August JP counter)
    // keeps the posting between its check and its insert. Afterwards an archived account carries a line in an open month — the state the
    // archive's own checks forbid. Either the posting must be refused ("sudah diarsipkan") or the archive must wait and see the line.
    const g = await makeGroup();
    const x = await createAccount(db, { clientId: g.client.id, fsLine: "BEBAN_UMUM_ADM", name: "Beban Perbaikan Lama" });
    const atk = await account(g.client.id, "6160");
    const kas = await account(g.client.id, "1110");
    await postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 8, 1), memo: "Pembuka seri", lines: [{ accountCode: "6160", debit: "10.000", credit: "" }, { accountCode: "1110", debit: "", credit: "10.000" }] });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const busy = db.$transaction(async (tx) => {
      await postJournal(tx, { entityId: g.pt.entity.id, date: dateOnly(2026, 8, 2), kind: "ADJUSTMENT", memo: "Jurnal lain", lines: [{ accountId: atk.id, debit: 20_000n }, { accountId: kas.id, credit: 20_000n }] });
      held();
      await gate;
    }, { timeout: 30_000 });
    await holding;
    const posting = postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, 8, 15), memo: "Perbaikan atap", lines: [{ accountCode: x.code, debit: "750.000", credit: "" }, { accountCode: "1110", debit: "", credit: "750.000" }] }).then(
      () => "posted",
      (e: Error) => e.message,
    );
    await waitForLockWaiters(1);
    const archived = await archiveAccount(db, { clientId: g.client.id, accountId: x.id }).then(
      () => "archived",
      (e: Error) => e.message,
    );
    release();
    await busy;
    const posted = await posting;
    const lines = await db.journalLine.count({ where: { accountId: x.id } });
    const state = { archived: (await account(g.client.id, x.code)).archivedAt !== null, linesOnAccount: lines };
    // Never both: an archived account with a line in open August.
    expect(state.archived && state.linesOnAccount > 0, `archive: ${archived}; posting: ${posted}`).toBe(false);
  });

  it("a remembered choice for an archived account falls through to Review; reviewing to it is refused; reports keep its history; after Aktifkan lagi it posts", async () => {
    const g = await makeGroup();
    const fix = await createAccount(db, { clientId: g.client.id, fsLine: "BEBAN_UMUM_ADM", name: "Beban Perbaikan Gudang" });
    const aug = ["Tanggal;Keterangan;Debet;Kredit;Saldo", "01/08/2026;SALDO AWAL;;;10.000.000,00", "05/08/2026;TOKO BANGUNAN SINAR JAYA;250.000,00;0,00;9.750.000,00", ""].join("\n");
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "agustus.csv", data: Buffer.from(aug), provider: null });
    const a = await db.bankTransaction.findFirstOrThrow({ where: { description: { contains: "SINAR JAYA" } } });
    await reviewTransaction(db, { bankTxId: a.id, accountCode: fix.code, taxTag: null });
    expect(await db.memory.count({ where: { clientId: g.client.id, accountCode: fix.code } })).toBe(1);
    await lock(g, 2026, 8);
    await archiveAccount(db, { clientId: g.client.id, accountId: fix.id });

    const sep = ["Tanggal;Keterangan;Debet;Kredit;Saldo", "01/09/2026;SALDO AWAL;;;9.750.000,00", "07/09/2026;TOKO BANGUNAN SINAR JAYA;300.000,00;0,00;9.450.000,00", ""].join("\n");
    await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "september.csv", data: Buffer.from(sep), provider: null });
    const b = await db.bankTransaction.findFirstOrThrow({ where: { description: { contains: "SINAR JAYA" }, date: dateOnly(2026, 9, 7) } });
    expect([b.method === "MEMORY", b.accountCode === fix.code, b.suggestedCode === fix.code]).toEqual([false, false, false]);
    await expect(reviewTransaction(db, { bankTxId: b.id, accountCode: fix.code, taxTag: null })).rejects.toThrow(`Akun ${fix.code} Beban Perbaikan Gudang sudah diarsipkan.`);

    // History stays: September's trial balance (year to date) still shows August's 250.000; Jurnal Umum August still lists the line.
    const tb = await trialBalance(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, dateOnly(2026, 9, 30));
    expect(tb.find((r) => r.account.code === fix.code)!.net).toBe(250_000n);
    const reg = await journalRegister(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, { start: dateOnly(2026, 8, 1), end: dateOnly(2026, 8, 31), kinds: null, search: null }, "all");
    expect(reg.entries.some((e) => e.lines.some((l) => l.code === fix.code && l.debit === 250_000n))).toBe(true);

    await unarchiveAccount(db, { clientId: g.client.id, accountId: fix.id });
    await reviewTransaction(db, { bankTxId: b.id, accountCode: fix.code, taxTag: null });
    const tb2 = await trialBalance(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, dateOnly(2026, 9, 30));
    expect(tb2.find((r) => r.account.code === fix.code)!.net).toBe(550_000n); // 250.000 + 300.000
  });

  it("Saldo Awal: an archived balance-sheet account is not offered and is refused", async () => {
    const g = await makeGroup();
    const y = await createAccount(db, { clientId: g.client.id, fsLine: "PIUTANG_LAIN", name: "Piutang Lama Direksi" });
    await archiveAccount(db, { clientId: g.client.id, accountId: y.id });
    const chart = await db.account.findMany({ where: { clientId: g.client.id } });
    expect(openingTargetOptions(chart).some((o) => o.code === y.code)).toBe(false);
    await expect(postOpening(db, { clientId: g.client.id, entityId: g.owner.entity.id, date: dateOnly(2026, 6, 30), lines: [{ accountCode: y.code, debit: "1.000.000", credit: "" }, { accountCode: "3100", debit: "", credit: "1.000.000" }] })).rejects.toThrow("sudah diarsipkan");
    expect(await db.journalEntry.count()).toBe(0);
  });
});

describe("arsip akun: ledger-import mapping", () => {
  beforeEach(resetDb);

  async function xlsx(rows: unknown[][]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("GL");
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const H = ["Entity", "Entry Date", "Account Code", "Account Name", "Currency", "Debit", "Credit", "Notes"];

  /** PT's January GL maps 61500 "Sewa Gudang Lama" to a new account, January is closed, the account archived; Andi's February GL has a 61500 of the same name. */
  async function books() {
    const g = await makeGroup();
    const x = await createAccount(db, { clientId: g.client.id, fsLine: "BEBAN_UMUM_ADM", name: "Beban Sewa Gudang Lama" });
    const jan = await xlsx([H, ["PT Uji", new Date(Date.UTC(2026, 0, 31)), "61500", "Sewa Gudang Lama", "IDR", 1_000_000, 0, ""], ["PT Uji", new Date(Date.UTC(2026, 0, 31)), "10000", "Kas", "IDR", 0, 1_000_000, ""]]);
    const s1 = await stageImport(db, { firmId: g.firm.id, clientId: g.client.id, fileName: "gl-jan.xlsx", data: jan });
    if (s1.status !== "STAGED") throw new Error("not staged");
    const src1 = await importSourceAccounts(db, s1.importId);
    await acceptMappings(db, g.client.id, src1.map((s) => ({ sourceAccountId: s.id, accountCode: s.code === "61500" ? x.code : "1110", method: "MANUAL" as const })));
    await postImport(db, g.client.id, s1.importId);
    await lock(g, 2026, 1);
    await archiveAccount(db, { clientId: g.client.id, accountId: x.id });
    const feb = await xlsx([H, ["Andi", new Date(Date.UTC(2026, 1, 28)), "61500", "Sewa Gudang Lama", "IDR", 500_000, 0, ""], ["Andi", new Date(Date.UTC(2026, 1, 28)), "10000", "Kas", "IDR", 0, 500_000, ""]]);
    const s2 = await stageImport(db, { firmId: g.firm.id, clientId: g.client.id, fileName: "gl-feb.xlsx", data: feb });
    if (s2.status !== "STAGED") throw new Error("not staged");
    await suggestMappings(db, { firmId: g.firm.id, clientId: g.client.id, provider: null, useAi: false });
    const andiRent = (await importSourceAccounts(db, s2.importId)).find((s) => s.entityId === g.owner.entity.id && s.code === "61500")!;
    return { g, x, andiRent, importId: s2.importId };
  }

  it("DEFECT: 'same name mapped before' suggests the archived account for another company's source account", async () => {
    // keywordSuggestion's PRIOR map is built from every accepted mapping, the archived target included, and is never checked against the
    // mappable (unarchived) chart. Andi's 61500 "Sewa Gudang Lama" is suggested as the archived account (PRIOR, 95%). Expected: not suggested.
    const { x, andiRent } = await books();
    expect(andiRent.suggestedCode).not.toBe(x.code);
  });

  it("DEFECT: accepting a mapping to an archived account is not refused; the import only fails at Catat", async () => {
    // acceptMappings() reads the whole chart (archived included) and refuses only suspense, clearing, system-only and foreign bank targets.
    // A mapping to an archived account must be refused when it is made, as every picker hides it; today it is stored and postImport then
    // fails inside postJournal ("sudah diarsipkan").
    const { g, x, andiRent } = await books();
    await expect(acceptMappings(db, g.client.id, [{ sourceAccountId: andiRent.id, accountCode: x.code, method: "MANUAL" }])).rejects.toThrow(/diarsipkan/);
  });
});
