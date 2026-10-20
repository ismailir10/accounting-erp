import { beforeEach, describe, expect, it } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { postAdjustment } from "@/lib/ledger/adjustment";
import { addAttachments, attachmentFile, attachmentsOf, cleanName, MAX_ATTACHMENTS, removeAttachment, sniff } from "@/lib/ledger/attachments";
import { importStatement } from "@/lib/import/pipeline";
import { removeStatementImport } from "@/lib/imports/remove";
import { randomUUID } from "node:crypto";
import { listEvents } from "@/lib/audit";
import { dateOnly } from "@/lib/format";

/** Lampiran jurnal (cycle 2026-10-20-lampiran-arsip): evidence kept with a journal, never a number. */
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(100, 32)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50)]);

describe("lampiran jurnal", () => {
  beforeEach(resetDb);

  const journal = (g: Awaited<ReturnType<typeof makeGroup>>, month = 8) =>
    postAdjustment(db, { clientId: g.client.id, entityId: g.pt.entity.id, date: dateOnly(2026, month, 20), memo: "Beli ATK", lines: [{ accountCode: "6160", debit: "500.000", credit: "" }, { accountCode: "1110", debit: "", credit: "500.000" }] });

  it("keeps PDF and PNG files with the journal, told by their bytes; Riwayat says so", async () => {
    const g = await makeGroup();
    const e = await journal(g);
    const added = await addAttachments(db, { clientId: g.client.id, entryId: e.id, files: [{ name: "C:\\scan\\nota toko.pdf", data: PDF }, { name: "struk", data: PNG }] });
    expect(added.map((a) => a.fileName)).toEqual(["nota toko.pdf", "struk.png"]);
    const listed = (await attachmentsOf(db, [e.id])).get(e.id)!;
    expect(listed.map((a) => [a.fileName, a.size])).toEqual([["nota toko.pdf", PDF.length], ["struk.png", PNG.length]]);
    const file = await attachmentFile(db, g.client.id, listed[0].id);
    expect([file!.contentType, Buffer.from(file!.data).equals(PDF)]).toEqual(["application/pdf", true]);
    const events = await listEvents(db, g.client.id, { kind: "ATTACHMENT" });
    expect(events[0].summary).toBe("Lampiran ditambahkan ke JP-2608-0001 · Beli ATK: nota toko.pdf, struk.png");
    // The ledger is untouched.
    expect(await db.journalLine.count()).toBe(2);
  });

  it("refuses other types, empty and oversized files, more than ten, and another client's journal; nothing is stored", async () => {
    const g = await makeGroup();
    const other = await makeGroup();
    const e = await journal(g);
    const add = (files: { name: string; data: Buffer }[], clientId = g.client.id) => addAttachments(db, { clientId, entryId: e.id, files });
    await expect(add([{ name: "nota.pdf", data: Buffer.from("<html>bukan pdf</html>") }])).rejects.toThrow("nota.pdf bukan PDF, JPG atau PNG.");
    await expect(add([{ name: "kosong.pdf", data: Buffer.alloc(0) }])).rejects.toThrow("kosong.pdf kosong.");
    await expect(add([{ name: "besar.pdf", data: Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]) }])).rejects.toThrow("terlalu besar");
    await expect(add(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({ name: `n${i}.pdf`, data: PDF })))).rejects.toThrow("paling banyak 10 lampiran");
    await expect(add([{ name: "nota.pdf", data: PDF }], other.client.id)).rejects.toThrow("Jurnal tidak ditemukan.");
    expect(await db.journalAttachment.count()).toBe(0);
    // A download through another client's page finds nothing.
    const [a] = await add([{ name: "nota.pdf", data: PDF }]);
    expect(await attachmentFile(db, other.client.id, a.id)).toBeNull();
  });

  it("is removed while the month is open; a closed month, or a closed later month, keeps it", async () => {
    const g = await makeGroup();
    const e = await journal(g);
    const [a, b] = await addAttachments(db, { clientId: g.client.id, entryId: e.id, files: [{ name: "a.pdf", data: PDF }, { name: "b.pdf", data: PDF }] });
    await removeAttachment(db, { clientId: g.client.id, attachmentId: a.id });
    await db.period.create({ data: { firmId: g.firm.id, clientId: g.client.id, year: 2026, month: 9, status: "LOCKED" } });
    await expect(removeAttachment(db, { clientId: g.client.id, attachmentId: b.id })).rejects.toThrow("September 2026 sudah ditutup: lampiran tetap bersama jurnalnya.");
    // Evidence arriving after the close is still accepted.
    await addAttachments(db, { clientId: g.client.id, entryId: e.id, files: [{ name: "c.pdf", data: PDF }] });
    expect((await attachmentsOf(db, [e.id])).get(e.id)!.map((x) => x.fileName)).toEqual(["b.pdf", "c.pdf"]);
    expect((await listEvents(db, g.client.id, { kind: "ATTACHMENT" })).map((x) => x.summary.split(":")[0])).toContain("Lampiran dihapus dari JP-2608-0001 · Beli ATK");
  });

  it("an import whose journal carries a lampiran is not removed until the lampiran is", async () => {
    const g = await makeGroup();
    const bca = g.pt.banks[0];
    const csv = ["Tanggal;Keterangan;Debet;Kredit;Saldo", "01/08/2026;SALDO AWAL;;;10.000.000,00", "03/08/2026;BIAYA ADM;15.000,00;0,00;9.985.000,00", ""].join("\n");
    const s = await importStatement(db, { bankAccountId: bca.id, fileName: "agustus.csv", data: Buffer.from(csv), provider: null });
    const entry = await db.journalEntry.findFirstOrThrow({ where: { kind: "BANK" } });
    const [a] = await addAttachments(db, { clientId: g.client.id, entryId: entry.id, files: [{ name: "nota-bank.pdf", data: PDF }] });
    const admin = await db.firmMember.create({ data: { firmId: g.firm.id, userId: randomUUID(), email: `admin-${randomUUID()}@example.test`, name: "Admin Uji", role: "ADMIN" } });
    const remove = () => removeStatementImport(db, { clientId: g.client.id, importId: s.importId, reason: "File Agustus salah rekening", actor: admin });
    await expect(remove()).rejects.toThrow("1 jurnal dari impor ini punya lampiran (BK-2608-0001)");
    await removeAttachment(db, { clientId: g.client.id, attachmentId: a.id });
    await remove();
    expect(await db.journalEntry.count()).toBe(0);
  });

  it("names and types", () => {
    expect([sniff(PDF)?.type, sniff(PNG)?.type, sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.type, sniff(Buffer.from("GIF89a"))]).toEqual(["application/pdf", "image/png", "image/jpeg", null]);
    expect([cleanName("../../etc/passwd", "pdf"), cleanName('a"b.pdf', "pdf"), cleanName("", "png")]).toEqual(["passwd.pdf", "ab.pdf", "lampiran.png"]);
  });
});
