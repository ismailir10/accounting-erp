import { beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { addAttachments, attachmentsOf, MAX_ATTACHMENTS, removeAttachment } from "@/lib/ledger/attachments";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction } from "@/lib/review";
import { removeLedgerImport, removeStatementImport } from "@/lib/imports/remove";
import { importSourceAccounts, postImport, stageImport } from "@/lib/ledger-import/post";
import { acceptMappings, suggestMappings } from "@/lib/ledger-import/mapping";
import { deleteClient } from "@/lib/clients/delete";
import { MAX_UPLOAD_BYTES } from "@/lib/upload";
import { journalRegister } from "@/lib/reports/journal-register";
import { journalWorkbook } from "@/lib/reports/ledger-workbook";
import { dateOnly } from "@/lib/format";

// The download route and the remove action through the real guard (tests/members.ts).
const auth = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({ authConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getClaims: async () => ({ data: auth.userId ? { claims: { sub: auth.userId } } : null }) } }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const { removeAttachmentAction } = await import("@/app/actions");
const { GET } = await import("@/app/(app)/clients/[id]/journals/lampiran/[attachmentId]/route");

/** Round nine, probe A — Lampiran jurnal (cycle 2026-10-20-lampiran-arsip): evidence beside an entry, never a number. */
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(100, 32)]);
type G = Awaited<ReturnType<typeof makeGroup>>;

const lock = (g: G, year: number, month: number) =>
  db.period.upsert({ where: { clientId_year_month: { clientId: g.client.id, year, month } }, create: { firmId: g.firm.id, clientId: g.client.id, year, month, status: "LOCKED" }, update: { status: "LOCKED" } });
const journal = (g: G, month = 8) =>
  postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, month, 20), memo: "Beli ATK", lines: [{ accountCode: "6160", debit: "500.000", credit: "" }, { accountCode: "1110", debit: "", credit: "500.000" }] });
const files = (n: number, prefix = "n") => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}.pdf`, data: PDF }));
/** Wait until `n` sessions of this database wait on a row lock (two writers parked behind a held row). */
async function waitForLockWaiters(n: number) {
  for (let i = 0; i < 200; i++) {
    const [{ c }] = await db.$queryRaw<{ c: number }[]>`SELECT count(*)::int AS c FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (c >= n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`fewer than ${n} sessions waiting on a lock`);
}
const download = (clientId: string, attachmentId: string) =>
  GET(new Request(`http://localhost/clients/${clientId}/journals/lampiran/${attachmentId}`), { params: Promise.resolve({ id: clientId, attachmentId }) });

