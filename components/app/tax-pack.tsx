"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download, Plus } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SimpleSelect } from "@/components/app/simple-select";
import { Money } from "@/components/app/money";
import { acceptSuggestionAction, addCorrectionAction, addCreditAction, deleteCorrectionAction, deleteCreditAction, deleteLossAction, dismissSuggestionAction, postTaxAction, setCorrectionPercentAction, setLossAction, setInstalmentAction, setRegimeAction, setTaxMonthAction } from "@/app/actions";
import { formatMoney } from "@/lib/money";
import type { TaxPackView } from "@/lib/tax/view";

type Account = { code: string; name: string };
type Result = { ok: true } | { ok: false; error: string };

const KIND = { PERMANENT: "beda tetap", TEMPORARY: "beda waktu" } as const;
const CREDIT = { PPH_25: "PPh 25", PPH_22: "PPh 22", PPH_23: "PPh 23", PPH_24: "PPh 24", OTHER: "Lainnya" } as const;

/** The PPh badan pack of one entity-year (accounting-rules 5d). Every figure is an estimate for the working papers, never an SPT. */
export function TaxPackPanel(props: { clientId: string; periodKey: string; periodLabel: string; view: TaxPackView; accounts: { pl: Account[]; credit: Account[] } }) {
  const router = useRouter();
  const v = props.view;
  const cur = v.entity.functionalCurrency;
  const base = `/clients/${props.clientId}`;
  const scope = { clientId: props.clientId, entityId: v.entity.id, year: v.year };
  const [busy, setBusy] = useState(false);
  const [percents, setPercents] = useState<Record<string, string>>({});
  const [loss, setLoss] = useState<{ originYear: string; amount: string } | null>(null);
  const [correction, setCorrection] = useState<{ description: string; direction: "POSITIVE" | "NEGATIVE"; kind: "PERMANENT" | "TEMPORARY"; amount: string; accountCode: string } | null>(null);
  const [credit, setCredit] = useState<{ type: "PPH_22" | "PPH_23" | "PPH_24" | "OTHER"; reference: string; date: string; amount: string; accountCode: string } | null>(null);
  const final = v.regime === "FINAL_UMKM";

  const run = async (action: () => Promise<Result>, done: string, after?: () => void) => {
    setBusy(true);
    const r = await action();
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(done);
    after?.();
    router.refresh();
  };
  const ledger = (code: string, month = props.periodKey) => `${base}/ledger/${code}?entity=${v.entity.id}&period=${month}`;
  const row = (label: React.ReactNode, amount: string, opts: { strong?: boolean; sign?: -1 | 1; testid?: string; muted?: boolean } = {}) => (
    <div className={`flex items-baseline justify-between gap-4 py-1.5 ${opts.strong ? "border-t font-medium" : ""}`} data-testid={opts.testid}>
      <div className={`min-w-0 ${opts.muted ? "text-muted-foreground" : ""}`}>{label}</div>
      <Money className="shrink-0" strong={opts.strong} value={BigInt(amount) * BigInt(opts.sign ?? 1)} currency={cur} />
    </div>
  );
  const correctionRows = (direction: "POSITIVE" | "NEGATIVE") =>
    v.corrections.filter((c) => c.direction === direction).map((c) => (
      <div key={c.key} className="flex items-baseline justify-between gap-4 py-1 pl-4 text-sm" data-testid={`correction-${c.key}`}>
        <div className="min-w-0">
          {c.label} <span className="text-xs text-muted-foreground">· {KIND[c.kind]}</span>
          {c.source.type === "ASSETS" && <Link href={`${base}/assets?period=${props.periodKey}&entity=${v.entity.id}`} className="ml-2 text-xs text-primary underline-offset-2 hover:underline">Aset Tetap</Link>}
          {c.source.type === "LEASES" && <Link href={`${base}/leases?period=${props.periodKey}&entity=${v.entity.id}`} className="ml-2 text-xs text-primary underline-offset-2 hover:underline">Sewa</Link>}
          {c.source.type === "ACCOUNT" && <Link href={ledger(c.source.code)} className="ml-2 text-xs text-primary underline-offset-2 hover:underline">{c.source.code}</Link>}
          {c.source.type === "MANUAL" && c.source.code && <Link href={ledger(c.source.code)} className="ml-2 text-xs text-primary underline-offset-2 hover:underline">{c.source.code}</Link>}
          {c.source.type === "MANUAL" && c.source.percent !== null && (
            <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
              ×
              <Input
                aria-label={`Persentase ${c.label}`}
                inputMode="numeric"
                className="h-6 w-12 px-1 text-right text-xs"
                defaultValue={String(c.source.percent)}
                onBlur={(e) => {
                  const pct = Number(e.target.value);
                  const src = c.source as { id: string; percent: number };
                  if (pct !== src.percent) run(() => setCorrectionPercentAction(props.clientId, src.id, pct), "Persentase koreksi diubah");
                }}
              />
              %
            </span>
          )}
          {c.source.type === "MANUAL" && (
            <Button variant="ghost" size="sm" className="ml-1 h-6 px-2 text-xs" disabled={busy} onClick={() => run(() => deleteCorrectionAction(props.clientId, (c.source as { id: string }).id), "Koreksi dihapus")}>Hapus</Button>
          )}
        </div>
        <Money className="shrink-0" value={BigInt(c.amount) * (direction === "NEGATIVE" ? -1n : 1n)} currency={cur} />
      </div>
    ));

  const proposal = (kind: "CURRENT" | "DEFERRED", title: string, hint: string) => {
    const lines = v.proposals[kind];
    return (
      <Card data-testid={`proposal-${kind}`}>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{hint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {v.laterPosting[kind] ? (
            <p className="text-muted-foreground">Jurnal ini sudah dicatat per {v.laterPosting[kind]}; posisinya dibukukan di sana. Buka bulan itu atau sesudahnya untuk mencatat perubahan.</p>
          ) : lines.length === 0 ? (
            <p className="text-muted-foreground">Sudah sesuai estimasi; tidak ada yang perlu dijurnal.</p>
          ) : (
            <>
              <div className="rounded-md border">
                {lines.map((l) => (
                  <div key={l.code} className="flex items-baseline justify-between gap-4 border-b px-3 py-1.5 last:border-b-0">
                    <span className="min-w-0">{l.code} {v.accountNames[l.code]}</span>
                    <span className="num shrink-0">{BigInt(l.amount) > 0n ? "Debit " : "Kredit "}{formatMoney(BigInt(l.amount) < 0n ? -BigInt(l.amount) : BigInt(l.amount), cur, { bare: true })}</span>
                  </div>
                ))}
              </div>
              <Button disabled={busy} onClick={() => run(() => postTaxAction({ ...scope, month: v.month, kind }), kind === "CURRENT" ? (final ? "Jurnal PPh final dicatat" : "Jurnal PPh badan dicatat") : "Jurnal pajak tangguhan dicatat")}>
                Catat jurnal per {props.periodLabel}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field className="w-72">
          <FieldLabel>Skema PPh badan {v.year}</FieldLabel>
          <SimpleSelect label="Skema PPh badan" value={v.regime} disabled={busy} onChange={(r) => run(() => setRegimeAction({ ...scope, regime: r as "NORMAL" | "FINAL_UMKM" }), "Skema diganti")} options={[{ value: "NORMAL", label: "Normal (Pasal 17 & 31E)" }, { value: "FINAL_UMKM", label: "PP 55/2022 final 0,5%" }]} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <a href={`${base}/tax/export?entity=${v.entity.id}&period=${props.periodKey}`} className={buttonVariants({ variant: "outline", size: "sm" })} download data-testid="tax-download"><Download /> Unduh kertas kerja</a>
          {!final && (
            <>
            <Button variant="outline" size="sm" onClick={() => setCorrection({ description: "", direction: "POSITIVE", kind: "PERMANENT", amount: "", accountCode: "" })}><Plus /> Koreksi fiskal</Button>
            <Button variant="outline" size="sm" onClick={() => setCredit({ type: "PPH_23", reference: "", date: `${v.year}-${props.periodKey.slice(5)}-01`, amount: "", accountCode: props.accounts.credit.some((a) => a.code === "1180") ? "1180" : (props.accounts.credit[0]?.code ?? "") })}><Plus /> Kredit pajak</Button>
            </>
          )}
        </div>
      </div>

      {v.suggestions.length > 0 && !final && (
        <Card data-testid="tax-suggestions">
          <CardHeader>
            <CardTitle>Usulan koreksi fiskal</CardTitle>
            <CardDescription>Akun yang namanya menunjukkan koreksi fiskal (Pasal 9 UU PPh, beda waktu). Terima dengan persentasenya untuk menambahkannya sebagai koreksi yang mengikuti saldo akun, atau abaikan.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y px-0">
            {v.suggestions.map((sg) => (
              <div key={sg.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2.5">
                <div className="min-w-0 flex-1 basis-56 text-sm">
                  <Link href={ledger(sg.code)} className="hover:text-primary">{sg.code} {sg.name}</Link>
                  <div className="text-xs text-muted-foreground">{sg.label} · {sg.direction === "POSITIVE" ? "positif" : "negatif"} · {KIND[sg.kind]}</div>
                </div>
                <Money className="text-sm" value={BigInt(sg.amount)} currency={cur} />
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  ×
                  <Input aria-label={`Persentase ${sg.name}`} inputMode="numeric" className="h-7 w-14 px-1 text-right text-xs" value={percents[sg.key] ?? String(sg.percent)} onChange={(e) => setPercents({ ...percents, [sg.key]: e.target.value.replace(/\D/g, "") })} />
                  %
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => acceptSuggestionAction({ ...scope, month: v.month, accountCode: sg.code, percent: Number(percents[sg.key] ?? sg.percent) }), "Koreksi ditambahkan")}>Terima</Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => dismissSuggestionAction({ ...scope, key: sg.key }), "Usulan diabaikan")}>Abaikan</Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card data-testid="tax-statement">
        <CardHeader>
          <CardTitle>{final ? `PPh final ${v.year}` : `Rekonsiliasi fiskal ${v.year}`} · s.d. {props.periodLabel}</CardTitle>
          <CardDescription>Estimasi dari buku besar untuk kertas kerja, bukan SPT. Tahun pajak = tahun kalender.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          {final ? (
            <>
              {row(<Link href={`${base}/reports?period=${props.periodKey}&entity=${v.entity.id}`} className="hover:text-primary">Peredaran bruto (pendapatan usaha)</Link>, v.turnover)}
              {row("PPh final 0,5% (PP 55/2022)", v.tax.due, { strong: true, testid: "tax-due" })}
              {BigInt(v.finalWithheld) > 0n && row("Dipotong pelanggan (PPh 4(2), sudah di 8200): tidak disetor lagi", v.finalWithheld, { muted: true, sign: -1 })}
              <p className="pt-2 text-xs text-muted-foreground">PPh final dihitung dari peredaran bruto; jurnalnya di bawah membebankan 8200 dan setoran bulanan melunasi utangnya (2145). Buku tidak menilai syarat PP 55/2022: peredaran bruto paling banyak Rp 4,8 M setahun, dan jangka waktu paling lama 3 tahun pajak untuk PT, 4 tahun untuk CV, firma dan koperasi, 7 tahun untuk orang pribadi (Pasal 59).</p>
            </>
          ) : (
            <>
              {row(<Link href={`${base}/reports?period=${props.periodKey}&entity=${v.entity.id}`} className="hover:text-primary">Laba sebelum pajak (komersial)</Link>, v.profitBeforeTax, { testid: "tax-pbt" })}
              <div className="py-1 text-muted-foreground">Koreksi fiskal positif</div>
              {correctionRows("POSITIVE")}
              {v.corrections.every((c) => c.direction !== "POSITIVE") && <div className="py-1 pl-4 text-muted-foreground">Tidak ada</div>}
              <div className="py-1 text-muted-foreground">Koreksi fiskal negatif</div>
              {correctionRows("NEGATIVE")}
              {v.corrections.every((c) => c.direction !== "NEGATIVE") && <div className="py-1 pl-4 text-muted-foreground">Tidak ada</div>}
              {row("Laba (rugi) fiskal", v.fiscalProfit, { strong: true })}
              <div className="flex items-baseline justify-between gap-4 py-1 text-muted-foreground">
                <span>Kompensasi kerugian</span>
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setLoss({ originYear: String(v.year - 1), amount: "" })}><Plus /> Rugi fiskal</Button>
              </div>
              {v.losses.length === 0 && <div className="py-1 pl-4 text-muted-foreground">Belum ada sisa rugi fiskal tahun lalu</div>}
              {v.losses.map((l) => (
                <div key={l.originYear} className="flex items-baseline justify-between gap-4 py-1 pl-4" data-testid={`loss-${l.originYear}`}>
                  <div className="min-w-0">
                    Rugi {l.originYear} <span className="text-xs text-muted-foreground">· sisa awal {formatMoney(BigInt(l.opening), cur)} · {l.expired ? `kedaluwarsa (berlaku s.d. ${l.expiresAfter})` : `berlaku s.d. ${l.expiresAfter}, sisa akhir ${formatMoney(BigInt(l.remaining), cur)}`}</span>
                    {l.id && <Button variant="ghost" size="sm" className="ml-1 h-6 px-2 text-xs" disabled={busy} onClick={() => run(() => deleteLossAction(props.clientId, l.id!), "Rugi fiskal dihapus")}>Hapus</Button>}
                  </div>
                  <Money className="shrink-0" value={-BigInt(l.used)} currency={cur} />
                </div>
              ))}
              {v.lossSuggestion && (
                <div className="my-1 flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2 text-xs" data-testid="loss-suggestion">
                  <span>Buku mencatat rugi fiskal {v.lossSuggestion.originYear} sebesar {formatMoney(BigInt(v.lossSuggestion.amount), cur)}. Catat sebagai sisa rugi bila belum dikompensasikan.</span>
                  <span className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => setLossAction({ ...scope, originYear: v.lossSuggestion!.originYear, amount: formatMoney(BigInt(v.lossSuggestion!.amount), cur, { bare: true }) }), "Rugi fiskal dicatat")}>Catat</Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => dismissSuggestionAction({ ...scope, key: `loss:${v.lossSuggestion!.originYear}` }), "Usulan diabaikan")}>Abaikan</Button>
                  </span>
                </div>
              )}
              {row("Penghasilan kena pajak (dibulatkan ke bawah ribuan)", v.tax.pkp, { testid: "tax-pkp" })}
              {BigInt(v.fiscalProfit) < 0n && <p className="pb-1 text-xs text-muted-foreground">Rugi fiskal: PKP nol. Kompensasi kerugian tahun lalu belum dihitung di sini.</p>}
              {row("Peredaran bruto (pendapatan usaha)", v.turnover, { muted: true })}
              {v.months < 12 && row(`Peredaran bruto disetahunkan (× 12 ÷ ${v.months} bulan), dasar Pasal 31E`, v.annualTurnover, { muted: true, testid: "tax-annual-turnover" })}
              {BigInt(v.tax.facilityPkp) > 0n && row(`PKP fasilitas Pasal 31E ${formatMoney(BigInt(v.tax.facilityPkp), cur)} × 11%`, v.tax.facilityTax)}
              {BigInt(v.tax.regularPkp) > 0n && row(`PKP lainnya ${formatMoney(BigInt(v.tax.regularPkp), cur)} × 22%`, v.tax.regularTax)}
              {row("PPh badan terutang", v.tax.due, { strong: true, testid: "tax-due" })}
              <div className="py-1 text-muted-foreground">Kredit pajak</div>
              {v.credits.length === 0 && <div className="py-1 pl-4 text-muted-foreground">Belum ada PPh 25 atau bukti potong tahun ini</div>}
              {v.credits.map((c) => (
                <div key={c.key} className="flex items-baseline justify-between gap-4 py-1 pl-4" data-testid={`credit-${c.type}`}>
                  <div className="min-w-0">
                    {CREDIT[c.type]} · <Link href={ledger(c.accountCode, c.month)} className="hover:text-primary">{c.date}</Link> <span className="text-xs text-muted-foreground">{c.label} · {c.accountCode}</span>
                    {c.source.type === "MANUAL" && <Button variant="ghost" size="sm" className="ml-1 h-6 px-2 text-xs" disabled={busy} onClick={() => run(() => deleteCreditAction(props.clientId, (c.source as { id: string }).id), "Kredit pajak dihapus")}>Hapus</Button>}
                    {c.type === "PPH_25" && c.source.type === "BANK" && (
                      <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                        Masa pajak
                        <Input type="month" aria-label={`Masa pajak ${c.label}`} className="h-6 w-36 px-2 text-xs" disabled={busy} defaultValue={c.masa ?? ""} key={`${c.key}:${c.masa}`} onChange={(e) => { const value = e.target.value; const id = (c.source as { bankTransactionId: string }).bankTransactionId; if (/^\d{4}-\d{2}$/.test(value)) void run(() => setTaxMonthAction(props.clientId, id, value), "Masa pajak diubah"); }} />
                        {!c.masa && "belum diisi: dihitung dari tanggal bayar"}
                      </span>
                    )}
                  </div>
                  <Money className="shrink-0" value={-BigInt(c.amount)} currency={cur} />
                </div>
              ))}
              {v.settlement && row(BigInt(v.settlement.balance) >= 0n ? "PPh Pasal 29 kurang bayar" : "PPh Pasal 28A lebih bayar", BigInt(v.settlement.balance) < 0n ? (-BigInt(v.settlement.balance)).toString() : v.settlement.balance, { strong: true, testid: "tax-balance" })}
              {v.settlement && row(v.months < 12 ? "Angsuran PPh 25 tahun berikutnya per bulan (proyeksi setahun)" : "Angsuran PPh 25 tahun berikutnya per bulan", v.settlement.nextInstalment, { muted: true, testid: "tax-next" })}
              {v.settlement && v.month === 12 && BigInt(v.settlement.nextInstalment) > 0n && (
                // The year's SPT sets next year's PPh 25 from the masa it is filed (by April): one click puts it on Pajak Masa.
                <div className="flex flex-wrap items-center gap-2 pb-1 pl-4 text-xs text-muted-foreground" data-testid="tax-next-adopt">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    disabled={busy}
                    onClick={() => run(() => setInstalmentAction({ clientId: props.clientId, entityId: v.entity.id, from: `${v.year + 1}-04`, amount: formatMoney(BigInt(v.settlement!.nextInstalment), cur, { bare: true }) }), `Angsuran PPh 25 mulai masa April ${v.year + 1} disimpan`)}
                  >
                    Jadikan angsuran mulai masa April {v.year + 1}
                  </Button>
                  <span>
                    Januari–Maret tetap angsuran sekarang sampai SPT disampaikan; masanya bisa diubah di{" "}
                    <Link href={`${base}/tax/masa?entity=${v.entity.id}&period=${v.year + 1}-04`} className="text-primary underline-offset-2 hover:underline">Pajak Masa</Link>.
                  </span>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {v.deferred && (
        <Card data-testid="tax-deferred">
          <CardHeader>
            <CardTitle>Pajak tangguhan (SAK EP)</CardTitle>
            <CardDescription>Beda temporer dari daftar aset tetap (nilai buku fiskal − nilai buku komersial), cadangan kerugian piutang (baru boleh dibebankan saat dihapusbukukan), sewa PSAK 116 dan liabilitas imbalan kerja (dibebankan saat dibayar), dikali 22%.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            {(() => {
              const others = BigInt(v.deferred.allowance) !== 0n || BigInt(v.deferred.leases) !== 0n || BigInt(v.deferred.employeeBenefits) !== 0n;
              return (
                <>
                  {others && row("Aset tetap (nilai fiskal − nilai buku)", v.deferred.assets)}
                  {BigInt(v.deferred.allowance) !== 0n && row("Cadangan kerugian piutang (1135)", v.deferred.allowance)}
                  {BigInt(v.deferred.leases) !== 0n && row("Sewa (PSAK 116)", v.deferred.leases)}
                  {BigInt(v.deferred.employeeBenefits) !== 0n && row("Liabilitas imbalan kerja (2310)", v.deferred.employeeBenefits)}
                  {row(others ? "Beda temporer" : "Beda temporer (nilai fiskal − nilai buku)", v.deferred.temporaryDifference)}
                </>
              );
            })()}
            {row(BigInt(v.deferred.amount) >= 0n ? "Aset pajak tangguhan" : "Liabilitas pajak tangguhan", BigInt(v.deferred.amount) < 0n ? (-BigInt(v.deferred.amount)).toString() : v.deferred.amount, { strong: true })}
            {BigInt(v.deferred.oci) !== 0n && row("  bagian atas pengukuran kembali imbalan kerja (ke 3920)", v.deferred.oci, { muted: true })}
          </CardContent>
        </Card>
      )}

      {!final && proposal("CURRENT", "Jurnal pajak kini", "Membawa beban pajak, kredit pajak dan utang PPh 29 (atau lebih bayar) ke estimasi di atas. Hanya selisih dari jurnal pajak sebelumnya yang dicatat.")}
      {final && proposal("CURRENT", "Jurnal PPh final", "Membebankan PPh final 0,5% × peredaran bruto tahun berjalan ke 8200 dan mencatat utangnya di 2145; setoran bulanan (kode 411128-420) melunasi 2145. Jurnal PPh badan skema normal yang dicatat sebelumnya ikut dibalik. Hanya selisih dari jurnal sebelumnya yang dicatat.")}
      {v.deferred && proposal("DEFERRED", "Jurnal pajak tangguhan", "Membawa aset/liabilitas pajak tangguhan ke saldo di atas; perubahannya ke 8110.")}

      {v.postings.length > 0 && (
        <Card data-testid="tax-postings">
          <CardHeader><CardTitle>Jurnal pajak tercatat {v.year}</CardTitle></CardHeader>
          <CardContent className="divide-y px-0 text-sm">
            {v.postings.map((p) => (
              <div key={p.id} className="flex flex-wrap items-baseline justify-between gap-x-4 px-6 py-2">
                <Link href={ledger(p.ledgerCode, p.period)} className="min-w-0 hover:text-primary">{p.date} · {p.memo}</Link>
                <Money value={BigInt(p.amount)} currency={cur} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={correction !== null} onOpenChange={(o) => !o && setCorrection(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Koreksi fiskal</DialogTitle>
            <DialogDescription>Positif menambah laba fiskal (mis. beban tanpa daftar nominatif), negatif mengurangi (mis. penghasilan bukan objek pajak).</DialogDescription>
          </DialogHeader>
          {correction && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field className="sm:col-span-2">
                <FieldLabel htmlFor="corr-desc">Keterangan</FieldLabel>
                <Input id="corr-desc" value={correction.description} onChange={(e) => setCorrection({ ...correction, description: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel>Arah</FieldLabel>
                <SimpleSelect label="Arah koreksi" value={correction.direction} onChange={(d) => setCorrection({ ...correction, direction: d as "POSITIVE" | "NEGATIVE" })} options={[{ value: "POSITIVE", label: "Positif (menambah)" }, { value: "NEGATIVE", label: "Negatif (mengurangi)" }]} />
              </Field>
              <Field>
                <FieldLabel>Jenis</FieldLabel>
                <SimpleSelect label="Jenis koreksi" value={correction.kind} onChange={(k) => setCorrection({ ...correction, kind: k as "PERMANENT" | "TEMPORARY" })} options={[{ value: "PERMANENT", label: "Beda tetap" }, { value: "TEMPORARY", label: "Beda waktu" }]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="corr-amount">Nominal</FieldLabel>
                <Input id="corr-amount" inputMode="decimal" className="num text-right" value={correction.amount} onChange={(e) => setCorrection({ ...correction, amount: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel>Akun (opsional)</FieldLabel>
                <SimpleSelect label="Akun koreksi" value={correction.accountCode} onChange={(c) => setCorrection({ ...correction, accountCode: c })} options={[{ value: "", label: "Tanpa akun" }, ...props.accounts.pl.map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }))]} />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCorrection(null)}>Batal</Button>
            <Button disabled={busy || !correction?.description.trim() || !correction?.amount} onClick={() => correction && run(() => addCorrectionAction({ ...scope, ...correction, accountCode: correction.accountCode || null }), "Koreksi ditambahkan", () => setCorrection(null))}>Simpan koreksi</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={loss !== null} onOpenChange={(o) => !o && setLoss(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sisa rugi fiskal</DialogTitle>
            <DialogDescription>Rugi fiskal yang belum dikompensasikan per 1 Januari {v.year}, sesuai lampiran SPT tahun lalu. Dikompensasikan paling lama lima tahun, yang tertua lebih dulu.</DialogDescription>
          </DialogHeader>
          {loss && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Tahun asal rugi</FieldLabel>
                <SimpleSelect label="Tahun asal rugi" value={loss.originYear} onChange={(y) => setLoss({ ...loss, originYear: y })} options={[1, 2, 3, 4, 5].map((k) => ({ value: String(v.year - k), label: String(v.year - k) }))} />
              </Field>
              <Field>
                <FieldLabel htmlFor="loss-amount">Sisa rugi</FieldLabel>
                <Input id="loss-amount" inputMode="decimal" className="num text-right" value={loss.amount} onChange={(e) => setLoss({ ...loss, amount: e.target.value })} />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setLoss(null)}>Batal</Button>
            <Button disabled={busy || !loss?.amount} onClick={() => loss && run(() => setLossAction({ ...scope, originYear: Number(loss.originYear), amount: loss.amount }), "Rugi fiskal dicatat", () => setLoss(null))}>Simpan rugi</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={credit !== null} onOpenChange={(o) => !o && setCredit(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Kredit pajak</DialogTitle>
            <DialogDescription>Bukti potong/pungut dari pihak lain. PPh 25 dari rekening koran sudah terhitung otomatis.</DialogDescription>
          </DialogHeader>
          {credit && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Jenis</FieldLabel>
                <SimpleSelect label="Jenis kredit pajak" value={credit.type} onChange={(t) => setCredit({ ...credit, type: t as "PPH_22" | "PPH_23" | "PPH_24" | "OTHER" })} options={(["PPH_22", "PPH_23", "PPH_24", "OTHER"] as const).map((t) => ({ value: t, label: CREDIT[t] }))} />
              </Field>
              <Field>
                <FieldLabel htmlFor="credit-ref">Nomor bukti potong</FieldLabel>
                <Input id="credit-ref" value={credit.reference} onChange={(e) => setCredit({ ...credit, reference: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="credit-date">Tanggal</FieldLabel>
                <Input id="credit-date" type="date" value={credit.date} onChange={(e) => setCredit({ ...credit, date: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="credit-amount">Nominal</FieldLabel>
                <Input id="credit-amount" inputMode="decimal" className="num text-right" value={credit.amount} onChange={(e) => setCredit({ ...credit, amount: e.target.value })} />
              </Field>
              <Field className="sm:col-span-2">
                <FieldLabel>Dicatat di akun</FieldLabel>
                <SimpleSelect label="Akun kredit pajak" value={credit.accountCode} onChange={(c) => setCredit({ ...credit, accountCode: c })} options={props.accounts.credit.map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }))} />
                <FieldDescription>Akun tempat potongan ini sudah dicatat, biasanya 1180 Pajak Dibayar di Muka.</FieldDescription>
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCredit(null)}>Batal</Button>
            <Button disabled={busy || !credit?.reference.trim() || !credit?.amount || !credit?.accountCode} onClick={() => credit && run(() => addCreditAction({ ...scope, ...credit }), "Kredit pajak ditambahkan", () => setCredit(null))}>Simpan kredit</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
