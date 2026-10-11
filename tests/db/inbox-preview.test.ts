import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";
import { makePdf, table } from "../pdf-fixture";
import { toBcaCsv } from "@/lib/demo/writers";
import { previewFile, type BankSection } from "@/lib/inbox/check";
import { proposeClient } from "@/lib/inbox/propose";
import { planBatch } from "@/lib/inbox/plan";

// Klien baru from files through the real guard (ADR 0017 §5): only the login token and revalidation are faked.
const state = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({ authConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getClaims: async () => ({ data: state.userId ? { claims: { sub: state.userId } } : null }) } }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const actions = await import("@/app/actions");

const SECRET = "inbox-preview-test-secret-32-characters-long";
beforeEach(async () => {
  vi.stubEnv("SETTINGS_SECRET", SECRET);
  await resetDb();
  state.userId = null;
});
afterEach(() => vi.unstubAllEnvs());

const d = (m: number, day: number) => new Date(Date.UTC(2026, m - 1, day));
const bcaCsv = (month: number) =>
  Buffer.from(toBcaCsv({ bank: "BCA", accountNumber: "6044551270", holder: "PT Dari File", year: 2026, month, opening: 1_000_000n + 300_000n * BigInt(month - 6), rows: [{ date: d(month, 5), description: "SETORAN TUNAI", amount: 500_000n }, { date: d(month, 9), description: "BIAYA ADM", amount: -200_000n }] }));
const PASSWORD = "rahasia-baru-55";
const mandiriPdf = () =>
  makePdf(
    [
      [
        ...table(800, [[[40, "PT Bank Mandiri (Persero) Tbk"]], [[40, "Nomor Rekening : 1230007654321"]], [[40, "Periode : 01/07/2026 - 31/07/2026"]]]),
        ...table(740, [
          [[40, "Tanggal"], [130, "Keterangan"], [360, "Debit"], [440, "Kredit"], [520, "Saldo"]],
          [[40, "01/07/2026"], [130, "SALDO AWAL"], [510, "0,00"]],
          [[40, "04/07/2026"], [130, "TRANSFER DARI CV PELANGGAN"], [430, "20.000.000,00"], [510, "20.000.000,00"]],
        ]),
      ],
    ],
    { userPassword: PASSWORD },
  );
const form = (name: string, data: Buffer, extra: Record<string, string> = {}) => {
  const f = new FormData();
  f.set("file", new File([new Uint8Array(data)], name));
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
};
const stored = async () => ({ versions: await db.evidenceVersion.count(), items: await db.uploadItem.count(), passwords: await db.clientPdfPassword.count() });

