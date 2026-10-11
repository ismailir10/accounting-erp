import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { db, makeGroup, resetDb } from "../helpers";
import { makePdf, smbcCombinedPdf, table } from "../pdf-fixture";
import { checkFile, type BankSection, type LedgerSection } from "@/lib/inbox/check";
import { keyringSize } from "@/lib/inbox/keyring";
import { toBcaCsv } from "@/lib/demo/writers";
import { createClient } from "@/lib/setup";

const SECRET = "inbox-check-test-secret-32-characters-long";
beforeEach(async () => {
  vi.stubEnv("SETTINGS_SECRET", SECRET);
  await resetDb();
});
afterEach(() => vi.unstubAllEnvs());

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
const bcaCsv = (month: number, accountNumber = "1111111111") =>
  Buffer.from(toBcaCsv({ bank: "BCA", accountNumber, holder: "PT Uji Sejahtera", year: 2026, month, opening: 1_000_000n, rows: [{ date: d(2026, month, 5), description: "SETORAN", amount: 500_000n }, { date: d(2026, month, 9), description: "PEMBELIAN PAKAN", amount: -200_000n }] }));

/** A Mandiri e-statement for the group's Mandiri Giro, locked with `password` like real ones. */
const mandiriPdf = (month: number, password: string) => {
  const mm = String(month).padStart(2, "0");
  return makePdf(
    [
      [
        ...table(800, [[[40, "PT Bank Mandiri (Persero) Tbk"]], [[40, "Nomor Rekening : 2222222222"]], [[40, `Periode : 01/${mm}/2026 - 30/${mm}/2026`]]]),
        ...table(740, [
          [[40, "Tanggal"], [130, "Keterangan"], [360, "Debit"], [440, "Kredit"], [520, "Saldo"]],
          [[40, `01/${mm}/2026`], [130, "SALDO AWAL"], [510, "0,00"]],
          [[40, `04/${mm}/2026`], [130, "TRANSFER DARI PT MITRA UNGGAS"], [430, "20.000.000,00"], [510, "20.000.000,00"]],
          [[40, `09/${mm}/2026`], [130, "PEMBELIAN PAKAN AYAM"], [355, "4.440.000,00"], [510, "15.560.000,00"]],
        ]),
      ],
    ],
    { userPassword: password },
  );
};

async function xlsx(rows: unknown[][], sheet = "GL"): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function setup() {
  const g = await makeGroup();
  const check = (name: string, data: Buffer, extra: { password?: string; clientId?: string } = {}) =>
    checkFile(db, { firmId: g.firm.id, clientId: extra.clientId ?? g.client.id, batchId: "b1", name, data, password: extra.password, actorId: "m1" });
  return { ...g, check };
}

