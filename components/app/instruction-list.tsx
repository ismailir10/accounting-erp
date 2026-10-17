"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { turnOffInstructionAction } from "@/app/instruction-actions";

/** One instruction as the list shows it (cycle 2026-10-18-instruksi-kantor); dates already formatted on the server. */
export type InstructionRow = {
  id: string;
  sentence: string;
  compiled: string;
  eyebrow: string;
  approved: string;
  off: string | null;
  /** What *Matikan* stops, for the confirm dialog. */
  stops: string;
  canTurnOff: boolean;
};

export function InstructionList({ active, off }: { active: InstructionRow[]; off: InstructionRow[] }) {
  return (
    <Card data-testid="instruction-list">
      <CardHeader>
        <CardTitle>Instruksi aktif</CardTitle>
        <CardDescription>Dijalankan sebagai aturan pasti. Untuk mengubah satu instruksi, matikan lalu tulis yang baru.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {active.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">Belum ada instruksi. Aturan bawaan Buku dan aturan dari Review tetap berlaku.</p>
        ) : (
          <ul className="divide-y border-y">{active.map((r) => <Row key={r.id} row={r} />)}</ul>
        )}
        {off.length > 0 && (
          <Collapsible className="border-b">
            <CollapsibleTrigger className="group flex w-full items-center gap-1 px-6 py-3 text-left text-sm font-medium text-primary hover:underline" data-testid="instruction-off-toggle">
              <ChevronRight className="size-4 transition-transform group-data-[panel-open]:rotate-90" aria-hidden />
              {off.length} dimatikan
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="divide-y border-t">{off.map((r) => <Row key={r.id} row={r} />)}</ul>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ row }: { row: InstructionRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const turnOff = async () => {
    setBusy(true);
    const r = await turnOffInstructionAction({ id: row.id });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Instruksi dimatikan");
    router.refresh();
  };
  return (
    <li id={`instruksi-${row.id}`} className="flex flex-wrap items-start justify-between gap-3 px-6 py-4 text-sm" data-testid="instruction-row">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="eyebrow">{row.eyebrow}</p>
        <p className="break-words">“{row.sentence}”</p>
        <p className="break-words text-muted-foreground">{row.compiled}</p>
        <p className="text-xs text-muted-foreground">{row.approved}{row.off && ` · ${row.off}`}</p>
      </div>
      {row.canTurnOff && !row.off && (
        <AlertDialog>
          <AlertDialogTrigger render={<Button variant="outline" size="sm" disabled={busy} />}>Matikan</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Matikan instruksi ini?</AlertDialogTitle>
              <AlertDialogDescription>{row.stops} Mutasi yang sudah dicatat, yang menunggu di Review, dan catatan kontrol tidak berubah.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Batal</AlertDialogCancel>
              <AlertDialogAction onClick={turnOff}>Matikan instruksi</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </li>
  );
}
