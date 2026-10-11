import { getCurrentMember } from "@/lib/tenant";
import { RemoveImportButton } from "@/components/app/remove-import";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { loadClientPage } from "@/lib/client-page";
import type { SearchParams } from "@/lib/scope";
import { formatDate } from "@/lib/format";
import { FS_LINES, type FsLine } from "@/lib/coa/template";
import { ACCEPTABLE_CHECKS, importBalances, importSourceAccounts } from "@/lib/ledger-import/post";
import { NEW_ACCOUNT_FS_LINES } from "@/lib/ledger-import/mapping";
import { setupProgress } from "@/lib/setup-progress";
import { resolveAiConfig } from "@/lib/settings/ai";
import { NextStep, PageHeader, Stat } from "@/components/app/page-header";
import { StatusPill } from "@/components/app/status";
import { MappingPanel } from "@/components/app/mapping-panel";
import { AcceptCheckButton, DiscardDraftButton, PostImportButton } from "@/components/app/ledger-import-actions";
import { importKindLabel } from "@/lib/ledger-import/code";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { isAdminRole } from "@/lib/auth/permissions";

export const metadata = { title: "Impor buku besar" };

const TYPE_LABEL = { ASET: "Aset", LIABILITAS: "Liabilitas", EKUITAS: "Ekuitas", PENDAPATAN: "Pendapatan", BEBAN: "Beban" } as const;
const SEVERITY = { BLOCK: { status: "FAIL", label: "Harus diselesaikan" }, REVIEW: { status: "REVIEW", label: "Perlu dicek" }, INFO: { status: "PASS", label: "Info" } } as const;

