"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { BookOpen, Boxes, CalendarCheck, Building2, ChartColumn, ChevronsUpDown, HandCoins, KeyRound, ReceiptText, Warehouse, ChevronDown, ClipboardCheck, Coins, FileSpreadsheet, FolderOpen, Home, Inbox, Landmark, ListFilter, LogOut, NotebookPen, Plus, Scale, Search, Settings2, SlidersHorizontal, Upload, Users, History, ListTree, Target } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { BrandMark } from "@/components/app/brand-mark";
import { ShortcutKbd, useClientSwitcher, type SwitcherClient } from "@/components/app/client-switcher";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { signOutAction } from "@/app/login/actions";
import { clientStages, resolveScope, SETUP_SECTIONS, type NavSection } from "@/lib/nav";

// The firm-wide pages. They sit under "Semua klien" so *Laporan* here can't be mistaken for the client's "3 · Laporan".
const DESTINATIONS = [
  { href: "/", label: "Beranda", icon: Home },
  { href: "/documents", label: "Dokumen", icon: FolderOpen },
  { href: "/reports", label: "Laporan", icon: ChartColumn },
];
// The client menu (lib/nav.ts) in three stages (ADR 0014): Sumber → Buku Besar → Laporan, in working order. The first-run steps
// (Impor → Saldo Awal → Review → Tutup Buku) read top to bottom and are never collapsed (ui-rules 14). Modules show per client.
const ICONS: Record<string, typeof Upload> = {
  "/import": Upload, "/analysis": ChartColumn, "/opening": Landmark, "/review": Inbox, "/ledger": BookOpen, "/trial-balance": Scale, "/journals/new": NotebookPen,
  "/receivables": HandCoins, "/inventory": Boxes, "/assets": Warehouse, "/leases": KeyRound, "/benefits": Users, "/close": ClipboardCheck,
  "/reports": FileSpreadsheet, "/budget": Target, "/tax/masa": CalendarCheck, "/tax": ReceiptText, "/accounts": ListTree, "/rates": Coins, "/settings": ListFilter, "/history": History,
};
type Item = NavSection & { icon: typeof Upload };
const withIcons = (items: NavSection[]): Item[] => items.map((item) => ({ ...item, icon: ICONS[item.href] ?? FileSpreadsheet }));

/**
 * `company`: the organisation is a company keeping its own books (ADR 0017 §1). Its one client is the company, always selected;
 * the switcher, the client list, *Tambah klien* and the firm-wide report list are gone, and nothing says "klien".
 */
