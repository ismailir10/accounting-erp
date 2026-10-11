"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { StatusPill } from "@/components/app/status";
import { clearAiKeyAction, listModelsAction, saveAiSettingsAction } from "@/app/settings-actions";

type Source = "pengaturan" | "env" | null;
type Status = {
  live: boolean;
  keyLast4: string | null;
  keySource: Source;
  model: string | null;
  modelSource: Source;
  gatewayHost: string;
  maxCallsPerRun: number;
  /** Tokens used this calendar month by every organisation together (logged + reserved). */
  monthlyTokensUsed: number;
  /** The monthly cap of an organisation without its own (AI_MONTHLY_TOKEN_BUDGET); each organisation's is set on its page. */
  defaultTokenBudget: number;
  /** Most recent real AI call, the only proof the key works (the model list is public). */
  lastCall: { at: string; ok: boolean; model: string; note: string | null } | null;
};

const SOURCE_LABEL: Record<"pengaturan" | "env", string> = { pengaturan: "disimpan di sini", env: "dari environment variable" };

/** Buku's AI provider (backoffice only, ADR 0017 §6). Organisations see AiStatusCard instead. */
export function AiSettingsForm({ status, canSave }: { status: Status; canSave: boolean }) {
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(status.model ?? "");
  const [models, setModels] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<null | "save" | "list" | "clear">(null);

  async function run<T>(kind: "save" | "list" | "clear", fn: () => Promise<({ ok: true } & T) | { ok: false; error: string }>, onOk: (r: T) => void) {
    setBusy(kind);
    try {
      const r = await fn();
      if (r.ok) onOk(r);
      else toast.error(r.error);
    } finally {
      setBusy(null);
    }
  }

  const disabled = !canSave || busy !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI untuk usulan akun</CardTitle>
        <CardDescription>
          Satu kunci untuk semua organisasi; dipakai hanya untuk mutasi yang belum dikenali aturan atau memori. Maks. {status.maxCallsPerRun} panggilan
          per proses. Bulan ini terpakai <span data-testid="ai-monthly-use">{status.monthlyTokensUsed.toLocaleString("id-ID")} token</span> di semua organisasi;
          batas bawaan {status.defaultTokenBudget.toLocaleString("id-ID")} token per organisasi per bulan. Tanpa kunci, Buku tetap jalan dengan aturan saja.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Status</dt>
            <dd className="mt-1">
              <StatusPill status={status.live ? "PASS" : "REVIEW"} label={status.live ? "Aktif" : "Aturan saja"} />
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Kunci API</dt>
            <dd className="mt-1 font-medium">
              {status.keyLast4 ? <span className="num">••••{status.keyLast4}</span> : "Belum ada"}
              {status.keySource && <span className="block text-xs font-normal text-muted-foreground">{SOURCE_LABEL[status.keySource]}</span>}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Model</dt>
            <dd className="mt-1 font-medium break-all">
              {status.model ?? "Belum dipilih"}
              {status.modelSource && <span className="block text-xs font-normal text-muted-foreground">{SOURCE_LABEL[status.modelSource]}</span>}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Panggilan terakhir</dt>
            <dd className="mt-1">
              {status.lastCall ? (
                <>
                  <StatusPill status={status.lastCall.ok ? "PASS" : "FAIL"} label={status.lastCall.ok ? "Berhasil" : "Gagal"} />
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {status.lastCall.at}
                    {!status.lastCall.ok && status.lastCall.note ? ` · ${status.lastCall.note}` : ` · ${status.lastCall.model}`}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">Belum ada. Kunci diuji saat impor pertama yang butuh AI.</span>
              )}
            </dd>
          </div>
        </dl>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="ai-key">Kunci API baru</FieldLabel>
            <Input
              id="ai-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={status.keyLast4 ? `Kosongkan untuk tetap memakai ••••${status.keyLast4}` : "Tempel kunci dari opencode.ai"}
              disabled={!canSave}
            />
            <FieldDescription>Disimpan terenkripsi dan tidak pernah ditampilkan lagi.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="ai-model">Model</FieldLabel>
            <Input id="ai-model" list="ai-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Ketik atau pilih dari daftar" disabled={!canSave} />
            <datalist id="ai-models">{models?.map((m) => <option key={m} value={m} />)}</datalist>
            <FieldDescription>
              {models ? `${models.length} model tersedia di ${status.gatewayHost}.` : (
                <button
                  type="button"
                  className="text-primary hover:underline disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => run("list", () => listModelsAction(), ({ models: list }) => setModels(list))}
                >
                  {busy === "list" ? "Memuat…" : `Muat daftar model dari ${status.gatewayHost}`}
                </button>
              )}
            </FieldDescription>
          </Field>
        </div>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2 border-t pt-4">
        <Button
          disabled={disabled || !model.trim() || (!apiKey.trim() && !status.keyLast4)}
          onClick={() =>
            run("save", () => saveAiSettingsAction({ apiKey, model }), () => {
              toast.success("Pengaturan AI tersimpan");
              setApiKey("");
              router.refresh();
            })
          }
        >
          {busy === "save" ? "Menyimpan…" : "Simpan"}
        </Button>
        {status.keySource === "pengaturan" && (
          <Button
            variant="ghost"
            className="ml-auto"
            disabled={disabled}
            onClick={() =>
              run("clear", () => clearAiKeyAction(), () => {
                toast.success("Kunci dihapus");
                router.refresh();
              })
            }
          >
            {busy === "clear" ? "Menghapus…" : "Hapus kunci"}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
