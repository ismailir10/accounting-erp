import { describe, expect, it } from "vitest";
import { clientSections, parseClientPath, parseRecents, pushRecent, resolveScope, searchScore, sectionOf, switchTarget } from "@/lib/nav";

const B = { id: "b1", modules: ["inventory"] };
const url = (href: string) => new URL(href, "http://x");

describe("sectionOf", () => {
  it("knows the page and whether the path is under it", () => {
    expect(sectionOf("/trial-balance")).toMatchObject({ section: { label: "Neraca Saldo" }, deeper: false });
    expect(sectionOf("/ledger/1101")).toMatchObject({ section: { label: "Buku Besar" }, deeper: true });
    expect(sectionOf("/ledger/akun/xyz")).toMatchObject({ section: { label: "Buku Besar" }, deeper: true });
    expect(sectionOf("")).toMatchObject({ section: { label: "Ringkasan klien" }, deeper: false });
  });
  it("picks the most specific page: /tax/masa is Pajak Masa, /tax is Pajak Badan", () => {
    expect(sectionOf("/tax/masa")?.section.label).toBe("Pajak Masa");
    expect(sectionOf("/tax")?.section.label).toBe("Pajak Badan");
  });
  it("does not match on a prefix that is not a path segment", () => {
    expect(sectionOf("/ledgerx")).toBeNull();
    expect(sectionOf("/documents")).toBeNull();
  });
});

describe("parseClientPath", () => {
  it("reads the client and the rest; /clients/new is not a client", () => {
    expect(parseClientPath("/clients/a1/ledger/1101")).toEqual({ clientId: "a1", rest: "/ledger/1101" });
    expect(parseClientPath("/clients/a1/")).toEqual({ clientId: "a1", rest: "" });
    expect(parseClientPath("/clients/new")).toBeNull();
    expect(parseClientPath("/reports")).toBeNull();
  });
});

describe("switchTarget", () => {
  it("keeps the page, the period, and resets the entity to the whole group", () => {
    const t = switchTarget("/clients/a1/trial-balance", B, { period: "2026-07", scope: "entity:e9" });
    expect(t).toMatchObject({ label: "Neraca Saldo", fellBack: false });
    const u = url(t.href);
    expect(u.pathname).toBe("/clients/b1/trial-balance");
    expect(Object.fromEntries(u.searchParams)).toEqual({ period: "2026-07", scope: "client:b1", entity: "combined" });
  });
  it("keeps tax/masa and journals/new as pages of their own", () => {
    expect(url(switchTarget("/clients/a1/tax/masa", B).href).pathname).toBe("/clients/b1/tax/masa");
    expect(url(switchTarget("/clients/a1/journals/new", B).href).pathname).toBe("/clients/b1/journals/new");
  });
  it("falls back to the section from a page under it, and says so", () => {
    const t = switchTarget("/clients/a1/ledger/akun/xyz", B);
    expect(url(t.href).pathname).toBe("/clients/b1/ledger");
    expect(t).toMatchObject({ label: "Buku Besar", fellBack: true });
    expect(url(switchTarget("/clients/a1/assets/asset9", { id: "b1", modules: ["assets"] }).href).pathname).toBe("/clients/b1/assets");
  });
  it("falls back to Ringkasan for a module the other client doesn't show", () => {
    const t = switchTarget("/clients/a1/leases", B);
    expect(url(t.href).pathname).toBe("/clients/b1");
    expect(t).toMatchObject({ label: "Ringkasan klien", fellBack: true });
    expect(url(switchTarget("/clients/a1/inventory", B).href).pathname).toBe("/clients/b1/inventory");
  });
  it("falls back to Ringkasan for a page the menu doesn't list", () => {
    expect(switchTarget("/clients/a1/documents", B)).toMatchObject({ label: "Ringkasan klien", fellBack: true });
  });
  it("opens the overview from the overview, without calling it a fallback", () => {
    expect(switchTarget("/clients/a1", B)).toMatchObject({ label: "Ringkasan klien", fellBack: false });
  });
  it("keeps a workspace page that is already scoped to a client", () => {
    const t = switchTarget("/reports", B, { period: "2026-08", scope: "client:a1" });
    expect(t).toMatchObject({ label: "Laporan", fellBack: false });
    expect(t.href).toBe("/reports?period=2026-08&scope=client%3Ab1");
    expect(url(switchTarget("/", B, { scope: "entity:e1" }).href).pathname).toBe("/");
  });
  it("opens Ringkasan from Semua klien, Pengaturan and Tambah klien", () => {
    for (const path of ["/", "/reports", "/settings", "/clients/new"]) {
      expect(url(switchTarget(path, B, { scope: "all" }).href).pathname).toBe("/clients/b1");
    }
    expect(url(switchTarget("/documents", B).href).pathname).toBe("/clients/b1");
  });
});

