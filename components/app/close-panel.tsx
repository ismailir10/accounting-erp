"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronRight, Loader2, Lock, LockOpen, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusPill } from "@/components/app/status";
import { ackControlAction, explainControlAction, lockAction, signoffAction, unlockAction } from "@/app/actions";
import type { Control } from "@/lib/controls";
import type { ControlExplanation } from "@/lib/controls/explain";

const ORDER = { FAIL: 0, REVIEW: 1, PASS: 2 } as const;

export function ClosePanel(props: {
  clientId: string;
  year: number;
  month: number;
  periodLabel: string;
  controls: Control[];
  /** `pelaksana`: the sign-off's Pelaksana once the month's checklist has its task; `blocked`: why this member may not tick it now. */
  signoffs: { key: string; label: string; done: boolean; by: string | null; pelaksana?: string | null; blocked?: string | null }[];
  /** Checklist tutup buku for the month: where it is and how many tasks are unfinished (a warning, never a blocker). */
  checklist?: { href: string; open: number } | null;
  locked: boolean;
  lockedAt: string | null;
  blockers: string[];
  /** AI configured: each flagged row offers "Jelaskan" (accounting-rules 20b). */
  aiReady?: boolean;
  /** Only an admin reopens a closed month (with a reason); the others see who can. */
  isAdmin: boolean;
  /** Why reopening is refused right now (a later month is still closed), or null. */
  unlockBlocker: string | null;
  /** The last reopenings of this client, newest first. */
  unlocks: { label: string; reason: string; by: string }[];
  /** Persetujuan kedua: "request" when another admin must confirm a reopen; a request already waiting hides the button. */
  reopenMode?: "direct" | "request";
  reopenPending?: boolean;
  /** Journals of the month waiting for a second approver hold the lock: where to decide them. */
  secondHref?: string | null;
}) {
  const { clientId, year, month } = props;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [ackFor, setAckFor] = useState<Control | null>(null);
  const [note, setNote] = useState("");
  const [explained, setExplained] = useState<Record<string, ControlExplanation>>({});
  const [explaining, setExplaining] = useState<string | null>(null);
  // Locking and reopening change what every import and journal may do: both are confirmed first.
  const [confirm, setConfirm] = useState<"lock" | "unlock" | null>(null);
  const [reason, setReason] = useState("");
  const reasonOk = reason.trim().length >= 5;
  const explain = async (c: Control) => {
    setExplaining(c.key);
    const r = await explainControlAction(clientId, year, month, c.key);
    setExplaining(null);
    if (!r.ok) return void toast.error(r.error);
    setExplained((x) => ({ ...x, [c.key]: r.explanation }));
    if (r.explanation.proposal) router.refresh();
  };
  const asks = props.reopenMode === "request";
  const run = <R extends { ok: boolean; error?: string }>(fn: () => Promise<R>, success?: string | ((r: R) => string)) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error((r as { error: string }).error);
      else {
        if (success) toast.success(typeof success === "string" ? success : success(r));
        router.refresh();
      }
    });

  // Groups with something to do come first (a group-level problem must not hide under a company's passing controls).
  const worst = (g: string) => Math.min(...props.controls.filter((c) => c.scope === g).map((c) => ORDER[c.status]));
  const groups = [...new Set(props.controls.map((c) => c.scope))].sort((a, b) => worst(a) - worst(b));

  const rowsOf = (g: string) => {
    const rows = props.controls.filter((c) => c.scope === g).sort((a, b) => ORDER[a.status] - ORDER[b.status]);
    return { open: rows.filter((c) => c.status !== "PASS"), passed: rows.filter((c) => c.status === "PASS") };
  };
  const controlRow = (c: (typeof props.controls)[number]) => (
    <div key={c.key} className="flex flex-wrap items-center gap-3 px-6 py-2.5" data-testid={`control-${c.key.split(":")[0]}`}>
      <StatusPill status={c.status} />
      <div className="min-w-0 flex-1 basis-56">
        <div className="text-sm font-medium">{c.title}</div>
        <div className="text-xs text-muted-foreground">{c.detail}</div>
        {c.ack && <div className="mt-1 flex items-center gap-1 text-xs text-foreground"><MessageSquare className="size-3" /> {c.ack}</div>}
        {c.staleAck && (
          <div className="mt-1 flex items-center gap-1 text-xs text-review" data-testid="stale-ack">
            <MessageSquare className="size-3" /> Catatan lama: “{c.staleAck}” — kondisinya berubah, periksa dan beri catatan lagi.
          </div>
        )}
      </div>
      {c.href && c.status !== "PASS" && (
        <Link href={c.href} className="text-sm font-medium text-primary hover:underline">Periksa</Link>
      )}
      {c.status !== "PASS" && !props.locked && props.aiReady && !explained[c.key] && (
        <Button variant="ghost" size="sm" disabled={explaining !== null} onClick={() => explain(c)}>
          {explaining === c.key ? "Menjelaskan…" : "Jelaskan"}
        </Button>
      )}
      {c.status === "REVIEW" && !props.locked && (
        <Button variant="outline" size="sm" onClick={() => { setAckFor(c); setNote(c.ack ?? c.staleAck ?? ""); }}>
          {c.ack ? "Ubah catatan" : c.staleAck ? "Perbarui catatan" : "Beri catatan"}
        </Button>
      )}
      {explained[c.key] && (
        <div className="basis-full space-y-1.5 border-l-2 border-primary/30 pl-3 text-sm" data-testid="control-explanation">
          <p>{explained[c.key].explanation}</p>
          {explained[c.key].suggestion && <p><span className="font-medium">Usulan AI:</span> {explained[c.key].suggestion}</p>}
          {explained[c.key].links.length > 0 && (
            <ul className="space-y-0.5 text-xs">
              {explained[c.key].links.map((l) => (
                <li key={l.id}><Link href={l.href} className="text-muted-foreground drill">{l.label} ›</Link></li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {explained[c.key].proposal && <span className="text-xs text-muted-foreground">Draf jurnal dibuat di <span className="font-medium text-foreground">Usulan jurnal koreksi</span>; dicatat setelah Anda klik.</span>}
            {c.status === "REVIEW" && explained[c.key].note && (
              <Button variant="outline" size="sm" onClick={() => { setAckFor(c); setNote(explained[c.key].note); }}>Pakai sebagai catatan</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        {groups.map((g) => {
          const { open, passed } = rowsOf(g);
          return (
          <Card key={g}>
            <CardHeader>
              <CardTitle>{g}</CardTitle>
            </CardHeader>
            <CardContent className="divide-y px-0">
              {open.map(controlRow)}
              {passed.length > 0 && (
                <details className="group/passed" data-testid="passed-controls">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-6 py-2.5 text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                    <ChevronRight className="size-4 transition-transform group-open/passed:rotate-90" aria-hidden />
                    {passed.length} kontrol lolos
                  </summary>
                  <div className="divide-y border-t">{passed.map(controlRow)}</div>
                </details>
              )}
            </CardContent>
          </Card>
          );
        })}
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Daftar periksa</CardTitle>
            <CardDescription>Diperiksa dan dicentang oleh akuntan</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {props.signoffs.map((s) => (
              // Not wrapped in <label>: a wrapping label re-forwards the click and toggles twice.
              <div key={s.key} className="flex items-start gap-2 text-sm" data-testid="signoff">
                <Checkbox
                  id={`signoff-${s.key}`}
                  checked={s.done}
                  disabled={pending || props.locked || Boolean(s.blocked)}
                  onCheckedChange={(v) => run(() => signoffAction(clientId, year, month, s.key, Boolean(v)))}
                  className="mt-0.5"
                />
                <label htmlFor={`signoff-${s.key}`} className="cursor-pointer">
                  {s.label}
                  {s.pelaksana && <span className="block text-xs text-muted-foreground">Pelaksana {s.pelaksana}</span>}
                  {s.by && <span className="block text-xs text-muted-foreground">Dicentang {s.by}</span>}
                  {s.blocked && !props.locked && <span className="block text-xs text-muted-foreground" data-testid="signoff-blocked">{s.blocked}</span>}
                </label>
              </div>
            ))}
            {props.checklist && <Link href={props.checklist.href} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">Buka checklist <ChevronRight className="size-3.5" /></Link>}
          </CardContent>
        </Card>
        <Card className={props.locked ? "border-pass/30" : ""}>
          <CardHeader>
            <CardTitle>{props.locked ? `Buku ${props.periodLabel} ditutup` : `Tutup buku ${props.periodLabel}`}</CardTitle>
            <CardDescription>
              {props.locked ? `Dikunci ${props.lockedAt}. Impor & jurnal ke periode ini ditolak.` : "Setelah ditutup, periode dikunci dari perubahan."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!props.locked && props.blockers.length > 0 && (
              <ul className="space-y-1 text-sm text-muted-foreground">
                {props.blockers.map((b) => <li key={b}>• {b}</li>)}
              </ul>
            )}
            {!props.locked && props.secondHref && (
              <Link href={props.secondHref} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline" data-testid="lock-second">
                Putuskan di Kotak persetujuan <ChevronRight className="size-3.5" />
              </Link>
            )}
            {/* A warning, not a blocker: the checklist never holds the lock (accounting-rules 23). */}
            {!props.locked && props.checklist && props.checklist.open > 0 && (
              <p className="text-sm text-muted-foreground" data-testid="checklist-warning">
                <Link href={props.checklist.href} className="underline-offset-4 hover:text-foreground hover:underline">Checklist: {props.checklist.open} tugas belum selesai</Link>
              </p>
            )}
            {props.locked ? (
              props.reopenPending ? (
                <p className="text-sm text-muted-foreground">Permintaan membuka kembali menunggu konfirmasi admin lain (lihat di atas).</p>
              ) : props.isAdmin ? (
                <>
                  <Button variant="outline" className="w-full" disabled={pending || props.unlockBlocker !== null} onClick={() => { setReason(""); setConfirm("unlock"); }} data-testid="unlock">
                    <LockOpen /> {asks ? "Minta buka kembali" : "Buka kembali periode"}
                  </Button>
                  {props.unlockBlocker && <p className="text-sm text-muted-foreground">{props.unlockBlocker}</p>}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Hanya admin kantor yang dapat membuka kembali periode yang sudah ditutup.</p>
              )
            ) : (
              <Button className="w-full" disabled={pending || props.blockers.length > 0} onClick={() => setConfirm("lock")} data-testid="lock">
                {pending ? <Loader2 className="animate-spin" /> : <Lock />} Tutup buku {props.periodLabel}
              </Button>
            )}
          </CardContent>
        </Card>
        {props.unlocks.length > 0 && (
          <Card data-testid="unlock-history">
            <CardHeader>
              <CardTitle>Riwayat buka kembali</CardTitle>
              <CardDescription>Periode yang pernah dibuka setelah ditutup, terbaru di atas.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {props.unlocks.map((u, i) => (
                <div key={i} className="text-sm">
                  <div className="font-medium">{u.label}</div>
                  <div className="text-muted-foreground">{u.reason}</div>
                  <div className="text-xs text-muted-foreground">{u.by}</div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm === "lock" ? `Tutup buku ${props.periodLabel}?` : asks ? `Minta buka kembali ${props.periodLabel}?` : `Buka kembali ${props.periodLabel}?`}</DialogTitle>
            <DialogDescription>
              {confirm === "lock"
                ? `Setelah ditutup, impor mutasi, reklasifikasi dan jurnal ke ${props.periodLabel} ditolak sampai periodenya dibuka kembali. Catatan kontrol dan daftar periksa ikut tersimpan.${props.checklist?.open ? ` ${props.checklist.open} tugas checklist belum selesai; buku tetap bisa ditutup.` : ""}`
                : asks
                  ? `Admin lain mengonfirmasi sebelum ${props.periodLabel} dibuka. Sampai itu, buku tetap ditutup.`
                  : `Periode ${props.periodLabel} bisa diubah lagi. Laporan yang sudah dikirim ke klien bisa berbeda setelah ada perubahan.`}
            </DialogDescription>
          </DialogHeader>
          {confirm === "unlock" && (
            <Field>
              <FieldLabel htmlFor="unlock-reason">Alasan membuka kembali</FieldLabel>
              <Textarea id="unlock-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="mis. Faktur pajak Agustus terlambat masuk" rows={3} data-testid="unlock-reason" />
              <FieldDescription>Wajib diisi (min. 5 karakter). Alasan dan nama Anda tersimpan di riwayat.</FieldDescription>
            </Field>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>Batal</Button>
            <Button
              disabled={pending || (confirm === "unlock" && !reasonOk)}
              data-testid="confirm-lock"
              onClick={() => {
                const which = confirm;
                setConfirm(null);
                if (which === "lock") run(() => lockAction(clientId, year, month), `Buku ${props.periodLabel} ditutup`);
                else
                  run(
                    () => unlockAction(clientId, year, month, reason),
                    (r) => ("pending" in r && r.pending ? "Permintaan buka kembali dikirim" : "fallback" in r && r.fallback ? "Periode dibuka kembali tanpa konfirmasi kedua: hanya satu admin aktif" : "Periode dibuka kembali"),
                  );
              }}
            >
              {confirm === "lock" ? `Tutup buku ${props.periodLabel}` : asks ? "Minta buka kembali" : "Buka kembali"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(ackFor)} onOpenChange={(o) => !o && setAckFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Catatan: {ackFor?.title}</DialogTitle>
            <DialogDescription>{ackFor?.detail}. Jelaskan kenapa ini wajar. Catatan ikut tersimpan di arsip tutup buku.</DialogDescription>
          </DialogHeader>
          <Textarea aria-label="Catatan kontrol" value={note} onChange={(e) => setNote(e.target.value)} placeholder="mis. Transfer pinjaman pemilik, bukti di folder klien" rows={3} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAckFor(null)}>Batal</Button>
            <Button
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await ackControlAction(clientId, year, month, ackFor!.key, note);
                  if (!r.ok) return void toast.error(r.error);
                  setAckFor(null);
                  router.refresh();
                })
              }
            >
              Simpan catatan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