describe("lampiran jurnal: limits", () => {
  beforeEach(async () => {
    await resetDb();
    auth.userId = null;
  });

  it("exactly 5 MB is taken, one byte more is refused; nine plus one fits, the eleventh is refused", async () => {
    const g = await makeGroup();
    const e = await journal(g);
    const exact = Buffer.concat([PDF, Buffer.alloc(MAX_UPLOAD_BYTES - PDF.length)]);
    expect(exact.length).toBe(5 * 1024 * 1024);
    await addAttachments(db, { clientId: g.client.id, entryId: e.id, files: [{ name: "pas.pdf", data: exact }] });
    await expect(addAttachments(db, { clientId: g.client.id, entryId: e.id, files: [{ name: "lebih.pdf", data: Buffer.concat([exact, Buffer.alloc(1)]) }] })).rejects.toThrow("lebih.pdf terlalu besar (maks. 5 MB).");
    await addAttachments(db, { clientId: g.client.id, entryId: e.id, files: files(8) });
    await addAttachments(db, { clientId: g.client.id, entryId: e.id, files: files(1, "kesepuluh") });
    await expect(addAttachments(db, { clientId: g.client.id, entryId: e.id, files: files(1, "kesebelas") })).rejects.toThrow(`Satu jurnal paling banyak ${MAX_ATTACHMENTS} lampiran.`);
    expect(await db.journalAttachment.count({ where: { entryId: e.id } })).toBe(10);
  });

  it("DEFECT: two uploads at once each pass the ten-file check and the journal ends with twelve lampiran", async () => {
    // 0 on the journal; two tabs each add 6 files. addAttachments reads the count (0) outside its transaction and nothing serialises the
    // two, so 0 + 6 ≤ 10 passes twice and the journal holds 12. The rule is "10 per journal": one of the two must be refused, ≤ 10 stay.
    // To make the interleaving certain (it happens on its own only sometimes), a third session holds the journal row while both uploads
    // read the count; their inserts (a key-share on the journal row) wait, and go through once it lets go.
    const g = await makeGroup();
    const e = await journal(g);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "JournalEntry" WHERE id = ${e.id} FOR UPDATE`;
      held();
      await gate;
    }, { timeout: 30_000 });
    await holding;
    const uploads = Promise.allSettled([
      addAttachments(db, { clientId: g.client.id, entryId: e.id, files: files(6, "a") }),
      addAttachments(db, { clientId: g.client.id, entryId: e.id, files: files(6, "b") }),
    ]);
    await waitForLockWaiters(2);
    release();
    await holder;
    const results = await uploads;
    expect(await db.journalAttachment.count({ where: { entryId: e.id } })).toBeLessThanOrEqual(MAX_ATTACHMENTS);
    expect(results.filter((r) => r.status === "rejected").length).toBe(1);
  });

  it("DEFECT: a PDF uploaded as 'bukti.html' is served for download as 'bukti.html', not with the extension its bytes say", async () => {
    // cleanName's contract: "the uploaded name without a path or control characters, with the extension its bytes say". The bytes are a
    // PDF (application/pdf), so the stored and downloaded name must end in .pdf — a file that saves to disk as .html (or .exe, .svg) opens
    // in another program than the type Buku checked. Expected e.g. "bukti.html.pdf" or "bukti.pdf"; it keeps "bukti.html".
    const g = await makeGroup();
    const e = await journal(g);
    const [a] = await addAttachments(db, { clientId: g.client.id, entryId: e.id, files: [{ name: "bukti.html", data: PDF }] });
    expect(a.fileName).toMatch(/\.pdf$/);
  });
});

describe("lampiran jurnal: removal follows the month", () => {
  beforeEach(resetDb);

  it("removed in an open month; refused once its own month is closed; another client's id is not found; adding to a closed month is allowed", async () => {
    const g = await makeGroup();
    const other = await makeGroup();
    const e = await journal(g, 8);
    const [a, b] = await addAttachments(db, { clientId: g.client.id, entryId: e.id, files: files(2) });
    await expect(removeAttachment(db, { clientId: other.client.id, attachmentId: a.id })).rejects.toThrow("Lampiran tidak ditemukan.");
    await removeAttachment(db, { clientId: g.client.id, attachmentId: a.id });
    await lock(g, 2026, 8);
    await expect(removeAttachment(db, { clientId: g.client.id, attachmentId: b.id })).rejects.toThrow("Agustus 2026 sudah ditutup: lampiran tetap bersama jurnalnya.");
    await addAttachments(db, { clientId: g.client.id, entryId: e.id, files: files(1, "susulan") });
    expect((await attachmentsOf(db, [e.id])).get(e.id)!.map((x) => x.fileName)).toEqual(["n1.pdf", "susulan0.pdf"]);
    // The ledger never moved.
    expect(await db.journalLine.count()).toBe(2);
  });
});

describe("lampiran jurnal: who may fetch or remove", () => {
  beforeEach(async () => {
    await resetDb();
    auth.userId = null;
  });

  it("an assigned member downloads it; another firm's member, an unassigned akuntan, and a client URL holding another client's id get 404", async () => {
    const g = await makeGroup();
    const other = await makeGroup();
    const e = await journal(g);
    const [a] = await addAttachments(db, { clientId: g.client.id, entryId: e.id, files: [{ name: "nota toko.pdf", data: PDF }] });
    // Another client of the same firm, with its own journal.
    const sister = await db.$transaction(async (tx) => (await import("@/lib/setup")).createClient(tx, g.firm.id, { name: "Klien Saudara", industry: "", entities: [{ name: "PT Saudara", shortName: "Saudara", kind: "PT", banks: [] }] }));

    const assigned = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    auth.userId = assigned.userId;
    const ok = await download(g.client.id, a.id);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("application/pdf");
    expect(ok.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(ok.headers.get("Content-Disposition")).toBe(`attachment; filename="nota toko.pdf"; filename*=UTF-8''nota%20toko.pdf`);
    expect(Buffer.from(await ok.arrayBuffer()).equals(PDF)).toBe(true);
    // An attachment id under a client the member may open, but belonging to another client: not found.
    const sisterMember = await addMember(g.firm.id, "AKUNTAN", { clients: [sister.client.id] });
    auth.userId = sisterMember.userId;
    expect((await download(sister.client.id, a.id)).status).toBe(404);
    expect((await download(g.client.id, a.id)).status).toBe(404);
    const outsider = await addMember(other.firm.id, "OWNER");
    auth.userId = outsider.userId;
    expect((await download(g.client.id, a.id)).status).toBe(404);
  });

  it("a viewer may download but not remove; the akuntan's removal goes through", async () => {
    const g = await makeGroup();
    const e = await journal(g);
    const [a] = await addAttachments(db, { clientId: g.client.id, entryId: e.id, files: files(1) });
    const viewer = await addMember(g.firm.id, "VIEWER", { clients: [g.client.id] });
    auth.userId = viewer.userId;
    expect((await download(g.client.id, a.id)).status).toBe(200);
    expect(await removeAttachmentAction(g.client.id, a.id)).toMatchObject({ ok: false });
    expect(await db.journalAttachment.count()).toBe(1);
    const akuntan = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    auth.userId = akuntan.userId;
    expect(await removeAttachmentAction(g.client.id, a.id)).toEqual({ ok: true });
    expect(await db.journalAttachment.count()).toBe(0);
  });
});

describe("lampiran jurnal: nothing removes them silently", () => {
  beforeEach(resetDb);

  async function xlsx(rows: unknown[][]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("GL");
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const admin = (g: G) => addMember(g.firm.id, "ADMIN");

  it("a statement import whose reclassification carries a lampiran is not removed until the lampiran is", async () => {
    const g = await makeGroup();
    const csv = ["Tanggal;Keterangan;Debet;Kredit;Saldo", "01/08/2026;SALDO AWAL;;;10.000.000,00", "03/08/2026;BIAYA ADM;15.000,00;0,00;9.985.000,00", ""].join("\n");
    const s = await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "agustus.csv", data: Buffer.from(csv), provider: null });
    const t = await db.bankTransaction.findFirstOrThrow({ where: { description: { contains: "BIAYA ADM" } } });
    await reviewTransaction(db, { bankTxId: t.id, accountCode: t.accountCode === "6170" ? "6160" : "6170", taxTag: null });
    const reclass = await db.journalEntry.findFirstOrThrow({ where: { kind: "RECLASS" } });
    const [a] = await addAttachments(db, { clientId: g.client.id, entryId: reclass.id, files: [{ name: "memo.pdf", data: PDF }] });
    const actor = await admin(g);
    const remove = () => removeStatementImport(db, { clientId: g.client.id, importId: s.importId, reason: "File Agustus salah rekening", actor });
    await expect(remove()).rejects.toThrow("1 jurnal dari impor ini punya lampiran (RK-2608-0001)");
    expect(await db.journalAttachment.count()).toBe(1);
    await removeAttachment(db, { clientId: g.client.id, attachmentId: a.id });
    await remove();
    expect(await db.journalEntry.count()).toBe(0);
  });

  it("a ledger import whose journal carries a lampiran is not removed until the lampiran is", async () => {
    const g = await makeGroup();
    const file = await xlsx([
      ["Entity", "Entry Date", "Account Code", "Account Name", "Currency", "Debit", "Credit", "Notes"],
      ["PT Uji", new Date(Date.UTC(2026, 0, 31)), "60001", "Beban Gaji", "IDR", 5_000_000, 0, ""],
      ["PT Uji", new Date(Date.UTC(2026, 0, 31)), "10000", "Kas", "IDR", 0, 5_000_000, ""],
    ]);
    const staged = await stageImport(db, { firmId: g.firm.id, clientId: g.client.id, fileName: "gl.xlsx", data: file });
    if (staged.status !== "STAGED") throw new Error("not staged");
    await suggestMappings(db, { firmId: g.firm.id, clientId: g.client.id, provider: null, useAi: false });
    const src = await importSourceAccounts(db, staged.importId);
    await acceptMappings(db, g.client.id, src.map((s) => ({ sourceAccountId: s.id, accountCode: s.code === "10000" ? "1110" : "6100", method: "MANUAL" as const })));
    await postImport(db, g.client.id, staged.importId);
    const entry = await db.journalEntry.findFirstOrThrow({ where: { ledgerImportId: staged.importId } });
    expect(entry.number).toBe("JI-2601-0001");
    const [a] = await addAttachments(db, { clientId: g.client.id, entryId: entry.id, files: [{ name: "slip gaji.pdf", data: PDF }] });
    const actor = await admin(g);
    const remove = () => removeLedgerImport(db, { clientId: g.client.id, importId: staged.importId, reason: "File buku besar salah bulan", actor });
    await expect(remove()).rejects.toThrow("1 jurnal dari impor ini punya lampiran (JI-2601-0001)");
    await removeAttachment(db, { clientId: g.client.id, attachmentId: a.id });
    await remove();
    expect(await db.journalEntry.count()).toBe(0);
  });

  it("deleting a client takes its lampiran with its books and leaves another client's", async () => {
    const g = await makeGroup();
    const other = await makeGroup();
    await addAttachments(db, { clientId: g.client.id, entryId: (await journal(g)).id, files: files(2) });
    const kept = await addAttachments(db, { clientId: other.client.id, entryId: (await journal(other)).id, files: files(1) });
    await deleteClient(db, { firmId: g.firm.id, clientId: g.client.id, confirmName: "Grup Uji" });
    expect((await db.journalAttachment.findMany({ select: { id: true } })).map((x) => x.id)).toEqual([kept[0].id]);
  });
});

describe("lampiran jurnal: shown where the journal is", () => {
  beforeEach(resetDb);

  it("Jurnal Umum lists them with the journal and its Excel names them in the source column; no amount changes", async () => {
    const g = await makeGroup();
    const e = await journal(g);
    await addAttachments(db, { clientId: g.client.id, entryId: e.id, files: [{ name: "nota toko.pdf", data: PDF }, { name: "struk.pdf", data: PDF }] });
    const reg = await journalRegister(db, { clientId: g.client.id, entityIds: [g.pt.entity.id] }, { start: dateOnly(2026, 8, 1), end: dateOnly(2026, 8, 31), kinds: null, search: null }, "all");
    expect(reg.entries.map((x) => [x.number, x.attachments.map((a) => a.fileName)])).toEqual([["JP-2608-0001", ["nota toko.pdf", "struk.pdf"]]]);
    expect([reg.debit, reg.credit]).toEqual([500_000n, 500_000n]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await journalWorkbook({ firm: "KJA Uji", title: "Grup Uji" }, "Agustus 2026", reg.entries)) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Jurnal Umum")!;
    let source = "";
    ws.eachRow((r) => {
      if (r.getCell(2).value === "JP-2608-0001") source = String(r.getCell(10).value);
    });
    expect(source).toContain("lampiran: nota toko.pdf, struk.pdf");
  });
});
