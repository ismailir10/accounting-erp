"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronRight, Circle, CircleCheck, Plus, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusPill } from "@/components/app/status";
import { ProgressFill } from "@/components/motion/progress-fill";
import { acceptChecklistAction, addChecklistTaskAction, markChecklistAction, removeChecklistTaskAction, updateChecklistTaskAction } from "@/app/actions";
import type { ChecklistKind } from "@/lib/generated/prisma/enums";

/** A member who may hold a task here, labelled "Rina · Akuntan"; `rank` orders the Pereviu choices (OWNER 3 > ADMIN 2 > AKUNTAN 1). */
export type PersonOption = { id: string; label: string; rank: number };

export type ChecklistRowView = {
  id: string;
  kind: ChecklistKind;
  title: string;
  eyebrow: string | null;
  /** "Pelaksana Rina · Pereviu Budi · Tenggat 10 Sep 2026" */
  people: string;
  late: string | null;
  waits: string | null;
  status: "BELUM" | "SELESAI" | "DIREVIU";
  finished: boolean;
  overdue: boolean;
  doneLine: string | null;
  proof: { ok: boolean; text: string; href: string; fix: string } | null;
  problem: string | null;
  done: boolean;
  canTick: boolean;
  canReview: boolean;
  canUndoReview: boolean;
  edit: { title: string; assigneeId: string; reviewerId: string | null; dueDay: number };
};

type Counts = { total: number; finished: number; awaitingReview: number; overdue: number };
type ProposalLine = { kind: "AUTO" | "SIGNOFF"; key: string; title: string; dueDay: number; reason: string };
type TaskDraft = { mode: "manual" | "auto" | "edit"; id?: string; kind?: ChecklistKind; key?: string; title: string; assigneeId: string; reviewerId: string | null; dueDay: string };

const NONE = "none";
const EYEBROW: Record<"AUTO" | "SIGNOFF", string> = { AUTO: "Otomatis", SIGNOFF: "Pemeriksaan akhir" };