export function AppSidebar({ firmName, clients, user, documents = true, company = false }: { firmName: string; clients: SwitcherClient[]; user?: { name: string; role: string }; documents?: boolean; company?: boolean }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const { setOpenMobile } = useSidebar();
  const { open: openSwitcher } = useClientSwitcher();
  const resolved = resolveScope(clients, pathname, { scope: search.get("scope"), entity: search.get("entity") });
  const { routeClient, scope, legacyEntity } = resolved;
  const selectedClient = resolved.selectedClient ?? (company ? clients[0] : undefined);
  function destinationHref(path: string) {
    const params = new URLSearchParams({ scope });
    if (search.get("period")) params.set("period", search.get("period")!);
    return `${path}?${params}`;
  }
  function clientHref(client: SwitcherClient, path = "") {
    const params = new URLSearchParams();
    if (search.get("period")) params.set("period", search.get("period")!);
    const sameClient = routeClient?.id === client.id || selectedClient?.id === client.id;
    params.set("scope", sameClient ? scope : `client:${client.id}`);
    const entity = client.entities.find((item) => scope === `entity:${item.id}` || (routeClient?.id === client.id && item.id === legacyEntity));
    params.set("entity", entity?.id || "combined");
    return `/clients/${client.id}${path}?${params}`;
  }
  const inSetup = Boolean(selectedClient && SETUP_SECTIONS.some((item) => pathname.startsWith(`/clients/${selectedClient.id}${item.href}`)));
  // The section holding the current page stays open; elsewhere it toggles.
  const [setupOpen, setSetupOpen] = useState(false);
  const closeMobile = () => setOpenMobile(false);
  function accountingLinks(sections: NavSection[], client: SwitcherClient) {
    // The most specific item wins, so /tax/masa lights Pajak Masa and not Pajak Badan.
    const items = withIcons(sections);
    const active = items.map((i) => i.href).filter((h) => pathname.startsWith(`/clients/${client.id}${h}`)).sort((a, b) => b.length - a.length)[0];
    return <SidebarMenuSub>{items.map((item) => <SidebarMenuSubItem key={item.href}><SidebarMenuSubButton isActive={item.href === active} aria-current={item.href === active ? "page" : undefined} render={<Link href={clientHref(client, item.href)} onClick={closeMobile} />}><item.icon /><span>{item.label}</span></SidebarMenuSubButton></SidebarMenuSubItem>)}</SidebarMenuSub>;
  }
  const isHere = (href: string) => pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
  return (
    <Sidebar>
      <SidebarHeader className="border-b border-sidebar-border"><Link href={destinationHref("/")} onClick={closeMobile} className="flex items-center gap-2 px-2 py-1.5"><BrandMark /><span className="min-w-0"><span className="block text-sm font-semibold">Buku</span><span className="block truncate text-xs text-sidebar-foreground/70">{firmName}</span></span></Link></SidebarHeader>
      <SidebarContent>
        <SidebarGroup>{!company && <SidebarGroupLabel>Semua klien</SidebarGroupLabel>}<SidebarMenu>{DESTINATIONS.filter((item) => (documents || item.href !== "/documents") && !(company && item.href === "/reports")).map((item) => <SidebarMenuItem key={item.href}><SidebarMenuButton isActive={isHere(item.href)} aria-current={isHere(item.href) ? "page" : undefined} render={<Link href={destinationHref(item.href)} onClick={closeMobile} />}><item.icon /><span>{item.label}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroup>
        {selectedClient && (
          <SidebarGroup>
            {company ? <SidebarGroupLabel><span className="block min-w-0 truncate" title={selectedClient.name}>{selectedClient.name}</span></SidebarGroupLabel> : <button type="button" onClick={() => { closeMobile(); openSwitcher(); }} aria-haspopup="dialog" title={selectedClient.name} data-testid="client-switcher" className="mb-1 flex w-full items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-accent px-2 py-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-sidebar-ring">
              <span className="icon-tile size-7"><Building2 className="size-4" /></span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{selectedClient.name}</span><span className="flex items-center gap-1.5 text-xs text-sidebar-foreground/70">Ganti klien <ShortcutKbd /></span></span>
              <ChevronsUpDown className="size-4 shrink-0 text-sidebar-foreground/60" aria-hidden />
            </button>}
            <SidebarMenu>
              <SidebarMenuItem><SidebarMenuButton isActive={pathname === `/clients/${selectedClient.id}`} aria-current={pathname === `/clients/${selectedClient.id}` ? "page" : undefined} render={<Link href={clientHref(selectedClient)} onClick={closeMobile} />}><Building2 /><span>{company ? "Ringkasan" : "Ringkasan klien"}</span></SidebarMenuButton></SidebarMenuItem>
              {clientStages(selectedClient.modules ?? []).map((stage) => <SidebarMenuItem key={stage.label}><p className="eyebrow px-2 pt-3 pb-1 text-sidebar-foreground/70">{stage.label}</p>{accountingLinks(stage.items, selectedClient)}</SidebarMenuItem>)}
              <Collapsible open={inSetup || setupOpen} onOpenChange={setSetupOpen} render={<SidebarMenuItem />}><CollapsibleTrigger render={<SidebarMenuButton className="group/trigger text-sidebar-foreground/70" />}><Settings2 /><span>{company ? "Pengaturan buku" : "Pengaturan klien"}</span><ChevronDown className="ml-auto transition-transform group-data-[panel-open]/trigger:rotate-180" /></CollapsibleTrigger><CollapsibleContent>{accountingLinks(SETUP_SECTIONS, selectedClient)}</CollapsibleContent></Collapsible>
            </SidebarMenu>
          </SidebarGroup>
        )}
        {!company && <SidebarGroup>
          {!selectedClient && <SidebarMenu className="mb-1"><SidebarMenuItem><SidebarMenuButton onClick={() => { closeMobile(); openSwitcher(); }} aria-haspopup="dialog" data-testid="client-switcher"><Search /><span>Cari klien</span><ShortcutKbd className="ml-auto" /></SidebarMenuButton></SidebarMenuItem></SidebarMenu>}
          <Collapsible key={selectedClient ? "client" : "firm"} defaultOpen={!selectedClient}><CollapsibleTrigger render={<SidebarGroupLabel render={<button type="button" />} className="group/trigger w-full cursor-pointer hover:bg-sidebar-accent" />}><span>Daftar klien ({clients.length})</span><ChevronDown className="ml-auto transition-transform group-data-[panel-open]/trigger:rotate-180" /></CollapsibleTrigger><CollapsibleContent><SidebarMenu>{clients.map((client) => <SidebarMenuItem key={client.id}><SidebarMenuButton isActive={client.id === selectedClient?.id} aria-current={client.id === selectedClient?.id ? "true" : undefined} render={<Link href={clientHref(client)} onClick={closeMobile} />}><Building2 /><span>{client.name}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></CollapsibleContent></Collapsible><SidebarMenu><SidebarMenuItem><SidebarMenuButton render={<Link href="/clients/new" onClick={closeMobile} />}><Plus /><span>Tambah klien</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu>
        </SidebarGroup>}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border"><SidebarMenu><SidebarMenuItem><SidebarMenuButton isActive={pathname === "/settings"} aria-current={pathname === "/settings" ? "page" : undefined} render={<Link href={destinationHref("/settings")} onClick={closeMobile} />}><SlidersHorizontal /><span>{company ? "Pengaturan" : "Pengaturan kantor"}</span></SidebarMenuButton></SidebarMenuItem><SidebarMenuItem><form action={signOutAction}><SidebarMenuButton type="submit"><LogOut /><span>Keluar</span></SidebarMenuButton></form></SidebarMenuItem></SidebarMenu>{user && <p className="truncate px-2 text-xs text-sidebar-foreground/70">{user.name} · {user.role}</p>}</SidebarFooter>
    </Sidebar>
  );
}

export function MobileTrigger() { return <SidebarTrigger className="md:hidden" aria-label="Buka navigasi" />; }