describe("clientSections", () => {
  it("lists the overview, the stages in order, modules the client shows, then settings", () => {
    const labels = clientSections(["leases"]).map((s) => s.label);
    expect(labels[0]).toBe("Ringkasan klien");
    expect(labels.indexOf("Unggah")).toBeLessThan(labels.indexOf("Saldo Awal"));
    expect(labels.indexOf("Sewa (PSAK 116)")).toBeGreaterThan(labels.indexOf("Jurnal Penyesuaian"));
    expect(labels.indexOf("Sewa (PSAK 116)")).toBeLessThan(labels.indexOf("Tutup Buku"));
    expect(labels).not.toContain("Persediaan");
    expect(labels.at(-1)).toBe("Riwayat perubahan");
  });
});

describe("search", () => {
  it("ignores case and accents, needs every word, puts a name that starts with the search first", () => {
    expect(searchScore("PT Jasa Kreatif Digital", "kréatif")).toBeGreaterThan(0);
    expect(searchScore("PT Jasa Kreatif Digital", "jasa dig")).toBeGreaterThan(0);
    expect(searchScore("PT Jasa Kreatif Digital", "jasa retail")).toBe(0);
    expect(searchScore("Jasa Kreatif", "jasa")).toBeGreaterThan(searchScore("PT Jasa Kreatif", "jasa"));
    expect(searchScore("anything", "  ")).toBe(1);
  });
});

describe("recent clients", () => {
  it("puts the newest first, drops duplicates and caps the list", () => {
    let list: string[] = [];
    for (const id of ["a", "b", "c", "d", "e", "f"]) list = pushRecent(list, id);
    expect(list).toEqual(["f", "e", "d", "c", "b"]);
    expect(pushRecent(list, "d")).toEqual(["d", "f", "e", "c", "b"]);
  });
  it("reads garbage as an empty list and forgets clients that no longer exist", () => {
    const known = new Set(["a", "b"]);
    expect(parseRecents(null, known)).toEqual([]);
    expect(parseRecents("{nope", known)).toEqual([]);
    expect(parseRecents('{"a":1}', known)).toEqual([]);
    expect(parseRecents('["a","gone",3,"a","b"]', known)).toEqual(["a", "b"]);
  });
});

describe("resolveScope", () => {
  const clients = [{ id: "a1", entities: [{ id: "e1" }, { id: "e2" }] }, { id: "b1", entities: [{ id: "e3" }] }];
  it("reads the client from the path, defaulting the scope to the client", () => {
    const r = resolveScope(clients, "/clients/b1/ledger", {});
    expect(r.routeClient?.id).toBe("b1");
    expect(r.scope).toBe("client:b1");
  });
  it("keeps a legacy ?entity= only when it belongs to the client", () => {
    expect(resolveScope(clients, "/clients/a1", { entity: "e2" }).scope).toBe("entity:e2");
    expect(resolveScope(clients, "/clients/a1", { entity: "e3" }).scope).toBe("client:a1");
  });
  it("reads the client from the scope on a workspace page, and from nothing on Semua klien", () => {
    expect(resolveScope(clients, "/reports", { scope: "entity:e3" }).selectedClient?.id).toBe("b1");
    expect(resolveScope(clients, "/reports", { scope: "client:a1" }).routeClient).toBeUndefined();
    expect(resolveScope(clients, "/", {}).selectedClient).toBeUndefined();
    expect(resolveScope(clients, "/clients/gone", {}).selectedClient).toBeUndefined();
  });
});