export function ChecklistPanel(props: {
  clientId: string;
  year: number;
  month: number;
  periodLabel: string;
  locked: boolean;
  hasTemplate: boolean;
  rows: ChecklistRowView[];
  counts: Counts;
  proposal: ProposalLine[] | null;
  people: PersonOption[];
  me: { id: string; rank: number };
  canWrite: boolean;
  /** OWNER/ADMIN who may write now: *Pakai daftar ini*, *Atur checklist*. */
  manage: boolean;
  /** The Otomatis kinds not in this month's list. */
  autoKinds: { key: string; label: string; dueDay: number }[];
}) {
  const { clientId, year, month } = props;
  const router = useRouter();
  // An explicit busy flag, not useTransition: the refresh after each action must not hold the checkboxes (ui-rules).
  const [busy, setBusy] = useState(false);
  const [managing, setManaging] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const meOption = props.people.find((p) => p.id === props.me.id);
  const [acceptWho, setAcceptWho] = useState<{ assigneeId: string; reviewerId: string }>({ assigneeId: meOption?.id ?? props.people[0]?.id ?? "", reviewerId: NONE });

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, success?: string) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (!r.ok) {
      toast.error((r as { error: string }).error);
      return false;
    }
    if (success) toast.success(success);
    router.refresh();
    return true;
  };

  const rankOf = (id: string) => props.people.find((p) => p.id === id)?.rank ?? 0;
  /** Pereviu choices for a Pelaksana: another member ranked at least as high (the server checks the same). */
  const reviewers = (assigneeId: string) => props.people.filter((p) => p.id !== assigneeId && p.rank >= rankOf(assigneeId));
  const editable = props.hasTemplate && !props.locked;

  const groups = [
    { key: "late", title: "Lewat tenggat", rows: props.rows.filter((r) => !r.finished && r.overdue) },
    { key: "todo", title: "Belum", rows: props.rows.filter((r) => !r.finished && !r.overdue && r.status === "BELUM") },
    { key: "review", title: "Menunggu reviu", rows: props.rows.filter((r) => !r.finished && !r.overdue && r.status !== "BELUM") },
  ].filter((g) => g.rows.length);
  const finished = props.rows.filter((r) => r.finished);

  const statusPill = (r: ChecklistRowView) =>
    r.overdue ? <StatusPill status="REVIEW" label="Lewat tenggat" />
    : r.status === "DIREVIU" ? <StatusPill status="PASS" label="Direviu" />
    : r.finished ? <StatusPill status="PASS" label="Selesai" />
    : r.status === "SELESAI" ? <StatusPill status="REVIEW" label="Menunggu reviu" />
    : <span className="text-xs text-muted-foreground">Belum</span>;

  const row = (r: ChecklistRowView) => (
    <li key={r.id} className="flex flex-wrap items-start gap-3 px-6 py-3" data-testid="checklist-row" data-status={r.status}>
      {r.kind === "AUTO" || !props.canWrite ? (
        r.finished || r.done ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-pass" role="img" aria-label={r.kind === "AUTO" ? "Terbukti dari buku" : "Selesai"} />
        : <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" role="img" aria-label="Belum" />
      ) : (
        // Not wrapped in <label>: a wrapping label re-forwards the click and toggles twice (ui-rules).
        <Checkbox
          id={`task-${r.id}`}
          checked={r.done}
          disabled={busy || !r.canTick}
          onCheckedChange={(v) => run(() => markChecklistAction(clientId, year, month, r.id, "done", Boolean(v)))}
          className="mt-0.5"
        />
      )}
      <div className="min-w-0 flex-1 basis-60 space-y-0.5">
        {r.eyebrow && <div className="eyebrow">{r.eyebrow}</div>}
        {r.kind !== "AUTO" && props.canWrite ? (
          <label htmlFor={`task-${r.id}`} className="block text-sm font-medium">{r.title}</label>
        ) : (
          <div className="text-sm font-medium">{r.title}</div>
        )}
        <div className="text-xs text-muted-foreground">
          {r.people}
          {r.late && <span className="text-review"> · {r.late}</span>}
          {r.waits && <span className="text-review"> · {r.waits}</span>}
        </div>
        {r.proof && (
          <div className={`text-xs ${r.proof.ok ? "text-muted-foreground" : "text-foreground"}`} data-testid="checklist-proof">
            {r.proof.text} · <Link href={r.proof.href} className="drill">{r.proof.fix}</Link>
          </div>
        )}
        {r.doneLine && <div className="text-xs text-muted-foreground" data-testid="checklist-done-line">{r.doneLine}</div>}
        {r.problem && <div className="text-xs text-review" data-testid="checklist-problem">{r.problem}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {statusPill(r)}
        {r.canReview && <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => markChecklistAction(clientId, year, month, r.id, "review", true), "Ditandai direviu")}>Tandai direviu</Button>}
        {r.canUndoReview && <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => markChecklistAction(clientId, year, month, r.id, "review", false))}>Batalkan reviu</Button>}
        {managing && editable && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setDraft({ mode: "edit", id: r.id, kind: r.kind, title: r.edit.title, assigneeId: r.edit.assigneeId, reviewerId: r.edit.reviewerId, dueDay: String(r.edit.dueDay) })}>Ubah</Button>
        )}
      </div>
    </li>
  );

  const saveDraft = async () => {
    if (!draft) return;
    const dueDay = Number(draft.dueDay);
    const ok = draft.mode === "edit"
      ? await run(() => updateChecklistTaskAction(clientId, year, month, draft.id!, { title: draft.title, assigneeId: draft.assigneeId, reviewerId: draft.reviewerId, dueDay }), "Tugas disimpan")
      : await run(() => addChecklistTaskAction(clientId, year, month, draft.mode === "auto"
        ? { kind: "AUTO", key: draft.key, assigneeId: draft.assigneeId, reviewerId: null, dueDay }
        : { kind: "MANUAL", title: draft.title, assigneeId: draft.assigneeId, reviewerId: draft.reviewerId, dueDay }), "Tugas ditambahkan");
    if (ok) setDraft(null);
  };
  const reviewerless = draft?.mode === "auto" || draft?.kind === "AUTO";
  const assigneeChoices = props.manage ? props.people : props.people.filter((p) => p.id === props.me.id);

  return (
    <div className="space-y-4">
      {props.proposal && (
        <Card data-testid="checklist-proposal">
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Usulan checklist {props.periodLabel}</CardTitle>
              <CardDescription>Disusun Buku dari yang dipakai klien ini. Tugas otomatis yang tidak dipakai bisa ditambahkan nanti.</CardDescription>
            </div>
            {props.manage && !props.locked && props.people.length > 0 && <Button onClick={() => setAccepting(true)} data-testid="checklist-accept">Pakai daftar ini</Button>}
          </CardHeader>
          <CardContent className="px-0">
            <ul className="divide-y border-t">
              {props.proposal.map((l) => (
                <li key={l.key} className="flex flex-wrap items-start gap-3 px-6 py-3" data-testid="proposal-line">
                  <div className="min-w-0 flex-1 basis-60">
                    <div className="eyebrow">{EYEBROW[l.kind]}</div>
                    <div className="text-sm font-medium">{l.title}</div>
                    <div className="text-xs text-muted-foreground">{l.reason}</div>
                  </div>
                  <span className="text-xs text-muted-foreground">Tenggat tanggal {l.dueDay}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {props.hasTemplate && (props.rows.length > 0 || editable) && (
        <Card data-testid="checklist">
          <CardHeader className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Tugas {props.periodLabel}</CardTitle>
              {props.canWrite && editable && (
                <div className="flex flex-wrap gap-2">
                  {managing && props.autoKinds.length > 0 && (
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => setDraft({ mode: "auto", key: props.autoKinds[0].key, title: "", assigneeId: props.me.id, reviewerId: null, dueDay: String(props.autoKinds[0].dueDay) })} data-testid="checklist-add-auto">
                      <Plus /> Tambah tugas otomatis
                    </Button>
                  )}
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => setDraft({ mode: "manual", title: "", assigneeId: props.me.id, reviewerId: null, dueDay: "10" })} data-testid="checklist-add">
                    <Plus /> Tambah tugas
                  </Button>
                  {props.manage && (
                    <Button variant="outline" size="sm" onClick={() => setManaging((m) => !m)} aria-pressed={managing} data-testid="checklist-manage">
                      <Settings2 /> {managing ? "Selesai mengatur" : "Atur checklist"}
                    </Button>
                  )}
                </div>
              )}
            </div>
            {props.counts.total > 0 && (
              <div className="space-y-2">
                <p className="text-sm" data-testid="checklist-summary">
                  {[`${props.counts.finished} / ${props.counts.total} selesai`, props.counts.awaitingReview ? `${props.counts.awaitingReview} menunggu reviu` : "", props.counts.overdue ? `${props.counts.overdue} lewat tenggat` : ""].filter(Boolean).join(" · ")}
                </p>
                <ProgressFill value={(props.counts.finished / props.counts.total) * 100} aria-label={`${props.counts.finished} dari ${props.counts.total} tugas selesai`} />
              </div>
            )}
          </CardHeader>
          <CardContent className="px-0">
            {groups.map((g) => (
              <section key={g.key} aria-label={g.title} className="border-t">
                <h3 className="eyebrow px-6 pt-3">{g.title} · {g.rows.length}</h3>
                <ul className="divide-y">{g.rows.map(row)}</ul>
              </section>
            ))}
            {finished.length > 0 && (
              <details className="group/done border-t" data-testid="checklist-finished">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-6 py-3 text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-4 transition-transform group-open/done:rotate-90" aria-hidden />
                  {finished.length} tugas selesai
                </summary>
                <ul className="divide-y border-t">{finished.map(row)}</ul>
              </details>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={accepting} onOpenChange={(o) => !o && setAccepting(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pakai daftar ini mulai {props.periodLabel}?</DialogTitle>
            <DialogDescription>Satu Pelaksana dan satu Pereviu untuk semua tugas; tiap tugas bisa diubah sesudahnya. Bulan sebelumnya tidak ikut.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="accept-assignee">Pelaksana</FieldLabel>
            <Select value={acceptWho.assigneeId} onValueChange={(v) => setAcceptWho({ assigneeId: String(v), reviewerId: NONE })}>
              <SelectTrigger id="accept-assignee" aria-label="Pelaksana" className="w-full"><SelectValue>{props.people.find((p) => p.id === acceptWho.assigneeId)?.label}</SelectValue></SelectTrigger>
              <SelectContent>{props.people.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="accept-reviewer">Pereviu</FieldLabel>
            <Select value={acceptWho.reviewerId} onValueChange={(v) => setAcceptWho((w) => ({ ...w, reviewerId: String(v) }))}>
              <SelectTrigger id="accept-reviewer" aria-label="Pereviu" className="w-full"><SelectValue>{props.people.find((p) => p.id === acceptWho.reviewerId)?.label ?? "Tanpa Pereviu"}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Tanpa Pereviu</SelectItem>
                {reviewers(acceptWho.assigneeId).map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <FieldDescription>Tugas otomatis tidak direviu: buktinya dari buku.</FieldDescription>
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAccepting(false)}>Batal</Button>
            <Button disabled={busy || !acceptWho.assigneeId} data-testid="checklist-accept-confirm" onClick={async () => {
              if (await run(() => acceptChecklistAction(clientId, year, month, acceptWho.assigneeId, acceptWho.reviewerId === NONE ? null : acceptWho.reviewerId), "Checklist dipakai")) setAccepting(false);
            }}>Pakai daftar ini</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.mode === "edit" ? "Ubah tugas" : draft?.mode === "auto" ? "Tambah tugas otomatis" : "Tambah tugas"}</DialogTitle>
            <DialogDescription>
              {draft?.mode === "edit" ? "Perubahan berlaku di setiap bulan tugas ini. Centang yang sudah diberikan tetap atas nama pemberinya." : `Berlaku mulai ${props.periodLabel}.`}
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-4">
              {draft.mode === "auto" ? (
                <Field>
                  <FieldLabel htmlFor="task-auto-kind">Jenis</FieldLabel>
                  <Select value={draft.key} onValueChange={(v) => setDraft({ ...draft, key: String(v), dueDay: String(props.autoKinds.find((k) => k.key === v)?.dueDay ?? 10) })}>
                    <SelectTrigger id="task-auto-kind" aria-label="Jenis" className="w-full"><SelectValue>{props.autoKinds.find((k) => k.key === draft.key)?.label}</SelectValue></SelectTrigger>
                    <SelectContent>{props.autoKinds.map((k) => <SelectItem key={k.key} value={k.key}>{k.label}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
              ) : (
                <Field>
                  <FieldLabel htmlFor="task-title">Nama tugas</FieldLabel>
                  <Input id="task-title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="mis. Unggah SPT Masa ke Coretax" maxLength={200} />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="task-assignee">Pelaksana</FieldLabel>
                <Select value={draft.assigneeId} onValueChange={(v) => setDraft({ ...draft, assigneeId: String(v), reviewerId: draft.reviewerId && reviewers(String(v)).some((p) => p.id === draft.reviewerId) ? draft.reviewerId : null })} disabled={!props.manage}>
                  <SelectTrigger id="task-assignee" aria-label="Pelaksana" className="w-full"><SelectValue>{props.people.find((p) => p.id === draft.assigneeId)?.label ?? "Pilih"}</SelectValue></SelectTrigger>
                  <SelectContent>{assigneeChoices.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}</SelectContent>
                </Select>
                {!props.manage && <FieldDescription>Tugas yang Anda tambahkan dikerjakan oleh Anda sendiri.</FieldDescription>}
              </Field>
              {!reviewerless && (
                <Field>
                  <FieldLabel htmlFor="task-reviewer">Pereviu</FieldLabel>
                  <Select value={draft.reviewerId ?? NONE} onValueChange={(v) => setDraft({ ...draft, reviewerId: v === NONE ? null : String(v) })}>
                    <SelectTrigger id="task-reviewer" aria-label="Pereviu" className="w-full"><SelectValue>{props.people.find((p) => p.id === draft.reviewerId)?.label ?? "Tanpa Pereviu"}</SelectValue></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Tanpa Pereviu</SelectItem>
                      {reviewers(draft.assigneeId).map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FieldDescription>Orang lain dengan peran setara atau lebih tinggi dari Pelaksana.</FieldDescription>
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="task-due">Tanggal tenggat</FieldLabel>
                <Input id="task-due" type="number" min={1} max={28} inputMode="numeric" value={draft.dueDay} onChange={(e) => setDraft({ ...draft, dueDay: e.target.value })} className="w-24" />
                <FieldDescription>Tanggal 1–28 di bulan setelah periode (tanggal 10 untuk {props.periodLabel} jatuh di bulan berikutnya).</FieldDescription>
              </Field>
              {draft.mode === "edit" && (
                <div className="space-y-1 border-t pt-4">
                  <Button variant="ghost" size="sm" className="text-fail" disabled={busy} data-testid="checklist-remove" onClick={async () => {
                    if (await run(() => removeChecklistTaskAction(clientId, year, month, draft.id!), "Tugas dihapus dari checklist")) setDraft(null);
                  }}>Hapus dari checklist</Button>
                  <p className="text-xs text-muted-foreground">Bulan sebelumnya tetap menyimpan tugas ini.</p>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>Batal</Button>
            <Button disabled={busy || !draft?.assigneeId} onClick={saveDraft} data-testid="checklist-save">{draft?.mode === "edit" ? "Simpan" : "Tambah"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
