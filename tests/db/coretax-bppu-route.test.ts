import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";
import { importStatement } from "@/lib/import/pipeline";
import { reviewTransaction } from "@/lib/review";

// The Coretax BPPU download and the slip form's action (cycle 2026-10-17-bppu-files, T4), through the real guard and route.
const auth = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({ authConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getClaims: async () => ({ data: auth.userId ? { claims: { sub: auth.userId } } : null }) } }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const { setContactTaxIdentityAction, setWithholdingSlipAction } = await import("@/app/actions");
const { GET } = await import("@/app/(app)/clients/[id]/tax/masa/coretax-bppu/route");

type G = Awaited<ReturnType<typeof makeGroup>>;
let g: G;
let paymentId: string;
const download = (clientId: string, entityId = g.pt.entity.id) => GET(new Request(`http://localhost/clients/${clientId}/tax/masa/coretax-bppu?entity=${entityId}&period=2026-08`), { params: Promise.resolve({ id: clientId }) });
const slip = (over: Partial<Parameters<typeof setWithholdingSlipAction>[0]> = {}) =>
  setWithholdingSlipAction({ clientId: g.client.id, bankTransactionId: paymentId, contactName: "Hj Rosmiati", kop: "28-403-02", dpp: "10.000.000", documentType: "Contract", documentNumber: "SPK-1", documentDate: "2026-08-01", ...over });

beforeEach(async () => {
  await resetDb();
  g = await makeGroup();
  await db.entity.update({ where: { id: g.pt.entity.id }, data: { npwp: "01.234.567.8-015.000" } });
  const csv = ["Tanggal;Keterangan;Debet;Kredit;Saldo", "01/08/2026;SALDO AWAL;;;500000000", "15/08/2026;SEWA RUKO HJ ROSMIATI;9000000;0;491000000", ""].join("\n");
  await importStatement(db, { bankAccountId: g.pt.banks[0].id, fileName: "bca.csv", data: Buffer.from(csv), provider: null });
  paymentId = (await db.bankTransaction.findFirstOrThrow({ where: { description: { contains: "ROSMIATI" } } })).id;
  await reviewTransaction(db, { bankTxId: paymentId, accountCode: "6120", taxTag: null, withholding: { kind: "PPH_4_2", amount: 1_000_000n } });
});

