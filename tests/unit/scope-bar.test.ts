// @vitest-environment jsdom
import { createElement, Fragment, type ReactNode } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ScopeBar } from "@/components/app/scope-bar";
const nav = vi.hoisted(() => ({push:vi.fn()}));
vi.mock("next/navigation", () => ({useRouter:()=>nav,usePathname:()=>"/clients/demo/reports",useSearchParams:()=>new URLSearchParams("entity=entity-a&scope=entity%3Aentity-a&period=2026-08&tab=mgmt")}));
vi.mock("@/components/ui/select",()=>({
 Select:({value,onValueChange,children}:{value:string;onValueChange:(v:string)=>void;children:ReactNode})=>createElement("select",{"aria-label":value.startsWith("2026-")?"Periode":"Entitas",value,onChange:(e:{target:{value:string}})=>onValueChange(e.target.value)},children),
 SelectContent:({children}:{children:ReactNode})=>createElement(Fragment,null,children),
 SelectItem:({value,children}:{value:string;children:ReactNode})=>createElement("option",{value},children),
 SelectTrigger:()=>null,SelectValue:()=>null,
}));
afterEach(()=>{cleanup();nav.push.mockReset()});
const props={entities:[{value:"entity-a",label:"PT Demo A"},{value:"entity-b",label:"PT Demo B"}],periods:[{value:"2026-07",label:"Juli 2026"},{value:"2026-08",label:"Agustus 2026"}],entity:"entity-a",period:"2026-08"};
it("changes the report month while retaining company and management tab",()=>{
 const page=render(createElement(ScopeBar,props));fireEvent.change(page.getByRole("combobox",{name:"Periode"}),{target:{value:"2026-07"}});
 const q=new URL(nav.push.mock.calls[0][0],"http://localhost").searchParams;
 expect(q.get("period")).toBe("2026-07");expect(q.get("entity")).toBe("entity-a");expect(q.get("scope")).toBe("entity:entity-a");expect(q.get("tab")).toBe("mgmt");
});
it("changes company while retaining the report month and management tab",()=>{
 const page=render(createElement(ScopeBar,props));fireEvent.change(page.getByRole("combobox",{name:"Entitas"}),{target:{value:"entity-b"}});
 const q=new URL(nav.push.mock.calls[0][0],"http://localhost").searchParams;
 expect(q.get("entity")).toBe("entity-b");expect(q.get("scope")).toBe("entity:entity-b");expect(q.get("period")).toBe("2026-08");expect(q.get("tab")).toBe("mgmt");
});