describe("Klien baru from files: preview", () => {
  it("reads a bank CSV and a locked PDF without a client, storing nothing", async () => {
    const g = await makeGroup();
    const csv = await previewFile(db, { firmId: g.firm.id, name: "bca-jun.csv", data: bcaCsv(6) });
    expect(csv).toMatchObject({ fileName: "bca-jun.csv", kind: "BANK", status: "CHECKED", message: null });
    expect(csv.sections).toEqual([
      { bank: "BCA", number: "6044551270", holder: null, currency: "IDR", periodStart: "2026-06-01", periodEnd: "2026-06-30", rows: 2, opening: "1000000", closing: "1300000", error: null } satisfies BankSection,
    ]);

    // Locked: asks for the password; a wrong one says so; the right one reads it. Nothing is stored, no keyring is written.
    expect(await previewFile(db, { firmId: g.firm.id, name: "mandiri.pdf", data: mandiriPdf() })).toEqual({ fileName: "mandiri.pdf", kind: "BANK", status: "NEEDS_PASSWORD", message: "PDF ini dikunci kata sandi.", sections: [] });
    expect(await previewFile(db, { firmId: g.firm.id, name: "mandiri.pdf", data: mandiriPdf(), password: "salah" })).toMatchObject({ status: "NEEDS_PASSWORD", message: "Kata sandi tidak membuka PDF ini. Coba kata sandi lain." });
    const pdf = await previewFile(db, { firmId: g.firm.id, name: "mandiri.pdf", data: mandiriPdf(), password: PASSWORD });
    expect(pdf).toMatchObject({ kind: "BANK", status: "CHECKED" });
    expect((pdf.sections as BankSection[]).map((s) => [s.bank, s.number])).toEqual([["MANDIRI", "1230007654321"]]);

    // A document that is no statement: kept for Dokumen.
    expect(await previewFile(db, { firmId: g.firm.id, name: "catatan.md", data: Buffer.from("# Catatan\n") })).toMatchObject({ kind: "OTHER", status: "KEPT" });
    expect(await stored()).toEqual({ versions: 0, items: 0, passwords: 0 });
  });

  it("the action is guarded like creating a client and refuses what Unggah refuses", async () => {
    const g = await makeGroup();
    expect(await actions.previewClientFileAction(form("a.csv", bcaCsv(6)))).toEqual({ ok: false, error: "Masuk terlebih dahulu." });
    state.userId = (await addMember(g.firm.id, "VIEWER")).userId;
    expect(await actions.previewClientFileAction(form("a.csv", bcaCsv(6)))).toEqual({ ok: false, error: "Peran Peninjau hanya dapat melihat dan mengunduh laporan." });
    state.userId = (await addMember(g.firm.id, "AKUNTAN")).userId;
    expect(await actions.previewClientFileAction(form("besar.pdf", Buffer.alloc(5 * 1024 * 1024 + 1)))).toEqual({ ok: false, error: "File terlalu besar (maks. 5 MB)." });
    expect(await actions.previewClientFileAction(new FormData())).toEqual({ ok: false, error: "Pilih file untuk diunggah." });
    const r = await actions.previewClientFileAction(form("bca-jun.csv", bcaCsv(6)));
    expect(r).toMatchObject({ ok: true, file: { kind: "BANK", status: "CHECKED" } });
    expect(await stored()).toEqual({ versions: 0, items: 0, passwords: 0 });
  });

  it("previewed files become a client, and the same files in its Unggah drop route to the new rekening", async () => {
    const g = await makeGroup();
    state.userId = (await addMember(g.firm.id, "AKUNTAN")).userId;
    const files = [
      { name: "bca-jun.csv", data: bcaCsv(6) },
      { name: "bca-jul.csv", data: bcaCsv(7) },
      { name: "mandiri-jul.pdf", data: mandiriPdf(), password: PASSWORD },
    ];
    const read = [];
    for (const f of files) {
      const r = await actions.previewClientFileAction(form(f.name, f.data, f.password ? { password: f.password } : {}));
      if (!r.ok) throw new Error(r.error);
      read.push(r.file);
    }
    const proposal = proposeClient(read);
    expect(proposal.entities).toHaveLength(1);
    expect(proposal.entities[0].banks.map((b) => b.display)).toEqual(["BCA ·1270", "Mandiri ·4321"]);

    // What the page sends: the existing onboarding path, then each file into one new drop with the password that opened it.
    const created = await actions.addClientAction({
      name: "Klien Dari File",
      industry: "",
      entities: proposal.entities.map((e) => ({ name: e.name || "Klien Dari File", shortName: e.shortName, kind: e.kind, npwp: "", banks: e.banks.map((b) => ({ bank: b.bank, number: b.number, label: "", isOverdraft: b.isOverdraft })) })),
    });
    if (!created.ok) throw new Error(created.error);
    const batch = randomUUID();
    for (const f of files) {
      const fd = form(f.name, f.data, { batchId: batch, ...(f.password ? { password: f.password } : {}) });
      expect(await actions.inboxCheckFileAction(created.clientId, fd)).toMatchObject({ ok: true, item: { status: "CHECKED" } });
    }
    const client = await db.client.findUniqueOrThrow({ where: { id: created.clientId }, select: { firmId: true } });
    const plan = await planBatch(db, { firmId: client.firmId, clientId: created.clientId, batchId: batch });
    expect(plan).toMatchObject({ ready: true, newAccounts: [], numberless: [], needsPassword: [] });
    expect(plan.known).toHaveLength(3);
    // The password that opened the PDF is kept for the new client only.
    expect(await db.clientPdfPassword.count({ where: { clientId: created.clientId } })).toBe(1);
  });
});