export default async function LedgerImportPage({ params, searchParams }: { params: Promise<{ id: string; importId: string }>; searchParams: SearchParams }) {
  const { importId } = await params;
  const { client, base } = await loadClientPage(params, searchParams);
  const imp = await prisma.ledgerImport.findFirst({ where: { id: importId, clientId: client.id }, include: { checks: { orderBy: { id: "asc" } }, _count: { select: { entries: true } } } });
  if (!imp) notFound();
  const [sources, balances, accounts, ai] = await Promise.all([
    importSourceAccounts(prisma, imp.id),
    // A Neraca's balances are balances; a ledger's net movement is not (cash paid out in a month is no "saldo kredit"), so only Neraca files get the hint.
    imp.mode === "NERACA" ? importBalances(prisma, imp.id) : Promise.resolve(new Map<string, bigint>()),
    prisma.account.findMany({ where: { clientId: client.id, isBank: false, isSuspense: false, isClearing: false }, orderBy: { code: "asc" } }),
    resolveAiConfig(prisma),
  ]);
  const posted = imp.status === "POSTED";
  // After posting, the banner points at the next first-run step instead of ending on links to the Neraca Saldo.
  const setup = posted ? await setupProgress(prisma, client.id) : null;
  const rank = { BLOCK: 0, REVIEW: 1, INFO: 2 } as const;
  const checks = [...imp.checks].sort((a, b) => rank[a.severity] - rank[b.severity]);
  const openBlock = checks.filter((c) => c.severity === "BLOCK" && !c.accepted);
  const fixable = openBlock.filter((c) => ACCEPTABLE_CHECKS.includes(c.code));
  const hardBlock = openBlock.filter((c) => !ACCEPTABLE_CHECKS.includes(c.code));
  // Entities the file names that the client doesn't have (the label is quoted in the check's message): the way on is adding them.
  const unknownLabels = hardBlock.flatMap((c) => (c.code === "UNKNOWN_ENTITY" ? [/^Entitas "(.+?)" belum/.exec(c.message)?.[1] ?? []].flat() : []));
  const reviews = checks.filter((c) => c.severity === "REVIEW");
  const unmapped = sources.filter((s) => !s.accountId);
  const entities = [...new Set(sources.map((s) => s.entityId))].map((id) => client.entities.find((e) => e.id === id)!).filter(Boolean);
  const ready = !posted && !openBlock.length && !unmapped.length;
  const kind = importKindLabel(imp).replace(/^./, (c) => c.toLowerCase());
  const isAdmin = isAdminRole((await getCurrentMember()).role);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Impor ${kind}: ${imp.sheetName}`}
        description={`${imp.fileName} · ${formatDate(imp.periodStart)}${+imp.periodEnd !== +imp.periodStart ? ` – ${formatDate(imp.periodEnd)}` : ""} · ${imp.currencyMode === "CONVERT" ? "baris valas dikonversi dengan kurs" : "jumlah dicatat apa adanya"}`}
        actions={
          <div className="flex items-center gap-2">
            <StatusPill status={posted ? "PASS" : "REVIEW"} label={posted ? "Tercatat" : "Draf, belum dicatat"} />
            {posted && isAdmin && <RemoveImportButton clientId={client.id} importId={imp.id} kind="ledger" fileName={imp.fileName} onDone={`${base}/import?tab=ledger`} />}
          </div>
        }
      />

      {posted ? (
        <NextStep tone="done" href={setup?.next?.href} cta={setup?.next?.cta}>
          {imp._count.entries} jurnal dicatat {imp.postedAt ? `pada ${formatDate(imp.postedAt)}` : ""}. Cek Neraca Saldo per akun sumber:{" "}
          {entities.map((e, i) => (
            <span key={e.id}>
              {i > 0 && ", "}
              <Link className="underline underline-offset-2" href={`${base}/trial-balance?view=source&entity=${e.id}&period=${imp.periodEnd.toISOString().slice(0, 7)}`}>{e.shortName}</Link>
            </span>
          ))}
          .
        </NextStep>
      ) : hardBlock.length && unknownLabels.length === hardBlock.length ? (
        <NextStep href={`${base}/settings`} cta="Tambah perusahaan">
          Tambahkan {unknownLabels.join(", ")} sebagai perusahaan klien, dengan nama singkat yang sama seperti di file, lalu unggah ulang.
        </NextStep>
      ) : hardBlock.length ? (
        <NextStep>Perbaiki {hardBlock.length} masalah di file lalu unggah ulang. Masalah ini tidak bisa diterima begitu saja.</NextStep>
      ) : fixable.length ? (
        <NextStep>Periksa {fixable.length} jurnal yang tidak seimbang di file: perbaiki filenya, atau terima dan catat selisihnya ke 1999.</NextStep>
      ) : unmapped.length ? (
        <NextStep>Petakan {unmapped.length} akun dari file ke bagan akun Buku di bawah.</NextStep>
      ) : (
        <NextStep>File sudah diperiksa dan semua akun dipetakan. Catat {imp.groupCount} jurnal ke buku.</NextStep>
      )}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label="Baris dibaca" value={imp.rowCount.toLocaleString("id-ID")} hint={`${imp.groupCount} jurnal`} />
        <Stat label="Harus diselesaikan" value={openBlock.length} hint={checks.some((c) => c.accepted) ? `${checks.filter((c) => c.accepted).length} selisih diterima ke 1999` : undefined} />
        <Stat label="Perlu dicek" value={reviews.length} hint="Dicatat di kontrol Tutup Buku" />
        <Stat label="Akun dipetakan" value={`${sources.length - unmapped.length}/${sources.length}`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1. Pemeriksaan file</CardTitle>
          <CardDescription>Aturan tetap, bukan AI. Setiap temuan menunjuk ke baris di file ({imp.sheetName}!baris).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {checks.slice(0, 25).map((c) => (
            <CheckRow key={c.id} c={c} clientId={client.id} posted={posted} />
          ))}
          {checks.length > 25 && (
            <Collapsible>
              <CollapsibleTrigger className="text-sm font-medium text-primary hover:underline">Tampilkan {checks.length - 25} temuan lainnya</CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-2">
                {checks.slice(25).map((c) => (
                  <CheckRow key={c.id} c={c} clientId={client.id} posted={posted} />
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Pemetaan akun</CardTitle>
          <CardDescription>
            Kode dan nama akun di file tetap disimpan (terlihat di Neraca Saldo · akun sumber). Setiap akun dipetakan ke satu akun Buku untuk laporan dan Gabungan Grup.
            Saran aturan dan AI hanya berlaku setelah Anda terima. AI hanya melihat kode, nama dan jenis akun, tidak pernah nominal.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MappingPanel
            clientId={client.id}
            locked={posted}
            aiActive={Boolean(ai.apiKey && ai.model)}
            fsLines={NEW_ACCOUNT_FS_LINES}
            options={accounts.map((a) => ({ code: a.code, name: a.name, group: `${TYPE_LABEL[a.type]} · ${FS_LINES[a.fsLine as FsLine]?.label ?? a.fsLine}`, normal: a.normalBalance }))}
            rows={sources.map((s) => ({
              id: s.id,
              entity: s.entity.shortName,
              code: s.code,
              name: s.name,
              previousNames: s.previousNames,
              suggestedCode: s.suggestedCode,
              suggestedBy: s.suggestedBy,
              confidence: s.mapConfidence,
              reason: s.mapReason,
              mappedCode: s.account?.code ?? null,
              mappedBy: s.mappedBy,
              typeHint: s.typeHint,
              balance: balances.get(`${s.entityId}|${s.code}`)?.toString() ?? null,
              currency: s.entity.functionalCurrency,
            }))}
          />
        </CardContent>
      </Card>

      {!posted && (
        <Card>
          <CardHeader>
            <CardTitle>3. Catat ke buku</CardTitle>
            <CardDescription>
              Semua jurnal dicatat sekaligus lewat buku besar Buku, atau tidak sama sekali. Periode yang sudah ditutup menolak impor.
              {imp.roundingTotal ? ` Pembulatan ke satuan terkecil mata uang perusahaan (Rupiah utuh, sen untuk valas) dicatat terpisah di 7190 Selisih Pembulatan.` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            <PostImportButton clientId={client.id} importId={imp.id} disabled={!ready} label={`Catat ${imp.groupCount} jurnal`} />
            <DiscardDraftButton clientId={client.id} importId={imp.id} />
            {!ready && (
              <span className="text-sm text-muted-foreground">
                {[openBlock.length ? `${openBlock.length} masalah belum selesai` : "", unmapped.length ? `${unmapped.length} akun belum dipetakan` : ""].filter(Boolean).join(" · ")}
              </span>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function CheckRow({ c, clientId, posted }: { c: { id: string; severity: "BLOCK" | "REVIEW" | "INFO"; code: string; message: string; refs: string[]; accepted: boolean }; clientId: string; posted: boolean }) {
  const sev = SEVERITY[c.severity];
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 rounded-md border px-3 py-2 text-sm">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={c.accepted ? "REVIEW" : sev.status} label={c.accepted ? "Diterima ke 1999" : sev.label} />
          <span>{c.message}</span>
        </div>
        {c.refs.length > 0 && <div className="font-mono text-xs break-all text-muted-foreground">{c.refs.slice(0, 8).join(", ")}{c.refs.length > 8 ? ` … (+${c.refs.length - 8})` : ""}</div>}
      </div>
      {ACCEPTABLE_CHECKS.includes(c.code) && !c.accepted && !posted && <AcceptCheckButton clientId={clientId} checkId={c.id} kind={c.code === "DATE_TYPO" ? "date" : "difference"} />}
    </div>
  );
}
