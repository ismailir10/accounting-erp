"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SimpleSelect } from "@/components/app/simple-select";

/** Departemen & Proyek filter for a ledger view: `?tag=<id>` in the URL, so a filtered Buku Besar is linkable (the Laba Rugi drills here). */
export function TagFilter({ options, value }: { options: { id: string; label: string }[]; value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  if (!options.length) return null;
  return (
    <SimpleSelect
      label="Departemen atau proyek"
      value={value}
      className="min-w-48"
      onChange={(v) => {
        const p = new URLSearchParams(params.toString());
        if (v) p.set("tag", v);
        else p.delete("tag");
        router.push(`${pathname}?${p.toString()}`);
      }}
      options={[{ value: "", label: "Semua departemen & proyek" }, ...options.map((o) => ({ value: o.id, label: o.label }))]}
    />
  );
}
