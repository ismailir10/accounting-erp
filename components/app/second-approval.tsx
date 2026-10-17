"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Loader2, LockOpen, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { approveJournalAction, cancelReopenAction, confirmReopenAction, rejectJournalAction, rejectReopenAction, withdrawJournalAction } from "@/app/actions";

type Result = { ok: boolean; error?: string };
const NOTE_MIN = 5;

/** *Tolak* with *Alasan menolak* (≥ 5 characters, shown to the maker): the dialog both journal and reopen requests use. */
function RejectDialog({ open, onOpenChange, title, onReject }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; onReject: (note: string) => Promise<Result> }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (note.trim().length < NOTE_MIN) return setError(`Tulis alasan menolak (min. ${NOTE_MIN} karakter).`);
    setBusy(true);
    const r = await onReject(note);
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "Gagal menyimpan.");
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setNote(""); setError(null); } onOpenChange(o); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Tidak ada yang dicatat. Alasannya ditampilkan kepada yang mengajukan.</DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="reject-note">Alasan menolak</FieldLabel>
          <Textarea id="reject-note" value={note} rows={3} aria-invalid={!!error} onChange={(e) => { setNote(e.target.value); setError(null); }} placeholder="mis. Nominal belum didukung bukti" />
          <FieldDescription>Wajib diisi (min. {NOTE_MIN} karakter).</FieldDescription>
          <FieldError>{error}</FieldError>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Batal</Button>
          <Button disabled={busy} onClick={submit}>{busy && <Loader2 className="animate-spin" />} Tolak</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useRun() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<Result>, ok: string) => {
    setBusy(key);
    const r = await fn();
    setBusy(null);
    // A refused approval (e.g. the reversal's month closed meanwhile) stays waiting: the reason is shown, the row stays.
    if (!r.ok) return void toast.error(r.error ?? "Gagal menyimpan.");
    toast.success(ok);
    router.refresh();
  };
  return { busy, run };
}

/**
 * The buttons of a journal waiting for a second approver (Kotak persetujuan): *Setujui & catat* and *Tolak* for an eligible member,
 * *Tarik kembali* for its maker, and who it waits for for everyone else. Eligibility is decided on the server (`canDecide`, `isMaker`);
 * every action checks it again.
 */
export function JournalDecision({ clientId, id, memo, canDecide, isMaker, waitingFor }: { clientId: string; id: string; memo: string; canDecide: boolean; isMaker: boolean; waitingFor: string }) {
  const { busy, run } = useRun();
  const router = useRouter();
  const [rejecting, setRejecting] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canDecide && (
        <>
          <Button size="sm" disabled={busy !== null} onClick={() => run("approve", () => approveJournalAction(clientId, id), "Jurnal disetujui dan dicatat")} data-testid="second-approve">
            {busy === "approve" ? <Loader2 className="animate-spin" /> : <Check />} Setujui & catat
          </Button>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => setRejecting(true)} data-testid="second-reject">
            <X /> Tolak
          </Button>
        </>
      )}
      {isMaker && (
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => run("withdraw", () => withdrawJournalAction(clientId, id), "Jurnal ditarik kembali")} data-testid="second-withdraw">
          <Undo2 /> Tarik kembali
        </Button>
      )}
      {!canDecide && <span className="text-sm text-muted-foreground" data-testid="second-waiting">{waitingFor}</span>}
      <RejectDialog
        open={rejecting}
        onOpenChange={setRejecting}
        title={`Tolak "${memo}"?`}
        onReject={async (note) => {
          const r = await rejectJournalAction(clientId, id, note);
          if (r.ok) { toast.success("Jurnal ditolak"); router.refresh(); }
          return r;
        }}
      />
    </div>
  );
}

/** Tutup Buku of a closed month with a reopen request waiting: who asked and why, and the decision buttons (NextStep's look). */
export function ReopenRequestPanel({ clientId, id, label, requestedBy, reason, canDecide, isRequester }: { clientId: string; id: string; label: string; requestedBy: string; reason: string; canDecide: boolean; isRequester: boolean }) {
  return (
    <div className="space-y-3 rounded-xl bg-primary-subtle px-4 py-3 text-sm" data-testid="reopen-request">
      <div className="flex items-start gap-3">
        <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand" aria-hidden />
        <p className="min-w-0 flex-1 font-medium">
          {requestedBy} meminta membuka kembali {label}: “{reason}”. Buku tetap ditutup sampai admin lain mengonfirmasi.
        </p>
      </div>
      <div className="pl-5">
        <ReopenDecision clientId={clientId} id={id} label={label} canDecide={canDecide} isRequester={isRequester} />
      </div>
    </div>
  );
}

/** The buttons of a reopen request: another admin confirms or rejects; the requester cancels; everyone else sees who it waits for. */
export function ReopenDecision({ clientId, id, label, canDecide, isRequester }: { clientId: string; id: string; label: string; canDecide: boolean; isRequester: boolean }) {
  const { busy, run } = useRun();
  const router = useRouter();
  const [rejecting, setRejecting] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canDecide && (
        <>
          <Button size="sm" disabled={busy !== null} onClick={() => run("confirm", () => confirmReopenAction(clientId, id), `${label} dibuka kembali`)} data-testid="reopen-confirm">
            {busy === "confirm" ? <Loader2 className="animate-spin" /> : <LockOpen />} Konfirmasi buka kembali
          </Button>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => setRejecting(true)} data-testid="reopen-reject">
            <X /> Tolak
          </Button>
        </>
      )}
      {isRequester && (
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => run("cancel", () => cancelReopenAction(clientId, id), "Permintaan dibatalkan")} data-testid="reopen-cancel">
          <Undo2 /> Batalkan permintaan
        </Button>
      )}
      {!canDecide && !isRequester && <span className="text-sm text-muted-foreground">Menunggu konfirmasi admin lain</span>}
      <RejectDialog
        open={rejecting}
        onOpenChange={setRejecting}
        title={`Tolak membuka kembali ${label}?`}
        onReject={async (note) => {
          const r = await rejectReopenAction(clientId, id, note);
          if (r.ok) { toast.success("Permintaan ditolak"); router.refresh(); }
          return r;
        }}
      />
    </div>
  );
}
