import { prisma } from "@/lib/db";
import { loadClientPage } from "@/lib/client-page";
import { withParams, type SearchParams } from "@/lib/scope";
import { formatDate, periodBounds } from "@/lib/format";
import { liveUploadFile } from "@/lib/demo/seed";
import { evidenceEnabled } from "@/lib/evidence/config";
import { setupProgress } from "@/lib/setup-progress";
import { SetupSteps } from "@/components/app/setup-steps";
import { NextStep, PageHeader } from "@/components/app/page-header";
import { ImportForm } from "@/components/app/import-form";
import { StatusPill } from "@/components/app/status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LedgerImportForm } from "@/components/app/ledger-import-form";
import { importKindLabel } from "@/lib/ledger-import/code";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { getCurrentFirm, getCurrentMember } from "@/lib/tenant";
import { completenessMatrix } from "@/lib/controls/completeness";
import { dataRequest, type MissingSlip } from "@/lib/controls/data-request";
import { bupotRecon } from "@/lib/tax/bupot";
import { BUPOT_KIND_LABEL } from "@/lib/tax/bupot-read";
import { packApplies } from "@/lib/tax/pack";
import { ownerQuestions } from "@/lib/review-questions";
import { CompletenessCard } from "@/components/app/completeness-card";
import { DataRequestCard } from "@/components/app/data-request-card";
import { UploadLinksCard } from "@/components/app/upload-links-card";
import { uploadLinks } from "@/lib/upload-links";
import { RemoveImportButton } from "@/components/app/remove-import";
import { isAdminRole } from "@/lib/auth/permissions";
import { accessView, requireWorkspaceSession } from "@/lib/auth/session";
import { aiRunForView } from "@/lib/ai/background";
import { batchItems } from "@/lib/inbox/plan";
import { UnggahInbox, UnggahTabs } from "@/components/app/unggah-inbox";

export const metadata = { title: "Unggah" };

