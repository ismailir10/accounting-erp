"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MethodBadge, StatusPill } from "@/components/app/status";
import { useAccess } from "@/components/app/access-context";
import { clearFluxExplanationAction, draftFluxExplanationAction, saveFluxExplanationAction } from "@/app/actions";

export type FluxExplanationProps = {
  clientId: string;
  entityId: string;
  year: number;
  month: number;
  code: string;
  /** The flux scan flags the account: only then may AI draft (ADR 0009 amendment). */
  flagged: boolean;
  aiReady: boolean;
  approved: { text: string; source: "AI" | "ACCOUNTANT"; approved: string; stale: boolean } | null;
  /** Last month's approved text for this account, offered with *Pakai lagi*. */
  previous: string | null;
};

type Draft = { text: string; source: "AI" | "ACCOUNTANT"; refs: { id: string; label: string; href: string }[]; foreign: string[]; edited: boolean };

/**
 * One mover's explanation (accounting-rules 20d): the approved text with who and when (or *Perlu ditinjau ulang*), last month's offered
 * again, and the editor — typed, or drafted by AI on a flagged account with its citations and every number checked. Nothing is stored
 * without *Setujui*. A viewer sees the approved text only.
 */
export function FluxExplanationCard(p: FluxExplanationProps) {
  // A draft belongs to one company, month and account; changing scope also discards a pending AI response.
  return <FluxExplanationEditor key={`${p.clientId}:${p.entityId}:${p.year}:${p.month}:${p.code}`} {...p} />;
}

function FluxExplanationEditor(p: FluxExplanationProps) {
  const router = useRouter();
  const { canWrite } = useAccess();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const key = { clientId: p.clientId, entityId: p.entityId, year: p.year, month: p.month, accountCode: p.code };
  const write = (text: string) => setDraft({ text, source: "ACCOUNTANT", refs: [], foreign: [], edited: true });

  const askAi = async () => {
    setBusy(true);
    const r = await draftFluxExplanationAction(key);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    setDraft({ ...r.draft, source: "AI", edited: false });
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    const source = draft.edited ? "ACCOUNTANT" : draft.source;
    const r = await saveFluxExplanationAction({ ...key, text: draft.text, source, refs: source === "AI" ? draft.refs.map((x) => x.id) : [] });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success(r.foreign.length ? `Penjelasan disetujui. Angka di luar data akun: ${r.foreign.join(", ")}` : `Penjelasan ${p.code} disetujui untuk laporan manajemen`);
    setDraft(null);
    router.refresh();
  };
  const clear = async () => {
    setBusy(true);
    const r = await clearFluxExplanationAction(key);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success(`Penjelasan ${p.code} dihapus`);
    router.refresh();
  };

  const aiButton = p.flagged && p.aiReady && (
    <Button variant="outline" size="sm" disabled={busy} onClick={askAi}>{busy ? "Menyusun…" : "Susun dengan AI"}</Button>
  );
  return (
    <div className="space-y-2 text-sm" data-testid="flux-explanation">
      {p.approved && !draft && (
        <div className="space-y-1" data-testid="flux-explanation-approved">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={p.approved.stale ? "REVIEW" : "PASS"} label={p.approved.stale ? "Perlu ditinjau ulang" : "Disetujui"} />
            <span className="text-xs text-muted-foreground">{p.approved.source === "AI" ? "Disusun AI" : "Ditulis akuntan"} · {p.approved.approved}</span>
          </div>
          <p className="whitespace-pre-line">{p.approved.text}</p>
          {p.approved.stale && <p className="text-xs text-review">Mutasi akun ini berubah setelah penjelasan disetujui. Laporan manajemen tidak memakainya sampai disetujui lagi.</p>}
        </div>
      )}
      {!p.approved && !draft && p.previous && canWrite && (
        <div className="space-y-1" data-testid="flux-explanation-previous">
          <div className="eyebrow">Penjelasan bulan lalu</div>
          <p className="whitespace-pre-line text-muted-foreground">{p.previous}</p>
        </div>
      )}
      {draft && (
        <div className="space-y-2">
          {draft.source === "AI" && !draft.edited && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <MethodBadge method="AI" />
              <span>Mengutip</span>
              {draft.refs.map((r) => (
                <Link key={r.id} href={r.href} className="drill">{r.label}</Link>
              ))}
            </div>
          )}
          <Textarea value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value, edited: true })} rows={4} maxLength={1000} aria-label={`Penjelasan akun ${p.code}`} />
          {draft.source === "AI" && !draft.edited && (
            draft.foreign.length ? (
              <p className="text-xs text-fail" data-testid="flux-explanation-check">Ditolak: angka {draft.foreign.join(", ")} tidak ada di baris yang dikirim. Ubah sendiri atau tulis ulang.</p>
            ) : (
              <p className="text-xs text-pass" data-testid="flux-explanation-check">Semua angka cocok dengan baris yang dikutip.</p>
            )
          )}
        </div>
      )}
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          {draft ? (
            <>
              <Button size="sm" disabled={busy || !draft.text.trim() || (draft.source === "AI" && !draft.edited && draft.foreign.length > 0)} onClick={save}>Setujui</Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>Batal</Button>
            </>
          ) : p.approved ? (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => write(p.approved!.text)}>Ubah penjelasan</Button>
              {aiButton}
              <Button variant="ghost" size="sm" disabled={busy} onClick={clear}>Hapus penjelasan</Button>
            </>
          ) : (
            <>
              {p.previous && <Button variant="outline" size="sm" disabled={busy} onClick={() => write(p.previous!)}>Pakai lagi</Button>}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => write("")}>Tulis penjelasan</Button>
              {aiButton}
            </>
          )}
        </div>
      )}
    </div>
  );
}