describe("Coretax BPPU download", () => {
  it("an akuntan completes the slip and the recipient, downloads the XML; audited as BUKTI_POTONG, never as a report sent", async () => {
    const akuntan = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    auth.userId = akuntan.userId;
    const none = await download(g.client.id);
    expect(none.status).toBe(400);
    expect(await none.text()).toBe("Belum ada bukti potong yang siap untuk Coretax di masa ini.");

    expect(await slip({ kop: "28-4" })).toEqual({ ok: false, error: "Kode objek pajak ditulis NN-NNN-NN, mis. 24-104-03." });
    expect(await slip()).toEqual({ ok: true });
    const contact = await db.contact.findFirstOrThrow({ where: { clientId: g.client.id, name: "Hj Rosmiati" } });
    expect(await setContactTaxIdentityAction({ clientId: g.client.id, contactId: contact.id, npwp: "", nik: "", nitku: "0012345678015000000001", address: "", email: "", holder: "penerima" })).toMatchObject({
      ok: false,
      fields: { nitku: "NITKU hanya untuk penerima ber-NPWP. Isi NPWP-nya dulu." },
    });
    expect(await setContactTaxIdentityAction({ clientId: g.client.id, contactId: contact.id, npwp: "", nik: "3174061502560010", nitku: "", address: "", email: "", holder: "penerima" })).toEqual({ ok: true });

    const res = await download(g.client.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="bppu-PT_Uji-2026-08.xml"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const xml = await res.text();
    expect(xml.match(/<Bpu>/g)).toHaveLength(1);
    expect(xml).toContain("<CounterpartTin>3174061502560010</CounterpartTin>");

    const events = await db.auditEvent.findMany({ where: { clientId: g.client.id }, orderBy: { createdAt: "asc" } });
    expect(events.filter((e) => e.kind === "REPORT_EXPORT")).toEqual([]);
    expect(events.filter((e) => e.subject === `coretax-bppu:${g.pt.entity.id}:2026-08`).map((e) => [e.kind, e.summary, e.actorId])).toEqual([
      ["BUKTI_POTONG", "XML bukti potong PT Uji Sejahtera masa Agustus 2026 diunduh: 1 bukti potong", akuntan.id],
    ]);
    // Saving the slip is in Riwayat with KOP, DPP and document; the recipient's NIK is in the file only, never in the history.
    expect(events.filter((e) => e.subject === `slip:${paymentId}`).map((e) => [e.kind, e.summary, e.actorId])).toEqual([
      ["BUKTI_POTONG", "Bukti potong SEWA RUKO HJ ROSMIATI 15 Agu 2026: penerima Hj Rosmiati, kode 28-403-02 (10%), DPP Rp 10.000.000, kontrak SPK-1 (1 Agu 2026)", akuntan.id],
    ]);
    expect(JSON.stringify(events)).not.toContain("3174061502560010");
  });

  it("a viewer downloads but can't edit; a stranger gets 404; the owner's books are refused", async () => {
    auth.userId = (await addMember(g.firm.id, "ADMIN")).userId;
    expect(await slip()).toEqual({ ok: true });
    const contact = await db.contact.findFirstOrThrow({ where: { clientId: g.client.id, name: "Hj Rosmiati" } });
    await setContactTaxIdentityAction({ clientId: g.client.id, contactId: contact.id, npwp: "09.876.543.2-101.200", nik: "", nitku: "", address: "", email: "", holder: "penerima" });

    auth.userId = (await addMember(g.firm.id, "VIEWER", { clients: [g.client.id] })).userId;
    expect((await download(g.client.id)).status).toBe(200);
    expect(await slip({ dpp: "1" })).toEqual({ ok: false, error: "Peran Peninjau hanya dapat melihat dan mengunduh laporan." });
    expect((await db.withholdingSlip.findFirstOrThrow()).dpp).toBe(10_000_000n);

    // An akuntan of the firm not assigned to this client, and a member of another firm, see nothing.
    auth.userId = (await addMember(g.firm.id, "AKUNTAN", { clients: [] })).userId;
    const unassigned = await download(g.client.id);
    expect(unassigned.status).toBe(404);
    expect(await unassigned.text()).toBe("Klien tidak ditemukan");
    const other = await makeGroup();
    auth.userId = (await addMember(other.firm.id, "ADMIN")).userId;
    expect((await download(g.client.id)).status).toBe(404);
    expect(await slip({ dpp: "1" })).toMatchObject({ ok: false });
    // Another client's id with this line: the line is not found there.
    expect(await setWithholdingSlipAction({ clientId: other.client.id, bankTransactionId: paymentId, kop: "", dpp: "", documentType: "", documentNumber: "", documentDate: "" })).toEqual({ ok: false, error: "Mutasi tidak ditemukan di klien ini." });

    auth.userId = (await addMember(g.firm.id, "ADMIN")).userId;
    const owner = await download(g.client.id, g.owner.entity.id);
    expect(owner.status).toBe(400);
    expect(await db.auditEvent.count({ where: { kind: "REPORT_EXPORT" } })).toBe(0);
  });

  it("a company without an NPWP gets no file and the reason", async () => {
    auth.userId = (await addMember(g.firm.id, "ADMIN")).userId;
    await slip({ contactName: "PT Sewa Ruko" });
    await db.contact.update({ where: { clientId_name: { clientId: g.client.id, name: "PT Sewa Ruko" } }, data: { npwp: "0098765432101200" } });
    await db.entity.update({ where: { id: g.pt.entity.id }, data: { npwp: null } });
    const res = await download(g.client.id);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("NPWP perusahaan belum diisi, jadi bukti potong tidak bisa dibuat.");
  });
});