export default async function ImportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { client, sp, period } = await loadClientPage(params, searchParams);
  const setup = await setupProgress(prisma, client.id, { period });
  const banks = client.entities.flatMap((e) => e.bankAccounts.map((b) => ({ id: b.id, label: b.label, entity: e.name, bank: b.bank, number: b.number })));
  const imports = await prisma.statementImport.findMany({
    where: { bankAccountId: { in: banks.map((b) => b.id) } },
    include: { bankAccount: { include: { entity: true } }, importedBy: { select: { name: true } } },
    orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }],
    take: 100,
  });
  const ledgerImports = await prisma.ledgerImport.findMany({ where: { clientId: client.id }, orderBy: { createdAt: "desc" }, take: 30, include: { _count: { select: { entries: true } }, importedBy: { select: { name: true } }, postedBy: { select: { name: true } } } });
  const hasBanks = banks.length > 0;
  // The history is a reference, not the task: six rows, the rest one click away (state in the URL like the other lists).
  const HISTORY = 6;
  const showAll = sp.riwayat === "semua";
  const shownImports = showAll ? imports : imports.slice(0, HISTORY);
  // Removing an import (ADR 0013) is an admin's decision, like reopening a month.
  const isAdmin = isAdminRole((await getCurrentMember()).role);
  // The client's background AI run (a stalled one resumes after this response when the member may write).
  const aiRun = await aiRunForView(prisma, client, { canWrite: accessView(await requireWorkspaceSession()).canWrite });
  // The Unggah inbox (cycle 2026-10-10-unggah-inbox): the client's latest drop, so its lines survive a reload. Reads only.
  // A hand-off from Dokumen (`?lanjut=<batchId>`) opens exactly that drop, so the flag can only ever carry on the drop it was made for.
  const handoff = typeof sp.lanjut === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sp.lanjut) ? sp.lanjut : undefined;
  const inbox = await batchItems(prisma, { firmId: client.firmId, clientId: client.id, batchId: handoff });
  const drive = !evidenceEnabled() ? "off" : (await prisma.driveConnection.findUnique({ where: { firmId: client.firmId }, select: { firmId: true } })) ? "ready" : "disconnected";
  // Sumber first (ADR 0014): what is missing for this month, and the message that asks the client for it.
  const completeness = await completenessMatrix(prisma, client.id, period.year, period.month);
  // …and the lines still in Review the client should explain (I1c), as Review's Excel lists them.
  const questions = await ownerQuestions(prisma, { firmId: client.firmId, clientId: client.id, entityIds: client.entities.map((e) => e.id), through: periodBounds(period.year, period.month).end });
  // …and the bukti potong customers still owe (I5d): withholding on receipts with no slip in an imported Coretax *diterima* list.
  const slips: MissingSlip[] = [];
  for (const e of client.entities.filter(packApplies)) {
    const d = (await bupotRecon(prisma, { clientId: client.id, entityId: e.id, year: period.year, month: period.month })).directions.find((x) => x.direction === "DITERIMA");
    if (d && d.imported > 0) for (const b of d.unmatchedBook) slips.push({ entity: e.shortName, date: b.date, description: b.description, kind: BUPOT_KIND_LABEL[b.kind], pph: b.pph, currency: "IDR" });
  }
  const request = dataRequest({ clientName: client.name, firmName: (await getCurrentFirm()).name, period, rows: completeness.rows, questions, slips });
  // Tautan unggah klien (I1d): files the client sent without an account, waiting in Dokumen.
  const links = evidenceEnabled() ? await uploadLinks(prisma, client.id) : [];

  let sample: { bankAccountId: string; fileName: string } | undefined;
  if (process.env.DEMO_MODE === "true") {
    const f = await liveUploadFile();
    const acct = banks.find((b) => f.fileName.includes(b.number.slice(-4)) && f.fileName.startsWith(b.bank));
    const already = acct && imports.some((i) => i.bankAccountId === acct.id && i.fileName === f.fileName);
    if (acct && !already) sample = { bankAccountId: acct.id, fileName: f.fileName };
  }

  const history = (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Rekening koran yang diimpor</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">File</TableHead>
                <TableHead>Rekening</TableHead>
                <TableHead className="hidden md:table-cell">Periode</TableHead>
                <TableHead className="hidden text-right md:table-cell">Baris</TableHead>
                <TableHead>Saldo berjalan</TableHead>
                <TableHead className={isAdmin ? "hidden md:table-cell" : "hidden pr-6 md:table-cell"}>Diimpor</TableHead>
                {isAdmin && <TableHead className="w-24 pr-6"><span className="sr-only">Hapus</span></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {imports.length === 0 && (
                <TableRow>
                  <TableCell colSpan={isAdmin ? 7 : 6} className="pl-6 text-muted-foreground">Belum ada rekening koran yang diimpor untuk klien ini.</TableCell>
                </TableRow>
              )}
              {shownImports.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="pl-6">
                    <span className="font-mono text-xs">{i.fileName}</span>
                    {i.parseNotes.map((n) => <span key={n} className="mt-1 block max-w-md text-xs text-muted-foreground">{n}</span>)}
                  </TableCell>
                  <TableCell>{i.bankAccount.label} <span className="text-muted-foreground">· {i.bankAccount.entity.shortName}</span></TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{formatDate(i.periodStart)} – {formatDate(i.periodEnd)}</TableCell>
                  <TableCell className="num hidden text-right md:table-cell">{i.rowCount}{i.duplicateCount ? <span className="text-muted-foreground"> ({i.duplicateCount} duplikat)</span> : null}</TableCell>
                  <TableCell><StatusPill status={i.continuityOk ? "PASS" : "REVIEW"} label={i.continuityOk ? "Nyambung" : "Ada celah"} /></TableCell>
                  <TableCell className={isAdmin ? "hidden text-muted-foreground md:table-cell" : "hidden pr-6 text-muted-foreground md:table-cell"}>{formatDate(i.createdAt)}<span className="block text-xs">oleh {i.importedBy?.name ?? "Sistem"}</span></TableCell>
                  {isAdmin && <TableCell className="pr-6 text-right"><RemoveImportButton clientId={client.id} importId={i.id} kind="statement" fileName={i.fileName} /></TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {imports.length > HISTORY && (
            <div className="border-t px-6 pt-3 text-sm">
              <Link href={withParams(`/clients/${client.id}/import`, { period: period.key, ...(showAll ? {} : { riwayat: "semua" }) })} className="text-primary underline-offset-4 hover:underline">
                {showAll ? `Tampilkan ${HISTORY} terbaru` : `Tampilkan semua (${imports.length})`}
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Buku besar & neraca yang diimpor</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {ledgerImports.length === 0 ? (
            <p className="px-6 text-sm text-muted-foreground">Belum ada buku besar atau neraca yang diimpor untuk klien ini.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">File · sheet</TableHead>
                  <TableHead>Jenis</TableHead>
                  <TableHead className="hidden md:table-cell">Periode</TableHead>
                  <TableHead className="text-right">Baris</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-10 pr-6" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledgerImports.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="pl-6">
                      <Link href={`/clients/${client.id}/import/ledger/${i.id}`} className="hover:text-primary">
                        <span className="font-mono text-xs">{i.fileName}</span> <span className="text-muted-foreground">· {i.sheetName}</span>
                      </Link>
                    </TableCell>
                    <TableCell>{importKindLabel(i)}</TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">{formatDate(i.periodStart)}{+i.periodEnd !== +i.periodStart ? ` – ${formatDate(i.periodEnd)}` : ""}</TableCell>
                    <TableCell className="num text-right">{i.rowCount}</TableCell>
                    <TableCell>
                      <StatusPill status={i.status === "POSTED" ? "PASS" : "REVIEW"} label={i.status === "POSTED" ? `Tercatat · ${i._count.entries} jurnal` : "Draf"} /><span className="mt-1 block text-xs text-muted-foreground">{i.status === "POSTED" ? `oleh ${i.postedBy?.name ?? "Sistem"}` : `diunggah ${i.importedBy?.name ?? "Sistem"}`}</span>
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      <Link href={`/clients/${client.id}/import/ledger/${i.id}`} aria-label={`Buka ${i.fileName}`} className="text-muted-foreground hover:text-primary">
                        <ChevronRight className="size-4" />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
  const manual = (
    <>
      {hasBanks ? (
        <ImportForm clientId={client.id} banks={banks} sample={sample} openingPending={setup.needsOpening.map((e) => e.shortName)} aiRun={aiRun} />
      ) : (
        <p className="text-sm text-muted-foreground">Klien ini belum punya rekening. Unggah rekening korannya di atas; rekeningnya ditambahkan dari file.</p>
      )}
      <LedgerImportForm clientId={client.id} entities={client.entities.map((e) => ({ id: e.id, name: e.name, currency: e.functionalCurrency }))} />
    </>
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Unggah" description="Rekening koran, buku besar, neraca, atau dokumen lain — Buku memilah dan membukukannya." />
      {setup.current === "import" ? (
        <NextStep>{setup.next?.text}</NextStep>
      ) : (
        <NextStep href={setup.next?.href} cta={setup.next?.cta}>{setup.next?.text}</NextStep>
      )}
      <SetupSteps progress={setup} />
      <UnggahInbox clientId={client.id} initial={inbox} drive={drive} aiRun={aiRun} handedOver={Boolean(handoff) && inbox.items.length > 0} />
      {completeness.rows.length > 0 && <CompletenessCard months={completeness.months} rows={completeness.rows} />}
      <UnggahTabs history={history} manual={manual} />
      {request && <DataRequestCard message={request.text} items={request.items} clientId={client.id} canLink={evidenceEnabled()} />}
      {evidenceEnabled() && (
        <UploadLinksCard
          clientId={client.id}
          clientName={client.name}
          links={links.map((l) => ({ id: l.id, intakeId: l.intakeId, created: formatDate(l.createdAt), expires: formatDate(l.expiresAt), lastUsed: l.lastUsedAt ? formatDate(l.lastUsedAt) : null, files: l.files, active: l.active }))}
        />
      )}
      {evidenceEnabled() && <p className="text-sm text-muted-foreground">Ingin menyimpan berkas untuk ditanyakan, bukan dibukukan? Pakai <Link href="/documents" className="text-primary hover:underline">Dokumen</Link>. Yang diimpor di sini langsung menjadi jurnal.</p>}
    </div>
  );}
