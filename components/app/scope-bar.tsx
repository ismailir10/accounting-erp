"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Option = { value: string; label: string };

/** Entity + period pickers. State lives in the URL so every view is linkable. */
export function ScopeBar({ entities, periods, entity, period, allowCombined = true }: { entities: Option[]; periods: Option[]; entity?: string; period?: string; allowCombined?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const set = (key: string, value: string | null) => {
    const p = new URLSearchParams(params.toString());
    if (value) p.set(key, value);
    else p.delete(key);
    if (key === "entity") {
      const clientId = pathname.match(/^\/clients\/([^/]+)/)?.[1];
      if (value && value !== "combined") p.set("scope", `entity:${value}`);
      else if (clientId) p.set("scope", `client:${clientId}`);
    }
    router.push(`${pathname}?${p.toString()}`);
  };
  const entityOptions = entities.length > 1 && allowCombined ? [{ value: "combined", label: "Gabungan Grup" }, ...entities] : entities;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {entity !== undefined && entityOptions.length > 1 && (
        <Select items={entityOptions} value={entity} onValueChange={(v) => set("entity", v as string)}>
          <SelectTrigger className="min-w-48 bg-card" aria-label="Entitas">
            <SelectValue />
          </SelectTrigger>
          {/* Wide enough for the longest entity name ("PT Chickin Sahabat Peternak"), never narrower than the trigger. */}
          <SelectContent className="w-auto min-w-(--anchor-width)">
            {entityOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {period !== undefined && (
        <Select items={periods} value={period} onValueChange={(v) => set("period", v as string)}>
          <SelectTrigger className="min-w-40 bg-card" aria-label="Periode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {periods.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
