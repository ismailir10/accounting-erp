import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeGroup, resetDb } from "../helpers";
import { addMember } from "../members";
import { createInvoice } from "@/lib/receivables/invoices";

// The Coretax faktur keluaran download and its two forms (cycle 2026-10-17-coretax-files), through the real guard and route.
const auth = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({ authConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getClaims: async () => ({ data: auth.userId ? { claims: { sub: auth.userId } } : null }) } }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const { setContactTaxIdentityAction, setInvoiceFakturItemAction } = await import("@/app/actions");
const { GET } = await import("@/app/(app)/clients/[id]/tax/masa/coretax/route");

type G = Awaited<ReturnType<typeof makeGroup>>;
let g: G;
const download = (clientId: string, query = "") => GET(new Request(`http://localhost/clients/${clientId}/tax/masa/coretax?entity=${g.pt.entity.id}&period=2026-08${query}`), { params: Promise.resolve({ id: clientId }) });
const sale = (number: string, contactName: string, contactNpwp?: string) =>
  createInvoice(db, { clientId: g.client.id, entityId: g.pt.entity.id, direction: "SALES", contactName, contactNpwp, number, issueDate: "2026-08-10", dpp: "10000000", ppn: "1100000", counterCode: "4100" });

beforeEach(async () => {
  await resetDb();
  g = await makeGroup();
  await db.entity.update({ where: { id: g.pt.entity.id }, data: { npwp: "01.234.567.8-015.000" } });
});

describe("Coretax faktur keluaran download", () => {
  it("an akuntan completes the buyer and item, downloads the XML; the download is audited as FAKTUR, never as a report sent", async () => {
    const akuntan = await addMember(g.firm.id, "AKUNTAN", { clients: [g.client.id] });
    auth.userId = akuntan.userId;
    const a = await sale("INV-1", "PT Mitra Alfa", "0098765432101200");
    const b = await sale("INV-2", "Budi Santoso");

    // Nothing is ready yet: no file.
    const none = await download(g.client.id);
    expect(none.status).toBe(400);
    expect(await none.text()).toBe("Belum ada faktur yang siap untuk Coretax di masa ini.");

    expect(await setContactTaxIdentityAction({ clientId: g.client.id, contactId: b.contactId, npwp: "", nik: "31740615", nitku: "", address: "", email: "" })).toMatchObject({ ok: false, fields: { nik: "NIK berisi 16 angka." } });
    expect(await setContactTaxIdentityAction({ clientId: g.client.id, contactId: b.contactId, npwp: "", nik: "3174061502560010", nitku: "", address: "Jl. Kenanga 2", email: "" })).toEqual({ ok: true });
    expect(await setInvoiceFakturItemAction({ clientId: g.client.id, invoiceIds: [a.id, b.id], kind: "B", code: "", unit: "UM.0030" })).toEqual({ ok: true, count: 2 });

    const res = await download(g.client.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="faktur-keluaran-PT_Uji-2026-08.xml"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const xml = await res.text();
    expect(xml.match(/<TaxInvoice>/g)).toHaveLength(2);
    expect(xml).toContain("<BuyerDocument>National ID</BuyerDocument>");

    const events = await db.auditEvent.findMany({ where: { clientId: g.client.id }, orderBy: { createdAt: "asc" } });
    expect(events.filter((e) => e.kind === "REPORT_EXPORT")).toEqual([]);
    const downloaded = events.filter((e) => e.subject === `coretax:${g.pt.entity.id}:2026-08`);
    expect(downloaded.map((e) => [e.kind, e.summary, e.actorId])).toEqual([["FAKTUR", "XML faktur keluaran PT Uji Sejahtera masa Agustus 2026 diunduh: 2 faktur", akuntan.id]]);
    // The NIK and address went into the file, never into the history.
    expect(JSON.stringify(events)).not.toContain("3174061502560010");

    // Only one part exists.
    expect((await download(g.client.id, "&part=2")).status).toBe(404);
    expect((await download(g.client.id, "&part=x")).status).toBe(404);
    expect((await download(g.client.id, "&part=1")).status).toBe(200);
  });

  it("a viewer downloads but can't edit; a stranger gets 404; the owner's books are refused", async () => {
    const a = await sale("INV-1", "PT Mitra Alfa", "0098765432101200");
    auth.userId = (await addMember(g.firm.id, "ADMIN")).userId;
    expect(await setInvoiceFakturItemAction({ clientId: g.client.id, invoiceIds: [a.id], kind: "B", code: "000000", unit: "UM.0030" })).toEqual({ ok: true, count: 1 });

    auth.userId = (await addMember(g.firm.id, "VIEWER", { clients: [g.client.id] })).userId;
    expect((await download(g.client.id)).status).toBe(200);
    expect(await setInvoiceFakturItemAction({ clientId: g.client.id, invoiceIds: [a.id], kind: "A", code: "000000", unit: "UM.0030" })).toEqual({ ok: false, error: "Peran Peninjau hanya dapat melihat dan mengunduh laporan." });
    expect(await setContactTaxIdentityAction({ clientId: g.client.id, contactId: a.contactId, npwp: "", nik: "", nitku: "", address: "", email: "" })).toMatchObject({ ok: false });

    // An akuntan of the firm not assigned to this client, and a member of another firm, see nothing.
    auth.userId = (await addMember(g.firm.id, "AKUNTAN", { clients: [] })).userId;
    const unassigned = await download(g.client.id);
    expect(unassigned.status).toBe(404);
    expect(await unassigned.text()).toBe("Klien tidak ditemukan");
    const other = await makeGroup();
    auth.userId = (await addMember(other.firm.id, "ADMIN")).userId;
    expect((await download(g.client.id)).status).toBe(404);
    expect(await setInvoiceFakturItemAction({ clientId: g.client.id, invoiceIds: [a.id], kind: "A", code: "000000", unit: "UM.0030" })).toMatchObject({ ok: false });
    expect((await db.invoice.findUniqueOrThrow({ where: { id: a.id } })).fakturItemKind).toBe("B");

    auth.userId = (await addMember(g.firm.id, "ADMIN")).userId;
    const owner = await GET(new Request(`http://localhost/clients/${g.client.id}/tax/masa/coretax?entity=${g.owner.entity.id}&period=2026-08`), { params: Promise.resolve({ id: g.client.id }) });
    expect(owner.status).toBe(400);
    expect(await db.auditEvent.count({ where: { kind: "REPORT_EXPORT" } })).toBe(0);
  });

  it("a company without an NPWP gets no file and the reason", async () => {
    auth.userId = (await addMember(g.firm.id, "ADMIN")).userId;
    await db.entity.update({ where: { id: g.pt.entity.id }, data: { npwp: null } });
    const a = await sale("INV-1", "PT Mitra Alfa", "0098765432101200");
    await setInvoiceFakturItemAction({ clientId: g.client.id, invoiceIds: [a.id], kind: "B", code: "000000", unit: "UM.0030" });
    const res = await download(g.client.id);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("NPWP perusahaan belum diisi, jadi faktur tidak bisa dibuat.");
  });
});
