"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { StatusPill } from "@/components/app/status";
import { clearReportCommentAction, draftCommentaryAction, saveReportCommentAction } from "@/app/actions";

export type ManagementNoteProps = {
  clientId: string;
  entityId: string;
  year: number;
  month: number;
  periodLabel: string;
  facts: string[];
  note: { text: string; source: "AI" | "ACCOUNTANT"; approved: string; stale: boolean } | null;
  aiReady: boolean;
};

/**
 * Catatan bulan ini (I5b): the computed sentences, an AI draft whose every number is checked against them, and the note the accountant
 * approves for the management report. Nothing reaches the report without the click.
 */
export function ManagementNoteCard(p: ManagementNoteProps) {
  // A draft belongs to one report; changing scope also discards pending AI responses.
  return <ManagementNoteEditor key={`${p.clientId}:${p.entityId}:${p.year}:${p.month}`} {...p} />;
}

function ManagementNoteEditor(p: ManagementNoteProps) {
  const router = useRouter();
  const [draft, setDraft] = useState<{ text: string; source: "AI" | "ACCOUNTANT"; foreign: string[]; edited: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const key = { clientId: p.clientId, entityId: p.entityId, year: p.year, month: p.month };

  const askAi = async () => {
    setBusy(true);
    const r = await draftCommentaryAction(key);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    setDraft({ text: r.text, source: "AI", foreign: r.foreign, edited: false });
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    const r = await saveReportCommentAction({ ...key, text: draft.text, source: draft.edited ? "ACCOUNTANT" : draft.source });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success(r.foreign.length ? `Catatan disimpan. Angka di luar laporan: ${r.foreign.join(", ")}` : "Catatan disimpan untuk laporan manajemen");
    setDraft(null);
    router.refresh();
  };
  const clear = async () => {
    setBusy(true);
    const r = await clearReportCommentAction(key);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Kembali ke kalimat otomatis");
    router.refresh();
  };

  return (
    <Card data-testid="management-note">
      <CardHeader>
        <CardTitle>Catatan bulan ini · laporan manajemen</CardTitle>
        <CardDescription>
          Kalimat otomatis dihitung dari buku besar. {p.aiReady ? "AI boleh menyusun ulang kalimatnya; setiap angka diperiksa terhadap laporan." : "AI belum diatur di Pengaturan, jadi kalimat otomatis yang dipakai."} Catatan masuk ke laporan manajemen hanya setelah Anda menyetujuinya.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {p.note && (
          <div className="space-y-2 rounded-md border p-3" data-testid="management-note-approved">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={p.note.stale ? "REVIEW" : "PASS"} label={p.note.stale ? "Perlu ditinjau ulang" : "Disetujui"} />
              <span className="text-xs text-muted-foreground">{p.note.source === "AI" ? "Disusun AI" : "Ditulis akuntan"} · {p.note.approved}</span>
            </div>
            <p className="whitespace-pre-line">{p.note.text}</p>
            {p.note.stale && <p className="text-xs text-review">Angka di buku besar berubah setelah catatan ini disetujui. Laporan memakai kalimat otomatis sampai catatannya disetujui lagi.</p>}
          </div>
        )}
        <div className="space-y-1">
          <div className="eyebrow">Kalimat otomatis</div>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {p.facts.map((f) => <li key={f}>{f}</li>)}
          </ul>
        </div>
        {draft && (
          <div className="space-y-2">
            <Textarea value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value, edited: true })} rows={6} aria-label="Catatan untuk laporan manajemen" />
            {draft.source === "AI" && !draft.edited && (
              draft.foreign.length ? (
                <p className="text-xs text-fail" data-testid="note-check">Ditolak: angka {draft.foreign.join(", ")} tidak ada di laporan. Ubah sendiri atau susun ulang.</p>
              ) : (
                <p className="text-xs text-pass" data-testid="note-check">Semua angka cocok dengan laporan.</p>
              )
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {draft ? (
            <>
              <Button disabled={busy || !draft.text.trim() || (draft.source === "AI" && !draft.edited && draft.foreign.length > 0)} onClick={save}>Pakai catatan ini</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>Batal</Button>
            </>
          ) : (
            <>
              {p.aiReady && <Button variant="outline" disabled={busy} onClick={askAi}>{busy ? "Menyusun…" : "Susun dengan AI"}</Button>}
              <Button variant="outline" disabled={busy} onClick={() => setDraft({ text: p.note?.text ?? p.facts.join(" "), source: "ACCOUNTANT", foreign: [], edited: true })}>Tulis sendiri</Button>
              {p.note && <Button variant="ghost" disabled={busy} onClick={clear}>Kembali ke kalimat otomatis</Button>}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
