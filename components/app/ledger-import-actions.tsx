"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { acceptCheckAction, discardLedgerDraftAction, postLedgerImportAction } from "@/app/actions";

const ACCEPT_TEXT = {
  date: { toast: "Baris akan dicatat per tanggal yang diperbaiki", button: "Terima tanggal yang diperbaiki" },
  skip: { toast: "Baris saldo awal file tidak akan dicatat", button: "Lewati baris saldo awal" },
  difference: { toast: "Selisih akan dicatat ke 1999 Belum Terklasifikasi", button: "Terima & catat selisih ke 1999" },
};

export function AcceptCheckButton({ clientId, checkId, kind }: { clientId: string; checkId: string; kind: "difference" | "date" | "skip" }) {
  const text = ACCEPT_TEXT[kind];
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const r = await acceptCheckAction(clientId, checkId);
        setBusy(false);
        if (!r.ok) return toast.error(r.error);
        toast.success(text.toast);
        router.refresh();
      }}
    >
      {busy && <Loader2 className="animate-spin" />} {text.button}
    </Button>
  );
}

export function PostImportButton({ clientId, importId, label, disabled }: { clientId: string; importId: string; label: string; disabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      disabled={disabled || busy}
      onClick={async () => {
        setBusy(true);
        const r = await postLedgerImportAction(clientId, importId);
        setBusy(false);
        if (!r.ok) {
          toast.error(r.error);
          return router.refresh(); // a refusal can update the draft's findings (e.g. a Kurs difference found at posting)
        }
        toast.success(`${r.entries} jurnal dicatat`);
        router.refresh();
      }}
    >
      {busy && <Loader2 className="animate-spin" />} {label}
    </Button>
  );
}

export function DiscardDraftButton({ clientId, importId }: { clientId: string; importId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const r = await discardLedgerDraftAction(clientId, importId);
        setBusy(false);
        if (!r.ok) return toast.error(r.error);
        toast.success("Draf dibatalkan");
        router.push(`/clients/${clientId}/import?tab=ledger`);
      }}
    >
      Batalkan draf
    </Button>
  );
}