describe("Unggah: check a dropped file", () => {
  it("reads a bank CSV as a statement and keeps it in the client's inbox", async () => {
    const g = await setup();
    const item = await g.check("mutasi-jan.csv", bcaCsv(1));
    expect(item).toMatchObject({ kind: "BANK", status: "CHECKED", message: null, periodStart: "2026-01-01", periodEnd: "2026-01-31", fileName: "mutasi-jan.csv", batchId: "b1" });
    expect(item.sections).toEqual([
      { bank: "BCA", number: "1111111111", holder: null, currency: "IDR", periodStart: "2026-01-01", periodEnd: "2026-01-31", rows: 2, opening: "1000000", closing: "1300000", error: null } satisfies BankSection,
    ]);
    const version = await db.evidenceVersion.findUniqueOrThrow({ where: { id: item.evidenceVersionId! }, include: { document: { include: { intake: true } } } });
    expect(version.document.intake).toMatchObject({ isInbox: true, clientId: g.client.id });

    // The same file again: a second line, the same stored version.
    const again = await g.check("mutasi-jan.csv", bcaCsv(1));
    expect(again.evidenceVersionId).toBe(item.evidenceVersionId);
    // The lines persist: a reload reads them back.
    expect(await db.uploadItem.count({ where: { clientId: g.client.id, batchId: "b1" } })).toBe(2);
  });

  it("lists every account of a combined PDF as its own section", async () => {
    const g = await setup();
    const item = await g.check("smbc-mei.pdf", smbcCombinedPdf());
    expect(item.kind).toBe("BANK");
    expect(item.status).toBe("CHECKED");
    const sections = item.sections as BankSection[];
    expect(sections.map((s) => s.number)).toEqual(["90022152088", "05243002879", "90022164251"]);
    expect(sections.every((s) => s.bank === "SMBC")).toBe(true);
    expect(item.periodStart).toBe("2026-05-01");
    expect(item.periodEnd).toBe("2026-05-31");
  });

  it("opens locked PDFs with the offered password once, then from the client's keyring", async () => {
    const g = await setup();
    const locked = await g.check("mandiri-agu.pdf", mandiriPdf(8, "rahasia"));
    expect(locked).toMatchObject({ kind: "BANK", status: "NEEDS_PASSWORD", message: "PDF ini dikunci kata sandi.", sections: [] });

    const wrong = await g.check("mandiri-agu.pdf", mandiriPdf(8, "rahasia"), { password: "salah" });
    expect(wrong.status).toBe("NEEDS_PASSWORD");
    expect(await keyringSize(db, g.client.id)).toBe(0);

    const opened = await g.check("mandiri-agu.pdf", mandiriPdf(8, "rahasia"), { password: "rahasia" });
    expect(opened).toMatchObject({ kind: "BANK", status: "CHECKED" });
    expect((opened.sections as BankSection[])[0]).toMatchObject({ bank: "MANDIRI", number: "2222222222", rows: 2 });
    expect(await keyringSize(db, g.client.id)).toBe(1);
    const stored = await db.clientPdfPassword.findFirstOrThrow();
    expect(stored.secret).not.toContain("rahasia");
    expect(stored.createdById).toBe("m1");

    // Next month's file, same password: opens without asking.
    const next = await g.check("mandiri-sep.pdf", mandiriPdf(9, "rahasia"));
    expect(next).toMatchObject({ kind: "BANK", status: "CHECKED", periodStart: "2026-09-01" });
    expect(await keyringSize(db, g.client.id)).toBe(1);

    // Another client never tries this client's keyring.
    const other = await db.$transaction((tx) => createClient(tx, g.firm.id, { name: "Klien Lain", industry: "retail", entities: [{ name: "PT Lain", shortName: "Lain", kind: "PT", banks: [] }] }));
    const foreign = await g.check("mandiri-sep.pdf", mandiriPdf(9, "rahasia"), { clientId: other.client.id });
    expect(foreign.status).toBe("NEEDS_PASSWORD");

    // No password anywhere in what is stored or returned.
    const rows = await db.uploadItem.findMany();
    expect(JSON.stringify([rows, opened, next])).not.toContain("rahasia");
    expect(JSON.stringify(wrong)).not.toContain("salah");
  });

  it("reads ledger workbooks as ledgers, also when they carry a balance column", async () => {
    const g = await setup();
    const plain = await xlsx([
      ["Entity", "Entry Date", "Account Code", "Account Name", "Currency", "Debit", "Credit", "Notes"],
      ["PT Uji", d(2026, 1, 31), "10000", "Kas", "IDR", 1000, 0, ""],
      ["PT Uji", d(2026, 1, 31), "31001", "Modal Saham", "IDR", 0, 1000, ""],
    ]);
    const item = await g.check("gl.xlsx", plain);
    expect(item).toMatchObject({ kind: "LEDGER", status: "CHECKED", periodStart: "2026-01-31", periodEnd: "2026-01-31" });
    expect(item.sections).toEqual([{ sheet: "GL", mode: "LEDGER", rows: 2, periodStart: "2026-01-31", periodEnd: "2026-01-31" } satisfies LedgerSection]);

    const withBalance = await xlsx([
      ["Tanggal", "No. Bukti", "Akun", "Keterangan", "Debit", "Kredit", "Saldo"],
      [d(2026, 1, 31), "1101", "Kas", "Setoran modal", 1000, 0, 1000],
      [d(2026, 1, 31), "3101", "Modal", "Setoran modal", 0, 1000, 0],
      [d(2026, 2, 3), "6101", "Beban Listrik", "Listrik", 50, 0, 50],
      [d(2026, 2, 3), "1101", "Kas", "Listrik", 0, 50, 950],
    ]);
    const ledger = await g.check("bukubesar.xlsx", withBalance);
    expect(ledger).toMatchObject({ kind: "LEDGER", status: "CHECKED", periodStart: "2026-01-31", periodEnd: "2026-02-03" });
  });

  it("keeps other files as documents only: notes, photos", async () => {
    const g = await setup();
    const note = await g.check("catatan.md", Buffer.from("# Catatan rapat\n\nKlien minta laporan bulan Januari.\n"));
    expect(note).toMatchObject({ kind: "OTHER", status: "KEPT", message: "Disimpan di Dokumen.", sections: [], periodStart: null });
    const photo = await g.check("foto.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]));
    expect(photo).toMatchObject({ kind: "OTHER", status: "KEPT" });
    expect(photo.message).toMatch(/gambar/);
    expect(await db.evidenceVersion.count()).toBe(2);
  });

  it("refuses year-less statements as a bank file with the reader's message", async () => {
    const g = await setup();
    const csv = ["Tanggal,Keterangan,Debit,Kredit,Saldo", "05/01,SALDO AWAL,,,1000000", "06/01,SETORAN,,500000,1500000"].join("\n");
    const item = await g.check("mutasi.csv", Buffer.from(csv));
    expect(item).toMatchObject({ kind: "BANK", status: "FAILED" });
    expect(item.message).toMatch(/tahun/);
  });

  it("books nothing", async () => {
    const g = await setup();
    await g.check("mutasi-jan.csv", bcaCsv(1));
    await g.check("smbc-mei.pdf", smbcCombinedPdf());
    await g.check("mandiri-agu.pdf", mandiriPdf(8, "rahasia"), { password: "rahasia" });
    expect(await db.statementImport.count()).toBe(0);
    expect(await db.bankTransaction.count()).toBe(0);
    expect(await db.journalEntry.count()).toBe(0);
    expect(await db.ledgerImport.count()).toBe(0);
    expect(await db.uploadItem.count()).toBe(3);
  });

  it("refuses another firm's client and gives a too-large file its own failed line", async () => {
    const g = await setup();
    await expect(checkFile(db, { firmId: "foreign", clientId: g.client.id, batchId: "b1", name: "x.csv", data: bcaCsv(1) })).rejects.toThrow("Klien tidak ditemukan");
    const big = await g.check("besar.pdf", Buffer.alloc(10 * 1024 * 1024 + 1, 1));
    expect(big).toMatchObject({ kind: "OTHER", status: "FAILED", evidenceVersionId: null });
    expect(big.message).toMatch(/10 MiB/);
    expect(await db.evidenceIntake.findFirstOrThrow({ where: { isInbox: true } })).toMatchObject({ status: "READY", issue: null });
    expect(await db.uploadItem.count()).toBe(1);
  });
});
