/**
 * The client menu and the rules for moving around it. Pure (no React, no icons), so the sidebar, the client switcher and the breadcrumbs
 * all read the same list and the same rules, and the rules are unit-tested (tests/unit/nav.test.ts).
 */

export type NavSection = { href: string; label: string };
export type NavStage = { label: string; items: NavSection[] };

/** Labels and hrefs match lib/clients/modules.ts (kept apart: that module is server code). */
export const MODULE_SECTIONS: (NavSection & { key: string })[] = [
  { key: "receivables", href: "/receivables", label: "Piutang & Utang" },
  { key: "inventory", href: "/inventory", label: "Persediaan" },
  { key: "assets", href: "/assets", label: "Aset Tetap" },
  { key: "leases", href: "/leases", label: "Sewa (PSAK 116)" },
  { key: "benefits", href: "/benefits", label: "Imbalan Kerja" },
];

export const SETUP_SECTIONS: NavSection[] = [
  { href: "/rates", label: "Kurs" },
  { href: "/settings", label: "Perusahaan & aturan" },
  { href: "/history", label: "Riwayat perubahan" },
];

export const OVERVIEW: NavSection = { href: "", label: "Ringkasan klien" };

/** Client pages in three stages (ADR 0014): Sumber → Buku Besar → Laporan, in working order (ui-rules 14). */
export function clientStages(modules: string[]): NavStage[] {
  return [
    { label: "1 · Sumber", items: [{ href: "/import", label: "Unggah" }, { href: "/opening", label: "Saldo Awal" }] },
    {
      label: "2 · Buku Besar",
      items: [
        { href: "/review", label: "Review transaksi" },
        { href: "/ledger", label: "Buku Besar" },
        { href: "/trial-balance", label: "Neraca Saldo" },
        { href: "/journals/new", label: "Jurnal Penyesuaian" },
        ...MODULE_SECTIONS.filter((m) => modules.includes(m.key)),
        { href: "/close", label: "Tutup Buku" },
      ],
    },
    { label: "3 · Laporan", items: [{ href: "/reports", label: "Laporan Keuangan" }, { href: "/tax/masa", label: "Pajak Masa" }, { href: "/tax", label: "Pajak Badan" }] },
  ];
}

/** Every page of the client menu, in order: the overview, the stages, then the settings group. */
export function clientSections(modules: string[]): NavSection[] {
  return [OVERVIEW, ...clientStages(modules).flatMap((s) => s.items), ...SETUP_SECTIONS];
}

const ALL_SECTIONS: NavSection[] = [OVERVIEW, ...clientStages(MODULE_SECTIONS.map((m) => m.key)).flatMap((s) => s.items), ...SETUP_SECTIONS];

const CLIENT_PATH = /^\/clients\/([^/]+)(\/.*)?$/;

/** `/clients/abc/ledger/1101` → `{ clientId: "abc", rest: "/ledger/1101" }`; null outside a client. `/clients/new` is not a client. */
export function parseClientPath(pathname: string): { clientId: string; rest: string } | null {
  const m = CLIENT_PATH.exec(pathname.replace(/\/+$/, "") || "/");
  if (!m || m[1] === "new") return null;
  return { clientId: m[1], rest: m[2] ?? "" };
}

/**
 * The menu page a client path belongs to (the most specific one: /tax/masa is Pajak Masa, not Pajak Badan), and whether the path is a
 * page *under* it (an account, an asset, an imported file) rather than the page itself. Null for a page the menu doesn't list.
 */
export function sectionOf(rest: string): { section: NavSection; deeper: boolean } | null {
  const path = rest.replace(/\/+$/, "");
  if (path === "") return { section: OVERVIEW, deeper: false };
  const hit = ALL_SECTIONS.filter((s) => s.href && (path === s.href || path.startsWith(`${s.href}/`))).sort((a, b) => b.href.length - a.href.length)[0];
  return hit ? { section: hit, deeper: path !== hit.href } : null;
}

/** A page under a section can return to a particular view of it: an imported ledger file goes back to the *Buku besar* tab of Impor. */
export function upQuery(rest: string): Record<string, string> {
  return /^\/import\/ledger(\/|$)/.test(rest) ? { tab: "ledger" } : {};
}

