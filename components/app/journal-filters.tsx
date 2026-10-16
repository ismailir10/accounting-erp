"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SimpleSelect } from "@/components/app/simple-select";

type Option = { value: string; label: string };

/** Jurnal Umum's range, kind and search. State lives in the URL (ui-rules 3); any change goes back to the first page. */
export function JournalFilters({ ranges, kinds, range, kind, q }: { ranges: Option[]; kinds: Option[]; range: string; kind: string; q: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [text, setText] = useState(q);
  const go = (changes: Record<string, string>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    p.delete("hal");
    router.push(`${pathname}?${p.toString()}`);
  };
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="journal-filters">
      <SimpleSelect label="Rentang" value={range} onChange={(v) => go({ range: v === "month" ? "" : v })} options={ranges} className="w-full sm:w-64" />
      <SimpleSelect label="Jenis jurnal" value={kind} onChange={(v) => go({ jenis: v === "semua" ? "" : v })} options={kinds} className="w-full sm:w-48" />
      <form
        role="search"
        className="flex w-full min-w-0 gap-2 sm:w-auto sm:flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          go({ q: text.trim() });
        }}
      >
        <Input aria-label="Cari jurnal" placeholder="Cari keterangan, akun, atau nominal" value={text} onChange={(e) => setText(e.target.value)} className="min-w-0 flex-1 sm:w-72" />
        <Button type="submit" variant="outline">
          <Search /> Cari
        </Button>
      </form>
    </div>
  );
}
