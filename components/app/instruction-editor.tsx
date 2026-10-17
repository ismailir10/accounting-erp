"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AccountPicker } from "@/components/app/account-picker";
import { SimpleSelect } from "@/components/app/simple-select";
import { aiCompileInstructionAction, approveInstructionAction, compileInstructionAction, previewInstructionAction, type CompileResult, type ScopeAccountOption } from "@/app/instruction-actions";
import { KIND_LABEL, MAX_SENTENCE, PATTERNS_LINE, type DraftField, type DraftJson } from "@/lib/instructions/labels";
import { TAX_TAG_LABEL } from "@/lib/coa/template";
import { formatRupiah } from "@/lib/money";

/**
 * Instruksi kantor's editor (cycle 2026-10-18-instruksi-kantor): one sentence and its scope, *Susun*, then the preview as the approval
 * screen — every compiled field editable, the lines it would have matched, *Setujui* only for the preview of the fields as shown. Nothing
 * is stored until *Setujui*.
 */
type Ok = Extract<CompileResult, { ok: true }>;
const FOOTER = "Menyetujui tidak mengubah mutasi yang sudah dicatat. Aturan dan tahan berlaku untuk impor berikutnya; tandai berlaku untuk bulan yang belum dikunci.";
const DIRECTIONS = [{ value: "OUT", label: "Uang keluar" }, { value: "IN", label: "Uang masuk" }, { value: "", label: "Keduanya" }];
const TAXES = [{ value: "", label: "Tanpa pajak" }, ...Object.entries(TAX_TAG_LABEL).map(([value, label]) => ({ value, label }))];
const OPERATORS = [{ value: "above", label: "di atas" }, { value: "least", label: "minimal" }];
const grouped = (digits: string | null) => (digits ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".") : "");
/** The typed amount as the closed schema reads it: digits (dots allowed as thousands), empty = none, anything else as typed. */
const amountOf = (text: string) => {
  const t = text.trim().replace(/^rp\.?\s*/i, "").replace(/\./g, "");
  return t === "" ? null : t;
};