export type SwitchTarget = { href: string; label: string; fellBack: boolean };
type Query = { period?: string | null; scope?: string | null };

const WORKSPACE_PAGES: Record<string, string> = { "/": "Beranda", "/documents": "Dokumen", "/reports": "Laporan" };

function query(period: string | null | undefined, scope: string, entity?: string) {
  const p = new URLSearchParams();
  if (period) p.set("period", period);
  p.set("scope", scope);
  if (entity) p.set("entity", entity);
  return p.toString();
}

/**
 * Where choosing client `to` leads from `pathname`, so the accountant keeps their place:
 * - on a client page → the same page of `to` (a page under a section falls back to the section; a module `to` doesn't show, or a page the
 *   menu doesn't list, falls back to Ringkasan);
 * - on Beranda / Dokumen / Laporan already scoped to a client → the same page scoped to `to` (the sidebar treats it that way);
 * - anywhere else (scope "all", Pengaturan, Tambah klien) → Ringkasan of `to`.
 * The period travels along; the entity resets to the whole group, because entity ids belong to one client.
 */
export function switchTarget(pathname: string, to: { id: string; modules?: string[] }, q: Query = {}): SwitchTarget {
  const here = parseClientPath(pathname);
  const base = `/clients/${to.id}`;
  const overview = (fellBack: boolean): SwitchTarget => ({ href: `${base}?${query(q.period, `client:${to.id}`, "combined")}`, label: OVERVIEW.label, fellBack });
  if (here) {
    const found = sectionOf(here.rest);
    if (!found || !found.section.href) return overview(!found);
    const hidden = MODULE_SECTIONS.some((m) => m.href === found.section.href && !(to.modules ?? []).includes(m.key));
    if (hidden) return overview(true);
    return { href: `${base}${found.section.href}?${query(q.period, `client:${to.id}`, "combined")}`, label: found.section.label, fellBack: found.deeper };
  }
  const page = WORKSPACE_PAGES[pathname.replace(/\/+$/, "") || "/"];
  if (page && q.scope && q.scope !== "all") return { href: `${pathname}?${query(q.period, `client:${to.id}`)}`, label: page, fellBack: false };
  return overview(false);
}

/** Lower-case, accent-free text for matching, so "Kreatif" finds "kreátif" and the other way round. */
export function normalizeSearch(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().trim();
}

/** 0 = hidden. Every word typed must appear; a name that starts with the first word comes first. */
export function searchScore(value: string, search: string): number {
  const words = normalizeSearch(search).split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const hay = normalizeSearch(value);
  if (!words.every((w) => hay.includes(w))) return 0;
  return hay.startsWith(words[0]) ? 2 : 1;
}

export const RECENT_LIMIT = 5;

/** Recently opened clients, newest first: no duplicates, capped, and ids that no longer exist are dropped. */
export function pushRecent(list: string[], id: string): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, RECENT_LIMIT);
}

/** Reads the stored list defensively: anything that isn't a list of known ids is ignored. */
export function parseRecents(raw: string | null, known: Set<string>): string[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((x): x is string => typeof x === "string" && known.has(x)))].slice(0, RECENT_LIMIT);
  } catch { return []; }
}

/**
 * Which client the page is about, and the scope string the sidebar links carry (`all`, `client:<id>`, `entity:<id>`).
 * On a client page the URL decides; on Beranda / Dokumen / Laporan the `scope` parameter does.
 */
export function resolveScope<C extends { id: string; entities: { id: string }[] }>(clients: C[], pathname: string, params: { scope?: string | null; entity?: string | null }) {
  const here = parseClientPath(pathname);
  const routeClient = here ? clients.find((c) => c.id === here.clientId) : undefined;
  const legacyEntity = params.entity ?? null;
  const scope = params.scope || (routeClient
    ? legacyEntity && routeClient.entities.some((e) => e.id === legacyEntity) ? `entity:${legacyEntity}` : `client:${routeClient.id}`
    : "all");
  const selectedClient = routeClient ?? clients.find((c) => scope === `client:${c.id}` || c.entities.some((e) => scope === `entity:${e.id}`));
  return { routeClient, selectedClient, scope, legacyEntity };
}