export function InstructionEditor({ scopes, aiAvailable }: { scopes: { value: string; label: string }[]; aiAvailable: boolean }) {
  const router = useRouter();
  const [sentence, setSentence] = useState("");
  const [scope, setScope] = useState(scopes[0]?.value ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; field?: DraftField } | null>(null);
  const [askAi, setAskAi] = useState(false);
  const [result, setResult] = useState<Ok | null>(null);
  const [fields, setFields] = useState<DraftJson | null>(null);
  const [amount, setAmount] = useState("");
  const [stale, setStale] = useState(false);
  const clientId = scope === "" ? null : scope;

  const show = (r: CompileResult) => {
    if (!r.ok) {
      setError({ text: r.error, field: r.field });
      setAskAi(Boolean(r.askAi));
      return;
    }
    setError(null);
    setAskAi(false);
    setResult(r);
    setFields(r.preview.draft);
    setAmount(grouped(r.preview.draft.minAmount));
    setStale(false);
  };
  const run = async (fn: () => Promise<CompileResult>) => {
    setBusy(true);
    try {
      show(await fn());
    } finally {
      setBusy(false);
    }
  };
  const compile = () => run(() => compileInstructionAction({ sentence, clientId }));
  const compileAi = () => run(() => aiCompileInstructionAction({ sentence, clientId }));
  const refresh = (next = fields) => next && result && run(() => previewInstructionAction({ clientId, fields: next, origin: result.origin }));
  const edit = (patch: Partial<DraftJson>) => {
    setFields((f) => (f ? { ...f, ...patch } : f));
    setStale(true);
    setError(null);
  };
  const reset = () => {
    setResult(null);
    setFields(null);
    setError(null);
    setAskAi(false);
    setStale(false);
  };
  const approve = async () => {
    if (!fields) return;
    setBusy(true);
    const r = await approveInstructionAction({ sentence, clientId, fields });
    setBusy(false);
    if (!r.ok) {
      setError({ text: r.error, field: r.field });
      return toast.error(r.error);
    }
    toast.success("Instruksi disetujui");
    reset();
    setSentence("");
    router.refresh();
  };
  const fieldError = (f: DraftField) => (error?.field === f ? error.text : undefined);

  return (
    <Card data-testid="instruction-editor">
      <CardHeader>
        <CardTitle>Instruksi baru</CardTitle>
        <CardDescription>Satu kalimat, satu instruksi. Buku menyusunnya; Anda memeriksa contohnya sebelum menyetujui.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid gap-4 md:grid-cols-[1fr_16rem]">
          <Field>
            <FieldLabel htmlFor="instruction-sentence">Instruksi</FieldLabel>
            <Input
              id="instruction-sentence"
              maxLength={MAX_SENTENCE}
              placeholder="mis. biaya admin bank selalu 6190"
              value={sentence}
              disabled={busy || !!result}
              aria-invalid={!!error && !error.field && !result}
              onChange={(e) => {
                setSentence(e.target.value);
                setError(null);
                setAskAi(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && sentence.trim() && !result) compile();
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="instruction-scope">Berlaku untuk</FieldLabel>
            <SimpleSelect id="instruction-scope" label="Berlaku untuk" value={scope} options={scopes} disabled={busy || !!result} onChange={setScope} />
          </Field>
        </div>
        {!result && (
          <div className="space-y-2">
            {error && <p className="text-sm text-destructive" data-testid="instruction-error">{error.text}</p>}
            <p className="text-xs text-muted-foreground" data-testid="instruction-patterns">{PATTERNS_LINE}</p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy || !sentence.trim()} onClick={compile}>Susun</Button>
              {askAi && aiAvailable && <Button variant="outline" disabled={busy} onClick={compileAi}>Susun dengan AI</Button>}
            </div>
          </div>
        )}
        {result && fields && (
          <Preview
            result={result}
            fields={fields}
            amount={amount}
            stale={stale}
            busy={busy}
            error={error}
            fieldError={fieldError}
            accounts={result.accounts}
            onEdit={edit}
            onAmount={(text) => {
              setAmount(text);
              edit({ minAmount: amountOf(text) });
            }}
            onHint={(pattern) => {
              const next = { ...fields, pattern };
              setFields(next);
              refresh(next);
            }}
            onRefresh={() => refresh(fields && { ...fields, minAmount: amountOf(amount) })}
            onApprove={approve}
            onCancel={reset}
          />
        )}
      </CardContent>
    </Card>
  );
}

function Preview(p: {
  result: Ok;
  fields: DraftJson;
  amount: string;
  stale: boolean;
  busy: boolean;
  error: { text: string; field?: DraftField } | null;
  fieldError: (f: DraftField) => string | undefined;
  accounts: ScopeAccountOption[];
  onEdit: (patch: Partial<DraftJson>) => void;
  onAmount: (text: string) => void;
  onHint: (pattern: string) => void;
  onRefresh: () => void;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const { preview, origin } = p.result;
  const f = p.fields;
  const blocked = preview.blocked;
  return (
    <section className="space-y-4 border-t pt-4" data-testid="instruction-preview">
      <div className="space-y-1">
        <p className="eyebrow">{KIND_LABEL[f.kind]} · {origin === "AI" ? "Disusun AI" : "Disusun Buku"}</p>
        <p className="text-base" data-testid="instruction-compiled">{p.stale ? "Isian diubah. Perbarui contoh untuk melihat hasilnya." : preview.sentence}</p>
        {origin === "AI" && <p className="text-review">Disusun AI — periksa setiap isian sebelum menyetujui.</p>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field>
          <FieldLabel htmlFor="instruction-pattern">Kata kunci</FieldLabel>
          <Input id="instruction-pattern" className="font-mono" value={f.pattern ?? ""} disabled={p.busy} aria-invalid={!!p.fieldError("pattern")} onChange={(e) => p.onEdit({ pattern: e.target.value || null })} />
          <FieldError>{p.fieldError("pattern")}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="instruction-direction">Arah</FieldLabel>
          <SimpleSelect id="instruction-direction" label="Arah" value={f.direction ?? ""} options={DIRECTIONS} disabled={p.busy} onChange={(v) => p.onEdit({ direction: v === "IN" || v === "OUT" ? v : null })} />
        </Field>
        {f.kind === "ACCOUNT" ? (
          <>
            <Field>
              <FieldLabel>Akun</FieldLabel>
              <AccountPicker ariaLabel="Akun" value={f.accountCode ?? ""} options={p.accounts} disabled={p.busy} onChange={(code) => p.onEdit({ accountCode: code || null })} />
              <FieldError>{p.fieldError("accountCode")}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="instruction-tax">Pajak</FieldLabel>
              <SimpleSelect id="instruction-tax" label="Pajak" value={f.taxTag ?? ""} options={TAXES} disabled={p.busy} onChange={(v) => p.onEdit({ taxTag: (v || null) as DraftJson["taxTag"] })} />
            </Field>
          </>
        ) : (
          <>
            <Field>
              <FieldLabel htmlFor="instruction-operator">Nominal</FieldLabel>
              <SimpleSelect id="instruction-operator" label="Di atas atau minimal" value={f.inclusive ? "least" : "above"} options={OPERATORS} disabled={p.busy} onChange={(v) => p.onEdit({ inclusive: v === "least" })} />
            </Field>
            <Field>
              <FieldLabel htmlFor="instruction-amount">Rp</FieldLabel>
              <Input id="instruction-amount" inputMode="numeric" className="num text-right" placeholder={f.kind === "HOLD" ? "Semua nominal" : ""} value={p.amount} disabled={p.busy} aria-invalid={!!p.fieldError("minAmount")} onChange={(e) => p.onAmount(e.target.value)} />
              <FieldError>{p.fieldError("minAmount")}</FieldError>
            </Field>
          </>
        )}
      </div>

      {p.stale ? (
        <Button variant="outline" size="sm" disabled={p.busy} onClick={p.onRefresh} data-testid="instruction-refresh">Perbarui contoh</Button>
      ) : (
        <>
          {preview.hints.length > 0 && (
            <div className="flex flex-wrap items-center gap-2" data-testid="instruction-hints">
              <span className="text-muted-foreground">Bank mungkin menulisnya:</span>
              {preview.hints.map((h) => (
                <Button key={h} variant="outline" size="xs" className="font-mono" disabled={p.busy} onClick={() => p.onHint(h)}>{h}</Button>
              ))}
            </div>
          )}
          {preview.notes.length > 0 && (
            <div className="space-y-1 text-muted-foreground" data-testid="instruction-notes">
              {preview.notes.map((n) => <p key={n}>{n}</p>)}
            </div>
          )}
          <Matched preview={preview} kind={f.kind} />
        </>
      )}
      {p.error && !p.error.field && <p className="text-destructive" data-testid="instruction-error">{p.error.text}</p>}
      {blocked && !p.stale && <p className="text-destructive" data-testid="instruction-blocked">{blocked}</p>}

      <div className="space-y-2 border-t pt-4">
        <p className="text-xs text-muted-foreground">{FOOTER}</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={p.busy || p.stale || !!blocked} onClick={p.onApprove} data-testid="instruction-approve">Setujui</Button>
          <Button variant="ghost" disabled={p.busy} onClick={p.onCancel}>Batal</Button>
        </div>
      </div>
    </section>
  );
}

function Matched({ preview, kind }: { preview: Ok["preview"]; kind: DraftJson["kind"] }) {
  if (!preview.matched) return null;
  const word = kind === "FLAG" ? "akan ditandai" : kind === "HOLD" ? "akan ditahan" : "cocok";
  return (
    <div className="space-y-3" data-testid="instruction-matched">
      <p className="eyebrow">Tiga bulan terakhir yang berisi mutasi: {preview.matched} baris {word}</p>
      <ul className="space-y-1">
        {preview.clients.filter((c) => c.total > 0).map((c) => (
          <li key={c.id} className="flex flex-wrap gap-x-3" data-testid="instruction-client-count">
            <span className="font-medium">{c.name}</span>
            {c.months.map((m) => <span key={m.label} className="text-muted-foreground">{m.label} <span className="num text-foreground">{m.count}</span></span>)}
          </li>
        ))}
      </ul>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tanggal</TableHead>
            <TableHead className="hidden md:table-cell">Klien</TableHead>
            <TableHead>Keterangan</TableHead>
            <TableHead className="text-right">Jumlah</TableHead>
            <TableHead className="hidden md:table-cell">Akun sekarang</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {preview.lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell className="whitespace-nowrap">{l.date.split("-").reverse().join("/")}</TableCell>
              <TableCell className="hidden md:table-cell">{l.client}</TableCell>
              <TableCell className="font-mono text-xs whitespace-normal break-all">{l.description}</TableCell>
              <TableCell className="num text-right whitespace-nowrap">{formatRupiah(BigInt(l.amount), { accounting: true })}</TableCell>
              <TableCell className="hidden md:table-cell">{l.status === "NEEDS_REVIEW" ? "di Review" : `${l.account ?? "dipecah"} · ${l.method}`}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {preview.matched > preview.lines.length && <p className="text-xs text-muted-foreground">{preview.lines.length} dari {preview.matched} baris ditampilkan.</p>}
    </div>
  );
}
